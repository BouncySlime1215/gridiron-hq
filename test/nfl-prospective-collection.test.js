import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * `runProspectiveCollection` genuinely calls two real, money-spending
 * functions (`captureCurrentQuoteTape`, `extractNewsEventsFromItems`) with
 * no dependency-injection seam to swap in a mock. This test file makes that
 * safe rather than avoiding it:
 *
 *   - ODDS_API_KEY is deleted before anything is imported, so
 *     `captureCurrentQuoteTape` takes its own documented no-key path
 *     (`{ skipped: true, reason: ... }`) and never reaches the network,
 *     regardless of whatever this session's real .env happens to have set.
 *   - The news-extraction half turns out to be doubly safe here: this test
 *     runner does not load .env (confirmed directly below — `getApiKey()`
 *     reads `process.env.ANTHROPIC_API_KEY` first, which `node --test` never
 *     sets), so it takes the same documented no-key skip path. Even if a key
 *     WERE present, `extractNewsEventsFromItems` only calls the API for
 *     candidates found in `news_items`, and this test's isolated temp
 *     database starts with zero rows in that table — zero candidates means
 *     zero calls regardless.
 *
 * What this actually proves: the two-halves-run-together wiring, that a
 * missing key degrades to a labeled skip rather than a crash or a silent
 * fabrication, and that a real sync_log heartbeat is written every time —
 * exactly the "no key configured -> show the dependency, don't charge
 * anything" contract the execution brief asks for.
 */
delete process.env.ODDS_API_KEY;

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-prospective-collection-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { runProspectiveCollection, PROSPECTIVE_COLLECTION_SOURCE, RESTART_LIMITATION } =
  await import('../server/services/nfl-prospective-collection.js');
const { lastRun } = await import('../server/services/scheduler.js');
const { MANUAL_SOURCES } = await import('../server/services/source-registry.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('with no Odds API key and an empty news_items table, both halves skip honestly and nothing crashes or spends anything', async () => {
  const result = await runProspectiveCollection({ newsLimit: 5 });
  assert.equal(result.quote_capture?.skipped, true, 'a missing key must produce a labeled skip, never a fabricated capture');
  assert.match(result.quote_capture.reason, /ODDS_API_KEY/);
  // This test runner has no ANTHROPIC_API_KEY loaded, so the news half
  // takes the identical documented no-key skip path -- proven directly,
  // not assumed, since the alternative (a real key with zero news_items
  // rows) would also read as free but through a different code path.
  assert.equal(result.news_extraction?.skipped, true);
  assert.match(result.news_extraction.reason, /Anthropic/);
  assert.equal(result.errors.length, 0);
  // Codex audit finding E10: both halves skipped is NOT 'ok'. Nothing ran and
  // nothing was collected; reporting that as success is how a silent
  // collection outage looks healthy on a status page. It is 'blocked', and it
  // leaves no successful-data watermark behind.
  assert.equal(result.status, 'blocked');
  assert.equal(result.last_successful_data_at, null);
  assert.deepEqual(result.half_status, { quote_capture: 'skipped', news_extraction: 'skipped' });
});

test('the restart limitation is stated on every result, not left implicit', async () => {
  const result = await runProspectiveCollection({ newsLimit: 5 });
  assert.equal(result.restart_limitation, RESTART_LIMITATION);
  assert.match(result.restart_limitation, /SCHEDULER_DISABLED/);
  assert.match(result.restart_limitation, /closed or the machine sleeps/);
});

test('a real heartbeat lands in sync_log every run, readable the same way every other source in this app already is', async () => {
  await runProspectiveCollection({ newsLimit: 5 });
  const record = lastRun(PROSPECTIVE_COLLECTION_SOURCE);
  assert.ok(record?.last_run_at, 'sync_log must show a real run timestamp');
  assert.equal(record.last_status, 'blocked', 'a run where nothing ran must not be recorded as ok');
  const detail = JSON.parse(record.last_detail);
  assert.equal(detail.quote_capture.skipped, true);
  assert.equal(detail.last_successful_data_at, null);
});

test('this source is registered so it actually surfaces on the Data Health page, not only reachable by calling the function directly', () => {
  const meta = MANUAL_SOURCES[PROSPECTIVE_COLLECTION_SOURCE];
  assert.ok(meta, 'must be registered in MANUAL_SOURCES for /dev/sources and the Data Health page to see it');
  assert.match(meta.label, /quote tape/i);
  assert.match(meta.failureMode, /no automatic retry/);
});

test('an unusual newsLimit/sinceDays does not throw, whichever path the extractor actually takes', async () => {
  const result = await runProspectiveCollection({ newsLimit: 3, sinceDays: 1 });
  // Whatever path it takes, the status must be one of the honest ones -- and
  // in this keyless test environment both halves skip, so it is 'blocked'.
  assert.ok(['ok', 'empty', 'partial', 'blocked', 'error'].includes(result.status));
  assert.equal(result.status, 'blocked');
  assert.ok(result.news_extraction);
});

/* ---- Codex audit finding E10: a returned error is a failure, not an 'ok' ---- */

/**
 * The defect these cover: both halves can fail by RETURNING `{ error }`
 * rather than throwing (a provider returning no snapshot, for instance), and
 * the old status logic only inspected thrown exceptions -- so those runs
 * reported `ok` and advanced a heartbeat as though data had been collected.
 * `classifyRun` is the pure decision the module now makes, exercised here
 * directly so every combination is covered without spending real API money.
 */
const { __test } = await import('../server/services/nfl-prospective-collection.js');

test('E10: a half that RETURNS an error object is classified as an error, never ok', () => {
  assert.equal(__test.classifyHalf({ error: 'odds provider returned no current snapshot' }, () => 0), 'error');
  assert.equal(__test.classifyHalf(null, () => 0), 'error', 'a missing result is not a success either');
});

test('E10: skipped, empty and productive halves are three different answers', () => {
  assert.equal(__test.classifyHalf({ skipped: true, reason: 'no key' }, () => 0), 'skipped');
  assert.equal(__test.classifyHalf({ accepted: 0 }, r => r.accepted), 'empty');
  assert.equal(__test.classifyHalf({ accepted: 3 }, r => r.accepted), 'ok');
});

test('E10 acceptance: one half failing is partial, both failing is error, both skipped is blocked', () => {
  assert.equal(__test.overallStatus(['error', 'error']), 'error');
  assert.equal(__test.overallStatus(['skipped', 'skipped']), 'blocked');
  assert.equal(__test.overallStatus(['error', 'skipped']), 'error',
    'nothing was collected and something broke — that is not a partial success');
  assert.equal(__test.overallStatus(['error', 'ok']), 'partial');
  assert.equal(__test.overallStatus(['skipped', 'ok']), 'partial');
  assert.equal(__test.overallStatus(['empty', 'empty']), 'empty');
  assert.equal(__test.overallStatus(['empty', 'ok']), 'partial');
  assert.equal(__test.overallStatus(['ok', 'ok']), 'ok');
});

test('E10 acceptance: only a genuinely productive run may set a successful-data watermark', () => {
  assert.equal(__test.watermarkFor(['skipped', 'skipped'], 'T'), null);
  assert.equal(__test.watermarkFor(['empty', 'empty'], 'T'), null,
    'a successful run that found nothing did not produce data, and must not look like it did');
  assert.equal(__test.watermarkFor(['error', 'empty'], 'T'), null);
  assert.equal(__test.watermarkFor(['ok', 'skipped'], 'T'), 'T');
});
