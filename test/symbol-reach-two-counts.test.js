/**
 * Tests for scripts/symbol-reach.mjs -- reach at the unit CONTRACT.md §1
 * actually uses.
 *
 * §1 says the unit of an inventory row is a symbol. scripts/reach-grade.mjs
 * takes a file, and docs/tdd/reach-grader.tdd.md names that gap as the first
 * thing it does not settle. This closes it, and in doing so makes two rules
 * executable that were prose with nothing able to detect a violation:
 *
 *   §3, the two-counts rule. Excluding the defining file answers "is this
 *   imported", not "is this used". One filter, two incompatible questions,
 *   identical-looking output. It produced a false `dead` row on 2026-09-22
 *   (SEASON_ENDING_RE / RELEASED_RE), which was withdrawn.
 *
 *   The internal-use case. Five more false `dead` rows were nearly filed
 *   against contingency.js: exports with no importer that are called inside
 *   their own file on a reached path. `dead` is a deletion candidate;
 *   "exported and never imported" is a tidy-up. Never the first word on the
 *   second's evidence.
 *
 * Enclosing-declaration attribution is the crux and it is where the hand-rolled
 * version failed: it tracked only `export function` and credited a private
 * function's body to the exported one above it. `test('enclosingDeclaration
 * attributes a body to the private function ...')` is that exact shape,
 * modelled on contingency.js's non-exported fittedAvailability() sitting below
 * availabilityFitStamp. Positions come from the TypeScript parser rather than
 * from brace counting, because this codebase is full of regex literals and a
 * hand lexer cannot tell `/` division from `/` regex without being a parser.
 *
 * Fixtures are synthetic so the assertions pin the analyzer rather than
 * today's source. Two smoke assertions touch the repo, and both are the
 * measured cases the rules came from.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  consumerCounts,
  declarationsOf,
  enclosingDeclaration,
  gradeSymbol,
  importersOfSymbol,
  internalUses,
  repoSymbolReport,
} from '../scripts/symbol-reach.mjs';

/**
 * The shape that broke the first attributor: a private function below an
 * exported one, using the symbol under test in its body. Anything that tracks
 * `export function` alone credits the use to `stampAbove`.
 */
const PRIVATE_BELOW_EXPORT = `
import { BASIS } from './basis.js';

export function stampAbove(x) {
  return { x };
}

function fittedThing(rows) {
  return rows.map(r => r * BASIS);
}

export function publicCaller(rows) {
  return fittedThing(rows);
}
`;

test('enclosingDeclaration attributes a body to the private function that owns it, not the export above it', () => {
  const decls = declarationsOf(PRIVATE_BELOW_EXPORT, 'x.js');
  const uses = internalUses(PRIVATE_BELOW_EXPORT, 'x.js', 'BASIS');
  assert.equal(uses.length, 1, 'the import specifier must not count as a use');
  const owner = enclosingDeclaration(decls, uses[0].offset);
  assert.equal(owner.name, 'fittedThing',
    'crediting a private function body to the exported declaration above it is how the first '
    + 'attributor produced a wrong line attribution on contingency.js');
  assert.equal(owner.exported, false);
});

test('declarationsOf finds exported and non-exported declarations of every form', () => {
  const src = `
export function a() {}
function b() {}
export const c = () => {};
const d = function () {};
export class E {}
class F {}
export const { g, h } = obj;
`;
  const names = declarationsOf(src, 'x.js').map(d => d.name).sort();
  assert.deepEqual(names, ['E', 'F', 'a', 'b', 'c', 'd', 'g', 'h']);
  const exported = declarationsOf(src, 'x.js').filter(d => d.exported).map(d => d.name).sort();
  assert.deepEqual(exported, ['E', 'a', 'c', 'g', 'h']);
});

test('internalUses ignores the declaration itself, the export specifier, and same-named properties', () => {
  const src = `
export const ROLE_MAX_GAP = 3;
export { ROLE_MAX_GAP };
function user(o) {
  const local = o.ROLE_MAX_GAP;
  return local + ROLE_MAX_GAP;
}
`;
  const uses = internalUses(src, 'x.js', 'ROLE_MAX_GAP');
  assert.equal(uses.length, 1, 'o.ROLE_MAX_GAP is a property, not a reference to the binding');
  assert.equal(enclosingDeclaration(declarationsOf(src, 'x.js'), uses[0].offset).name, 'user');
});

test('consumerCounts reports BOTH counts, and they differ exactly where CONTRACT.md section 3 says they do', () => {
  const sources = {
    'server/services/defining.js': PRIVATE_BELOW_EXPORT.replace(/BASIS/g, 'SEASON_ENDING_RE'),
    'server/routes/model.js': "import { stampAbove } from '../services/defining.js';",
  };
  const counts = consumerCounts({
    files: Object.keys(sources),
    read: f => sources[f],
  }, 'server/services/defining.js', 'SEASON_ENDING_RE');

  assert.equal(counts.withoutDefiningFile, 0,
    'the import question: nothing outside the file imports it');
  assert.ok(counts.withDefiningFile > 0,
    'the usage question: it is used where it is defined, which is the evidence the exclusion throws away');
  assert.notEqual(counts.withDefiningFile, counts.withoutDefiningFile);
});

