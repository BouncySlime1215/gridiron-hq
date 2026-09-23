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
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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
  const ceilCellLine = src.match(/(?:cell|single)\('Ceiling',[\s\S]*?\)\)?\}/)?.[0]
    ?? src.match(/(?:cell|single)\('Ceiling'.*\n?.*/)?.[0] ?? '';
  assert.ok(ceilCellLine, 'Ceiling cell call not found');
  assert.doesNotMatch(ceilCellLine, /ceilBetter\b/,
    'the Ceiling cell is still coloured from ceilBetter (a summed-p80 diff), not ceilingDelta');
  // Skeptic round: a stray `ceilingDelta` token elsewhere is not enough — the
  // cell itself must take its colour from ceilingBetter(ceilingDelta) and read
  // no package p80 for its text or its colour.
  assert.match(ceilCellLine, /ceilingBetter\(ceilingDelta\)\)\}/,
    `the Ceiling cell's colour argument is not exactly ceilingBetter(ceilingDelta): \`${ceilCellLine}\``);
  assert.doesNotMatch(ceilCellLine, /p80/,
    `the Ceiling cell still reads a package p80: \`${ceilCellLine}\``);
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

// ---------------------------------------------------------------------------
// Rendered for real (skeptic round): the TSX is compiled with the repo's own
// TypeScript and rendered by React, the idiom of test/start-sit-gate-panel.test.js.
// This is what kills use-site mutants such as colouring by
// sign(risk.in.p80 - risk.out.p80), ceilingBetter(null) or an inverted delta,
// which the source-read assertions above only pin by spelling.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-risk-strip-ceiling-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const repoRequire = createRequire(new URL('../package.json', import.meta.url));
const writeTemp = (name, text) => { fs.writeFileSync(path.join(temp, name), text); return pathToFileURL(path.join(temp, name)).href; };
const runtimeUrl = writeTemp('jsx-runtime.mjs', `import { createRequire } from 'node:module';
const rt = createRequire(${JSON.stringify(repoRequire.resolve('react/jsx-runtime'))})(${JSON.stringify(repoRequire.resolve('react/jsx-runtime'))});
export const jsx = rt.jsx; export const jsxs = rt.jsxs; export const Fragment = rt.Fragment;`);
const { outputText } = ts.transpileModule(clientSrc('trade/RiskStrip.tsx'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
});
assert.ok(outputText.includes('"react/jsx-runtime"'), 'the compiled RiskStrip imports react/jsx-runtime');
const { default: RiskStrip } = await import(writeTemp('RiskStrip.mjs', outputText.split('"react/jsx-runtime"').join(`'${runtimeUrl}'`)));

const pkg = (p80, n) => ({
  players: Array.from({ length: n }, (_, i) => ({ id: i + 1 })), seasons: 4, top24_seasons: 2, top12_seasons: 1,
  min_games: 14, swing_pct: 20, band_pct: null, points: null, p20: null, p80,
  headline_profile: null, headline_read: null, unreadable: 0,
});
/** The Ceiling cell's markup, its visible text, and the colour class it carries. */
function ceilingCell(risk, ceilingDelta) {
  const html = renderToStaticMarkup(React.createElement(RiskStrip, { risk, ceilingDelta }));
  const cellHtml = html.split('<div class="min-w-0"').find(c => c.includes('>Ceiling<'));
  assert.ok(cellHtml, `no Ceiling cell rendered: ${html}`);
  const text = cellHtml.replace(/<[^>]+>/g, ' ').replace(/^[^>]*>/, '').replace(/\s+/g, ' ').trim();
  const colour = /text-good/.test(cellHtml) ? 'good' : /text-crit/.test(cellHtml) ? 'crit' : 'none';
  return { text, colour };
}

test('rendered: summed p80 falls but the lineup ceiling rises -> Ceiling cell is green and prints the Weekly ceiling', () => {
  // The package's own example (L4): sends 435 summed p80 for 418, Weekly ceiling +21.1.
  const c = ceilingCell({ out: pkg(435, 2), in: pkg(418, 1) }, 21.1);
  assert.equal(c.colour, 'good', `Ceiling cell colour must follow ceiling_delta +21.1, got ${c.colour} (${c.text})`);
  assert.match(c.text, /\+21\.1 pts/, `Ceiling cell must print the Weekly ceiling change: ${c.text}`);
  assert.doesNotMatch(c.text, /435|418/, `Ceiling cell must not print the summed package p80 pair: ${c.text}`);
});

test('rendered: summed p80 rises but the lineup ceiling falls -> Ceiling cell is red', () => {
  // The package's L1 shape: 329 -> 470 summed p80 on a 1-for-2, Weekly ceiling -0.4.
  const c = ceilingCell({ out: pkg(329, 1), in: pkg(470, 2) }, -0.4);
  assert.equal(c.colour, 'crit', `Ceiling cell colour must follow ceiling_delta -0.4, got ${c.colour} (${c.text})`);
  assert.match(c.text, /-0\.4 pts/);
  assert.doesNotMatch(c.text, /329|470/);
});

test('rendered: no ceiling_delta -> Ceiling cell neutral with a dash, whatever the p80 pair says', () => {
  const c = ceilingCell({ out: pkg(200, 1), in: pkg(300, 2) }, null);
  assert.equal(c.colour, 'none');
  assert.equal(c.text, 'Ceiling —');
});
