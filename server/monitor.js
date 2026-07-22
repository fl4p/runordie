// Überwachung — läuft periodisch per systemd-Timer und schickt ntfy-Push-Alarme:
//   1) Dienst-Gesundheit: Health-Check gegen die lokale API. Alarm nur bei WECHSEL
//      (down / wieder up), damit es nicht bei jedem Lauf spamt.
//   2) Neue Fehler-Reports: seit dem letzten Lauf (Zustand in data/.monitor_state),
//      gruppiert, als ein Alarm.
// Konfig per Env: NTFY_URL, HEALTH_URL, DB_PATH. Abonnieren: die NTFY_URL im
// ntfy-App/Browser öffnen (z. B. https://ntfy.sh/<topic>).
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(HERE, 'data', 'runordie.db');
const STATE = process.env.STATE_PATH || join(HERE, 'data', '.monitor_state');
const NTFY = process.env.NTFY_URL || 'https://ntfy.sh/runordie-mon-fl4p-3v9k2x8';
const HEALTH = process.env.HEALTH_URL || 'http://127.0.0.1:18931/api/leaderboard';

async function ntfy(title, body, priority = 'default', tags = '') {
  try {
    // HTTP-Header müssen ASCII sein -> kein Emoji im Title (ntfy zeigt Emojis über Tags).
    const safeTitle = String(title).replace(/[^\x20-\x7e]/g, '').trim() || 'RUN OR DIE';
    await fetch(NTFY, { method: 'POST', headers: { Title: safeTitle, Priority: priority, Tags: tags }, body: String(body).slice(0, 3000) });
  } catch { /* Netz weg -> nächster Lauf versucht es erneut */ }
}

let state = { lastId: 0, healthy: true };
try { state = { ...state, ...JSON.parse(readFileSync(STATE, 'utf8')) }; } catch { /* erster Lauf */ }

// 1) Gesundheit — Alarm nur bei Statuswechsel
let healthy = false;
try { const r = await fetch(HEALTH, { signal: AbortSignal.timeout(8000) }); healthy = r.ok; } catch { /* down */ }
if (!healthy && state.healthy) await ntfy('RUN OR DIE Backend DOWN', 'Health-Check fehlgeschlagen: ' + HEALTH, 'urgent', 'rotating_light');
else if (healthy && !state.healthy) await ntfy('RUN OR DIE Backend wieder OK', 'Health-Check erfolgreich', 'default', 'white_check_mark');

// 2) Neue Fehler seit dem letzten Lauf
let maxId = state.lastId;
try {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const rows = db.prepare('SELECT id, kind, message, sig FROM errors WHERE id > ? ORDER BY id').all(state.lastId);
  db.close();
  if (rows.length) {
    maxId = rows[rows.length - 1].id;
    const groups = new Map();
    for (const e of rows) { const g = groups.get(e.sig) || { n: 0, msg: e.message, kind: e.kind }; g.n++; groups.set(e.sig, g); }
    const body = [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 10)
      .map((g) => `${g.n}× [${g.kind}] ${String(g.msg).slice(0, 90)}`).join('\n');
    await ntfy(`RUN OR DIE: ${rows.length} neue Fehler (${groups.size} Arten)`, body, 'high', 'warning');
  }
} catch { /* keine DB / keine errors-Tabelle -> nichts zu tun */ }

try { writeFileSync(STATE, JSON.stringify({ lastId: maxId, healthy })); } catch (e) { console.error('state write:', e.message); }
process.exit(0);
