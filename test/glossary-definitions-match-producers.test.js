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
const edge = read('server/routes/edge.js');

// Matches from the entry's opening brace to the closing brace at the SAME
// indentation, not the first `}` — an inline comment can itself contain a
// brace (e.g. quoting a template literal), which a naive `[^}]*}` would stop
// at early and silently truncate the entry.
const block = id => {
  const m = glossary.match(new RegExp(`^  ${id}:\\s*\\{.*?^  \\}`, 'ms'));
  assert.ok(m, `${id} entry not found in glossary.ts`);
  return m[0];
};
const field = (b, name) => {
  const m = b.match(new RegExp(`${name}:\\s*'([^']*)'`));
  return m ? m[1] : null;
};
// Sentence-wording checks must run on the `plain` field alone, never the whole
// block — the block also carries this test file's own explanatory comments
// (e.g. quoting the wrong phrase being replaced), which would make a check
// against the block pass or fail for the wrong reason.
const plainOf = id => {
  const p = field(block(id), 'plain');
  assert.ok(p, `${id} has no plain sentence`);
  return p;
};

test('week_floor / week_ceiling: raw is the served trade asset field, and the sentence states both of its producers', () => {
  // Producer: trade-engine.js:462 — `floor: weekDist?.p10 ?? w?.floor ?? null`
  // on the assetUniverse() asset. `projection.p10` names nothing any route
  // serves (git grep finds it only in glossary.ts). The served field has TWO
  // producers: the week draw's p10 (includes the chance he does not suit up),
  // and, when there is no week projection, edge.js:145 volatility()'s
  // `floor: +q(0.2)` — the 20th percentile of LAST season's played weeks only.
  assert.match(tradeEngine, /floor:\s*weekDist\?\.p10/, 'trade-engine.js no longer serves floor as weekDist.p10 — re-point the raw path');
  assert.equal(field(block('week_floor'), 'raw'), 'asset.floor', 'raw must name the served asset field, not a projection.p10 nothing serves');
  assert.equal(field(block('week_ceiling'), 'raw'), 'asset.ceiling', 'raw must name the served asset field, not a projection.p90 nothing serves');
  assert.doesNotMatch(glossary, /raw:\s*'projection\./, 'no glossary raw may point into a projection.* object no route serves');
  const plain = plainOf('week_floor');
  assert.doesNotMatch(plain, /not catastrophically/i,
    'the sentence promises the floor is never a total bust, but the p10 draw includes the games he does not play at all');
  assert.match(plain, /doesn.t (suit up|play)|does not (suit up|play)|not (suit|play)ing at all/i,
    'the sentence must say the floor can include a week he does not play, since that is what the served p10 contains');
  const fallsBack = /floor:\s*weekDist\?\.p10\s*\?\?\s*w\?\.floor/.test(tradeEngine);
  if (fallsBack) {
    assert.match(edge, /floor:\s*\+q\(0\.2\)/, 'control: the fallback floor must still be edge.js volatility() q(0.2) — re-audit the one-in-five wording');
    assert.match(edge, /export function volatility\(season = SEASON - 1\)/, 'control: volatility() must still default to last season');
    assert.match(plain, /last season/i, 'the served floor falls back to last season\'s played-week 20th percentile (edge.js volatility) — the sentence must say so');
    assert.match(plain, /one (week )?in five|20th/i, 'the fallback is the bottom one week in five, not one in ten');
    assert.match(plainOf('week_ceiling'), /last season/i, 'the served ceiling has the same last-season fallback (trade-engine.js:462 `w?.ceiling`)');
  }
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
  const plain = plainOf('season_floor');
  assert.doesNotMatch(plain, /rest of the season/i, 'a draft-day preseason number is not a rest-of-season read');
  assert.match(plain, /preseason|draft.day/i, 'the sentence must say this is the preseason model, frozen before the season started');
  assert.notEqual(field(b, 'unit'), 'points_per_game', 'the preseason p20 is a full-season total (lineup-brain.js:187 reads preseason.points, a total), not points per game');
});

test('expected_wins: the sentence must say the total counts games already played, matching the real starting record the sim seeds from', () => {
  // Producer: season-sim.js:126 `initialRecords`, used at :364 to seed
  // `startingRecords`, which season totals at :431 are summed on top of. Since
  // #162 this is real-record-plus-remaining, not remaining alone.
  assert.match(seasonSim, /function initialRecords/, 'season-sim.js no longer has initialRecords — the "real record carried in" defect this checks may be gone; re-audit');
  assert.match(seasonSim, /startingRecords\s*=\s*initialRecords\(/, 'expected_wins is no longer seeded from the real record — re-audit whether "rest of the season" is now correct');
  const plain = plainOf('expected_wins');
  assert.doesNotMatch(plain, /rest of the season/i,
    'expected_wins is a season total including games already played (season-sim.js:126,364), not a rest-of-season count');
  assert.match(plain, /already played|counting the games|whole season/i,
    'the sentence must say the total includes games already played');
  assert.doesNotMatch(plain, /remaining|not counting|excluding|rest of/i,
    'a sentence can name "already played" while denying it — any remaining/excluding wording contradicts season-sim.js:364');
});

test('this week\'s projected points: one entry, on the Start/Sit producer (startSitWeekPoints), not two entries with different raws', () => {
  // Producer: lineup-brain.js:356 `startSitWeekPoints` returns `week_points`
  // (:363), the one construction every week-total page shares (lineup-posture.js
  // imports it). start_score and projected_points both described "this week's
  // projected points" with different raws (lineup.week_points vs a
  // projection.mean nothing serves) — one number, two entries.
  assert.match(lineupBrain, /export function startSitWeekPoints/, 'the Start/Sit week producer moved — re-point the raw path');
  assert.match(lineupBrain, /week_points:\s*r2\(base/, 'lineup-brain.js no longer names the field week_points — re-point the raw path');
  assert.doesNotMatch(lineupBrain, /^\s*score:\s/m, 'control: lineup-brain.js must not emit a literal `score:` field, or lineup.score might be real after all');
  assert.doesNotMatch(glossary, /^  start_score:/m, 'start_score duplicated projected_points; the glossary keeps one entry per number');
  const b = block('projected_points');
  assert.equal(field(b, 'raw'), 'lineup.week_points');
  assert.match(plainOf('projected_points'), /chance to play/i, 'week_points is current_week_ppg, which already multiplies in his chance to play');
});

test('no two glossary entries share a raw path (one number, one entry)', () => {
  const raws = [...glossary.matchAll(/^    raw:\s*(['"])(.*?)\1/gm)].map(m => m[2]);
  assert.ok(raws.length >= 14, `control: expected the full glossary's raws, found ${raws.length}`);
  const dupes = raws.filter((r, i) => raws.indexOf(r) !== i);
  assert.deepEqual(dupes, [], `raw paths used by more than one entry: ${dupes.join(', ')}`);
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
  const plain = plainOf('title_delta');
  assert.doesNotMatch(plain, /so the difference is the move and not luck/i,
    'the paired seed does not guarantee this while the draw order can shift with the trade (season-sim.js:313-356) — the sentence must not promise it');
  assert.match(plain, /noise/i,
    'the sentence must flag that some of the change can be simulation noise, not only the trade');
  assert.doesNotMatch(plain, /never luck|not luck|no luck|all (about )?the move|purely|entirely|only the move/i,
    'the same overclaim in new words: the paired seed alone does not isolate the move (season-sim.js:313-356)');
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
  const plain = plainOf('points_allowed_to_position');
  assert.doesNotMatch(plain, /\bso far\b/i, 'a multi-season, recency-weighted, shrunk blend (matchups.js:94-102) is not "so far" (this season, unweighted)');
  assert.match(plain, /recent seasons|multiple seasons|blend/i, 'the sentence must say this blends recent seasons, not just the current one');
  assert.match(plain, /tested|did not (predict|help|improve)/i, 'the sentence should say this was tested and did not predict (matchups.js:9-14)');
  // Only `mult` is shrunk (matchups.js:193); `allowed` is the plain
  // recency-weighted mean (:186 `b.wpts / b.w`). The sentence may claim
  // shrinkage only if the line producing `allowed` calls shrink().
  const allowedLine = matchups.match(/const allowed = [^\n]*/);
  assert.ok(allowedLine, 'control: matchups.js no longer computes `const allowed =` — re-audit');
  assert.match(matchups, /mult:\s*\+shrink\(/, 'control: the shrink this check contrasts with is on `mult`');
  if (!/shrink\(/.test(allowedLine[0])) {
    assert.doesNotMatch(plain, /pulled toward|shrunk|shrink|toward (the )?(league )?average|regress/i,
      'the served `allowed` is unshrunk (matchups.js:186); only `mult` is shrunk');
  }
});
