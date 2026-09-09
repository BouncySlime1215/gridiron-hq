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
  assert.equal(result.status, 'ok');
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
  assert.equal(record.last_status, 'ok');
  const detail = JSON.parse(record.last_detail);
  assert.equal(detail.quote_capture.skipped, true);
});

test('this source is registered so it actually surfaces on the Data Health page, not only reachable by calling the function directly', () => {
  const meta = MANUAL_SOURCES[PROSPECTIVE_COLLECTION_SOURCE];
  assert.ok(meta, 'must be registered in MANUAL_SOURCES for /dev/sources and the Data Health page to see it');
  assert.match(meta.label, /quote tape/i);
  assert.match(meta.failureMode, /no automatic retry/);
});

test('an unusual newsLimit/sinceDays does not throw, whichever path the extractor actually takes', async () => {
  const result = await runProspectiveCollection({ newsLimit: 3, sinceDays: 1 });
  assert.equal(result.status, 'ok');
  assert.ok(result.news_extraction);
});
