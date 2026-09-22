/**
 * Tests for scripts/reach-grade.mjs -- the grader behind
 * docs/inventory/CONTRACT.md's `wired` / `wired-betting-only` split.
 *
 * The grade turns on ONE property: the *set* of entry points a module
 * reaches, not the first one a walk happens to find. The contract says so in
 * words ("trace every path to an entry point, not the first one"), and a rule
 * with no consumer that can detect its violation is decoration -- by the
 * contract's own test. This file is that consumer.
 *
 * So the assertions here are about THE ALGORITHM, not about today's import
 * graph. A test that asserted "player-week-engine.js is wired" would pass or
 * fail on whether someone moved an import last week, and would say nothing
 * about whether the grader is correct. Instead the fixtures are synthetic and
 * name the shape being pinned; exactly one assertion touches the real repo,
 * as a smoke check that the graph builder still parses this codebase at all.
 *
 * The regression this exists for is `test('a first-entry-point-only walk
 * mis-grades ...')`: it builds the wrong implementation on purpose, in the
 * fixture's dangerous ordering (the betting path SHORTER than the fantasy
 * one, so any breadth-first walk meets it first), and shows it produces
 * `wired-betting-only` where the truth is `wired`. That mis-grade is silent
 * and it moves a row out of the fantasy total -- the exact overstatement the
 * grade was added to prevent, inverted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BETTING_ENTRY_POINTS,
  buildImporterGraph,
  MLB_ENTRY_POINTS,
  classifyImportEdges,
  dropRouteBootEdges,
  gradeReach,
  isBettingEntryPoint,
  mountedRoutes,
  mountPaths,
  reachableEntries,
  repoGraph,
  routesUnderPrefixOf,
  surfaceLabel,
} from '../scripts/reach-grade.mjs';

/**
 * The shape the contract's worked example warns about, with the ordering that
 * makes a first-path walk wrong: the betting entry is TWO hops away and the
 * fantasy entry is THREE, so a breadth-first walk reaches the betting route
 * first and a walk that stops there never learns the module is also served
 * off a fantasy route.
 */
function twoEntryFixture() {
  return {
    'server/services/subject.js': ['server/services/betting-link.js', 'server/services/deep-helper.js'],
    'server/services/betting-link.js': ['server/routes/nfl-betting.js'],
    'server/services/deep-helper.js': ['server/services/mid-helper.js'],
    'server/services/mid-helper.js': ['server/routes/model.js'],
  };
}

const ENTRY = f => f.startsWith('server/routes/');

/**
 * The wrong implementation, written out so the difference is visible rather
 * than argued. It is a faithful breadth-first walk that returns as soon as it
 * has one entry point -- which is what "trace to an entry point" reads like
 * if you do not read the next sentence.
 */
function firstEntryOnly(importers, start, isEntry) {
  let frontier = [[start, [start]]];
  const seen = new Set([start]);
  while (frontier.length) {
    const next = [];
    for (const [node, trail] of frontier) {
      for (const up of importers[node] || []) {
        if (seen.has(up)) continue;
        seen.add(up);
        const t = [...trail, up];
        if (isEntry(up)) return new Map([[up, t]]);
        next.push([up, t]);
      }
    }
    frontier = next;
  }
  return new Map();
}

test('reachableEntries returns every reachable entry point, not the first one found', () => {
  const reach = reachableEntries(twoEntryFixture(), 'server/services/subject.js', { isEntry: ENTRY });
  assert.deepEqual(
    [...reach.entries.keys()].sort(),
    ['server/routes/model.js', 'server/routes/nfl-betting.js'],
    'the walk stopped early: a nearer entry point must not end the search',
  );
  assert.equal(reach.truncated, false);
});

test('a first-entry-point-only walk mis-grades a two-entry module as wired-betting-only', () => {
  const fixture = twoEntryFixture();
  const subject = 'server/services/subject.js';

  const wrong = firstEntryOnly(fixture, subject, ENTRY);
  assert.deepEqual([...wrong.keys()], ['server/routes/nfl-betting.js'],
    'fixture is wrong: the betting entry must be the one a first-path walk meets');
  assert.equal(
    gradeReach({ entries: wrong, truncated: false }).grade,
    'wired-betting-only',
    'the wrong walk must actually produce the wrong grade, or this test proves nothing',
  );

  const right = reachableEntries(fixture, subject, { isEntry: ENTRY });
  assert.equal(gradeReach(right).grade, 'wired',
    'one non-betting entry point is enough to make the row wired (CONTRACT.md section 2)');
});

