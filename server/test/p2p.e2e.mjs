// End-to-End-Tests des P2P-Gesundheitswächters (netP2PProbe) und der Transport-Anzeige.
// Echte WebRTC-Aushandlung (STUN, KEIN ?nop2p) zwischen headless-Chromium-Seiten am
// selben Host. "Silent Death" wird über __game.netTestSilenceP2P simuliert (Kanal bleibt
// 'open', onmessage entfernt -> lastRecv friert ein -> Probe greift nach dem Timeout).
//   npm run test:p2p   (aus server/)   ·   CHROMIUM=… überschreibt den Browser
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'server.js');
const PORT = +(process.env.PORT || 8455);
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

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE, { method: 'HEAD' }); if (r.ok || r.status === 200) return; } catch { /* noch nicht */ }
    await sleep(150);
  }
  throw new Error('Server nicht erreichbar: ' + BASE);
}

const label = (p) => p.evaluate(() => __game.netTransportLabel());

// Host + n Clients aufsetzen, Runde starten, auf echte P2P-Verbindung aller Clients warten.
async function room(mk, n) {
  const host = await mk();
  await host.evaluate(() => __game.netCreateRoom());
  const code = await until(() => host.evaluate(() => __game.netCode), 'room code');
  const clients = [];
  for (let i = 0; i < n; i++) {
    const c = await mk();
    await c.evaluate((cd) => __game.netJoinRoom(cd), code);
    clients.push(c);
  }
  await until(() => host.evaluate((k) => __game.netRoster.length === k, n + 1), 'roster fills');
  await host.evaluate(() => __game.netStartOnline());
  for (const c of clients) await until(() => c.evaluate(() => __game.netRole === 'client' && __game.state === 'playing'), 'client playing');
  // echte P2P-Aushandlung abwarten (STUN am selben Host) — der Kern-Vorbedingung dieser Tests
  for (const c of clients) await until(() => label(c).then((l) => l === '🔗 P2P'), 'client P2P up', 12000);
  return { host, clients, code };
}

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), 'runordie-p2p-'));
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

    // ---- 1) Gesunde P2P wird vom Wächter NICHT fälschlich gekappt ----
    {
      const { host, clients } = await room(mk, 1);
      const c = clients[0];
      ok(await label(c) === '🔗 P2P', 'client shows 🔗 P2P once direct connection is up');
      ok(await label(host) === '🔗 P2P', 'host shows 🔗 P2P for a directly-connected client');
      await sleep(4000); // > NET_P2P_TIMEOUT: der Probe läuft ~8x, darf gesunde P2P nicht kappen
      ok(await label(c) === '🔗 P2P', 'healthy P2P survives the watchdog (no false drop over 4s)');
      const st = await c.evaluate(() => __game.state);
      ok(st === 'playing', 'client still playing after the idle-probe window', st);
      await host.close(); await c.close();
    }

    // ---- 2) Silent Death -> automatischer Fallback aufs Relay, Spiel läuft weiter ----
    {
      const { host, clients } = await room(mk, 1);
      const c = clients[0];
      await c.evaluate(() => __game.netTestSilenceP2P()); // Kanal 'open', liefert nichts -> lastRecv friert
      // Probe (2x/s) muss binnen ~NET_P2P_TIMEOUT+etwas kappen
      const fell = await until(() => label(c).then((l) => l === '📡 Relay'), 'client falls back to relay', 6000).then(() => true).catch(() => false);
      ok(fell, 'silent-death P2P auto-falls-back to 📡 Relay within timeout');
      await sleep(4000);
      const st = await c.evaluate(() => __game.state);
      ok(st === 'playing', 'game survives the P2P death via relay (still playing, not disconnected)', st);
      // Host-Seite sollte den Peer ebenfalls verworfen haben (p2pdrop übers Relay)
      const hp = await host.evaluate(() => __game.netP2P);
      ok(!Object.values(hp).some((s) => s === 'open'), 'host dropped its side of the dead peer too', JSON.stringify(hp));
      await host.close(); await c.close();
    }

    // ---- 3) m.to-Filter: der host-erkannte Ausfall EINES Clients kappt NICHT die anderen ----
    // (Regression zum Review-Fund: das Relay broadcastet Host-JSON an ALLE Clients.)
    {
      const { host, clients } = await room(mk, 2);
      const [c1, c2] = clients;
      // Host verstummt nur Peer von Slot 1 -> Host-Probe kappt slot1 und broadcastet p2pdrop{to:1}
      await host.evaluate(() => __game.netTestSilenceP2P(1));
      const c1fell = await until(() => label(c1).then((l) => l === '📡 Relay'), 'client1 dropped', 6000).then(() => true).catch(() => false);
      ok(c1fell, 'the client whose peer died is dropped to relay');
      await sleep(1500); // dem Broadcast Zeit geben, fälschlich auch c2 zu treffen (falls Filter fehlt)
      ok(await label(c2) === '🔗 P2P', 'a healthy client is NOT collateral-dropped by another client\'s p2pdrop (m.to filter)');
      await host.close(); await c1.close(); await c2.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill('SIGKILL');
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* egal */ }
  }

  console.log('\nP2P E2E\n' + results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\n\x1b[31mE2E-Lauf abgebrochen:\x1b[0m', e.message); process.exit(1); });
