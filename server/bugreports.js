// Bug-Reports auswerten (Spieler-Mitschnitte vom 🐛-Knopf im Spiel). Öffnet die
// DB NUR LESEND (eigene Verbindung, damit der laufende Dienst ungestört bleibt).
//   npm run bugreports              (letzte Reports, kurz)
//   node bugreports.js show <id>    (volle Frames als JSON, z.B. zum Weiterreichen
//                                     an eine Analyse/Visualisierung)
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
const safe = (s) => String(s ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

if (mode === 'show') {
  const row = db.prepare('SELECT * FROM bug_reports WHERE id = ?').get(+arg || 0);
  if (!row) { console.log('Kein Report mit dieser ID.'); process.exit(1); }
  let frames;
  try { frames = JSON.parse(row.frames); } catch { frames = null; }
  console.log(`Report #${row.id}  ${new Date(row.at).toISOString()}  [${safe(row.mode)}]  user=${row.user_id ?? '-'}`);
  console.log(`Notiz: ${safe(row.note) || '(keine)'}`);
  console.log(`Rundenzeit: ${row.elapsed ?? '?'}s  Ping: ${row.ping ?? '-'}ms`);
  console.log(`${safe(row.url)}\n${safe(row.ua)}\n`);
  console.log(`Frames (${Array.isArray(frames) ? frames.length : 0}), Format je Sample:`);
  console.log('  { t, el, pl:[[id,x,y,z,flags]…], ob:[[x,y,z,kind]…], sh:[[x,y,z]…], la:[[z,type]…] }\n');
  console.log(JSON.stringify(frames, null, 1));
  process.exit(0);
}

const total = db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get().n;
console.log(`\n${total} Bug-Reports gesamt\n`);
if (!total) { console.log('Keine Reports. 🎉\n'); process.exit(0); }

const rows = db.prepare(
  `SELECT id, at, note, mode, elapsed, ping, user_id, length(frames) AS frames_len
   FROM bug_reports ORDER BY id DESC LIMIT ?`).all(Math.min(200, +arg || 30));
for (const r of rows) {
  console.log(`#${r.id}  vor ${ago(r.at)}  [${safe(r.mode)}]  Runde ${r.elapsed ?? '?'}s  ` +
    `Ping ${r.ping ?? '-'}ms  user=${r.user_id ?? '-'}  (${r.frames_len}B Frames)`);
  console.log('  ' + (safe(r.note) || '(keine Notiz)'));
}
console.log(`\nVolle Frames: node bugreports.js show <id>\n`);
process.exit(0);
