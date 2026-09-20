/**
 * Every paired comparison in the model chain must be clustered, and must say so (2026-09-20).
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION. `pairedBootstrapDiff` degrades quietly by design: it
 * takes `groups` as an option, and when the array it is handed does not line up it falls back to
 * an UNGROUPED resample and returns an interval anyway. That interval is narrower than the truth
 * -- `backtest-significance.js` documents exactly that failure mode -- so a caller that meant to
 * cluster and silently stopped clustering reports more confidence than it has, with nothing in
 * the result saying the clustering was dropped.
 *
 * `clusteredDiff` (pooled-arms.js) is the same comparison with the degradation removed: it
 * refuses two value arrays of different lengths, and it THROWS when clustering was asked for and
 * declined, rather than returning an unclustered interval that reads identically to a clustered
 * one. A caller that has a genuine reason to want the ungrouped resample still has
 * `pairedBootstrapDiff`; what it does not have is the accident.
 *
 * The three call sites below all build their error arrays and their `groups` in lockstep from one
 * source array, so all three are correct TODAY. That is the reason to pin it: this defect has
 * already shipped once in `offseason-model.js`, where a lazily-built arm made one array shorter,
 * the `groups.length === n` guard was satisfied by the shorter one, and the clustered branch ran
 * on a pairing that compared one season's rows against another's. It inverted the verdict. The
 * lockstep here is one careless `.filter()` away from the same shape.
 *
 * WHY THIS CHECKS USAGE AND NOT THE IMPORT LINE. An earlier test in this project asserted which
 * name a file imported and was satisfied by a file that imported it and then did not use it. So
 * this asserts the identifier does not appear in the file's CODE at all, with comments stripped,
 * because prose that discusses `pairedBootstrapDiff` is exactly what the header above is doing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * Line and block comments removed, so a mention in prose does not count as a call. Crude on
 * purpose: it does not parse strings, and neither file contains the identifier in a string.
 */
const codeOf = file => fs.readFileSync(file, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const CALLERS = [
  'server/services/nfl-offseason-change.js',
  'server/services/nfl-team-strength.js',
  'server/services/offseason-model.js'
];

for (const file of CALLERS) {
  test(`${file} compares through clusteredDiff, which cannot silently stop clustering`, () => {
    const code = codeOf(file);
    assert.ok(code.includes('clusteredDiff'),
      'the guarded comparison must be the one this file calls');
    assert.equal(code.includes('pairedBootstrapDiff'), false,
      'no pairedBootstrapDiff in this file\'s code: it returns an unclustered interval rather '
      + 'than refusing, and the two results are indistinguishable at the call site');
  });
}

test('every clusteredDiff call in the model chain passes groups', () => {
  // `clusteredDiff` throws without `groups`, so this is belt and braces -- but it throws at run
  // time on a path that needs real history to reach, and this fails at test time.
  for (const file of CALLERS) {
    const code = codeOf(file);
    for (const call of code.match(/clusteredDiff\(([\s\S]*?)\);/g) ?? []) {
      assert.match(call, /groups/,
        `${file}: a clusteredDiff call with no groups would throw where it runs: ${call.slice(0, 80)}`);
    }
  }
});
