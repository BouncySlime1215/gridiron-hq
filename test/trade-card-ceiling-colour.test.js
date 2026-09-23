/**
 * RL-3-3 (WORK-QUEUE C-13 / trade card): the Ceiling cell's colour on a trade
 * card follows a SUM of each player's own draft-day p80
 * (`RiskStrip.tsx`'s `ceilBetter = risk.in.p80 - risk.out.p80`), not the
 * lineup-level `ceiling_delta` already printed on the same card as "Weekly
 * ceiling" (TradeCard.tsx:122-126, trade-engine.js:1183 `lazyField(out,
 * 'ceiling_delta', ...)`). Summing p80 mostly tracks who receives more
 * players, and the row's own measurement puts it in contradiction with the
 * printed Weekly ceiling on 37-62 of 122-180 card sides (WORK-QUEUE.md
 * RL-3-3, R1 lead measured).
 *
 * No render harness exists for this client (see test/trade-manager-read.js:42
 * and test/trade-risk-strip-unreadable.test.js) — these are source-read /
 * extraction assertions, the idiom this repo already uses to pin RiskStrip.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const clientSrc = name => readFileSync(new URL(`../client/src/components/${name}`, import.meta.url), 'utf8');

/**
 * `ceilingBetter` must be a standalone, evaluable pure function (the same
 * idiom as `floorOf`/`ceilingOf` above it) that decides the Ceiling cell's
 * colour from the lineup-level ceiling_delta alone — never from `risk`.
 */
function extractCeilingBetter(src) {
  const m = src.match(/const ceilingBetter = \([^)]*\) =>[\s\S]*?;\n/);
  assert.ok(m, 'ceilingBetter could not be extracted — the Ceiling cell must be coloured by a '
    + 'standalone function of ceiling_delta, not inlined off risk.out.p80/risk.in.p80');
  const js = m[0].replace(/: number \| null \| undefined/, '').replace(/^const ceilingBetter = /, '');
  return eval(`(${js.replace(/;\n$/, '')})`);
}

test('RED/GREEN: the Ceiling cell colour follows ceiling_delta, not summed p80', () => {
  const src = clientSrc('trade/RiskStrip.tsx');
  const ceilingBetter = extractCeilingBetter(src);

  // Fixture: the package sent has a HIGHER summed p80 than the package received
  // (so the old p80-diff logic would colour "in" as WORSE, i.e. false/red),
  // but the lineup's own Weekly ceiling improves (ceiling_delta > 0, i.e. good).
  // The row's contract: the cell's colour must match ceiling_delta's sign.
  assert.equal(ceilingBetter(5.2), true,
    'a positive ceiling_delta (lineup ceiling improves) must colour the Ceiling cell good, '
    + 'regardless of which side\'s players carry the bigger summed p80');
  assert.equal(ceilingBetter(-3.1), false,
    'a negative ceiling_delta must colour the Ceiling cell bad');
  assert.equal(ceilingBetter(null), null, 'a missing ceiling_delta leaves the cell neutral');
  assert.equal(ceilingBetter(undefined), null, 'an undefined ceiling_delta leaves the cell neutral');
  assert.equal(ceilingBetter(0), null, 'a zero delta is a wash, not a colour');
});

test('the Ceiling cell in the component body is driven by the ceilingDelta prop, not risk.*.p80', () => {
  const src = clientSrc('trade/RiskStrip.tsx');
  // The component must accept a ceilingDelta prop...
  assert.match(src, /ceilingDelta/,
    'RiskStrip does not declare a ceilingDelta prop — TradeCard has nothing lineup-level to pass it');
  // ...and the Ceiling cell's colour argument must be computed from it, not
  // from a p80 difference between the two packages.
  const ceilCellLine = src.match(/cell\('Ceiling',[\s\S]*?\)\)?\}/)?.[0]
    ?? src.match(/cell\('Ceiling'.*\n?.*/)?.[0] ?? '';
  assert.ok(ceilCellLine, 'Ceiling cell call not found');
  assert.doesNotMatch(ceilCellLine, /ceilBetter\b/,
    'the Ceiling cell is still coloured from ceilBetter (a summed-p80 diff), not ceilingDelta');
});

test('TradeCard passes the lineup-level ceiling_delta into RiskStrip at both call sites', () => {
  const src = clientSrc('TradeCard.tsx');
  const sideBoxCall = src.match(/<RiskStrip risk=\{s\.risk\}[^/]*\/>/)?.[0] ?? '';
  const compactCall = src.match(/<RiskStrip risk=\{deal\.me\.risk\}[^/]*\/>/)?.[0] ?? '';
  assert.match(sideBoxCall, /ceilingDelta=\{s\.ceiling_delta\}/,
    `SideBox's RiskStrip (TradeCard.tsx ~138) does not pass ceilingDelta={s.ceiling_delta}: got \`${sideBoxCall}\``);
  assert.match(compactCall, /ceilingDelta=\{deal\.me\.ceiling_delta\}/,
    `the compact RiskStrip (TradeCard.tsx ~280) does not pass ceilingDelta={deal.me.ceiling_delta}: got \`${compactCall}\``);
});
