#!/usr/bin/env node
/**
 * PEOPLE-BOARD metric on a real DB copy: builds the War Room view for one league exactly
 * as the route does (warRoomView, People Board on) and prints COUNTS ONLY (roster ids, no
 * names, no chat text):
 *   - tiles, and how many carry real P(responds) AND fatigue values (the unit's metric);
 *   - the standing order with Nick's overrides (never / last / hard);
 *   - per slot ok / unknown / failed, with each distinct unknown reason (digits masked);
 *   - view latency p50 / p95 over `reps` calls and the event-loop delay while they ran.
 *
 *   node scripts/study/people-board-check.mjs [league=4] [reps=50] [--cold]
 *   --cold drops the route's people cache before every call (every call does all its SELECTs).
 *
 * Needs the War Room and People Board switches on (warroom-flag.js), GRIDIRON_DB_PATH and
 * GRIDIRON_CHAT_DB_PATH pointed at copies, and the plans file (warroom-flag.js#warRoomPlansPath).
 * Writes nothing.
 */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { warRoomView, __resetPeopleCache } from '../../server/services/war-room-view.js';

const leagueId = Number(process.argv.slice(2).filter(a => !a.startsWith('--'))[0] ?? 4);
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const cold = process.argv.includes('--cold');
const reps = Number(args[1] ?? 50);
if (!Number.isInteger(leagueId) || leagueId < 1) throw new Error(`league id must be a positive integer, got ${process.argv[2]}`);

const v = await warRoomView(leagueId); // also warms the lazy imports and the plans cache
if (!v.enabled) throw new Error('The War Room is off (warroom-flag.js).');
if (!v.people_board?.enabled) throw new Error('The People Board is off (warroom-flag.js#peopleBoardFlag).');

const lag = monitorEventLoopDelay({ resolution: 5 });
lag.enable();
const ms = [];
for (let i = 0; i < reps; i++) {
  if (cold) __resetPeopleCache();
  const t = performance.now();
  await warRoomView(leagueId);
  ms.push(performance.now() - t);
  await new Promise(r => setImmediate(r));
}
lag.disable();
ms.sort((a, b) => a - b);
const q = p => +ms[Math.min(ms.length - 1, Math.floor(p * ms.length))].toFixed(1);

const tiles = v.people?.status === 'ok' ? v.people.value : [];
const SLOTS = ['p_responds', 'fatigue', 'mood', 'in_market', 'word', 'approach', 'last_contact'];
const slots = Object.fromEntries(SLOTS.map(k => {
  const counts = { ok: 0, unknown: 0, failed: 0 };
  const reasons = {};
  for (const t of tiles) {
    counts[t[k].status] += 1;
    if (t[k].status !== 'ok') { const r = String(t[k].reason ?? '').replace(/\d+/g, 'N'); reasons[r] = (reasons[r] ?? 0) + 1; }
  }
  return [k, { ...counts, reasons }];
}));
console.log(JSON.stringify({
  league: leagueId,
  people: v.people?.status, people_reason: v.people?.status === 'ok' ? undefined : v.people?.reason,
  tiles: tiles.length,
  real_p_responds_and_fatigue: tiles.filter(t => t.p_responds.status === 'ok' && t.fatigue.status === 'ok').length,
  order: tiles.map(t => `${t.team}:${t.standing}${t.nick.hard ? '+hard' : ''}`).join(' '),
  overrides: { never: tiles.filter(t => t.standing === 'never').map(t => t.team), last: tiles.filter(t => t.standing === 'last').map(t => t.team),
    hard: tiles.filter(t => t.nick.hard).map(t => t.team), sources: [...new Set(tiles.map(t => t.nick.source).filter(Boolean))] },
  slots,
  view_ms: { reps, cold, p50: q(0.5), p95: q(0.95), max: q(1) },
  event_loop_delay_ms: { p99: +(lag.percentile(99) / 1e6).toFixed(1), max: +(lag.max / 1e6).toFixed(1) },
}, null, 2));
