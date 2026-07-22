// RUN OR DIE — Online-Server: statische Dateien + dummes WebSocket-Relay.
// KEINE Spiellogik: der Host (Slot 0) simuliert, der Server leitet nur weiter.
//   Host  -> Server: Frame wird an alle Clients im Raum verteilt
//   Client-> Server: Frame geht an den Host; der Server stempelt den Absender-Slot
//                    (Binär: 1 Byte Slot vorangestellt, JSON: Feld "from")
// Start: npm start  ·  PORT=8080  ·  LAG=120 simuliert 120 ms Einweg-Latenz.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { handleApi } from './api.js';
import { userForToken, recordOnline } from './db.js';

const PORT = +(process.env.PORT || 8080);
const LAG = +(process.env.LAG || 0); // ms künstliche Einweg-Latenz (Latenz-Tests)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_PLAYERS = 4;
const MAX_CONNS = +(process.env.MAX_CONNS || 500); // Gesamt-Verbindungslimit
const JOIN_BURST = 20;      // erlaubte create/join-Versuche …
const JOIN_WINDOW_MS = 10000; // … pro Socket in diesem Fenster (gegen Code-Brute-Force)
// Pro-IP-Limits: das Socket-Fenster allein wäre per Reconnect-Schleife umgehbar
// (Code-Bruteforce mit >1000 Versuchen/s über frische Verbindungen)
const MAX_CONNS_PER_IP = +(process.env.MAX_CONNS_PER_IP || 8);
const IP_JOIN_BURST = 40;        // create/join-Versuche pro IP …
const IP_JOIN_WINDOW_MS = 60000; // … in diesem Fenster (überlebt Reconnects)
// CSWSH-Schutz: ORIGINS="https://example.com,https://foo.io" aktiviert eine
// Origin-Allowlist; ohne gesetzte Variable bleibt alles erlaubt (lokale Tests)
const ALLOWED_ORIGINS = (process.env.ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
// X-Forwarded-For nur hinter eigenem Reverse-Proxy lesen (TRUST_PROXY=1):
// direkt exponiert könnte sonst jeder Client die Per-IP-Limits per
// erfundenem Header umgehen — genau der Angriff, den sie verhindern sollen
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// ---------- Statische Dateien (nur Whitelist, kein Verzeichnis-Traversal) ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
};

const http = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  // Konten-API (/api/…) vor der statischen Whitelist
  if (path.startsWith('/api/')) { await handleApi(req, res, path, clientIp(req)); return; }
  const entry = STATIC[path];
  if (!entry) { res.writeHead(404); res.end('not found'); return; }
  try {
    const body = await readFile(join(ROOT, entry[0]));
    res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(500); res.end('read error');
  }
});

// ---------- Räume ----------
// code -> { host: ws, clients: Map<slot, ws>, locked: bool }
const rooms = new Map();
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne I/O/0/1 (Verwechslung)

// ---------- Reconnect-Kulanz ----------
// Bricht die Verbindung eines Clients ab, WÄHREND das Spiel läuft (Raum locked),
// darf er sich für ein kurzes Fenster wieder in den laufenden Raum einklinken —
// sonst würde ein kurzer Netzhänger ihn ins Menü werfen. Der Client bekommt beim
// Beitreten einen opaken Reconnect-Schlüssel (rk); bei Abbruch merken wir ihn hier
// und erlauben genau diesem rk, den Lock einmalig zu umgehen. Funktioniert auch
// für anonyme Spieler (Identität = rk, kein Konto nötig).
const rejoinGrace = new Map(); // rk -> { code, at }
const GRACE_MS = 15000;

// ---------- Präsenz: angemeldete Spieler, die gerade im Online-Bereich sind ----------
// userId -> ws. Basis für die "Online-Spieler"-Liste und Einladungen. Anonyme
// Spieler tauchen NICHT auf (nur Konten haben eine stabile Identität/Namen).
const online = new Map();

function presenceList() {
  return [...online.values()].filter((w) => w.user).map((w) => ({ // Gürtel + Hosenträger: nie an null-user scheitern
    id: w.user.id,
    name: w.user.username,
    busy: !!w.roomCode, // in einem Raum (Lobby oder Partie) -> nicht einladbar
  }));
}

