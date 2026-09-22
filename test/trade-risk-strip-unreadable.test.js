/**
 * The fourth surface.
 *
 * `evidence_unreadable` fixed three places in trade-engine.js that turned a
 * failed career query into a claim about a player. The trade card has a
 * fourth: `RiskStrip`'s Floor cell renders `PackageRisk` directly, and it
 * reads `seasons === 0` the same way `playerRiskProfile` used to — as a fact.
 *
 *   floorOf: r.seasons ? `${top24_seasons}/${seasons} top-24` : 'no record'
 *
 * With every career on a side unreadable, `seasons` is 0 and the cell reads
 * **"no record"** about players who may have a decade of them. With one of two
 * readable, `seasons` is the readable man's alone (packageRisk sums over
 * `withRecord`), so the cell prints the readable half as though it were the
 * package. And `floorBetter` divides those two partial sums against each other
 * and colours the cell green or red off the result.
 *
 * These are source-read assertions, the idiom this repo already pins
 * RiskStrip and ManagerRead with (test/trade-manager-read.test.js:42) — the
 * client has no render harness, and a claim in a string literal is exactly
 * what a source read can hold.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const clientSrc = name => readFileSync(new URL(`../client/src/components/${name}`, import.meta.url), 'utf8');

test('R1: the Floor cell does not call an unreadable package "no record"', () => {
  const src = clientSrc('trade/RiskStrip.tsx');
  assert.match(src, /unreadable/,
    'floorOf never looks at PackageRisk.unreadable, so a failed career query still reads as a finding');
  // The honest-rookie string must survive — it is the correct answer when the
  // sources worked and there genuinely is nothing. It just may not be the
  // answer when they did not work.
  assert.match(src, /'no record'/, 'the genuine no-record case must keep its own wording');
  assert.match(src, /r\.unreadable[\s\S]{0,200}?'no record'|'no record'[\s\S]{0,200}?r\.unreadable/,
    'the unreadable branch must be decided in the same expression as "no record", not somewhere else');
});

test('R2: a partly readable package is not printed as a whole one', () => {
  const src = clientSrc('trade/RiskStrip.tsx');
  // packageRisk sums over players with a record, so `seasons` on a mixed
  // package covers only part of it. Whatever the cell prints, the package's
  // own size has to appear next to the count that does not cover it.
  // Read the rendered strings themselves, not the function around them: the
  // old one-liner mentions players.length in its empty-package guard, which
  // says nothing about what the top-24 count covers.
  const templates = src.match(/`[^`]*top24_seasons[^`]*`/g) ?? [];
  assert.ok(templates.length, 'no template renders top24_seasons — floorOf is not where this test expects it');
  assert.ok(templates.some(t => /players\.length/.test(t)),
    'every string that prints top24_seasons/seasons does so with no indication of how much of '
    + `the package that covers — rendered as: ${templates.join(' | ')}`);
});

test('R3: the Floor comparison is not coloured from partial sums', () => {
  const src = clientSrc('trade/RiskStrip.tsx');
  const floorBetter = src.match(/const floorBetter = [\s\S]*?;\n/)?.[0] ?? '';
  assert.ok(floorBetter, 'floorBetter is not where this test expects it');
  // The guard may be a named local, but it has to be decided from `unreadable`.
  const guard = floorBetter.match(/&& ([A-Za-z]\w*)\n?\s*\?/)?.[1];
  assert.ok(guard || /unreadable/.test(floorBetter),
    'floorBetter divides top24_seasons by seasons with no check that either side was fully read, '
    + 'so a green or red Floor cell can be computed from half a package');
  if (guard) {
    const decl = src.match(new RegExp(`const ${guard} = .*\n`))?.[0] ?? '';
    assert.match(decl, /unreadable/,
      `floorBetter is guarded on \`${guard}\`, but \`${guard}\` is not decided from the unreadable count`);
  }
});

test('R4: a side whose records all failed still renders, instead of the strip vanishing', () => {
  const src = clientSrc('trade/RiskStrip.tsx');
  const anyRecord = src.match(/const anyRecord = [\s\S]*?;\n/)?.[0] ?? '';
  assert.ok(anyRecord, 'anyRecord is not where this test expects it');
  assert.match(anyRecord, /unreadable/,
    'with every career AND every preseason read failing, seasons is 0 and p80 is null on both '
    + 'sides, so the whole strip returns null and the failure is silent — the exact shape '
    + 'CLAUDE.md names: "If a layer goes inert, the surface must say so"');
});

test('R5: the client types carry the unreadable count and the unknown profile', () => {
  const types = clientSrc('trade/types.ts');
  assert.match(types, /unreadable: number/,
    'PackageRisk does not declare `unreadable`, so the client cannot read what the server now sends');
  assert.match(types, /'unknown'/,
    "PlayerRisk.profile's union omits 'unknown', which playerRiskProfile now returns");
});
