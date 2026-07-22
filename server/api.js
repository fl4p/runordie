// HTTP-JSON-API für Benutzerkonten: Registrieren, Login, Konto, Bestenliste,
// Solo-Score melden. Das Frontend liegt auf GitHub Pages, ruft die API also
// CROSS-ORIGIN auf -> CORS nötig. Erlaubte Origins per CORS_ORIGINS (kommagetrennt),
// Standard das GitHub-Pages-Frontend; localhost ist für Entwicklung immer erlaubt.
import {
  createUser, findUser, verifyPassword, newSession, userForToken, endSession,
  recordSolo, leaderboard, publicUser, validUsername, validPassword, recordError,
} from './db.js';

const MAX_BODY = 4 * 1024;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'https://fl4p.github.io')
  .split(',').map((s) => s.trim()).filter(Boolean);
function corsAllows(origin) {
  return !!origin && (CORS_ORIGINS.includes(origin) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
}

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

// Fehler-Reports pro IP drosseln: ein kaputter Build könnte sonst je Client
// eine Flut auslösen (Client cappt zwar selbst, aber doppelt hält besser).
const errHits = new Map(); // ip -> { n, at }
const ERR_MAX = 40, ERR_WINDOW_MS = 60 * 1000;
function errBlocked(ip) {
  const now = Date.now();
  const b = errHits.get(ip) || { n: 0, at: now };
  if (now - b.at > ERR_WINDOW_MS) { b.n = 0; b.at = now; }
  b.n++; errHits.set(ip, b);
  return b.n > ERR_MAX;
}

// Speicher der Rate-Limiter gelegentlich säubern (verwaiste IP-Einträge)
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of loginFails) if (now - b.at > LOGIN_WINDOW_MS) loginFails.delete(ip);
  for (const [ip, b] of regHits) if (now - b.at > REG_WINDOW_MS) regHits.delete(ip);
  for (const [ip, b] of errHits) if (now - b.at > ERR_WINDOW_MS * 5) errHits.delete(ip);
}, 10 * 60 * 1000).unref?.();

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve) => {
    let buf = '', done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      buf += c;
      if (buf.length > limit) { req.destroy(); finish(null); } // Überlänge: sofort abbrechen
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

  // CORS: erlaubten Origin zurückspiegeln (setHeader bleibt bei writeHead erhalten).
  // Keine Cookies -> keine credentials; das Token reist im Authorization-Header.
  const origin = req.headers.origin;
  if (corsAllows(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-max-age', '600');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; } // Preflight

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

    // Fehler-Report vom Client (unbehandelte Fehler / Promise-Rejections).
    // Kein Login nötig (Fehler passieren auch vorher); stark gedrosselt.
    if (req.method === 'POST' && route === '/error') {
      if (errBlocked(ip)) { res.writeHead(429); res.end(); return true; }
      const body = await readJson(req, 16 * 1024); // Stacks können lang sein

      if (body && typeof body === 'object') {
        const user = userForToken(bearer(req)); // optional
        recordError({
          kind: body.kind, message: body.message, stack: body.stack,
          url: body.url, ua: body.ua || req.headers['user-agent'], userId: user?.id,
        });
      }
      res.writeHead(204); res.end(); // immer 204, nie ein Fehler-über-Fehler
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
