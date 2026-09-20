/**
 * The four provenance renderings are now one component, and stay one.
 *
 * Before this, Start/Sit, News, the odds sentence and the Settings freshness
 * card each answered "where did this number come from" in their own words, with
 * their own colours, and with their own view on whether the healthy case is
 * worth mentioning. Three of the four said nothing at all when the number WAS
 * measured, so a reader could not tell a healthy page from a page that forgot to
 * check.
 *
 * These tests do two jobs. They pin that each site now renders the chip, and
 * they pin that the ad-hoc strings the chip replaced have not crept back — which
 * is the direction this actually fails. Nobody deletes the shared component; they
 * add "(assumed)" next to it for one page, and a month later there are two
 * vocabularies again.
 *
 * Honest limit, same as the steps before: node:test, no DOM, source text only.
 * A page that renders the chip and ALSO writes its own suffix a few lines away
 * would pass the first job and fail the second, which is why the second exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const lineup = read('client/src/pages/Lineup.tsx');
const news = read('client/src/pages/News.tsx');
const odds = read('client/src/components/OddsBasis.tsx');
const freshness = read('client/src/components/DataBehindNumbers.tsx');
const waivers = read('client/src/components/lineup/WaiverWire.tsx');
const tradeLab = read('client/src/pages/TradeLab.tsx');

// Four were named when this started. Grepping for the strings the chip replaced
// found two more — the waiver board's "(assumed)" suffix and Trade Lab's pair of
// hand-rolled pills — which is the point: nobody knew there were six, and that
// is exactly how six vocabularies happen.
const SITES = [
  ['Start/Sit', lineup], ['News', news],
  ['the odds sentence', odds], ['the Settings freshness card', freshness],
  ['the waiver board', waivers], ['Trade Lab', tradeLab]
];

test('all six provenance renderings now use the one component', () => {
  for (const [name, src] of SITES) {
    assert.match(src, /from '\.[./]*(components\/)?ui\/BasisChip'/,
      `${name} no longer imports the shared chip`);
    // The tag has to END here: /<BasisChip/ alone also matches <BasisChipX,
    // so renaming the element to anything with the same prefix left this green.
    // Caught by a mutation run, not by reading it.
    assert.match(src, /<BasisChip[\s/>]/, `${name} imports the chip and does not render it`);
  }
});

test('the ad-hoc suffixes the chip replaced have not come back', () => {
  // The exact strings that were there. A page that starts writing its own
  // parenthetical again is a page on its way back to a second vocabulary.
  for (const [name, src] of [['Start/Sit', lineup], ['News', news], ['the waiver board', waivers]]) {
    assert.doesNotMatch(src, /'\s*\(assumed\)'/, `${name} is hand-writing "(assumed)" again`);
    assert.doesNotMatch(src, /'\s*\(not modelled\)'/, `${name} is hand-writing "(not modelled)" again`);
    assert.doesNotMatch(src, /\(assumed — the fit does not cover/, `${name} is hand-writing its own basis suffix again`);
  }
});

test('the server vocabulary is mapped, never compared to inline', () => {
  // A page that tests `basis === 'role'` to decide wording is a page making its
  // own provenance decision, which is the thing the chip centralises. The one
  // remaining comparison in each page chooses WHICH element to render, not what
  // to say about the basis, so the map is what must be present.
  for (const [name, src] of [['Start/Sit', lineup], ['News', news]]) {
    assert.match(src, /AVAILABILITY_BASIS\[/, `${name} is no longer going through the basis map`);
  }
  assert.doesNotMatch(lineup, /const measured = basis === 'role'/,
    'Start/Sit is deciding its own wording from the basis again');
});

test('a low chance to play and an assumed basis are no longer the same grey', () => {
  // They were one pill. They are two things: a low chance to play is a fact
  // about the player, an assumed basis is a gap on our side, and a reader who
  // sees one grey pill cannot tell which they are looking at.
  const pill = lineup.slice(lineup.indexOf('% to play'), lineup.indexOf('% to play') + 400);
  assert.doesNotMatch(pill, /measured \?/, 'the percentage is being greyed by its basis again');
  assert.match(lineup, /play < 75 \? 'bg-amber-50/, 'the low-chance colour is gone');
});

test('Trade Lab no longer uses the warning colour for a gap on our side', () => {
  // Its assumed pill was bg-amber-50 / text-amber-900, which is what this app
  // uses for something wrong with the manager's team. An assumed chance to play
  // is not that, and every deal on the page was ranked under it.
  assert.doesNotMatch(tradeLab, /Chance to play: assumed, not measured/,
    'Trade Lab is writing its own basis wording again');
  assert.match(tradeLab, /AVAILABILITY_BASIS\[rosters\.model_context\.availability_basis\.basis\]/,
    'Trade Lab is no longer mapping the server basis');
});

test('the odds bracket says assumed in the basis ramp, not in the warning colour', () => {
  // text-amber-700 is what the rest of the app uses for "something is wrong with
  // your team". A bracket we had to assume is a gap on our side.
  assert.doesNotMatch(odds, /assumed \? 'text-amber-700'/, 'the bracket is amber again');
  assert.match(odds, /basis=\{assumed \? 'assumed' : 'measured'\}/, 'the bracket lost its chip');
  // And the server's sentence is still rendered verbatim rather than reworded.
  assert.match(odds, /<span>\{bracket\}<\/span>/, 'the bracket sentence is being reworded by the page');
});

test('the freshness card says whether THIS season is in each row', () => {
  // The live failure mode: the model falls back to the most recent season it
  // has and says nothing, so the app looks completely healthy while projecting
  // this year off last year's football. The card listed which seasons are
  // loaded; it never said in one glance whether the one being played is among
  // them.
  assert.match(freshness, /basis=\{missingThisSeason \? 'missing' : 'measured'\}/,
    'the usage row no longer says whether this season is loaded');
  assert.match(freshness, /const linesThisSeason/, 'the game-lines row no longer checks this season');
  assert.match(freshness, /basis=\{linesThisSeason \? 'measured' : 'missing'\}/,
    'the game-lines row lost its chip');
  // The season comes from the league, never the calendar. draft-assist.js reads
  // the calendar year for this and is wrong every January.
  assert.match(freshness, /const season = active\?\.season \?\? null/,
    'the freshness card is no longer taking the season from the league');
});
