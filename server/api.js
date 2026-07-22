// HTTP-JSON-API für Benutzerkonten: Registrieren, Login, Konto, Bestenliste,
// Solo-Score melden. Läuft auf demselben node:http-Server wie die statischen
// Dateien; hinter nginx unter /runordie/api/… erreichbar (same-origin).
import {
  createUser, findUser, verifyPassword, newSession, userForToken, endSession,
  recordSolo, leaderboard, publicUser, validUsername, validPassword,
} from './db.js';

const MAX_BODY = 4 * 1024;

// Login-Bruteforce bremsen: pro IP begrenzte Fehlversuche im Zeitfenster
const loginFails = new Map(); // ip -> { n, at }
const LOGIN_MAX = 10, LOGIN_WINDOW_MS = 5 * 60 * 1000;
function loginBlocked(ip) {
  const b = loginFails.get(ip);
  if (!b) return false;
  if (Date.now() - b.at > LOGIN_WINDOW_MS) { loginFails.delete(ip); return false; }
  return b.n >= LOGIN_MAX;
}
function loginFail(ip) {
  const now = Date.now();
  const b = loginFails.get(ip) || { n: 0, at: now };
  if (now - b.at > LOGIN_WINDOW_MS) { b.n = 0; b.at = now; }
  b.n++; loginFails.set(ip, b);
}

// Registrierungen pro IP drosseln: sonst könnte ein Angreifer die DB fluten und
// (über scrypt je Aufruf) CPU verbrennen. JEDER Versuch zählt, nicht nur Fehler.
const regHits = new Map(); // ip -> { n, at }
const REG_MAX = 8, REG_WINDOW_MS = 60 * 60 * 1000;
function regBlocked(ip) {
  const now = Date.now();
  const b = regHits.get(ip) || { n: 0, at: now };
  if (now - b.at > REG_WINDOW_MS) { b.n = 0; b.at = now; }
  b.n++; regHits.set(ip, b);
  return b.n > REG_MAX;
}

// Speicher der Rate-Limiter gelegentlich säubern (verwaiste IP-Einträge)
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of loginFails) if (now - b.at > LOGIN_WINDOW_MS) loginFails.delete(ip);
  for (const [ip, b] of regHits) if (now - b.at > REG_WINDOW_MS) regHits.delete(ip);
}, 10 * 60 * 1000).unref?.();

function readJson(req) {
  return new Promise((resolve) => {
    let buf = '', done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      buf += c;
      if (buf.length > MAX_BODY) { req.destroy(); finish(null); } // Überlänge: sofort abbrechen
    });
    req.on('end', () => { try { finish(JSON.parse(buf || '{}')); } catch { finish(null); } });
    req.on('error', () => finish(null));
    req.on('close', () => finish(null)); // hängt kein end/error nach -> Promise trotzdem lösen
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function bearer(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Gibt true zurück, wenn die Anfrage als API behandelt wurde
export async function handleApi(req, res, path, ip) {
  if (!path.startsWith('/api/')) return false;
  const route = path.slice(4); // "/api/x" -> "/x"

  try {
    if (req.method === 'POST' && (route === '/register' || route === '/login')) {
      if (loginBlocked(ip)) { sendJson(res, 429, { error: 'Zu viele Versuche, bitte später erneut' }); return true; }
      const body = await readJson(req);
      if (!body) { sendJson(res, 400, { error: 'Ungültige Anfrage' }); return true; }
      const username = String(body.username || '').trim();
      const password = String(body.password || '');

      if (route === '/register') {
        if (regBlocked(ip)) { sendJson(res, 429, { error: 'Zu viele Registrierungen, bitte später erneut' }); return true; }
        if (!validUsername(username)) { sendJson(res, 400, { error: 'Name: 3–16 Zeichen, nur A–Z, 0–9, _' }); return true; }
        if (!validPassword(password)) { sendJson(res, 400, { error: 'Passwort: mindestens 6 Zeichen' }); return true; }
        if (findUser(username)) { sendJson(res, 409, { error: 'Name ist bereits vergeben' }); return true; }
        const user = await createUser(username, password);
        const token = newSession(user.id);
        sendJson(res, 200, { token, user: publicUser(user) });
        return true;
      }

      // /login
      const user = findUser(username);
      // Immer scrypt rechnen (auch bei unbekanntem Namen), um Timing-Leaks zu
      // vermeiden, die Namen enumerierbar machen würden
      const ok = user
        ? await verifyPassword(password, user.pass_hash, user.pass_salt)
        : await verifyPassword(password, '00', 'ff');
      if (!user || !ok) { loginFail(ip); sendJson(res, 401, { error: 'Name oder Passwort falsch' }); return true; }
      const token = newSession(user.id);
      sendJson(res, 200, { token, user: publicUser(user) });
      return true;
    }

    if (req.method === 'POST' && route === '/logout') {
      endSession(bearer(req));
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'GET' && route === '/me') {
      const user = userForToken(bearer(req));
      if (!user) { sendJson(res, 401, { error: 'Nicht angemeldet' }); return true; }
      sendJson(res, 200, { user: publicUser(user) });
      return true;
    }

    if (req.method === 'POST' && route === '/score') {
      const user = userForToken(bearer(req));
      if (!user) { sendJson(res, 401, { error: 'Nicht angemeldet' }); return true; }
      const body = await readJson(req);
      const time = Math.max(0, Math.min(100000, (body?.time | 0)));
      recordSolo(user.id, time);
      sendJson(res, 200, { user: publicUser(userForToken(bearer(req))) });
      return true;
    }

    if (req.method === 'GET' && route === '/leaderboard') {
      sendJson(res, 200, { top: leaderboard(20) });
      return true;
    }

    sendJson(res, 404, { error: 'Unbekannte Route' });
    return true;
  } catch (err) {
    console.error('api:', err);
    sendJson(res, 500, { error: 'Serverfehler' });
    return true;
  }
}
