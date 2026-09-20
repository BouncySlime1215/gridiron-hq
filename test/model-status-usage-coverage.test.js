/**
 * GET /api/model/status says whether the usage feed's own stamp is telling the truth.
 *
 * `usage_seasons` says what is held. It cannot say what is MISSING, because a season
 * with no rows has no row to appear in. `usageCoverage()` called with no argument has
 * the same blind spot by construction — it asks only about the seasons already held, so
 * `missing` is empty and `stamp_disagrees` is false whatever the feed did. The caller
 * has to name the window it expects, and this pins that it does.
 *
 * The window is derived from NFL_SEASON rather than typed out. A hardcoded list of years
 * is exactly how nflverse_weekly_usage came to stamp itself green for a season it never
 * fetched, so the test drives NFL_SEASON and asserts the window follows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-status-usage-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'status.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { default: modelRouter, clearModelCache } = await import('../server/routes/model.js');

const app = express();
app.use('/api/model', modelRouter);
app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT INTO players (id, name, position) VALUES (1, 'Held Receiver', 'WR')`);
for (const season of [2022, 2023, 2024, 2025]) {
  run(`INSERT INTO player_week_usage (player_id, season, week, targets) VALUES (1, ?, 1, 5)`, season);
}
// The feed says it succeeded. 2026 has no rows at all.
run(`INSERT INTO sync_log (job, last_run_at, last_status, consecutive_failures)
     VALUES ('nflverse_weekly_usage', datetime('now'), 'ok', 0)`);

const status = async () => { clearModelCache(); return (await fetch(`${base}/api/model/status`)).json(); };

test('the window is the five seasons ending at NFL_SEASON, derived not typed', async () => {
  const body = await status();
  assert.deepEqual(body.usage_coverage.seasons, [2022, 2023, 2024, 2025, 2026]);
});

test('THE POINT: a green stamp over a season with no rows is reported as a disagreement', async () => {
  const body = await status();
  assert.deepEqual(body.usage_coverage.missing, [2026]);
  assert.equal(body.usage_coverage.stamp.status, 'ok');
  assert.equal(body.usage_coverage.stamp_disagrees, true,
    'the feed claims ok while a season in the window holds nothing: that is a lie, not staleness');
});

test('usage_seasons alone could not have said this', async () => {
  const body = await status();
  // Held seasons only. 2026 is absent rather than reported missing, which is the whole
  // reason the coverage field exists beside it.
  assert.ok(!body.usage_seasons.some(r => Number(r.season) === 2026));
  assert.deepEqual(body.usage_coverage.per_season.filter(s => !s.held).map(s => s.season), [2026]);
});

test('once the season is held the disagreement clears', async () => {
  run(`INSERT INTO player_week_usage (player_id, season, week, targets) VALUES (1, 2026, 1, 5)`);
  const body = await status();
  assert.deepEqual(body.usage_coverage.missing, []);
  assert.equal(body.usage_coverage.stamp_disagrees, false);
});
