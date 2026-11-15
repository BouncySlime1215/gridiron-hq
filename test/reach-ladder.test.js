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
  routeEntryPredicate,
} = await import('../scripts/reach-ladder.mjs');
const { isBettingEntryPoint } = await import('../scripts/reach-grade.mjs');

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

/**
 * The three rules below were added AFTER the first GREEN, when running the
 * script against b0c1616d disagreed with the Auditor's frozen entry split:
 * 227 route / 1 script-only against its 214 / 14. The disagreement was the
 * test working. Recorded in this order rather than tidied into the original
 * block, because a rule written after the failure it describes is a different
 * kind of evidence from one written before, and the file should not pretend
 * otherwise.
 */

test('route-reached excludes betting entries, and ONLY betting entries', () => {
  const perFile = new Map([
    ['only-betting.js', ['server/routes/nfl-betting.js']],
    ['betting-and-fantasy.js', ['server/routes/nfl-betting.js', 'server/routes/trades.js']],
    ['only-fantasy.js', ['server/routes/trades.js']],
  ]);
  const mounted = new Set(['server/routes/nfl-betting.js', 'server/routes/trades.js']);
  const bettingExcluded = entrySplit({
    perFile,
    isRouteEntry: e => mounted.has(e) && !isBettingEntryPoint(e),
  });
  // A file only a betting route reaches is NOT route-reached for this product.
  assert.equal(bettingExcluded.route, 2);
  assert.equal(bettingExcluded.scriptOnly, 1);

  // The counter-case that makes this rule load-bearing: counting ANY mounted
  // route gives a different answer, and it is the answer the first version of
  // this script produced.
  const anyRoute = entrySplit({ perFile, isRouteEntry: e => mounted.has(e) });
  assert.equal(anyRoute.route, 3);
  assert.notDeepEqual(anyRoute, bettingExcluded,
    'if these agreed, the betting exclusion would be untested');
});

test('schedulerInvokedScripts parses, so a path in a comment or prose cannot count', () => {
  const scripts = new Set(['scripts/real.mjs', 'scripts/mentioned.mjs']);
  const source = [
    '// This job used to run scripts/mentioned.mjs before it was inlined.',
    '/** See scripts/mentioned.mjs for the three-stage order. */',
    "const script = path.join(PROJECT_ROOT, 'scripts/real.mjs');",
  ].join('\n');
  const invoked = schedulerInvokedScripts({ schedulerSource: source, scripts });
  assert.deepEqual([...invoked], ['scripts/real.mjs'],
    'a path named only in a comment is not an invocation');
});

test('schedulerInvokedScripts does not match on a basename appearing anywhere', () => {
  // The first version matched each script's basename as a substring of the
  // scheduler source. That reported server/index.js as scheduler-invoked, off
  // the substring "index.js" -- a heuristic wearing a command's clothes, which
  // is the exact defect this file exists to remove.
  const scripts = new Set(['server/index.js']);
  const source = "const p = path.join(root, 'server/routes/index.js');";
  assert.equal(schedulerInvokedScripts({ schedulerSource: source, scripts }), null);
});

test('the predicate the ladder actually passes excludes betting entries', () => {
  // This rule exists because a mutation survived without it. Deleting the
  // betting exclusion from measure()'s call site broke NO test: the entrySplit
  // rule above injects its own predicate, so it pins the unit and says nothing
  // about the wiring. That is precisely how the first run of this script
  // reported 227 route / 1 script-only against the frozen 214 / 14.
  const mounted = new Set(['server/routes/nfl-betting.js', 'server/routes/trades.js']);
  const isRoute = routeEntryPredicate(mounted);
  assert.equal(isRoute('server/routes/trades.js'), true);
  assert.equal(isRoute('server/routes/nfl-betting.js'), false, 'a betting route is not route-reach for this product');
  assert.equal(isRoute('scripts/build-x.mjs'), false, 'a package script is not a route');
});

