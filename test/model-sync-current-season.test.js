/**
 * POST /api/model/sync must ingest the season being played (2026-09-19).
 *
 * Measured on the live app: `player_week_usage` and `player_week_snaps` held
 * roughly 8,000 rows for every prior year and zero for 2026, while
 * /api/dev/sources reported `nflverse_weekly_usage: ok`. Both were true. The
 * route's default season list was `[SEASON - 5 ... SEASON - 1]` — every
 * completed season and never the current one — so the sync succeeded at
 * fetching seasons that had not changed.
 *
 * That one list drives play-by-play, nflverse usage, the advanced feeds and
 * ffopportunity, and scripts/bootstrap-data.mjs calls the route with no
 * `seasons` parameter, so the default is what actually runs.
 *
 * This asserts the shape of the default directly, by reading the source. The
 * route itself cannot be called in a test without performing a multi-season
 * ingest over the network, and the defect was never in the ingest — it was in
 * the list handed to it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'server/routes/model.js'), 'utf8');

test('the default season list ends at the current season, not the last completed one', () => {
  const match = source.match(/:\s*\[(SEASON[^\]]*)\]\)\.filter\(Boolean\)/);
  assert.ok(match, 'could not find the default season list in POST /sync');
  const list = match[1].split(',').map(s => s.trim());

  assert.equal(list.at(-1), 'SEASON',
    `the season being played must be ingested; the list ends at ${list.at(-1)}`);
  assert.equal(list.includes('SEASON - 5'), false,
    'the window should slide forward rather than grow — a completed season nflverse never revises ' +
    'does not need re-fetching every run');
  assert.equal(list.length, 5, 'still five seasons, so this costs no more than it did');
});

test('an explicit ?seasons= still wins, so a deliberate backfill is unaffected', () => {
  assert.match(source, /req\.query\.seasons \? String\(req\.query\.seasons\)/,
    'the caller-supplied list must still take precedence over the default');
});
