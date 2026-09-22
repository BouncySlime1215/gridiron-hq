/**
 * The standing start/sit gate (plan item C12, unit C-01): start by OUR weekly
 * projection vs the dumb rule "start the higher season-to-date average", on
 * same-week, same-position pairs both rules call startable, graded on what the
 * two picks actually scored. Pre-registration:
 * docs/evidence/2026-09-22/start-sit-baseline-gate-prereg.md.
 *
 * The replay itself (weekly-backtest.js#replaySeasonWeekly) is mocked here so
 * the CALL is pinned: configuration B (roleRecency: WEEKLY_ROLE_RECENCY passed
 * explicitly, kOverride omitted, no distributions), the pre-registered windows,
 * and the k control running before any replay. The real replay is exercised by
 * the evidence run, not by this file.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-start-sit-gate-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

// The replay is a spy: it records every call and serves fixture decision rows.
const replayCalls = [];
let fixtureRows = {};
mock.module('../server/services/weekly-backtest.js', {
  namedExports: {
    replaySeasonWeekly: (season, opts) => {
      replayCalls.push({ season, opts });
      const rows = (fixtureRows[season] ?? []).filter(r => r.week >= opts.startWeek && r.week <= opts.endWeek);
      return { season, _decision_rows: rows };
    }
  }
});

const S = await import('../server/services/gates/start-sit-gate.js').catch(error => ({ __importError: error }));
const { WEEKLY_ROLE_RECENCY, WEEKLY_ENSEMBLE_WEIGHTS, weeklyEnsemblePrediction } =
  await import('../server/services/weekly-ensemble.js');
const { startSitPairAccuracy } = await import('../scripts/promote-early-week-weights.mjs');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** One gate input row: our projection, the season average, what he scored. */
const r = (season, week, position, playerId, policy, baseline, actual) =>
  ({ season, week, position, player_id: playerId, policy, baseline, actual });

test('the start/sit gate module loads', () => {
  assert.ifError(S.__importError);
  assert.equal(typeof S.startSitDecisions, 'function');
  assert.equal(typeof S.runStartSitGate, 'function');
});

test('pairs are same season, week and position, with both players startable by both rules', () => {
  const rows = [
    r(2025, 5, 'WR', 1, 14, 9, 20), r(2025, 5, 'WR', 2, 12, 13, 8),    // a WR pair
    r(2025, 5, 'WR', 3, 7.9, 12, 30),                                   // ours says 7.9: not startable
    r(2025, 5, 'RB', 4, 15, 10, 5),                                     // a different position
    r(2025, 6, 'WR', 5, 13, 11, 11),                                    // a different week
    r(2024, 5, 'WR', 6, 16, 8.5, 2),                                    // a different season
    r(2025, 5, 'WR', 7, 15, 7.9, 12),                                   // the average says 7.9: not startable
  ];
  const out = S.startSitDecisions(rows);
  assert.equal(out.pairs, 1);
  assert.equal(out.disagreements.length, 1);
  assert.equal(S.STARTABLE_PPR, 8);
});

test('our pick is the higher of our projections, the dumb pick the higher average, points ours minus theirs', () => {
  const out = S.startSitDecisions([r(2025, 5, 'WR', 1, 14, 9, 20), r(2025, 5, 'WR', 2, 12, 13, 8)]);
  const [dz] = out.disagreements;
  assert.equal(dz.policy_id, 1);
  assert.equal(dz.baseline_id, 2);
  assert.equal(dz.policy_points, 20);
  assert.equal(dz.baseline_points, 8);
  assert.equal(dz.season, 2025);
  assert.equal(dz.week, 5);
  assert.equal(dz.position, 'WR');
});

test('a projection tie by either rule is not a disagreement', () => {
  const tieOurs = S.startSitDecisions([r(2025, 5, 'TE', 1, 12, 9, 20), r(2025, 5, 'TE', 2, 12, 13, 8)]);
  const tieDumb = S.startSitDecisions([r(2025, 5, 'TE', 1, 14, 11, 20), r(2025, 5, 'TE', 2, 12, 11, 8)]);
  const agree = S.startSitDecisions([r(2025, 5, 'TE', 1, 14, 13, 20), r(2025, 5, 'TE', 2, 12, 11, 8)]);
  for (const out of [tieOurs, tieDumb, agree]) {
    assert.equal(out.pairs, 1);
    assert.equal(out.disagreements.length, 0);
  }
  assert.equal(agree.agreement_share, 1);
});

