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

/*
 * THE BANNER'S OWN CONTRACT, which is a different question from the one above.
 *
 * Everything above answers "is the stamp lying". The banner has to RENDER something,
 * and the shape it renders from is specified by the thread that owns it —
 * docs/tdd/usage-coverage-banner.tdd.md §5, on their hold branch. Their client already
 * exists (client/src/lib/usage-coverage.js), already has its sixteen mutations, and
 * reads four mutually exclusive states off one key. Nothing serves it.
 *
 * The state names are theirs verbatim, not a translation: 'healthy', 'never_run',
 * 'stale', 'ok_no_rows'. Their client "shows anything else as unrecognised", so a
 * fifth name invented on this side renders as a shrug on a banner whose entire job is
 * to stop an app from looking healthy while it projects this season off last season.
 * Chat sync has no competing vocabulary — searched every remote head for the token and
 * theirs is the only tree that holds it — so there is nothing to reconcile.
 *
 * These are ADDITIONS to the same key, not a second field. usage_coverage keeps job,
 * seasons, per_season, missing, never_run, stamp and stamp_disagrees, which are the
 * diagnosis; these eight are what the banner needs to say a sentence.
 */
const setLeagueWeek = (week) => {
  run(`DELETE FROM leagues`);
  if (week !== null) run(`INSERT INTO leagues (id, platform, league_id, season, name, current_week)
                          VALUES (1, 'espn', '900', 2026, 'Banner Fixture', ?)`, week);
};
const clear2026 = () => run(`DELETE FROM player_week_usage WHERE season = 2026`);

test('the banner contract: every key it names is served, and none is undefined', async () => {
  stampUsage('ok');
  const u = (await setup()).usage_coverage;
  for (const key of ['state', 'season', 'rows', 'latest_week', 'league_week',
    'seasons_with_rows', 'source_status', 'last_run_at']) {
    assert.ok(key in u, `usage_coverage.${key} is in the contract and must be served`);
    assert.notEqual(u[key], undefined, `${key} must be a value or null, never undefined`);
  }
  assert.equal(u.season, 2026, 'the season being played, not the newest season held');
  assert.deepEqual(u.seasons_with_rows, [2022, 2023, 2024, 2025, 2026],
    'what is being used instead, which is the sentence the banner writes');
});

test('OK_NO_ROWS: the state this install is actually in', async () => {
  clear2026();
  stampUsage('ok');
  const u = (await setup()).usage_coverage;
  assert.equal(u.rows, 0, 'no rows for the season being played');
  assert.equal(u.source_status, 'ok', 'and the source says it ran fine');
  assert.equal(u.state, 'ok_no_rows');
  assert.equal(u.season, 2026,
    'the season being played, even — especially — when it holds nothing. Reading the '
    + 'newest season that HAS rows would make the field agree with itself in exactly '
    + 'the state it exists to report, and a mutation doing that survived until this line');
  assert.deepEqual(u.seasons_with_rows, [2022, 2023, 2024, 2025],
    'the banner names what it is projecting off instead');
});

test('NEVER_RUN outranks ok_no_rows: a fresh clone has made no claim', async () => {
  clear2026();
  stampUsage(null);
  const u = (await setup()).usage_coverage;
  assert.equal(u.rows, 0, 'zero rows either way — the states are told apart by the stamp');
  assert.equal(u.source_status, 'never run');
  assert.equal(u.state, 'never_run',
    'a fresh clone must not be told its feed reported success');
  assert.equal(u.last_run_at, null);
});

test('STALE is about the WEEK, not the season: rows held, but behind the league', async () => {
  clear2026();
  stampUsage('ok');
  run(`INSERT INTO player_week_usage (player_id, season, week, targets) VALUES (1, 2026, 1, 5)`);
  // 2025 week 9, and it is here to make the query's WHERE clause load-bearing. Without
  // the season filter, MAX(week) over the whole table answers 9, the season being
  // played looks caught up with the league, and a stale feed reads as healthy. A
  // mutation dropping that filter survived until this row existed.
  run(`INSERT INTO player_week_usage (player_id, season, week, targets) VALUES (1, 2025, 9, 5)`);
  setLeagueWeek(3);
  const u = (await setup()).usage_coverage;
  assert.equal(u.rows > 0, true);
  assert.equal(u.latest_week, 1);
  assert.equal(u.league_week, 3);
  assert.equal(u.state, 'stale',
    'a season with week 1 in it while the league plays week 3 is not healthy');
});

test('HEALTHY, and the state is one of exactly the four the client knows', async () => {
  clear2026();
  stampUsage('ok');
  run(`INSERT INTO player_week_usage (player_id, season, week, targets) VALUES (1, 2026, 3, 5)`);
  setLeagueWeek(3);
  const u = (await setup()).usage_coverage;
  assert.equal(u.latest_week, 3);
  assert.equal(u.state, 'healthy');
  assert.ok(['healthy', 'never_run', 'stale', 'ok_no_rows'].includes(u.state),
    'the client shows a fifth name as unrecognised, so there must never be one');
});

test('no league is not a stale league: league_week null cannot make the state stale', async () => {
  clear2026();
  stampUsage('ok');
  run(`INSERT INTO player_week_usage (player_id, season, week, targets) VALUES (1, 2026, 1, 5)`);
  setLeagueWeek(null);
  const u = (await setup()).usage_coverage;
  assert.equal(u.league_week, null);
  assert.equal(u.state, 'healthy',
    'with nothing to be behind, held rows are not evidence of being behind');
});
