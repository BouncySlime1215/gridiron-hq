/**
 * EVAL-E4: the planner-vs-baselines grader (server/services/eval/e4-planner.js)
 * and the pure parts of its Sleeper replay (scripts/eval/e4-planner-replay.mjs).
 * No real data: a made-up six-team league with invented players and points.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as E4 from '../server/services/eval/e4-planner.js';
import { STATUS } from '../server/services/eval/common.js';
import { rng } from '../server/services/eval/stats.js';
import {
  acceptP, bracket, seedOrder, lineup, prepareLeague, formatCheck, realized, realizedGain, makeWorld, makeAdapter,
  exportLeagues, FIT, DECISION_WEEK,
} from '../scripts/eval/e4-planner-replay.mjs';

// ------------------------------------------------------------------ grader
const rowsWith = (edge, n = 300, seed = 1) => {
  const rand = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const noise = () => (rand() < 0.1 ? (rand() < 0.5 ? -1 : 1) * 0.3 : 0);
    return { cluster: `L${i % 150}`, season: 2023,
      planner: { title: edge + noise(), playoff: 0 }, finder: { title: noise(), playoff: 0 }, greedy: { title: noise() * 0.5, playoff: 0 } };
  });
};

test('summarize: picks the best baseline by mean and compares the planner with it, paired and clustered', () => {
  const s = E4.summarize(rowsWith(0.2));
  assert.equal(s.n, 300);
  assert.equal(s.league_seasons, 150);
  assert.ok(['finder', 'nothing', 'greedy'].includes(s.best_baseline));
  assert.equal(s.vs_best, s.vs[s.best_baseline]);
  assert.ok(s.vs_best.ci[0] > 0, `ci ${s.vs_best.ci}`);
  assert.equal(E4.verdict(s.vs_best), STATUS.PASSING);
});

test('verdict: a planner worse than a baseline fails; a null effect is not_enough_data', () => {
  assert.equal(E4.verdict(E4.summarize(rowsWith(-0.2)).vs_best), STATUS.FAILING);
  assert.equal(E4.verdict(E4.summarize(rowsWith(0)).vs_best), STATUS.NOT_ENOUGH_DATA);
  assert.equal(E4.verdict({ mean: null, ci: null }), STATUS.NOT_ENOUGH_DATA);
});

test('summarize: nothing is 0 by definition and a non-finite arm drops the row', () => {
  const rows = [...rowsWith(0.1, 20), { cluster: 'x', planner: { title: NaN }, finder: { title: 0 }, greedy: { title: 0 } }];
  const s = E4.summarize(rows);
  assert.equal(s.n, 20);
  assert.equal(s.means.nothing, 0);
});

test('historical row: waits until frozen; a frozen summary grades from its stored CI and says the accepts are assumed', () => {
  const w = E4.historical(null);
  assert.equal(w.status, STATUS.NOT_ENOUGH_DATA);
  assert.match(w.needs_text, /not frozen/);
  const frozen = { title: E4.roundSummary(E4.summarize(rowsWith(0))) };
  const r = E4.historical(frozen);
  assert.equal(r.source, 'historical_fixed');
  assert.equal(r.check, 'E4');
  assert.equal(r.detail.real_behavior_only, false);
  assert.equal(r.status, STATUS.NOT_ENOUGH_DATA);
  assert.ok(r.needs_n >= 1 && r.needs_unit === 'league_seasons');
  const pass = E4.historical({ title: E4.roundSummary(E4.summarize(rowsWith(0.2))) });
  assert.equal(pass.status, STATUS.PASSING);
  assert.equal(pass.needs_text, null);
  assert.ok(pass.ci_low > 0 && pass.n === 300);
});

test('live row: not_enough_data until 4 graded weeks exist in planner_move_outcomes', () => {
  const db = new DatabaseSync(':memory:');
  const a = E4.live(db);
  assert.equal(a.check, 'E4-live');
  assert.equal(a.status, STATUS.NOT_ENOUGH_DATA);
  assert.equal(a.needs_n, 4);
  assert.equal(a.needs_unit, 'weeks');
  db.exec('CREATE TABLE planner_move_outcomes (league_id TEXT, season INTEGER, week INTEGER, planner_gain REAL, finder_gain REAL, greedy_gain REAL)');
  const ins = db.prepare('INSERT INTO planner_move_outcomes VALUES (?, ?, ?, ?, ?, ?)');
  for (const w of [3, 4, 5]) ins.run('1', 2026, w, 0.01, 0, 0);
  ins.run('1', 2025, 9, 0.01, 0, 0);
  const b = E4.live(db);
  assert.equal(b.n, 3);
  assert.equal(b.needs_n, 1);
  for (const w of [6, 7, 8, 9, 10]) ins.run('1', 2026, w, 0.02 + w * 0.001, 0, 0.001);
  const c = E4.live(db);
  assert.equal(c.n, 8);
  assert.equal(c.status, STATUS.PASSING);
});

test('run returns the historical and the live row', () => {
  const rows = E4.run(new DatabaseSync(':memory:'));
  assert.deepEqual(rows.map(r => r.check), ['E4', 'E4-live']);
});

// ------------------------------------------------------------------ replay: pure parts
test('acceptP: 0.35 at par, rises 0.01 per screen point, clamped', () => {
  assert.equal(acceptP(100, 100), 0.35);
  assert.ok(Math.abs(acceptP(110, 100) - 0.45) < 1e-12);
  assert.equal(acceptP(1000, 100), 0.9);
  assert.equal(acceptP(0, 100), 0.02);
  assert.equal(acceptP(10, 0), 0.02);
});

test('bracket: 6 teams give the top two a bye and reseed; higher seed wins ties', () => {
  // seeds 0..5 (index = team); team 5 (seed 6) scores most every round.
  const champ = bracket([0, 1, 2, 3, 4, 5], 6, t => (t === 5 ? 100 : 50 - t));
  assert.equal(champ, 5);
  const played = [];
  bracket([0, 1, 2, 3, 4, 5], 6, (t, r) => { played.push([r, t]); return 10; });
  assert.deepEqual(played.filter(([r]) => r === 0).map(([, t]) => t).sort(), [2, 3, 4, 5], 'seeds 1-2 sit out round 1');
  assert.equal(bracket([3, 1, 2, 0], 4, () => 10), 3, 'all tied: top seed wins');
});

test('seedOrder: wins first, then points for', () => {
  assert.deepEqual(seedOrder(Float64Array.from([5, 7, 7, 2]), Float64Array.from([900, 800, 850, 1000])), [2, 1, 0, 3]);
});

test('lineup: dedicated slots first, then flex; byes skipped', () => {
  const P = { a: { pos: 'RB', bye: null }, b: { pos: 'RB', bye: 7 }, c: { pos: 'WR', bye: null }, d: { pos: 'WR', bye: null }, e: { pos: 'RB', bye: null } };
  const score = { a: 10, b: 30, c: 9, d: 8, e: 5 };
  const lu = lineup(Object.keys(P), ['RB', 'WR', 'FLEX'], id => P[id], 7, id => score[id]);
  assert.deepEqual(lu.sort(), ['a', 'c', 'd']);
});

// A six-team league, 3 starters (QB, RB, WR), playoff start week 10 (regular weeks 1-9), 4 playoff teams.
function fixtureLeague() {
  const rids = [1, 2, 3, 4, 5, 6];
  const pl = {};
  const tw = {};
  const strength = { 1: 10, 2: 12, 3: 14, 4: 16, 5: 18, 6: 20 };
  for (const r of rids) {
    const ids = [`${r}q`, `${r}r`, `${r}w`, `${r}b`];
    ids.forEach((id, j) => {
      const base = j === 3 ? 1 : strength[r];
      pl[id] = [['QB', 'RB', 'WR', 'WR'][j], null, Array(19).fill(base), Array(19).fill(base)];
    });
    tw[r] = [];
  }
  // Team 1's bench WR is a star in reality from week 7 on (nobody knew: value stays 1).
  pl['1b'][3] = pl['1b'][3].map((x, w) => (w >= 7 ? 40 : x));
  pl['1b'][2] = Array(19).fill(1);
  // Round-robin-ish schedule: pairs rotate.
  const sched = [[[1, 2], [3, 4], [5, 6]], [[1, 3], [2, 5], [4, 6]], [[1, 4], [2, 6], [3, 5]], [[1, 5], [2, 4], [3, 6]], [[1, 6], [2, 3], [4, 5]]];
  for (let w = 1; w <= 9; w++) {
    for (const [a, b] of sched[(w - 1) % 5]) {
      for (const [x, y] of [[a, b], [b, a]]) {
        const ids = [`${x}q`, `${x}r`, `${x}w`, `${x}b`];
        tw[x][w - 1] = [3 * strength[x], y, ids];
      }
    }
  }
  const made = {}, champ = {};
  for (const r of rids) { made[r] = r >= 3 ? 1 : 0; champ[r] = r === 6 ? 1 : 0; }
  return { lid: 'fixture', season: 2021, sc: 'ppr', sf: 0, nt: 6, pt: 4, pws: 10, slots: ['QB', 'RB', 'WR'], rids,
    tw: Object.fromEntries(rids.map(r => [String(r), tw[r]])), made, champ, pl };
}

test('realized: doing nothing reproduces the real standings (the format check) and a swap moves real points', () => {
  const C = prepareLeague(fixtureLeague());
  assert.equal(formatCheck(C), true);
  const base = realized(C, new Map(C.base));
  assert.deepEqual([...base.made].sort(), ['3', '4', '5', '6']);
  assert.equal(base.champion, '6');
  // Team 6 sends its WR (20 a week) to team 1 for team 1's WR (10 a week): from week 7 and in the playoffs
  // team 6's rule lineup scores 50, below team 5's 54, so the real title moves.
  const s = new Map(C.base);
  s.set('6', [...C.base.get('6').filter(x => x !== '6w'), '1w']);
  s.set('1', [...C.base.get('1').filter(x => x !== '1w'), '6w']);
  const after = realized(C, s);
  assert.equal(after.champion, '5');
});

test('realizedGain: expected over accept/decline outcomes with the step p; do nothing is 0', () => {
  const C = prepareLeague(fixtureLeague());
  const base = realized(C, new Map(C.base));
  assert.deepEqual(realizedGain(C, '2', [], base), { title: 0, playoff: 0, title_done: 0, playoff_done: 0, steps: 0, p_complete: 0 });
  // Team 5 gets team 6's WR for its bench WR: team 6's lineup drops to 41, team 5's rises to 56 -> team 5 wins the title.
  const g = realizedGain(C, '5', [{ team: '6', give: ['5b'], get: ['6w'], p: 0.4 }], base);
  assert.equal(g.title_done, 1);
  assert.ok(Math.abs(g.title - 0.4 * g.title_done) < 1e-12, 'one step: expected = p x realized change');
  assert.equal(g.p_complete, 0.4);
  // Two steps: the second declined strands the first (weight p1 x (1 - p2)).
  const g2 = realizedGain(C, '5', [{ team: '6', give: ['5b'], get: ['6w'], p: 0.5 }, { team: '1', give: ['5r'], get: ['1r'], p: 0.5 }], base);
  assert.equal(g2.p_complete, 0.25);
  assert.ok(Math.abs(g2.title - (0.25 * 1 + 0.25 * g2.title_done)) < 1e-12);
});

test('world: rescore is deterministic per seed, zero for no change, and a strong add raises title odds', () => {
  const C = prepareLeague(fixtureLeague());
  const W = makeWorld(C, 11, { runs: 300, fit: FIT });
  const none = W.rescore(new Map(), '2');
  assert.equal(none.me.title_delta, 0);
  const s = new Map([['2', [...C.base.get('2').filter(x => x !== '2w'), '6w']], ['6', [...C.base.get('6').filter(x => x !== '6w'), '2w']]]);
  const a = W.rescore(s, '2', '6'), b = makeWorld(C, 11, { runs: 300, fit: FIT }).rescore(s, '2', '6');
  assert.equal(a.me.title_after, b.me.title_after);
  assert.ok(a.me.title_delta > 0 && a.them.title_delta < 0);
  assert.ok(a.me.title_delta_se > 0);
});

test('adapter: planner-shaped, market value above replacement, week-7 decision', () => {
  const C = prepareLeague(fixtureLeague());
  const ad = makeAdapter(C, '1', { runs: 50, leagueKey: 'Lx' });
  assert.equal(ad.league.week, DECISION_WEEK);
  assert.equal(ad.rosters.get('1').length, 4);
  assert.ok(ad.players.get('6w').value > ad.players.get('1w').value);
  assert.equal(ad.managers.has('1'), false);
  const p = ad.priceStep('6', ['6w'], ['1w']);
  assert.ok(p.p >= 0.02 && p.p <= 0.9);
});

test('export refuses the held-out 2025 season before reading anything', () => {
  assert.throws(() => exportLeagues({ sh: '/nonexistent', cache: '/nonexistent', seasons: [2024, 2025], out: '/dev/null' }), /2025 is held out/);
});