/** One season of rows with no projection ties, so accuracy and wins must reconcile. */
function seasonRows() {
  const rows = [];
  let id = 1;
  for (const week of [5, 6, 7]) {
    for (const position of ['QB', 'WR']) {
      for (let k = 0; k < 6; k++) {
        const policy = 8.3 + ((id * 37) % 97) / 7;
        const baseline = 8.1 + ((id * 53) % 89) / 6;
        const actual = ((id * 29) % 31) + (k === 2 ? 0 : 0.5);
        rows.push(r(2025, week, position, id++, +policy.toFixed(3), +baseline.toFixed(3), actual));
      }
    }
  }
  return rows;
}

test("pair accuracy is startSitPairAccuracy's, on the same pairs (one definition, two call sites)", () => {
  // Plus projection ties on each side, which both definitions score as half.
  const rows = [...seasonRows(), r(2025, 8, 'TE', 900, 11, 9, 14), r(2025, 8, 'TE', 901, 11, 12, 6),
    r(2025, 8, 'TE', 902, 13, 12, 9)];
  const out = S.startSitDecisions(rows);
  const theirs = startSitPairAccuracy(
    rows.map(x => ({ week: x.week, position: x.position, preds: { policy: x.policy, baseline: x.baseline }, actual: x.actual })),
    ['policy', 'baseline'], { threshold: S.STARTABLE_PPR });
  assert.equal(out.pairs, theirs.pairs);
  assert.ok(Math.abs(out.pair_accuracy.policy - theirs.accuracy.policy) < 1e-4, JSON.stringify({ out: out.pair_accuracy, theirs }));
  assert.ok(Math.abs(out.pair_accuracy.baseline - theirs.accuracy.baseline) < 1e-4);
});

test('with no projection ties, the accuracy gap is the disagreements\' net wins over all pairs', () => {
  const out = S.startSitDecisions(seasonRows());
  const net = out.disagreements.reduce((s, x) => s + (x.policy_points > x.baseline_points ? 1
    : x.policy_points === x.baseline_points ? 0 : -1), 0);
  assert.ok(out.disagreements.length > 0);
  assert.ok(Math.abs((out.pair_accuracy.policy - out.pair_accuracy.baseline) - net / out.pairs) < 1e-4);
});

test('a player whose team does not play in week W is a bye and leaves the pool; an injury zero stays', () => {
  const rows = [r(2025, 6, 'WR', 1, 14, 9, 0), r(2025, 6, 'WR', 2, 12, 13, 0), r(2025, 6, 'WR', 3, 12, 13, 9)];
  const usage = [
    { player_id: 1, week: 5, team: 'AAA' }, { player_id: 2, week: 5, team: 'BBB' },
    { player_id: 3, week: 5, team: 'CCC' },
    { player_id: 3, week: 6, team: 'CCC' },                   // CCC plays week 6
    { player_id: 9, week: 6, team: 'AAA' },                   // AAA plays week 6 (player 1 did not: injury)
  ];                                                          // BBB has no week-6 row: bye
  const out = S.removeByes(rows, usage);
  assert.deepEqual(out.kept.map(x => x.player_id), [1, 3]);
  assert.deepEqual(out.removed.map(x => x.player_id), [2]);
});

test('the k control stops at the hardcoded K.share = 6, and when no fitted k resolves', () => {
  assert.throws(() => S.kControl([2026], () => ({ target_share: { ALL: 6 } })), /K\.share = 6/);
  assert.throws(() => S.kControl([2026], () => null), /K\.share = 6/);
  assert.throws(() => S.kControl([2026], () => ({ carry_share: { RB: 0.07 } })), /K\.share = 6/);
  assert.deepEqual(S.kControl([2025, 2026], s => ({ target_share: { ALL: s === 2025 ? 0.21 : 0.1733 } })),
    [{ season: 2025, target_share_k: 0.21 }, { season: 2026, target_share_k: 0.1733 }]);
});

