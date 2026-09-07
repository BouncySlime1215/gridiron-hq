/**
 * The verify half of Trade Lab's propose → verify → (retry once) → commit loop.
 *
 * `POST /api/trades/:leagueId/sense-check` used to be a single unchecked Claude
 * call. It read the deal the deterministic engine had already scored, returned a
 * verdict — sound / worth a second look / risky / lopsided — and that was the
 * answer. Nothing ever asked whether the verdict survived contact with a
 * simulated season.
 *
 * Meanwhile `season-sim.js#tradeImpact()` has answered exactly that question the
 * whole time, and answers it better than any of the inputs the sense-check
 * reasons over: it plays the rest of the season out hundreds of times with the
 * trade and without it, under COMMON RANDOM NUMBERS (the same simulated football
 * worlds on both sides of the diff), and reports what the deal does to each
 * team's championship odds. The two never spoke. A user could be told a deal was
 * "sound" while the simulator, unasked, would have said it cost them title odds.
 *
 * This module is the conversation between them. It is JS math checking an LLM,
 * not a second opinion from the same model that just spoke.
 *
 * THREE RULES, and each one is here for a reason rather than for symmetry with
 * the other two verify loops in this repository:
 *
 *   1. AT MOST ONE RETRY. Structural, not a counter: `retry` is referenced
 *      exactly once in `proposeVerifyRetryTrade` and there is no loop construct
 *      in the function, so "at most 2 Claude calls" cannot drift as the code
 *      changes. Trade Lab has no 90-second clock, but an unbounded
 *      argue-until-they-agree loop is an unbounded latency and an unbounded
 *      bill, and neither is worth a fourth opinion.
 *
 *   2. THE THRESHOLD IS MEASURED, NOT GUESSED, AND IT IS MEASURED FOR THIS
 *      QUANTITY. Title odds are a probability in [0,1] whose whole interesting
 *      range for a 12-team league sits within a few points of 1/12; the draft
 *      advisor's bar is in points of finished-roster value and means nothing
 *      here. `NOISE_SD_AT_REFERENCE_RUNS` below was measured by re-running
 *      `tradeImpact()` on real deals under different seeds. See
 *      docs/TRADE_LAB_VERIFY_LOOP.md.
 *
 *   3. THE SIMULATION IS THE ONLY THING ALLOWED TO FIRE THE RETRY. The
 *      sense-check's own `agrees_with_engine` field is Claude grading Claude
 *      against a lineup-points engine, which is the proxy — title odds are the
 *      thing the proxy proxies for. That field is reported, never gated on.
 *
 * Nothing here modifies `season-sim.js`. `tradeImpact()` is called exactly as it
 * stands and its output shape is consumed as published.
 */

/**
 * The sense-check's verdict vocabulary, mapped to what the verdict actually
 * ASKS THE USER TO DO. This is the join between a word and a number, and it is
 * the only place the mapping exists.
 *
 * `lopsided` is the interesting one. It is directionally ambiguous in English —
 * a deal can be lopsided in my favour — but it is not ambiguous in this prompt,
 * which asks for a second opinion on a deal *I am considering accepting* and
 * lists `lopsided` as the most severe of four grades after `risky`. It reads as
 * "do not do this". A `lopsided` verdict on a deal the simulator says is a clear
 * title-odds GAIN for me is therefore a real contradiction and exactly the case
 * worth one more call, because the cost of getting it wrong is declining a deal
 * that would have helped.
 *
 * `worth a second look` is genuinely non-committal, so it is contradicted
 * SYMMETRICALLY: it is a shrug, and a shrug is contradicted by the simulation
 * having a clear answer in either direction. That is not a lower bar than the
 * other two — the same `bar` applies — it is the same bar applied to |delta|.
 */
export const STANCE_OF_VERDICT = Object.freeze({
  'sound': 'accept',
  'worth a second look': 'caution',
  'risky': 'reject',
  'lopsided': 'reject'
});

