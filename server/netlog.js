// Netz-Telemetrie auswerten ("crunchen"): die Verbindungsereignisse, die der
// Client mit kind='net' an /api/error meldet (WS-Close-Codes, Reconnect-Ergebnis).
// Öffnet die DB NUR LESEND (eigene Verbindung, Dienst bleibt ungestört).
//   npm run netlog            (Übersicht der letzten 24 h)
//   node netlog.js recent [n] (die letzten Roh-Ereignisse)
//   node netlog.js all        (gesamter Zeitraum statt 24 h)
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
const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
// WS-Close-Codes in Klartext (RFC 6455 + gängige Netzursachen)
const CLOSE = {
  1000: 'normal', 1001: 'going-away (Tab/Hintergrund)', 1005: 'no-status',
  1006: 'abnormal (Netz/NAT/Radio abgerissen)', 1011: 'server-error',
  1012: 'service-restart', 1013: 'server-busy/too-many', 1015: 'TLS-fail',
};

const since = mode === 'all' ? 0 : Date.now() - 24 * 3600 * 1000;
const rows = db.prepare("SELECT * FROM errors WHERE kind='net' AND at >= ? ORDER BY id DESC").all(since);
console.log(`\n${rows.length} Netz-Ereignisse ${mode === 'all' ? 'gesamt' : '(letzte 24 h)'}\n`);
if (!rows.length) { console.log('Keine Netz-Telemetrie gemeldet.\n'); process.exit(0); }

if (mode === 'recent') {
  for (const e of rows.slice(0, Math.min(500, +arg || 40))) {
    const d = parse(e.stack);
    console.log(`— ${ago(e.at)} ago  [${safe(e.message)}]  user=${e.user_id ?? '-'}`);
    console.log('  ' + safe(JSON.stringify(d)));
    console.log('  ' + safe(e.ua).slice(0, 90) + '\n');
  }
  process.exit(0);
}

// ---- WS-Close-Codes: WARUM brechen Verbindungen ab? ----
const closes = rows.filter((e) => e.message === 'ws-close').map((e) => ({ ...parse(e.stack), user: e.user_id, ua: e.ua }));
if (closes.length) {
  console.log(`WS-ABBRÜCHE (${closes.length}) — nach Close-Code:`);
  const byCode = {};
  for (const c of closes) { const k = c.code ?? '?'; (byCode[k] ??= []).push(c); }
  for (const [code, list] of Object.entries(byCode).sort((a, b) => b[1].length - a[1].length)) {
    const ingame = list.filter((c) => c.ingame).length;
    const p2p = list.filter((c) => c.path === 'p2p').length;
    const avgOpen = Math.round(list.reduce((s, c) => s + (c.openMs || 0), 0) / list.length / 1000);
    const avgPing = Math.round(list.filter((c) => c.ping > 0).reduce((s, c, _, a) => s + c.ping / a.length, 0)) || '-';
    console.log(`  ${String(code).padEnd(5)} ${String(list.length).padStart(4)}×  ${CLOSE[code] || '?'}`);
    console.log(`        im Spiel: ${ingame}/${list.length} · P2P: ${p2p} · Ø Verbindungsdauer: ${avgOpen}s · Ø Ping: ${avgPing}ms`);
  }
  console.log('');
}

// ---- Reconnect: hilft die 10-s-Wiederverbindung? ----
const recon = rows.filter((e) => e.message === 'reconnect').map((e) => parse(e.stack));
if (recon.length) {
  const ok = recon.filter((r) => r.ok);
  const avgTries = (recon.reduce((s, r) => s + (r.tries || 0), 0) / recon.length).toFixed(1);
  const avgOkMs = ok.length ? Math.round(ok.reduce((s, r) => s + (r.ms || 0), 0) / ok.length) : 0;
  console.log(`RECONNECTS (${recon.length}):`);
  console.log(`  erfolgreich: ${ok.length}/${recon.length} (${Math.round(100 * ok.length / recon.length)} %)`);
  console.log(`  Ø Versuche: ${avgTries} · Ø Zeit bis Erfolg: ${avgOkMs} ms`);
  console.log('');
}

// ---- Geräte-/Browser-Verteilung der Abbrüche (grobe UA-Klassierung) ----
const uaClass = (ua) => {
  ua = String(ua || '');
  if (/iPhone|iPad|iOS/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Firefox/i.test(ua)) return 'Firefox';
  if (/Edg/i.test(ua)) return 'Edge';
  if (/Chrome/i.test(ua)) return 'Chrome/Desktop';
  if (/Safari/i.test(ua)) return 'Safari/Desktop';
  return 'andere';
};
const byUa = {};
for (const e of rows.filter((e) => e.message === 'ws-close')) { const k = uaClass(e.ua); byUa[k] = (byUa[k] || 0) + 1; }
if (Object.keys(byUa).length) {
  console.log('ABBRÜCHE nach Gerät/Browser:');
  for (const [k, n] of Object.entries(byUa).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)} ${n}`);
  console.log('');
}

console.log('Tipp: `node netlog.js recent 40` zeigt die Rohdaten, `node netlog.js all` den gesamten Zeitraum.\n');
