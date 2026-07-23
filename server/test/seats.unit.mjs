// Unit-Tests der reinen Sitzplatz-/Raum-Helfer (seats.js) — kein Server, kein Browser.
//   node --test test/seats.unit.mjs   (oder: npm run test:unit)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PLAYERS, freeSlots, usedSlots, seatCount, seatName, roomClientSockets } from '../seats.js';

// Kleiner Raum-Bauhelfer: host belegt hostSlots, clients ist eine Map slot->ws.
const room = (hostSlots, clientEntries = []) => ({
  host: { slots: hostSlots },
  clients: new Map(clientEntries),
});

test('usedSlots vereint Host- und Client-Slots', () => {
  const r = room([0], [[1, {}], [2, {}]]);
  assert.deepEqual([...usedSlots(r)].sort(), [0, 1, 2]);
});

test('freeSlots gibt die niedrigsten freien Slots', () => {
  assert.deepEqual(freeSlots(room([0]), 1), [1]);
  assert.deepEqual(freeSlots(room([0]), 2), [1, 2]);
  assert.deepEqual(freeSlots(room([0], [[1, {}]]), 2), [2, 3]);
});

test('freeSlots gibt null, wenn nicht genug frei ist', () => {
  const full3 = room([0], [[1, {}], [2, {}]]); // 3 belegt, 1 frei
  assert.deepEqual(freeSlots(full3, 1), [3]);
  assert.equal(freeSlots(full3, 2), null, 'nur 1 frei -> 2 nicht möglich');
  const full4 = room([0, 1], [[2, {}], [3, {}]]);
  assert.equal(freeSlots(full4, 1), null, 'voll');
});

test('freeSlots respektiert MAX_PLAYERS (4)', () => {
  assert.equal(MAX_PLAYERS, 4);
  assert.equal(freeSlots(room([]), 5), null, 'nie mehr als 4');
  assert.deepEqual(freeSlots(room([]), 4), [0, 1, 2, 3]);
});

test('freeSlots mit 2-Sitz-Host (Splitscreen-Host belegt 0 und 1)', () => {
  assert.deepEqual(freeSlots(room([0, 1]), 2), [2, 3]);
});

test('seatCount: 2 nur bei seats===2, sonst 1', () => {
  assert.equal(seatCount({ seats: 2 }), 2);
  assert.equal(seatCount({ seats: 1 }), 1);
  assert.equal(seatCount({}), 1);
  assert.equal(seatCount({ seats: 3 }), 1, 'ungültig -> 1');
  assert.equal(seatCount({ seats: '2' }), 2, "numerischer String '2' wird via |0 zu 2");
  assert.equal(seatCount({ seats: 'abc' }), 1, 'nicht-numerisch -> 1');
});

test('seatName: Sitz 0 = Erstkonto, Sitz 1 = Zweitkonto oder ②', () => {
  assert.equal(seatName({ user: { username: 'A' }, user2: { username: 'B' } }, 0), 'A');
  assert.equal(seatName({ user: { username: 'A' }, user2: { username: 'B' } }, 1), 'B', 'eigenes Zweitkonto');
  assert.equal(seatName({ user: { username: 'A' } }, 1), 'A ②', 'ohne Zweitkonto -> ②');
  assert.equal(seatName({ user: null }, 0), null, 'anonym');
  assert.equal(seatName({ user: null, user2: null }, 1), null, 'anonymer Sitz 2');
});

test('roomClientSockets dedupliziert 2-Sitz-Clients', () => {
  const ws = { id: 'x' };
  const r = room([0], [[1, ws], [2, ws]]); // eine ws auf zwei Slots
  assert.equal(roomClientSockets(r).size, 1, 'derselbe Socket zählt einmal');
});
