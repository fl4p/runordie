// Reine Sitzplatz-/Raum-Helfer (keine Seiteneffekte) — aus server.js herausgezogen,
// damit sie unit-getestet werden können (test/seats.unit.mjs). Eine Verbindung kann
// 1–2 lokale Sitze mitbringen (Splitscreen an einem Gerät, gemischt mit Online).
export const MAX_PLAYERS = 4;

// Alle Client-Sockets eines Raums, dedupliziert (2-Sitz-Clients zeigen mit zwei Keys
// auf dieselbe ws).
export const roomClientSockets = (room) => new Set(room.clients.values());

// Belegte absolute Slots: die des Hosts + alle Client-Slots.
export function usedSlots(room) {
  const used = new Set(room.host.slots || []);
  for (const s of room.clients.keys()) used.add(s);
  return used;
}

// n zusammenhängend freie (niedrigste) Slots finden, oder null wenn nicht genug frei.
export function freeSlots(room, n) {
  const used = usedSlots(room);
  const out = [];
  for (let s = 0; s < MAX_PLAYERS && out.length < n; s++) if (!used.has(s)) out.push(s);
  return out.length === n ? out : null;
}

// Gewünschte lokale Spielerzahl aus einer create/join-Nachricht (1 oder 2).
export const seatCount = (msg) => (msg.seats | 0) === 2 ? 2 : 1;

// Anzeigename je Sitz einer Verbindung: Sitz 0 = Erstkonto, Sitz 1 = eigenes
// Zweitkonto (falls angemeldet), sonst die ②-Markierung des Erstkontos.
export function seatName(ws, i) {
  if (i === 0) return ws.user ? ws.user.username : null;
  if (ws.user2) return ws.user2.username;
  return ws.user ? ws.user.username + ' ②' : null;
}
