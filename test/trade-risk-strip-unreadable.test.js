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

/**
 * `floorOf` is plain JavaScript once its one type annotation is gone, so it can
 * be RUN rather than grepped for. It is worth the extraction: the first version
 * of R1 asserted that the source mentioned `unreadable` and `'no record'` near
 * each other, and a mutation sweep showed that assertion **survives** reverting
 * the fix — `unread` is still computed for the mixed-package branch, so the
 * tokens are all still there while the cell prints "no record" again. A test
 * that cannot tell the fix from the defect is not a test.
 *
 * There is no TSX transform in this suite (see test/trade-manager-read.test.js),
 * hence reading the declaration out and evaluating it. If the extraction ever
 * stops matching, that is a failure, not a skip.
 */
function extractFloorOf(src) {
  const m = src.match(/const floorOf = \(r: PackageRisk\) => \{[\s\S]*?\n\};/);
  assert.ok(m, 'floorOf could not be extracted — this test must be repaired, not skipped');
  const js = m[0].replace('(r: PackageRisk)', '(r)').replace(/^const floorOf = /, '');
  return eval(`(${js.replace(/;$/, '')})`);
}

/** A PackageRisk in the shape packageRisk() returns, with only what floorOf reads. */
const pkg = (over = {}) => ({ players: [{}], seasons: 0, top24_seasons: 0, unreadable: 0, ...over });

test('R1: the Floor cell does not call an unreadable package "no record"', () => {
  const floorOf = extractFloorOf(clientSrc('trade/RiskStrip.tsx'));

  // The defect: every career on this side threw, so the sums are 0. Saying
  // "no record" here is a claim about players nothing was read about.
  assert.equal(floorOf(pkg({ players: [{}, {}], seasons: 0, unreadable: 2 })), 'not readable');

  // The honest case must be untouched: the sources worked and there genuinely
  // is no record. Same zero, different reason, different sentence.
  assert.equal(floorOf(pkg({ players: [{}], seasons: 0, unreadable: 0 })), 'no record');

  // And a fully readable package still reads exactly as it did.
  assert.equal(floorOf(pkg({ players: [{}], seasons: 5, top24_seasons: 5 })), '5/5 top-24');
  assert.equal(floorOf(pkg({ players: [] })), '—');
});

test('R2: a partly readable package is not printed as a whole one', () => {
  const floorOf = extractFloorOf(clientSrc('trade/RiskStrip.tsx'));
  // packageRisk sums over players with a record, so `seasons` on a mixed
  // package covers only part of it: two players here, one career readable with
  // five top-24 seasons and one that threw. A cell printing "5/5 top-24" is
  // reporting one man's record as the pair's.
  const mixed = floorOf(pkg({ players: [{}, {}], seasons: 5, top24_seasons: 5, unreadable: 1 }));

  assert.notEqual(mixed, '5/5 top-24', 'the readable half is printed as the whole package');
  assert.equal(mixed, '5/5 top-24 (1/2)');
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
