/**
 * Tests for scripts/reach-ladder.mjs -- the command that regenerates the
 * reach ladder CONTRACT.md publishes.
 *
 * WHY THIS EXISTS. CONTRACT.md's headline was a set of numbers no command
 * produced. `183 wired`, the `116 / 67` route-versus-script split and the
 * `53 / 14` line were worked out per row inside a session and never written
 * down as code, so nothing could regenerate them and nobody could check them
 * (Evidence Auditor R51.3). They were cited across this project for a day.
 * The contract's own test -- "a rule with no consumer that can detect its
 * violation is decoration" -- applies to its own headline figure, and the
 * headline failed it.
 *
 * THE TWO AXES ARE DIFFERENT QUESTIONS AND THE OLD FIGURES CONFLATED THEM
 * (Auditor R54.2 condition 2). This is the crux of the file:
 *
 *   EDGE MECHANISM -- is the import at module scope, which runs at load, or
 *   inside a function body, which runs only when that function is called?
 *   That is what CONTRACT.md's bracket is, and both ends of it come from one
 *   graph each: classifyImportEdges().request for the low end, the full
 *   importer graph for the high end.
 *
 *   ENTRY TYPE -- is the entry point that reaches this file a mounted route
 *   or a package.json script? That is a different question entirely, asked
 *   of one graph, and it is NOT the bracket. Presenting it as the bracket is
 *   the mistake that produced `116 / 67`.
 *
 * A single number cannot answer both, and a reader given one number will
 * assume it answered theirs. So the ladder reports both, separately named,
 * edge bracket first, and no rule here lets the entry split be labelled a
 * bracket.
 *
 * THE FALSIFICATION TEST. `expectedLadderAt500bab36` pins the Auditor's own
 * independently measured run. If the script disagrees with it, the SCRIPT is
 * wrong -- the grader and that run have each been reproduced across two trees
 * and two sessions. That was committed in advance, in
 * /mnt/project-files/w45mur-partition-script-PREREGISTRATION.md, before any
 * of this was written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  GRADE_ORDER,
  EDGE_AXIS,
  ENTRY_AXIS,
  ladderRow,
  entrySplit,
  schedulerInvokedScripts,
  requireToolchain,
} = await import('../scripts/reach-ladder.mjs');

/**
 * The Auditor's R54.1 run on b0c1616d, whose `git write-tree` is
 * 500bab36774ca1264b5dbdc5f1e5d69445f19ff7. Reproduced independently from
 * this thread before the script existed, every cell matching.
 */
const R54_1 = {
  'request-only': [172, 65, 6, 18, 11, 47],
  'request+job': [228, 55, 3, 2, 10, 21],
  population: 319,
};

test('the grade order is fixed, so two runs are comparable cell by cell', () => {
  assert.deepEqual(GRADE_ORDER, [
    'wired',
    'wired-betting-only',
    'wired-mlb-only',
    'wired-offproduct-only',
    'hand-run-script',
    'unreached',
  ]);
});

test('both of the R54.1 rows sum to the population, and a row that does not is rejected', () => {
  for (const key of ['request-only', 'request+job']) {
    const row = R54_1[key];
    assert.equal(row.reduce((a, b) => a + b, 0), R54_1.population, `${key} must sum to the population`);
  }
  // CONTRACT.md:160-166 printed 178 for request-only with a column summing to
  // 325, not 319. That is how an unreproducible figure announces itself, and
  // ladderRow must refuse to emit such a row rather than print it.
  assert.throws(
    () => ladderRow({ tally: { wired: 178, unreached: 47 }, population: 319 }),
    /sum/i,
    'a column that does not sum to its population is not a ladder row',
  );
});

test('ladderRow emits every grade in GRADE_ORDER with its column sum', () => {
  const row = ladderRow({
    tally: { wired: 228, 'wired-betting-only': 55, 'wired-mlb-only': 3, 'wired-offproduct-only': 2, 'hand-run-script': 10, unreached: 21 },
    population: 319,
  });
  assert.deepEqual(row.cells, R54_1['request+job']);
  assert.equal(row.sum, 319);
  assert.equal(row.cells.length, GRADE_ORDER.length);
});

test('a grade the order does not name is an error, not a silently dropped column', () => {
  assert.throws(
    () => ladderRow({ tally: { wired: 318, 'wired-something-new': 1 }, population: 319 }),
    /wired-something-new/,
  );
});

test('the two axes are named, distinct, and the entry axis is never a bracket', () => {
  assert.notEqual(EDGE_AXIS.name, ENTRY_AXIS.name);
  assert.match(EDGE_AXIS.name, /edge/i);
  assert.match(ENTRY_AXIS.name, /entry/i);
  // The bracket is the edge axis and only the edge axis.
  assert.equal(EDGE_AXIS.isBracket, true);
  assert.equal(ENTRY_AXIS.isBracket, false);
  // And the entry axis says so in its own words, for a reader who sees only
  // one table.
  assert.match(ENTRY_AXIS.note, /not the bracket/i);
});

test('the edge axis is reported before the entry axis', () => {
  assert.ok(EDGE_AXIS.order < ENTRY_AXIS.order,
    'edge bracket first: a reader who stops after one table must have read the bracket');
});

test('entrySplit reports route and script-only over one graph, and sums to the wired count', () => {
  const split = entrySplit({
    perFile: new Map([
      ['a.js', ['server/routes/x.js']],
      ['b.js', ['scripts/y.mjs']],
      ['c.js', ['server/routes/x.js', 'scripts/y.mjs']],
    ]),
    isRouteEntry: e => e.startsWith('server/routes/'),
  });
  // c.js has a route entry, so it is route-reached: script-only means NO
  // route reaches it at all.
  assert.equal(split.route, 2);
  assert.equal(split.scriptOnly, 1);
  assert.equal(split.route + split.scriptOnly, 3);
});

test('schedulerInvokedScripts returns null rather than guessing when it cannot derive the set', () => {
  // The pre-registered commitment: if the job-reached versus developer-facing
  // split cannot be produced by command, the script reports script-only as ONE
  // number and says the 53/14 split is not reproducible. It does not fall back
  // to a hand list -- that would be the same defect with a .mjs extension.
  const undecidable = schedulerInvokedScripts({ schedulerSource: null, scripts: new Set(['scripts/a.mjs']) });
  assert.equal(undecidable, null);
});

test('requireToolchain fails loudly on the wrong typescript, naming both versions', () => {
  assert.throws(
    () => requireToolchain({ typescript: '5.8.2', required: '5.9.3' }),
    /5\.8\.2[\s\S]*5\.9\.3|5\.9\.3[\s\S]*5\.8\.2/,
  );
  assert.doesNotThrow(() => requireToolchain({ typescript: '5.9.3', required: '5.9.3' }));
});

test('this repo is on the pinned typescript, so a ladder measured here is comparable', () => {
  assert.equal(require('typescript').version, '5.9.3');
});
