// Fehler-Reports auswerten ("crunchen"). Öffnet die DB NUR LESEND (eigene
// Verbindung, damit der laufende Dienst ungestört bleibt und keine
// -wal/-shm-Dateien mit fremdem Eigentümer entstehen).
//   npm run errors            (nutzt denselben DB_PATH wie der Dienst)
//   node errors.js recent [n] (die letzten Roh-Einträge)
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(HERE, 'data', 'runordie.db');
let db;
try { db = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
catch { console.log('Keine Datenbank unter ' + DB_PATH + ' (noch keine Reports?).'); process.exit(0); }

const [, , mode, arg] = process.argv;
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 90) return s + 's';
  if (s < 5400) return Math.round(s / 60) + 'm';
  if (s < 129600) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
};
// Steuerzeichen sind beim Speichern entfernt; hier defensiv nochmal (Alt-Daten)
const safe = (s) => String(s ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

const total = db.prepare('SELECT COUNT(*) AS n FROM errors').get().n;
console.log(`\n${total} Fehler-Reports gesamt\n`);
if (!total) { console.log('Keine Fehler gemeldet. 🎉\n'); process.exit(0); }

if (mode === 'recent') {
  const rows = db.prepare('SELECT * FROM errors ORDER BY id DESC LIMIT ?').all(Math.min(500, +arg || 30));
  for (const e of rows) {
    console.log(`— ${new Date(e.at).toISOString()}  [${safe(e.kind)}]  user=${e.user_id ?? '-'}`);
    console.log('  ' + safe(e.message));
    if (e.stack) console.log('  ' + safe(e.stack).split('\n').slice(0, 4).join('\n  '));
    console.log(`  ${safe(e.url)}\n  ${safe(e.ua).slice(0, 90)}\n`);
  }
} else {
  const groups = db.prepare(
    `SELECT sig, kind, COUNT(*) AS n, MAX(at) AS last, COUNT(DISTINCT user_id) AS users, message, stack
     FROM errors GROUP BY sig ORDER BY n DESC, last DESC LIMIT ?`).all(Math.min(200, +arg || 40));
  console.log('Nach Häufigkeit gruppiert (Signatur = Meldung + oberster Frame):\n');
  for (const g of groups) {
    console.log(`  ${String(g.n).padStart(4)}×  ${g.users} Nutzer  zuletzt vor ${ago(g.last)}  [${safe(g.kind)}]`);
    console.log(`        ${safe(g.message)}`);
    const frame = safe(g.stack).split('\n').find((l) => /\.(m?js)|https?:/.test(l));
    if (frame) console.log(`        ${frame.trim().slice(0, 100)}`);
    console.log('');
  }
  console.log('Roh-Einträge: node errors.js recent 50\n');
}
process.exit(0);
