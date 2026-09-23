/**
 * The glossary and the basis chip, held to the rules they were written for.
 *
 * Both files exist to stop the same class of defect: a label or a provenance
 * claim written inline in one component, disagreeing with the same claim in
 * another. A test that only checked they compile would be worth nothing, so
 * these check the rules themselves:
 *
 *   - no `plain` sentence uses a word from the banned list, which is the whole
 *     of Nick's "make sense to someone who never deals with stats" rule and is
 *     the thing most likely to erode one careless entry at a time;
 *   - every basis tier the SERVER can emit has a chip tier, because a tier with
 *     no mapping renders nothing and the number then ships with no provenance
 *     at all — silently, which is the worst shape;
 *   - the two `floor` quantities stay separate, since collapsing them back into
 *     one word is the exact defect the glossary was written to end;
 *   - every tier has a colour from the basis ramp and none borrows a semantic
 *     colour.
 *
 * Read as source text rather than imported, because this is a JS test suite and
 * these are TS/TSX modules with no build step in the test run. That is a real
 * limit and it is stated here rather than hidden: these tests pin what the files
 * SAY, not what React renders. A DOM harness would be needed for the latter and
 * there is not one in this repo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const glossary = read('client/src/lib/glossary.ts');
const chip = read('client/src/components/ui/BasisChip.tsx');
const contingency = read('server/services/contingency.js');
const css = read('client/src/index.css');

/** Every `plain: '…'` sentence in a file, single- or double-quoted. */
const plains = src => [...src.matchAll(/\bplain:\s*(['"])((?:\\.|(?!\1).)*)\1/g)].map(m => m[2]);

test('no plain-words sentence uses a word the glossary bans', () => {
  const banned = [...glossary.matchAll(/'([a-z]+)'/g)]
    .map(m => m[1])
    .filter(w => glossary.slice(glossary.indexOf('BANNED_WORDS'), glossary.indexOf('] as const')).includes(`'${w}'`));
  assert.ok(banned.length >= 6, 'the banned list was not found — this test is checking nothing');

  const sentences = [...plains(glossary), ...plains(chip)];
  assert.ok(sentences.length >= 18, `expected the glossary and chip to carry their sentences, found ${sentences.length}`);
  for (const s of sentences) {
    for (const w of banned) {
      assert.doesNotMatch(s, new RegExp(`\\b${w}`, 'i'),
        `"${w}" appears in a plain-words sentence: ${s}`);
    }
  }
});

test('every availability basis the server can emit maps to a chip tier', () => {
  // The server's vocabulary. Since main's availability-basis.js landed, this is
  // no longer inline in contingency.js — contingency.js:610-611 now destructures
  // AVAILABILITY_FIT_BASIS from availability-basis.js and reads the canonical
  // list from there, so this test re-points to the same source rather than the
  // consumer, which is what the file's own header (availability-basis.js:1-15)
  // says every reader should do.
  assert.match(contingency, /const \[ROLE_FIT, POOLED_FIT, NO_FIT\] = AVAILABILITY_FIT_BASIS/,
    'contingency.js no longer derives its basis from AVAILABILITY_FIT_BASIS — re-point this test');
  const basisSrc = read('server/services/availability-basis.js');
  const line = basisSrc.match(/export const AVAILABILITY_FIT_BASIS = Object\.freeze\(\[([^\]]*)\]\)/);
  assert.ok(line, 'availability-basis.js no longer defines AVAILABILITY_FIT_BASIS where this test looks — re-point it');
  const served = [...line[1].matchAll(/'(\w+)'/g)].map(m => m[1]);
  assert.deepEqual(served, ['role', 'pooled', 'constants'], 'the server vocabulary changed');

  const map = chip.slice(chip.indexOf('AVAILABILITY_BASIS'), chip.indexOf('interface Tier'));
  for (const b of served) {
    assert.match(map, new RegExp(`\\b${b}:\\s*'`), `the server can emit '${b}' and the chip does not map it`);
  }
});

test('every chip tier has a sentence and a colour from the basis ramp', () => {
  const tiers = ['measured', 'fitted', 'pooled', 'assumed', 'none', 'missing'];
  for (const t of tiers) {
    const block = chip.match(new RegExp(`\\b${t}:\\s*\\{[^}]*\\}`, 's'));
    assert.ok(block, `tier ${t} has no record`);
    assert.match(block[0], /plain:\s*['"]/, `tier ${t} has no plain-words sentence`);
    assert.match(block[0], new RegExp(`var\\(--basis-${t}\\)`), `tier ${t} does not use its own ramp colour`);
  }
  // And the ramp colours exist. A var() naming a token nobody defined resolves
  // to nothing and the stripe silently disappears.
  for (const t of tiers) {
    assert.match(css, new RegExp(`^\\s*--basis-${t}\\s*:`, 'm'), `--basis-${t} is not defined`);
  }
});

test('the two floors stay two quantities under two names', () => {
  // The defect this file exists to end: `floor` meaning the 10th percentile of a
  // week in one place and the 20th of a season in another, both on one screen.
  assert.match(glossary, /week_floor:/, 'the weekly floor entry is gone');
  assert.match(glossary, /season_floor:/, 'the season floor entry is gone');
  const week = glossary.match(/week_floor:\s*\{[^}]*\}/s)[0];
  const season = glossary.match(/season_floor:\s*\{[^}]*\}/s)[0];
  const nameOf = b => b.match(/name:\s*'([^']*)'/)[1];
  assert.notEqual(nameOf(week), nameOf(season), 'both floors are back under one display name');
  assert.notEqual(week.match(/raw:\s*'([^']*)'/)[1], season.match(/raw:\s*'([^']*)'/)[1]);
});

test('every glossary entry is complete, because a half-filled entry is worse than none', () => {
  // A term with no raw column cannot be shown in a deep dive, and a term with no
  // precision renders at whatever the caller felt like, which is the thing the
  // fixed precision exists to prevent.
  const body = glossary.slice(glossary.indexOf('export const GLOSSARY'), glossary.indexOf('} as const satisfies'));
  const entries = [...body.matchAll(/^  (\w+):\s*\{/gm)].map(m => m[1]);
  assert.ok(entries.length >= 14, `expected the full glossary, found ${entries.length}`);
  for (const id of entries) {
    const block = body.match(new RegExp(`^  ${id}:\\s*\\{.*?^  \\}`, 'ms'));
    assert.ok(block, `${id} could not be read`);
    for (const field of ['name', 'plain', 'raw', 'unit', 'precision']) {
      assert.match(block[0], new RegExp(`\\b${field}:`), `${id} has no ${field}`);
    }
  }
});

test('a percentage is a fraction on the wire, and the formatter says so', () => {
  // The hundred-times-too-large bug. Every percent field in this app arrives
  // 0-1; an entry given `percent` for a field that already arrives in percent
  // renders 5730% and reads as a model fault for a week.
  assert.match(glossary, /multiplies/, 'the fraction convention is no longer stated');
  assert.match(glossary, /t\.unit === 'percent' \? value \* 100 : value/,
    'formatValue no longer scales percentages, so every percentage on the app renders as 0.x');
});

test('a missing number renders as a dash, never as zero', () => {
  // Different facts. This project has shipped the bug where they looked alike.
  assert.match(glossary, /if \(value == null \|\| !Number\.isFinite\(value\)\) return '—'/,
    'formatValue no longer distinguishes a missing number from a real one');
});

test('the sentence reaches a reader who is not using a mouse', () => {
  // A `title` attribute is a mouse affordance. On a touch screen it does not
  // exist, and a screen reader announces the visible word and offers no route to
  // the explanation — which would make the chip a coloured pill that says
  // "Rough" and means nothing. The whole sentence goes in the accessible name.
  assert.match(chip, /aria-label=\{`\$\{tier\.label\}\. \$\{title\}`\}/,
    'the chip no longer carries its sentence in its accessible name');
  // And BasisLine exists so at least one place per page says it out loud, since
  // a hover sentence is not a sentence on a phone.
  assert.match(chip, /export function BasisLine/, 'the spelled-out form is gone');
});

test('the chip refuses to render a tier it does not know', () => {
  // The alternative is a confident-looking pill with no colour and no sentence,
  // which asserts provenance it does not have.
  assert.match(chip, /if \(!tier\) return null/, 'an unknown basis now renders as an empty chip');
});
