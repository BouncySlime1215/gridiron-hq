/**
 * Trade Lab's propose → verify → (retry once) → commit loop.
 *
 * Every `tradeImpact()` shape below is either a real measured run or built to
 * the same published shape. The lopsided case in particular is not invented:
 * the numbers come from `tradeImpact()` on league 29 ("Ajay's select league",
 * 12-team ESPN redraft), 600 paired runs, and are recorded in
 * docs/TRADE_LAB_VERIFY_LOOP.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  judgeTradeVerdict, proposeVerifyRetryTrade, tradeChallengeText, contradictionBar,
  stanceOf, TRADE_VERIFY_STATUS, TRADE_VERIFY_THRESHOLD, SENSE_CHECK_SIM_RUNS
} from '../server/services/trade-verify.js';

/* ------------------------------------------------------------- fixtures */

/** A `tradeImpact()` return value with the deltas dialled to order. */
const impact = ({ mine = 0, theirs = 0, runs = SENSE_CHECK_SIM_RUNS } = {}) => ({
  runs, from_week: 1, seed: 1, paired_simulation: true,
  me: {
    roster_id: '10', owner: 'My Team',
    title_before: 0.0833, title_after: +(0.0833 + mine).toFixed(4), title_delta: mine,
    playoff_before: 0.52, playoff_after: +(0.52 + mine * 4).toFixed(4), playoff_delta: +(mine * 4).toFixed(4),
    wins_delta: +(mine * 10).toFixed(2)
  },
  them: {
    roster_id: '3', owner: 'Their Team',
    title_before: 0.0833, title_after: +(0.0833 + theirs).toFixed(4), title_delta: theirs,
    playoff_before: 0.48, playoff_after: +(0.48 + theirs * 4).toFixed(4), playoff_delta: +(theirs * 4).toFixed(4),
    wins_delta: +(theirs * 10).toFixed(2)
  }
});

/**
 * REAL, MEASURED. League 29, my team (roster 10) sends Justin Jefferson +
 * Stefon Diggs for Quinshon Judkins + Jalen Hurts. The deterministic lineup
 * engine scores it at **+15.01 ppg for me** — it is, by the proxy the
 * sense-check reasons over, a large win. Six seeds of `tradeImpact()` at 600
 * runs put my championship odds change at -0.0433 / -0.0450 / -0.0400 / -0.0400
 * / -0.0333 / -0.0267, mean **-3.8pp**, while the other side gains ~+5.8pp.
 *
 * This is the case the whole loop exists for: points says yes, the season says
 * no, and nothing in the sense-check's inputs would have told it so.
 */
const LOPSIDED = {
  runs: 600, from_week: 1, seed: 1, paired_simulation: true,
  me: {
    roster_id: '10', owner: 'Ajay\'s select league — my team',
    title_before: 0.1350, title_after: 0.0917, title_delta: -0.0433,
    playoff_before: 0.7717, playoff_after: 0.5667, playoff_delta: -0.2050,
    wins_delta: -1.42
  },
  them: {
    roster_id: '2', owner: 'Ajay\'s Eleven',
    title_before: 0.0733, title_after: 0.1067, title_delta: 0.0334,
    playoff_before: 0.4283, playoff_after: 0.6100, playoff_delta: 0.1817,
    wins_delta: 1.19
  }
};

/** A loop runner that counts calls and records the order things happened in. */
function runner({ first, second = null, sim = null, order = [] } = {}) {
  const calls = { propose: 0, retry: 0, simulate: 0 };
  return {
    calls, order,
    run: () => proposeVerifyRetryTrade({
      propose: async () => { calls.propose++; order.push('propose:start'); await Promise.resolve(); order.push('propose:end'); return first; },
      simulate: sim === false ? null : () => { calls.simulate++; order.push('simulate'); return sim; },
      verify: (verdict, imp) => ({ ...judgeTradeVerdict(imp, verdict), proposed_verdict: verdict }),
      retry: async (judgement) => { calls.retry++; order.push('retry'); return typeof second === 'function' ? second(judgement) : second; }
    })
  };
}

const sound = { verdict: 'sound', headline: 'h', evidence: 'e', concerns: ['c'], agrees_with_engine: true, why: 'w' };

/* ------------------------------------------------------- the vocabulary */

test('every verdict the sense-check prompt can emit maps to a stance', () => {
  assert.equal(stanceOf('sound'), 'accept');
  assert.equal(stanceOf('worth a second look'), 'caution');
  assert.equal(stanceOf('risky'), 'reject');
  assert.equal(stanceOf('lopsided'), 'reject');
  // The model does not always match the prompt's casing or spacing.
  assert.equal(stanceOf('  Sound '), 'accept');
});

