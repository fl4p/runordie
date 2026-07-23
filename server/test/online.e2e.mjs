// End-to-End-Tests des Online-Bereichs: Konten, Präsenz, öffentliche Räume,
// Lobby-Regeln, Sitzplatz-Modell, Rauswurf und Spawn-Replay-Ausrichtung. Startet
// EINEN Relay-Server + temporäre DB und fährt die Szenarien über headless-Chromium.
//   npm run test:online   (aus server/)   ·   CHROMIUM=… überschreibt den Browser
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'server.js');
const PORT = +(process.env.PORT || 8420);
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
const until = async (fn, what, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(120); }
  throw new Error('timeout: ' + what);
};
const rnd = () => Math.floor(Math.random() * 1e6);

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE, { method: 'HEAD' }); if (r.ok || r.status === 200) return; } catch { /* noch nicht */ }
    await sleep(150);
  }
  throw new Error('Server nicht erreichbar: ' + BASE);
}

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), 'runordie-online-'));
  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(dbDir, 'test.db'), REG_MAX: '0' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let browser;
  const mk = async (query = '') => {
    const p = await browser.newPage();
    await p.addInitScript(() => localStorage.setItem('runordie_gpuprof_v1', 'done'));
    await p.goto(BASE + query, { waitUntil: 'load' });
    await p.waitForFunction(() => window.__game);
    return p;
  };
  try {
    await waitServer();
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ARGS });

    // ---- 1) Konten: Registrieren/Login, falsches Passwort, Doppelname ----
    {
      const p = await mk();
      const A = 'Acc' + rnd();
      const reg = await p.evaluate(async (u) => { try { await __game.authLogin(u, 'secret1', true); return __game.authUser?.username; } catch (e) { return 'ERR:' + e.message; } }, A);
      ok(reg === A, 'register + login sets the account', reg);
      await p.evaluate(() => __game.authLogout());
      const wrong = await p.evaluate(async (u) => { try { await __game.authLogin(u, 'WRONGpw', false); return 'ALLOWED'; } catch (e) { return 'REJECTED'; } }, A);
      ok(wrong === 'REJECTED', 'wrong password is rejected');
      const dup = await p.evaluate(async (u) => { try { await __game.authApi('POST', '/register', { username: u, password: 'secret1' }); return 'ALLOWED'; } catch (e) { return 'REJECTED'; } }, A);
      ok(dup === 'REJECTED', 'duplicate username is rejected');
      await p.close();
    }

    // ---- 2) Login-Race: langsame /me einer ALTEN Sitzung darf neuen Login nicht überschreiben ----
    {
      const setup = await mk();
      const oldU = 'Old' + rnd(), newU = 'New' + rnd();
      const oldTok = await setup.evaluate(async (u) => (await __game.authApi('POST', '/register', { username: u, password: 'secret1' })).token, oldU);
      await setup.evaluate(async (u) => { await __game.authApi('POST', '/register', { username: u, password: 'secret1' }); }, newU);
      await setup.close();
      const p = await browser.newPage();
      await p.addInitScript((t) => { localStorage.setItem('runordie_gpuprof_v1', 'done'); localStorage.setItem('runordie_token', t); }, oldTok);
      await p.route('**/api/me', async (r) => { await sleep(1500); r.continue(); }); // /me der Alt-Sitzung verzögern
      await p.goto(BASE, { waitUntil: 'load' });
      await p.waitForFunction(() => window.__game);
      const who = await p.evaluate(async (u) => {
        const restore = __game.authRestore();     // /me mit ALTEM Token (langsam)
        await __game.authLogin(u, 'secret1', false); // Login als NEU
        await restore;                              // Alt-/me trifft ein -> darf NICHT überschreiben
        return __game.authUser?.username;
      }, newU);
      ok(who === newU, 'login-race: stale /me does not clobber the new login', `is ${who}`);
      await p.close();
    }

    // ---- 3) Zweiter Splitscreen-Spieler: eigenes Konto -> eigener Name in der Lobby ----
    {
      const host = await mk(), cli = await mk();
      const A = 'P1x' + rnd(), B = 'P2x' + rnd(), C = 'Cx' + rnd();
      await host.evaluate(async (u) => { await __game.authLogin(u, 'secret1', true); }, A);
      await host.evaluate(async (u) => { await __game.authLogin2(u, 'secret1', true); }, B);
      const same = await host.evaluate(async (u) => { try { await __game.authLogin2(u, 'secret1', false); return 'ALLOWED'; } catch (e) { return 'REJECTED'; } }, A);
      ok(same === 'REJECTED', 'player 2 cannot be the same account as player 1');
      await host.evaluate(() => { __game.netLocalSeats = 2; });
      await cli.evaluate(async (u) => { await __game.authLogin(u, 'secret1', true); }, C);
      await host.evaluate(() => __game.netCreateRoom());
      const code = await until(() => host.evaluate(() => __game.netCode), 'room code');
      await cli.evaluate((c) => __game.netJoinRoom(c), code);
      await until(() => host.evaluate(() => __game.netRoster.length === 3), 'roster fills (2 seats + client)');
      const names = await cli.evaluate(() => __game.netNames);
      ok(names[0] === A && names[1] === B && names[2] === C, 'both host accounts + client are named for everyone', JSON.stringify(names));
      await host.close(); await cli.close();
    }

    // ---- 4) Präsenz aus dem Hauptmenü (kein Klick auf ONLINE nötig) ----
    {
      const A = 'Pr' + rnd(), B = 'Ob' + rnd();
      const pa = await mk(), pb = await mk();
      await pa.evaluate(async (u) => { await __game.authLogin(u, 'secret1', true); }, A);
      await pa.evaluate(() => __game.startGame(true)); // offline solo, NIE online geklickt
      await pb.evaluate(async (u) => { await __game.authLogin(u, 'secret1', true); }, B);
      await pb.evaluate(() => __game.netShowOnlineMenu());
      const seen = await until(async () => { const l = await pb.evaluate(() => __game.netOnline.map((x) => x.name)); return l.includes(A) ? l : null; }, 'B sees A online', 8000).catch(() => null);
      ok(!!seen, 'a logged-in player at the menu shows online to others');
      await pa.close(); await pb.close();
    }

    // ---- 5) Öffentliche Räume: privat nicht gelistet, öffentlich live, gestartet raus ----
    {
      const host = await mk(), br = await mk();
      await host.evaluate(() => __game.netCreateRoom());
      const code = await until(() => host.evaluate(() => __game.netCode), 'room code');
      await br.evaluate(() => __game.netShowPublicRooms());
      await sleep(500);
      const before = await br.evaluate(() => __game.netPublicRooms.map((r) => r.code));
      ok(!before.includes(code), 'a private room is NOT in the public list');
      await host.evaluate(() => __game.netSetPublic(true));
      const listed = await until(async () => { const l = await br.evaluate(() => __game.netPublicRooms.map((r) => r.code)); return l.includes(code) ? l : null; }, 'room appears public', 6000);
      ok(!!listed, 'going public lists the room live for a browsing player');
      await br.evaluate((c) => __game.netJoinRoom(c), code);
      await until(() => host.evaluate(() => __game.netRoster.length === 2), 'browser joins from the list');
      await host.evaluate(() => __game.netStartOnline());
      const h2 = await mk();
      await h2.evaluate(() => __game.netShowPublicRooms());
      await sleep(700);
      const afterLock = await h2.evaluate(() => __game.netPublicRooms.map((r) => r.code));
      ok(!afterLock.includes(code), 'a started (locked) room drops out of the public list');
      await host.close(); await br.close(); await h2.close();
    }

    // ---- 6) Lobby-Regeln: Host stellt ein, Clients sehen live; Nachzügler sieht Stand ----
    {
      const host = await mk(), c1 = await mk();
      await host.evaluate(() => __game.netCreateRoom());
      const code = await until(() => host.evaluate(() => __game.netCode), 'room code');
      await c1.evaluate((c) => __game.netJoinRoom(c), code);
      await until(() => host.evaluate(() => __game.netRoster.length === 2), 'roster');
      const seen0 = await until(() => c1.evaluate(() => __game.netLobbySettings), 'c1 gets settings on join', 5000);
      const before = seen0.stun;
      await host.evaluate(() => __game.netToggleLobbySetting('stun'));
      const seen1 = await until(async () => { const s = await c1.evaluate(() => __game.netLobbySettings); return s && s.stun !== before ? s : null; }, 'c1 sees the live toggle', 5000);
      ok(seen1.stun !== before, 'clients see the host toggle a rule live');
      const c2 = await mk();
      await c2.evaluate((c) => __game.netJoinRoom(c), code);
      const seen2 = await until(() => c2.evaluate(() => __game.netLobbySettings), 'c2 gets settings', 5000);
      ok(JSON.stringify(seen2) === JSON.stringify(await host.evaluate(() => __game.netLobbySettingsObj)), 'a late joiner sees the current (toggled) rules');
      await host.close(); await c1.close(); await c2.close();
    }

    // ---- 7) Sitzplatz-Modell: 2-Sitz-Client belegt 2 Slots; 5. Spieler abgelehnt ----
    {
      const host = await mk(), cli = await mk(), full = await mk();
      await host.evaluate(() => __game.netCreateRoom());
      const code = await until(() => host.evaluate(() => __game.netCode), 'room code');
      await cli.evaluate(() => { __game.netLocalSeats = 2; });
      await cli.evaluate((c) => __game.netJoinRoom(c), code);
      await until(() => host.evaluate(() => __game.netRoster.length === 3), 'a 2-seat client takes two slots');
      const seats = await cli.evaluate(() => __game.netMySeats);
      ok(seats.length === 2, 'client owns two seats', JSON.stringify(seats));
      // Raum ist mit 3 belegt; ein weiterer 2-Sitz-Client passt nicht (nur 1 frei)
      await full.evaluate(() => { __game.netLocalSeats = 2; });
      await full.evaluate((c) => __game.netJoinRoom(c), code);
      const rej = await until(async () => {
        const m = await full.evaluate(() => (document.getElementById('msg')?.textContent || ''));
        return /Platz|voll/i.test(m) ? m : null;
      }, 'over-capacity join rejected', 6000).catch(() => null);
      ok(!!rej, 'joining beyond capacity is rejected');
      await host.close(); await cli.close(); await full.close();
    }

    // ---- 8) Rauswurf: Host wirft einen Mitspieler vor dem Start ----
    {
      const host = await mk(), cli = await mk();
      await host.evaluate(() => __game.netCreateRoom());
      const code = await until(() => host.evaluate(() => __game.netCode), 'room code');
      await cli.evaluate((c) => __game.netJoinRoom(c), code);
      const slot = await until(() => cli.evaluate(() => __game.netMySlot || null), 'client slot');
      await until(() => host.evaluate(() => __game.netRoster.length === 2), 'roster');
      await host.evaluate((s) => __game.netLeave && (window.__k = s), slot); // Slot merken
      await host.evaluate((s) => { /* Host sendet kick */ document.dispatchEvent(new MouseEvent('click')); }, slot);
      // Kick über die interne API auslösen (Button-ID kick_<slot>)
      await host.evaluate((s) => { const b = document.getElementById('kick_' + s); if (b) b.click(); }, slot);
      const kicked = await until(async () => {
        const st = await cli.evaluate(() => ({ code: __game.netCode, role: __game.netRole }));
        return (!st.code) ? st : null;
      }, 'kicked client drops out', 6000).catch(() => null);
      ok(!!kicked, 'host can kick a player from the lobby');
      const hostRoster = await host.evaluate(() => __game.netRoster.length);
      ok(hostRoster === 1, 'host roster shrinks back after kick', `roster ${hostRoster}`);
      await host.close(); await cli.close();
    }

    // ---- 9) Spawn-Replay-Ausrichtung: Online-Runde mit Wänden, KEINE Desync-Warnung ----
    {
      const warns = [];
      const host = await mk(), cli = await mk();
      cli.on('console', (m) => { if (/Spawn-Replay asynchron|asynchron/.test(m.text())) warns.push(m.text()); });
      await host.evaluate(() => __game.netCreateRoom());
      const code = await until(() => host.evaluate(() => __game.netCode), 'room code');
      await cli.evaluate((c) => __game.netJoinRoom(c), code);
      await until(() => host.evaluate(() => __game.netRoster.length === 2), 'roster');
      await host.evaluate(() => __game.netStartOnline());
      await until(() => cli.evaluate(() => __game.netRole === 'client' && __game.state === 'playing'), 'client playing');
      await sleep(9000); // Hindernisse (inkl. Wände mit Graffiti) spawnen lassen
      const obs = await cli.evaluate(() => __game.obstacles.length);
      ok(warns.length === 0, 'spawn replay stays aligned (no desync warnings)', `${warns.length} warnings`);
      ok(obs > 0, 'obstacles replicate onto the client', `${obs} obstacles`);
      await host.close(); await cli.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill('SIGKILL');
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* egal */ }
  }

  console.log('\nOnline E2E\n' + results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\n\x1b[31mE2E-Lauf abgebrochen:\x1b[0m', e.message); process.exit(1); });