test("HARDCODED_K_SHARE is the constant projections.js actually falls back to", () => {
  const src = fs.readFileSync(new URL('../server/services/projections.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const K = {'), src.indexOf('};', src.indexOf('const K = {')));
  const m = block.match(/share:\s*([\d.]+)/);
  assert.ok(m, 'K.share not found in projections.js');
  assert.equal(S.HARDCODED_K_SHARE, Number(m[1]));
});

test("the default k resolver is configuration B's: an empty fit table stops the gate, a live fit passes it", () => {
  assert.throws(() => S.kControl([2026]), /K\.share = 6/);
  run(`INSERT INTO shrinkage_fits (id, fitted_at, through_season, test_season, active, note)
       VALUES (1, '2026-09-18T00:00:00Z', 2025, 2025, 1, 'fixture')`);
  run(`INSERT INTO shrinkage_k (fit_id, metric, position, k) VALUES (1, 'target_share', 'ALL', 0.1733)`);
  assert.deepEqual(S.kControl([2026]), [{ season: 2026, target_share_k: 0.1733 }]);
  // Cutoff-safe: the stored fit is through 2025, so a 2025 replay must NOT read it; it
  // re-fits on seasons <= 2024, and this database has no rows to re-fit on.
  assert.throws(() => S.kControl([2025]), /K\.share = 6/);
});

test('the prediction head is the as-of champion for the week it predicts, read once per week', () => {
  const asked = [];
  const weights = { QB: [0, 1, 0, 0, 0], RB: [1, 0, 0, 0, 0], WR: [0.5, 0.5, 0, 0, 0], TE: [0, 0, 1, 0, 0] };
  const head = S.asOfChampionHead(2025, { weightSetFor: q => { asked.push(q); return { id: `fit-w${q.week}`, weights }; } });
  const ctx = { structural: 10, season_to_date: 14, last3: 12, last1: 9, median: 11, position: 'WR', week: 7, prior_weeks: 6 };
  assert.equal(head(ctx), weeklyEnsemblePrediction(ctx, weights));
  head({ ...ctx, structural: 20 });
  head({ ...ctx, week: 8 });
  assert.deepEqual(asked, [{ season: 2025, week: 7 }, { season: 2025, week: 8 }]);
  assert.deepEqual(head.champions(), { 7: 'fit-w7', 8: 'fit-w8' });
});

test('the default champion is what production resolves for that week (frozen weights on an empty fit table)', () => {
  const head = S.asOfChampionHead(2025);
  const ctx = { structural: 10, season_to_date: 14, last3: 12, last1: 9, median: 11, position: 'RB', week: 7, prior_weeks: 6 };
  assert.equal(head(ctx), weeklyEnsemblePrediction(ctx, WEEKLY_ENSEMBLE_WEIGHTS));
  assert.deepEqual(head.champions(), { 7: 'frozen-2023' });
});

/* ------------------------------------------------------------------ the run */

const usageRow = (playerId, season, week, team, position = 'WR') =>
  run(`INSERT OR IGNORE INTO player_week_usage (player_id, season, week, team, position) VALUES (?,?,?,?,?)`,
    playerId, season, week, team, position);

/** The default fixture's actual scores for players 1-8, before the week offset. */
const ACTUALS = [22, 3, 15, 9, 12, 12, 7, 19];
const defaultActual = (id, week) => ACTUALS[id - 1] + week;

/**
 * Players 1-8, WR, two teams; BBB is on a bye in 2025 week 6.
 * `actual(id, week, season)` overrides what each player scored.
 */