// ---------- Öffentliche Räume (Browser) ----------
// Ein Host kann seinen Raum "öffentlich" schalten; dann taucht er in einer für alle
// abrufbaren Liste auf. Gelistet werden nur offene (nicht gestartete, nicht volle)
// öffentliche Räume. Beitreten geht wie bei einem eingetippten Code — auch anonym.
function publicRoomList() {
  const out = [];
  for (const [code, r] of rooms) {
    if (!r.public || r.locked) continue;
    const used = usedSlots(r).size;
    if (used >= MAX_PLAYERS) continue; // voll -> nicht anzeigen
    out.push({ code, host: r.host?.user?.username || null, count: used, max: MAX_PLAYERS });
  }
  return out.slice(0, 50); // Deckel gegen Übergröße
}
// Wer die öffentliche Liste angefragt hat, bekommt Live-Updates — AUCH anonym
// (die Präsenz-Liste `online` führt nur Angemeldete). Aufräumen beim Close.
const browsers = new Set();
function broadcastRooms() {
  const payload = JSON.stringify({ t: 'rooms', rooms: publicRoomList() });
  const seen = new Set();
  for (const w of online.values()) { if (!seen.has(w)) { seen.add(w); send(w, payload); } }
  for (const w of browsers) { if (w.readyState === 1 && !seen.has(w)) { seen.add(w); send(w, payload); } }
}
function broadcastPresence() {
  const payload = JSON.stringify({ t: 'presence', users: presenceList() });
  for (const w of online.values()) send(w, payload);
}
// Verbindung als online führen (nach erfolgreicher Anmeldung). Gibt true zurück,
// wenn sich die Liste geändert hat (neuer Nutzer oder Socket-Wechsel).
// Meldet sich derselbe Nutzer neu an (anderer Browser/Reconnect), wird die ALTE
// Sitzung sofort abgeräumt: aus ihrem Raum werfen und trennen. Das verhindert
// Zombie-Räume (alter Host noch "OPEN", aber niemand simuliert) — der Hauptgrund,
// warum "in Brave beitreten, schließen, in Chrome erneut beitreten" scheiterte,
// bis der ~Heartbeat die tote Verbindung nach Sekunden aufräumte.
function setOnline(ws) {
  if (!ws.user) return false;
  const prev = online.get(ws.user.id);
  if (prev && prev !== ws) {
    try { leaveRoom(prev); prev.terminate(); } catch (err) { console.error('takeover:', err); }
  }
  online.set(ws.user.id, ws);
  return prev !== ws;
}
function clearOnline(ws) {
  if (ws.user && online.get(ws.user.id) === ws) { online.delete(ws.user.id); return true; }
  return false;
}

// ---------- Sitzplätze (seats) ----------
// Eine Verbindung kann 1–2 lokale Spieler mitbringen (Splitscreen an einem Gerät,
// gemischt mit Online). ws.slots hält ihre absoluten Raum-Slots; ws.slot bleibt der
// erste davon (Host-Erkennung: slot===0). r.clients bildet JEDEN Client-Slot -> ws ab
// (bei 2 Sitzen zeigen zwei Keys auf dieselbe ws).
const roomClientSockets = (room) => new Set(room.clients.values()); // dedupliziert 2-Sitz-Clients
function usedSlots(room) {
  const used = new Set(room.host.slots || []);
  for (const s of room.clients.keys()) used.add(s);
  return used;
}
function freeSlots(room, n) {
  const used = usedSlots(room);
  const out = [];
  for (let s = 0; s < MAX_PLAYERS && out.length < n; s++) if (!used.has(s)) out.push(s);
  return out.length === n ? out : null;
}
const seatCount = (msg) => (msg.seats | 0) === 2 ? 2 : 1;
// Anzeigename je Sitz einer Verbindung: Sitz 0 = Erstkonto, Sitz 1 = eigenes
// Zweitkonto, falls angemeldet — sonst die ②-Markierung des Erstkontos.
function seatName(ws, i) {
  if (i === 0) return ws.user ? ws.user.username : null;
  if (ws.user2) return ws.user2.username;
  return ws.user ? ws.user.username + ' ②' : null;
}

