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

const PORT = +(process.env.PORT || 8080);
const LAG = +(process.env.LAG || 0); // ms künstliche Einweg-Latenz (Latenz-Tests)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_PLAYERS = 4;

// ---------- Statische Dateien (nur Whitelist, kein Verzeichnis-Traversal) ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
};

const http = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
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

wss.on('connection', (ws) => {
  ws.roomCode = null; ws.slot = null; ws.missedPongs = 0;
  ws.on('pong', () => { ws.missedPongs = 0; });

  ws.on('message', (data, isBinary) => {
    // Ein geworfener Handler darf niemals den Relay-Prozess (alle Räume!) töten
    try { handleMessage(ws, data, isBinary); } catch (err) { console.error('message handler:', err); }
  });

  ws.on('close', () => { try { leaveRoom(ws); } catch (err) { console.error('leave:', err); } });
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

    if (msg.t === 'create') {
      if (ws.roomCode) { sendJson(ws, { t: 'err', msg: 'Schon in einem Raum' }); return; }
      const code = newCode();
      if (!code) { sendJson(ws, { t: 'err', msg: 'Server voll' }); return; }
      rooms.set(code, { host: ws, clients: new Map(), locked: false });
      ws.roomCode = code; ws.slot = 0;
      sendJson(ws, { t: 'created', code });
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
      r.clients.set(slot, ws);
      ws.roomCode = code; ws.slot = slot;
      sendJson(ws, { t: 'joined', code, slot });
      sendJson(r.host, { t: 'peer', slot });
      return;
    }

    if (!room) return;

    if (msg.t === 'lock' && ws.slot === 0) { room.locked = true; return; }
    if (msg.t === 'leave') { leaveRoom(ws); return; }

    // Alles andere: JSON-Relay (Events vom Host, Aktionen von Clients)
    if (ws.slot === 0) {
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

function leaveRoom(ws) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room) return;
  if (ws.slot === 0) {
    // Host weg -> Raum stirbt, alle Clients zurück ins Menü
    for (const c of room.clients.values()) { sendJson(c, { t: 'closed' }); c.roomCode = null; c.slot = null; }
    rooms.delete(ws.roomCode);
  } else {
    room.clients.delete(ws.slot);
    sendJson(room.host, { t: 'left', slot: ws.slot });
  }
  ws.roomCode = null; ws.slot = null;
}

// ---------- Heartbeat: tote Verbindungen nach ~30-40 s trennen ----------
setInterval(() => {
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
