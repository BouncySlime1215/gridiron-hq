/**
 * When the rest-of-season model fails, the asset universe says so.
 *
 * ros-projection.js now raises a failed history query instead of returning an empty
 * one (test/ros-projection-failures.test.js). buildAssetUniverse must not let that
 * take every page down, and must not hide it either: it logs the failure with the
 * league and week, and every asset that fell back carries `ros_basis.failed`.
 * Setup follows test/ros-projection-wiring.test.js.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ros-failure-wiring-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { seedIfEmpty } = await import('../server/db/seed/index.js');
seedIfEmpty();
run(`INSERT OR IGNORE INTO schedule_games (season, team_id, week, opponent_abbr, home)
     SELECT 2026, t.id, w.week, t.abbr, 1 FROM nfl_teams t
     JOIN (WITH RECURSIVE n(week) AS (SELECT 1 UNION ALL SELECT week + 1 FROM n WHERE week < 18) SELECT week FROM n) w`);

mock.module('../server/services/ros-projection.js', {
  namedExports: {
    buildRosProjections: () => { throw new Error('Provided value cannot be bound to SQLite parameter 2'); }
  }
});
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const { assetUniverse } = await import('../server/services/trade-engine.js');
const { deriveFormat } = await import('../server/services/format.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('a failed ROS build is logged and marked on the assets, not silent and not fatal', () => {
  const [wr] = rows(`SELECT p.id FROM players p JOIN nfl_teams t ON t.id = p.team_id
                     WHERE p.position = 'WR' AND p.fantasy_relevant = 1 ORDER BY p.id LIMIT 1`);
  run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games) VALUES (?,2026,'projected',300,17)`, wr.id);
  run(`INSERT INTO leagues (id, platform, league_id, season, name, payload) VALUES (71, 'sleeper', 'rf-71', 2026, 'ROS failure', '{}')`);
  const lg = rows('SELECT * FROM leagues WHERE id = 71')[0];
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let assets;
  try { assets = assetUniverse(lg, deriveFormat(lg).formatKey); } finally { console.error = original; }
  assert.ok(errors.some(e => /rest-of-season/.test(e) && /cannot be bound/.test(e)), `logged: ${errors}`);
  const a = assets.get(wr.id);
  assert.ok(a, 'the universe still builds');
  assert.match(a.ros_basis?.failed ?? '', /rest-of-season model failed/);
});
