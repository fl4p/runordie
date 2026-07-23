// Feature-Smoke-Suite für index.html (Frontend). Lädt das Spiel headless und
// prüft pro Feature eine schnelle Verhaltens-Assertion — fängt Regressionen an
// Menü-Struktur und Kern-Features, die der Bot-Soak (Physik/Leaks) nicht sieht.
// Besonders gegen die parallele Arbeit: verschwindet ein Feature aus index.html,
// schlägt hier ein Test fehl statt es erst im Live-Spiel zu bemerken.
//
//   npm run test:smoke                          (aus dem server/-Verzeichnis)
//   CHROMIUM=/pfad/zu/chrome npm run test:smoke
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'server.js');
const PORT = +(process.env.PORT || 8397);
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

// Frische Seite im Menü-Zustand; optional Touch/localStorage vorbelegen
async function freshPage(browser, { touch = false, mobile = false } = {}) {
  // deviceScaleFactor 2: sonst ist window.devicePixelRatio 1 und der Akku-Modus-
  // pixelRatio (min(dpr, 1.5) vs min(dpr, 2)) wäre nicht unterscheidbar
  const ctx = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('  \x1b[31mPAGEERROR\x1b[0m ' + String(e.message).slice(0, 140)); failed++; });
  await page.addInitScript((t) => {
    localStorage.setItem('runordie_gpuprof_v1', 'done'); // Auto-Benchmark aus
    if (t) localStorage.setItem('runordie_touch', '1');
  }, touch);
  await page.goto(BASE + 'index.html?check=1', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && __game.state === 'menu', null, { timeout: 20000 });
  return page;
}

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), 'runordie-smoke-'));
  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(dbDir, 'test.db') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let browser;
  try {
    await waitServer();
    browser = await chromium.launch({ executablePath: CHROMIUM, args: ARGS });

    // ---- 1. Menü lädt, alle interaktiven IDs vorhanden (Klick-Delegation/Redesign) ----
    let page = await freshPage(browser);
    const IDS = ['startsolo', 'startbot', 'startduo', 'startonline', 'divebtn', 'stunbtn',
      'punchbtn', 'rushbtn', 'snowbtn', 'laserkillbtn', 'botdiffbtn', 'fpscapbtn', 'gpuprofbtn',
      'sensrange', 'sensval', 'rotcambtn', 'padmapjump', 'padmappunch', 'padmaptackle', 'padmapghost', 'padmapreset'];
    const idsPresent = await page.evaluate((ids) => {
      for (const d of document.querySelectorAll('#msg details')) d.open = true;
      return ids.filter((i) => !document.getElementById(i));
    }, IDS);
    ok(idsPresent.length === 0, 'Alle Menü-IDs vorhanden', idsPresent.length ? 'fehlen: ' + idsPresent.join(',') : '');

    // Version im Menü + Sensitivity bis 4x
    const menuMeta = await page.evaluate(() => ({
      ver: (document.querySelector('.mver')?.textContent || '').includes('v'),
      sensMax: document.getElementById('sensrange')?.max,
    }));
    ok(menuMeta.ver, 'Spielversion im Menü sichtbar');
    ok(menuMeta.sensMax === '4', 'Stick-Empfindlichkeit bis 4x', 'max=' + menuMeta.sensMax);

    // ---- 2. Akku-Modus zyklt 3-stufig + pixelRatio ----
    const power = await page.evaluate(() => {
      const read = () => ({ t: document.getElementById('fpscapbtn').textContent, pr: __game.renderer.getPixelRatio() });
      const seq = [read()];
      for (let i = 0; i < 3; i++) { document.getElementById('fpscapbtn').click(); seq.push(read()); }
      return seq;
    });
    ok(power.some((s) => s.t.includes('30')) && power.some((s) => s.t.includes('AUS')) && power.some((s) => s.t.includes('60')),
      'Akku-Modus: 3 Stufen (60/30/aus)');
    ok(power.some((s) => Math.abs(s.pr - 1.5) < 0.01) && power.some((s) => Math.abs(s.pr - 2) < 0.01),
      'Akku-Modus: pixelRatio 1.5 (eco) und 2 (aus)');

    // ---- 3. Menü-Restore nach ESC (MENU_HTML) hält die IDs ----
    const restore = await page.evaluate(async () => {
      __game.startGame(true); await new Promise((r) => setTimeout(r, 200));
      __game.backToMenu(); await new Promise((r) => setTimeout(r, 200));
      return { menu: __game.state === 'menu', ids: ['startsolo', 'divebtn', 'sensrange', 'rotcambtn'].every((i) => document.getElementById(i)) };
    });
    ok(restore.menu && restore.ids, 'ESC-Restore: Menü + IDs wiederhergestellt');
    await page.context().close();

    // ---- 4. Tag/Nacht-Zyklus + Laternen ----
    page = await freshPage(browser);
    const daynight = await page.evaluate(() => {
      __game.startGame(true);
      const before = __game.dayMode;
      __game.toggleDaySky();
      return { toggled: __game.dayMode !== before, hasToggle: typeof __game.toggleDaySky === 'function' };
    });
    ok(daynight.hasToggle && daynight.toggled, 'Tag/Nacht umschaltbar');
    await page.context().close();

    // ---- 5. Power-ups: Sprenghecht (breach) und Schattenkristall (ghost) wirken ----
    page = await freshPage(browser);
    const powerups = await page.evaluate(async () => {
      __game.startGame(true); await new Promise((r) => setTimeout(r, 100));
      const g = __game, p = g.players[0];
      // Schattenkristall: Ladung + Zünden -> unsichtbar (Material transparent, Augen versteckt)
      p.ghostCharges = 1;
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      const ghost = {
        smoky: p.parts.every((pt) => pt.mesh.material.transparent && pt.mesh.material.opacity < 0.3),
        eyesHidden: (p.eyes || []).length === 2 && p.eyes.every((e) => !e.visible),
        noShadow: p.parts.every((pt) => !pt.mesh.castShadow),
      };
      return { ghost };
    });
    ok(powerups.ghost.smoky && powerups.ghost.eyesHidden && powerups.ghost.noShadow,
      'Schattenkristall: unsichtbar (Rauch, Augen aus, kein Schatten)', JSON.stringify(powerups.ghost));
    await page.context().close();

    // ---- 6. Laser treffen auch im "nur Schieben"-Modus (noStun) ----
    page = await freshPage(browser);
    await page.evaluate(() => localStorage.setItem('runordie_noStun', '1'));
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__game && __game.state === 'menu');
    const laser = await page.evaluate(async () => {
      __game.startGame(true); await new Promise((r) => setTimeout(r, 100));
      const g = __game, pl = g.players[0];
      const noStun = document.getElementById('stunbtn').textContent.includes('AUS');
      g.spawnLaser('line');
      const L = g.lasers[g.lasers.length - 1];
      let hit = false;
      for (let i = 0; i < 60; i++) { L.z = pl.torso.position.z; L.y0 = pl.torso.position.y; L.amp = 0; await new Promise((r) => setTimeout(r, 16)); if (pl.ragdoll) { hit = true; break; } }
      return { noStun, hit };
    });
    ok(laser.noStun && laser.hit, 'Laser treffen im noStun-Modus');
    await page.context().close();

    // ---- 7. Touch: freie Kamera lässt Seitwärtsbewegung intakt (Report #3) ----
    page = await freshPage(browser, { touch: true, mobile: true });
    await page.evaluate(() => localStorage.setItem('runordie_rotMode', '1'));
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__game && __game.state === 'menu');
    const touchMove = await page.evaluate(async () => {
      __game.startGame(true); await new Promise((r) => setTimeout(r, 100));
      const g = __game, pl = g.players[0];
      pl.yaw = Math.PI / 2; const x0 = pl.torso.position.x, z0 = pl.torso.position.z;
      for (let i = 0; i < 35; i++) { pl.keys.r = true; pl.yaw = Math.PI / 2; await new Promise((r) => setTimeout(r, 16)); }
      return { rot: g.rotMode, dx: pl.torso.position.x - x0, dz: pl.torso.position.z - z0 };
    });
    ok(touchMove.rot && Math.abs(touchMove.dx) > Math.abs(touchMove.dz) && Math.abs(touchMove.dx) > 1,
      'Touch + freie Kamera: seitwärts bleibt bildschirmfest', `dx=${touchMove.dx.toFixed(1)} dz=${touchMove.dz.toFixed(1)}`);
    await page.context().close();

    // ---- 8. Festgeklemmt -> Sprungtaste zieht hoch (Report #4) ----
    page = await freshPage(browser);
    const unstuck = await page.evaluate(() => new Promise((resolve) => {
      __game.startGame(true);
      const pl = __game.players[0]; pl.stuckT = 0;
      let n = 0, jumped = false, yAtJump = 0, stuckAtJump = 0;
      (function hold() {
        for (const { body } of pl.parts) { if (body.position.y < 2.4) body.position.y = 2.5; body.velocity.x = 0; body.velocity.z = 0; if (body.velocity.y < -1) body.velocity.y = 0; }
        if (pl.stuckT > 0.35 && !jumped) {
          jumped = true; yAtJump = pl.torso.position.y; stuckAtJump = pl.stuckT; // Sprung setzt stuckT gleich auf 0 zurück
          document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
          setTimeout(() => resolve({ stuckAtJump, vy: __game.players[0].torso.velocity.y, lifted: pl.torso.position.y >= yAtJump - 0.05 }), 40);
          return;
        }
        if (++n > 200) { resolve({ stuckAtJump: 0, vy: 0, lifted: false }); return; }
        requestAnimationFrame(hold);
      })();
    }));
    // stuck erkannt (>0.35) und der Sprung gab den sanften Hochzieh-Impuls (vy ~6,
    // NICHT der normale Sprung 9.5) und hob die Figur
    ok(unstuck.stuckAtJump > 0.35 && unstuck.vy >= 4 && unstuck.vy <= 7.5 && unstuck.lifted,
      'Festgeklemmt: Sprungtaste zieht hoch', `stuckT=${unstuck.stuckAtJump?.toFixed?.(2)} vy=${unstuck.vy?.toFixed?.(1)}`);
    await page.context().close();

  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill('SIGKILL');
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* egal */ }
  }

  console.log(`\n  ${passed} bestanden, ${failed} fehlgeschlagen\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('Smoke-Suite abgebrochen:', e); process.exit(2); });
