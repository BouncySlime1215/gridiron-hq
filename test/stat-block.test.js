/**
 * The stat block and the number roll, held to the rules that make them worth
 * having rather than to the fact that they compile.
 *
 * Both are small. Both are the kind of small thing that quietly loses its
 * reason: a caller adds a `label` prop "just for this one place", a hover state
 * gets applied to every block including the ones that open nothing, the roll
 * stops checking the reduced-motion preference in a refactor. None of those
 * break a build and all of them break the thing the component was for.
 *
 * Same honest limit as test/glossary-and-basis.test.js: this is a node:test
 * suite with no DOM, so these read the source text. What is pinned is what the
 * files say. It is stated here rather than implied.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const block = read('client/src/components/ui/StatBlock.tsx');
const roll = read('client/src/lib/useNumberRoll.ts');
const css = read('client/src/index.css');
const doc = read('docs/design/design-system.md');

test('a stat block cannot be given its own label', () => {
  // Rule 2. A caller that can pass a label is a caller that will, and then
  // `floor` means two things on one screen again — which is the defect the
  // glossary was written to end, reintroduced one prop at a time.
  const props = block.slice(block.indexOf('}: {'), block.indexOf('}) {'));
  assert.doesNotMatch(props, /^\s*label\??:/m, 'StatBlock takes a label prop again');
  assert.match(block, /const t = term\(id\)/, 'the label no longer comes from the glossary');
  assert.match(block, /\{t\.name\}/, 'the glossary name is no longer what renders');
});

test('the basis is required, and there is no way to render a number without one', () => {
  // Rule 3. 'missing' is how a caller says it has no basis, and it renders as
  // such. An optional basis would make "no chip" the path of least resistance.
  const props = block.slice(block.indexOf('}: {'), block.indexOf('}) {'));
  assert.match(props, /^\s*basis:\s*Basis;/m, 'basis became optional');
  assert.doesNotMatch(props, /^\s*basis\?:/m, 'basis became optional');
  assert.match(block, /<BasisChip basis=\{basis\}/, 'the chip is no longer rendered');
});

test('a stat block is not a card', () => {
  // Rule 1, and the reason `StatTile` in DesignSystem.tsx is not what this
  // extends: it wraps every number in a `.card`. Six bordered boxes in a row
  // read as six separate objects rather than six facts about one thing.
  assert.doesNotMatch(block, /className=["'][^"']*\bcard\b/, 'StatBlock is wrapping itself in a card');
  const rule = css.slice(css.indexOf('.stat-block {'), css.indexOf('.stat-block-label'));
  assert.match(rule, /border:\s*0/, '.stat-block grew a border');
  assert.match(rule, /background:\s*none/, '.stat-block grew a fill');
  assert.doesNotMatch(rule, /box-shadow:\s*(?!none)/, '.stat-block grew a shadow');
});

test('only a block that opens something looks like it opens something', () => {
  // A hover state that leads nowhere is a worse lie than no affordance.
  assert.match(block, /const interactive = typeof onOpen === 'function'/, 'interactivity is no longer conditional');
  assert.match(css, /\.stat-block\.is-interactive:hover/, 'the hover state is no longer scoped to interactive blocks');
  assert.doesNotMatch(css, /^\.stat-block:hover/m, 'every stat block now has a hover state');
  assert.match(css, /\.stat-block\.is-interactive:focus-visible/, 'an interactive block has no focus ring');
  assert.match(block, /'aria-label':/, 'a clickable number announces only its digits');
});

test('tone colours the number and never comes from the basis', () => {
  // A basis is an attribute, not a verdict. Wiring tone to basis would put the
  // whole separation back where it was.
  assert.match(block, /tone = 'neutral'/, 'tone lost its neutral default');
  assert.doesNotMatch(block, /tone\s*=\s*[^;\n]*basis/, 'tone is being derived from the basis');
  for (const t of ['good', 'crit']) {
    assert.match(css, new RegExp(`\\.stat-block-value\\.tone-${t}\\s*\\{\\s*color:\\s*var\\(--${t}\\)`),
      `tone-${t} no longer uses the semantic colour it names`);
  }
});

test('the roll never runs on first paint, under reduced motion, or below precision', () => {
  // The three bounds that keep this a signal rather than decoration. The design
  // system states them; this is where they are actually held.
  assert.match(roll, /window\.matchMedia\?\.\(REDUCED\)\.matches/, 'the reduced-motion check is gone');
  assert.match(roll, /prefers-reduced-motion: reduce/, 'the media query changed');
  assert.match(roll, /if \(prev == null \|\| target == null/, 'a value appearing from nothing now animates');
  assert.match(roll, /Math\.abs\(target - prev\) < step/, 'the below-precision guard is gone');
  assert.match(roll, /Math\.pow\(10, -precision\)/, 'the threshold is no longer the display precision');
});

test('the roll is bounded by the design token, and a broken token cannot hang it', () => {
  // A token that is missing or in an unexpected unit must not produce NaN, which
  // would leave a number mid-count forever.
  assert.match(roll, /--motion-reveal/, 'the roll no longer reads its duration from the token');
  assert.match(roll, /if \(!Number\.isFinite\(n\) \|\| n <= 0\) return 260/, 'a missing token can now produce NaN');
  assert.match(css, /^\s*--motion-reveal\s*:\s*260ms/m, 'the token and the fallback have drifted apart');
  assert.match(doc, /`--motion-reveal`/, 'the document no longer names the token the roll depends on');
});

test('the roll returns a number, so formatting stays in one place', () => {
  // Returning a formatted string would let a rolling value render at a different
  // precision from a settled one, which is the same drift in motion form.
  assert.match(roll, /\): number \| null \| undefined \{/, 'useNumberRoll no longer returns a number');
  assert.doesNotMatch(roll, /toFixed/, 'the roll is formatting, which is the glossary\'s job');
});

test('it cancels, so a value that changes twice does not leave two animations running', () => {
  assert.match(roll, /cancelAnimationFrame/, 'nothing cancels the frame');
  assert.match(roll, /return stop;/, 'the effect no longer cleans up on unmount');
});
