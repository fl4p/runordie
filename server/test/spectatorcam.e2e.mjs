// E2E: Zuschauer-Kamera. Stirbt der verfolgte Spieler, folgt die Kamera nach 2 s
// einem noch lebenden Mitspieler (camTarget). Vorher bleibt sie beim eigenen;
// ist niemand sonst am Leben, bleibt sie ebenfalls beim eigenen.
//
//   npm run test:spectatorcam         (aus dem server/-Verzeichnis)
//   CHROMIUM=/pfad/zu/chrome npm run test:spectatorcam
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'server.js');
const PORT = +(process.env.PORT || 8401);
const BASE = `http://localhost:${PORT}/`;
const HARDCODED = '/home/fab/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const CHROMIUM = process.env.CHROMIUM || (existsSync(HARDCODED) ? HARDCODED : chromium.executablePath());
const ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];

let passed = 0, failed = 0;
const ok = (cond, name, detail = '') => {
  console.log(`${cond ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m'} ${name}${detail ? '  \x1b[2m' + detail + '\x1b[0m' : ''}`);
  cond ? passed++ : failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE, { method: 'HEAD' }); if (r.ok || r.status === 200) return; } catch { /* noch nicht */ }
    await sleep(150);
  }
  throw new Error('Server nicht erreichbar: ' + BASE);
}

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), 'runordie-spec-'));
  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(dbDir, 'test.db') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let browser;
  try {
    await waitServer();
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ARGS });
    const p = await browser.newPage(); const errs = [];
    p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 140)));
    await p.addInitScript(() => localStorage.setItem('runordie_gpuprof_v1', 'done'));
    await p.goto(BASE, { waitUntil: 'load' });
    await p.waitForFunction(() => window.__game);
    await p.evaluate(() => { __game.renderer.render = () => {}; });

    ok(await p.evaluate(() => typeof __game.camTarget === 'function'), 'camTarget-Hook vorhanden');

    // Lebender Spieler -> Ziel bleibt er selbst
    const r = await p.evaluate(() => {
      const [a, b] = __game.players;
      a.alive = true; a.parked = false; a.deadT = 0;
      b.alive = true; b.parked = false; b.deadT = 0;
      const selfWhenAlive = __game.camTarget(a) === a;
      // gerade gestorben (< 2 s): noch beim eigenen
      a.alive = false; a.deadT = 1.0;
      const selfWhenFreshDead = __game.camTarget(a) === a;
      // > 2 s tot, b lebt -> wechselt zu b
      a.deadT = 2.5;
      const switchesToLive = __game.camTarget(a) === b;
      // b ebenfalls tot -> bleibt beim eigenen (kein Ziel)
      b.alive = false;
      const staysWhenNoneLive = __game.camTarget(a) === a;
      // b geparkt (ausgeschieden/inaktiv) zählt nicht als Ziel
      b.alive = true; b.parked = true;
      const skipsParked = __game.camTarget(a) === a;
      return { selfWhenAlive, selfWhenFreshDead, switchesToLive, staysWhenNoneLive, skipsParked };
    });
    ok(r.selfWhenAlive, 'lebend: Kamera bleibt beim eigenen Spieler');
    ok(r.selfWhenFreshDead, 'frisch tot (<2 s): noch beim eigenen Spieler');
    ok(r.switchesToLive, 'nach 2 s tot: Kamera wechselt zu lebendem Mitspieler');
    ok(r.staysWhenNoneLive, 'niemand sonst lebt: bleibt beim eigenen Spieler');
    ok(r.skipsParked, 'geparkte Spieler sind kein Zuschauer-Ziel');

    ok(errs.length === 0, 'keine pageerrors', errs.join(' | '));
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill('SIGKILL');
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* egal */ }
  }
  console.log(`\n  ${passed} bestanden, ${failed} fehlgeschlagen\n`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('spectatorcam E2E abgebrochen:', e); process.exit(2); });
