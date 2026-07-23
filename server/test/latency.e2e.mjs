// End-to-End-Test der Synchronisation unter künstlicher Latenz. Startet das Relay
// mit LAG=100 (100 ms Einweg-Verzögerung je Relay-Hop) und zwingt beide Seiten per
// ?nop2p=1 auf den Relay-Pfad (WebRTC ginge sonst direkt an der Latenz vorbei).
// Prüft, dass eine Online-Runde unter ~200 ms RTT gesund und spielbar bleibt:
// gemessener Ping ~200 ms, stetiger Snapshot-Fluss, keine Invarianten-Verletzung.
//
//   npm run test:latency         (aus dem server/-Verzeichnis)
//   CHROMIUM=/pfad/zu/chrome npm run test:latency
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'server.js');
const PORT = +(process.env.PORT || 8395);
const LAG = +(process.env.LAG || 100);
const BASE = `http://localhost:${PORT}/`;
const HARDCODED = '/home/fab/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const CHROMIUM = process.env.CHROMIUM || (existsSync(HARDCODED) ? HARDCODED : chromium.executablePath());
const ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];

let passed = 0, failed = 0;
const results = [];
const ok = (cond, name, detail = '') => {
  results.push(`${cond ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m'} ${name}${detail ? '  \x1b[2m' + detail + '\x1b[0m' : ''}`);
  cond ? passed++ : failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const until = async (fn, what, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); }
  throw new Error('timeout: ' + what);
};

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE, { method: 'HEAD' }); if (r.ok || r.status === 200) return; } catch { /* noch nicht */ }
    await sleep(150);
  }
  throw new Error('Server nicht erreichbar: ' + BASE);
}

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), 'runordie-lat-'));
  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), LAG: String(LAG), DB_PATH: join(dbDir, 'test.db') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let browser;
  try {
    await waitServer();
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ARGS });
    const mk = async () => {
      const p = await browser.newPage();
      await p.addInitScript(() => localStorage.setItem('runordie_gpuprof_v1', 'done'));
      await p.goto(BASE + '?nop2p=1', { waitUntil: 'load' }); // Relay erzwingen -> LAG greift
      await p.waitForFunction(() => window.__game);
      return p;
    };
    const host = await mk(), cli = await mk();
    await host.evaluate(() => __game.netCreateRoom());
    const code = await until(() => host.evaluate(() => __game.netCode), 'room code');
    await cli.evaluate((c) => __game.netJoinRoom(c), code);
    await until(() => host.evaluate(() => __game.netRoster.length === 2), 'roster fills');
    await host.evaluate(() => __game.netStartOnline());
    await until(() => cli.evaluate(() => __game.netRole === 'client' && __game.state === 'playing'), 'client playing');

    // Relay-only bestätigen (sonst misst der Test die falsche Latenz)
    const path = await cli.evaluate(() => __game.netStat().path);
    ok(path === 'relay', 'client is on the relay path (P2P disabled)', `path=${path}`);

    // ~5 s lang Ping / Snapshot-Alter / Zustand / Invarianten abtasten
    const pings = [], snapAges = []; let everStalled = false, everNotPlaying = false, invViol = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      const s = await cli.evaluate(() => ({
        st: __game.netStat(), state: __game.state,
        inv: (__game.invariants || []).length, role: __game.netRole,
      }));
      if (s.st.ping > 0) pings.push(s.st.ping);
      if (s.st.snapAge >= 0) snapAges.push(s.st.snapAge);
      if (s.state !== 'playing') everNotPlaying = true;
      if (s.st.snapAge > 600) everStalled = true;
      invViol = Math.max(invViol, s.inv);
    }
    const medPing = median(pings), medAge = median(snapAges), maxAge = Math.max(0, ...snapAges);
    const expected = 2 * LAG;
    // Ping muss die künstliche Latenz klar widerspiegeln (> LAG) und beschränkt
    // bleiben. Kein enges Fenster: headless-SwiftShader (~8 fps) bläht die Messung
    // um ~2 Frames auf; auf echter Hardware (60 fps) liegt sie nahe 2xLAG.
    ok(medPing > LAG && medPing < 1500, `ping reflects the injected latency (~2xLAG=${expected}ms)`, `median ${medPing}ms`);
    ok(pings.length >= 10, 'ping was measured continuously', `${pings.length}/20 samples`);
    ok(!everStalled, 'snapshots kept flowing (age never spiked > 600ms)', `median ${medAge}ms, max ${maxAge}ms`);
    ok(!everNotPlaying, 'game stayed in play the whole time');
    ok(invViol === 0, 'no invariant violations under latency', `max ${invViol}`);

    // Ein Abbruch soll auch unter Latenz sauber neu verbinden
    await cli.evaluate(() => __game.netDropWs());
    const recovered = await until(async () => {
      const r = await cli.evaluate(() => ({ rc: __game.netReconnecting, st: __game.state, code: __game.netCode }));
      return (!r.rc && r.st === 'playing' && r.code) ? r : null;
    }, 'reconnect under latency', 14000).catch(() => null);
    ok(recovered && recovered.code === code, 'reconnect recovers under latency too');
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill('SIGKILL');
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* egal */ }
  }

  console.log(`\nLatency E2E (LAG=${LAG}ms one-way, relay-only)\n` + results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\n\x1b[31mE2E-Lauf abgebrochen:\x1b[0m', e.message); process.exit(1); });
