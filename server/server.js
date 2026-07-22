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

// Spielframes sind klein (Snapshots < 2 KB, Spawn-Events wenige KB) — das
// ws-Default von 100 MiB wäre ein Speicher-Verstärker für böswillige Clients
const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 64 * 1024 });

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
  const origin = req.headers.origin;
  // Same-Origin immer erlauben (der Browser sendet den Header auch dann mit) —
  // eine Allowlist ohne die eigene Serving-Domain sperrte sonst die eigene Seite aus
  const sameOrigin = origin && req.headers.host && origin.endsWith('//' + req.headers.host);
  if (ALLOWED_ORIGINS.length && origin && !sameOrigin && !ALLOWED_ORIGINS.includes(origin)) {
    ws.close(1008, 'origin'); return; // fremde Website bindet Besucher-Browser ein
  }
  ws.ip = clientIp(req);
  const nIp = (ipConns.get(ws.ip) || 0) + 1;
  if (nIp > MAX_CONNS_PER_IP) { ws.close(1013, 'too many connections'); return; }
  ipConns.set(ws.ip, nIp);
  ws.roomCode = null; ws.slot = null; ws.missedPongs = 0;
  ws.joinCount = 0; ws.joinWindowAt = 0;
  ws.on('pong', () => { ws.missedPongs = 0; });

  ws.on('message', (data, isBinary) => {
    // Ein geworfener Handler darf niemals den Relay-Prozess (alle Räume!) töten
    try { handleMessage(ws, data, isBinary); } catch (err) { console.error('message handler:', err); }
  });

  ws.on('close', () => {
    const c = (ipConns.get(ws.ip) || 1) - 1;
    c > 0 ? ipConns.set(ws.ip, c) : ipConns.delete(ws.ip);
    try { leaveRoom(ws); } catch (err) { console.error('leave:', err); }
  });
  ws.on('error', () => { /* close folgt */ });
});

function handleMessage(ws, data, isBinary) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;

    // ---- Binärframes: reines Relay (Snapshots vom Host, Inputs von Clients) ----
    if (isBinary) {
      if (!room) return;
      if (ws.slot === 0) {
        for (const c of room.clients.values()) send(c, data, true);
      } else {
        // Absender-Slot voranstellen, damit der Host weiß, wessen Input das ist
        const stamped = Buffer.concat([Buffer.from([ws.slot]), data]);
        send(room.host, stamped, true);
      }
      return;
    }

    // ---- Textframes: Steuerprotokoll oder JSON-Relay ----
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

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
      authWs(ws, msg.token); // optionale Anmeldung -> ws.user / ws.name
      rooms.set(code, { host: ws, clients: new Map(), locked: false, names: { 0: ws.name } });
      ws.roomCode = code; ws.slot = 0;
      sendJson(ws, { t: 'created', code, name: ws.name });
      return;
    }

    if (msg.t === 'join') {
      if (ws.roomCode) { sendJson(ws, { t: 'err', msg: 'Schon in einem Raum' }); return; }
      const code = String(msg.code || '').toUpperCase().trim();
      const r = rooms.get(code);
      if (!r) { sendJson(ws, { t: 'err', msg: 'Raum nicht gefunden' }); return; }
      if (r.locked) { sendJson(ws, { t: 'err', msg: 'Spiel läuft schon' }); return; }
      let slot = -1; // kleinster freier Slot 1..3
      for (let s = 1; s < MAX_PLAYERS; s++) if (!r.clients.has(s)) { slot = s; break; }
      if (slot < 0) { sendJson(ws, { t: 'err', msg: 'Raum ist voll (4 Spieler)' }); return; }
      authWs(ws, msg.token);
      r.clients.set(slot, ws);
      r.names[slot] = ws.name;
      ws.roomCode = code; ws.slot = slot;
      sendJson(ws, { t: 'joined', code, slot, names: { ...r.names } }); // bekannte Namen mitschicken
      sendJson(r.host, { t: 'peer', slot, name: ws.name });
      return;
    }

    if (!room) return;

    if (msg.t === 'lock' && ws.slot === 0) { room.locked = true; return; }
    if (msg.t === 'leave') { leaveRoom(ws); return; }

    // Alles andere: JSON-Relay (Events vom Host, Aktionen von Clients)
    if (ws.slot === 0) {
      // Jede neue Runde macht genau EIN Rundenende wieder buchbar
      if (msg.k === 'round') room.tallied = false;
      // Rundenende: Statistik für angemeldete Spieler buchen. Der Host meldet den
      // Sieger-Slot (w); er ist die einzige Vertrauensstelle (Party-Spiel). Nur in
      // einem echten, gestarteten Spiel mit Mitspielern und nur einmal pro Runde —
      // sonst könnte ein Host in einem leeren Raum beliebig Siege erzeugen.
      if (msg.k === 'end' && room.locked && room.clients.size >= 1 && !room.tallied) {
        room.tallied = true;
        tallyRound(room, msg.w);
      }
      const s = JSON.stringify(msg);
      for (const c of room.clients.values()) send(c, s);
    } else {
      // Nur echte Spiel-Nachrichten (k) durchlassen und das Steuer-Feld t
      // strippen: sonst könnte ein Client dem Host Server-Nachrichten wie
      // {"t":"closed"} unterschieben und damit die Runde für alle beenden
      if (typeof msg.k !== 'string') return;
      delete msg.t;
      msg.from = ws.slot;
      sendJson(room.host, msg);
    }
}

