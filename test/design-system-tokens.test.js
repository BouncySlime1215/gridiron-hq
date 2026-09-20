/**
 * The design system document and the stylesheet have to stay one thing.
 *
 * A design system that lives only in a markdown file is a document, and a
 * document drifts from the code the first time somebody is in a hurry. This
 * repository has already paid for exactly that shape twice: NAV_GROUPS and the
 * command palette kept two hand-maintained lists of the same destinations until
 * the palette silently could not reach a third of the app, and `floor` means two
 * different percentiles in two files under one label today.
 *
 * So these tests hold three things:
 *
 *   1. every token docs/design/design-system.md names is actually defined in
 *      client/src/index.css;
 *   2. the two existing animations read their timing from those tokens rather
 *      than from a second copy of the same numbers;
 *   3. the faces the document rejects have not reappeared as a default.
 *
 * The token names below are written out BY HAND. Scraping them out of either
 * file would make this agree with whichever side is wrong, which is the exact
 * defect it exists to catch — the rule the rest of this suite is built on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../client/src/index.css', import.meta.url), 'utf8');
const doc = fs.readFileSync(new URL('../docs/design/design-system.md', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');

/** Every token the document names, transcribed by hand from its tables. */
const TYPE = ['--font-body', '--font-display', '--font-mono',
  '--type-hero', '--type-stat', '--type-title', '--type-lead', '--type-body',
  '--type-note', '--type-label'];
const BASIS = ['--basis-measured', '--basis-fitted', '--basis-pooled',
  '--basis-assumed', '--basis-none', '--basis-missing'];
const MOTION = ['--motion-quick', '--motion-base', '--motion-reveal',
  '--motion-settle', '--motion-decay', '--ease-out', '--ease-inout'];

const defines = name => new RegExp(`^\\s*${name}\\s*:`, 'm').test(css);

test('every type token the document names is defined in the stylesheet', () => {
  for (const t of TYPE) assert.equal(defines(t), true, `${t} is in the document and not in the CSS`);
});

test('every basis token the document names is defined in the stylesheet', () => {
  for (const t of BASIS) assert.equal(defines(t), true, `${t} is in the document and not in the CSS`);
});

test('every motion token the document names is defined in the stylesheet', () => {
  for (const t of MOTION) assert.equal(defines(t), true, `${t} is in the document and not in the CSS`);
});

test('the document does not name a token the stylesheet has never heard of', () => {
  // The other direction. A token invented in prose and never written is worse
  // than one missing from the prose: somebody builds against it and gets the
  // browser's initial value with nothing failing.
  const named = [...doc.matchAll(/`(--[a-z0-9-]+)`/g)].map(m => m[1]);
  const orphans = [...new Set(named)].filter(t => !defines(t));
  assert.deepEqual(orphans, [], `the document names tokens no stylesheet defines: ${orphans.join(', ')}`);
});

test('the two existing animations read their timing from the tokens, not a second copy', () => {
  // These predate the design system and their values were kept exactly as they
  // were. The point of the change was to stop the numbers existing twice, so a
  // literal duration back on either rule means the drift has restarted.
  const rise = css.slice(css.indexOf('.tr-rise {'), css.indexOf('.tr-rise {') + 200);
  assert.match(rise, /var\(--motion-settle/, '.tr-rise went back to a hard-coded duration');
  assert.match(rise, /var\(--ease-out/, '.tr-rise went back to a hard-coded easing');

  const flash = css.slice(css.indexOf('.just-updated {'), css.indexOf('.just-updated {') + 200);
  assert.match(flash, /var\(--motion-decay/, '.just-updated went back to a hard-coded duration');
});

test('the basis ramp never borrows the semantic colours', () => {
  // A pooled number is not a problem with the manager's team. Defining a basis
  // token as var(--good) or var(--warn) would tell every reader it is one, and
  // the app's own comment above those tokens says they exist to keep that
  // distinction from collapsing.
  for (const t of BASIS) {
    const line = css.match(new RegExp(`^\\s*${t}\\s*:([^;]*);`, 'm'));
    assert.ok(line, `${t} is not defined`);
    assert.doesNotMatch(line[1], /var\(--(good|warn|crit|danger|accent)/,
      `${t} is defined in terms of a semantic or brand colour`);
  }
});

test('the body face is the chosen one, and degrades to what shipped before', () => {
  assert.match(css, /body\s*\{\s*font-family:\s*var\(--font-body\)/,
    'the body no longer reads the font token');
  const body = css.match(/^\s*--font-body:([^;]*);/m);
  assert.ok(body, '--font-body is not defined');
  assert.match(body[1], /'Archivo'/, 'the display/body face changed without the document changing');
  assert.match(body[1], /-apple-system/,
    'the previous stack is the fallback, so a blocked font request degrades to what shipped before');
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Archivo/,
    'the face is declared but never loaded');
});

test('the faces the document rejects have not come back as a default', () => {
  // Named in the document's own section 1: these are the faces that arrive when
  // nobody chose. The point of that section is that somebody chose.
  for (const face of ['Inter', 'Roboto', 'Poppins', 'Space Grotesk', 'Montserrat']) {
    assert.doesNotMatch(css, new RegExp(`font-family:[^;]*${face}`, 'i'),
      `${face} is back in a font stack`);
    assert.doesNotMatch(html, new RegExp(`family=${face.replace(' ', '\\+')}`, 'i'),
      `${face} is being loaded`);
  }
});

test('the document does not promise a dark palette the stylesheet does not have', () => {
  // This test exists because the document used to say "Every token above gets a
  // dark value" while index.css had no dark block at all and no token had a
  // dark value. A design system asserting something untrue about itself is the
  // same defect as a page printing a number with no basis, one level up.
  const hasMedia = /@media\s*\(prefers-color-scheme:\s*dark\)/.test(css);
  const hasAttr = /:root\[data-theme="dark"\]/.test(css);

  if (!hasMedia && !hasAttr) {
    assert.match(doc, /\*\*Not built\./,
      'the document describes a dark palette that the stylesheet does not define');
    assert.doesNotMatch(doc, /Every token above gets a dark value\./,
      'the document is promising dark values again');
    return;
  }

  // Dark has landed. Now the contract binds: all three states, every basis
  // token in each, or a token falls back to its light value in exactly one of
  // them and nothing fails.
  assert.ok(hasMedia && hasAttr,
    'dark is half-wired: the media query and the [data-theme="dark"] block must both exist, or an explicit choice loses to the OS');
  const blocks = [
    css.slice(css.indexOf('@media (prefers-color-scheme: dark)')),
    css.slice(css.indexOf(':root[data-theme="dark"]'))
  ];
  for (const block of blocks) {
    const scope = block.slice(0, block.indexOf('\n}\n') + 1);
    for (const t of BASIS) {
      assert.match(scope, new RegExp(`${t}\\s*:`), `${t} has no dark value in one of the two dark blocks`);
    }
  }
});