/**
 * A contradiction must clear BOTH bars, the same two-bar shape
 * `draft-advice-verify.js` uses — but every number below is this quantity's own.
 *
 * NOISE_SD_AT_REFERENCE_RUNS = 0.0155 — statistical, and MEASURED rather than
 * assumed. `tradeImpact()` publishes a `title_delta` and no standard error for
 * it, so there is no formula to read the noise off; it had to be sampled. Three
 * real deals from the trade finder on a live 12-team league were each
 * re-simulated under six different seeds at 600 runs, and the seed-to-seed sd of
 * `me.title_delta` came out at 0.0069, 0.0122 and 0.0139. The noisiest of the
 * three was then re-measured at 300 / 1200 / 2400 runs as well, giving 0.0190 /
 * 0.0107 / 0.0067. Rescaling each of those five figures to the 600-run reference
 * gives 0.0134 / 0.0139 / 0.0151 / 0.0134 (plus the 0.0069 and 0.0122 deals);
 * 0.0155 sits just above the worst of them, so the bar errs toward NOT firing
 * the retry.
 *
 * REFERENCE_RUNS = 600 — the run count that sd was measured at. Monte Carlo
 * noise scales as 1/sqrt(runs), so the bar is rescaled by
 * sqrt(REFERENCE_RUNS / runs): raising the run count tightens the bar and
 * lowering it loosens it, automatically and without a second calibration. That
 * scaling was VERIFIED rather than assumed — the 300/600/1200/2400 series above
 * runs against a 1/sqrt(runs) prediction of 0.0197 / — / 0.0098 / 0.0070 and
 * tracks it across an eightfold range, which is what licenses the rescaling.
 *
 * SE_FACTOR — the ordinary two-standard-errors convention.
 *
 * MATERIAL_TITLE_DELTA = 0.01 — practical. Even a statistically real title-odds
 * change can be too small to act on. A season is one sample; a deal that moves a
 * championship from 8.3% to 8.6% has, in the only run of the season that will
 * ever happen, changed nothing a manager can perceive or plan around. Below this
 * the deal is a coin flip dressed as a decision, and the roster-fit reasoning
 * the sense-check exists to do is a better tiebreak than a fourth decimal place
 * of Monte Carlo. At the 1,200-run default the noise bar (2.2pp) is the binding
 * one; this floor only starts to matter above ~5,800 runs, and it is here so
 * that raising the run count can never drive the bar to zero.
 */
export const TRADE_VERIFY_THRESHOLD = Object.freeze({
  SE_FACTOR: 2,
  NOISE_SD_AT_REFERENCE_RUNS: 0.0155,
  REFERENCE_RUNS: 600,
  MATERIAL_TITLE_DELTA: 0.01
});

/**
 * How many paired seasons the sense-check's verify step plays.
 *
 * This is set by MEASUREMENT, not by taste, and it was moved once already. The
 * calibration above was done at 600 runs, and 600 was the initial default on the
 * assumption that the simulation had to stay small to stay hidden. Measuring the
 * real route proved that assumption wrong in a useful direction: the propose call
 * takes ~17.5s while 600 runs of `tradeImpact` take ~8s, so more than half the
 * simulation budget was going unused. 1,200 runs cost ~18s — still essentially
 * inside the propose call — and cut the noise bar from 2.9pp to 2.2pp, which is
 * a materially sharper check for well under a second of wall clock.
 *
 * The bar rescales itself for this count (`contradictionBar`), so raising it did
 * not require a second calibration and lowering it back would not either. Going
 * further is a losing trade: 2,400 runs take ~24s and would start adding real
 * latency for another 0.7pp.
 */
export const SENSE_CHECK_SIM_RUNS = 1200;

