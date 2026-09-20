/**
 * The odds gate: when the championship and playoff percentages are shown.
 *
 * The playoff-odds simulation was graded on 184,959 real team-weeks across
 * 2,500 Sleeper leagues, 2021-2025. Before week 4 it is WORSE than telling
 * every team its league's base rate, and at every week it is overconfident at
 * both ends. A number that loses to the base rate is worse than no number,
 * because a manager acts on it — so the percentage is withheld until the odds
 * stand on enough results.
 *
 * Unlike the other files in this vocabulary, part of this one is a REAL unit
 * test: gateState is a pure function of the payload, so it is imported and
 * called rather than read as text. That matters, because the three states are
 * the whole design and a state that collapses into another is invisible in
 * source text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// Imported from the plain-JS module, not from OddsGate.tsx: node:test has no
// build step and cannot load a .tsx file. OddsGate.tsx re-exports these three,
// and the source-text assertions below check that it still does, so the thing
// the page imports and the thing this file calls stay the same code.
import { gateState, gradedSentence, BRIER_IN_WORDS } from '../client/src/lib/odds-gate.js';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const page = read('client/src/pages/MyTeam.tsx');
const gateSrc = read('client/src/components/ui/OddsGate.tsx');
const glossary = read('client/src/lib/glossary.ts');

const CAL = {
  graded_team_weeks: 184959,
  corpus: '2500 Sleeper leagues, 2021-2025',
  by_week: { 2: { brier: 0.2855, base_rate: 0.2410 }, 4: { brier: 0.21, base_rate: 0.2410 } },
  extremes: { no_chance_qualify_rate: 0.1212, certain_miss_rate: 0.1011 },
  measured_on: '2026-09-20',
  not_graded: "the app's own from-week-1 configuration was not graded"
};

test('no games played is its own state, not folded into "too early"', () => {
  // The distinction that matters most to someone two weeks into a season. The
  // odds standing on ZERO results is not "we need a bit more" — it is a
  // preseason projection that knows nothing about the games he has watched.
  // This is also what League Hub sends today: MyTeam.tsx requests the
  // simulation with no from_week at all.
  assert.equal(gateState({ published: false, min_week: 4, weeks_played: 0, reason: null }), 'no_results');
  assert.equal(gateState({ published: false, min_week: 4, weeks_played: 2, reason: null }), 'too_early');
  assert.equal(gateState({ published: true, min_week: 4, weeks_played: 5, reason: null }), 'published');
  // And zero wins over published: a gate that says published with no results is
  // contradicting itself, and the safer reading is the one that shows less.
  assert.equal(gateState({ published: true, min_week: 4, weeks_played: 0, reason: null }), 'no_results');
  // No gate served at all means nothing is being withheld — an older server
  // must not blank the page.
  assert.equal(gateState(null), 'published');
  assert.equal(gateState(undefined), 'published');
});

test('the page never sends a from_week, so this is the zero-results case live', () => {
  assert.match(page, /\/model\/\$\{active\.id\}\/simulate\?runs=1500/,
    'the simulation call changed — recheck whether it now sends results');
  const call = page.slice(page.indexOf('/simulate?runs=1500') - 60, page.indexOf('/simulate?runs=1500') + 40);
  assert.doesNotMatch(call, /from_week/,
    'the call now sends a from_week — the no_results state may no longer be what League Hub shows');
});

test('both percentages are gated, not just the headline', () => {
  // The playoff number is the one that was actually graded. It cannot stay a
  // bare percentage while the championship number beside it is withheld on that
  // grading's strength.
  assert.equal((page.match(/<WithheldOdds gate=\{sim\.odds_gate\}/g) ?? []).length, 2,
    'one of the two percentages is still ungated');
  assert.match(page, /label="Championship"/, 'the championship number lost its gate');
  assert.match(page, /label="Make playoffs"/, 'the playoff number lost its gate');
});

test('withholding the headline still opens the deep dive', () => {
  // Someone who wants to know why there is no percentage should be one tap from
  // the grading that says so. A dead end here would make the gate feel like a
  // failure rather than a decision.
  assert.match(page, /className="odds-withheld-open" onClick=\{\(\) => setDrill\(true\)\}/,
    'the withheld state no longer opens the drill-down');
});

test('the page and this test are calling the same code', () => {
  // This file imports the gate from lib/odds-gate.js because node:test cannot
  // load a .tsx module. That is only honest evidence while OddsGate.tsx gets
  // its logic from the same place. If someone re-implements gateState inside
  // the component, every test above would keep passing against a module the
  // page no longer uses.
  assert.match(gateSrc, /import \{ gateState, withheldReason \} from '\.\.\/\.\.\/lib\/odds-gate\.js'/,
    'the component no longer imports the gate logic this file tests');
  assert.doesNotMatch(gateSrc, /function gateState|function gradedSentence|function withheldReason/,
    'the component has grown its own copy of logic that lives in lib/odds-gate.js');
  assert.match(page, /from '\.\.\/components\/ui\/OddsGate'/,
    'the page no longer imports the gate components');
});

test('layer 4 keeps all four parts of what the grading found', () => {
  const s = gradedSentence({ published: false, min_week: 4, weeks_played: 0, reason: null, calibration: CAL });
  assert.match(s, /week by week/, 'dropped the credit for the walk-forward backtest that did happen');
  assert.match(s, /184,959/, 'dropped how much was graded');
  assert.match(s, /worse than/, 'dropped what the grading actually found');
  assert.match(s, /too sure of itself at the two ends/, 'dropped the overconfidence');
  assert.match(s, /grading did not cover/, 'dropped that this app\'s own configuration was not graded');
  assert.doesNotMatch(s, /\bcalibrated\b/i, 'is calling an ungraded configuration calibrated');
});

test('a Brier score is explained wherever one is shown', () => {
  // Nick's rule: explanations that make sense to someone who never deals with
  // stats. A bare "Brier 0.2855" is the exact opposite.
  const s = gradedSentence({ published: false, min_week: 4, weeks_played: 0, reason: null, calibration: CAL });
  assert.match(s, /0\.2855/, 'the score is gone');
  assert.match(s, new RegExp(BRIER_IN_WORDS.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'a score is shown without the sentence saying what it is');
  assert.doesNotMatch(s, /\bBrier\b/, 'the jargon name is shown instead of the explanation');
});

test('with no calibration served, layer 4 understates rather than inventing', () => {
  const s = gradedSentence({ published: true, min_week: 4, weeks_played: 6, reason: null });
  assert.match(s, /has not been scored against real finished\s+seasons here/,
    'an ungraded payload now claims a grading it was not given');
  assert.doesNotMatch(s, /184,959|worse than/, 'numbers appeared that the payload did not carry');
});

test('the withheld state is not styled as an error', () => {
  // Nothing is broken and nothing is wrong with the manager's team. Amber is
  // what this app uses for that, and greying or shrinking reads as "failed to
  // load", which is a different and wrong message.
  const css = read('client/src/index.css');
  const rules = css.slice(css.indexOf('.odds-withheld {'), css.indexOf('.odds-caveat'));
  assert.doesNotMatch(rules, /amber|var\(--warn\)|var\(--danger\)|var\(--crit\)/,
    'the withheld state is styled as a warning');
  assert.match(gateSrc, /basis=\{none \? 'missing' : 'none'\}/,
    'the withheld state no longer carries a basis chip');
});

test('the plain-words sentences avoid the vocabulary the glossary bans', () => {
  const banned = [...glossary.slice(glossary.indexOf('BANNED_WORDS'), glossary.indexOf('] as const'))
    .matchAll(/'([a-z]+)'/g)].map(m => m[1]);
  const sentences = [
    BRIER_IN_WORDS,
    gradedSentence({ published: false, min_week: 4, weeks_played: 0, reason: null, calibration: CAL })
  ];
  for (const s of sentences) {
    for (const w of banned) {
      assert.doesNotMatch(s, new RegExp(`\\b${w}`, 'i'), `"${w}" appears in a plain-words sentence`);
    }
  }
});

test('the grading carries its own as-of, beside the grade and not in the headline', () => {
  // A grading is a measurement like any other here: taken on a day, able to go
  // stale with nothing on screen changing. It belongs next to the number of
  // team-weeks it graded, not next to the percentage it is grading.
  const s = gradedSentence({ published: false, min_week: 4, weeks_played: 0, reason: null, calibration: CAL });
  assert.match(s, /184,959 real team-weeks from [^.]*, measured 2026-09-20\./,
    'the grading no longer says when it was taken, or says it somewhere else');
  // And a payload without one says nothing rather than inventing a date.
  const noDate = gradedSentence({
    published: false, min_week: 4, weeks_played: 0, reason: null,
    calibration: { ...CAL, measured_on: undefined }
  });
  assert.doesNotMatch(noDate, /measured /, 'a date appeared that the payload did not carry');
  assert.match(noDate, /184,959/, 'dropping the date dropped the grading with it');
});
