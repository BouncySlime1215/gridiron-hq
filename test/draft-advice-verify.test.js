import test from 'node:test';
import assert from 'node:assert/strict';
import {
  judgeProposal, proposeVerifyRetry, challengeText,
  VERIFY_THRESHOLD, VERIFY_STATUS
} from '../server/services/draft-advice-verify.js';

/**
 * The live advisor's propose → verify → (retry once) loop.
 *
 * Everything here is driven by injected fakes rather than a real draft: the
 * point under test is the DECISION LOGIC and the hard cap on Claude calls, and
 * those must be provable without a database, an API key, or two seconds of
 * Monte Carlo per assertion. The simulation objects below are hand-built in
 * `lookahead()`'s published shape.
 */

/** A `lookahead()` return value, in the exact shape the real one produces. */
function sim(candidates, { sims = 200 } = {}) {
  const sorted = [...candidates].sort((a, b) => (b.expected ?? -1) - (a.expected ?? -1));
  const best = sorted.find(c => c.expected != null);
  return {
    pick_number: 24, sims, generated_at: new Date().toISOString(),
    candidates: sorted.map(c => ({
      player_id: c.player_id ?? c.name.toLowerCase().replace(/\W/g, ''),
      name: c.name, position: c.position ?? 'RB', team_abbr: c.team_abbr ?? 'DAL',
      expected: c.expected, sd: c.sd ?? 330, sims: c.expected == null ? 0 : sims,
      sniped_pct: c.sniped_pct ?? 0,
      typical_build: 'RB 4.0, WR 5.0', likely_next: [],
      delta: c.expected == null || !best ? null : +(c.expected - best.expected).toFixed(1)
    }))
  };
}

/* ------------------------------------------------------------ the threshold */

test('the proposal is confirmed when the simulation also ranks it first', () => {
  const v = judgeProposal(sim([
    { name: 'Breece Hall', expected: 2162 },
    { name: 'Trey McBride', expected: 2153 }
  ]), 'Breece Hall');
  assert.equal(v.contradicted, false);
  assert.equal(v.status, VERIFY_STATUS.CONFIRMED);
  // `gap` is the proposal's signed SHORTFALL against the best alternative, so a
  // proposal that is itself the best reports a negative one.
  assert.equal(v.gap, -9);
  assert.match(v.reason, /also ranks Breece Hall first/);
});

test('a noise-level shortfall is confirmed, not contradicted', () => {
  // Real numbers from a round-2 board: the top five shortlist candidates sat
  // within 25 pts of each other on a ~2160-pt roster, and the measured
  // seed-to-seed noise in that gap was ~10-24 pts. A retry there would be
  // chasing simulation noise on a 90-second clock.
  const v = judgeProposal(sim([
    { name: 'Jeremiyah Love', expected: 2162.5, sd: 329 },
    { name: 'Brock Bowers', expected: 2137.4, sd: 335.9 }
  ]), 'Brock Bowers');
  assert.equal(v.contradicted, false, `should be inside the bar, got gap ${v.gap} vs ${v.threshold.required_gap}`);
  assert.equal(v.gap, 25.1);
  assert.ok(v.threshold.required_gap > 25.1);
});

test('a clear, material shortfall is contradicted', () => {
  // Same board, but the proposal is a player ~90 spots down: 66 pts of
  // finished-roster value below the best alternative, past every bar.
  const v = judgeProposal(sim([
    { name: 'Jeremiyah Love', expected: 2162.5, sd: 329 },
    { name: 'MarShawn Lloyd', expected: 2096.6, sd: 304.1 }
  ]), 'MarShawn Lloyd');
  assert.equal(v.contradicted, true);
  assert.equal(v.gap, 65.9);
  assert.ok(v.gap > v.threshold.required_gap);
  assert.match(v.reason, /Jeremiyah Love simulates 65\.9 pts/);
});

test('the noise bar scales with the simulation count, so fewer sims means a duller trigger', () => {
  const cands = [{ name: 'A', expected: 2160, sd: 330 }, { name: 'B', expected: 2100, sd: 330 }];
  const at200 = judgeProposal(sim(cands, { sims: 200 }), 'B');
  const at50 = judgeProposal(sim(cands, { sims: 50 }), 'B');
  assert.ok(at50.threshold.required_gap > at200.threshold.required_gap);
  assert.equal(at200.contradicted, true);
  assert.equal(at50.contradicted, false, 'at 50 sims a 60-pt gap is not yet distinguishable from noise');
});