test('a verdict outside the vocabulary is unverified rather than guessed at', () => {
  const j = judgeTradeVerdict(impact({ mine: -0.09 }), 'terrible idea');
  assert.equal(j.status, TRADE_VERIFY_STATUS.UNVERIFIED);
  assert.equal(j.contradicted, false);
  assert.match(j.reason, /not one of the four verdicts/);
});

/* ---------------------------------------------------------- the threshold */

test('the bar is the measured noise, doubled, and is binding over the material floor', () => {
  const atReference = contradictionBar(TRADE_VERIFY_THRESHOLD.REFERENCE_RUNS);
  assert.equal(atReference.noise_bar,
    +(TRADE_VERIFY_THRESHOLD.SE_FACTOR * TRADE_VERIFY_THRESHOLD.NOISE_SD_AT_REFERENCE_RUNS).toFixed(4));
  // The route does not run at the reference count — it runs at whatever
  // SENSE_CHECK_SIM_RUNS says — so the bar that actually ships is this one.
  const shipped = contradictionBar(SENSE_CHECK_SIM_RUNS);
  assert.ok(shipped.noise_bar > shipped.material_bar, 'at the shipped run count the statistical bar still binds');
  assert.equal(shipped.required, shipped.noise_bar);
  assert.ok(shipped.noise_bar < atReference.noise_bar,
    'the shipped run count is above the reference, so the shipped bar must be tighter');
});

test('the bar tracks the run count on its own — more runs, tighter bar', () => {
  const ref = contradictionBar(TRADE_VERIFY_THRESHOLD.REFERENCE_RUNS).noise_bar;
  const quadrupled = contradictionBar(TRADE_VERIFY_THRESHOLD.REFERENCE_RUNS * 4).noise_bar;
  const quartered = contradictionBar(TRADE_VERIFY_THRESHOLD.REFERENCE_RUNS / 4).noise_bar;
  // 1/sqrt(runs): four times the runs halves the noise bar.
  assert.ok(Math.abs(quadrupled - ref / 2) < 1e-4, `${quadrupled} should be half of ${ref}`);
  assert.ok(Math.abs(quartered - ref * 2) < 1e-4);
});

test('the material floor takes over once the run count is high enough to resolve nothing useful', () => {
  const huge = contradictionBar(1e6);
  assert.equal(huge.required, TRADE_VERIFY_THRESHOLD.MATERIAL_TITLE_DELTA);
});

/* ------------------------------------------------------------- judgement */

test('an approving verdict the simulation agrees with is confirmed', () => {
  const j = judgeTradeVerdict(impact({ mine: 0.05, theirs: -0.01 }), 'sound');
  assert.equal(j.status, TRADE_VERIFY_STATUS.CONFIRMED);
  assert.equal(j.contradicted, false);
  assert.equal(j.gap, 0.05);
});

test('an approving verdict on a deal the simulation dislikes only slightly is still confirmed', () => {
  const bar = contradictionBar(SENSE_CHECK_SIM_RUNS).required;
  const j = judgeTradeVerdict(impact({ mine: -(bar * 0.9) }), 'sound');
  assert.equal(j.status, TRADE_VERIFY_STATUS.CONFIRMED);
  assert.match(j.reason, /inside the .* bar/);
});

test('an approving verdict on a deal the simulation clearly rejects is contradicted', () => {
  const j = judgeTradeVerdict(impact({ mine: -0.06 }), 'sound');
  assert.equal(j.contradicted, true);
  assert.equal(j.status, null);
  assert.match(j.reason, /take this deal/);
});

test('a rejecting verdict on a deal the simulation clearly likes is contradicted in the other direction', () => {
  for (const verdict of ['risky', 'lopsided']) {
    const j = judgeTradeVerdict(impact({ mine: 0.07 }), verdict);
    assert.equal(j.contradicted, true, verdict);
    assert.match(j.reason, /do not take this deal/);
  }
});

test('a non-committal verdict is contradicted symmetrically — a shrug loses to a clear answer either way', () => {
  const up = judgeTradeVerdict(impact({ mine: 0.07 }), 'worth a second look');
  const down = judgeTradeVerdict(impact({ mine: -0.07 }), 'worth a second look');
  const flat = judgeTradeVerdict(impact({ mine: 0.004 }), 'worth a second look');
  assert.equal(up.contradicted, true);
  assert.equal(down.contradicted, true);
  assert.equal(flat.contradicted, false, 'a genuinely undecided simulation does not contradict a shrug');
});

