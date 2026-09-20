/**
 * The fitted model's read on the league, and the four rules it is easy to break.
 *
 * `GET /api/leagues/:id/outlook` is not the simulation that produces the
 * championship number on the same page. That one plays the rest of the season
 * out thousands of times; this one is a model fitted on finished seasons
 * reading the season so far. Two methods, two answers, and the glossary keeps
 * them under two names for the same reason it keeps two floors apart.
 *
 * Part of this is a real unit test: the clamp, the verdicts and the
 * decomposition order are decisions, so they are imported and called. The
 * markup is read as source text, because node:test has no build step and
 * cannot import a .tsx.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { probabilityText, verdictOf, decompositionParts, showsDecomposition } from '../client/src/lib/outlook.js';
import { percentText } from '../client/src/lib/percent.js';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const panel = read('client/src/components/league/OutlookPanel.tsx');
const page = read('client/src/pages/MyTeam.tsx');
const glossary = read('client/src/lib/glossary.ts');

/**
 * A file with its comments removed, for assertions about what is SHOWN.
 *
 * Needed because these components explain what they are deliberately not
 * saying, in their own headers: the panel's comment says no_results_yet is
 * "NOT a preseason forecast", and a whole-file check for that phrase would
 * forbid the explanation along with the mistake. Naming what was avoided is
 * the opposite of doing it.
 */
const withoutComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const panelShown = withoutComments(panel);

test('a probability never reads as certain, whatever it rounds to', () => {
  // The payload guarantees the value is never 0 and never 1. That guarantee
  // does not survive rounding: at one decimal 0.9999 renders "100.0%" and
  // 0.00004 renders "0.0%". A screen saying a season is decided in week 3 is a
  // stronger claim than any model here makes, so the clamp is on the RENDERED
  // string rather than on the value.
  assert.equal(probabilityText(0.9999), 'above 99.9%');
  assert.equal(probabilityText(0.99996), 'above 99.9%');
  assert.equal(probabilityText(0.0001), 'below 0.1%');
  assert.equal(probabilityText(0.00004), 'below 0.1%');
  // And everything in between is the number itself, not a hedge.
  assert.equal(probabilityText(0.5), '50.0%');
  assert.equal(probabilityText(0.12345), '12.3%');
  assert.equal(probabilityText(0.999), '99.9%');
  assert.equal(probabilityText(0.001), '0.1%');
  // A missing number is null, so a caller renders its own state. A missing
  // number and a zero are different facts.
  assert.equal(probabilityText(null), null);
  assert.equal(probabilityText(undefined), null);
  assert.equal(probabilityText(Number.NaN), null);
});