export const TRADE_VERIFY_STATUS = {
  /** The season simulation agreed with the verdict, or disagreed inside the bar. */
  CONFIRMED: 'confirmed',
  /** The simulation disagreed and, given the numbers, Claude changed the verdict. */
  REVISED: 'revised',
  /** The simulation disagreed, Claude was told, and it kept the verdict anyway. */
  UPHELD: 'upheld',
  /** No simulation was possible — no check happened, and the answer still ships. */
  UNVERIFIED: 'unverified'
};

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = v => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const pp = v => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pp`);
/** A bar is a magnitude, so it is never signed — "past the 2.9pp bar", either way. */
const bp = v => (v == null ? 'n/a' : `${(Math.abs(v) * 100).toFixed(1)}pp`);

/** Loose match on the verdict vocabulary — the model does not always match case. */
export function stanceOf(verdict) {
  if (typeof verdict !== 'string') return null;
  return STANCE_OF_VERDICT[verdict.trim().toLowerCase()] ?? null;
}

/** The bar a title-odds gap must clear, in absolute title-odds probability. */
export function contradictionBar(runs, threshold = TRADE_VERIFY_THRESHOLD) {
  const n = Math.max(1, num(runs) ?? threshold.REFERENCE_RUNS);
  const noise = threshold.SE_FACTOR * threshold.NOISE_SD_AT_REFERENCE_RUNS
    * Math.sqrt(threshold.REFERENCE_RUNS / n);
  const material = threshold.MATERIAL_TITLE_DELTA;
  // Rounded to the same 4 decimals `tradeImpact` reports its deltas at, so the
  // bar and the number being compared against it have the same resolution.
  const noise_bar = +noise.toFixed(4), material_bar = +material.toFixed(4);
  return { required: Math.max(noise_bar, material_bar), noise_bar, material_bar };
}

/**
 * Judge one sense-check verdict against a `tradeImpact()` result.
 *
 * Consumes `tradeImpact()`'s published shape exactly as it stands —
 * `{ runs, seed, paired_simulation, me: {...}, them: {...} }`, each side
 * carrying `title_before/title_after/title_delta`, `playoff_delta`,
 * `wins_delta` — and reads nothing else. If the simulator's variance model gets
 * more honest underneath, this needs no change: a wider spread is a
 * re-measurement of `NOISE_SD_AT_REFERENCE_RUNS`, which raises the bar, which
 * makes the retry rarer. That is the correct response to admitting more
 * uncertainty.
 *
 * BOTH SIDES ARE SIMULATED AND BOTH ARE REPORTED. The contradiction test is on
 * MY title-odds delta, because that is the quantity the user's decision is
 * about, but `them` is carried into the challenge text and the committed
 * payload: a deal that is a title-odds gain for me and a bigger one for them is
 * a fact worth putting in front of the model, and it comes free — `tradeImpact`
 * returns both sides of one paired run.
 *
 * @param impact   a `tradeImpact()` return value, or null
 * @param verdict  the verdict string Claude proposed
 * @returns { contradicted, status, reason, stance, my_side, their_side, gap, bar, threshold, runs }
 */
export function judgeTradeVerdict(impact, verdict, { threshold = TRADE_VERIFY_THRESHOLD } = {}) {
  const base = {
    contradicted: false, stance: null, my_side: null, their_side: null,
    gap: null, bar: null, threshold: null, runs: num(impact?.runs), seed: impact?.seed ?? null,
    paired: impact?.paired_simulation ?? null
  };
  if (!impact || impact.error) {
    return { ...base, status: TRADE_VERIFY_STATUS.UNVERIFIED,
      reason: impact?.error ? `the season simulation could not run: ${impact.error}` : 'the season simulation did not run' };
  }
  if (!impact.me || !impact.them) {
    return { ...base, status: TRADE_VERIFY_STATUS.UNVERIFIED, reason: 'the season simulation returned no per-team result' };
  }

  const slim = s => ({
    roster_id: s.roster_id, owner: s.owner,
    title_before: num(s.title_before), title_after: num(s.title_after),
    title_delta: num(s.title_delta),
    playoff_before: num(s.playoff_before), playoff_after: num(s.playoff_after),
    playoff_delta: num(s.playoff_delta),
    wins_delta: num(s.wins_delta)
  });
  const mine = slim(impact.me), theirs = slim(impact.them);
  const detail = { ...base, my_side: mine, their_side: theirs };

  const stance = stanceOf(verdict);
  if (!stance) {
    return { ...detail, status: TRADE_VERIFY_STATUS.UNVERIFIED,
      reason: verdict ? `"${verdict}" is not one of the four verdicts this check understands` : 'no verdict was proposed' };
  }
  if (mine.title_delta == null) {
    return { ...detail, stance, status: TRADE_VERIFY_STATUS.UNVERIFIED,
      reason: 'the simulation produced no title-odds delta for my team' };
  }

  const bars = contradictionBar(impact.runs, threshold);
  const gap = mine.title_delta;
  const withBar = {
    ...detail, stance, gap: +gap.toFixed(4),
    bar: +bars.required.toFixed(4),
    threshold: {
      required_gap: +bars.required.toFixed(4),
      noise_bar: bars.noise_bar,
      material_bar: bars.material_bar,
      se_factor: threshold.SE_FACTOR,
      noise_sd: threshold.NOISE_SD_AT_REFERENCE_RUNS,
      reference_runs: threshold.REFERENCE_RUNS
    }
  };
  const bar = bars.required;
  const sim = `${impact.runs} paired simulated seasons put my championship odds at ${pct(mine.title_before)} → ${pct(mine.title_after)} (${pp(gap)})`;

  if (stance === 'accept' && gap < -bar) {
    return { ...withBar, contradicted: true, status: null,
      reason: `the verdict reads as "take this deal", but ${sim} — a loss past the ${bp(bar)} bar that separates a real change from simulation noise` };
  }
  if (stance === 'reject' && gap > bar) {
    return { ...withBar, contradicted: true, status: null,
      reason: `the verdict reads as "do not take this deal", but ${sim} — a gain past the ${bp(bar)} bar that separates a real change from simulation noise` };
  }
  if (stance === 'caution' && Math.abs(gap) > bar) {
    return { ...withBar, contradicted: true, status: null,
      reason: `the verdict is non-committal, but ${sim} — past the ${pp(bar)} bar in ${gap > 0 ? 'my favour' : 'the other direction'}, so the simulation is not undecided even though the verdict is` };
  }

  return {
    ...withBar, status: TRADE_VERIFY_STATUS.CONFIRMED,
    reason: Math.abs(gap) <= bar
      ? `${sim}, inside the ${bp(bar)} bar that separates a real change from simulation noise — nothing here contradicts the verdict`
      : `${sim}, which points the same way as the verdict`
  };
}

/**
 * The sentence the retry call actually sees.
 *
 * Deliberately not leading. It hands over the numbers, states plainly what the
 * simulation does and does not know, and says that holding the verdict is a
 * legitimate answer — because it often is. The simulator prices lineup points,
 * depth, byes, weekly variance and the playoff schedule; it does not price an
 * injury designation, a camp report, an age cliff the market has not moved on,
 * or the fact that a manager has to live with this roster. Those are the things
 * the sense-check exists to notice, and a model that capitulates to a number
 * every time is worth less than one that can say why the number is incomplete.
 */
export function tradeChallengeText(judgement) {
  const m = judgement.my_side, t = judgement.their_side;
  return `SEASON-SIMULATION CHECK — you graded this deal "${judgement.proposed_verdict ?? 'as above'}". Before that answer is committed, I ran the rest of this season out ${judgement.runs} times WITH this trade and ${judgement.runs} times WITHOUT it, using the same simulated football in both — the same injuries, the same weekly scores, the same opponents — so the difference below is the trade and nothing else.

