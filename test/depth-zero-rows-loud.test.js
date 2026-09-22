import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// nfl_depth held 0 rows in production on 2026-09-22 while nfl_snaps held
// 128,146. The two feeds are fetched by the same function in the same loop, so
// the difference is not the network: depth charts through 2024 carry a week
// rather than a publication timestamp, and every row is dated from `game_lines`
// before it is stored. With no schedule loaded every row is dropped, the fetch
// still succeeds, and this used to return `rows: 0, failures: []` -- a source
// that produced nothing while reporting six seasons loaded.
//
// nfl-advanced.js:275 now throws instead. Nothing tested that, so nothing
// stopped it being deleted or weakened. These tests are that pin. They also
// pin the thing a person actually needs from the error, which is not "0 rows"
// but which dependency to go and fix.
//
// Seasons differ between tests on purpose. `_historicalAvailability` and
// `_weekCache` are module-level caches keyed by season, so reusing one season
// across an empty-schedule and a loaded-schedule test would serve the cached
// null and the second test would pass for the wrong reason.

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-depth-zero-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { syncDepthCharts } = await import('../server/services/nfl-advanced.js');

/** The historical release: a week column, no publication timestamp. */
const historicalCsv = (season, week) => [
  'season,week,club_code,gsis_id,full_name,depth_position,depth_team',
  `${season},${week},KC,00-0033873,Patrick Mahomes,QB,1`,
  `${season},${week},KC,00-0034796,Isiah Pacheco,RB,1`,
  `${season},${week},BUF,00-0034857,Josh Allen,QB,1`
].join('\n');

/** Fake the nflverse fetch. `eachRow` reads `res.body` as a web stream. */
function stubFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = async url => handler(String(url));
  return () => { globalThis.fetch = real; };
}
const okCsv = body => new Response(body, { status: 200 });
const notFound = () => new Response('', { status: 404 });

function loadSchedule(season, week, teams, gameday) {
  for (const team of teams) {
    db.prepare(`INSERT OR REPLACE INTO game_lines (season, week, team, home, gameday)
                VALUES (?,?,?,1,?)`).run(season, week, team, gameday);
  }
}
const depthRows = season =>
  rows('SELECT COUNT(*) AS c FROM nfl_depth WHERE season=?', season)[0].c;

test('a depth sync that downloads rows and stores none is a failure, not a success', async () => {
  const restore = stubFetch(() => okCsv(historicalCsv(2021, 3)));
  try {
    await assert.rejects(() => syncDepthCharts([2021]), /stored 0 rows/);
  } finally { restore(); }
});

test('the error names the dependency to fix, not the symptom', async () => {
  const restore = stubFetch(() => okCsv(historicalCsv(2019, 5)));
  try {
    await syncDepthCharts([2019]);
    assert.fail('expected the zero-row guard to throw');
  } catch (error) {
    // "0 rows" alone sends a person looking at the depth feed, which is fine.
    // The cause is a different table entirely, so the message has to say so.
    assert.match(error.message, /game_lines is empty/);
    assert.match(error.message, /syncHistoricalLines/,
      'the message must name the call that fixes it, not only the table');
  } finally { restore(); }
});

test('nothing is written when the guard fires', async () => {
  const restore = stubFetch(() => okCsv(historicalCsv(2020, 2)));
  try {
    await syncDepthCharts([2020]).catch(() => {});
    assert.equal(depthRows(2020), 0,
      'a throw that left half a season behind would be worse than the silence it replaced');
  } finally { restore(); }
});

test('with the schedule loaded the same feed stores its rows and does not throw', async () => {
  loadSchedule(2022, 4, ['KC', 'BUF'], '2022-10-02');
  const restore = stubFetch(() => okCsv(historicalCsv(2022, 4)));
  try {
    const result = await syncDepthCharts([2022]);
    assert.equal(result.rows, 3);
    assert.equal(result.failures.length, 0);
    assert.equal(depthRows(2022), 3);
  } finally { restore(); }
});

test('a feed that cannot be fetched at all reports that, not a storage failure', async () => {
  const restore = stubFetch(() => notFound());
  try {
    // Both failure modes end in zero rows. A person reading the error needs to
    // know whether the download failed or the join did, because the two have
    // nothing to do with each other.
    await assert.rejects(() => syncDepthCharts([2018]), /Every depth-chart season failed/);
  } finally { restore(); }
});

test('one season failing to download does not condemn a season that stored rows', async () => {
  loadSchedule(2023, 6, ['KC', 'BUF'], '2023-10-15');
  const restore = stubFetch(url =>
    url.includes('depth_charts_2023') ? okCsv(historicalCsv(2023, 6)) : notFound());
  try {
    const result = await syncDepthCharts([2017, 2023]);
    assert.equal(result.rows, 3);
    assert.equal(result.seasons_loaded, 1);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].season, 2017);
  } finally { restore(); }
});
