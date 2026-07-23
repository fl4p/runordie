// E2E: die freie Kamera (Dreh-Modus) als Online-Raumregel. Prüft, dass der Host
// sie in der LOBBY und WÄHREND DES SPIELS umstellen kann und der Client jeweils
// folgt, und dass der Client beim Verlassen auf seinen persönlichen Modus
// zurückgesetzt wird.
//
//   npm run test:camrule         (aus dem server/-Verzeichnis)
//   CHROMIUM=/pfad/zu/chrome npm run test:camrule
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'server.js');
const PORT = +(process.env.PORT || 8399);
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
  const dbDir = mkdtempSync(join(tmpdir(), 'runordie-cam-'));
  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(dbDir, 'test.db') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let browser;
  try {
    await waitServer();
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ARGS });
    const mk = async () => {
      const p = await browser.newPage(); p.errs = [];
      p.on('pageerror', (e) => p.errs.push(String(e.message).slice(0, 140)));
      await p.addInitScript(() => localStorage.setItem('runordie_gpuprof_v1', 'done'));
      await p.goto(BASE, { waitUntil: 'load' });
      await p.waitForFunction(() => window.__game);
      await p.evaluate(() => { __game.renderer.render = () => {}; }); // 60 fps statt SwiftShader-8fps
      return p;
    };
    const host = await mk(), cli = await mk();
    await host.evaluate(() => __game.netCreateRoom());
    const code = await until(() => host.evaluate(() => __game.netCode), 'room code');
    await cli.evaluate((c) => __game.netJoinRoom(c), code);
    await until(() => host.evaluate(() => __game.netRoster.length === 2), 'roster fills');

    ok(await host.evaluate(() => __game.rotMode === false), 'Kamera startet FEST (rotMode false)');

    // 1) In der LOBBY umschalten -> Client sieht die Regel
    await host.evaluate(() => __game.netToggleLobbySetting('cam'));
    const lobbySeen = await until(() => cli.evaluate(() => __game.netLobbySettings && __game.netLobbySettings.cam === true), 'client sees cam in lobby');
    ok(!!lobbySeen, 'Lobby: Host stellt DREHBAR, Client sieht es');

    // 2) Start -> beide übernehmen die Kamera-Regel
    await host.evaluate(() => __game.netStartOnline());
    await until(() => cli.evaluate(() => __game.netRole === 'client' && __game.state === 'playing'), 'client playing');
    await sleep(400);
    ok(await host.evaluate(() => __game.rotMode === true) && await cli.evaluate(() => __game.rotMode === true),
      'Nach Start: beide DREHBAR');

    // 3) Während des Spiels wieder auf FEST -> Client folgt live
    await host.evaluate(() => __game.netToggleLobbySetting('cam'));
    await until(() => cli.evaluate(() => __game.rotMode === false), 'client follows cam off in-game');
    ok(await host.evaluate(() => __game.rotMode === false), 'Im Spiel: Host stellt FEST, Client folgt live');

    // 4) Verlassen -> Client zurück auf persönlichen Modus (war FEST)
    await cli.evaluate(() => __game.backToMenu());
    await sleep(400);
    ok(await cli.evaluate(() => __game.rotMode === false), 'Client nach Verlassen: persönlicher Modus (FEST) restauriert');

    // 5) Die Host-Regel darf die persönliche localStorage-Präferenz des Clients
    //    NICHT überschreiben (sonst bleibt sie bei unsauberem Exit korrumpiert)
    const clientLS = await cli.evaluate(() => localStorage.getItem('runordie_rotMode'));
    ok(clientLS !== '1', 'Client-localStorage nicht auf Host-Wert korrumpiert', `runordie_rotMode=${clientLS}`);

    ok(host.errs.length === 0 && cli.errs.length === 0, 'keine pageerrors', [...host.errs, ...cli.errs].join(' | '));
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill('SIGKILL');
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* egal */ }
  }
  console.log(`\n  ${passed} bestanden, ${failed} fehlgeschlagen\n`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('camrule E2E abgebrochen:', e); process.exit(2); });
