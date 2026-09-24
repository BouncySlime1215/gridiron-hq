/**
 * CAMPAIGN-01: path arithmetic (pure). No DB, no simulation, no env.
 *
 * Promoted from the ACQ-FLIP study (scripts/study/acq-flip-proto.mjs, PR #227)
 * so the producer does not import study code. Same formulas, same tests
 * (test/acq-flip-proto.test.js keeps covering the study copy; the campaign
 * suite covers these).
 *
 * A path is a list of steps. Step i = { p: P(step i accepted | 0..i-1 done),
 * delta: Nick's objective change vs today once steps 0..i are done, se? }.
 * Where a path can stop: after step j is done and j+1 is declined, Nick sits at
 * delta_j (delta_-1 = 0). A declined second leg strands the first.
 */

/** The trade finder's fairness window on the counterparty's side, in percent. */
export const SCREEN_WINDOW = Object.freeze({ low: -12, high: 18 });
/** A title-odds number is real only past this many standard errors (season-sim.js). */
export const NOISE_K = 2;

/** How a deal reads on his market screen: what he gets minus what he gives, as % of what he gives. */
export function screenPct(theyGetValue, theyGiveValue) {
  if (!(theyGiveValue > 0)) return null;
  return ((theyGetValue - theyGiveValue) / theyGiveValue) * 100;
}

/** Whether a deal looks fair on his screen: inside the finder's window. */
export function screenFair(theyGetValue, theyGiveValue, window = SCREEN_WINDOW) {
  const pct = screenPct(theyGetValue, theyGiveValue);
  return pct != null && pct >= window.low && pct <= window.high;
}

/**
 * Every place a path can end, with its probability:
 * [{ stop_after: j (-1 = nothing happened), prob, delta, se }]. Probabilities sum to 1.
 */
export function pathOutcomes(steps) {
  const out = [];
  let reach = 1;
  for (let i = 0; i < steps.length; i++) {
    const prev = i === 0 ? { delta: 0, se: 0 } : steps[i - 1];
    out.push({ stop_after: i - 1, prob: reach * (1 - steps[i].p), delta: prev.delta, se: prev.se ?? null });
    reach *= steps[i].p;
  }
  const last = steps[steps.length - 1];
  if (last) out.push({ stop_after: steps.length - 1, prob: reach, delta: last.delta, se: last.se ?? null });
  return out;
}

/**
 * Score one path (the prototype's pathExpectation, unchanged in meaning):
 *   p_complete = product of every p
 *   score      = p_complete x final delta
 *   expected   = sum over stopping points of prob x delta (the honest number)
 *   stranded   = the part of `expected` from paths that stopped after a done step
 *   sd         = spread of the ending delta across accept/decline outcomes (for SAFE)
 */
export function pathExpectation(steps) {
  if (!steps.length) {
    return { p_complete: 0, delta_final: 0, score: 0, expected: 0, stranded: 0, expected_se: null, sd: 0 };
  }
  const outs = pathOutcomes(steps);
  let expected = 0, stranded = 0, var_ = 0, seKnown = true;
  for (const o of outs) {
    expected += o.prob * o.delta;
    if (o.stop_after >= 0 && o.stop_after < steps.length - 1) stranded += o.prob * o.delta;
    if (o.stop_after >= 0) {
      if (o.se == null) seKnown = false; else var_ += (o.prob * o.se) ** 2;
    }
  }
  let spread = 0;
  for (const o of outs) spread += o.prob * (o.delta - expected) ** 2;
  const last = steps[steps.length - 1];
  const p_complete = outs[outs.length - 1].prob;
  return { p_complete, delta_final: last.delta, score: p_complete * last.delta, expected, stranded,
    expected_se: seKnown ? Math.sqrt(var_) : null, sd: Math.sqrt(spread) };
}

/** Whether some later step hands on a player an earlier step brought in. */
export function isChained(steps) {
  const acquired = new Set();
  for (const s of steps) {
    if (s.give.some(id => acquired.has(id))) return true;
    for (const id of s.get) acquired.add(id);
  }
  return false;
}

/** Flip spread: p from A to B changes B by dB and A by dA; spread = dB + dA. */
export function flipSpread(dB, seB, dA, seA, k = NOISE_K) {
  const spread = dB + dA;
  const se = Math.sqrt((seB ?? 0) ** 2 + (seA ?? 0) ** 2);
  return { spread, se, clears: se > 0 && spread > k * se };
}

/** Linear shortlist estimate of Nick's change from single-player values. */
export function linearNick(finalIds, originalIds, addValue, lossValue) {
  const orig = new Set(originalIds), fin = new Set(finalIds);
  let v = 0;
  for (const id of fin) if (!orig.has(id)) v += addValue.get(id) ?? 0;
  for (const id of orig) if (!fin.has(id)) v += lossValue.get(id) ?? 0;
  return v;
}

/** k-subsets of size 1..max (max <= 3) of a list. */
export function combos(list, max = 2) {
  const out = list.map(x => [x]);
  if (max >= 2) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) out.push([list[i], list[j]]);
  }
  if (max >= 3) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      for (let k = j + 1; k < list.length; k++) out.push([list[i], list[j], list[k]]);
    }
  }
  return out;
}

/** Stable key for a deal (partner + sorted ids), used for dedupe, diffing and skip matching. */
export function dealKey(step) {
  if (!step) return 'none';
  const ids = a => [...(a ?? [])].map(String).sort().join('+');
  return `${step.team}|${ids(step.give)}|${ids(step.get)}`;
}

/** Players given across a whole path, net of ones the path itself brought in and passed on. */
export function assetsSpent(steps, originalIds) {
  const orig = new Set([...originalIds].map(String));
  const spent = new Set();
  for (const s of steps) for (const id of s.give) if (orig.has(String(id))) spent.add(String(id));
  return spent.size;
}