MY TEAM (${m.owner})
  Championship odds  ${pct(m.title_before)} → ${pct(m.title_after)}   (${pp(m.title_delta)})
  Playoff odds       ${pct(m.playoff_before)} → ${pct(m.playoff_after)}   (${pp(m.playoff_delta)})
  Expected wins      ${m.wins_delta >= 0 ? '+' : ''}${m.wins_delta}

THEIR TEAM (${t.owner})
  Championship odds  ${pct(t.title_before)} → ${pct(t.title_after)}   (${pp(t.title_delta)})
  Playoff odds       ${pct(t.playoff_before)} → ${pct(t.playoff_after)}   (${pp(t.playoff_delta)})
  Expected wins      ${t.wins_delta >= 0 ? '+' : ''}${t.wins_delta}

${judgement.reason.charAt(0).toUpperCase()}${judgement.reason.slice(1)}.

WHAT THIS SIMULATION KNOWS: every roster in the league, the real remaining schedule, bye weeks, weekly scoring variance and correlation between players, optimal lineups set from pre-kickoff expectations, and the actual playoff bracket. It values depth and a playoff schedule without needing a rule for either. Championship odds are the goal; points per week are the proxy for it, and the two disagree more often than people expect.

WHAT IT DOES NOT KNOW: the scouting record you were given — injury designations, camp reporting, age and workload, whether a multi-season floor is being sold for a one-year spike, or anything about how this manager negotiates.

So either revise your verdict to match what the season actually does, or keep it and say plainly which fact from the deal data outweighs a ${pp(m.title_delta)} move in championship odds. Both are real answers. Do not change your mind merely because a number was shown to you.