test('the grade does not depend on the order importers are listed in', () => {
  const forward = twoEntryFixture();
  const reversed = Object.fromEntries(
    Object.entries(forward).map(([k, v]) => [k, [...v].reverse()]).reverse(),
  );
  const a = gradeReach(reachableEntries(forward, 'server/services/subject.js', { isEntry: ENTRY }));
  const b = gradeReach(reachableEntries(reversed, 'server/services/subject.js', { isEntry: ENTRY }));
  assert.equal(a.grade, b.grade);
  assert.deepEqual(a.entries, b.entries);
});

test('a module whose every path ends in a betting route grades wired-betting-only', () => {
  const fixture = {
    'server/services/subject.js': ['server/services/a.js', 'server/services/b.js'],
    'server/services/a.js': ['server/routes/nfl-market.js'],
    'server/services/b.js': ['server/routes/betting-hub.js'],
  };
  const graded = gradeReach(reachableEntries(fixture, 'server/services/subject.js', { isEntry: ENTRY }));
  assert.equal(graded.grade, 'wired-betting-only');
  assert.equal(graded.nonBetting.length, 0);
  assert.equal(graded.betting.length, 2, 'both betting entry points are reported, not just one');
});

test('a module no entry point reaches grades unreached, and says so rather than defaulting', () => {
  const fixture = {
    'server/services/subject.js': ['server/services/orphan.js'],
    'server/services/orphan.js': [],
  };
  const graded = gradeReach(reachableEntries(fixture, 'server/services/subject.js', { isEntry: ENTRY }));
  assert.equal(graded.grade, 'unreached');
  assert.deepEqual(graded.entries, []);
});

test('a cycle in the import graph terminates and does not hide the entry point behind it', () => {
  const fixture = {
    'server/services/subject.js': ['server/services/x.js'],
    'server/services/x.js': ['server/services/y.js'],
    'server/services/y.js': ['server/services/x.js', 'server/routes/model.js'],
  };
  const reach = reachableEntries(fixture, 'server/services/subject.js', { isEntry: ENTRY });
  assert.deepEqual([...reach.entries.keys()], ['server/routes/model.js']);
});

test('the reported path is a real import chain, each step importing the one before it', () => {
  const fixture = twoEntryFixture();
  const reach = reachableEntries(fixture, 'server/services/subject.js', { isEntry: ENTRY });
  for (const [entry, trail] of reach.entries) {
    assert.equal(trail[0], 'server/services/subject.js');
    assert.equal(trail.at(-1), entry);
    for (let i = 0; i < trail.length - 1; i += 1) {
      assert.ok(
        (fixture[trail[i]] || []).includes(trail[i + 1]),
        `${trail[i + 1]} does not import ${trail[i]}; the reported path is not a real chain`,
      );
    }
  }
});

test('a depth cut-off reports indeterminate, never a grade computed from a truncated walk', () => {
  const reach = reachableEntries(twoEntryFixture(), 'server/services/subject.js', { isEntry: ENTRY, maxDepth: 2 });
  assert.equal(reach.truncated, true, 'the fantasy entry is 3 hops away, so depth 2 must truncate');
  const graded = gradeReach(reach);
  assert.equal(graded.grade, 'indeterminate');
  assert.match(graded.reason, /truncat/i,
    'a truncated walk must say why it cannot grade, not silently report wired-betting-only');
});

test('a route file imported by server/index.js but never mounted is not an entry point', () => {
  const index = `
    const { default: modelRouter } = await import('./routes/model.js');
    const { default: ghostRouter } = await import('./routes/ghost.js');
    app.use('/api/model', ...legacyAuthenticated, modelRouter);
  `;
  const mounted = mountedRoutes(index);
  assert.ok(mounted.has('server/routes/model.js'));
  assert.ok(
    !mounted.has('server/routes/ghost.js'),
    'an imported-but-unmounted router is the orphaned-route case CONTRACT.md section 2 names; '
    + 'counting it as an entry point would grade every orphan wired',
  );
});

test('smoke: the graph builder still parses this repository, and player-week-engine.js is wired, not betting-only', () => {
  const { importers, isEntry } = repoGraph();
  assert.ok(Object.keys(importers).length > 100, 'the import graph came back empty or nearly so');

  const subject = 'server/services/player-week-engine.js';
  const graded = gradeReach(reachableEntries(importers, subject, { isEntry }));
  const entries = graded.entries;
  assert.ok(entries.includes('server/routes/model.js'),
    `expected a direct fantasy route among ${entries.join(', ')}`);
  assert.ok(entries.some(isBettingEntryPoint),
    `expected a betting route among ${entries.join(', ')}`);
  assert.equal(graded.grade, 'wired',
    'a module with both a betting and a non-betting entry point is wired (CONTRACT.md section 2)');
});