function newCode() {
  for (let tries = 0; tries < 50; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

const send = (ws, data, binary = false) => {
  if (ws?.readyState !== ws?.OPEN) return;
  const doSend = () => { if (ws.readyState === ws.OPEN) ws.send(data, { binary }); };
  LAG ? setTimeout(doSend, LAG) : doSend();
};
const sendJson = (ws, obj) => send(ws, JSON.stringify(obj));

// Origin-Prüfung schon beim Handshake (verifyClient) statt danach: eine fremde
// Website bekommt so gar keine offene Verbindung (kein kurzes Open→Close). Der
// eigene Origin und localhost (Dev) sind immer erlaubt; ohne ORIGINS bleibt alles offen.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!ALLOWED_ORIGINS.length || !origin) return true;
  const host = req.headers.host;
  const sameOrigin = host && origin.endsWith('//' + host);
  const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return sameOrigin || localOrigin || ALLOWED_ORIGINS.includes(origin);
}

// Spielframes sind klein (Snapshots < 8 KB, typische Spawn-Events wenige KB) — das
// ws-Default von 100 MiB wäre ein Speicher-Verstärker für böswillige Clients.
// ABER: 64 KB war zu knapp — ein einzelnes großes Host-Ereignis (dichte Welle +
// Graffiti-Zufälle, gebündelte WebRTC-Signalisierung) überschritt es gelegentlich,
// worauf ws die HOST-Verbindung mit 1009 schloss → der Raum starb und ALLE fielen
// wortlos ins Menü. 512 KB gibt großzügig Luft und bleibt eine harte Obergrenze.
// (Der Client meldet zusätzlich übergroße Nachrichten per Telemetrie, damit ein
// echter Ausreißer auffällt.)
const wss = new WebSocketServer({
  server: http, path: '/ws', maxPayload: 512 * 1024,
  verifyClient: (info) => originAllowed(info.req),
});

const ipConns = new Map(); // ip -> offene Verbindungen
const ipJoins = new Map(); // ip -> { n, at } — Join-Fenster, überlebt Reconnects
function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '?';
}

wss.on('connection', (ws, req) => {
  if (wss.clients.size > MAX_CONNS) { ws.close(1013, 'server busy'); return; }
  ws.ip = clientIp(req);
  const nIp = (ipConns.get(ws.ip) || 0) + 1;
  if (nIp > MAX_CONNS_PER_IP) { ws.close(1013, 'too many connections'); return; }
  ipConns.set(ws.ip, nIp);
  ws.roomCode = null; ws.slot = null; ws.slots = null; ws.missedPongs = 0;
  ws.joinCount = 0; ws.joinWindowAt = 0;
  ws.on('pong', () => { ws.missedPongs = 0; });

  ws.on('message', (data, isBinary) => {
    // Ein geworfener Handler darf niemals den Relay-Prozess (alle Räume!) töten
    try { handleMessage(ws, data, isBinary); } catch (err) { console.error('message handler:', err); }
  });

  ws.on('close', () => {
    const c = (ipConns.get(ws.ip) || 1) - 1;
    c > 0 ? ipConns.set(ws.ip, c) : ipConns.delete(ws.ip);
    browsers.delete(ws);
    try {
      const wasOnline = clearOnline(ws);
      const wasInRoom = !!ws.roomCode; // vor leaveRoom merken (danach null)
      // Abbruch mitten im laufenden Spiel: Reconnect-Fenster für diesen Client öffnen
      // (nur Clients, nicht der Host — ohne Host ist der Raum ohnehin weg).
      const rm = ws.roomCode ? rooms.get(ws.roomCode) : null;
      if (rm?.locked && ws.slot !== 0 && ws.rkey) { rejoinGrace.set(ws.rkey, { code: ws.roomCode, at: Date.now(), slots: ws.slots }); ws.graced = true; }
      const wasPublic = !!rm?.public;
      leaveRoom(ws);
      // Präsenz auffrischen, wenn die Liste sich ändert ODER Mitspieler durch das
      // Verlassen wieder frei/einladbar werden (auch bei anonymem Host)
      if (wasOnline || wasInRoom) broadcastPresence();
      if (wasPublic) broadcastRooms(); // öffentlicher Raum wurde kleiner oder ist weg
    } catch (err) { console.error('close:', err); }
  });
  ws.on('error', () => { /* close folgt */ });
});