Respond with ONLY JSON, no other fields:
{"verdict":"one of: sound / worth a second look / risky / lopsided",
 "headline":"one sentence — your take now, and its FIRST clause is a concrete multi-season number from a record you were given",
 "evidence":"one line: the 2-3 numbers that decide this deal, comma-separated, no adjectives",
 "concerns":["0-4 short, specific concerns grounded in the data you were given — omit entirely if none"],
 "why":"2-3 sentences: what the simulation changed about your read, or why it does not change it"}`;
}

/**
 * The bounded loop, with every side effect injected so it is testable without a
 * league, a database or an API key.
 *
 * @param propose   async () => sense-check JSON               — Claude call 1
 * @param simulate  optional () => a `tradeImpact()` result, run CONCURRENTLY
 *                  with the propose call (see below)
 * @param verify    (verdict, impact) => a `judgeTradeVerdict` judgement
 * @param retry     async (judgement) => sense-check JSON      — Claude call 2, at most once
 * @returns the sense-check payload plus a `verification` block
 *
 * THE SIMULATION RUNS DURING THE PROPOSE CALL, NOT AFTER IT. The trade is fully
 * specified in the request — who, for whom, both packages — before Claude is
 * asked anything, so `tradeImpact()` has no dependency on the proposal. Firing
 * the HTTP request first and then running the simulation synchronously means
 * several seconds of Monte Carlo happen inside the seconds the model spends
 * generating, and the verify step costs the user far less wall clock than it
 * costs CPU. Measured: docs/TRADE_LAB_VERIFY_LOOP.md.
 *
 * The hard cap is structural: `retry` is referenced exactly once below and there
 * is no loop construct in this function.
 */
export async function proposeVerifyRetryTrade({ propose, simulate, verify, retry }) {
  const t0 = Date.now();

  // Started, deliberately NOT awaited: the request is in flight while the
  // synchronous simulation below occupies the CPU.
  const pending = propose();
  // A rejected proposal must not surface as an unhandled rejection while the
  // simulation is still running.
  pending.catch(() => {});

  let impact = null, simMs = 0;
  if (simulate) {
    const tSim = Date.now();
    try { impact = simulate(); } catch { impact = null; }
    simMs = Date.now() - tSim;
  }

  const first = await pending;
  const tProposed = Date.now();
  const proposedVerdict = first?.verdict ?? null;

  const judgement = { ...verify(proposedVerdict, impact), proposed_verdict: proposedVerdict };
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

  if (!judgement.contradicted) {
    return {
      ...first,
      verification: {
        status: judgement.status,
        revised: false,
        claude_calls: 1,
        proposed_verdict: proposedVerdict,
        final_verdict: proposedVerdict,
        note: judgement.status === TRADE_VERIFY_STATUS.UNVERIFIED
          ? `Not simulation-checked: ${judgement.reason}.`
          : `Confirmed on the first pass — ${judgement.reason}.`,
        simulation: simulationFacts(judgement),
        latency_ms: timing()
      }
    };
  }

  // Exactly one more call. Whatever comes back is final, agreement or not — and
  // the simulation is deliberately NOT re-run to re-judge it, because re-judging
  // is the first half of a loop.
  const second = await retry(judgement);
  const retryDone = Date.now();
  const finalVerdict = second?.verdict ?? proposedVerdict;
  const norm = v => (typeof v === 'string' ? v.trim().toLowerCase() : v);
  const same = norm(finalVerdict) === norm(proposedVerdict);
  const status = same ? TRADE_VERIFY_STATUS.UPHELD : TRADE_VERIFY_STATUS.REVISED;

  return {
    ...mergeRetry(first, second),
    verification: {
      status,
      revised: !same,
      claude_calls: 2,
      proposed_verdict: proposedVerdict,
      final_verdict: finalVerdict,
      note: same
        ? `The season simulation disagreed (${judgement.reason}); asked to reconsider with the numbers in hand, the second opinion kept "${proposedVerdict}".`
        : `Revised after simulation: the first read was "${proposedVerdict}", but ${judgement.reason} — changed to "${finalVerdict}".`,
        simulation: simulationFacts(judgement),
      latency_ms: timing(retryDone - tVerified, retryDone)
    }
  };
}

function simulationFacts(judgement) {
  return {
    ran: judgement.status !== TRADE_VERIFY_STATUS.UNVERIFIED || judgement.my_side != null,
    runs: judgement.runs,
    seed: judgement.seed,
    paired: judgement.paired,
    compute_ms: judgement.sim_compute_ms ?? null,
    contradicted: judgement.contradicted,
    stance: judgement.stance,
    reason: judgement.reason,
    my_team: judgement.my_side,
    their_team: judgement.their_side,
    title_delta: judgement.gap,
    threshold: judgement.threshold
  };
}

/**
 * Every field of this payload is a judgement about the DEAL, and the retry
 * re-decides the deal — so unlike the draft advisor (whose per-player scouting
 * is carried over untouched because a roster simulation has no bearing on it),
 * there is nothing here that is safe to keep from the first answer once the
 * verdict has moved. The merge is therefore a straight overwrite with the first
 * answer as the fallback for any field the retry omitted.
 *
 * `agrees_with_engine` is the exception in the other direction: it is a claim
 * about the deterministic lineup-points engine, which this loop did not show the
 * model anything new about, so a retry that does not restate it keeps the
 * original.
 */
function mergeRetry(first, second) {
  if (!second?.verdict) return first;
  return {
    ...first,
    verdict: second.verdict,
    headline: second.headline ?? first.headline,
    evidence: second.evidence ?? first.evidence,
    concerns: Array.isArray(second.concerns) ? second.concerns : first.concerns,
    why: second.why ?? first.why,
    agrees_with_engine: typeof second.agrees_with_engine === 'boolean'
      ? second.agrees_with_engine : first.agrees_with_engine
  };
}
