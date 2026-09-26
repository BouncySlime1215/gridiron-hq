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

test('live row: not_enough_data until the pre-registered gate (8 graded league-weeks, 3 NFL weeks)', () => {
  const db = new DatabaseSync(':memory:');
  const a = E4.live(db, { flag: true });
  assert.equal(a.check, 'E4-live');
  assert.equal(a.status, STATUS.NOT_ENOUGH_DATA);
  assert.equal(a.needs_n, 8);
  assert.equal(a.needs_unit, 'weeks');
  db.exec('CREATE TABLE planner_move_outcomes (league_id TEXT, season INTEGER, week INTEGER, planner_gain REAL, finder_gain REAL, greedy_gain REAL)');
  const ins = db.prepare('INSERT INTO planner_move_outcomes VALUES (?, ?, ?, ?, ?, ?)');
  for (const w of [3, 4, 5]) ins.run('1', 2026, w, 0.01, 0, 0);
  ins.run('1', 2025, 9, 0.01, 0, 0);
  const b = E4.live(db, { flag: true });
  assert.equal(b.n, 3);
  assert.equal(b.needs_n, 5);
  assert.equal(b.status, STATUS.NOT_ENOUGH_DATA);
  for (const w of [6, 7, 8, 9, 10]) ins.run('1', 2026, w, 0.02 + w * 0.001, 0, 0.001);
  const c = E4.live(db, { flag: true });
  assert.equal(c.n, 8);
  assert.equal(c.status, STATUS.PASSING);
  assert.equal(c.detail.provisional, false);
});

test('E4-LIVE: the early number is reported with its n from the first graded week, labelled, never a grade', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE planner_move_outcomes (league_id TEXT, season INTEGER, week INTEGER, planner_gain REAL, finder_gain REAL, greedy_gain REAL)');
  const ins = db.prepare('INSERT INTO planner_move_outcomes VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('4', 2026, 3, 0.012, 0.004, 0.001);
  const one = E4.live(db, { flag: true });
  assert.equal(one.n, 1);
  assert.equal(one.status, STATUS.NOT_ENOUGH_DATA);
  assert.equal(one.metric, 0.008, 'served minus the best baseline (finder here)');
  assert.equal(one.ci_low, null, 'no interval from one week');
  assert.equal(one.detail.provisional, true);
  assert.equal(one.detail.served_minus_nothing, 0.012);
  assert.equal(one.detail.served_minus_finder, 0.008);
  assert.match(one.needs_text, /^early number, not a grade: over 1 graded week the served move changed title odds \+1\.2 points vs doing nothing and \+0\.8 vs the finder's best deal; graded after 7 more weeks/);
  assert.doesNotMatch(one.needs_text, /planner_gain|finder_gain|_se\b/, 'no engine field names in the text');
});

test('E4-LIVE: a strongly negative early run is never failing before n allows (no Balanced fallback)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE planner_move_outcomes (league_id TEXT, season INTEGER, week INTEGER, planner_gain REAL, finder_gain REAL, greedy_gain REAL)');
  const ins = db.prepare('INSERT INTO planner_move_outcomes VALUES (?, ?, ?, ?, ?, ?)');
  // 7 league-weeks, every one clearly worse than the finder: the CI is wholly below 0.
  for (const [lg, w] of [[1, 3], [2, 3], [3, 3], [4, 3], [1, 4], [2, 4], [3, 4]]) ins.run(String(lg), 2026, w, -0.02 - lg * 0.001, 0.01, 0);
  const r = E4.live(db, { flag: true });
  assert.equal(r.n, 7);
  assert.ok(r.ci_high < 0, 'the early interval is below zero');
  assert.equal(r.status, STATUS.NOT_ENOUGH_DATA);
  // 8 league-weeks but only 2 NFL weeks: still not a grade.
  ins.run('4', 2026, 4, -0.03, 0.01, 0);
  const r2 = E4.live(db, { flag: true });
  assert.equal(r2.n, 8);
  assert.equal(r2.detail.gate.nfl_weeks, 2);
  assert.equal(r2.status, STATUS.NOT_ENOUGH_DATA);
  assert.match(r2.needs_text, /across at least 3 NFL weeks/);
  // A third NFL week meets the gate: now it may fail.
  ins.run('1', 2026, 5, -0.025, 0.01, 0);
  const r3 = E4.live(db, { flag: true });
  assert.equal(r3.status, STATUS.FAILING);
  assert.equal(r3.needs_text, null);
});