function seedFixture({ actual = defaultActual } = {}) {
  for (let id = 1; id <= 8; id++) run(`INSERT OR IGNORE INTO players (id, name, position) VALUES (?, ?, 'WR')`, id, `Fixture ${id}`);
  run(`INSERT OR IGNORE INTO players (id, name, position) VALUES (90, 'Filler A', 'WR'), (91, 'Filler B', 'WR')`);
  const team = id => (id <= 4 ? 'AAA' : 'BBB');
  for (const season of [2024, 2025]) {
    for (let week = 1; week <= 18; week++) {
      usageRow(90, season, week, 'AAA');
      if (!(season === 2025 && week === 6)) usageRow(91, season, week, 'BBB');
    }
    for (let id = 1; id <= 8; id++) for (const week of [4, 5]) usageRow(id, season, week, team(id));
  }
  for (const week of [1, 2]) { usageRow(90, 2026, week, 'AAA'); usageRow(91, 2026, week, 'BBB'); }
  for (let id = 1; id <= 8; id++) usageRow(id, 2026, 1, team(id));

  const rowsFor = (season, week) => Array.from({ length: 8 }, (_, i) => {
    const id = i + 1;
    // Ours prefers the higher id, the average the lower id: they disagree on EVERY pair.
    // The default actuals follow neither exactly.
    return { player_id: id, week, position: 'WR', prediction: 9 + id, season_to_date: 18 - id,
      actual: actual(id, week, season), played: true };
  });
  fixtureRows = {
    2024: [...rowsFor(2024, 5), ...rowsFor(2024, 6)],
    2025: [...rowsFor(2025, 5), ...rowsFor(2025, 6)],
    2026: rowsFor(2026, 2),
  };
}

test('the replay runs in configuration B over the pre-registered windows', () => {
  seedFixture();
  replayCalls.length = 0;
  const result = S.runStartSitGate({ iterations: 200, resolveK: () => ({ target_share: { ALL: 0.2 } }) });
  assert.deepEqual(replayCalls.map(c => [c.season, c.opts.startWeek, c.opts.endWeek]),
    [[2024, 5, 18], [2025, 5, 18], [2026, 2, 2]]);
  for (const { opts } of replayCalls) {
    assert.equal(opts.roleRecency, WEEKLY_ROLE_RECENCY, 'roleRecency must be the WEEKLY_ROLE_RECENCY object itself');
    assert.ok(!('kOverride' in opts), 'kOverride must be omitted so the fitted k resolves');
    assert.equal(opts.distributions, false);
    assert.equal(typeof opts.predictionHead, 'function');
  }
  assert.deepEqual(result.configuration.role_recency, { seasonDecay: 0.05, weekHalfLife: 5 });
  assert.equal(result.configuration.k_override, 'omitted');
  assert.deepEqual(result.configuration.k_control.map(k => k.season), [2024, 2025, 2026]);
});

test('the k control runs before any replay and stops the whole run', () => {
  seedFixture();
  replayCalls.length = 0;
  assert.throws(() => S.runStartSitGate({ iterations: 200, resolveK: () => ({ target_share: { ALL: 6 } }) }), /K\.share = 6/);
  assert.equal(replayCalls.length, 0);
});

test('bye rows never reach the pairs: BBB on a bye in 2025 week 6 drops players 5-8 that week', () => {
  seedFixture();
  const result = S.runStartSitGate({ iterations: 200, resolveK: () => ({ target_share: { ALL: 0.2 } }) });
  assert.equal(result.past.per_season[2025].bye_rows_removed, 4);
  assert.equal(result.past.per_season[2024].bye_rows_removed, 0);
  // 2025: week 5 has 8 startable WRs (28 pairs), week 6 has 4 (6 pairs).
  assert.equal(result.past.per_season[2025].pairs, 34);
  assert.equal(result.past.per_season[2024].pairs, 56);
});

test('the oracle control wins every disagreement it has and the identity control has none', () => {
  seedFixture();
  const result = S.runStartSitGate({ iterations: 200, resolveK: () => ({ target_share: { ALL: 0.2 } }) });
  assert.ok(result.controls.oracle.n > 0);
  assert.equal(result.controls.oracle.win_rate, 1);
  assert.ok(result.controls.oracle.points_per_decision > 0);
  assert.equal(result.controls.identity.n, 0);
  assert.equal(result.controls.passed, true);
  assert.notEqual(result.verdict, 'instrument_fault');
});

test('an instrument whose known-nonzero control finds nothing says so instead of grading', () => {
  seedFixture();
  for (const s of Object.keys(fixtureRows)) fixtureRows[s] = fixtureRows[s].map(x => ({ ...x, actual: 10 }));
  const result = S.runStartSitGate({ iterations: 200, resolveK: () => ({ target_share: { ALL: 0.2 } }) });
  assert.equal(result.controls.passed, false);
  assert.equal(result.verdict, 'instrument_fault');
});

