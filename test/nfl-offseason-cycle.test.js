/**
 * Phase 1 of the 2026-09-09 learning-pipeline plan: closes a confirmed real
 * ~6-month blackout in depth charts/injury reports that recurred at every
 * season boundary this project has data for. Root cause was structural --
 * the whole ingestion cycle only ran when a game had just finalized, and no
 * games finalize between the Super Bowl and next September.
 *
 * These tests cover the new logic this fix actually depends on: the
 * calendar-aware refresh cadence, and the coverage-health detector that
 * makes a future blackout impossible to miss silently. They do not exercise
 * `refreshNflOffseasonCycle`/`syncOffseasonData` end to end -- that function
 * makes real network calls to external nflverse sources, and this project's
 * own convention (see nfl-prospective-collection.test.js) is to test around
 * that boundary rather than mock a chain of external fetches.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-offseason-cycle-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { offseasonRefreshIntervalHours, offseasonCoverageHealth, rookieEvidenceCoverage } =
  await import('../server/services/nfl-offseason-cycle.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('refresh cadence is daily through the confirmed highest-churn window (late Aug cutdowns)', () => {
  assert.equal(offseasonRefreshIntervalHours(new Date('2026-08-25T00:00:00Z')), 24);
  assert.equal(offseasonRefreshIntervalHours(new Date('2026-09-05T00:00:00Z')), 24);
});

test('refresh cadence is every ~3 days around the draft and minicamps', () => {
  assert.equal(offseasonRefreshIntervalHours(new Date('2026-04-25T00:00:00Z')), 24 * 3);
  assert.equal(offseasonRefreshIntervalHours(new Date('2026-05-15T00:00:00Z')), 24 * 3);
});

test('refresh cadence is sparse in the dead period', () => {
  assert.equal(offseasonRefreshIntervalHours(new Date('2026-02-15T00:00:00Z')), 24 * 14);
  assert.equal(offseasonRefreshIntervalHours(new Date('2026-07-10T00:00:00Z')), 24 * 14);
});

test('coverage health detects a real, known-shape blackout month rather than missing it', () => {
  // One completed season (2022), with depth/injury coverage for the regular
  // season EXCEPT a deliberately missing month (November) -- the exact shape
  // of the real, confirmed gap this fix targets.
  db.exec(`INSERT INTO game_lines (season, week, team, opponent, home, spread, team_score, opp_score, source, fetched_at)
    VALUES (2022, 1, 'AAA', 'BBB', 1, -3, 20, 17, 'test', '2022-09-08T00:00:00Z')`);
  const months = ['2022-09-15', '2022-10-15', /* skip 2022-11 on purpose */ '2022-12-15', '2023-01-15'];
  months.forEach((day, week) => {
    db.prepare(`INSERT INTO nfl_depth (season, week, team, gsis_id, player_name, pos_abb, pos_rank, pos_slot, captured)
      VALUES (2022, ?, 'AAA', 'g1', 'Test Player', 'QB', 1, 'QB1', ?)`).run(week + 1, `${day}T00:00:00Z`);
    db.prepare(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status, practice_status, injury, modified_at)
      VALUES (2022, ?, 'g1', 'AAA', 'Test Player', 'QB', 'Questionable', 'Limited', 'knee', ?)`).run(week + 1, `${day}T00:00:00Z`);
  });
  const health = offseasonCoverageHealth();
  assert.equal(health.healthy, false, 'a real missing month must be caught, not silently pass as healthy');
  assert.ok(health.gaps.nfl_depth.includes('2022-11'), `expected 2022-11 in ${JSON.stringify(health.gaps.nfl_depth)}`);
  assert.ok(health.gaps.nfl_injuries.includes('2022-11'));
});

test('coverage health reports healthy when every in-season month has data', () => {
  db.exec(`DELETE FROM nfl_depth; DELETE FROM nfl_injuries; DELETE FROM game_lines;`);
  db.exec(`INSERT INTO game_lines (season, week, team, opponent, home, spread, team_score, opp_score, source, fetched_at)
    VALUES (2023, 1, 'AAA', 'BBB', 1, -3, 20, 17, 'test', '2023-09-08T00:00:00Z')`);
  ['2023-09-15', '2023-10-15', '2023-11-15', '2023-12-15', '2024-01-15', '2024-02-05'].forEach((day, week) => {
    db.prepare(`INSERT INTO nfl_depth (season, week, team, gsis_id, player_name, pos_abb, pos_rank, pos_slot, captured)
      VALUES (2023, ?, 'AAA', 'g1', 'Test Player', 'QB', 1, 'QB1', ?)`).run(week + 1, `${day}T00:00:00Z`);
    db.prepare(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status, practice_status, injury, modified_at)
      VALUES (2023, ?, 'g1', 'AAA', 'Test Player', 'QB', 'Questionable', 'Limited', 'knee', ?)`).run(week + 1, `${day}T00:00:00Z`);
  });
  const health = offseasonCoverageHealth();
  assert.equal(health.healthy, true, JSON.stringify(health.gaps));
});

test('rookieEvidenceCoverage reports real per-season player counts for the reconciliation check to compare', () => {
  db.exec(`DELETE FROM nfl_rookie_evidence;`);
  const insert = db.prepare(`INSERT INTO nfl_rookie_evidence
    (season, player_id, player_name, position, college, evidence_type, values_json, available_at, captured_at, source, source_ref, verification_state)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 10; i++) insert.run(2024, `p${i}`, `Player ${i}`, 'WR', 'State', 'draft', '{}', '2024-05-01T00:00:00Z', '2026-09-01T00:00:00Z', 'test', `ref${i}`, 'verified');
  for (let i = 0; i < 2; i++) insert.run(2025, `q${i}`, `Player ${i}`, 'WR', 'State', 'draft', '{}', '2025-05-01T00:00:00Z', '2026-09-01T00:00:00Z', 'test', `ref${i}`, 'verified');
  const coverage = rookieEvidenceCoverage();
  const y2024 = coverage.find(c => c.season === 2024), y2025 = coverage.find(c => c.season === 2025);
  assert.equal(y2024.players, 10);
  assert.equal(y2025.players, 2);
  assert.ok(y2025.players < y2024.players / 2, 'fixture must reproduce the shape of a real coverage gap: one season far below its neighbor');
});
