/**
 * The guard has to be ON the write path, not merely available beside it.
 *
 * `test/evidence-report-guard.test.js` proves the guard refuses an empty run.
 * It cannot prove that either generator ASKS it to. Both scripts run a full
 * registry backfill in a child process and read `server/data.sqlite`, so
 * exercising them end-to-end inside `npm test` is neither cheap nor
 * reproducible on a fresh clone -- which is exactly why nothing has ever
 * exercised them, and exactly the generator-coverage gap this thread has been
 * closing elsewhere.
 *
 * So the property asserted here is structural and deliberately narrow: neither
 * script writes its report itself. `writeEvidenceReport` asserts before it
 * creates anything, so if it is the ONLY way a report leaves these files, the
 * guard cannot be bypassed by a later edit that adds a second write beside it.
 * That is a claim about the call graph, which is a structural question, so it
 * is asked of `scan(src).code` -- comments and string bodies blanked -- and not
 * of the raw text, where a `writeFileSync` named in a comment would read as a
 * call and a real call inside a template string would not.
 *
 * What this does NOT prove, stated plainly so nobody quotes it as more: that
 * the counts each script passes are the real row counts rather than literals.
 * That is settled by running them, and the run is recorded in
 * docs/tdd/evidence-report-guard.tdd.md, not here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scan } from '../scripts/wiring-map.mjs';

const GENERATORS = [
  'scripts/run-purged-evaluation.mjs',
  'scripts/run-historical-leaderboard.mjs',
];

for (const file of GENERATORS) {
  const code = scan(fs.readFileSync(file, 'utf8')).code;

  test(`${file} writes its report only through the guard`, () => {
    assert.match(code, /writeEvidenceReport\s*\(/,
      'the report must be written by the guarded writer');
    assert.doesNotMatch(code, /writeFileSync\s*\(/,
      'a direct write beside the guarded one is the bug returning: the guard '
      + 'would still pass and the unguarded report would still land');
  });

  test(`${file} takes --out so it can be run without overwriting committed evidence`, () => {
    assert.match(code, /resolveOutDir\s*\(/,
      'a hardcoded output directory is why this generator could never be '
      + 'exercised: every trial run overwrote the committed report it was '
      + 'meant to be checked against');
  });
}