test('the betting entry points are an explicit list, and a mount prefix is not the test', () => {
  assert.deepEqual([...BETTING_ENTRY_POINTS].sort(), [
    'server/routes/betting-hub.js',
    'server/routes/execution-slate.js',
    'server/routes/nfl-betting.js',
    'server/routes/nfl-market.js',
    'server/routes/wong.js',
  ]);
  assert.equal(isBettingEntryPoint('server/routes/model.js'), false);

  // Both directions are live in this repo, which is why the list is the test.
  // wong.js is mounted UNDER /api/betting; execution-slate.js is mounted
  // outside it. A prefix rule catches the first and misses the second.
  assert.equal(isBettingEntryPoint('server/routes/wong.js'), true);
  assert.equal(isBettingEntryPoint('server/routes/execution-slate.js'), true);
});

test('buildImporterGraph reverses the arrows: it maps a module to the files importing it', () => {
  const sources = {
    'server/services/subject.js': 'export const x = 1;',
    'server/routes/model.js': "import { x } from '../services/subject.js';",
    'server/routes/ghost.js': "const { x } = await import('../services/subject.js');",
    'client/dist/bundle.js': "import { x } from '../../server/services/subject.js';",
  };
  const graph = buildImporterGraph({
    files: Object.keys(sources),
    read: f => sources[f],
  });
  assert.deepEqual(
    [...(graph['server/services/subject.js'] || [])].sort(),
    ['server/routes/ghost.js', 'server/routes/model.js'],
    'static and dynamic imports both count; build output under client/dist does not',
  );
});

/*
 * The two rules below were not written from the contract. They were written
 * after the first run of the finished grader against this repository returned
 * two answers that were wrong in the safe-looking direction, which is the only
 * direction that survives review.
 */

test('server/index.js importing an unmounted route is not a reach', () => {
  const raw = {
    'server/routes/ghost.js': new Set(['server/index.js']),
    'server/routes/model.js': new Set(['server/index.js']),
    'server/services/subject.js': new Set(['server/routes/ghost.js']),
  };
  const importers = dropRouteBootEdges(raw);
  const mounted = new Set(['server/routes/model.js']);
  const isEntry = f => mounted.has(f) || f === 'server/index.js';

  const graded = gradeReach(reachableEntries(importers, 'server/services/subject.js', { isEntry }));
  assert.equal(
    graded.grade, 'unreached',
    'an orphaned route is loaded at boot and its handlers never run; counting the boot '
    + 'import as a reach grades every orphan wired through server/index.js',
  );
  assert.ok(!graded.entries.includes('server/index.js'));
});

test('a module reached only by a hand-run script is graded hand-run-script, never unreached', () => {
  const fixture = {
    'server/services/subject.js': ['scripts/study-something.mjs'],
    'scripts/study-something.mjs': [],
  };
  const isHandRunScript = f => f.startsWith('scripts/');
  const reach = reachableEntries(fixture, 'server/services/subject.js', { isEntry: ENTRY });

  assert.equal(gradeReach(reach).grade, 'unreached',
    'with no hand-run predicate the walk finds no entry point, which is the flattening being fixed');
  const graded = gradeReach(reach, { isHandRunScript });
  assert.equal(graded.grade, 'hand-run-script');
  assert.deepEqual(graded.handRun, ['scripts/study-something.mjs']);
  assert.match(graded.reason, /types the command/,
    'CONTRACT.md: record it as reached from a hand-run script, never as wired');
});

test('a hand-run script does not upgrade or downgrade a module that also has a real entry point', () => {
  const fixture = {
    'server/services/subject.js': ['scripts/study-something.mjs', 'server/routes/model.js'],
    'scripts/study-something.mjs': [],
  };
  const graded = gradeReach(
    reachableEntries(fixture, 'server/services/subject.js', { isEntry: ENTRY }),
    { isHandRunScript: f => f.startsWith('scripts/') },
  );
  assert.equal(graded.grade, 'wired');
  assert.deepEqual(graded.handRun, []);
});