function handleMessage(ws, data, isBinary) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;

    // ---- Binärframes: reines Relay (Snapshots vom Host, Inputs von Clients) ----
    if (isBinary) {
      if (!room) return;
      if (ws.slot === 0) {
        for (const c of roomClientSockets(room)) send(c, data, true); // Snapshot an alle Clients
      } else {
        // Client-Input-Frame: [type=2, seat, seq…]. Den Sitz auf den absoluten Slot
        // abbilden und diesen voranstellen (so kann ein Client nur SEINE Slots ansprechen).
        if (data.length < 2 || data[0] !== 2) return;
        const absSlot = ws.slots?.[data[1] | 0];
        if (absSlot === undefined) return;
        const stamped = Buffer.concat([Buffer.from([absSlot]), data]);
        send(room.host, stamped, true);
      }
      return;
    }

    // ---- Textframes: Steuerprotokoll oder JSON-Relay ----
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // Präsenz anmelden: der Client meldet sich mit seinem Token, ohne (noch)
    // einem Raum beizutreten -> erscheint in der Online-Liste, kann eingeladen werden
    if (msg.t === 'hello') {
      authWs(ws, msg.token);
      if (!ws.user) { sendJson(ws, { t: 'presence', users: [] }); return; }
      const changed = setOnline(ws);
      sendJson(ws, { t: 'presence', users: presenceList() }); // eigene Liste sofort
      if (changed) broadcastPresence();                       // die anderen aktualisieren
      return;
    }

    // Einladung: lädt eine/n Online-Spieler/in in den EIGENEN Raum ein
    if (msg.t === 'invite') {
      const now = Date.now();
      if (now - (ws.inviteAt || 0) > 10000) { ws.inviteAt = now; ws.inviteCount = 0; }
      if ((ws.inviteCount = (ws.inviteCount || 0) + 1) > 10) return; // Gesamt-Spam-Bremse
      const r = ws.roomCode ? rooms.get(ws.roomCode) : null;
      if (!ws.user || !r || r.locked) return;                    // nur aus einem offenen Raum
      if (usedSlots(r).size >= MAX_PLAYERS) return;              // kein freier Slot
      const tId = msg.to | 0;
      const target = online.get(tId);
      if (!target || target === ws || target.roomCode) return;   // offline / man selbst / schon im Raum
      // Denselben Spieler nicht dauernd zutoasten (max. 1× / 30 s je Ziel)
      ws.invSeen = ws.invSeen || new Map();
      if (now - (ws.invSeen.get(tId) || 0) < 30000) return;
      ws.invSeen.set(tId, now);
      sendJson(target, { t: 'invited', from: ws.user.username, code: ws.roomCode });
      return;
    }

    // create/join drosseln: ein Socket ohne Raum kann sonst den 32^4-Code-Raum
    // durchprobieren, um laufende Räume zu finden/zu stören
    if (msg.t === 'create' || msg.t === 'join') {
      const now = Date.now();
      if (now - ws.joinWindowAt > JOIN_WINDOW_MS) { ws.joinWindowAt = now; ws.joinCount = 0; }
      if (++ws.joinCount > JOIN_BURST) { sendJson(ws, { t: 'err', msg: 'Zu viele Versuche, kurz warten' }); return; }
      // Pro-IP-Fenster: bremst auch Reconnect-Schleifen (Socket-Zähler frisch)
      const b = ipJoins.get(ws.ip) || { n: 0, at: now };
      if (now - b.at > IP_JOIN_WINDOW_MS) { b.n = 0; b.at = now; }
      b.n++; ipJoins.set(ws.ip, b);
      if (b.n > IP_JOIN_BURST) { sendJson(ws, { t: 'err', msg: 'Zu viele Versuche, kurz warten' }); return; }
    }

    if (msg.t === 'create') {
      if (ws.roomCode) { sendJson(ws, { t: 'err', msg: 'Schon in einem Raum' }); return; }
      const code = newCode();
      if (!code) { sendJson(ws, { t: 'err', msg: 'Server voll' }); return; }
      authWs(ws, msg.token, msg.token2); // optionale Anmeldung -> ws.user / ws.user2
      const seats = seatCount(msg);
      const slots = seats === 2 ? [0, 1] : [0]; // Host nimmt die untersten Slots
      const names = {};
      slots.forEach((s, i) => { names[s] = seatName(ws, i); });
      rooms.set(code, { host: ws, clients: new Map(), locked: false, public: false, names });
      ws.roomCode = code; ws.slots = slots; ws.slot = 0; ws.rkey = randomUUID();
      setOnline(ws);
      sendJson(ws, { t: 'created', code, name: ws.name, slots, names, rk: ws.rkey });
      broadcastPresence(); // Ersteller ist jetzt (evtl. neu) online
      return;
    }

    if (msg.t === 'join') {
      if (ws.roomCode) { sendJson(ws, { t: 'err', msg: 'Schon in einem Raum' }); return; }
      const code = String(msg.code || '').toUpperCase().trim();
      const r = rooms.get(code);
      if (!r) { sendJson(ws, { t: 'err', msg: 'Raum nicht gefunden' }); return; }
      let preferSlots = null; // beim Reconnect möglichst die alten Slots zurückgeben
      if (r.locked) {
        // Laufendes Spiel: normalerweise gesperrt. Ausnahme: ein Client, der eben
        // die Verbindung verloren hat, darf mit gültigem Reconnect-Schlüssel zurück.
        const g = msg.rk ? rejoinGrace.get(String(msg.rk)) : null;
        if (g && g.code === code && Date.now() - g.at < GRACE_MS) { preferSlots = g.slots || null; rejoinGrace.delete(String(msg.rk)); }
        else { sendJson(ws, { t: 'err', msg: 'Spiel läuft schon' }); return; }
      }
      authWs(ws, msg.token, msg.token2);
      // Man kann nicht dem EIGENEN Raum (aus einer zweiten Sitzung) beitreten:
      // die Sitzungsübernahme in setOnline würde ihn sonst mitten im Beitritt löschen.
      if (r.host?.user && ws.user && r.host.user.id === ws.user.id) {
        sendJson(ws, { t: 'err', msg: 'Du hostest diesen Raum bereits' }); return;
      }
      const seats = seatCount(msg);
      // Reconnect: die zuvor belegten Slots bevorzugen, falls noch frei (stabile
      // Identität/Farbe). Sonst normale Vergabe (niedrigste freie Slots).
      const used = usedSlots(r);
      const slots = (preferSlots && preferSlots.length === seats && preferSlots.every((s) => !used.has(s)))
        ? preferSlots : freeSlots(r, seats);
      if (!slots) { sendJson(ws, { t: 'err', msg: seats === 2 ? 'Nicht genug Platz für 2 Spieler' : 'Raum ist voll (4 Spieler)' }); return; }
      const names = {};
      slots.forEach((s, i) => { r.clients.set(s, ws); r.names[s] = seatName(ws, i); names[s] = seatName(ws, i); });
      ws.roomCode = code; ws.slots = slots; ws.slot = slots[0]; ws.rkey = randomUUID();
      setOnline(ws);
      sendJson(ws, { t: 'joined', code, slots, names: { ...r.names }, rk: ws.rkey }); // bekannte Namen mitschicken
      sendJson(r.host, { t: 'peer', slots, names }); // Host lernt die neuen Slots + Namen
      broadcastPresence();
      if (r.public) broadcastRooms(); // Belegung geändert -> Liste auffrischen
      return;
    }

    // Öffentliche Raumliste abrufen (auch anonym; braucht keinen eigenen Raum).
    // Anfrager merken, damit sie Live-Updates bekommen (bis die Verbindung endet).
    if (msg.t === 'rooms') { browsers.add(ws); sendJson(ws, { t: 'rooms', rooms: publicRoomList() }); return; }

    if (!room) return;

    // Host schaltet den Raum öffentlich/privat (nur vor dem Start sinnvoll listbar)
    if (msg.t === 'setpublic' && ws.slot === 0) {
      room.public = !!msg.on;
      sendJson(ws, { t: 'public', on: room.public });
      broadcastRooms();
      return;
    }
    if (msg.t === 'lock' && ws.slot === 0) { room.locked = true; broadcastPresence(); broadcastRooms(); return; } // jetzt "busy", aus der Liste
    if (msg.t === 'leave') { leaveRoom(ws); broadcastPresence(); broadcastRooms(); return; }

    // Nur der Host kann Mitspieler aus dem Raum werfen — und nur VOR Spielstart
    // (nach dem Lock würde ein Rauswurf eine laufende Partie desynchronisieren)
    if (msg.t === 'kick' && ws.slot === 0) {
      if (room.locked) return;
      const slot = msg.slot | 0;
      const target = room.clients.get(slot);
      if (!target || slot < 1) return;
      const gone = target.slots || [slot]; // eine ganze Verbindung fliegt (beide Sitze)
      for (const s of gone) { room.clients.delete(s); if (room.names) delete room.names[s]; }
      target.roomCode = null; target.slots = null; target.slot = null;
      sendJson(target, { t: 'kicked' });         // der Geworfene fällt ins Menü
      sendJson(ws, { t: 'left', slots: gone });   // der Host aktualisiert seine Lobby wie bei 'left'
      broadcastPresence();                        // der Geworfene ist wieder frei/einladbar
      if (room.public) broadcastRooms();
      return;
    }

    // Alles andere: JSON-Relay (Events vom Host, Aktionen von Clients)
    if (ws.slot === 0) {
      // Jede neue Runde macht genau EIN Rundenende wieder buchbar
      if (msg.k === 'round') room.tallied = false;
      // Rundenende: Statistik für angemeldete Spieler buchen. Der Host meldet den
      // Sieger-Slot (w); er ist die einzige Vertrauensstelle (Party-Spiel). Nur in
      // einem echten, gestarteten Spiel mit Mitspielern und nur einmal pro Runde.
      if (msg.k === 'end' && room.locked && room.clients.size >= 1 && !room.tallied) {
        room.tallied = true;
        tallyRound(room, msg.w, msg.dur);
      }
      const s = JSON.stringify(msg);
      for (const c of roomClientSockets(room)) send(c, s); // 2-Sitz-Clients nur einmal
    } else {
      // Nur echte Spiel-Nachrichten (k) durchlassen und das Steuer-Feld t
      // strippen: sonst könnte ein Client dem Host Server-Nachrichten wie
      // {"t":"closed"} unterschieben und damit die Runde für alle beenden
      if (typeof msg.k !== 'string') return;
      delete msg.t;
      // Aktionen tragen einen Sitz (0/1) -> auf den absoluten Slot abbilden, damit
      // der Host weiß, WELCHEN Spieler die Aktion betrifft. Sonst der erste Slot.
      msg.from = (msg.k === 'act' && ws.slots) ? (ws.slots[msg.seat | 0] ?? ws.slot) : ws.slot;
      sendJson(room.host, msg);
    }
}