// Optionale Anmeldung einer WS-Verbindung über ein Session-Token: setzt den
// angezeigten Namen (für Lobby/Scorebar) und die Nutzer-ID (für die Statistik).
// Schlägt sie fehl, bleibt der Spieler anonym — Online-Spielen geht auch ohne Konto.
function authWs(ws, token) {
  const u = token ? userForToken(token) : null;
  ws.user = u || null;
  ws.name = u ? u.username : null;
}

// Rundenergebnis buchen: jede/r angemeldete aktive Spieler/in bekommt eine
// gespielte Runde, der Sieger-Slot zusätzlich einen Sieg.
function tallyRound(room, winnerSlot) {
  const members = [room.host, ...room.clients.values()];
  for (const c of members) {
    if (!c?.user) continue;
    try { recordOnline(c.user.id, c.slot === winnerSlot); } catch (err) { console.error('stats:', err); }
  }
}

function leaveRoom(ws) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room) return;
  if (ws.slot === 0) {
    // Host weg -> Raum stirbt, alle Clients zurück ins Menü
    for (const c of room.clients.values()) { sendJson(c, { t: 'closed' }); c.roomCode = null; c.slot = null; }
    rooms.delete(ws.roomCode);
  } else {
    room.clients.delete(ws.slot);
    if (room.names) delete room.names[ws.slot];
    sendJson(room.host, { t: 'left', slot: ws.slot });
  }
  ws.roomCode = null; ws.slot = null;
}

// ---------- Heartbeat: tote Verbindungen nach ~30-40 s trennen ----------
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of ipJoins) if (now - b.at > IP_JOIN_WINDOW_MS * 2) ipJoins.delete(ip);
  for (const ws of wss.clients) {
    if (++ws.missedPongs > 3) { ws.terminate(); continue; }
    try { ws.ping(); } catch { /* terminate beim nächsten Takt */ }
  }
}, 10000);

// Ein einzelner Relay-Prozess bedient alle Räume — nie unkontrolliert sterben
process.on('uncaughtException', (err) => console.error('uncaught:', err));
process.on('unhandledRejection', (err) => console.error('unhandled:', err));
wss.on('error', (err) => console.error('wss:', err));
http.on('error', (err) => { console.error('http:', err); process.exit(1); });

http.listen(PORT, () => {
  console.log(`RUN OR DIE Server: http://localhost:${PORT}  (Relay: /ws${LAG ? `, LAG=${LAG}ms` : ''})`);
});
