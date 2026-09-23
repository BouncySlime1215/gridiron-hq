/**
 * swallow-scan: the enumeration tool, tested against the shapes it must not
 * miss and must not invent.
 *
 * This scanner produced the sweep that found three real defects (the veto
 * climate, the counterparty data key, the self-read transaction state). An
 * enumeration is only worth the confidence people put in it, so the two ways
 * its first version was wrong are pinned here as tests rather than described in
 * a paragraph. Both were raised by the evidence auditor before it was committed:
 *
 *  S1 THE TRY IT MATCHES MUST BE THE TRY THAT MATCHES. The first version found
 *     the textually nearest preceding `try` on a line scan. A closed inner
 *     `try {} catch {}` sitting between the outer `try` and its `catch` steals
 *     that match in either order, and the block it then reads is the wrong
 *     block: one ordering loses the read entirely, the other attributes an
 *     inner catch's read to the outer one.
 *  S2 NO FIXED LOOKBACK. The first version capped the search at 25 lines. The
 *     true maximum span between `try` and `catch` in server/ is 122 lines, and
 *     26% of the sites exceed 12. A cap does not make a scan cheaper; it makes
 *     it quietly incomplete, which is the failure mode an enumeration cannot
 *     afford.
 *  S3 The wins of the first version stay won: prose is not SQL, an import is
 *     not a read, and a catch that binds its error is not a bare catch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSource, tablesIn, migratedTables } from '../scripts/swallow-scan.mjs';

/** The tables reported against the catch on the line containing `marker`. */
const at = (src, marker) => {
  const line = src.split('\n').findIndex(l => l.includes(marker)) + 1;
  assert.ok(line > 0, `marker ${marker} not in source`);
  return scanSource(src).filter(h => h.line === line).flatMap(h => h.tables);
};

test('S1a: a closed inner try/catch AFTER the read does not hide the read', () => {
  // Scanning upward for the nearest `try` lands on the inner one, which sits
  // BELOW the read — so the block considered starts after the query and the
  // outer catch is reported as swallowing nothing.
  const src = `
function f() {
  let tx = [];
  try {
    tx = rows(\`SELECT id FROM league_transactions_raw WHERE league_id = ?\`, id);
    try { risky(); } catch {}
  } catch { tx = []; } // OUTER
  return tx;
}`;
  assert.deepEqual(at(src, 'OUTER'), ['league_transactions_raw']);
});

test('S1b: a closed inner try/catch BEFORE the read keeps the read on the outer catch', () => {
  const src = `
function f() {
  let tx = [];
  try {
    try { risky(); } catch {}
    tx = rows(\`SELECT id FROM league_transactions_raw WHERE league_id = ?\`, id);
  } catch { tx = []; } // OUTER
  return tx;
}`;
  assert.deepEqual(at(src, 'OUTER'), ['league_transactions_raw']);
});

test('S1c: an inner catch owns its own read, and the outer one is not charged with it', () => {
  // The inner catch is the one that swallows this fault. Reporting it twice
  // would inflate the count the sweep is read for, and would send whoever
  // fixes the inner one back to a site that no longer exists.
  const src = `
function f() {
  try {
    try {
      a = rows(\`SELECT id FROM negotiation_profiles\`);
    } catch { a = null; } // INNER
    b = 1;
  } catch { b = 0; } // OUTER
}`;
  assert.deepEqual(at(src, 'INNER'), ['negotiation_profiles']);
  assert.deepEqual(at(src, 'OUTER'), []);
});

test('S2: a try block longer than any fixed lookback is still scanned', () => {
  // 40 lines of filler between the read and the catch. server/ holds a real
  // span of 122; whatever number a cap picks, this test is the reason not to
  // pick one.
  const filler = Array.from({ length: 40 }, (_, i) => `    const v${i} = ${i};`).join('\n');
  const src = `
function f() {
  try {
    const tx = rows(\`SELECT id FROM league_transactions_raw\`);
${filler}
  } catch { tx = []; } // FAR
}`;
  assert.deepEqual(at(src, 'FAR'), ['league_transactions_raw']);
});

test('S3a: English prose in a comment is not a SQL read', () => {
  const src = `
function f() {
  try {
    // We read from the store and then update the cache from this table.
    /* Pulled from python, joined into the report. */
    hydrate();
  } catch {} // PROSE
}`;
  assert.deepEqual(at(src, 'PROSE'), []);
});

test('S3b: an import is not a SQL read', () => {
  const src = `
function f() {
  try {
    const { x } = await import('node:fs');
  } catch {} // IMPORT
}`;
  assert.deepEqual(at(src, 'IMPORT'), []);
});

test('S3c: a catch that binds its error is not a bare catch', () => {
  const src = `
function f() {
  try {
    rows(\`SELECT id FROM league_transactions_raw\`);
  } catch (err) { report(err); } // BOUND
}`;
  assert.deepEqual(at(src, 'BOUND'), []);
});

test('tablesIn reads FROM, JOIN, INTO and UPDATE, and no SQL keywords', () => {
  assert.deepEqual(tablesIn('SELECT * FROM a JOIN b ON 1 INSERT INTO c UPDATE d SET x = 1'),
    ['a', 'b', 'c', 'd']);
  assert.deepEqual(tablesIn('SELECT 1 FROM sqlite_master WHERE type = ?'), []);
});

test('migratedTables finds the tables this repo actually creates', () => {
  const found = migratedTables(['server/migrations', 'server/db/schema']);
  // `leagues` is created in server/db/schema/core-and-fantasy.js, which is
  // applied by migration 000_legacy_schema and is easy to forget is a source.
  assert.ok(found.has('leagues'), 'schema/ is a source of tables, not just migrations/');
  assert.ok(found.has('trade_outcomes'), 'migrations/ is a source of tables');
  // The site this whole sweep exists for: created by a script, by no migration.
  assert.equal(found.has('league_transactions_raw'), false);
});
