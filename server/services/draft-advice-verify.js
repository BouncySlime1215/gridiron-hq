/**
 * The verify half of the live draft advisor's propose → verify → (retry once) loop.
 *
 * `/:id/advice` used to be a single unchecked Claude call: it read the dossiers,
 * named a player, and that was the answer. Nothing ever asked whether the pick
 * survived contact with the rest of the draft. This module is that check, and it
 * is JS math, not a second opinion from the same model that just spoke —
 * `draft-lookahead.js`'s Monte Carlo plays the remaining rounds out a few hundred
 * times for the proposed player AND for the alternatives Claude was shown, then
 * compares finished-roster value.
 *
 * Two rules shape everything here, and both come from the 90-second pick clock:
 *
 *   1. AT MOST ONE RETRY. Not "retry until they agree" — a loop with no bound is
 *      an unbounded latency, which on a draft clock is the same thing as a wrong
 *      answer. Claude gets the simulation's actual numbers once and whatever it
 *      says next is final, including "I still want X, here's why".
 *   2. THE THRESHOLD IS DELIBERATELY DULL. Firing the retry costs a second of a
 *      ninety-second budget, so it only fires when the simulation and the
 *      proposal actually disagree — not when they differ by simulation noise, and
 *      not when they differ by an amount too small to change a season.
 *
 * None of this touches `rankTargets()`, the instant deterministic board, which
 * renders before any of this starts and never waits on it.
 */

/**
 * A contradiction has to clear BOTH bars.
 *
 * SE_FACTOR / CRN_FACTOR — statistical. The gap must exceed `SE_FACTOR`
 * standard errors of the difference in simulated means. `lookahead()` publishes
 * only the marginal `sd` of each candidate's roster value, so the naive estimate
 * is the unpaired sqrt(sd_a²/n + sd_b²/n) — but that overstates the real
 * uncertainty, because the lookahead scores every candidate inside the SAME
 * simulated seasons and the same simulated draft orders (common random numbers),
 * which cancels most of the shared noise out of the difference.
 *
 * `CRN_FACTOR` is how much of that unpaired SE actually survives, and it was
 * MEASURED, not assumed: the same round-2 board was simulated at 200 sims under
 * eight different seeds, and the seed-to-seed sd of each candidate's gap-to-best
 * came out at 9.7, 12.5, 21.4, 23.7 and 23.7 pts against an unpaired SE of
 * 32.6 — ratios of 0.30 to 0.73. 0.75 sits just above the worst case observed,
 * so the bar still errs toward NOT firing the retry, without erring by the
 * factor of ~1.4 the uncorrected formula did. (Calibrated at 200 sims; the
 * formula is in sims, so it tracks a change to the sim count on its own.)
 *
 * MATERIAL_FRAC — practical. Even a gap that is real can be too small to matter.
 * 1% of a finished roster's expected value is roughly 20 points over a season in
 * a normal league: about one starter tier, and comfortably more than the
 * resolution anyone should claim for a preseason projection. Below that the two
 * picks are the same pick and the dossier reasoning is a better tiebreak than a
 * third decimal place of Monte Carlo. At 200 sims the noise bar is the binding
 * one; the material bar matters if the sim count is ever raised.
 *
 * MAX_SNIPED_PCT — a candidate who is gone before the user's turn in most
 * simulated worlds has an `expected` conditioned on the minority of worlds where
 * he survived, which is a selection-biased number and not comparable to a
 * candidate available everywhere. Such a candidate is neither judged nor used as
 * the challenger.
 */
export const VERIFY_THRESHOLD = {
  SE_FACTOR: 2,
  CRN_FACTOR: 0.75,
  MATERIAL_FRAC: 0.01,
  MAX_SNIPED_PCT: 25
};

