/**
 * Nothing prints "Calibrated" off a number that is not a calibration.
 *
 * `DesignSystem.tsx` exported a `<Confidence>` component that took a `coverage`
 * fraction and rendered one of four words: `Uncalibrated`, `Calibrated` at
 * `>= .78`, `Developing` at `>= .65`, `Low confidence` below that. Three things
 * were wrong with it and only one of them is that nothing rendered it.
 *
 *   1. **It is the wrong quantity.** Coverage is how much data you have.
 *      Calibration is whether the predictions matched the outcomes. A model can
 *      have complete coverage and be badly calibrated, and the component would
 *      call it Calibrated. The thresholds .78 and .65 have nothing behind them.
 *
 *   2. **It grants the claim with no fit id.** `BasisChip`'s `fitted` tier is
 *      defined as "a model fitted on history, with a fit id behind it"
 *      (BasisChip.tsx:48). That is the vocabulary this app settled on, and it
 *      exists precisely so a number cannot claim a model without naming one.
 *      `<Confidence>` handed out a stronger word than `fitted` for free.
 *
 *   3. **This project measured confidence tiers and rejected them.**
 *      `docs/HISTORICAL-TESTS.md:27` records a preregistered null — "confidence
 *      tiers have now failed on clean data in multiple independent passes" —
 *      and the row below it, "No edge and no usable confidence tier, across
 *      every forecaster tested". Shipping the rejected idea as a ready-made
 *      component is how it comes back.
 *
 * So the component is gone, and these tests are what stops it returning. They
 * are deliberately about the CLAIM, not about the file: any component anywhere
 * that turns a number into a calibration verdict fails the first test.
 *
 * Honest limit: node:test, no DOM, source text only.
 *
 * Note on what is NOT asserted here: seven other design-system exports have no
 * consumer either (`Section`, `StatTile`, `Provenance`, `Distribution`,
 * `DriverBars`, `ErrorState`, `DataTable`). Those stay. A design system is
 * allowed to hold a component nobody has adopted yet — that is the difference
 * between an unadopted component and a wrong one, and only the wrong one is
 * being removed. The third test pins the list so the next arrival is deliberate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const CLIENT = url.fileURLToPath(new URL('../client/src', import.meta.url));

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(CLIENT);

test('C1: no component turns a number into a calibration verdict', () => {
  assert.ok(FILES.length > 50, `only ${FILES.length} client files were walked — the walker is not reaching the tree`);
  // The four words the removed tier ladder printed. Banned as string literals:
  // prose about calibration is fine, a rendered verdict is not.
  const VERDICTS = ["'Calibrated'", "'Uncalibrated'", "'Developing'", "'Low confidence'",
    '"Calibrated"', '"Uncalibrated"', '"Developing"', '"Low confidence"'];
  const offenders = [];
  for (const file of FILES) {
    const src = fs.readFileSync(file, 'utf8');
    for (const verdict of VERDICTS) {
      if (src.includes(verdict)) offenders.push(`${path.relative(CLIENT, file)} renders ${verdict}`);
    }
  }
  assert.deepEqual(offenders, [],
    `a calibration verdict is being rendered from something that is not a calibration: ${offenders.join(', ')}`);
});

test('C2: the design system exports no confidence tier', () => {
  const src = fs.readFileSync(path.join(CLIENT, 'components/ui/DesignSystem.tsx'), 'utf8');
  assert.doesNotMatch(src, /export function Confidence\b/,
    'the confidence tier is back in the design system');
  assert.doesNotMatch(src, /coverage\s*>=?\s*\.?\d/,
    'a coverage number is being compared to a bare threshold to produce a label');
});

test('C3: the design system\'s exported surface is pinned, so a new one is deliberate', () => {
  const src = fs.readFileSync(path.join(CLIENT, 'components/ui/DesignSystem.tsx'), 'utf8');
  const exported = [...src.matchAll(/^export function ([A-Za-z]+)/gm)].map(m => m[1]).sort();
  assert.deepEqual(exported, [
    'Card', 'DataTable', 'Distribution', 'DriverBars', 'EmptyState', 'ErrorState',
    'PageHeader', 'Provenance', 'Section', 'Sheet', 'Skeleton', 'StatTile', 'ToastProvider'
  ], 'the design system gained or lost a component — if that was on purpose, say so here');
});