test('a wider simulated sd raises the bar — admitting more uncertainty makes the retry rarer', () => {
  // This is the property that matters as draft-lookahead.js grows real
  // player-outcome variance underneath: a bigger sd must never make the loop
  // MORE twitchy.
  const narrow = judgeProposal(sim([{ name: 'A', expected: 2160, sd: 120 }, { name: 'B', expected: 2100, sd: 120 }]), 'B');
  const wide = judgeProposal(sim([{ name: 'A', expected: 2160, sd: 600 }, { name: 'B', expected: 2100, sd: 600 }]), 'B');
  assert.ok(wide.threshold.required_gap > narrow.threshold.required_gap);
  assert.equal(narrow.contradicted, true);
  assert.equal(wide.contradicted, false);
});

test('both bars must be cleared — a statistically clean but immaterial gap is not a contradiction', () => {
  // Tiny sd makes the noise bar vanish; the 1%-of-roster material bar is then
  // what stops a 5-pt "difference" from burning a Claude call.
  const v = judgeProposal(sim([{ name: 'A', expected: 2160, sd: 1 }, { name: 'B', expected: 2155, sd: 1 }]), 'B');
  assert.equal(v.contradicted, false);
  assert.ok(v.threshold.material_bar > v.threshold.noise_bar);
  assert.equal(v.threshold.required_gap, v.threshold.material_bar);
});

test('names are compared through the caller\'s matcher, not by string identity', () => {
  const loose = (a, b) => a.replace(/[^a-z]/gi, '').toLowerCase() === b.replace(/[^a-z]/gi, '').toLowerCase();
  const s = sim([{ name: 'T.J. Hockenson', expected: 2100 }, { name: 'Breece Hall', expected: 2160 }]);
  assert.equal(judgeProposal(s, 'TJ Hockenson').status, VERIFY_STATUS.UNVERIFIED, 'strict matching cannot find him');
  assert.equal(judgeProposal(s, 'TJ Hockenson', { matches: loose }).proposed.name, 'T.J. Hockenson');
});

/* ------------------------------------------------ when no check is possible */

test('an unsimulatable proposal is reported unverified rather than contradicted', () => {
  for (const [label, s, name] of [
    ['no simulation at all', null, 'Breece Hall'],
    ['no pick proposed', sim([{ name: 'Breece Hall', expected: 2160 }]), null],
    ['a name the simulation never saw', sim([{ name: 'Breece Hall', expected: 2160 }]), 'Somebody Else']
  ]) {
    const v = judgeProposal(s, name);
    assert.equal(v.status, VERIFY_STATUS.UNVERIFIED, label);
    assert.equal(v.contradicted, false, `${label}: unverified must never trigger a retry`);
  }
});

test('a candidate sniped in most simulated worlds is neither judged nor used as the challenger', () => {
  const sniped = judgeProposal(sim([
    { name: 'Breece Hall', expected: 2400, sniped_pct: 90 },
    { name: 'Trey McBride', expected: 2160 }
  ]), 'Breece Hall');
  assert.equal(sniped.status, VERIFY_STATUS.UNVERIFIED);
  assert.match(sniped.reason, /10% of simulated worlds/);

  // And the same player cannot beat a live proposal with his selection-biased mean.
  const asChallenger = judgeProposal(sim([
    { name: 'Breece Hall', expected: 2400, sniped_pct: 90 },
    { name: 'Trey McBride', expected: 2160 },
    { name: 'Brock Bowers', expected: 2150 }
  ]), 'Trey McBride');
  assert.equal(asChallenger.challenger.name, 'Brock Bowers');
  assert.equal(asChallenger.contradicted, false);
});

test('a candidate taken before my turn in every world has no expected value to judge', () => {
  const v = judgeProposal(sim([
    { name: 'Breece Hall', expected: null, sniped_pct: 100 },
    { name: 'Trey McBride', expected: 2160 }
  ]), 'Breece Hall');
  assert.equal(v.status, VERIFY_STATUS.UNVERIFIED);
  assert.equal(v.contradicted, false);
});

