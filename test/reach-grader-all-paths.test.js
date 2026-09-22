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
import {
  BETTING_ENTRY_POINTS,
  buildImporterGraph,
  dropRouteBootEdges,
  gradeReach,
  isBettingEntryPoint,
  mountedRoutes,
  reachableEntries,
  repoGraph,
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

test('the betting entry points are exactly the three surfaces the contract names', () => {
  assert.deepEqual([...BETTING_ENTRY_POINTS].sort(), [
    'server/routes/betting-hub.js',
    'server/routes/nfl-betting.js',
    'server/routes/nfl-market.js',
  ]);
  assert.equal(isBettingEntryPoint('server/routes/model.js'), false);
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
