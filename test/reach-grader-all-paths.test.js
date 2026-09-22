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
