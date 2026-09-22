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

// `resolveOutDir: false` means the generator had its own `--out` before this
// work and keeps it: `joint-score-report.mjs` parses flags with its own
// `value('out', …)` and takes a full PATH, not a directory. Asserting
// `resolveOutDir` there would force a worse interface for the sake of a
// uniform-looking test.
const GENERATORS = [
  { file: 'scripts/run-purged-evaluation.mjs', resolveOutDir: true },
  { file: 'scripts/run-historical-leaderboard.mjs', resolveOutDir: true },
  { file: 'scripts/freeze-baseline.mjs', resolveOutDir: true },
  { file: 'scripts/joint-score-report.mjs', resolveOutDir: false },
];

for (const { file, resolveOutDir } of GENERATORS) {
  const src = scan(fs.readFileSync(file, 'utf8'));
  const code = src.code;   // comments AND string bodies blanked — structural questions
  const text = src.text;   // comments blanked, strings intact — content questions

  test(`${file} writes its report only through the guard`, () => {
    assert.match(code, /writeEvidenceReport\s*\(/,
      'the report must be written by the guarded writer');
    assert.doesNotMatch(code, /writeFileSync\s*\(/,
      'a direct write beside the guarded one is the bug returning: the guard '
      + 'would still pass and the unguarded report would still land');
  });

  test(`${file} can write somewhere other than the committed evidence`, () => {
    // `resolveOutDir(` is a call, so it is asked of `code`. The flag name `'out'`
    // is a STRING, so it is asked of `text` — `code` blanks string bodies, and a
    // first version asked `code` for `value('out'` and failed on a correct file.
    // Same two views, same rule, and getting it backwards is how this thread's
    // own producer sweep once reported zero artifacts.
    assert.match(resolveOutDir ? code : text,
      resolveOutDir ? /resolveOutDir\s*\(/ : /value\s*\(\s*'out'/,
      'a hardcoded output directory is why these generators could never be '
      + 'exercised: every trial run overwrote the committed report it was '
      + 'meant to be checked against');
  });
}