/* -------------------------------------------------------- the bounded loop */

/** A propose/retry pair that counts how many times Claude was actually asked. */
function fakeClaude({ first, second }) {
  const calls = [];
  return {
    calls,
    propose: async () => { calls.push('propose'); return { advice: structuredClone(first) }; },
    retry: async (verdict) => { calls.push('retry'); return typeof second === 'function' ? second(verdict) : structuredClone(second); }
  };
}

const FIRST = {
  pick: 'Brock Bowers',
  why: 'Top-3 TE in each of his two seasons; my TE slot is the only starting hole left.',
  evidence: '1,100 rec yds, 112 targets, TE1 overall',
  players: [
    { name: 'Brock Bowers', pros: 'p', cons: 'c', camp: 'fine', status: 'healthy', verdict: 'take' },
    { name: 'Jeremiyah Love', pros: 'p', cons: 'c', camp: 'fine', status: 'rookie', verdict: 'fine here' }
  ],
  position_priority: 'TE then RB',
  next_turn_outlook: 'An RB2 should survive.'
};

test('confirmed first try: one Claude call, the advice is untouched, and the response says so', async () => {
  const fake = fakeClaude({ first: FIRST });
  const res = await proposeVerifyRetry({
    ...fake,
    verify: name => judgeProposal(sim([
      { name: 'Brock Bowers', expected: 2162.5 },
      { name: 'Jeremiyah Love', expected: 2153.6 }
    ]), name)
  });

  assert.deepEqual(fake.calls, ['propose'], 'the retry must not fire when the simulation agrees');
  assert.equal(res.verification.claude_calls, 1);
  assert.equal(res.verification.status, VERIFY_STATUS.CONFIRMED);
  assert.equal(res.verification.revised, false);
  assert.equal(res.verification.proposed_pick, 'Brock Bowers');
  assert.equal(res.verification.final_pick, 'Brock Bowers');
  assert.match(res.verification.note, /Confirmed on the first pass/);
  assert.deepEqual(res.advice, FIRST, 'a confirmed proposal is returned exactly as proposed');
  assert.equal(res.verification.simulation.contradicted, false);
  assert.equal(res.verification.latency_ms.retry_ms, null);
});

test('retry triggered: the simulation disagrees, Claude reconsiders, and the pick is marked revised', async () => {
  const fake = fakeClaude({
    first: FIRST,
    second: verdict => {
      // The challenge must carry the actual numbers, not a vague nudge.
      assert.match(verdict.reason, /Jeremiyah Love simulates/);
      const text = challengeText(verdict);
      assert.match(text, /2162\.5/);
      assert.match(text, /2096\.6/);
      assert.match(text, /Brock Bowers/);
      assert.match(text, /Jeremiyah Love/);
      return { pick: 'Jeremiyah Love', why: 'Sim says so.', evidence: '66 pts of roster value' };
    }
  });
  const res = await proposeVerifyRetry({
    ...fake,
    verify: name => judgeProposal(sim([
      { name: 'Jeremiyah Love', expected: 2162.5, sd: 329 },
      { name: 'Brock Bowers', expected: 2096.6, sd: 304.1 }
    ]), name)
  });

  assert.deepEqual(fake.calls, ['propose', 'retry']);
  assert.equal(res.verification.claude_calls, 2);
  assert.equal(res.verification.status, VERIFY_STATUS.REVISED);
  assert.equal(res.verification.revised, true);
  assert.equal(res.verification.proposed_pick, 'Brock Bowers');
  assert.equal(res.verification.final_pick, 'Jeremiyah Love');
  assert.match(res.verification.note, /Revised after simulation/);
  assert.equal(res.advice.pick, 'Jeremiyah Love');
  assert.equal(res.advice.why, 'Sim says so.');
  // The scouting read is carried over rather than re-billed — it is per-player,
  // and a roster simulation says nothing about it.
  assert.equal(res.advice.players.length, 2);
  assert.equal(res.advice.players[0].pros, 'p');
  assert.equal(res.advice.position_priority, 'TE then RB', 'untouched fields survive the merge');
  // ...but the per-player verdicts, which ARE the choice, are reconciled.
  assert.equal(res.advice.players.find(p => p.name === 'Jeremiyah Love').verdict, 'take');
  assert.equal(res.advice.players.find(p => p.name === 'Brock Bowers').verdict, 'fine here');
});

