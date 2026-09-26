/**
 * U4 CONSISTENT-CHIP (scripts/rnd/consistent-chip.mjs): rule D from docs/tdd/U4-CONSISTENT-CHIP-PREREG.md
 * fails closed on every missing input, and while the pre-registered test has served no position
 * (SERVED_POSITIONS empty) the reader never lets A.J. Brown (277) move.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RULE, SERVED_POSITIONS, starterBaselines, teamWindow, consistentRead, consistentOfFrom }
  from '../scripts/rnd/consistent-chip.mjs';
import { ajMayMove } from '../server/services/campaign/never-give.js';

const TABLE = { positions: { QB: [-8, -4, 0, 4, 8], RB: [-6, -3, 0, 3, 6], WR: [-6, -3, 0, 3, 6], TE: [-4, -2, 0, 2, 4] } };
const K = 1;
const BASE = { median: 15, line: 13 };
const win = pts => pts.map((p, i) => ({ season: 2026, week: 10 - i, pts: p }));
const good = () => ({ position: 'WR', score: 90, hurt: false, injuryStatus: null, window: win([20, 18, 16, 15, 9, 8]), mean: 19 });
const read = (p, o = {}) => consistentRead(p, { baseline: BASE, k: K, table: TABLE, ...o });

test('a consistent Blue chip reads consistent (all five clauses hold)', () => {
  const r = read(good());
  assert.deepEqual(r.reasons, []);
  assert.equal(r.consistent, true);
  assert.equal(r.hits, 4);
});

test('every missing or failing input reads NOT consistent (fails closed)', () => {
  const cases = {
    no_score: { score: null },
    below_blue_chip: { score: 82 },
    hurt: { hurt: true },
    hurt_unknown: { hurt: undefined },
    inactive_out: { injuryStatus: 'Out' },
    inactive_doubtful: { injuryStatus: 'Doubtful' },
    injury_unread: { injuryStatus: undefined },
    window_short: { window: win([20, 18, 16, 15, 9]) },
    window_missed_game: { window: win([20, 18, null, 15, 16, 17]) },
    window_none: { window: null },
    history_3_of_6: { window: win([20, 18, 16, 9, 9, 8]) },
    p25_below_line: { mean: 15 },
    no_mean: { mean: null },
    kicker: { position: 'K' },
  };
  for (const [name, patch] of Object.entries(cases)) {
    const r = read({ ...good(), ...patch });
    assert.equal(r.consistent, false, name);
  }
  assert.equal(read(good(), { baseline: null }).consistent, false, 'no baseline');
  assert.equal(read(good(), { k: null }).consistent, false, 'no k');
  assert.equal(read(good(), { table: null }).consistent, false, 'no table');
  assert.equal(consistentRead(undefined, { baseline: BASE, k: K, table: TABLE }).consistent, false, 'no player');
});

test('D0 (literal NEXT-LEAP) compares the p25 with the median, stricter than D', () => {
  const p = { ...good(), mean: 17 }; // p25 = 17 - 3.75 = 13.25: over the line, under the median
  assert.equal(read(p).consistent, true);
  assert.equal(read(p, { literal: true }).consistent, false);
});

test('starter baselines: last season top N by ppg (8+ games), median of their weeks, N-th ppg as the line', () => {
  const games = [];
  for (let i = 0; i < 21; i++) for (let w = 1; w <= 17; w++) games.push({ id: `w${i}`, position: 'WR', week: w, pts: 30 - i });
  games.push({ id: 'short', position: 'WR', week: 1, pts: 99 }); // 1 game: not ranked
  games.push({ id: 'w0', position: 'WR', week: 18, pts: 0 }); // week 18 excluded
  const b = starterBaselines(games).get('WR');
  assert.equal(b.n, 20);
  assert.equal(b.line, 11); // the 20th: 30 - 19
  assert.equal(b.median, 20.5); // weeks of 30..11, pooled
  assert.equal(starterBaselines(games).has('RB'), false, 'too few RBs: no baseline, so nobody reads consistent');
});

test('team window: last 6 team weeks walking back into last season; byes skipped, a missed game is null', () => {
  const tw = new Map([['2026:PHI', new Set([1, 2, 3])], ['2025:PHI', new Set([13, 15, 16, 17, 18])]]);
  const games = [
    { season: 2026, week: 1, team: 'PHI', pts: 10 }, { season: 2026, week: 3, team: 'PHI', pts: 12 },
    { season: 2025, week: 13, team: 'PHI', pts: 7 }, { season: 2025, week: 15, team: 'PHI', pts: 8 },
    { season: 2025, week: 16, team: 'PHI', pts: 9 }, { season: 2025, week: 17, team: 'PHI', pts: 11 },
    { season: 2025, week: 18, team: 'PHI', pts: 40 },
  ];
  const w = teamWindow(games, tw, { season: 2026, week: 4 });
  assert.deepEqual(w.map(x => `${x.season}:${x.week}:${x.pts}`), ['2026:3:12', '2026:2:null', '2026:1:10', '2025:17:11', '2025:16:9', '2025:15:8']);
  assert.equal(teamWindow(games.filter(g => g.season === 2026), tw, { season: 2026, week: 4 }), null, 'a rookie has no last season');
  assert.equal(RULE.window, 6);
});

test('today no position is served, so the reader never lets 277 move', () => {
  assert.deepEqual([...SERVED_POSITIONS], []);
  const inputs = new Map([['500', good()]]);
  const of = consistentOfFrom(inputs, { baselines: new Map([['WR', BASE]]), k: K, table: TABLE });
  assert.equal(of('500'), false);
  assert.equal(ajMayMove(['500'], { scoreOf: () => 95, consistentOf: of }), false);
  const served = consistentOfFrom(inputs, { baselines: new Map([['WR', BASE]]), k: K, table: TABLE, servedPositions: ['WR'] });
  assert.equal(served('500'), true);
  assert.equal(served('404'), false, 'a player with no inputs is not consistent');
});