test('the result names its windows, both rules, the universe, the scoring and the sign convention', () => {
  seedFixture();
  const result = S.runStartSitGate({ iterations: 200, resolveK: () => ({ target_share: { ALL: 0.2 } }) });
  assert.deepEqual(result.past.seasons, [2024, 2025]);
  assert.deepEqual(result.past.weeks, [5, 18]);
  assert.equal(result.forward.season, 2026);
  assert.deepEqual(result.forward.weeks, [2, 2]);
  assert.equal(result.past.n, result.past.per_season[2024].n + result.past.per_season[2025].n);
  assert.match(result.baseline, /season-to-date/i);
  assert.match(result.policy, /projection/i);
  assert.match(result.universe, /8\.0/);
  assert.equal(result.scoring, 'PPR');
  assert.match(result.sign_convention, /positive favours our/i);
  assert.ok(Array.isArray(result.gates) && result.gates.length === 4);
  assert.ok(typeof result.verdict === 'string');
  assert.equal(result.configuration.champions[2025][5], 'frozen-2023', 'the champion per graded week is recorded');
  assert.equal(result.configuration.champions[2026][2], 'frozen-2023');
  // Addendum 1 §1: the replay is today's configuration, not the number served at the time.
  assert.doesNotMatch(result.policy, /would have served/i);
  assert.match(result.forward.label, /replay/i);
  assert.match(result.forward.label, /not the projection the app served/i);
});

/* ------------------------------------------------------- the grade's values */

const KNOWN_K = () => ({ target_share: { ALL: 0.2 } });

test('direction is the sign of points per decision, and says when there is nothing to sign', () => {
  assert.equal(S.directionOf({ n: 3, points_per_decision: 0.4 }), 'ours_ahead');
  assert.equal(S.directionOf({ n: 3, points_per_decision: -0.4 }), 'dumb_ahead');
  assert.equal(S.directionOf({ n: 3, points_per_decision: 0 }), 'even');
  assert.equal(S.directionOf({ n: 0, points_per_decision: null }), 'no_disagreements');
  assert.equal(S.directionOf({ status: 'not_available', reason: 'no rows' }), 'not_available');
  assert.equal(S.directionOf(null), 'not_available');
});

test('the default fixture grades to the hand-counted values: ours loses, so a swapped rule would flip the sign', () => {
  // Counted by hand, not by the code: ours starts the higher id, the average the lower
  // id, so every pair is a disagreement. An 8-player week: 28 disagreements, points
  // (ours minus theirs) summing to -7, 13.5 wins (players 5 and 6 tie). The 4-player
  // week (2025 W6, BBB on a bye): 6 disagreements, sum -27, 2 wins. Past = three
  // 8-player weeks and one 4-player week: n 90, points -48 / 90, wins 42.5 / 90.
  seedFixture();
  const result = S.runStartSitGate({ iterations: 200, resolveK: KNOWN_K });
  assert.equal(result.past.n, 90);
  assert.equal(result.past.per_season[2024].n, 56);
  assert.equal(result.past.per_season[2025].n, 34);
  assert.equal(result.past.points_per_decision, -0.5333);
  assert.equal(result.past.win_rate, 0.4722);
  assert.equal(result.past.direction, 'dumb_ahead');
  assert.equal(result.forward.n, 28);
  assert.equal(result.forward.points_per_decision, -0.25);
  assert.equal(result.forward.win_rate, 0.4821);
  assert.equal(result.forward.direction, 'dumb_ahead');
  assert.notEqual(result.verdict, 'beats_dumb');
});

test('when our projection orders the actuals right, every call is won and the verdict is beats_dumb', () => {
  // Actual = 2 x id + 1: the higher id always scores more. Points per disagreement =
  // (3 weeks x 168 + 20) / 90 = 5.8222.
  seedFixture({ actual: id => 2 * id + 1 });
  const result = S.runStartSitGate({ iterations: 200, resolveK: KNOWN_K });
  assert.equal(result.past.n, 90);
  assert.equal(result.past.win_rate, 1);
  assert.equal(result.past.points_per_decision, 5.8222);
  assert.equal(result.past.direction, 'ours_ahead');
  assert.deepEqual(result.gates.map(g => g.passed), [true, true, true, true]);
  assert.equal(result.verdict, 'beats_dumb');
});