// Optionale Anmeldung einer WS-Verbindung über ein Session-Token: setzt den
// angezeigten Namen (für Lobby/Scorebar) und die Nutzer-ID (für die Statistik).
// Schlägt sie fehl, bleibt der Spieler anonym — Online-Spielen geht auch ohne Konto.
function authWs(ws, token, token2) {
  const u = token ? userForToken(token) : null;
  // Ändert oder verliert die Verbindung ihre Identität, den alten online-Eintrag
  // entfernen — nie ein Socket mit user=null in `online` zurücklassen. Sonst
  // würfe presenceList() für ALLE und der unentfernbare Eintrag (clearOnline
  // verlangt ws.user) bräche Präsenz/Einladungen bis zum Neustart.
  if (ws.user && online.get(ws.user.id) === ws && (!u || u.id !== ws.user.id)) {
    online.delete(ws.user.id);
  }
  ws.user = u || null;
  ws.name = u ? u.username : null;
  // Zweiter lokaler Sitz (Splitscreen): eigenes Konto NUR für Name + Statistik,
  // KEINE Präsenz/Einladung/Übernahme (nur das Erstkonto ist "online"/einladbar).
  // Ein Konto zählt nicht doppelt, falls versehentlich zweimal dasselbe Token.
  const u2 = token2 ? userForToken(token2) : null;
  ws.user2 = (u2 && (!u || u2.id !== u.id)) ? u2 : null;
}