export const VERIFY_STATUS = {
  /** The simulation put the proposed pick at or near the top. First instinct held. */
  CONFIRMED: 'confirmed',
  /** The simulation disagreed and, given the numbers, Claude changed the pick. */
  REVISED: 'revised',
  /** The simulation disagreed, Claude was told, and it kept the pick anyway. */
  UPHELD: 'upheld',
  /** The simulation could not evaluate the proposal — no check was possible. */
  UNVERIFIED: 'unverified'
};

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Judge one proposal against a `lookahead()` result.
 *
 * Consumes `lookahead()`'s output shape exactly as it stands — `{ sims,
 * pick_number, candidates: [{ player_id, name, expected, sd, sims, sniped_pct,
 * delta, ... }] }`, sorted best-expected first — and cares only about
 * `name`/`expected`/`sd`/`sims`/`sniped_pct`. Whatever variance realism the
 * simulation grows underneath (draft-order only, or draft order plus correlated
 * player outcomes) flows through here without a change: a wider, more honest
 * `sd` simply makes the noise bar higher and the retry rarer, which is the right
 * response to admitting more uncertainty.
 *
 * @param sim            a `lookahead()` return value, or null
 * @param proposedName   the player Claude named
 * @param matches        (a, b) => boolean name comparison (the route passes the
 *                       app's `normalise`-based one, so "T.J. Hockenson" and
 *                       "TJ Hockenson" are the same player)
 * @returns { contradicted, status, reason, proposed, challenger, gap, threshold, sims }
 */
export function judgeProposal(sim, proposedName, { matches = (a, b) => a === b, threshold = VERIFY_THRESHOLD } = {}) {
  const base = { contradicted: false, proposed: null, challenger: null, gap: null, threshold: null, sims: sim?.sims ?? null };
  if (!sim?.candidates?.length) {
    return { ...base, status: VERIFY_STATUS.UNVERIFIED, reason: 'the simulation produced no candidates' };
  }
  if (!proposedName) {
    return { ...base, status: VERIFY_STATUS.UNVERIFIED, reason: 'no pick was proposed' };
  }

  const slim = c => ({
    name: c.name, position: c.position ?? null,
    expected: num(c.expected), sd: num(c.sd), sims: num(c.sims), sniped_pct: num(c.sniped_pct)
  });

  const proposed = sim.candidates.find(c => matches(c.name, proposedName));
  if (!proposed) {
    return { ...base, status: VERIFY_STATUS.UNVERIFIED, reason: `"${proposedName}" was not among the simulated candidates` };
  }
  if (num(proposed.expected) == null) {
    return { ...base, proposed: slim(proposed), status: VERIFY_STATUS.UNVERIFIED, reason: `"${proposed.name}" was taken before my turn in every simulated world` };
  }
  if (num(proposed.sniped_pct) != null && proposed.sniped_pct > threshold.MAX_SNIPED_PCT) {
    return {
      ...base, proposed: slim(proposed), status: VERIFY_STATUS.UNVERIFIED,
      reason: `"${proposed.name}" survives to my turn in only ${100 - proposed.sniped_pct}% of simulated worlds — his expected value is not comparable`
    };
  }

  // The challenger: the best simulated alternative that is actually available
  // often enough for its mean to mean anything.
  const challenger = sim.candidates
    .filter(c => c !== proposed && num(c.expected) != null
      && (num(c.sniped_pct) == null || c.sniped_pct <= threshold.MAX_SNIPED_PCT))
    .sort((a, b) => b.expected - a.expected)[0] ?? null;

  if (!challenger || challenger.expected <= proposed.expected) {
    return {
      ...base, proposed: slim(proposed), challenger: challenger ? slim(challenger) : null,
      gap: challenger ? +(challenger.expected - proposed.expected).toFixed(1) : 0,
      status: VERIFY_STATUS.CONFIRMED,
      reason: challenger
        ? `the simulation also ranks ${proposed.name} first of the realistic alternatives`
        : 'no comparable alternative to weigh him against'
    };
  }

  const n = Math.max(1, num(proposed.sims) ?? num(sim.sims) ?? 1);
  const nc = Math.max(1, num(challenger.sims) ?? n);
  const sdP = num(proposed.sd) ?? 0, sdC = num(challenger.sd) ?? 0;
  const se = (threshold.CRN_FACTOR ?? 1) * Math.sqrt((sdP * sdP) / n + (sdC * sdC) / nc);
  const noiseBar = threshold.SE_FACTOR * se;
  const materialBar = threshold.MATERIAL_FRAC * Math.abs(challenger.expected);
  const bar = Math.max(noiseBar, materialBar);
  const gap = challenger.expected - proposed.expected;

  const detail = {
    ...base,
    proposed: slim(proposed), challenger: slim(challenger),
    gap: +gap.toFixed(1),
    threshold: {
      required_gap: +bar.toFixed(1),
      noise_bar: +noiseBar.toFixed(1),
      material_bar: +materialBar.toFixed(1),
      se_factor: threshold.SE_FACTOR,
      crn_factor: threshold.CRN_FACTOR ?? 1,
      material_frac: threshold.MATERIAL_FRAC
    }
  };

  if (gap <= bar) {
    return {
      ...detail, status: VERIFY_STATUS.CONFIRMED,
      reason: `${challenger.name} simulates ${gap.toFixed(1)} pts higher, inside the ${bar.toFixed(1)}-pt bar that separates a real gap from noise`
    };
  }
  return {
    ...detail, contradicted: true, status: null,
    reason: `${challenger.name} simulates ${gap.toFixed(1)} pts of finished-roster value above ${proposed.name}, past the ${bar.toFixed(1)}-pt bar`
  };
}

/**
 * The sentence the retry call actually sees. Deliberately not leading: it hands
 * over the numbers and explicitly allows "I was right anyway", because the
 * simulation is one model among several and a dossier fact it cannot see (a
 * camp report, an injury designation) is a legitimate reason to hold.
 */
export function challengeText(verdict) {
  const p = verdict.proposed, c = verdict.challenger;
  return `SIMULATION CHECK — you proposed ${p.name}, and I then ran the rest of this draft out ${p.sims ?? '200'} times for each of your shortlisted players before you commit.

