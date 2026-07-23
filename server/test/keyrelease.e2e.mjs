// E2E: Fokusverlust löst gehaltene Bewegungstaster. Ohne diesen Fix bleibt bei
// Alt-Tab / App-Wechsel ein Taster "gedrückt" und die Figur läuft endlos in eine
// Richtung (Bug-Report #8 "manchmal geht man nur nach hinten").
//
//   npm run test:keyrelease         (aus dem server/-Verzeichnis)
//   CHROMIUM=/pfad/zu/chrome npm run test:keyrelease
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'server.js');
const PORT = +(process.env.PORT || 8403);
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
  const dbDir = mkdtempSync(join(tmpdir(), 'runordie-key-'));
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

    // Solo starten (Digit1), dann die "Rückwärts"-Taste (S) halten
    await p.keyboard.press('Digit1');
    await p.waitForFunction(() => __game.state === 'playing');
    await p.keyboard.down('KeyS'); // S = rückwärts für Spieler 1
    await sleep(120);
    const heldBefore = await p.evaluate(() => __game.players[0].keys.b === true);
    ok(heldBefore, 'Taste gehalten: keys.b ist true');

    // Fokusverlust simulieren (Alt-Tab): window 'blur'
    await p.evaluate(() => dispatchEvent(new Event('blur')));
    await sleep(80);
    ok(await p.evaluate(() => __game.players[0].keys.b === false), 'blur löst die gehaltene Taste (keys.b false)');

    // Erneut halten, dann Tab-Wechsel (visibilitychange -> hidden)
    await p.keyboard.down('KeyS');
    await sleep(80);
    ok(await p.evaluate(() => __game.players[0].keys.b === true), 'erneut gehalten');
    await p.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(80);
    ok(await p.evaluate(() => __game.players[0].keys.b === false), 'visibilitychange(hidden) löst die Taste');

    await p.keyboard.up('KeyS');
    ok(errs.length === 0, 'keine pageerrors', errs.join(' | '));
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill('SIGKILL');
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* egal */ }
  }
  console.log(`\n  ${passed} bestanden, ${failed} fehlgeschlagen\n`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('keyrelease E2E abgebrochen:', e); process.exit(2); });
