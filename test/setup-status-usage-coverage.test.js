/**
 * GET /api/model/setup-status says whether the usage feed's own stamp is telling the truth.
 *
 * WHY THIS ROUTE AND NOT /status. The first version of this change put `usage_coverage`
 * on `GET /api/model/status`. That route had exactly one caller in the whole tree,
 * `client/src/pages/Model.tsx`, which no file imports and no `<Route>` declares — so it
 * would have wired a signal whose entire job is to say "the feed is LYING rather than
 * merely stale" onto an endpoint no human can reach. It would have read as wired in
 * every report and nobody would ever have seen the answer. `/status` was deleted on
 * 2026-09-20; `/setup-status` is the one route in this family a person actually reaches,
 * through `client/src/components/DataSetupBanner.tsx:24`, which `App.tsx` renders on
 * every page.
 *
 * WHY THE CALLER MUST NAME ITS WINDOW. `usageCoverage()` called with no argument asks
 * only about the seasons already held, so `missing` is empty and `stamp_disagrees` is
 * false by construction, whatever the feed did. A caller that does not say what it
 * EXPECTS gets a check that cannot fail. And the window is derived from NFL_SEASON
 * rather than typed out, because a hardcoded list of years is exactly how
 * nflverse_weekly_usage came to stamp itself green for a season it never fetched.
 *
 * THE THREE STATES MUST BE DISTINGUISHABLE FROM EACH OTHER, which is the whole point:
 * never run (no claim made), stale (the feed says it failed, and it is missing data),
 * and lying (the feed says ok, and it is missing data). Only the third is new
 * information — staleness is the only failure the surfaces beside this one can already
 * describe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-setup-usage-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'setup.sqlite');
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
const setup = async () => { clearModelCache(); return (await fetch(`${base}/api/model/setup-status`)).json(); };
const stampUsage = (status) => {
  run(`DELETE FROM sync_log WHERE job = 'nflverse_weekly_usage'`);
  if (status) run(`INSERT INTO sync_log (job, last_run_at, last_status, consecutive_failures)
                   VALUES ('nflverse_weekly_usage', datetime('now'), ?, 0)`, status);
};

test('the window is the five seasons ending at NFL_SEASON, derived and not typed out', async () => {
  stampUsage('ok');
  assert.deepEqual((await setup()).usage_coverage.seasons, [2022, 2023, 2024, 2025, 2026]);
});

test('THE POINT: a green stamp over a season with no rows is reported as a disagreement', async () => {
  stampUsage('ok');
  const body = await setup();
  assert.deepEqual(body.usage_coverage.missing, [2026]);
  assert.equal(body.usage_coverage.stamp.status, 'ok');
  assert.equal(body.usage_coverage.stamp_disagrees, true,
    'the feed claims ok while a season in the window holds nothing: that is a lie, not staleness');
});

test('the banner is told, and told in words that are not the never-run words', async () => {
  stampUsage('ok');
  const body = await setup();
  assert.equal(body.needs_setup, true, 'a lying stamp is a reason to show the banner');
  const row = body.missing.find(m => m.source === 'nflverse_weekly_usage_seasons');
  assert.ok(row, 'the disagreement must appear in the list the banner renders, not only in detail');
  assert.match(row.label, /2026/, 'the sentence names the season that is actually missing');
  assert.match(row.label, /reports success|wrote nothing|no rows/i,
    'the sentence has to say the feed CLAIMED success, or it reads as ordinary staleness');
  assert.ok(!/never run/i.test(row.label), 'a lie must not be worded as a never-run');
});

test('STALE IS NOT LYING: a failed stamp over the same missing season is not a disagreement', async () => {
  stampUsage('error');
  const body = await setup();
  assert.deepEqual(body.usage_coverage.missing, [2026], 'the data is missing either way');
  assert.equal(body.usage_coverage.stamp_disagrees, false,
    'a feed that says it failed has not contradicted itself');
  assert.equal(body.missing.some(m => m.source === 'nflverse_weekly_usage_seasons'), false,
    'the lying-stamp row is only for a lying stamp');
});

test('NEVER RUN IS NOT LYING EITHER: a feed with no row has made no claim to contradict', async () => {
  stampUsage(null);
  const body = await setup();
  assert.equal(body.usage_coverage.never_run, true);
  assert.equal(body.usage_coverage.stamp_disagrees, false,
    'calling a fresh clone a liar would fire on every new install');
  assert.equal(body.missing.some(m => m.source === 'nflverse_weekly_usage_seasons'), false);
});

test('once the season is held the disagreement clears', async () => {
  stampUsage('ok');
  run(`INSERT INTO player_week_usage (player_id, season, week, targets) VALUES (1, 2026, 1, 5)`);
  const body = await setup();
  assert.deepEqual(body.usage_coverage.missing, []);
  assert.equal(body.usage_coverage.stamp_disagrees, false);
  assert.equal(body.missing.some(m => m.source === 'nflverse_weekly_usage_seasons'), false);
});