Taking ${p.name} now finishes with an expected roster value of ${p.expected} pts (sd ${p.sd}).
Taking ${c.name} now finishes with ${c.expected} pts (sd ${c.sd}) — ${verdict.gap} pts higher, which is past the ${verdict.threshold.required_gap}-pt bar that separates a real difference from simulation noise.

The simulation knows the draft board, roster construction, positional scarcity and who is likely to survive to my next pick. It does NOT know the scouting dossier — camp reporting, injury designations, depth-chart news. So either reconsider and take ${c.name}, or keep ${p.name} and say plainly which dossier fact outweighs a ${verdict.gap}-pt simulated roster deficit.

Respond with ONLY JSON, no other fields:
{"pick":"the player I should take right now — ${p.name} or ${c.name}",
 "why":"two sentences max, same rule as before: FIRST clause is a concrete multi-season number from his record, then the roster hole or scarcity",
 "evidence":"one line: the 2-3 numbers that decide this, comma-separated, no adjectives",
 "next_turn_outlook":"one sentence on what should still be there at my next pick"}`;
}

/**
 * The bounded loop itself, with every side effect injected so it can be tested
 * without a draft, a database or an API key.
 *
 * @param propose   async () => ({ advice, ... })            — Claude call 1
 * @param simulate  optional () => simulation result, run CONCURRENTLY with the
 *                  propose call (see below)
 * @param verify    (proposedName, simResult) => a `judgeProposal` verdict
 * @param retry     async (verdict) => partial advice        — Claude call 2, at most once
 * @returns { advice, verification }
 *
 * THE SIMULATION RUNS DURING THE PROPOSE CALL, NOT AFTER IT. The shortlist is
 * decided by `rankTargets()` before Claude is asked anything, so the lookahead
 * — which simulates the whole shortlist, not just the eventual proposal — has
 * no dependency on Claude's answer. Firing the HTTP request first and then
 * doing the Monte Carlo synchronously means the ~1.9s of simulation happens
 * inside the ~10s the model spends generating, and verification costs the pick
 * clock nothing at all. Measured: docs/DRAFT_ADVICE_VERIFY_LOOP.md.
 *
 * The hard cap is structural, not a counter someone remembers to check: `retry`
 * is referenced exactly once in this function and there is no loop construct in
 * it, so "at most 2 calls" cannot drift as the code changes.
 */
export async function proposeVerifyRetry({ propose, simulate, verify, retry, matchesName }) {
  const t0 = Date.now();

  // Started, deliberately NOT awaited: the request is in flight while the
  // simulation below occupies the CPU.
  const pending = propose();
  // A rejected proposal must not surface as an unhandled rejection while the
  // synchronous simulation is still running.
  pending.catch(() => {});

  let simResult = null, simMs = 0;
  if (simulate) {
    const tSim = Date.now();
    try { simResult = simulate(); } catch { simResult = null; }
    simMs = Date.now() - tSim;
  }

  const { advice, ...proposeExtra } = await pending;
  const tProposed = Date.now();
  const proposedPick = advice?.pick ?? null;

  const verdict = verify(proposedPick, simResult);
  const tVerified = Date.now();

  // `simulate_ms` is CPU spent, not clock added: it ran inside `propose_ms`.
  const timing = (retryMs = null, end = Date.now()) => ({
    propose_ms: tProposed - t0,
    simulate_ms: simMs,
    simulate_overlapped: Boolean(simulate),
    judge_ms: tVerified - tProposed,
    retry_ms: retryMs,
    total_ms: end - t0
  });

  if (!verdict.contradicted) {
    return {
      advice, ...proposeExtra,
      verification: {
        status: verdict.status,
        revised: false,
        claude_calls: 1,
        proposed_pick: proposedPick,
        final_pick: proposedPick,
        note: verdict.status === VERIFY_STATUS.UNVERIFIED
          ? `Not simulation-checked: ${verdict.reason}.`
          : `Confirmed on the first pass — ${verdict.reason}.`,
        simulation: simulationFacts(verdict),
        latency_ms: timing()
      }
    };
  }

  // Exactly one more call. Whatever comes back is final, agreement or not.
  const second = await retry(verdict);
  const retryDone = Date.now();
  const finalPick = second?.pick ?? proposedPick;
  const same = matchesName ? matchesName(finalPick, proposedPick) : finalPick === proposedPick;
  const status = same ? VERIFY_STATUS.UPHELD : VERIFY_STATUS.REVISED;

  return {
    advice: mergeRetry(advice, second, { matchesName }),
    ...proposeExtra,
    verification: {
      status,
      revised: !same,
      claude_calls: 2,
      proposed_pick: proposedPick,
      final_pick: finalPick,
      note: same
        ? `The simulation disagreed (${verdict.reason}); asked to reconsider, the advisor kept ${proposedPick}.`
        : `Revised after simulation: the first read was ${proposedPick}, but ${verdict.reason} — changed to ${finalPick}.`,
      simulation: simulationFacts(verdict),
      latency_ms: timing(retryDone - tVerified, retryDone)
    }
  };
}

function simulationFacts(verdict) {
  return {
    sims: verdict.sims,
    compute_ms: verdict.sim_compute_ms ?? null,
    contradicted: verdict.contradicted,
    reason: verdict.reason,
    proposed: verdict.proposed,
    best_alternative: verdict.challenger,
    gap: verdict.gap,
    threshold: verdict.threshold
  };
}

/**
 * The retry re-decides the CHOICE, not the scouting. `players[]` — pros, cons,
 * camp line, status per shortlisted player — is a read on each player that a
 * roster simulation has no bearing on, so it is carried over rather than
 * regenerated. That is most of the first call's output tokens, and output
 * tokens are the whole latency of this feature; regenerating them would roughly
 * double the retry's cost for no new information.
 *
 * The per-player `verdict` field IS choice-dependent, so it is reconciled: the
 * final pick reads "take", and a player who lost the argument stops claiming it.
 */
function mergeRetry(first, second, { matchesName } = {}) {
  if (!second?.pick) return first;
  const same = (a, b) => (matchesName ? matchesName(a, b) : a === b);
  const players = (first.players ?? []).map(p => {
    if (!p?.name) return p;
    if (same(p.name, second.pick)) return { ...p, verdict: 'take' };
    if (p.verdict === 'take') return { ...p, verdict: 'fine here' };
    return p;
  });
  return {
    ...first,
    pick: second.pick,
    why: second.why ?? first.why,
    evidence: second.evidence ?? first.evidence,
    ...(second.position_priority ? { position_priority: second.position_priority } : {}),
    ...(second.next_turn_outlook ? { next_turn_outlook: second.next_turn_outlook } : {}),
    ...(players.length ? { players } : {})
  };
}
