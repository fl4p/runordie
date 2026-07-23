// Unit-Tests der Datenbankschicht (db.js) — schnell, deterministisch, ohne Browser
// oder Server. Läuft mit dem eingebauten Node-Testrunner.
//   node --test test/db.unit.mjs      (oder: npm run test:unit)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DB_PATH VOR dem Import setzen: db.js öffnet die DB beim Laden.
const dir = mkdtempSync(join(tmpdir(), 'runordie-dbunit-'));
process.env.DB_PATH = join(dir, 'test.db');
const db = await import('../db.js');
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* egal */ } });

test('validUsername akzeptiert 3–16 Zeichen A–Z 0–9 _', () => {
  for (const ok of ['abc', 'Player_1', 'AAAAAAAAAAAAAAAA']) assert.ok(db.validUsername(ok), ok);
  for (const bad of ['ab', 'a'.repeat(17), 'has space', 'bad-dash', 'ümlaut', '', 42, null]) assert.ok(!db.validUsername(bad), String(bad));
});

test('validPassword verlangt 6–200 Zeichen', () => {
  assert.ok(db.validPassword('secret1'));
  assert.ok(db.validPassword('x'.repeat(200)));
  assert.ok(!db.validPassword('short'));
  assert.ok(!db.validPassword('x'.repeat(201)));
  assert.ok(!db.validPassword(123456));
});

test('createUser + findUser + verifyPassword', async () => {
  const u = await db.createUser('Alice', 'secret1');
  assert.equal(u.username, 'Alice');
  assert.ok(u.id > 0);
  const found = db.findUser('alice'); // COLLATE NOCASE
  assert.equal(found.id, u.id);
  assert.ok(await db.verifyPassword('secret1', found.pass_hash, found.pass_salt), 'richtiges Passwort');
  assert.ok(!(await db.verifyPassword('wrong', found.pass_hash, found.pass_salt)), 'falsches Passwort');
});

test('doppelter Benutzername (auch andere Schreibweise) schlägt fehl', async () => {
  await db.createUser('Bob', 'secret1');
  await assert.rejects(() => db.createUser('BOB', 'secret1'), 'UNIQUE COLLATE NOCASE');
});

test('Sessions: newSession -> userForToken -> endSession', async () => {
  const u = await db.createUser('Cara', 'secret1');
  const tok = db.newSession(u.id);
  assert.equal(db.userForToken(tok).id, u.id);
  assert.equal(db.userForToken('nope'), null);
  assert.equal(db.userForToken(''), null);
  db.endSession(tok);
  assert.equal(db.userForToken(tok), null, 'nach endSession ungültig');
});

test('recordSolo: best_time = MAX, games++, play_seconds += Zeit', async () => {
  const u = await db.createUser('Dora', 'secret1');
  db.recordSolo(u.id, 30);
  db.recordSolo(u.id, 12); // kleiner -> best_time bleibt 30
  const p = db.publicUser(db.findUser('Dora'));
  assert.equal(p.bestTime, 30);
  assert.equal(p.games, 2);
  assert.equal(p.playSeconds, 42, '30 + 12 Spielzeit');
});

test('recordOnline: rounds++, wins += Sieg, play_seconds += Dauer', async () => {
  const u = await db.createUser('Ed', 'secret1');
  db.recordOnline(u.id, true, 42);
  db.recordOnline(u.id, false, 18);
  const p = db.publicUser(db.findUser('Ed'));
  assert.equal(p.onlineRounds, 2);
  assert.equal(p.onlineWins, 1);
  assert.equal(p.playSeconds, 60, '42 + 18 Runden-Dauer');
});

test('recordOnline begrenzt/säubert die Dauer', async () => {
  const u = await db.createUser('Flo', 'secret1');
  db.recordOnline(u.id, false, -5);      // negativ -> 0
  db.recordOnline(u.id, false, 1e9);     // riesig -> gedeckelt (100000)
  const p = db.publicUser(db.findUser('Flo'));
  assert.equal(p.playSeconds, 100000);
});

test('publicUser gibt niemals Hash/Salt preis', async () => {
  const u = await db.createUser('Gwen', 'secret1');
  const p = db.publicUser(db.findUser('Gwen'));
  assert.ok(!('pass_hash' in p) && !('pass_salt' in p));
  assert.deepEqual(Object.keys(p).sort(), ['bestTime', 'games', 'id', 'onlineRounds', 'onlineWins', 'playSeconds', 'username'].sort());
});

test('leaderboard: nach best_time absteigend, nur mit best_time > 0', async () => {
  const a = await db.createUser('Lb1', 'secret1');
  const b = await db.createUser('Lb2', 'secret1');
  await db.createUser('Lb3', 'secret1'); // best_time 0 -> nicht gelistet
  db.recordSolo(a.id, 50);
  db.recordSolo(b.id, 90);
  const top = db.leaderboard(20).map((r) => r.username);
  assert.ok(top.indexOf('Lb2') < top.indexOf('Lb1'), 'Lb2 (90) vor Lb1 (50)');
  assert.ok(!top.includes('Lb3'), 'kein Eintrag ohne best_time');
});

test('play_seconds-Spalte existiert (Migration lief)', () => {
  const cols = db.default.prepare("SELECT name FROM pragma_table_info('users')").all().map((c) => c.name);
  assert.ok(cols.includes('play_seconds'));
});

test('recordBugReport + recentBugReports', () => {
  const before = db.bugReportCount();
  db.recordBugReport({ note: 'x', mode: 'solo', elapsed: 12.5, ping: null, url: 'u', ua: 'ua', frames: [[1, 2, 3]] });
  assert.equal(db.bugReportCount(), before + 1);
  const recent = db.recentBugReports(1);
  assert.equal(recent[0].note, 'x');
  assert.equal(recent[0].mode, 'solo');
});
