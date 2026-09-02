import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Accuracy and calibration by slice, with 2021 quarantined and every slice
// carrying its sample and a read-floor flag.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-slices-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');
await import('../server/services/nfl-expert-council.js');
const { sliceDiagnostic, MIN_SLICE_SAMPLE } = await import('../server/services/nfl-slice-diagnostic.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

function seed(season, week, home, { spread, div = 0, roof = 'outdoors', experts }) {
  run(`INSERT OR IGNORE INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,div_game,roof,team_score,opp_score)
       VALUES (?,?,?,?,1,?,44,22,'test',datetime('now'),?,?,24,20)`, season, week, home, 'OPP', spread, div, roof);
  for (const [id, observed, forecast, uncertainty, correct] of experts) {
    run(`INSERT INTO nfl_weekly_expert_examples
      (audit_run_id,season,week,home,away,expert_id,council_version,engine_version,evidence_hash,evidence_cutoff,
       observed,forecast_residual,uncertainty,actual_residual,directional_correct,squared_error,authority,missing_reason,payload_json,created_at)
      VALUES (1,?,?,?,'OPP',?,'v','e','h','c',?,?,?,3,?,?,'research_only',?,'{}',datetime('now'))`,
    season, week, home, id, observed ? 1 : 0, forecast, uncertainty, correct == null ? null : (correct ? 1 : 0),
    forecast == null ? null : (forecast - 3) ** 2, observed ? null : 'evidence unavailable');
  }
}

test('nothing recorded reports unavailable rather than empty slices', () => {
  assert.equal(sliceDiagnostic().available, false);
});

test('slices are cut by season, matchup type, specialist, confidence and coverage, with 2021 quarantined', () => {
  // 2021: quarantined rows that would otherwise look perfect.
  for (let i = 0; i < 5; i++) seed(2021, 5 + i, `Q${i}`, { spread: -3, experts: [['coordinator', 1, 2, 4, true], ['rulebook', 1, 2, 4, true]] });
  // 2023: a divisional pick'em and a big non-divisional favourite, with mixed coverage.
  for (let i = 0; i < 4; i++) seed(2023, 5 + i, `D${i}`, { spread: -2.5, div: 1, roof: 'dome',
    experts: [['coordinator', 1, 1.5, 3, i % 2 === 0], ['rulebook', 1, 2, 4, true], ['line_movement', 0, null, null, null]] });
  for (let i = 0; i < 2; i++) seed(2023, 10 + i, `B${i}`, { spread: -9.5, div: 0,
    experts: [['coordinator', 1, 4, 3, true], ['rulebook', 1, 2, 4, false]] });
  const out = sliceDiagnostic();
  assert.equal(out.available, true);
  assert.equal(out.quarantine.rows_excluded, 10, 'the 2021 rows are excluded by default');
  assert.deepEqual(out.by_season.map(s => s.key), [2023]);
  assert.equal(out.market.spread.directional_calls, 6);
  assert.equal(out.market.spread.directional_rate, r(4 / 6));
  assert.equal(out.market.spread.readable, false, 'six calls is under the read floor');
  const divisional = out.by_matchup_type.find(s => s.key === 'divisional·pickem_to_3');
  assert.equal(divisional.directional_calls, 4);
  assert.equal(divisional.directional_rate, 0.5);
  const big = out.by_matchup_type.find(s => s.key === 'non_divisional·big_over_7');
  assert.equal(big.directional_rate, 1);
  assert.ok(out.by_roof.find(s => s.key === 'indoor').rows === 4);
  const rulebook = out.by_specialist.find(s => s.id === 'rulebook');
  assert.equal(rulebook.directional_calls, 6);
  assert.equal(rulebook.directional_rate, r(4 / 6));
  const movement = out.by_specialist.find(s => s.id === 'line_movement');
  assert.equal(movement.observed, 0);
  assert.equal(movement.rows, 4);
  assert.ok(out.by_confidence_bucket.find(s => s.key === 'z_0.5_to_1'), 'the pickem coordinator calls sit at z=0.5');
  assert.ok(out.by_confidence_bucket.find(s => s.key === 'z_over_1'), 'the big-favourite calls sit above z=1');
  assert.ok(out.by_coverage_bucket.every(s => s.key === 'coverage_7_or_fewer'));
  assert.equal(out.coordinator_calibration.n, 6);
  assert.ok(out.coordinator_calibration.buckets.every(b => b.readable === false));
  assert.equal(out.read_floor, MIN_SLICE_SAMPLE);
  const withQuarantine = sliceDiagnostic({ includeQuarantined: true });
  assert.deepEqual(withQuarantine.by_season.map(s => s.key), [2021, 2023]);
});

const r = value => +value.toFixed(4);
