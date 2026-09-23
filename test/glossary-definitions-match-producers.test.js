/**
 * The glossary's PRESENCE is checked by test/glossary-and-basis.test.js. This
 * file checks MEANING: that each entry's sentence and `raw` path describe what
 * the cited producer actually computes, not just that the fields exist.
 *
 * R&D found six of fifteen entries described a number the served code does not
 * produce — a different horizon, unit, or a field that does not exist at all
 * (rnd/loop/r7-internal-glossary-defines-numbers-code-no-longer-makes.md).
 * Each test below cites the producer file:line and, where the defect was "this
 * claim used to be true but a later change broke it silently", a control that
 * would have caught the earlier, correct state.
 *
 * Read as source text, same limit as glossary-and-basis.test.js: this pins what
 * the files SAY, not what a server response actually contains at runtime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const glossary = read('client/src/lib/glossary.ts');
const tradeEngine = read('server/services/trade-engine.js');
const lineupBrain = read('server/services/lineup-brain.js');
const seasonSim = read('server/services/season-sim.js');
const matchups = read('server/services/matchups.js');

const block = id => {
  const m = glossary.match(new RegExp(`  ${id}:\\s*\\{[^}]*\\}`, 's'));
  assert.ok(m, `${id} entry not found in glossary.ts`);
  return m[0];
};
const field = (b, name) => {
  const m = b.match(new RegExp(`${name}:\\s*'([^']*)'`));
  return m ? m[1] : null;
};

test('week_floor: raw is the trade engine\'s served p10, and the sentence admits it can be a did-not-play zero', () => {
  // Producer: trade-engine.js:462 — `floor: weekDist?.p10 ?? ...`. The p10 comes
  // from a draw that INCLUDES the chance the player doesn't suit up at all, so a
  // sentence promising "not catastrophically" is a claim the draw does not keep.
  assert.match(tradeEngine, /floor:\s*weekDist\?\.p10/, 'trade-engine.js no longer serves floor as weekDist.p10 — re-point the raw path');
  const b = block('week_floor');
  assert.equal(field(b, 'raw'), 'projection.p10');
  assert.doesNotMatch(b, /not catastrophically/i,
    'the sentence promises the floor is never a total bust, but the p10 draw includes the games he does not play at all');
  assert.match(b, /doesn.t (suit up|play)|does not (suit up|play)|not (suit|play)ing at all/i,
    'the sentence must say the floor can include a week he does not play, since that is what the served p10 contains');
});

test('season_floor: raw is the preseason draft-day band, not a season-long career percentile that does not exist', () => {
  // Producer: lineup-brain.js:187 — `p20: r1(preseason.p20)`, nested under the
  // `preseason` object EvidenceStrip.tsx renders as "preseason X-Y pts" (a full
  // season total set at draft day). Control: `career.p20` names nothing this
  // module emits.
  assert.match(lineupBrain, /p20:\s*r1\(preseason\.p20\)/, 'lineup-brain.js no longer emits preseason.p20 at this shape — re-point the raw path');
  assert.doesNotMatch(lineupBrain, /career\s*[.:]\s*p20/, 'control: this file must not define a career.p20 either, or the old raw path would be right after all');
  const b = block('season_floor');
  assert.equal(field(b, 'raw'), 'evidence.preseason.p20', 'raw must point at the preseason band the server actually serves, not a career percentile');
  assert.doesNotMatch(b, /rest of the season/i, 'a draft-day preseason number is not a rest-of-season read');
  assert.match(b, /preseason|draft.day/i, 'the sentence must say this is the preseason model, frozen before the season started');
  assert.notEqual(field(b, 'unit'), 'points_per_game', 'the preseason p20 is a full-season total (lineup-brain.js:187 reads preseason.points, a total), not points per game');
});

test('expected_wins: the sentence must say the total counts games already played, matching the real starting record the sim seeds from', () => {
  // Producer: season-sim.js:126 `initialRecords`, used at :364 to seed
  // `startingRecords`, which season totals at :431 are summed on top of. Since
  // #162 this is real-record-plus-remaining, not remaining alone.
  assert.match(seasonSim, /function initialRecords/, 'season-sim.js no longer has initialRecords — the "real record carried in" defect this checks may be gone; re-audit');
  assert.match(seasonSim, /startingRecords\s*=\s*initialRecords\(/, 'expected_wins is no longer seeded from the real record — re-audit whether "rest of the season" is now correct');
  const b = block('expected_wins');
  assert.doesNotMatch(b, /rest of the season/i,
    'expected_wins is a season total including games already played (season-sim.js:126,364), not a rest-of-season count');
  assert.match(b, /already played|counting the games|whole season/i,
    'the sentence must say the total includes games already played');
});

test('start_score: raw points at week_points, the field the lineup is actually solved on — lineup.score does not exist', () => {
  // Producer: lineup-brain.js:363 emits `week_points`, and :474 solves the pool
  // on `week_points` by default. No route emits a `score:` field on a pool row.
  assert.match(lineupBrain, /week_points:\s*r2\(base/, 'lineup-brain.js no longer names the field week_points — re-point the raw path');
  assert.doesNotMatch(lineupBrain, /^\s*score:\s/m, 'control: lineup-brain.js must not emit a literal `score:` field either, or lineup.score might be real after all');
  const b = block('start_score');
  assert.notEqual(field(b, 'raw'), 'lineup.score', 'lineup.score is not a field any route serves');
  assert.equal(field(b, 'raw'), 'lineup.week_points');
});

test('title_delta: the sentence does not promise clean pairing while the paired-seed draw order can still shift between runs', () => {
  // Producer: season-sim.js:313 builds the per-player draw order from `roster`,
  // which is derived from each team's OWN player list order; a trade changes
  // that team's player list (removes/appends), which reorders `active` at :356
  // even though :476 reuses the same `pairedSeed` for both runs. A canonical
  // (e.g. id-sorted) roster order would fix this; there is none today, so the
  // "same simulated seasons ... so the difference is the move and not luck"
  // claim overstates what the paired seed alone guarantees.
  assert.match(seasonSim, /const roster = \[\.\.\.new Map\(teams\.flatMap/, 'season-sim.js no longer builds the roster this way — re-audit the pairing defect before trusting this test');
  const rosterToSampler = seasonSim.slice(seasonSim.indexOf('const roster = [...new Map(teams.flatMap'), seasonSim.indexOf('draw: correlatedSampler'));
  assert.doesNotMatch(rosterToSampler, /\.sort\(\(a,\s*b\)\s*=>\s*a\.id\s*-\s*b\.id\)/,
    'season-sim.js now sorts the roster into a canonical order before drawing — the pairing bug this test guards against may be fixed; update the title_delta sentence back to the unconditional claim and this assertion');
  const b = block('title_delta');
  assert.doesNotMatch(b, /so the difference is the move and not luck/i,
    'the paired seed does not guarantee this while the draw order can shift with the trade (season-sim.js:313-356) — the sentence must not promise it');
  assert.match(b, /noise|approx|roughly|about/i,
    'the sentence must flag that some of the change can be simulation noise, not only the trade');
});

test('points_allowed_to_position: raw is the field matchups.js actually serves (`allowed`), and the sentence says multi-season, tested, not "so far"', () => {
  // Producer: matchups.js:189 `allowed: +allowed.toFixed(1)` inside computeDvp,
  // served through dvpFor()/dvpTable() and rendered at TradeLab.tsx:1128 as
  // "{d.allowed} ppg allowed" — there is no `ppg_allowed` field anywhere.
  // matchups.js:94-102 blends seasons with RECENCY=0.5 decay and shrinks with
  // K_DVP=200, so it is not "so far" (this season only, unweighted).
  assert.match(matchups, /allowed:\s*\+allowed\.toFixed\(1\)/, 'matchups.js no longer names this field `allowed` — re-point the raw path');
  assert.doesNotMatch(matchups, /ppg_allowed/, 'control: matchups.js must not define ppg_allowed either, or that raw path might be right after all');
  const b = block('points_allowed_to_position');
  assert.notEqual(field(b, 'raw'), 'matchups.dvp.ppg_allowed', 'matchups.dvp.ppg_allowed is not a field matchups.js emits');
  assert.equal(field(b, 'raw'), 'matchups.dvp.allowed');
  assert.doesNotMatch(b, /\bso far\b/i, 'a multi-season, recency-weighted, shrunk blend (matchups.js:94-102) is not "so far" (this season, unweighted)');
  assert.match(b, /recent seasons|multiple seasons|blend/i, 'the sentence must say this blends recent seasons, not just the current one');
  assert.match(b, /tested|did not (predict|help|improve)/i, 'the sentence should say this was tested and did not predict (matchups.js:9-14)');
});
