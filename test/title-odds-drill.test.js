/**
 * The first real drill-down: the championship number.
 *
 * It is the right one to do first because it is the number My Team exists to
 * show, and because all five layers already existed in the payload and were
 * rendered as small grey prose below the card or not at all. Nothing new had to
 * be computed; what changed is that a reader can now ask.
 *
 * The test that matters here is the fourth layer. There is a real temptation to
 * write "tested" on this number, because its INPUTS were tested —
 * weekly-backtest.js replays past seasons week by week and grades each weekly
 * player projection on the week it predicted. The championship probability
 * itself has never been scored against finished seasons: nothing in this
 * repository checks how often a team given 20% actually won. Saying "tested"
 * because the inputs were tested is exactly the overstatement layer 4 exists to
 * prevent, and it is the kind that survives review because it is nearly true.
 *
 * Honest limit, as throughout: node:test, no DOM, source text only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// Layer 4 is built, not literal, since the odds gate landed; call it rather
// than reading a string the page no longer contains. See test/odds-gate.test.js.
import { gradedSentence } from '../client/src/lib/odds-gate.js';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const page = read('client/src/pages/MyTeam.tsx');
/**
 * The layers object, sliced from `layers={{` rather than from a bare key name.
 * `method:` appears twice in this file as a fetch option long before the drawer
 * does, and slicing on it silently produced an empty string — a test that
 * asserted nothing and passed. Anchor on something that occurs once.
 */
const layers = page.slice(page.indexOf('layers={{'));
const between = (from, to) => layers.slice(layers.indexOf(from), layers.indexOf(to));
const glossary = read('client/src/lib/glossary.ts');

test('the championship number is a stat block that opens a deep dive', () => {
  assert.match(page, /<StatBlock\s+id="title_odds"/, 'the championship number is no longer a stat block');
  assert.match(page, /onOpen=\{\(\) => setDrill\(true\)\}/, 'it no longer opens anything');
  assert.match(page, /<DeepDive/, 'the drawer is gone');
  // Formatting goes through the glossary, so this number reads the same here as
  // it does anywhere else it appears.
  assert.doesNotMatch(page, /myTwin\.title_odds \* 100\)\.toFixed/,
    'the page is formatting the championship number by hand again');
  assert.match(glossary, /title_odds:/, 'the glossary entry it formats through is gone');
});

test('nothing opens on first paint', () => {
  assert.match(page, /useState\(false\);?\s*$/m, 'the drawer state is no longer closed by default');
  assert.match(page, /const \[drill, setDrill\] = useState\(false\)/, 'the drawer opens on arrival');
});

test('layer 4 does not claim the championship number was tested', () => {
  // THIS TEST WAS CHANGED WHEN THE ODDS GATE LANDED, AND WHY.
  //
  // It used to assert the literal sentence in MyTeam.tsx. Layer 4 is no longer
  // a literal: `gradedSentence(sim?.odds_gate)` builds it from what the server
  // says was graded, because the playoff side of this simulation HAS now been
  // graded — 184,959 real team-weeks — and a hard-coded "never been scored"
  // would be a false claim in the other direction.
  //
  // The intent is unchanged and both halves still have to survive: the inputs
  // were graded, and whatever has not been graded is said so. So this checks
  // the page still delegates, and checks the claim where it is now made.
  assert.match(layers, /tested: gradedSentence\(sim\?\.odds_gate\)/,
    'layer 4 stopped delegating to the graded sentence');
  assert.match(page, /import \{[^}]*gradedSentence[^}]*\} from '\.\.\/components\/ui\/OddsGate'/,
    'the page no longer imports the sentence it renders');

  // With nothing graded served, the original claim must still be the one made.
  const ungraded = gradedSentence(undefined);
  assert.match(ungraded, /not been scored against real finished\s+seasons/,
    'layer 4 stopped saying the championship number itself is ungraded');

  // With a grading served, it reports that grading and still names what the
  // grading did not cover. Neither form may say "calibrated".
  const graded = gradedSentence({
    published: false, min_week: 4, weeks_played: 0, reason: null,
    calibration: {
      graded_team_weeks: 184959,
      by_week: { 2: { brier: 0.2855, base_rate: 0.2410 } },
      extremes: { no_chance_qualify_rate: 0.1212, certain_miss_rate: 0.1011 },
      not_graded: "this app's own configuration"
    }
  });
  assert.match(graded, /grading did not cover/,
    'a graded payload stopped naming what the grading left out');
  for (const s of [ungraded, graded]) {
    assert.match(s, /week by week/, 'layer 4 stopped crediting the backtest that did happen');
    assert.doesNotMatch(s, /\bcalibrated\b/i, 'layer 4 is calling an unscored probability calibrated');
  }

  // And the claim it credits is checkable: the harness exists and grades weeks.
  const backtest = read('server/services/weekly-backtest.js');
  assert.match(backtest, /graded on\s+\n?\s*\*?\s*week W alone/,
    'the weekly backtest no longer grades the week it predicted');
});

test('an assumed input is marked assumed, not folded into the method sentence', () => {
  // A championship number built on an assumed playoff bracket is not the same
  // number as one built on the league's real schedule, and layer 2 is the only
  // place that difference is visible.
  const inputs = between('inputs: [', 'method:');
  assert.match(inputs, /playoff_basis === 'default_weeks_15_17' \? 'assumed' : 'measured'/,
    'an assumed bracket is no longer marked as assumed');
  assert.match(inputs, /volume numbers behind them are still hand-set/,
    'the fit input stopped saying its volume half is hand-set');
});

test('the method sentence explains without the vocabulary the glossary bans', () => {
  const method = between('method:', 'tested:');
  const banned = glossary.slice(glossary.indexOf('BANNED_WORDS'), glossary.indexOf('] as const'));
  for (const w of [...banned.matchAll(/'([a-z]+)'/g)].map(m => m[1])) {
    assert.doesNotMatch(method, new RegExp(`\\b${w}`, 'i'), `the method sentence uses "${w}"`);
  }
  // Nor the words this one would reach for: copula, Monte Carlo, Cholesky.
  for (const w of ['copula', 'monte carlo', 'cholesky', 'correlated']) {
    assert.doesNotMatch(method, new RegExp(w, 'i'), `the method sentence uses "${w}"`);
  }
});