// Rundenergebnis buchen: jede/r angemeldete aktive Spieler/in bekommt eine
// gespielte Runde, der Sieger-Slot zusätzlich einen Sieg.
function tallyRound(room, winnerSlot, dur) {
  const members = [room.host, ...roomClientSockets(room)]; // 2-Sitz-Clients nur einmal
  for (const c of members) {
    if (!c) continue;
    const slots = c.slots || [];
    // Sitz 0 gehört dem Erstkonto, Sitz 1 dem Zweitkonto (Splitscreen) — jeweils
    // eigene Runden/Siege/Spielzeit buchen. Sieg = genau DER Sitz war der Sieger-Slot.
    if (c.user) { try { recordOnline(c.user.id, slots[0] === winnerSlot, dur); } catch (err) { console.error('stats:', err); } }
    if (c.user2) { try { recordOnline(c.user2.id, slots[1] === winnerSlot, dur); } catch (err) { console.error('stats:', err); } }
  }
}

function leaveRoom(ws) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room) return;
  if (ws.slot === 0) {
    // Host weg -> Raum stirbt, alle Clients zurück ins Menü
    for (const c of roomClientSockets(room)) { sendJson(c, { t: 'closed' }); c.roomCode = null; c.slots = null; c.slot = null; }
    rooms.delete(ws.roomCode);
  } else {
    const gone = ws.slots || [ws.slot];
    for (const s of gone) { room.clients.delete(s); if (room.names) delete room.names[s]; }
    // reconnectable: dieser Client hat gerade die Verbindung verloren (Kulanz aktiv)
    // und könnte zurückkommen -> der Host soll den Raum kurz offen halten.
    sendJson(room.host, { t: 'left', slots: gone, reconnectable: !!ws.graced });
  }
  ws.roomCode = null; ws.slots = null; ws.slot = null;
}