test('both sides of the trade are simulated and both are reported', () => {
  const j = judgeTradeVerdict(impact({ mine: 0.05, theirs: -0.03 }), 'sound');
  assert.equal(j.my_side.title_delta, 0.05);
  assert.equal(j.their_side.title_delta, -0.03);
  assert.equal(j.their_side.owner, 'Their Team');
  assert.ok(j.paired, 'the check must be reading a paired (common random numbers) simulation');
});

test('a simulation that could not run leaves the answer unverified rather than blocking it', () => {
  for (const bad of [null, { error: 'both teams required' }, { runs: 600 }]) {
    const j = judgeTradeVerdict(bad, 'sound');
    assert.equal(j.status, TRADE_VERIFY_STATUS.UNVERIFIED);
    assert.equal(j.contradicted, false);
  }
});

/* ----------------------------------------------- the real lopsided trade */

test('THE CASE THIS EXISTS FOR: +15 ppg by the engine, -4.3pp of title odds by the season — and Claude approving it gets caught', async () => {
  // The lineup engine scores this deal at +15.01 ppg for me. A second opinion
  // reading only the engine's numbers has every reason to call it sound.
  const j = judgeTradeVerdict(LOPSIDED, 'sound');
  assert.equal(j.contradicted, true,
    'a deal that costs 4.3pp of championship odds must not be waved through as "sound"');
  assert.ok(Math.abs(j.gap) > j.bar, `${j.gap} must clear the ${j.bar} bar`);
  // And the other side is the mirror image, which is what makes it lopsided
  // rather than merely bad.
  assert.ok(j.their_side.title_delta > 0);

  const r = runner({ first: sound, sim: LOPSIDED, second: { verdict: 'lopsided', headline: 'H2', why: 'W2' } });
  const out = await r.run();
  assert.equal(out.verification.status, TRADE_VERIFY_STATUS.REVISED);
  assert.equal(out.verification.revised, true);
  assert.equal(out.verdict, 'lopsided');
  assert.equal(r.calls.propose + r.calls.retry, 2);
  assert.match(out.verification.note, /Revised after simulation/);
});

test('the challenge text hands over both teams\' actual numbers and does not lead the model', () => {
  const j = { ...judgeTradeVerdict(LOPSIDED, 'sound'), proposed_verdict: 'sound' };
  const text = tradeChallengeText(j);
  assert.match(text, /-4\.3pp/, 'my measured title-odds delta must appear');
  assert.match(text, /\+3\.3pp/, "their measured title-odds delta must appear too");
  assert.match(text, /600 times/, 'the run count must be stated');
  assert.match(text, /Both are real answers/, 'holding the verdict must be offered as legitimate');
  assert.match(text, /WHAT IT DOES NOT KNOW/, 'the simulation must state its own blind spots');
  assert.doesNotMatch(text, /you (were|are) wrong/i);
});

/* ------------------------------------------------------------- the loop */

test('confirmed on the first pass costs exactly one Claude call', async () => {
  const r = runner({ first: sound, sim: impact({ mine: 0.04 }) });
  const out = await r.run();
  assert.equal(out.verification.status, TRADE_VERIFY_STATUS.CONFIRMED);
  assert.equal(out.verification.claude_calls, 1);
  assert.equal(r.calls.retry, 0);
  assert.equal(out.verdict, 'sound');
  assert.equal(out.concerns[0], 'c', 'the proposal is returned untouched');
  assert.match(out.verification.note, /Confirmed on the first pass/);
});

test('a contradiction spends exactly one retry, and the retry keeping its verdict is "upheld", not a failure', async () => {
  const r = runner({ first: sound, sim: impact({ mine: -0.08 }), second: { verdict: 'sound', why: 'the injury designation outweighs it' } });
  const out = await r.run();
  assert.equal(out.verification.status, TRADE_VERIFY_STATUS.UPHELD);
  assert.equal(out.verification.revised, false);
  assert.equal(out.verification.claude_calls, 2);
  assert.equal(out.why, 'the injury designation outweighs it');
  assert.match(out.verification.note, /kept "sound"/);
});