test('G4 reads the forward rows: a forward season against our projection leaves the verdict unconfirmed', () => {
  // Past as above (every call won); 2026 week 2 reversed (actual = 40 - 2 x id), so
  // our pick loses every forward disagreement by 2 x (id gap): -168 / 28 = -6.
  seedFixture({ actual: (id, week, season) => (season === 2026 ? 40 - 2 * id : 2 * id + 1) });
  const result = S.runStartSitGate({ iterations: 200, resolveK: KNOWN_K });
  assert.equal(result.past.win_rate, 1);
  assert.equal(result.forward.n, 28);
  assert.equal(result.forward.win_rate, 0);
  assert.equal(result.forward.points_per_decision, -6);
  assert.equal(result.gates[3].id, 'G4');
  assert.equal(result.gates[3].value, -6);
  assert.equal(result.gates[3].passed, false);
  assert.equal(result.verdict, 'beats_dumb_unconfirmed_forward');
});

/* ------------------------------ what the app served, and the literal dumb rule */

const SERVED_AS_OF = '2026-09-17T18:56:10.819Z';
/** Our served week-2 projection (weekly-learning.js#captureWeeklyPredictions's table). */
function seedServed(predictions) {
  run('DELETE FROM weekly_prediction_snapshots WHERE season = 2026');
  for (const [id, prediction] of Object.entries(predictions)) {
    run(`INSERT INTO weekly_prediction_snapshots (season, week, player_id, position, as_of, cutoff, engine_version,
         structural, prediction, weight_fit, mode)
         VALUES (2026, 2, ?, 'WR', ?, '2026-W1', 'fixture', ?, ?, 'frozen-2023', 'position_ensemble')`,
    Number(id), SERVED_AS_OF, prediction, prediction);
  }
}
/** ESPN's week-2 projection per league (collect-roster-snapshots.mjs#writePeriod's table). */
function seedEspn(rowsToWrite) {
  run('DELETE FROM league_roster_snapshots WHERE season = 2026');
  for (const { league, id, projected, source = 'final' } of rowsToWrite) {
    run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id, player_id,
         position, lineup_slot_id, is_starter, projected_points, source, first_seen_at, changed_at)
         VALUES (?, 2026, 2, 1, ?, ?, 'WR', 20, 0, ?, ?, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z')`,
    league, 1000 + id, id, projected, source);
  }
}
/** Players 1-8's served projections: ours still prefers the higher id among 1-4, the lower among 5-8. */
const SERVED = { 1: 10, 2: 11, 3: 12, 4: 13, 5: 25, 6: 24, 7: 23, 8: 22 };
const ESPN_ROWS = [
  // Players 1-3 carried by two leagues with the same value: one value.
  ...[[1, 10.5], [2, 14], [3, 13.5]].flatMap(([id, projected]) => [{ league: 1, id, projected }, { league: 2, id, projected }]),
  { league: 1, id: 4, projected: 7.5 },          // below 8.0: not startable by ESPN
  { league: 1, id: 5, projected: 13 }, { league: 1, id: 6, projected: 12.5 }, { league: 1, id: 7, projected: 12 },
  { league: 1, id: 8, projected: 15 }, { league: 2, id: 8, projected: 15.5 },   // the leagues disagree: excluded
  { league: 3, id: 2, projected: 30, source: 'live' },                          // a live row is never read
];