// ---------- Heartbeat: tote Verbindungen zügig trennen ----------
// 6-s-Takt, nach 2 verpassten Pongs raus (~12–18 s). Das begrenzt das Zeitfenster,
// in dem ein abrupt geschlossener (Host-)Client als Zombie-Raum weiterlebt. Für
// angemeldete Nutzer räumt zusätzlich die Sitzungsübernahme (setOnline) sofort auf.
const HEARTBEAT_MS = 6000;
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of ipJoins) if (now - b.at > IP_JOIN_WINDOW_MS * 2) ipJoins.delete(ip);
  for (const [rk, g] of rejoinGrace) if (now - g.at > GRACE_MS) rejoinGrace.delete(rk); // abgelaufene Kulanz
  for (const ws of wss.clients) {
    if (++ws.missedPongs > 2) { ws.terminate(); continue; }
    try { ws.ping(); } catch { /* terminate beim nächsten Takt */ }
  }
}, HEARTBEAT_MS);

// Ein einzelner Relay-Prozess bedient alle Räume — nie unkontrolliert sterben
process.on('uncaughtException', (err) => console.error('uncaught:', err));
process.on('unhandledRejection', (err) => console.error('unhandled:', err));
wss.on('error', (err) => console.error('wss:', err));
http.on('error', (err) => { console.error('http:', err); process.exit(1); });

http.listen(PORT, () => {
  console.log(`RUN OR DIE Server: http://localhost:${PORT}  (Relay: /ws${LAG ? `, LAG=${LAG}ms` : ''})`);
});