test('the clamp lives in one place and the glossary applies it', () => {
  // Two implementations would drift and only one of them would be the one on
  // screen. percentText is the implementation; the glossary entry carries the
  // flag; probabilityText is a wrapper over the same function.
  assert.equal(percentText(0.9999, 1, { neverCertain: true }), 'above 99.9%');
  // Without the flag it is an ordinary percentage — nothing else in the app
  // silently gains a hedge.
  assert.equal(percentText(0.9999, 1), '100.0%');
  assert.match(glossary, /outlook_probability: \{/, 'the outlook number has no glossary entry of its own');
  // Sliced to the entry. A whole-file match passed while the flag was gone,
  // because formatValue's own call site further down reads
  // `percentText(value, t.precision, { neverCertain: true })` — an assertion
  // watching a symbol rather than the decision, again.
  const entry = glossary.slice(glossary.indexOf('outlook_probability: {'));
  assert.match(entry.slice(0, entry.indexOf('},')), /neverCertain: true/,
    'the outlook entry lost its flag, so the number can print 100%');
  assert.match(glossary, /if \(t\.neverCertain && t\.unit === 'percent'\)/,
    'formatValue stopped applying the clamp, so a stat block would print 100%');
  // And it is NOT the same quantity as the simulation's playoff number.
  assert.match(glossary, /raw: 'outlook\.probability'/);
  assert.match(glossary, /raw: 'sim\.playoff_odds'/);
  assert.notEqual(
    glossary.indexOf("raw: 'outlook.probability'"), glossary.indexOf("raw: 'sim.playoff_odds'"),
    'the two playoff numbers have collapsed into one entry');
});

test('act is never a verdict this panel can produce', () => {
  // The server sends fine, watch and act_candidate and never act, because act
  // means a specific move exists that raises these odds — and only a caller
  // holding the trade engine's best move knows that. A panel that upgraded the
  // label itself would be telling a manager to do something without having
  // found anything for him to do.
  assert.equal(verdictOf('act'), null, 'the panel knows a verdict the server never sends');
  assert.ok(verdictOf('fine') && verdictOf('watch') && verdictOf('act_candidate'));
  assert.equal(verdictOf('something_else'), null);
  // And the panel says so on screen rather than leaving an absent button.
  assert.match(panel, /Whether a move is actually available is\s*\n?\s*a different question/,
    'the panel stopped saying it cannot tell you what to do');
});

test('the decomposition is shown in the order the server stated', () => {
  // The three parts are not equally important in every league and the server
  // knows which dominates. A fixed order would put the biggest one last in half
  // of them.
  const d = { luck: 0.1, noise: 0.2, real: 0.7, real_is: 'what is left over', order: ['noise', 'real', 'luck'] };
  assert.deepEqual(decompositionParts(d).map(p => p.key), ['noise', 'real', 'luck']);
  assert.deepEqual(
    decompositionParts({ ...d, order: ['luck', 'noise', 'real'] }).map(p => p.key),
    ['luck', 'noise', 'real']);
  // Only `real` carries the caveat, and only because the server sent one.
  const parts = decompositionParts(d);
  assert.equal(parts.find(p => p.key === 'real').note, 'what is left over');
  assert.equal(parts.find(p => p.key === 'luck').note, null);
  assert.equal(decompositionParts({ ...d, real_is: null }).find(p => p.key === 'real').note, null);
  // A part the server did not send is a dash, never a zero.
  assert.equal(decompositionParts({ ...d, luck: null }).find(p => p.key === 'luck').value, null);
});

test('with nothing played there is nothing to take apart', () => {
  // The three parts are a split of what has happened. With no weeks played they
  // are a split of nothing, and a chart of zero is a claim.
  const teams = [{ decomposition: { order: ['real'] } }];
  assert.equal(showsDecomposition({ weeks_played: 0, teams }), false);
  assert.equal(showsDecomposition({ weeks_played: 2, teams }), true);
  assert.equal(showsDecomposition({ weeks_played: 2, teams: [{ decomposition: null }] }), false);
  assert.equal(showsDecomposition(null), false);
  assert.match(panel, /Nothing has been played yet, so there is nothing to take apart\./,
    'the empty state stopped saying why it is empty');
});

test('the not-ready reason is printed as it arrives', () => {
  // Five distinct reasons, two of which are deliberate refusals rather than
  // missing data. The sentence is the only thing that distinguishes them, and
  // the server wrote them finished. Rewording here would put a second version
  // of each claim in a second place.
  assert.match(panel, /<BasisLine basis="none">\{outlook\.reason\}<\/BasisLine>/,
    'the not-ready reason is being reworded or dropped');
  assert.doesNotMatch(panelShown, /not ready yet|try again later/i,
    'the panel has grown its own not-ready wording');
});

test("no_results_yet is not called a preseason forecast", () => {
  // It is the same model with the result features turned off, which is a
  // different thing. Naming it a preseason forecast would invent a comparison
  // the server did not run.
  assert.match(panel, /With everything that has happened this season set aside/,
    'the no-results comparison lost its wording');
  assert.doesNotMatch(panelShown, /preseason/i, 'the panel is calling it a preseason forecast');
});

test('the page renders it beside the simulation, not blended into it', () => {
  assert.match(page, /<OutlookPanel outlook=\{outlook\} teamName=\{teamName\} myRosterId=\{myTeamId\} \/>/,
    'the outlook panel is no longer on the page');
  assert.match(page, /`\/leagues\/\$\{active\.id\}\/outlook`/, 'the page stopped asking for the outlook');
  // The route does not exist on every deployment yet, so its error must not be
  // surfaced: "this build has no outlook route" is not something a manager can
  // act on, and an error card would be the page reporting its own roadmap.
  assert.match(page, /const \{ data: outlook \} = useApi<any>\(outlookUrl\);/,
    'the page is now surfacing an error for a route that may not exist');
  assert.match(panel, /if \(!outlook\) return null;/, 'the panel renders something when it was told nothing');
});
