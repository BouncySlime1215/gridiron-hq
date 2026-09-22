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
  const rows = seasonRows();
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

/** Players 1-8, WR, two teams; BBB is on a bye in 2025 week 6. */
function seedFixture() {
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
    // Ours and the average disagree on every adjacent pair; actuals follow neither exactly.
    return { player_id: id, week, position: 'WR', prediction: 9 + id, season_to_date: 18 - id,
      actual: [22, 3, 15, 9, 12, 12, 7, 19][i] + week, played: true };
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
