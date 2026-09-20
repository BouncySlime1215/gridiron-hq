/**
 * "Is this season's data actually in here?" has to be answerable from the app.
 *
 * `POST /api/model/sync` ran its season list as `[SEASON-5 … SEASON-1]`, so it
 * re-fetched every completed season and never the one being played.
 * `player_week_usage` held about eight thousand rows for each prior year and zero
 * for the current one; every source reported `ok`; the projections carried on
 * being computed from last year's football with nothing on any screen different.
 * The counts that would have shown it were on `/api/model/status` the whole time,
 * rendered by a page that has since been deleted, so the app went back to having
 * no answer.
 *
 * The subtle part, and what most of these tests are about: the defect shows up as
 * an ABSENCE. `usageSeasons()` groups the table, so a season with no rows is not a
 * zero in the list — it is not in the list. Anything that renders the list alone
 * shows five healthy-looking seasons and says nothing at all about the missing
 * one. Only a reader that asks for a named season by name can see it, and the name
 * has to come from the league being played rather than from the calendar, because
 * the calendar year is wrong every January and this repo has already shipped that
 * bug once in draft-assist.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-data-behind-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { usageSeasons } = await import('../server/services/nflverse.js');

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const card = read('client/src/components/DataBehindNumbers.tsx');

// Two prior seasons loaded and the season being played completely absent — the
// live shape of the defect, not a hypothetical one.
run("INSERT INTO players (id, name, position) VALUES (1, 'Fixture One', 'WR')");
run("INSERT INTO players (id, name, position) VALUES (2, 'Fixture Two', 'RB')");
for (const [season, week, player] of [[2024, 1, 1], [2024, 2, 1], [2025, 1, 1], [2025, 2, 2]]) {
  run('INSERT INTO player_week_usage (player_id, season, week) VALUES (?,?,?)', player, season, week);
}

test('a season with no rows is missing from the list, not a zero in it', () => {
  const seasons = usageSeasons();
  assert.deepEqual(seasons.map(s => s.season), [2024, 2025]);
  assert.equal(seasons.find(s => s.season === 2026), undefined,
    'the current season is absent entirely, which is why rendering the list alone hides the defect');
});

test('the counts the card prints are the ones the query actually produces', () => {
  const y2025 = usageSeasons().find(s => s.season === 2025);
  assert.equal(y2025.rows, 2);
  assert.equal(y2025.players, 2, 'distinct players, not rows — the card labels them differently');
  const y2024 = usageSeasons().find(s => s.season === 2024);
  assert.equal(y2024.rows, 2);
  assert.equal(y2024.players, 1);
});

test('the endpoint serves every field the card renders', () => {
  // The inverse of this repo's usual check. A served field nothing renders is a
  // silent disclosure; a rendered field nothing serves is a card that is blank
  // or lying on the day someone edits the route.
  const route = read('server/routes/model.js');
  const status = route.slice(route.indexOf("r.get('/status'"));
  for (const field of ['usage_seasons', 'lines', 'players_with_gsis']) {
    assert.match(status.slice(0, 400), new RegExp(field), `/status no longer serves ${field}`);
    assert.match(card, new RegExp(field), `the card stopped reading ${field}`);
  }
});

test('the season it asks about comes from the league, never the calendar', () => {
  assert.match(card, /active\?\.season/, 'the season under test is the league\'s own');
  assert.doesNotMatch(card, /getFullYear/,
    'the calendar year is wrong every January; draft-assist.js already shipped that bug');
});

test('the missing-season warning is driven by a row count, not by the list being short', () => {
  // `usage.find(...)` returning undefined and a season present with zero rows must
  // both count as missing, or the warning depends on which way the query happens
  // to report it.
  assert.match(card, /\(thisSeason\?\.rows \?\? 0\) === 0/);
});

test('the card is mounted, and does not restate what other surfaces own', () => {
  const settings = read('client/src/pages/Settings.tsx');
  assert.match(settings, /import DataBehindNumbers/);
  assert.match(settings, /<DataBehindNumbers \/>/);
  // Chance-to-play basis belongs to Start/Sit and per-league sync times to the
  // league cards. Two accounts of one number is how they drift apart.
  assert.match(card, /to="\/lineup"/, 'it links to Start/Sit for the availability basis');
  assert.match(card, /view=connections/, 'and to the league cards for sync times');
  assert.doesNotMatch(card, /availability_basis/, 'it does not restate the basis itself');
  assert.doesNotMatch(card, /fetched_at/, 'nor the per-league sync times');
});