test('THE CAP IS HARD: a retry whose new verdict the simulation would like even less still stops at two calls', async () => {
  // The test that would defeat a naive "retry until they agree": the second
  // answer is a verdict the same simulation contradicts just as clearly. A loop
  // would keep going. This stops, and takes the second answer.
  const r = runner({
    first: sound,
    sim: impact({ mine: -0.08 }),
    // 'risky' on a -8pp deal is not contradicted, so flip to a deal the sim
    // likes and have the retry reject it — the second answer is contradicted by
    // the same numbers that fired the retry.
    second: { verdict: 'risky', why: 'still no' }
  });
  const out = await r.run();
  assert.equal(r.calls.propose, 1);
  assert.equal(r.calls.retry, 1);
  assert.equal(r.calls.simulate, 1, 'the simulation is NOT re-run to re-judge the retry — that is the first half of a loop');
  assert.equal(out.verification.claude_calls, 2);
});

test('the retry cap holds even when the retry returns nothing usable', async () => {
  const r = runner({ first: sound, sim: impact({ mine: -0.08 }), second: null });
  const out = await r.run();
  assert.equal(r.calls.retry, 1);
  assert.equal(out.verdict, 'sound', 'an unusable retry falls back to the original answer');
  assert.equal(out.verification.final_verdict, 'sound');
  assert.equal(out.verification.status, TRADE_VERIFY_STATUS.UPHELD);
});

test('an unverified proposal never spends the retry and still returns the answer', async () => {
  const r = runner({ first: sound, sim: { error: 'both teams required' } });
  const out = await r.run();
  assert.equal(out.verification.status, TRADE_VERIFY_STATUS.UNVERIFIED);
  assert.equal(out.verification.claude_calls, 1);
  assert.equal(r.calls.retry, 0);
  assert.equal(out.verdict, 'sound');
  assert.match(out.verification.note, /Not simulation-checked/);
});

test('the simulation is started while the propose call is still in flight', async () => {
  const order = [];
  const r = runner({ first: sound, sim: impact({ mine: 0.04 }), order });
  await r.run();
  const started = order.indexOf('propose:start');
  const simulated = order.indexOf('simulate');
  const finished = order.indexOf('propose:end');
  assert.ok(started >= 0 && simulated > started, 'the simulation must start after the request is dispatched');
  assert.ok(simulated < finished,
    'the simulation must run BEFORE the propose call is awaited, or the whole sim cost lands on the user');
});

test('a failing propose call is not masked by the simulation running underneath it', async () => {
  await assert.rejects(() => proposeVerifyRetryTrade({
    propose: async () => { throw new Error('anthropic 529'); },
    simulate: () => impact({ mine: 0.04 }),
    verify: (v, i) => judgeTradeVerdict(i, v),
    retry: async () => { throw new Error('retry must not run'); }
  }), /anthropic 529/);
});

test('a simulation that throws is caught and downgraded to unverified, never to a 500', async () => {
  const out = await proposeVerifyRetryTrade({
    propose: async () => sound,
    simulate: () => { throw new Error('projections table missing'); },
    verify: (v, i) => judgeTradeVerdict(i, v),
    retry: async () => { throw new Error('retry must not run'); }
  });
  assert.equal(out.verification.status, TRADE_VERIFY_STATUS.UNVERIFIED);
  assert.equal(out.verification.claude_calls, 1);
});

test('the committed payload carries the numbers that decided it', async () => {
  const r = runner({ first: sound, sim: LOPSIDED, second: { verdict: 'risky' } });
  const out = await r.run();
  const s = out.verification.simulation;
  assert.equal(s.runs, 600);
  assert.equal(s.paired, true);
  assert.equal(s.contradicted, true);
  assert.equal(s.title_delta, -0.0433);
  assert.equal(s.my_team.owner, LOPSIDED.me.owner);
  assert.equal(s.their_team.owner, LOPSIDED.them.owner);
  assert.ok(s.threshold.required_gap > 0);
  assert.equal(out.verification.proposed_verdict, 'sound');
  assert.equal(out.verification.final_verdict, 'risky');
  assert.ok(out.verification.latency_ms.simulate_overlapped);
});

test('the retry re-decides the deal, and fields it omits keep the first answer', async () => {
  const r = runner({ first: sound, sim: impact({ mine: -0.08 }), second: { verdict: 'risky', headline: 'new headline' } });
  const out = await r.run();
  assert.equal(out.verdict, 'risky');
  assert.equal(out.headline, 'new headline');
  assert.equal(out.evidence, 'e', 'omitted by the retry, so carried over');
  assert.deepEqual(out.concerns, ['c']);
  assert.equal(out.agrees_with_engine, true, 'a claim about the deterministic engine, which the retry saw nothing new about');
});
