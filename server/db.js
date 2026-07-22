// Persistenz für Benutzerkonten, Sessions und Statistiken (SQLite).
// Bewusst synchron (better-sqlite3): der Relay ist ein einzelner Node-Prozess,
// die Datenmengen sind klein, und synchroner Code erspart Race-Conditions.
import Database from 'better-sqlite3';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scryptAsync = promisify(scrypt);

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(HERE, 'data', 'runordie.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // gleichzeitige Lese-/Schreibzugriffe, crash-fest
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL COLLATE NOCASE,
    pass_hash     TEXT NOT NULL,
    pass_salt     TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    best_time     INTEGER NOT NULL DEFAULT 0,  -- beste Solo-Überlebenszeit (s)
    games         INTEGER NOT NULL DEFAULT 0,  -- Solo-Läufe gewertet
    online_rounds INTEGER NOT NULL DEFAULT 0,  -- Online-Runden gespielt
    online_wins   INTEGER NOT NULL DEFAULT 0   -- Online-Runden gewonnen
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_users_best ON users(best_time DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS errors (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      INTEGER NOT NULL,   -- Zeitstempel (ms)
    kind    TEXT,               -- 'error' | 'rejection'
    message TEXT,
    stack   TEXT,
    url     TEXT,               -- location.href des Clients
    ua      TEXT,               -- User-Agent (gekürzt)
    user_id INTEGER,            -- falls angemeldet
    sig     TEXT                -- Gruppierungs-Signatur (Meldung + oberster Frame)
  );
  CREATE INDEX IF NOT EXISTS idx_errors_at ON errors(at);
  CREATE INDEX IF NOT EXISTS idx_errors_sig ON errors(sig);
`);

// Migration: gesamte Spielzeit (Sekunden). ADD COLUMN ist idempotent gemacht —
// bei bestehender Produktions-DB darf nichts verloren gehen (nur anhängen).
if (!db.prepare(`SELECT 1 FROM pragma_table_info('users') WHERE name='play_seconds'`).get()) {
  db.exec(`ALTER TABLE users ADD COLUMN play_seconds INTEGER NOT NULL DEFAULT 0`); // Summe aus Solo + Online
}

// ---------- Passwörter: scrypt (aus node:crypto, keine Extra-Abhängigkeit) ----------
// ASYNC: scrypt braucht ~50–100 ms; synchron würde es den einzigen Node-Thread
// blockieren und damit ALLE laufenden Spiele einfrieren (das Relay teilt sich
// den Prozess). Die Callback-Variante rechnet im libuv-Threadpool.
const SCRYPT_LEN = 64;
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, SCRYPT_LEN)).toString('hex');
  return { hash, salt };
}
export async function verifyPassword(password, hash, salt) {
  let derived;
  try { derived = await scryptAsync(password, salt, SCRYPT_LEN); } catch { return false; }
  const stored = Buffer.from(hash, 'hex');
  // Länge zuerst prüfen: timingSafeEqual wirft bei ungleicher Länge
  return stored.length === derived.length && timingSafeEqual(stored, derived);
}

// ---------- Statements ----------
const stmt = {
  insertUser: db.prepare(
    `INSERT INTO users (username, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?)`),
  userByName: db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`),
  userById: db.prepare(`SELECT * FROM users WHERE id = ?`),
  insertSession: db.prepare(
    `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`),
  sessionByToken: db.prepare(`SELECT * FROM sessions WHERE token = ?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),
  deleteExpired: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),
  bumpBest: db.prepare(
    `UPDATE users SET best_time = MAX(best_time, ?), games = games + 1, play_seconds = play_seconds + ? WHERE id = ?`),
  bumpOnline: db.prepare(
    `UPDATE users SET online_rounds = online_rounds + 1, online_wins = online_wins + ?, play_seconds = play_seconds + ? WHERE id = ?`),
  leaderboard: db.prepare(
    `SELECT username, best_time, games, online_wins FROM users
     WHERE best_time > 0 ORDER BY best_time DESC, username ASC LIMIT ?`),
  insertErr: db.prepare(
    `INSERT INTO errors (at, kind, message, stack, url, ua, user_id, sig) VALUES (?,?,?,?,?,?,?,?)`),
  trimErr: db.prepare(`DELETE FROM errors WHERE id <= (SELECT MAX(id) FROM errors) - ?`),
  errGroups: db.prepare(
    `SELECT sig, kind, COUNT(*) AS n, MAX(at) AS last, MIN(at) AS first,
            COUNT(DISTINCT user_id) AS users, message, stack, url
     FROM errors GROUP BY sig ORDER BY n DESC, last DESC LIMIT ?`),
  errRecent: db.prepare(`SELECT * FROM errors ORDER BY id DESC LIMIT ?`),
  errCount: db.prepare(`SELECT COUNT(*) AS n FROM errors`),
};

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 Tage
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export function validUsername(u) { return typeof u === 'string' && USERNAME_RE.test(u); }
export function validPassword(p) { return typeof p === 'string' && p.length >= 6 && p.length <= 200; }

export async function createUser(username, password) {
  const { hash, salt } = await hashPassword(password);
  const info = stmt.insertUser.run(username, hash, salt, Date.now());
  return stmt.userById.get(info.lastInsertRowid);
}
export function findUser(username) { return stmt.userByName.get(username); }

export function newSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  stmt.insertSession.run(token, userId, now, now + SESSION_TTL_MS);
  return token;
}
export function userForToken(token) {
  if (!token) return null;
  const s = stmt.sessionByToken.get(token);
  if (!s) return null;
  if (s.expires_at < Date.now()) { stmt.deleteSession.run(token); return null; }
  return stmt.userById.get(s.user_id) || null;
}
export function endSession(token) { if (token) stmt.deleteSession.run(token); }

// time = Solo-Überlebenszeit dieses Laufs -> zählt auch als Spielzeit
export function recordSolo(userId, time) { stmt.bumpBest.run(time | 0, Math.max(0, time | 0), userId); }
// dur = Dauer der Online-Runde in Sekunden (vom Host gemeldet) -> Spielzeit
export function recordOnline(userId, won, dur = 0) {
  stmt.bumpOnline.run(won ? 1 : 0, Math.max(0, Math.min(100000, dur | 0)), userId);
}
export function leaderboard(limit = 20) { return stmt.leaderboard.all(Math.min(100, limit | 0 || 20)); }

// Öffentliche Sicht auf ein Konto (nie den Hash herausgeben)
export function publicUser(u) {
  return u && {
    id: u.id, username: u.username, bestTime: u.best_time,
    games: u.games, onlineRounds: u.online_rounds, onlineWins: u.online_wins,
    playSeconds: u.play_seconds | 0,
  };
}

// ---------- Fehler-Reports (vom Client gemeldete unbehandelte Fehler) ----------
// Signatur zum Gruppieren: Meldung + oberster Code-Frame ohne Zeilennummern,
// damit gleiche Bugs von verschiedenen Geräten/Builds zusammenfallen.
function errSig(message, stack) {
  const top = String(stack || '').split('\n').find((l) => /\.(m?js)|https?:/.test(l)) || '';
  const norm = top.replace(/:\d+:\d+/g, '').replace(/\?[^ )]*/g, '').trim().slice(0, 140);
  return (String(message || '').slice(0, 120) + ' | ' + norm).slice(0, 260);
}
// Steuerzeichen entfernen (außer Zeilenumbruch/Tab): sonst könnten vom Client
// eingeschmuggelte ANSI-/Terminal-Escapes die Ausgabe von errors.js manipulieren.
const clean = (s, n) => String(s ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, n);
export function recordError(e) {
  const message = clean(e.message, 500), stack = clean(e.stack, 4000);
  stmt.insertErr.run(
    Date.now(), clean(e.kind, 20), message, stack, clean(e.url, 300),
    clean(e.ua, 200), e.userId || null, errSig(message, stack));
  if (Math.random() < 0.03) stmt.trimErr.run(5000); // Ringpuffer: letzte ~5000 behalten
}
export function errorGroups(limit = 50) { return stmt.errGroups.all(Math.min(200, limit | 0 || 50)); }
export function recentErrors(limit = 50) { return stmt.errRecent.all(Math.min(500, limit | 0 || 50)); }
export function errorCount() { return stmt.errCount.get().n; }

// Abgelaufene Sessions gelegentlich wegräumen
setInterval(() => { try { stmt.deleteExpired.run(Date.now()); } catch { /* egal */ } }, 3600 * 1000).unref?.();

export default db;
