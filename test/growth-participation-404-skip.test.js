/**
 * The current season's participation 404 is a skip, not a failed download.
 *
 * Two merged PRs, each right alone, broke each other on main:
 *
 *   #92 (6e722719) removed the `season <= 2023` gate, so the growth cycle calls
 *       ingestFormations(season) for the season being played on every download
 *       cycle (nfl-model-growth.js:247).
 *   #119 added cycleOutcome(), which counts any ingestion step with `.error` as
 *       a failed download (nfl-model-growth.js:177-178).
 *
 * nflverse publishes participation for a season only after its post-season is
 * complete (nflreadr load_participation docs, quoted in
 * docs/tdd/2026-09-22-formations-404-skip.tdd.md), so the cycle's own season
 * always returns 404 while it is being played. ingestFormations returns that as
 * `{ error }` (nfl-formations.js:68-75), attempt() stores it as-is, and every
 * in-season download cycle ends `ingest_error` with a note calling the data
 * stale. The absence is documented and expected; it must be recorded as one.
 *
 * What must NOT change: any other status, or a thrown fetch, is still a failed
 * download. A 503 is not a publication schedule, and neither is a 403 or a 429
 * (GitHub forbidding or rate-limiting the request) or a 410. And a 404 is only
 * the documented absence for the season in progress: a completed season is
 * published, so its 404 is a real fault even when the manual route
 * (POST /profitability/model-growth/run, which passes its own season) is what
 * asked for it.
 *
 * The cycle is driven end to end with fetch stubbed, the same way
 * growth-participation-season-gate.test.js does it, so the step under test is
 * the one the real call site produced, not a hand-built object. Its verdict is
 * then read through the real cycleOutcome.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-growth-404-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
// The season in progress is read the way the cycle reads it (availableSeason:
// NFL_SEASON, else the newest game_lines season). Cleared so the fixture's
// game_lines decide it, whatever the shell exports.
delete process.env.NFL_SEASON;
const SEASON = 2026;
const COMPLETED = 2024;
const { db, run, rows } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// finalized_week > 0 needs a week whose every home game has both scores;
// without it the cycle skips every download and the call site never runs.
// COMPLETED gets a final week too, so the manual-route run below reaches the
// download branch; SEASON stays the newest season, so it is the one in progress.
for (const season of [COMPLETED, SEASON]) {
  for (const [team, opp] of [['BUF', 'MIA'], ['KC', 'DEN']]) {
    run(`INSERT INTO game_lines (season, week, team, opponent, home, team_score, opp_score)
         VALUES (?,?,?,?,?,?,?)`, season, 1, team, opp, 1, 24, 17);
  }
}

// Participation answers with whatever the phase sets; every other feed 503s so
// nothing else in the cycle writes rows.
let participation = { status: 404 };
const participationUrls = [];
globalThis.fetch = async url => {
  if (String(url).includes('/pbp_participation/')) {
    participationUrls.push(String(url));
    if (participation.throws) throw new Error(participation.throws);
    return { ok: false, status: participation.status, text: async () => 'Not Found', body: null };
  }
  return { ok: false, status: 503, text: async () => '', body: null };
};

const growth = await import('../server/services/nfl-model-growth.js');
const { runNflModelGrowthCycle, cycleOutcome } = growth;
const { ingestFormations } = await import('../server/services/nfl-formations.js');

participation = { status: 404 };
const unpublished = await runNflModelGrowthCycle({ season: SEASON, force: true });
const unpublishedUrls = participationUrls.splice(0);
const unpublishedRunId = rows('SELECT MAX(id) id FROM nfl_model_growth_runs')[0].id;
participation = { status: 503 };
const unavailable = await runNflModelGrowthCycle({ season: SEASON, force: true });
participation = { throws: 'fetch failed' };
const thrown = await runNflModelGrowthCycle({ season: SEASON, force: true });
// Client errors that are not "not published": forbidden, rate-limited, gone.
const clientErrors = {};
for (const status of [403, 429, 410]) {
  participation = { status };
  clientErrors[status] = await runNflModelGrowthCycle({ season: SEASON, force: true });
}
// The manual route's shape: a completed season asked for explicitly, 404ing.
participation = { status: 404 };
const completed = await runNflModelGrowthCycle({ season: COMPLETED, force: true });
const completedUrls = participationUrls.splice(0).filter(url => url.endsWith(`_${COMPLETED}.csv`));

const verdictFor = step => cycleOutcome({ finalizedWeek: 2, requiredLag: [],
  detail: { ingestion: { formation_participation: step } } });

test('the cycle records the current-season participation 404 as a skip, not an error', () => {
  const step = unpublished.ingestion.formation_participation;
  assert.equal(step?.error, undefined,
    `a 404 for the season being played is the documented absence; step was ${JSON.stringify(step)}`);
  assert.equal(step.skipped, true);
  assert.equal(step.absence, 'not_published', 'which absence it is, as a field, not a sentence');
  assert.equal(step.http_status, 404);
  assert.equal(step.season, SEASON);
});

test('the cycle asks nflverse for its own season, once', () => {
  // The skip rule is only right because the file requested is the season being
  // played. Asking for season - 1 would download a published ~50 MB file on
  // every download cycle and still be labelled with this season. Found as a
  // surviving call-site mutant (C2) in the first mutation sweep.
  assert.deepEqual(unpublishedUrls.map(url => url.split('/').pop()), [`pbp_participation_${SEASON}.csv`]);
});

test('cycleOutcome counts that 404 as a skip, not a failed download', () => {
  // The re-audit reproduction, with the step the real call site produced.
  const verdict = verdictFor(unpublished.ingestion.formation_participation);
  assert.equal(verdict.status, 'ok',
    `expected ok with a recorded skip, got ${verdict.status}: ${verdict.note}`);
  assert.deepEqual(verdict.skipped, ['formation_participation']);
  assert.match(verdict.note, /formation_participation/, 'the skip is named where a person reads it');
  assert.match(verdict.note, /immutable labels/, 'the clean-run sentence is kept, not replaced');
});

test('the stored run record carries the skip as a field', () => {
  // latestRun() (nfl-model-growth.js:112) serves detail_json to the status
  // route, so the field has to survive the round trip, not just the return.
  assert.deepEqual(unpublished.skipped_steps, ['formation_participation']);
  const stored = JSON.parse(rows('SELECT detail_json FROM nfl_model_growth_runs WHERE id=?',
    unpublishedRunId)[0].detail_json);
  assert.deepEqual(stored.skipped_steps, ['formation_participation']);
});

test('any other participation status is still a failed download', () => {
  const step = unavailable.ingestion.formation_participation;
  assert.ok(step?.error, `a 503 is not a publication schedule; step was ${JSON.stringify(step)}`);
  assert.notEqual(step.skipped, true);
  assert.equal(verdictFor(step).status, 'ingest_error');
  assert.deepEqual(unavailable.skipped_steps ?? [], []);
});

test('a 403, a 429 or a 410 for the season in progress is still a failed download', () => {
  // Only 404 is the publication schedule. Widening the rule to every 4xx would
  // turn GitHub forbidding or rate-limiting the request into "not published
  // yet" and a run that ends ok (skeptic mutant U1).
  for (const [status, result] of Object.entries(clientErrors)) {
    const step = result.ingestion.formation_participation;
    assert.ok(step?.error, `${status} is not a publication schedule; step was ${JSON.stringify(step)}`);
    assert.equal(step.http_status, Number(status));
    assert.notEqual(step.skipped, true, `${status} is not recorded as a skip`);
    assert.equal(verdictFor(step).status, 'ingest_error', `${status} makes the run ingest_error`);
    assert.deepEqual(result.skipped_steps ?? [], [], `${status} is not in skipped_steps`);
  }
});

test('a 404 for a completed season is a failed download, not a skip', () => {
  // nfl-formations.js says it: 2016-2025 are published, so a 404 for one of
  // them is a real fault. The route passes its own season into the cycle, so
  // "the cycle's season is the one being played" is not something the rule may
  // assume; it has to check.
  assert.deepEqual(completedUrls.map(url => url.split('/').pop()), [`pbp_participation_${COMPLETED}.csv`],
    'the run asked for the completed season');
  const step = completed.ingestion.formation_participation;
  assert.ok(step?.error, `a completed season's 404 is a fault; step was ${JSON.stringify(step)}`);
  assert.equal(step.http_status, 404);
  assert.notEqual(step.skipped, true);
  assert.equal(step.absence, undefined, 'not labelled not_published');
  assert.equal(verdictFor(step).status, 'ingest_error');
  assert.deepEqual(completed.skipped_steps ?? [], []);
});

test('a thrown participation fetch is still a failed download', () => {
  const step = thrown.ingestion.formation_participation;
  assert.match(step?.error ?? '', /fetch failed/);
  assert.equal(verdictFor(step).status, 'ingest_error');
});

test('ingestFormations reports the status as a field, which is what the skip reads', async () => {
  participation = { status: 404 };
  const result = await ingestFormations(2031);
  assert.ok(result.error, 'the writer still reports a non-OK download as an error to every caller');
  assert.equal(result.http_status, 404);
  assert.equal(result.season, 2031);
  participation = { status: 502 };
  assert.equal((await ingestFormations(2031)).http_status, 502);
});

test('a step that carries an error is a failure even if it also says skipped', () => {
  const verdict = verdictFor({ skipped: true, error: 'participation for 2026 returned 500' });
  assert.equal(verdict.status, 'ingest_error', 'an error key always wins over a skip flag');
  assert.deepEqual(verdict.skipped ?? [], []);
});

test('the production skip rule, pinned directly', () => {
  // The call site injects this rule into attempt(); a test that only fed
  // cycleOutcome a hand-made skip could not see it deleted.
  const { unpublishedSeasonSkip } = growth;
  assert.equal(typeof unpublishedSeasonSkip, 'function', 'nfl-model-growth.js exports the rule it applies');
  // Arguments: the step, the season it asked for, the season in progress.
  const notFound = { season: SEASON, http_status: 404, error: `participation for ${SEASON} returned 404` };
  const skip = unpublishedSeasonSkip(notFound, SEASON, SEASON);
  assert.equal(skip.error, undefined);
  assert.equal(skip.skipped, true);
  assert.equal(skip.absence, 'not_published');
  const future = { season: SEASON + 1, http_status: 404, error: `participation for ${SEASON + 1} returned 404` };
  assert.equal(unpublishedSeasonSkip(future, SEASON + 1, SEASON).skipped, true,
    'a season after the one in progress is not published either');
  for (const status of [503, 403, 429, 410]) {
    const other = { season: SEASON, http_status: status, error: `participation returned ${status}` };
    assert.equal(unpublishedSeasonSkip(other, SEASON, SEASON), other, `a ${status} passes through untouched`);
  }
  const completedStep = { season: COMPLETED, http_status: 404, error: `participation for ${COMPLETED} returned 404` };
  assert.equal(unpublishedSeasonSkip(completedStep, COMPLETED, SEASON), completedStep,
    'a completed season\'s 404 passes through as the failure it is');
  assert.equal(unpublishedSeasonSkip(notFound, SEASON, undefined), notFound,
    'no known season in progress means no skip: the rule fails loud, not quiet');
  const stored = { season: SEASON, plays_stored: 45184 };
  assert.equal(unpublishedSeasonSkip(stored, SEASON, SEASON), stored, 'a success passes through untouched');
  const threw = { error: 'fetch failed' };
  assert.equal(unpublishedSeasonSkip(threw, SEASON, SEASON), threw, 'no status field means no skip');
});