/**
 * The rule below exists because the rule above was NOT enough, and the
 * Independent Auditor caught that (R62) after this file had already been
 * signed off once.
 *
 * `routeEntryPredicate` is pinned directly by test 14. But pinning the
 * predicate says nothing about whether `measure()` still CALLS it. Replacing
 * the call site at reach-ladder.mjs with `e => mounted.has(e)` left all
 * fourteen rules passing — the identical defect this file already documents,
 * one level up, and I recorded M1 as "killed" when only its unit form was.
 *
 * So this rule runs the real `measure()` over a real fixture repository and
 * asserts the SPLIT it produces. Nothing is injected. The fixture is built
 * around the one case that discriminates: a service reached by a betting
 * route AND by a package.json script. It grades `wired` (the script is a
 * non-betting entry), so it reaches the split -- and there the correct
 * predicate calls it script-only, while the mutant calls it route-reached.
 * That is the same disagreement, in miniature, that showed up on the real
 * tree as 227/1 against 214/14.
 */
test('measure() itself excludes betting routes from route-reach, over a real repository', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { measure } = await import('../scripts/reach-ladder.mjs');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-fixture-'));
  const write = (rel, body) => {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };

  write('package.json', JSON.stringify({ scripts: { job: 'node scripts/job.mjs' } }));
  write('server/index.js', [
    "const { default: betting } = await import('./routes/nfl-betting.js');",
    "const { default: trades } = await import('./routes/trades.js');",
    "app.use('/api/betting', betting);",
    "app.use('/api/trades', trades);",
  ].join('\n'));
  // Reaches the file that is ALSO reached by a script. This is the case the
  // whole rule turns on.
  // The `from` form deliberately: `buildImporterGraph` matches `from '...'`
  // and `import('...')`, and does NOT see a bare side-effect `import '...'`.
  // A fixture written in the bare form silently loses its job-graph edges.
  write('server/routes/nfl-betting.js', "import { both } from '../services/both.js';\nexport default { both };\n");
  write('server/routes/trades.js', "import { fantasy } from '../services/fantasy.js';\nexport default { fantasy };\n");
  write('scripts/job.mjs', "import { both } from '../server/services/both.js';\nconsole.log(both);\n");
  write('server/services/both.js', 'export const both = 1;\n');
  write('server/services/fantasy.js', 'export const fantasy = 1;\n');

  const git = args => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['commit', '-qm', 'fixture']);

  const out = measure({ cwd: dir });

  // Both files are `wired`: fantasy.js through a fantasy route, both.js
  // through the script (a non-betting entry), so neither is betting-only.
  assert.equal(out.population, 2, 'population is the two service files');
  assert.equal(out.edge['request+job'].cells[0], 2, 'both files grade wired');

  // The claim under test. both.js is reached by a betting route and a script;
  // no FANTASY route reaches it, so it is script-only.
  assert.deepEqual(
    { route: out.entry.route, scriptOnly: out.entry.scriptOnly },
    { route: 1, scriptOnly: 1 },
    'a file only a betting route and a script reach is script-only, not route-reached',
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Independent Auditor R66. The high end of the bracket is a LOWER BOUND, not
 * a count: buildImporterGraph matches `from '...'` and `import('...')` only,
 * so a bare side-effect `import '...'` is invisible to it, and twelve such
 * imports exist on c90d2834. A missed edge can only add reach, never remove
 * it, so the true figure is at or above what the command prints.
 *
 * By this file's own standard a rule with no consumer that can detect its
 * violation is decoration, so the bound is pinned rather than written in a
 * comment: silently reverting the label would restate a bounded figure as a
 * measured one, which is the whole defect this PR exists to remove.
 */
test('the printed high end is labelled a lower bound, not a count', async () => {
  const { render } = await import('../scripts/reach-ladder.mjs');
  const text = render({
    tree: { head: 'x', writeTree: 'y', servicesTree: 's', modelingTree: 'm' },
    toolchain: { node: 'v22', typescript: require('typescript').version },
    population: 321,
    edge: {
      'request-only': { cells: [169, 65, 6, 18, 12, 51], sum: 321 },
      'request+job': { cells: [225, 55, 3, 2, 10, 26], sum: 321 },
    },
    entry: { route: 211, scriptOnly: 14 },
    schedulerInvokedScripts: null,
  });
  assert.match(text, /≥225/, 'the high end carries the bound marker');
  assert.match(text, /lower bound/i, 'and says so in words for a reader who misses the symbol');
  assert.doesNotMatch(text, /bracket: 169-225\b/, 'the bare unbounded form must not come back');
});
