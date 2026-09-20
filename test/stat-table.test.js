/**
 * The design system's fifth component.
 *
 * The one it replaces, components/StatTable.tsx, was a rankings-only StatRow
 * and StatHeader pair: a hard-coded abbreviation map (TGT, RECY, RECTD),
 * `any`-typed rows, pre-system emerald/slate colours, and one caller. When that
 * caller (Rankings.tsx) was deleted it became unimported. It is replaced rather
 * than kept, because a table whose column names live inside itself is the
 * label-written-inline bug in grid form — the same defect the glossary exists
 * to end, one level up.
 *
 * Source text only: node:test has no build step and cannot import a .tsx.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const at = rel => new URL(`../${rel}`, import.meta.url);
const read = rel => fs.readFileSync(at(rel), 'utf8');
const table = read('client/src/components/ui/StatTable.tsx');
const css = read('client/src/index.css');
const doc = read('docs/design/design-system.md');

test('the old table is gone, not kept alongside the new one', () => {
  assert.equal(fs.existsSync(at('client/src/components/StatTable.tsx')), false,
    'both tables are in the tree, which is the thing this replaces');
  assert.equal(fs.existsSync(at('client/src/components/ui/StatTable.tsx')), true);
  // And its abbreviation map did not come with it. Checked below the header
  // comment, which names those abbreviations deliberately: explaining what was
  // replaced is not the same as shipping it, and a whole-file check would
  // forbid the explanation.
  const code = table.slice(table.indexOf("import type { ReactNode }"));
  for (const abbr of ['RECY', 'RECTD', 'rushAtt', 'colsFor', 'StatMode']) {
    assert.ok(!code.includes(abbr), `${abbr} survived the replacement`);
  }
});

test('the design system names five components, and the table is one', () => {
  // A component built without a spec is the gap this closes. The spec goes in
  // first; this asserts the document and the code agree that it exists.
  assert.match(doc, /^Five, named here so they are built once\./m,
    'section 4 still says four components');
  assert.match(doc, /^### Stat table$/m, 'the table has no section in the design system');
  const spec = doc.slice(doc.indexOf('### Stat table'), doc.indexOf('### Glossary'));
  assert.ok(spec.length > 800, 'the table section is a heading with nothing under it');
});

test('R1: a column is declared by glossary id and cannot be given a label', () => {
  // Rule 1, and the same rule StatBlock has. A caller that can pass a label is
  // a caller that will, and then one quantity has two names again.
  const iface = table.slice(table.indexOf('export interface StatColumn'), table.indexOf('export interface NotTrackedColumn'));
  assert.match(iface, /id: TermId;/, 'a column no longer keys off the glossary');
  assert.doesNotMatch(iface, /\blabel\b/, 'a column can be given its own label');
  assert.match(table, /const t = term\(col\.id\);/, 'the header text no longer comes from the glossary');
  assert.match(table, /formatValue\(col\.id, value/, 'cells are not formatted through the glossary');
});

test('R2: the basis is in the header once, and a cell marks itself only when it differs', () => {
  // Rule 2. A chip on every cell of a twenty-row table is noise nobody reads;
  // no chip at all puts the table back where this redesign started.
  assert.match(table, /<BasisChip basis=\{col\.basis\} note=\{col\.basisNote\}/,
    'the column header lost its basis');
  assert.match(table, /basis: Basis;/, 'a column no longer has to declare a basis');
  assert.match(table, /\{differs && differs !== col\.basis && \(/,
    'a cell marker shows even when it agrees with its column, or never shows at all');
});

test('R3: a number is coloured only by the lexicon direction, never by its basis', () => {
  // Rule 3. A basis is not a verdict, and `neither` — aDOT is the example — is
  // never coloured, because far downfield is not good or bad on its own.
  const tone = table.slice(table.indexOf('function toneFor'), table.indexOf('export default function StatTable'));
  assert.match(tone, /if \(better === 'neither'.*\) return 'neutral';/,
    "a 'neither' quantity can now be coloured");
  assert.match(tone, /if \(!col\.signed\) return 'neutral';/,
    'an unsigned column is being coloured against an invented zero point');
  assert.doesNotMatch(tone, /basis/, 'the tone is being decided from the basis');
});

test('R4: a quantity stored nowhere is a struck header, not a column of dashes', () => {
  // Rule 4. Em dashes read as "we have no data on this player". The truth is
  // "we have this on nobody". The four in this state are named in the design
  // system and must never appear as numbers.
  assert.match(table, /className="stat-table-not-tracked">\{col\.name\}/, 'a not-tracked column lost its name');
  assert.match(table, /<span className="stat-table-reason">Not tracked<\/span>/, 'it no longer says why');
  assert.match(table, /if \(!isTracked\(col\)\) return <td[^>]*aria-hidden="true" \/>/,
    'a not-tracked column is rendering cells, which is the column of dashes');
  const rules = css.slice(css.indexOf('.stat-table-not-tracked'), css.indexOf('.stat-table-row-head'));
  assert.match(rules, /text-decoration: line-through/, 'the struck header is no longer struck');
  assert.match(doc, /yards per route run and route participation/,
    'the design system stopped naming the quantities that are not stored');
});

test('the first column sticks, because this is read on a phone', () => {
  assert.match(table, /className="stat-table-row-head stat-table-sticky"/, 'the row head no longer sticks');
  const sticky = css.slice(css.indexOf('.stat-table-sticky {'), css.indexOf('.stat-table-sticky {') + 400);
  assert.match(sticky, /position: sticky/, 'the sticky column is not sticky');
  assert.match(sticky, /background: var\(--bg\)/,
    'a sticky column with no background lets the scrolling cells show through it');
  assert.match(css, /\.stat-table-scroll \{ overflow-x: auto/, 'the table no longer scrolls sideways');
});

test('R4: a missing value is an em dash, never a zero, and never an empty cell', () => {
  // A missing number and a zero are different facts, and this project has
  // shipped the bug where they looked the same. formatValue owns that.
  const glossary = read('client/src/lib/glossary.ts');
  assert.match(glossary, /if \(value == null \|\| !Number\.isFinite\(value\)\) return '—';/,
    'formatValue stopped distinguishing a missing number from a zero');
  assert.doesNotMatch(table, /\?\? 0\b/, 'the table is defaulting a missing value to zero');
});

test('the table has a consumer, or the design system says why it does not', () => {
  // useNumberRoll shipped in this same system fully tested and imported by
  // nothing, and its tests passed the whole time because they read the hook's
  // own source. A component nobody renders is dead code that reads as a
  // feature. This closes it from both sides: either a page imports the table,
  // or the document states it has no consumer and why — and when the first page
  // does import it, the statement must go, so the claim cannot rot.
  const files = [];
  const walk = dir => {
    for (const e of fs.readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`);
      else if (/\.tsx?$/.test(e.name)) files.push(`${dir}/${e.name}`);
    }
  };
  walk('client/src');
  assert.ok(files.length > 40, 'the client tree walk found almost nothing — this would pass vacuously');
  const consumers = files.filter(f =>
    f !== 'client/src/components/ui/StatTable.tsx' && /from '[^']*ui\/StatTable'/.test(read(f)));

  const spec = doc.slice(doc.indexOf('### Stat table'), doc.indexOf('### Glossary'));
  const declaresNoConsumer = /\*\*No page renders it yet/.test(spec);

  if (consumers.length === 0) {
    assert.ok(declaresNoConsumer,
      'the table is imported by nothing and the design system does not say so');
    assert.match(spec, /waiting on the normalised stat names/,
      'the reason it has no consumer is gone, leaving an unexplained orphan');
  } else {
    assert.equal(declaresNoConsumer, false,
      `${consumers[0]} renders the table, so the design system must stop saying no page does`);
  }
});