test('retry that holds its ground: still 2 calls, marked upheld rather than revised', async () => {
  const fake = fakeClaude({
    first: FIRST,
    second: { pick: 'Brock Bowers', why: 'The sim cannot see that Love is on the PUP list.', evidence: 'PUP' }
  });
  const res = await proposeVerifyRetry({
    ...fake,
    verify: name => judgeProposal(sim([
      { name: 'Jeremiyah Love', expected: 2162.5, sd: 329 },
      { name: 'Brock Bowers', expected: 2096.6, sd: 304.1 }
    ]), name)
  });

  assert.deepEqual(fake.calls, ['propose', 'retry']);
  assert.equal(res.verification.status, VERIFY_STATUS.UPHELD);
  assert.equal(res.verification.revised, false);
  assert.equal(res.verification.claude_calls, 2);
  assert.equal(res.advice.pick, 'Brock Bowers');
  assert.match(res.verification.note, /kept Brock Bowers/);
});

/* -------------------------------------------------------------- the hard cap */

test('the retry cap holds: never more than 2 Claude calls, whatever the retry answers', async () => {
  // The scenario that would defeat a naive "loop until they agree": the retry
  // comes back with a THIRD name that the simulation likes even less. A loop
  // would keep going and blow the pick clock; this must stop at two.
  const s = sim([
    { name: 'Jeremiyah Love', expected: 2162.5, sd: 329 },
    { name: 'Brock Bowers', expected: 2096.6, sd: 304.1 },
    { name: 'MarShawn Lloyd', expected: 1990.0, sd: 300 }
  ]);
  const fake = fakeClaude({ first: FIRST, second: { pick: 'MarShawn Lloyd', why: 'w', evidence: 'e' } });
  let verifyCalls = 0;
  const res = await proposeVerifyRetry({
    ...fake,
    verify: name => { verifyCalls++; return judgeProposal(s, name); }
  });

  assert.equal(fake.calls.filter(c => c === 'propose').length, 1);
  assert.equal(fake.calls.filter(c => c === 'retry').length, 1, 'exactly one retry, never a second');
  assert.equal(fake.calls.length, 2);
  assert.equal(verifyCalls, 1, 'the simulation is not re-run to re-judge the retry — that is the loop');
  assert.equal(res.verification.claude_calls, 2);
  assert.equal(res.advice.pick, 'MarShawn Lloyd', 'whatever the second call says is final, agreement or not');
});

test('an unverified proposal never spends the retry', async () => {
  const fake = fakeClaude({ first: FIRST, second: { pick: 'Someone', why: 'w', evidence: 'e' } });
  const res = await proposeVerifyRetry({ ...fake, verify: name => judgeProposal(null, name) });
  assert.deepEqual(fake.calls, ['propose']);
  assert.equal(res.verification.status, VERIFY_STATUS.UNVERIFIED);
  assert.equal(res.verification.claude_calls, 1);
  assert.match(res.verification.note, /Not simulation-checked/);
});

test('a retry that comes back unusable falls back to the proposal instead of losing the pick', async () => {
  const fake = fakeClaude({ first: FIRST, second: { why: 'no pick field at all' } });
  const res = await proposeVerifyRetry({
    ...fake,
    verify: name => judgeProposal(sim([
      { name: 'Jeremiyah Love', expected: 2162.5, sd: 329 },
      { name: 'Brock Bowers', expected: 2096.6, sd: 304.1 }
    ]), name)
  });
  assert.equal(res.advice.pick, 'Brock Bowers');
  assert.equal(res.verification.final_pick, 'Brock Bowers');
  assert.equal(res.verification.status, VERIFY_STATUS.UPHELD);
  assert.equal(res.verification.claude_calls, 2, 'the call was still spent and must still be counted');
});

/* ------------------------------------------- the simulation runs concurrently */

