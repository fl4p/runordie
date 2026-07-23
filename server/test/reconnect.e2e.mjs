// End-to-End-Tests für die Verbindungswiederherstellung (simulierte Abbrüche).
// Startet einen eigenen Relay-Server auf einem Testport mit temporärer DB, öffnet
// zwei headless-Chromium-Seiten (Host + Client), spielt online und prüft, dass ein
// Client einen Abbruch mitten im Spiel übersteht.
//
//   npm run test:e2e                 (aus dem server/-Verzeichnis)
//   CHROMIUM=/pfad/zu/chrome npm run test:e2e   (anderer Browser-Pfad)
//
// Braucht `playwright-core` (devDependency) + ein installiertes Chromium. Der
// Standardpfad passt zum Playwright-Cache dieses Rechners; per CHROMIUM=… ändern.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'server.js');
const PORT = +(process.env.PORT || 8390);
const BASE = `http://localhost:${PORT}/`;
const HARDCODED = '/home/fab/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const CHROMIUM = process.env.CHROMIUM || (existsSync(HARDCODED) ? HARDCODED : chromium.executablePath());
const ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];

// ---- winziges Test-Gerüst ----
let passed = 0, failed = 0;
const results = [];
function ok(cond, name, detail = '') {
  results.push(`${cond ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m'} ${name}${detail ? '  \x1b[2m' + detail + '\x1b[0m' : ''}`);
  cond ? passed++ : failed++;
}
const until = async (fn, what, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(120); }
  throw new Error('timeout: ' + what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE, { method: 'HEAD' }); if (r.ok || r.status === 200) return; } catch { /* noch nicht da */ }
    await sleep(150);
  }
  throw new Error('Server nicht erreichbar auf ' + BASE);
}

// Host + Client aufsetzen, einem Raum beitreten und (optional) das Spiel starten.
async function makeRoom(browser, { hostSeats = 1 } = {}) {
  const mk = async () => {
    const p = await browser.newPage();
    await p.addInitScript(() => localStorage.setItem('runordie_gpuprof_v1', 'done'));
    await p.goto(BASE, { waitUntil: 'load' });
    await p.waitForFunction(() => window.__game);
    return p;
  };
  const host = await mk(), cli = await mk();
  if (hostSeats === 2) await host.evaluate(() => { __game.netLocalSeats = 2; });
  await host.evaluate(() => __game.netCreateRoom());
  const code = await until(() => host.evaluate(() => __game.netCode), 'room code');
  await cli.evaluate((c) => __game.netJoinRoom(c), code);
  const need = hostSeats === 2 ? 3 : 2;
  await until(() => host.evaluate((n) => __game.netRoster.length === n, need), 'roster fills');
  await host.evaluate(() => __game.netStartOnline());
  await until(() => cli.evaluate(() => __game.netRole === 'client' && __game.state === 'playing'), 'client playing');
  return { host, cli, code };
}

// Einen Abbruch auslösen und auf die Erholung warten (zurück im selben Raum, spielend).
async function dropAndRecover(cli, label, ms = 13000) {
  await cli.evaluate(() => __game.netDropWs());
  await until(() => cli.evaluate(() => __game.netReconnecting ? 1 : null), label + ' enters reconnect', 3000);
  return until(async () => {
    const s = await cli.evaluate(() => ({ rc: __game.netReconnecting, st: __game.state, slot: __game.netMySlot, code: __game.netCode }));
    return (!s.rc && s.st === 'playing' && s.code) ? s : null;
  }, label + ' recovers', ms);
}

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), 'runordie-e2e-'));
  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(dbDir, 'test.db') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let browser;
  try {
    await waitServer();
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ARGS });

    // 1) Abbruch mitten im 1v1-Spiel -> Wiedereintritt in denselben Raum, gleicher Slot
    {
      const { host, cli, code } = await makeRoom(browser);
      const slot0 = await cli.evaluate(() => __game.netMySlot);
      const r = await dropAndRecover(cli, 'single-drop');
      ok(r.code === code, '1v1 mid-game drop rejoins the SAME room', `${r.code}==${code}`);
      ok(r.slot === slot0, '   …and keeps the same slot', `slot ${r.slot}`);
      const hostOk = await host.evaluate(() => __game.netRole === 'host' && __game.netRoster.length === 2);
      ok(hostOk, '   …host held the room open (roster back to 2)');
      await host.close(); await cli.close();
    }

    // 2) ZWEI aufeinanderfolgende Abbrüche -> beide erholen sich (Regression: der
    //    erneuerte onclose-Handler; früher hing der zweite Abbruch 15 s)
    {
      const { host, cli } = await makeRoom(browser);
      const slot0 = await cli.evaluate(() => __game.netMySlot);
      const r1 = await dropAndRecover(cli, 'drop-1');
      await sleep(1200);
      const r2 = await dropAndRecover(cli, 'drop-2');
      ok(r1.st === 'playing' && r2.st === 'playing', 'two consecutive drops BOTH recover');
      ok(r1.slot === slot0 && r2.slot === slot0, '   …slot stays stable across both', `slot ${r2.slot}`);
      await host.close(); await cli.close();
    }

    // 3) Server komplett weg -> nach ~10 s aufgeben und sauber ins Menü fallen
    {
      const { host, cli } = await makeRoom(browser);
      srv.kill('SIGKILL'); // Backend hart beenden -> kein Reconnect möglich
      const t0 = Date.now();
      await cli.evaluate(() => __game.netDropWs());
      const gaveUp = await until(async () => {
        const s = await cli.evaluate(() => ({ rc: __game.netReconnecting, st: __game.state, role: __game.netRole }));
        return (!s.rc && s.st === 'menu' && !s.role) ? s : null;
      }, 'client gives up to menu', 16000);
      const secs = (Date.now() - t0) / 1000;
      ok(gaveUp.st === 'menu' && !gaveUp.role, 'dead server -> gives up to the menu');
      ok(secs >= 9 && secs <= 14, `   …after ~10 s (was ${secs.toFixed(1)} s)`);
      await host.close(); await cli.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill('SIGKILL');
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* egal */ }
  }

  console.log('\nReconnect E2E\n' + results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\n\x1b[31mE2E-Lauf abgebrochen:\x1b[0m', e.message); process.exit(1); });