test('a symbol with no importer but a use inside its own file is internal-only, never dead', () => {
  const graded = gradeSymbol({
    name: 'SEASON_ENDING_RE',
    definingFile: 'server/services/defining.js',
    importers: [],
    internal: [{ line: 9, offset: 120, enclosing: { name: 'fittedThing', exported: false } }],
    fileGrade: { grade: 'wired', entries: ['server/routes/model.js'] },
  });
  assert.equal(graded.grade, 'internal-only');
  assert.notEqual(graded.grade, 'dead');
  assert.deepEqual(graded.usedInside, ['fittedThing']);
  assert.match(graded.reason, /export keyword/i,
    'the row must say what is actually unused: the export, not the code path');
});

test('a symbol with no importer and no internal use is unused-in-code, and still not dead in data', () => {
  const graded = gradeSymbol({
    name: 'resetAvailabilityCache',
    definingFile: 'server/services/defining.js',
    importers: [],
    internal: [],
    fileGrade: { grade: 'wired', entries: ['server/routes/model.js'] },
  });
  assert.equal(graded.grade, 'unused-in-code');
  assert.match(graded.reason, /quer/i,
    'CONTRACT.md: a grep finds dead-in-code; dead-in-data needs a query, and this tool ran none');
});

test('an internal use inside a declaration nothing reaches does not make the symbol internal-only', () => {
  const graded = gradeSymbol({
    name: 'helper',
    definingFile: 'server/services/orphan.js',
    importers: [],
    internal: [{ line: 4, offset: 40, enclosing: { name: 'alsoOrphaned', exported: true } }],
    fileGrade: { grade: 'unreached', entries: [] },
  });
  assert.equal(graded.grade, 'unreached',
    'a use on a path nothing reaches is not evidence of life; the file grade is the ceiling');
});

test('a symbol takes the grade of the entry points its importers reach, not the file it lives in', () => {
  const graded = gradeSymbol({
    name: 'linkPlayer',
    definingFile: 'server/services/shared.js',
    importers: [{ file: 'server/services/betting-fantasy-link.js', line: 3 }],
    internal: [],
    fileGrade: { grade: 'wired', entries: ['server/routes/model.js', 'server/routes/nfl-betting.js'] },
    importerGrades: {
      'server/services/betting-fantasy-link.js': { grade: 'wired-betting-only', entries: ['server/routes/nfl-betting.js'] },
    },
  });
  assert.equal(graded.grade, 'wired-betting-only',
    'the file is wired through routes/model.js, but nothing that imports THIS symbol is; '
    + 'grading the symbol by its file is the overstatement section 1 exists to prevent');
});

test('gradeSymbol always carries both counts, so a row cannot be filed on one of them', () => {
  const graded = gradeSymbol({
    name: 'x',
    definingFile: 'server/services/defining.js',
    importers: [{ file: 'server/routes/model.js', line: 2 }],
    internal: [{ line: 9, offset: 12, enclosing: { name: 'f', exported: true } }],
    fileGrade: { grade: 'wired', entries: ['server/routes/model.js'] },
    importerGrades: { 'server/routes/model.js': { grade: 'wired', entries: ['server/routes/model.js'] } },
  });
  assert.equal(typeof graded.counts.withDefiningFile, 'number');
  assert.equal(typeof graded.counts.withoutDefiningFile, 'number');
  assert.equal(graded.counts.withoutDefiningFile, 1);
  assert.equal(graded.counts.withDefiningFile, 2);
});

test('importersOfSymbol follows a renamed import and ignores a same-named export from elsewhere', () => {
  const sources = {
    'server/services/defining.js': 'export const FEATURE_NAMES = [];',
    'server/services/other.js': 'export const FEATURE_NAMES = [];',
    'server/routes/model.js': "import { FEATURE_NAMES as NAMES } from '../services/defining.js';",
    'server/routes/props.js': "import { FEATURE_NAMES } from '../services/other.js';",
  };
  const found = importersOfSymbol(
    { files: Object.keys(sources), read: f => sources[f] },
    'server/services/defining.js',
    'FEATURE_NAMES',
  );
  assert.deepEqual(found.map(f => f.file), ['server/routes/model.js'],
    'a name collision is not a reach: other.js defines its own FEATURE_NAMES');
  assert.equal(found[0].alias, 'NAMES');
});

test('smoke: SEASON_ENDING_RE is internal-only on this repo, which is the row that was withdrawn', () => {
  const report = repoSymbolReport('server/services/player-availability.js', ['SEASON_ENDING_RE']);
  const row = report.symbols[0];
  assert.equal(row.counts.withoutDefiningFile, 0, 'nothing outside the file imports it');
  assert.ok(row.counts.withDefiningFile > 0, 'it is used where it is defined');
  assert.equal(row.grade, 'internal-only');
  assert.ok(row.usedInside.length > 0, `expected an enclosing declaration, got ${JSON.stringify(row.usedInside)}`);
});