test('E4-LIVE: coverage says how many weeks were captured, settled, graded, ungraded (with why) and still open', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE planner_move_outcomes (league_id TEXT, season INTEGER, week INTEGER, planner_gain REAL, finder_gain REAL,
    greedy_gain REAL, planner_gain_se REAL, finder_gain_se REAL, greedy_gain_se REAL, settle_note TEXT, settled_at TEXT)`);
  const ins = db.prepare('INSERT INTO planner_move_outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run('4', 2026, 3, 0.01, 0, 0.002, 0.002, 0, 0.004, null, 't');
  ins.run('4', 2026, 4, null, 0, 0.002, null, 0, 0.004, 'planner: give 9 no longer on team 5', 't');
  ins.run('1', 2026, 4, 0.01, null, 0, 0.002, null, 0, 'finder: finder not run', 't');
  ins.run('4', 2026, 5, null, null, null, null, null, null, null, null);
  const r = E4.live(db, { flag: true });
  assert.equal(r.n, 1);
  assert.deepEqual({ ...r.detail.coverage, ungraded_reasons: undefined },
    { captured: 4, settled: 3, graded: 1, ungraded: 2, open: 1, ungraded_reasons: undefined });
  assert.deepEqual(r.detail.coverage.ungraded_reasons, { 'planner: give # no longer on team #': 1, 'finder: finder not run': 1 });
  assert.deepEqual(r.detail.sim_noise_se, { planner: 0.002, finder: 0, greedy: 0.004 });
  assert.equal(r.detail.by_league['4'].n, 1);
  const none = new DatabaseSync(':memory:');
  none.exec(`CREATE TABLE planner_move_outcomes (league_id TEXT, season INTEGER, week INTEGER, planner_gain REAL, finder_gain REAL,
    greedy_gain REAL, settled_at TEXT, settle_note TEXT)`);
  none.prepare('INSERT INTO planner_move_outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('4', 2026, 3, null, null, null, null, null);
  const w = E4.live(none, { flag: true });
  assert.equal(w.n, 0);
  assert.match(w.needs_text, /needs 8 more weeks \(0 graded weeks so far \(1 waiting for the week to finish, 0 ungraded\)\)/);
});

test('E4-LIVE flag: off (default) serves the pre-E4-LIVE row unchanged; on serves the early number', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE planner_move_outcomes (league_id TEXT, season INTEGER, week INTEGER, planner_gain REAL, finder_gain REAL, greedy_gain REAL)');
  const ins = db.prepare('INSERT INTO planner_move_outcomes VALUES (?, ?, ?, ?, ?, ?)');
  for (const w of [3, 4, 5]) ins.run('4', 2026, w, 0.01, 0, 0);
  const prev = process.env.GRIDIRON_E4_LIVE;
  try {
    delete process.env.GRIDIRON_E4_LIVE;
    assert.equal(E4.liveFlagOn(), false);
    const off = E4.live(db);
    assert.deepEqual(off, E4.liveLegacy(db), 'flag off: the legacy row, field for field');
    assert.equal(off.needs_n, 1, 'legacy gate: 4 graded weeks');
    assert.match(off.needs_text, /needs 1 more weeks \(3 graded week\(s\) so far\)/);
    assert.equal(off.detail.coverage, undefined, 'no early number or coverage while off');
    process.env.GRIDIRON_E4_LIVE = '0';
    assert.deepEqual(E4.live(db), off, "'0' is off");
    process.env.GRIDIRON_E4_LIVE = '1';
    const on = E4.live(db);
    assert.equal(on.needs_n, 5);
    assert.equal(on.detail.provisional, true);
    assert.match(on.needs_text, /^early number, not a grade: over 3 graded weeks/);
  } finally {
    if (prev === undefined) delete process.env.GRIDIRON_E4_LIVE; else process.env.GRIDIRON_E4_LIVE = prev;
  }
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

test('frozen 2023-24 result: planner minus best baseline straddles 0 -> not_enough_data, never an empty pass', () => {
  const r = E4.historical();
  assert.equal(r.status, STATUS.NOT_ENOUGH_DATA);
  assert.equal(r.n, E4.HISTORICAL.title.n);
  assert.ok(r.ci_low < 0 && r.ci_high > 0);
  assert.equal(r.detail.best_baseline, undefined, 'detail keeps the full summary per target');
  assert.equal(r.detail.title.best_baseline, 'finder');
});
