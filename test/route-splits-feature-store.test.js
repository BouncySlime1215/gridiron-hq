import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-route-fs-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { up } = await import('../server/migrations/069_nfl_route_splits.js');
const { SEASON_AGGREGATE_WEEK } = await import('../server/services/nfl-route-splits.js');
const { buildPlayerFeatureVector } = await import('../server/services/nfl-weekly-feature-store.js');

up(db);

const PLAYER = '00-0036900';
const insert = (season, week, stats) => db.prepare(`INSERT INTO nfl_route_splits
  (season,week,player_id,kind,player_name,team,position,qualifies,stats,source_fetched_at)
  VALUES (?,?,?,'routes','Ja''Marr Chase','CIN','WR',1,?,'2026-09-22T00:00:00Z')`)
  .run(season, week, PLAYER, JSON.stringify(stats));

test('weekly route splits reach the player feature vector under a route_ prefix', () => {
  insert(2025, 1, { route_targets: 9, route_entropy: 0.61, shell_epa_cover_3: 0.4 });
  insert(2025, 2, { route_targets: 11, route_entropy: 0.58, shell_epa_cover_3: 0.2 });
  const built = buildPlayerFeatureVector(2025, 3, PLAYER, { playerName: "Ja'Marr Chase" });
  assert.equal(built.error, undefined);
  const keys = Object.keys(built.vector).filter(k => k.startsWith('route_'));
  assert.ok(keys.length > 0, 'route features are present');
  assert.ok(keys.some(k => k.startsWith('route_route_entropy__')), 'entropy carried through the transforms');
});

/**
 * Season aggregates live at week 0 and are NOT a week. Letting them into the
 * weekly history would invent a week-0 observation for every player and mix a
 * whole season's totals into a rolling weekly mean. nfl_ngs's own sync drops
 * week-0 rows for exactly this reason (server/services/nfl-advanced.js:111).
 */
test('a season aggregate never becomes a week in player history', () => {
  const solo = '00-0099999';
  db.prepare(`INSERT INTO nfl_route_splits
    (season,week,player_id,kind,player_name,team,position,qualifies,stats,source_fetched_at)
    VALUES (?,?,?,'routes','Season Only','CIN','WR',1,?,'2026-09-22T00:00:00Z')`)
    .run(2025, SEASON_AGGREGATE_WEEK, solo, JSON.stringify({ route_targets: 175 }));
  const built = buildPlayerFeatureVector(2025, 3, solo, { playerName: 'Season Only' });
  assert.equal(built.error, 'no earlier player observations',
    'a week-0 row alone is not a history');
});

test('the loader survives a database where the migration has not run', () => {
  db.exec('DROP TABLE nfl_route_splits');
  const built = buildPlayerFeatureVector(2025, 3, PLAYER, { playerName: "Ja'Marr Chase" });
  assert.equal(built.error, 'no earlier player observations', 'absent table is not a crash');
  up(db);
});