test('the simulation is started while the propose call is still in flight', async () => {
  // This is where the verify step's ~1.9s goes: inside the ~10s the model
  // spends generating, not after it. If this ordering ever regresses, the
  // feature silently gets two seconds slower on every single pick.
  const order = [];
  let releasePropose;
  const proposed = new Promise(res => { releasePropose = res; });

  const res = await proposeVerifyRetry({
    propose: async () => { order.push('propose:start'); await proposed; order.push('propose:end'); return { advice: FIRST }; },
    simulate: () => {
      order.push('simulate');
      // The propose call has NOT resolved yet at this point — that is the test.
      releasePropose();
      return sim([{ name: 'Brock Bowers', expected: 2162.5 }, { name: 'Jeremiyah Love', expected: 2153.6 }]);
    },
    verify: (name, s) => { order.push('verify'); return judgeProposal(s, name); },
    retry: async () => { throw new Error('must not be reached'); }
  });

  assert.deepEqual(order, ['propose:start', 'simulate', 'propose:end', 'verify']);
  assert.equal(res.verification.status, VERIFY_STATUS.CONFIRMED);
  assert.equal(res.verification.latency_ms.simulate_overlapped, true);
});

test('a simulation that throws leaves the advice intact and unverified', async () => {
  const fake = fakeClaude({ first: FIRST, second: { pick: 'Other', why: 'w', evidence: 'e' } });
  const res = await proposeVerifyRetry({
    propose: fake.propose,
    retry: fake.retry,
    simulate: () => { throw new Error('board unavailable'); },
    verify: (name, s) => judgeProposal(s, name)
  });
  assert.deepEqual(fake.calls, ['propose'], 'a broken simulation must not spend the retry');
  assert.equal(res.verification.status, VERIFY_STATUS.UNVERIFIED);
  assert.equal(res.advice.pick, 'Brock Bowers');
});

test('a failing propose call still rejects, and is not masked by the concurrent simulation', async () => {
  let simulated = false;
  await assert.rejects(
    proposeVerifyRetry({
      propose: async () => { throw new Error('anthropic 529'); },
      simulate: () => { simulated = true; return null; },
      verify: (name, s) => judgeProposal(s, name),
      retry: async () => ({ pick: 'x' })
    }),
    /anthropic 529/
  );
  assert.equal(simulated, true, 'the simulation had already started when the call failed');
});

/* ---------------------------------------------------- the consumed interface */

test('judgeProposal reads only the lookahead fields it documents, and tolerates the rest changing', () => {
  // draft-lookahead.js is under active development (player-outcome variance via
  // a copula). This pins the narrow contract this module actually depends on,
  // so a shape change breaks here loudly rather than silently degrading the
  // check during a live draft.
  const minimal = {
    sims: 200,
    candidates: [
      { name: 'A', expected: 2160, sd: 330, sims: 200, sniped_pct: 0 },
      { name: 'B', expected: 2060, sd: 330, sims: 200, sniped_pct: 0 }
    ]
  };
  const v = judgeProposal(minimal, 'B');
  assert.equal(v.contradicted, true);
  assert.equal(v.gap, 100);
  assert.equal(v.proposed.name, 'B');
  assert.equal(v.challenger.name, 'A');

  // Missing optional fields must degrade, not throw.
  const sparse = { sims: 200, candidates: [{ name: 'A', expected: 2160 }, { name: 'B', expected: 2060 }] };
  assert.doesNotThrow(() => judgeProposal(sparse, 'B'));
  assert.equal(judgeProposal(sparse, 'B').contradicted, true, 'with no sd the material bar alone decides');
});

test('the published threshold is the one the code applies', () => {
  assert.equal(VERIFY_THRESHOLD.SE_FACTOR, 2);
  assert.equal(VERIFY_THRESHOLD.CRN_FACTOR, 0.75);
  assert.equal(VERIFY_THRESHOLD.MATERIAL_FRAC, 0.01);
  const v = judgeProposal(sim([{ name: 'A', expected: 2160, sd: 330 }, { name: 'B', expected: 2000, sd: 330 }]), 'B');
  const se = 0.75 * Math.sqrt((330 ** 2) / 200 + (330 ** 2) / 200);
  assert.equal(v.threshold.noise_bar, +(2 * se).toFixed(1));
  assert.equal(v.threshold.material_bar, +(0.01 * 2160).toFixed(1));
});