test('what the app served is graded against the average on the replay rows, with only the projection swapped', () => {
  seedFixture();
  seedServed(SERVED);
  seedEspn(ESPN_ROWS);
  const result = S.runStartSitGate({ iterations: 200, resolveK: KNOWN_K });
  const served = result.forward.served;
  // Hand count, 2026 week 2 (actual = the default + 2; the offset cancels): of 28 pairs
  // ours (served) and the average agree on the 6 pairs inside players 5-8. Inside 1-4:
  // 6 disagreements, sum -27, 2 wins; across (ours takes 5-8, the average 1-4): 16,
  // sum +4, 8 wins. n 22, points -23 / 22, wins 10 / 22.
  assert.equal(served.vs_average.rows, 8);
  assert.equal(served.vs_average.excluded.no_snapshot, 0);
  assert.equal(served.vs_average.pairs, 28);
  assert.equal(served.vs_average.n, 22);
  assert.equal(served.vs_average.points_per_decision, -1.0455);
  assert.equal(served.vs_average.win_rate, 0.4545);
  assert.equal(served.vs_average.direction, 'dumb_ahead');
  assert.equal(result.forward.n, 28, 'the replay grade itself is unchanged by the served arm');
  assert.deepEqual(served.weeks, [{ week: 2, captured_at: SERVED_AS_OF, weight_fit: ['frozen-2023'],
    replay_champion: 'frozen-2023', same_weights: true, k_fit_id: 1, k_fitted_at: '2026-09-18T00:00:00Z',
    served_before_k_fit: true }]);
  assert.match(served.label, /served/i);
});

test("the literal rule: what the app served against ESPN's projection, one value per player-week, final rows only", () => {
  seedFixture();
  seedServed(SERVED);
  seedEspn(ESPN_ROWS);
  const result = S.runStartSitGate({ iterations: 200, resolveK: KNOWN_K });
  const espn = result.forward.served.vs_espn;
  // Hand count: player 8 is dropped (two leagues, two values), player 4 is below 8.0
  // by ESPN, so players 1, 2, 3, 5, 6, 7 make 15 pairs. They disagree on 7:
  // (2,3) +12, (2,5) +9, (2,6) +9, (2,7) +4, (3,5) -3, (3,6) -3, (3,7) -8.
  // n 7, points +20 / 7, wins 4 / 7. Had the live row been read, player 2 would be
  // dropped as conflicting and the count would differ.
  assert.equal(espn.excluded.espn_conflicting_player_weeks, 1);
  assert.equal(espn.excluded.no_espn, 1);
  assert.equal(espn.excluded.no_snapshot, 0);
  assert.equal(espn.rows, 7);
  assert.equal(espn.pairs, 15);
  assert.equal(espn.n, 7);
  assert.equal(espn.points_per_decision, 2.8571);
  assert.equal(espn.win_rate, 0.5714);
  assert.equal(espn.direction, 'ours_ahead');
  assert.match(espn.baseline, /ESPN/);
});

test('the served arms never move the verdict or the gates (addendum 1: descriptive only)', () => {
  seedFixture({ actual: id => 2 * id + 1 });
  seedServed({});
  seedEspn([]);
  const without = S.runStartSitGate({ iterations: 200, resolveK: KNOWN_K });
  assert.equal(without.forward.served.vs_average.status, 'not_available');
  assert.match(without.forward.served.vs_average.reason, /weekly_prediction_snapshots/);
  assert.equal(without.forward.served.vs_average.direction, 'not_available');
  assert.equal(without.forward.served.vs_espn.status, 'not_available');
  // Served projections that reverse the replay's order, and an ESPN rule that agrees with the actuals.
  seedServed({ 1: 22, 2: 21, 3: 20, 4: 19, 5: 18, 6: 17, 7: 16, 8: 15 });
  seedEspn([1, 2, 3, 4, 5, 6, 7, 8].map(id => ({ league: 1, id, projected: 8 + id })));
  const withServed = S.runStartSitGate({ iterations: 200, resolveK: KNOWN_K });
  assert.equal(withServed.forward.served.vs_espn.direction, 'dumb_ahead');
  assert.deepEqual(withServed.gates, without.gates);
  assert.equal(withServed.verdict, without.verdict);
  seedServed({});
  seedEspn([]);
});

test('with no rows for a season later than the past window, the forward window is not available, not zero', () => {
  run('DELETE FROM player_week_usage WHERE season = 2026');
  seedFixtureWithout2026();
  replayCalls.length = 0;
  const result = S.runStartSitGate({ iterations: 200, resolveK: () => ({ target_share: { ALL: 0.2 } }) });
  assert.equal(result.forward.status, 'not_available');
  assert.deepEqual(replayCalls.map(c => c.season), [2024, 2025]);
});

function seedFixtureWithout2026() {
  seedFixture();
  run('DELETE FROM player_week_usage WHERE season = 2026');
  delete fixtureRows[2026];
}
