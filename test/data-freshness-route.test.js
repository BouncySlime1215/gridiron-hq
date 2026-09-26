/**
 * Serving the freshness report over HTTP. The route's own jobs, none of which
 * the service can do for it: resolve which season and week count as current
 * (the service is pure over those and takes them as arguments), pick the
 * registry, and hand back rows in the shape the panel renders — while never
 * being the thing that says "fresh" about a table with no current rows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-data-freshness-route-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';
delete process.env.NFL_WEEK;

const { db, run } = await import('../server/db/index.js');

const TEAM = 'KC';
run(`INSERT INTO nfl_teams (abbr, name, conference, division) VALUES (?, 'Kansas City', 'AFC', 'West')`, TEAM);
// Weeks 1-2 played, week 3 not: currentNflWeek resolves week 3 without the clock.
for (const [week, score] of [[1, 24], [2, 17], [3, null]]) {
  run(`INSERT INTO game_lines (season, week, team, opponent, home, team_score) VALUES (2026,?,?, 'LV',1,?)`, week, TEAM, score);
}
run(`INSERT INTO players (id, name, position) VALUES (1, 'Test Player', 'WR')`);

const { default: dataFreshnessRouter } = await import('../server/routes/data-freshness.js');
const app = express();
app.use(express.json());
app.use('/api/data-freshness', dataFreshnessRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const get = url => fetch(base + url);

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('the report is a list of tables, each with the full panel shape', async () => {
  const body = await (await get('/api/data-freshness')).json();
  assert.ok(Array.isArray(body.tables), 'no tables array in the payload');
  assert.ok(body.tables.length > 0, 'the report is empty');
  for (const k of ['table', 'label', 'row_count', 'earliest', 'latest', 'last_write', 'current_rule', 'status']) {
    assert.ok(k in body.tables[0], `a table row is missing ${k}`);
  }
});

test('the season and week the report was computed for are in the payload', async () => {
  const body = await (await get('/api/data-freshness')).json();
  assert.equal(body.season, 2026, 'the resolved season is not reported');
  assert.equal(body.week, 3, 'the resolved week is not reported, so a reader cannot tell what "current" meant');
});

test('player_week_usage with no current-season rows is reported not fresh, over HTTP', async () => {
  db.prepare(`DELETE FROM player_week_usage`).run();
  for (const s of [2023, 2024, 2025]) db.prepare(`INSERT INTO player_week_usage (player_id, season, week) VALUES (1, ?, 1)`).run(s);
  const body = await (await get('/api/data-freshness')).json();
  const pwu = body.tables.find(t => t.table === 'player_week_usage');
  assert.ok(pwu, 'player_week_usage is not in the served report');
  assert.notEqual(pwu.status, 'fresh', 'the endpoint said fresh on data with no current season — the banner bug, over HTTP');
  assert.equal(pwu.status, 'stale');
});

test('an overall flag summarises whether anything served is not fresh', async () => {
  db.prepare(`DELETE FROM player_week_usage`).run();
  for (const s of [2023, 2024]) db.prepare(`INSERT INTO player_week_usage (player_id, season, week) VALUES (1, ?, 1)`).run(s);
  const body = await (await get('/api/data-freshness')).json();
  assert.equal(body.all_fresh, false, 'a report with a stale table claimed everything was fresh');
});

test('the route uses the schedule\'s current week, not a fixed one: a row at that week reads fresh', async () => {
  db.prepare(`DELETE FROM player_week_usage`).run();
  // A 2026 row at week 3, the week the schedule is on. It is current only if the
  // route passed week 3 to the service; a route hardwired to week 1 would call
  // this future data and report stale.
  db.prepare(`INSERT INTO player_week_usage (player_id, season, week) VALUES (1, 2026, 3)`).run();
  // FC-SNAP added dynasty_values to the registry; all_fresh needs a price fetched today too.
  db.prepare(`INSERT OR REPLACE INTO dynasty_values (format_key, player_id, value, fetched_at)
              VALUES ('rd_sf1_t10_ppr1', 1, 100, datetime('now'))`).run();
  // FC-FRESH-AGE added the redraft fc_value rows (the trade-rule currency): fetched today too.
  db.prepare(`INSERT OR REPLACE INTO player_metrics (player_id, source, value, fetched_at)
              VALUES (1, 'fc_value', 100, datetime('now'))`).run();
  const body = await (await get('/api/data-freshness')).json();
  const pwu = body.tables.find(t => t.table === 'player_week_usage');
  assert.equal(pwu.status, 'fresh', 'a current-week row was not recognised as current — the route sent the wrong week');
  assert.equal(body.tables.find(t => t.table === 'dynasty_values')?.status, 'fresh');
  assert.equal(body.all_fresh, true);
});
