/**
 * `availability_basis` is a fact about the PROCESS; the screens were printing it
 * as a fact about the PLAYER (2026-09-19).
 *
 * `availabilityBasis()` says the fit tables are present and the role layer is in
 * use. It does not say that any particular player was priced by it:
 * `playerActiveProbability` reaches the fitted role cell only when that player
 * has a role cell to reach, and otherwise drops to the pooled rates and then to
 * the hand-set chain. So one process can price one player on the role layer and
 * the next on constants, while every screen reading the process basis labels
 * both as measured.
 *
 * `weeklyAvailability` already works this out per player and records it as
 * `source`. These tests pin that the asset carries it, so a screen has a
 * per-player fact to print instead of a per-process one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-availability-source-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';
process.env.NFL_WEEK = '2';

const { db, run, row } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { assetUniverse, tradeWeekContext } = await import('../server/services/trade-engine.js');
const { deriveFormat } = await import('../server/services/format.js');
const contingency = await import('../server/services/contingency.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const payload = { teams: [{ id: 1, name: 'Mine', roster: { entries: [] } }] };
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (71, 'espn', 'as-71', 2026, 'Source', '1', 10, 1, ?, '2026-09-18 01:00:00')`, JSON.stringify(payload));
const lg = () => row('SELECT * FROM leagues WHERE id = 71');
const universe = () => assetUniverse(lg(), deriveFormat(lg()).formatKey);

const { season, week } = tradeWeekContext(lg());

// Two skill players the weekly model covers, and a kicker it does not.
run(`INSERT INTO players (id, name, position, gsis_id) VALUES (8801, 'Reported Wr', 'WR', '00-8801')`);
run(`INSERT INTO players (id, name, position, gsis_id) VALUES (8802, 'Quiet Rb', 'RB', '00-8802')`);
run(`INSERT INTO players (id, name, position) VALUES (8803, 'Some Kicker', 'K')`);
run(`INSERT INTO nfl_injuries (season, week, gsis_id, report_status, practice_status)
     VALUES (?, ?, '00-8801', 'Questionable', 'Limited')`, season, week);

test('the asset records which model priced that player', () => {
  const asset = universe().get(8801);
  assert.ok(asset, 'the reported player is in the universe');
  assert.equal(asset.availability_source, contingency.weeklyAvailability(season, week).get(8801)?.source,
    'the asset carries the per-player record weeklyAvailability already computes');
  assert.ok(asset.availability_source, 'and it is not empty for a player the weekly model covers');
});

test('two players in one process can carry different sources', () => {
  // The defect in one assertion. A single `availabilityBasis()` cannot be right
  // about both of these at once, which is why a per-player field is needed at
  // all rather than a better-labelled per-process one.
  const universe_ = universe();
  const reported = universe_.get(8801).availability_source;
  const quiet = universe_.get(8802).availability_source;
  assert.notEqual(reported, quiet,
    'a player on the weekly injury report and one with no report are not priced the same way');
});

test('a position the weekly model does not cover says so by saying nothing', () => {
  // weeklyAvailability covers QB/RB/WR/TE only. Null is the honest answer for a
  // position with no model, and it is a different statement from a position that
  // has one and fell through it.
  assert.equal(universe().get(8803).availability_source, null);
});

test('the process basis is still served, and is still a different fact', () => {
  // Not replaced. `context.availability_basis` remains the right answer to "are
  // the fit tables loaded"; it was only ever the wrong answer to "was THIS
  // player measured".
  const universe_ = universe();
  assert.notEqual(universe_.context.availability_basis, undefined,
    'the process-level basis is untouched');
  // One basis, two sources: the per-process answer is the same for both players
  // by construction, which is exactly why it could not label either honestly.
  assert.notEqual(universe_.get(8801).availability_source, universe_.get(8802).availability_source);
});
