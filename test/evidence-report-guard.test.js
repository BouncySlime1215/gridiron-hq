/**
 * Two evidence generators wrote a finished-looking report from constants when
 * every real-data input was empty.
 *
 * `scripts/run-purged-evaluation.mjs` builds its bet-ledger universe by reading
 * the backfilled trial registry, and then pushes two HARDCODED rows
 * (`audit_registry#1`, `audit_registry#14`, lines 88-91) unconditionally. If the
 * registry read returns nothing -- an empty scratch database, a backfill that
 * failed and still exited 0, a schema change that renamed a `kind` -- those two
 * constants keep `sharpeByTrial` non-empty on their own. A deflated Sharpe
 * ratio is computed over them, `fs.writeFileSync` lands
 * `purged-evaluation-report.json`, and the script exits 0. Nothing in the run
 * says the statistics came from two literals in the source file.
 *
 * `scripts/run-historical-leaderboard.mjs` has no such constants and therefore
 * "survives" the same emptiness only by ACCIDENT: at :142 it calls
 * `sharpeByTrial.reduce((a, b) => ...)` with no initial value, which throws
 * `TypeError: Reduce of empty array with no initial value` -- two lines after
 * `sharpeMean` has already silently become NaN. A TypeError from a reduce is
 * not a guard. It names no cause, it fires only for one of the several ways the
 * inputs can be empty, and it says nothing at all when the real
 * `audit_registry` read returns zero rows while Group C returns some -- which is
 * the case that silently degrades the leaderboard back into stage 2's
 * hand-picked subset, the one thing this script exists to fix.
 *
 * The guard under test does three things, in this order:
 *
 *   1. names every real source it read, with a row count;
 *   2. refuses to write when a source that MUST be real is empty, naming all of
 *      them rather than the first;
 *   3. stamps those counts into the written report's `registry_summary`, so a
 *      report that ever does come out thin says so on its face rather than
 *      needing this comment to explain it.
 *
 * Point 2 is why the assertion has to run BEFORE the write and not around it: a
 * guard that throws after `writeFileSync` has already published the thing it
 * was guarding.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveOutDir, assertEvidenceSources, writeEvidenceReport, EmptyEvidenceSourceError,
} from '../scripts/lib/evidence-report.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `gridiron-evidence-${name}-`));

const REPORT = {
  generated_at: '2026-09-13T00:00:00.000Z',
  registry_summary: { total_trials_registered: 41, scored: 39 },
  deflated_sharpe_ratio: { dsr: 0.9412, best_observed_trial: { sharpe: 31.785 } },
};

test('a report built from real sources is written, with the source counts stamped in', () => {
  const outDir = path.join(tmp('write'), 'nested');
  const sources = { trial_registry_rows_read: 41, db_derived_bet_ledger_trials: 11,
    constant_bet_ledger_trials: 2 };

  const { file } = writeEvidenceReport({
    outDir, filename: 'purged-evaluation-report.json', report: REPORT, sources,
    required: ['trial_registry_rows_read', 'db_derived_bet_ledger_trials'],
  });

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written.registry_summary.sources, sources,
    'the counts must survive into the artifact; a guard that only logs to stderr '
    + 'tells nobody reading the committed report anything');
  assert.equal(written.registry_summary.total_trials_registered, 41,
    'stamping must not displace what registry_summary already carried');
});

test('the rest of the report is passed through untouched', () => {
  const outDir = tmp('passthrough');
  const { file } = writeEvidenceReport({
    outDir, filename: 'r.json', report: REPORT,
    sources: { a: 1 }, required: ['a'],
  });
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { registry_summary: _drop, ...rest } = written;
  const { registry_summary: _drop2, ...expected } = REPORT;
  assert.deepEqual(rest, expected,
    'the guard records provenance; it must not edit a single committed number');
});

test('an empty required source refuses the write, and writes nothing at all', () => {
  const root = tmp('refuse');
  const outDir = path.join(root, 'evidence');
  assert.throws(() => writeEvidenceReport({
    outDir, filename: 'purged-evaluation-report.json', report: REPORT,
    sources: { trial_registry_rows_read: 0, db_derived_bet_ledger_trials: 0,
      constant_bet_ledger_trials: 2 },
    required: ['trial_registry_rows_read', 'db_derived_bet_ledger_trials'],
  }), EmptyEvidenceSourceError);

  assert.equal(fs.existsSync(outDir), false,
    'the guard must run before the write AND before the mkdir. A guard that '
    + 'throws afterwards has already published the report it was guarding.');
});

test('the error names every empty source, not just the first one found', () => {
  let err;
  try {
    assertEvidenceSources(
      { trial_registry_rows_read: 0, sequence_length: 5, db_derived_bet_ledger_trials: 0,
        audit_registry_rows_read: 0 },
      ['trial_registry_rows_read', 'sequence_length', 'db_derived_bet_ledger_trials',
        'audit_registry_rows_read'],
    );
  } catch (e) { err = e; }

  assert.ok(err instanceof EmptyEvidenceSourceError, 'expected the named error');
  assert.deepEqual(err.emptySources,
    ['trial_registry_rows_read', 'db_derived_bet_ledger_trials', 'audit_registry_rows_read'],
    'reporting one empty source at a time turns one broken run into three');
  for (const k of err.emptySources) assert.match(err.message, new RegExp(k));
  assert.doesNotMatch(err.message, /sequence_length/,
    'a source that was fine must not be named as a cause');
});

test('a required source that is absent entirely counts as empty', () => {
  assert.throws(() => assertEvidenceSources({ trial_registry_rows_read: 41 },
    ['trial_registry_rows_read', 'audit_registry_rows_read']), EmptyEvidenceSourceError,
  'a renamed or forgotten key must fail loudly. Treating `undefined` as "not '
  + 'checked, therefore fine" is how the silent version of this bug comes back.');
});

test('a required source that is NaN counts as empty', () => {
  assert.throws(() => assertEvidenceSources({ n: Number.NaN }, ['n']),
    EmptyEvidenceSourceError);
});

test('a recorded-but-not-required source may legitimately be zero', () => {
  assert.doesNotThrow(() => assertEvidenceSources(
    { trial_registry_rows_read: 41, constant_bet_ledger_trials: 0, pbo_strategies_constant: 4 },
    ['trial_registry_rows_read'],
  ), 'constants are disclosed, not required. Requiring them would make the guard '
    + 'fire on a correct run, and a gate that fires on correct runs gets removed.');
});

test('resolveOutDir honours --out, and falls back when it is not usable', () => {
  const base = '/home/user/gridiron-hq';
  const fallback = path.join(base, 'docs/evidence/2026-09-13');

  assert.equal(resolveOutDir(['node', 'x.mjs', '--out', '/tmp/e'], fallback, base), '/tmp/e');
  assert.equal(resolveOutDir(['node', 'x.mjs', '--out', 'out/e'], fallback, base),
    path.join(base, 'out/e'), 'a relative --out resolves against the repo root, not the cwd');
  assert.equal(resolveOutDir(['node', 'x.mjs'], fallback, base), fallback);
  assert.equal(resolveOutDir(['node', 'x.mjs', '--out'], fallback, base), fallback,
    '--out as the last argument must not swallow undefined');
  assert.equal(resolveOutDir(['node', 'x.mjs', '--out', '--verbose'], fallback, base), fallback,
    '--out immediately followed by another flag is a missing value, not a directory named --verbose');
});
