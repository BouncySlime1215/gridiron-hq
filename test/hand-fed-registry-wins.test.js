/**
 * S-18: one rule per hand-fed table. When source-registry.js exports
 * `servedTables()` with an entry for a table (PRs #96 / #104), THAT entry is the
 * rule every reader uses, and data-freshness.js's HAND_FED_ENTRIES copy is only
 * the fallback. Feature detection is the kind of code that silently never fires,
 * so the registry is mocked here with rules that DIFFER from the fallback on the
 * same rows, and each verdict is paired with the fallback's opposite verdict as
 * the known-nonzero control: the test can tell which rule answered.
 *
 * `mock.module` takes `namedExports`, NOT `exports` (see
 * test/data-freshness-evaluator-delegation.test.js).
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-hand-fed-registry-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const realRegistry = await import('../server/services/source-registry.js');

// Registry rules chosen to disagree with the fallback on the rows inserted below.
const REGISTRY = [
  { table: 'league_roster_snapshots', season_col: 'season', week_col: null, updated_col: null, grain: 'week',
    current_rule: { text: 'registry: a this-season snapshot of a player still on a roster',
      sql: 'SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS current FROM league_roster_snapshots WHERE season = ? AND on_roster = 1',
      params: ['season'] } },
  { table: 'correlation_estimates', season_col: null, week_col: null, updated_col: 'fitted_at', grain: 'fit',
    current_rule: { text: 'registry: a dated estimate on at least 1000 pairs',
      sql: 'SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS current FROM correlation_estimates WHERE fitted_at IS NOT NULL AND pairs >= 1000',
      params: [] } },
];
mock.module('../server/services/source-registry.js', {
  namedExports: { ...realRegistry, servedTables: () => REGISTRY }
});

const freshness = await import('../server/services/data-freshness.js');
const correlation = await import('../server/services/correlation.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const fallback = table => freshness.HAND_FED_ENTRIES.find(e => e.table === table);

test('the registry entry is the rule when it exports one; the fallback answers only for a table it lacks', () => {
  assert.equal(freshness.servedTableEntry('league_roster_snapshots'), REGISTRY[0]);
  assert.equal(freshness.servedTableEntry('correlation_estimates'), REGISTRY[1]);
  assert.equal(freshness.servedTableEntry('trending_players'), fallback('trending_players'),
    'no registry entry for trending: the fallback is the one entry');
});

test('roster history follows the registry rule, not the fallback, on the same row', () => {
  run(`INSERT INTO league_roster_snapshots
       (league_id, season, scoring_period_id, team_id, espn_player_id, player_name, lineup_slot_id,
        is_starter, on_roster, source, first_seen_at, changed_at)
       VALUES (80, 2026, 1, 1, 1, 'Dropped Player', 20, 0, 0, 'live', '2026-09-20', '2026-09-20')`);
  const ctx = { currentSeason: 2026, currentWeek: 3 };
  assert.equal(freshness.tableFreshness(fallback('league_roster_snapshots'), ctx).status, 'fresh',
    'control: the fallback calls this row current, so a verdict of stale can only come from the registry');
  assert.equal(freshness.servedTableState('league_roster_snapshots', ctx).state, 'stale');
});

test('the correlation reader follows the registry rule, not the fallback, on the same row', () => {
  run(`INSERT INTO correlation_estimates (key, correlation, pairs, fitted_at) VALUES ('QB|WR|team', 0.18, 10, datetime('now'))`);
  assert.equal(freshness.tableFreshness(fallback('correlation_estimates'), {}).status, 'fresh',
    'control: the fallback calls a dated estimate current');
  assert.equal(correlation.correlationBasis().state, 'stale', 'correlation.js reads the one entry, which is the registry');
});
