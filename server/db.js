// Persistenz für Benutzerkonten, Sessions und Statistiken (SQLite).
// Bewusst synchron (better-sqlite3): der Relay ist ein einzelner Node-Prozess,
// die Datenmengen sind klein, und synchroner Code erspart Race-Conditions.
import Database from 'better-sqlite3';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
`);

// ---------- Passwörter: scrypt (aus node:crypto, keine Extra-Abhängigkeit) ----------
const SCRYPT_LEN = 64;
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_LEN).toString('hex');
  return { hash, salt };
}
export function verifyPassword(password, hash, salt) {
  let derived;
  try { derived = scryptSync(password, salt, SCRYPT_LEN); } catch { return false; }
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
    `UPDATE users SET best_time = MAX(best_time, ?), games = games + 1 WHERE id = ?`),
  bumpOnline: db.prepare(
    `UPDATE users SET online_rounds = online_rounds + 1, online_wins = online_wins + ? WHERE id = ?`),
  leaderboard: db.prepare(
    `SELECT username, best_time, games, online_wins FROM users
     WHERE best_time > 0 ORDER BY best_time DESC, username ASC LIMIT ?`),
};

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 Tage
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export function validUsername(u) { return typeof u === 'string' && USERNAME_RE.test(u); }
export function validPassword(p) { return typeof p === 'string' && p.length >= 6 && p.length <= 200; }

export function createUser(username, password) {
  const { hash, salt } = hashPassword(password);
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

export function recordSolo(userId, time) { stmt.bumpBest.run(time | 0, userId); }
export function recordOnline(userId, won) { stmt.bumpOnline.run(won ? 1 : 0, userId); }
export function leaderboard(limit = 20) { return stmt.leaderboard.all(Math.min(100, limit | 0 || 20)); }

// Öffentliche Sicht auf ein Konto (nie den Hash herausgeben)
export function publicUser(u) {
  return u && {
    id: u.id, username: u.username, bestTime: u.best_time,
    games: u.games, onlineRounds: u.online_rounds, onlineWins: u.online_wins,
  };
}

// Abgelaufene Sessions gelegentlich wegräumen
setInterval(() => { try { stmt.deleteExpired.run(Date.now()); } catch { /* egal */ } }, 3600 * 1000).unref?.();

export default db;