/*
 * Found while preparing a set-level diff against another thread's grader: 19 of
 * this repo's 31 route files came back `unreached`. A mounted route IS an entry
 * point, so that answer is impossible. The walk starts at the subject and only
 * ever tests the nodes it walks UP to, so the subject's own entry-point status
 * was never checked.
 */

test('a module that is itself an entry point is reached, by itself', () => {
  const importers = { 'server/routes/model.js': [] };
  const isEntry = f => f === 'server/routes/model.js';
  const reach = reachableEntries(importers, 'server/routes/model.js', { isEntry });

  assert.deepEqual([...reach.entries.keys()], ['server/routes/model.js'],
    'a mounted route grading `unreached` is impossible: it is the thing that serves');
  assert.deepEqual(reach.entries.get('server/routes/model.js'), ['server/routes/model.js'],
    'the path to itself is itself, with no hops');
  assert.equal(gradeReach(reach).grade, 'wired');
});

test('a betting route grades betting-only when nothing else reaches it', () => {
  const importers = { 'server/routes/nfl-betting.js': [] };
  const isEntry = f => f === 'server/routes/nfl-betting.js';
  const graded = gradeReach(reachableEntries(importers, 'server/routes/nfl-betting.js', { isEntry }));
  assert.equal(graded.grade, 'wired-betting-only',
    'counting a betting route as a non-betting reach for itself would hide it from the grade');
});

test('an unmounted route is still unreached: being a route file is not being an entry point', () => {
  const importers = { 'server/routes/ghost.js': [] };
  const isEntry = f => f === 'server/routes/model.js';
  const graded = gradeReach(reachableEntries(importers, 'server/routes/ghost.js', { isEntry }));
  assert.equal(graded.grade, 'unreached');
});

/*
 * Auditor R17.4: request reach and job reach are two kinds of reach and are
 * never summed. The mechanism that separates them is in the syntax, not in a
 * file name: an import at MODULE SCOPE runs when the module loads, so a handler
 * that loads the module has it; an import inside a FUNCTION BODY runs only when
 * that function is called, which for a scheduled job means only when the job
 * runs. `scheduler.js:1064` is the live case — a lazy `await import` inside a
 * job body — and naming the bucket "via scheduler.js" would have encoded one
 * file instead of the mechanism.
 */

test('classifyImportEdges puts a module-scope import in request reach and a function-body import in job reach', () => {
  const sources = {
    'a.js': `
import { x } from './b.js';

export async function job() {
  const { y } = await import('./c.js');
  return y;
}
`,
    'b.js': 'export const x = 1;',
    'c.js': 'export const y = 2;',
  };
  const { request, deferred } = classifyImportEdges({
    files: Object.keys(sources),
    read: f => sources[f],
  });
  assert.deepEqual([...(request['b.js'] || [])], ['a.js'],
    'a static import runs at load, so anything that loads a.js has b.js');
  assert.equal(request['c.js'], undefined,
    'a function-body import does not run at load; counting it as request reach is the error');
  assert.deepEqual([...(deferred['c.js'] || [])], ['a.js']);
});

test('a top-level await import is request reach, because it runs at load', () => {
  const sources = {
    'a.js': "const { y } = await import('./c.js');\nexport const z = y;",
    'c.js': 'export const y = 2;',
  };
  const { request, deferred } = classifyImportEdges({
    files: Object.keys(sources),
    read: f => sources[f],
  });
  assert.deepEqual([...(request['c.js'] || [])], ['a.js'],
    'server/index.js mounts every route this way; it is not deferred');
  assert.equal(deferred['c.js'], undefined);
});

test('job-reach-only is a grade about mechanism, and is never added to the request-reach total', () => {
  const request = { 'server/services/subject.js': [] };
  const deferred = { 'server/services/subject.js': ['server/services/job-host.js'] };
  const importers = { 'server/services/subject.js': ['server/services/job-host.js'],
    'server/services/job-host.js': ['server/routes/model.js'] };
  const isEntry = f => f.startsWith('server/routes/');

  const onRequest = gradeReach(reachableEntries(request, 'server/services/subject.js', { isEntry }));
  const onEither = gradeReach(reachableEntries(importers, 'server/services/subject.js', { isEntry }));

  assert.equal(onRequest.grade, 'unreached',
    'no handler reaches it: the only edge in is a function-body import');
  assert.equal(onEither.grade, 'wired');
  assert.notEqual(onRequest.grade, onEither.grade,
    'the two reaches disagree here, which is the whole reason they are reported apart');
  void deferred;
});

/*
 * Auditor R18.1: /api/mlb is not betting and is not the fantasy product either.
 * Folding it into wired-betting-only records a false fact the Phase A plan
 * reads; leaving it in the fantasy wired total hides the most droppable
 * category, since MLB is not in the approved product. It gets its own label on
 * the same explicit-list precedent, and betting-only is NOT renamed.
 */

const ENTRY_R = f => f.startsWith('server/routes/');

test('a module reached only through /api/mlb is mlb-only, not betting-only and not wired', () => {
  const fixture = { 'server/services/subject.js': ['server/routes/mlb.js'] };
  const graded = gradeReach(reachableEntries(fixture, 'server/services/subject.js', { isEntry: ENTRY_R }));
  assert.equal(graded.grade, 'wired-mlb-only');
  assert.deepEqual(graded.mlb, ['server/routes/mlb.js']);
  assert.deepEqual(graded.betting, [], 'calling this betting would state a false fact');
  assert.deepEqual(graded.fantasy, []);
});

test('betting and MLB together, with no fantasy route, is off-product — not folded into either', () => {
  const fixture = { 'server/services/subject.js': ['server/routes/mlb.js', 'server/routes/nfl-betting.js'] };
  const graded = gradeReach(reachableEntries(fixture, 'server/services/subject.js', { isEntry: ENTRY_R }));
  assert.equal(graded.grade, 'wired-offproduct-only');
  assert.equal(graded.betting.length, 1);
  assert.equal(graded.mlb.length, 1);
  assert.match(graded.reason, /no fantasy entry point/);
});

test('one fantasy route outweighs any number of off-product ones', () => {
  const fixture = {
    'server/services/subject.js': ['server/routes/mlb.js', 'server/routes/nfl-betting.js', 'server/routes/model.js'],
  };
  const graded = gradeReach(reachableEntries(fixture, 'server/services/subject.js', { isEntry: ENTRY_R }));
  assert.equal(graded.grade, 'wired');
  assert.deepEqual(graded.fantasy, ['server/routes/model.js']);
  assert.match(graded.reason, /fantasy product/);
});

test('the MLB surface list is explicit, and fantasy is the default for an unlisted route', () => {
  assert.deepEqual([...MLB_ENTRY_POINTS], ['server/routes/mlb.js']);
  assert.equal(surfaceLabel('server/routes/mlb.js'), 'mlb');
  assert.equal(surfaceLabel('server/routes/nfl-betting.js'), 'betting');
  assert.equal(surfaceLabel('server/routes/trades.js'), 'fantasy',
    'a route nobody has classified counts as product, so a new surface cannot silently leave the total');
});

test('every route mounted under a betting surface prefix is itself on the betting list', () => {
  /*
   * The family-level case, as a test rather than a rule. Wiring map labels a
   * route FAMILY only when every file under it carries the label, so one
   * unlisted sub-route un-labels the family and its modules count back into the
   * fantasy total. This grader labels route FILES, so there is no family to
   * un-label — but a new router mounted under `/api/betting` and never added to
   * the list would default to `fantasy`: safe for the total, and silent. This
   * makes it loud.
   */
  const { importers, isEntry } = repoGraph();
  void importers; void isEntry;
  const index = fs.readFileSync('server/index.js', 'utf8');

  const missed = [];
  for (const surface of BETTING_ENTRY_POINTS) {
    for (const under of routesUnderPrefixOf(index, surface)) {
      if (surfaceLabel(under.file) !== 'betting') missed.push(`${under.path} -> ${under.file}`);
    }
  }
  assert.deepEqual(missed, [],
    'a router mounted under a betting hub that is not on the betting list: decide its label, '
    + 'do not let it default to fantasy silently');
});

test('mountPaths pairs each mounted router with the path it is mounted at', () => {
  const index = `
    const { default: hubRouter } = await import('./routes/betting-hub.js');
    const { default: wongRouter } = await import('./routes/wong.js');
    app.use('/api/betting', ...auth, hubRouter);
    app.use('/api/betting/wong', ...auth, wongRouter);
  `;
  assert.deepEqual(mountPaths(index).sort((a, b) => a.path.localeCompare(b.path)), [
    { path: '/api/betting', file: 'server/routes/betting-hub.js' },
    { path: '/api/betting/wong', file: 'server/routes/wong.js' },
  ]);
  assert.deepEqual(
    routesUnderPrefixOf(index, 'server/routes/betting-hub.js'),
    [{ path: '/api/betting/wong', file: 'server/routes/wong.js' }],
    'wong sits under the hub; the hub does not sit under itself',
  );
});
