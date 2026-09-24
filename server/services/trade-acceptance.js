/**
 * How likely is THIS manager to say yes to THIS deal — as a band, never as a
 * number we cannot back.
 *
 * Master plan D4: "P(accept) - too few decided proposals (6 accepts, 24
 * declines) to fit a model, so it is a band from the heuristic (their perceived
 * value delta, need fit, receptiveness, profile) with the observed accept rate
 * as the anchor, labelled as a band."
 *
 * Nothing here is fitted. Every term is a named, capped adjustment on a real
 * observed anchor, in the same shape `counterparty-pricing.js#playerValuation`
 * uses, so a reader can always see what moved it and by how much.
 *
 * **Why "need fit" and "profile" are not their own price terms, though D4 lists
 * them.** Both are already inside `perception_delta`: `playerValuation` charges
 * positional need as factor 5 and the negotiation profile's `roster_read` as
 * factor 2, and `readDeal` turns those priced players into the delta this
 * function reads. Adding them again here would be the double-charge that file
 * has three explicit rules against — the same evidence, counted twice, looking
 * like two independent reasons to believe. So the price axis enters exactly
 * once, as `perception_delta`, and what is added on top is only what that delta
 * does NOT already contain:
 *
 *   - `receptiveness`  — how open he is to dealing at all, which is about the
 *                        person's current posture, not this package's price.
 *                        Charged only for the part the anchor does not already
 *                        hold: `counterparty-pricing.js:180-182` blends the
 *                        observed accept rate into receptiveness with weight
 *                        `min(1, n/15)`, so past fifteen decided offers the
 *                        blend is entirely the accept rate and charging
 *                        receptiveness on top would count it twice.
 *
 *                        **What that costs, stated rather than hidden.** The
 *                        blend is not all of receptiveness: Nick's priors
 *                        (`:185-187`) and the post-loss window (`:195-196`) are
 *                        added AFTER it and are genuinely independent of the
 *                        accept rate, and the discount here is applied to the
 *                        whole deviation from 1.00 rather than to the blended
 *                        part alone. So past fifteen decided offers this band
 *                        gives up those two signals, and below fifteen it
 *                        under-weights them (the chat part is discounted by
 *                        `1-w` inside the blend and again by `1-w` here) while
 *                        still carrying `w(1-w)` of the accept rate. Both
 *                        errors point at "charge less than we could", which is
 *                        the safe direction for a band that is not fitted, but
 *                        neither is exact. Undoing the blend properly means
 *                        inverting `:175-199`, which is a change to that file's
 *                        contract and is not made here.
 *   - `says_no_holds`  — whether a stated no converts into a real no. Declared
 *                        in NEGOTIATION_PROFILE_SCHEMA and read by nothing in
 *                        server/ before this file; it is a behavioural signal,
 *                        independent of what he thinks the players are worth.
 *
 * **The band is wide on purpose.** Its width is set by how much evidence stands
 * behind the anchor, not by how confident the heuristic feels. No decided
 * offers means a band wide enough to be nearly useless, which is the honest
 * answer rather than a confident midpoint invented out of a prior.
 *
 * **The edge test gates it.** A deal that fails `edgeTest` never receives an
 * acceptance number at all. An idea that only wins on his perception is a gift,
 * and a gift does not become sendable because he would probably take it.
 */

import { previewFields, previewText, previewUnconfirmed } from './preview-mode.js';

/** Every source allowed to move the band, with its own cap. */
export const ACCEPTANCE_SOURCES = Object.freeze({
  perception_delta: {
    label: 'how the deal reads on his numbers',
    cap: 0.30,
    fitted: false,
    needs: 'a chat or profile read that actually priced one of these players',
  },
  receptiveness: {
    label: 'how open he is to dealing right now',
    cap: 0.12,
    fitted: false,
    needs: 'manager signals; 1.0 means no information',
  },
  says_no_holds: {
    label: 'whether his no holds',
    cap: 0.08,
    fitted: false,
    needs: 'a valid negotiation profile stating does_his_no_hold',
  },
  // CLONE-01b b2. Both default-off (GRIDIRON_CLONE_V2 or preview mode): the
  // engine passes them only when on, so off is the band exactly as before.
  clone: {
    label: 'his clone: accept rate, motive and activity, updated by his replies to your offers',
    cap: 0.30,
    fitted: false,
    needs: 'the counterparty layer, and settled replies to offers you sent him (manager_clone_fits)',
  },
  veto: {
    label: 'chance the league vetoes it after he accepts',
    cap: 0.30,
    fitted: false,
    needs: "the league's vetoVotesRequired and its veto history (1 vetoed trade so far)",
  },
});

/**
 * With no decided offers there is no observed rate to anchor on. This is a
 * DECLARED starting point, not an estimate of anything: it exists so the band
 * has a centre, and the width around it is set wide enough to say plainly that
 * the centre is not knowledge.
 */
const UNANCHORED_CENTRE = 0.30;

/**
 * Decided offers at which `counterparty-pricing.js` has blended the observed
 * accept rate ENTIRELY into receptiveness (`:181`, `min(1, n/15)`). Mirrored
 * here so the band can charge only the part of receptiveness the anchor does
 * not already contain. If that file's blend changes, this must change with it.
 */
const ANCHOR_BLEND_N = 15;

/** Band widths. Narrower means more evidence, never more confidence in the heuristic. */
const WIDTH = Object.freeze({
  no_counterparty_data: 0.55,
  unanchored: 0.45,
  min_anchored: 0.10,
  max_anchored: 0.35,
  /** Decided offers needed to halve the anchored band's extra width. */
  half_at_n: 12,
});

/**
 * A probability is never reported as certainty or impossibility — and that
 * holds for the EDGES of the band, not only its midpoint. Exported so a test
 * asserts the published invariant rather than a copy of these numbers.
 */
export const BAND_FLOOR = 0.02;
export const BAND_CEILING = 0.97;
const FLOOR = BAND_FLOOR;
const CEILING = BAND_CEILING;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round = x => +x.toFixed(3);

/** What a stated no is worth, as an effect on the band. */
const NO_HOLDS_EFFECT = Object.freeze({
  rarely: 0.08,   // his no is an opening price
  usually: -0.03,
  yes: -0.08,     // his no is final
});

/**
 * The band for one deal.
 *
 * @param {object}   counterparty the block the trade engine already puts on
 *   every idea (`readDeal`'s output plus `counterparty_data`).
 * @param {object}   edge         `edgeTest`'s result. Required: a missing one
 *   fails closed rather than being read as a pass.
 * @param {object}   [profile]    the manager's negotiation profile, if valid.
 * @param {string[]} [zero]       sources to suppress, for the ablation.
 * @param {object}   [clone]      CLONE-01b b2: `cloneFor`'s result, passed only
 *   when the clone flag is on. It moves the centre as one capped factor.
 * @param {object}   [veto]       CLONE-01b b2: `vetoFactor`'s result. Adds
 *   `completion`, P(complete) = P(accept) x (1 - P(veto)); the band itself stays
 *   P(accept), which is what E1 grades.
 */
export function acceptanceBand({ counterparty = null, edge = null, profile = null, zero = [],
  clone = null, veto = null } = {}) {
  const off = new Set(zero);
  const factors = [];
  const inert = [];
  const add = (source, effect, why) => {
    if (off.has(source)) return;
    const spec = ACCEPTANCE_SOURCES[source];
    // A source that was READ and came out at nothing is not the same as a source
    // that was never read, and a reader must be able to tell them apart — the
    // first rule `counterparty-pricing.js` states. Dropping it from `factors`
    // AND from `inert` made "priced, and it reads as neutral" look identical to
    // "no data for this league".
    if (!Number.isFinite(effect)) {
      inert.push({ source, reason: `${why}, but that did not reduce to a usable number` });
      return;
    }
    if (Math.abs(effect) < 0.001) {
      inert.push({ source,
        reason: `${why} — read, but it moves the band by less than 0.001, so it is reported `
          + 'rather than rounded into a factor that would read as a real adjustment' });
      return;
    }
    const capped = clamp(effect, -spec.cap, spec.cap);
    factors.push({ source, label: spec.label, effect: round(capped), cap: spec.cap,
      fitted: false, why });
  };
  const skip = (source, reason) => { if (!off.has(source)) inert.push({ source, reason }); };

  // ------------------------------------------------- the edge test, first
  // Before anything is priced, because an idea that fails it must not carry an
  // acceptance number at all — not even a low one, which would still read as
  // "sendable, just unlikely" rather than "we should not be offering this".
  const refuse = (basis, why) => ({ band: null, basis, why, fitted: false,
    anchor: anchorOf(counterparty), factors: [], inert: [] });
  if (!edge || typeof edge.passes !== 'boolean') {
    return refuse('edge_unknown',
      'no edge-test result was supplied, so nothing is claimed about acceptance; this fails closed');
  }
  if (!edge.passes) {
    return refuse('edge_failed',
      'this deal does not pass the edge test — it is not positive for you on our own numbers, '
      + `so how likely he is to accept is not a question worth answering${
        edge.failed?.length ? ` (failed: ${edge.failed.join(', ')})` : ''}`);
  }

  const anchor = anchorOf(counterparty);
  const hasData = counterparty?.counterparty_data === true;

  // ------------------------------------------------------------ the centre
  //
  // `anchor.usable`, not `anchor.accept_rate != null`: a rate with no decided
  // offers behind it is a number, not an observation, and centring on it bought
  // a band NARROWER than knowing nothing. `manager-signals.js:206` withholds the
  // rate below five decisions, so this shape cannot come off a real league today
  // — but that gate is in a third module with nothing tying it to this one, and
  // an unreachable state that would print a confident number is still a state
  // this function has to refuse. What we were handed stays reported on `anchor`.
  if (anchor.accept_rate != null && !anchor.usable) {
    inert.push({ source: 'anchor',
      reason: `an accept rate of ${anchor.accept_rate} arrived with 0 decided offers behind it; `
        + 'a rate with no sample is not an observation, so it does not anchor this band' });
  }
  const centre = anchor.usable ? anchor.accept_rate : UNANCHORED_CENTRE;

  // --------------------------------------- 1. how it reads on his numbers
  const delta = counterparty?.perception_delta;
  if (counterparty?.perception_informed && Number.isFinite(delta)) {
    // perception_delta is a percentage: how much more he thinks he gets than he
    // gives. 0.6 of it, capped, keeps a 20%-better-for-him deal worth about 12
    // points of probability rather than letting one lopsided read dominate.
    add('perception_delta', (delta / 100) * 0.6,
      `${delta > 0 ? '+' : ''}${delta}% on his own numbers`);
  } else {
    skip('perception_delta', hasData
      ? 'nothing he has said or that his profile records priced any player in this deal'
      : 'no counterparty data for this league');
  }

  // --------------------------------------------- 2. his posture right now
  //
  // Charged only for the part the anchor does not already carry.
  // `counterparty-pricing.js:180-182` blends `tx_accept_rate` INTO receptiveness
  // with weight `min(1, n/15)`, so at fifteen or more decided offers the blended
  // score is entirely the accept rate this band is already centred on. Adding it
  // on top would count one piece of evidence twice and make a single observed
  // rate look like two agreeing signals — the same failure `playerValuation`
  // avoids by treating talk_vs_model and chat_sentiment as alternatives rather
  // than additions. The blend is not quite all of receptiveness (the header says
  // what this approximation gives up, and in which direction).
  const receptiveness = counterparty?.receptiveness;
  // Only an anchor this band is ACTUALLY centred on can carry receptiveness for
  // it. The skip below asserts a fact about where the centre came from; printing
  // it while the centre is the declared starting point would drop real evidence
  // and give a false reason for doing it.
  const carriedByAnchor = anchor.usable ? Math.min(1, anchor.n / ANCHOR_BLEND_N) : 0;
  if (Number.isFinite(receptiveness) && Math.abs(receptiveness - 1) >= 0.001) {
    if (carriedByAnchor >= 1) {
      skip('receptiveness', `his ${anchor.n} decided offers are already the anchor this band is `
        + 'centred on, and receptiveness is built from them — charging it again would count the '
        + 'same evidence twice');
    } else {
      add('receptiveness', (receptiveness - 1) * 0.4 * (1 - carriedByAnchor),
        `receptiveness ${receptiveness.toFixed(2)} against a 1.00 no-information baseline`
        + (carriedByAnchor > 0
          ? `, discounted to ${Math.round((1 - carriedByAnchor) * 100)}% because ${anchor.n} `
            + 'decided offers are already in the anchor'
          : ''));
    }
  } else {
    skip('receptiveness', 'receptiveness is 1.00, which is this layer saying it knows nothing');
  }

  // ------------------------------------------------- 3. does his no hold
  const noHold = profile?.says_no?.does_his_no_hold ?? null;
  if (noHold && noHold !== 'unknown' && noHold in NO_HOLDS_EFFECT) {
    add('says_no_holds', NO_HOLDS_EFFECT[noHold],
      noHold === 'rarely' ? 'his profile says his no rarely holds, so a first no is an opening price'
        : noHold === 'yes' ? 'his profile says his no holds, so a refusal is likely final'
          : 'his profile says his no usually holds');
  } else {
    skip('says_no_holds', profile
      ? `his profile records does_his_no_hold as ${noHold ?? 'absent'}`
      : 'no valid negotiation profile for this manager');
  }

  // ------------------------------------------------- 4. his clone (b2)
  //
  // The clone's prior already holds the observed accept rate this band is
  // centred on, so it enters as the DIFFERENCE from that centre: it replaces
  // the anchor rather than stacking on it. Perception, receptiveness and the
  // profile's no stay as they are; the clone skips an activity term that
  // receptiveness already applied (clonePrior), so nothing is counted twice.
  const cloneOn = clone && Number.isFinite(clone.p) && !off.has('clone');
  if (cloneOn) {
    add('clone', clone.p - centre, `his clone reads ${clone.p.toFixed(3)} against a centre of `
      + `${centre.toFixed(3)} (${clone.n} settled repl${clone.n === 1 ? 'y' : 'ies'} to your offers; ${clone.reason})`);
  }

  // ------------------------------------------------------------ the band
  const mid = clamp(centre + factors.reduce((s, f) => s + f.effect, 0), FLOOR, CEILING);
  const width = !hasData ? WIDTH.no_counterparty_data
    : !anchor.usable ? WIDTH.unanchored
      : WIDTH.min_anchored
        + (WIDTH.max_anchored - WIDTH.min_anchored) / (1 + anchor.n / WIDTH.half_at_n);

  const basis = !hasData ? 'no_information'
    : !anchor.usable ? 'heuristic_unanchored' : 'heuristic_anchored';

  const band = bandAround(mid, width);
  const completion = veto && !off.has('veto') ? completionOf(band, veto) : null;

  return {
    band,
    basis,
    fitted: false,
    why: !hasData
      ? 'no counterparty data for this league, so this is a declared starting point with a band '
        + 'wide enough to say it is not knowledge'
      : `a heuristic band around ${anchor.usable ? 'his own observed accept rate'
        : 'a declared starting point'}, adjusted by ${factors.length} named `
        + `factor${factors.length === 1 ? '' : 's'} — not a calibrated probability`,
    anchor,
    factors,
    inert,
    ...(cloneOn ? { clone } : {}),
    ...(completion ? { completion } : {}),
  };
}

/** P(complete) = P(accept) x (1 - P(veto)), on each end of the band. */
function completionOf(band, veto) {
  if (!Number.isFinite(veto.p_veto)) {
    return { band: null, p_veto: null, fitted: false, reason: veto.reason };
  }
  const keep = 1 - veto.p_veto;
  return {
    band: { low: round(band.low * keep), mid: round(band.mid * keep), high: round(band.high * keep) },
    p_veto: veto.p_veto, level: veto.level ?? null, fitted: false,
    why: `P(complete) = P(accept) x (1 - ${veto.p_veto}); ${veto.why}`,
  };
}

/**
 * A band of the width the evidence bought, placed so that neither end reports
 * certainty or impossibility.
 *
 * The edges used to be clamped into [0, 1] independently of each other, which
 * did two wrong things at once: it published 1.000 and 0.000 as the ends of a
 * probability this module says it never states with certainty, and it ATE the
 * band's width whenever the midpoint sat near an extreme — 0.084 wide where the
 * evidence bought 0.127. Narrower must always mean more evidence. So the band is
 * SLID into [FLOOR, CEILING] with its width intact instead of being cut down to
 * fit; the widest band here is 0.55 and the window is 0.95, so it always fits.
 */
function bandAround(mid, width) {
  const lo = mid - width / 2;
  const hi = mid + width / 2;
  const shift = Math.max(0, FLOOR - lo) - Math.max(0, hi - CEILING);
  return { low: round(lo + shift), mid: round(mid), high: round(hi + shift) };
}

/**
 * The observed accept rate and its sample, reported the way anchorLadder
 * reports it, plus whether it may be used as an anchor at all.
 *
 * `usable` is separate from `accept_rate` on purpose: what we were handed is
 * always reported, and whether it earns the centre of a band is a second
 * question. A rate with zero decided offers behind it answers no.
 */
function anchorOf(counterparty) {
  const rate = Number.isFinite(counterparty?.accept_rate) ? counterparty.accept_rate : null;
  const n = Number.isFinite(counterparty?.accept_rate_n) ? counterparty.accept_rate_n : 0;
  const usable = rate != null && n > 0;
  return {
    accept_rate: rate, n, usable, calibrated: false, fitted: false,
    why: !usable
      ? (rate == null
        ? 'no decided offers with this manager yet, so there is no accept rate to anchor on'
        : `an accept rate of ${rate} arrived with no decided offers behind it, so it is reported `
          + 'but does not anchor anything')
      : `${Math.round(rate * 100)}% of ${n} decided offers have been accepted — that is the anchor, `
        + 'not a calibrated probability for this package',
  };
}

/* ------------------------------------------------ CLONE-01b b2: the clones */

/**
 * The clone of one manager: what we would predict HE does with THIS package.
 *
 *   prior      his decided-offer accept rate, shrunk to the league pool
 *              (beta-binomial, strength m), then capped logit offsets for his
 *              motive state (CLONE-01a) and his trade activity (RL-11-1). This
 *              is the population model at n = 0.
 *   update     Beta(prior p x S, (1 - p) x S), S = m + his history, plus every
 *              settled reply to an offer Nick SENT him (manager_clone_fits),
 *              each weighted by how much it says about THIS package: a decline
 *              refutes every package at or below its price for him in full and
 *              a better one less (exp decay per GAIN_SCALE_PCT); an accept the
 *              mirror image. A reply whose price is unknown counts in full.
 *   bound      a decline says his reservation value is above that package, so
 *              the highest declined gain is the floor the follow-up must clear.
 *
 * Nothing is fitted: the offsets and the decay scale are declared guesses,
 * labelled `fitted:false`, and the grade (scripts/rnd/grade-clone-e1.mjs, EVAL
 * E1) decides whether the flag may ever default on.
 */
export const CLONE_ENV = 'GRIDIRON_CLONE_V2';
const CLONE_UNCONFIRMED = 'default-off: CLONE-01b b2 manager clones and veto, unconfirmed forward';
/** Largest move one prior offset may make, in logit units. */
export const CLONE_OFFSET_CAP = 0.4;
/** Declared, not fitted: how far each motive state leans him toward yes (logit). */
const MOTIVE_LOGIT = Object.freeze({ desperate_buyer: 0.4, buyer: 0.2, seller: 0.2, hold: 0 });
/** A reply's relevance halves-ish (1/e) for every this-many points of gain between its package and this one. */
export const GAIN_SCALE_PCT = 10;
/**
 * A reply whose price is unknown still says how open he is, exactly as the
 * unpriced ESPN history in the prior does, so it counts in full: only a KNOWN
 * price gap discounts a reply.
 */
const UNKNOWN_GAIN_WEIGHT = 1;
/** No league pool at all: the band's declared starting point, at CLONE-01a's fallback strength. */
const DECLARED_POOL = Object.freeze({ p0: UNANCHORED_CENTRE, m: 15 });
/** Declared P(veto) by vetoRiskFor level (n = 1 vetoed trade, C27): never fitted. */
const VETO_P = Object.freeze({ low: 0.02, watch: 0.10, high: 0.30, unknown: 0.05 });

const logit = p => Math.log(p / (1 - p));
const sigmoid = x => 1 / (1 + Math.exp(-x));

/** Off, on by its own flag, or on only because of preview mode (then labelled). Read per call. */
export function cloneMode() {
  const site = process.env[CLONE_ENV] === '1';
  const preview = !site && previewUnconfirmed();
  return { on: site || preview, preview };
}

/** His gain on one package, % of what he gives: the engine's their_value_pct unit. Null if unpriced. */
export function packageGainPct(give, get) {
  const sum = ps => (ps ?? []).reduce((s, p) => (Number.isFinite(p?.value) ? s + p.value : NaN), 0);
  const out = sum(give);
  const back = sum(get);
  if (!Number.isFinite(out) || !Number.isFinite(back) || back <= 0 || !(give ?? []).length) return null;
  return +(((out - back) / back) * 100).toFixed(1);
}

/** The league pool over the managers who carry an accept rate: {p0, m}, or null. */
export function leagueAcceptPool(counterparties) {
  let k = 0;
  let n = 0;
  for (const c of counterparties ?? []) {
    if (!Number.isFinite(c?.accept_rate) || !(c.accept_rate_n > 0)) continue;
    k += c.accept_rate * c.accept_rate_n;
    n += c.accept_rate_n;
  }
  return n > 0 ? { p0: k / n, m: DECLARED_POOL.m, decisions: n } : null;
}

function motiveOffset(motive) {
  const state = motive?.state ?? null;
  if (!state || !(state in MOTIVE_LOGIT)) {
    return { source: 'motive', logit: null,
      reason: motive?.reason ?? 'no motive state on this profile (CLONE-01a is off or has no season sim)' };
  }
  return { source: 'motive', logit: clamp(MOTIVE_LOGIT[state], -CLONE_OFFSET_CAP, CLONE_OFFSET_CAP),
    state, fitted: false, reason: `motive ${state} (declared offset, not fitted)` };
}

function activityOffset(factors) {
  const f = (factors ?? []).find(x => x?.source === 'trade_activity') ?? null;
  if (!f) return { source: 'activity', logit: null, reason: 'no trade-activity read for him' };
  if (Number.isFinite(f.effect)) {
    return { source: 'activity', logit: null,
      reason: 'already applied in his receptiveness, which this band charges; not counted again' };
  }
  const e = Number.isFinite(f.would_effect) ? f.would_effect : null;
  if (e == null) return { source: 'activity', logit: null, reason: f.why ?? 'his activity term is withheld' };
  const x = clamp(logit(clamp(0.5 + e, 0.05, 0.95)), -CLONE_OFFSET_CAP, CLONE_OFFSET_CAP);
  return { source: 'activity', logit: +x.toFixed(4), fitted: true,
    reason: `trade activity ${e > 0 ? '+' : ''}${e.toFixed(2)} on the receptiveness score` };
}

/**
 * The population prior for one manager. `settled` is the part of his ESPN
 * accept rate that is also a settled sent offer: those replies enter as the
 * update, so they are taken out of the history here rather than counted twice.
 */
export function clonePrior({ counterparty = null, pool = null, settled = { n: 0, k: 0 } } = {}) {
  const P = pool && pool.p0 > 0 && pool.p0 < 1 ? pool : DECLARED_POOL;
  const rate = Number.isFinite(counterparty?.accept_rate) ? counterparty.accept_rate : null;
  const n0 = rate == null ? 0 : (counterparty.accept_rate_n ?? 0);
  const n = Math.max(0, n0 - (settled?.n ?? 0));
  const k = rate == null ? 0 : clamp(Math.round(rate * n0) - (settled?.k ?? 0), 0, n);
  const pShrunk = (k + P.m * P.p0) / (n + P.m);
  const offsets = [motiveOffset(counterparty?.motive), activityOffset(counterparty?.receptiveness_factors)];
  const shift = offsets.reduce((s, o) => s + (o.logit ?? 0), 0);
  const p = shift === 0 ? pShrunk : sigmoid(logit(pShrunk) + shift);
  return { p, p_shrunk: +pShrunk.toFixed(4), strength: P.m + n, history_n: n, history_k: k,
    pool: { p0: +P.p0.toFixed(4), m: P.m, source: P === pool ? 'league' : 'declared' }, offsets };
}

/** How much one settled reply says about a package at `gain` for him. */
function relevance(reply, gain) {
  if (!Number.isFinite(reply.gain_pct) || !Number.isFinite(gain)) return UNKNOWN_GAIN_WEIGHT;
  const gap = reply.y ? reply.gain_pct - gain : gain - reply.gain_pct;
  return gap <= 0 ? 1 : Math.exp(-gap / GAIN_SCALE_PCT);
}

/** The clone's P(accept) for one package, with its prior, its evidence and the price bound. */
export function cloneFor({ counterparty = null, pool = null, fit = null, gainPct = null, preview = false } = {}) {
  const replies = (fit?.replies ?? []).filter(r => r && (r.y === 0 || r.y === 1));
  const k = replies.filter(r => r.y === 1).length;
  // Only an accept or a decline is inside his ESPN accept rate (manager-signals
  // counts his EXECUTE TRADE_ACCEPT / TRADE_DECLINE rows; checked on the local DB
  // 9/24, 6 of 6 managers exact). A counter is his own TRADE_PROPOSAL, not a
  // decline, so it is not in the history and is not taken out of it.
  const inHistory = replies.filter(r => r.status !== 'countered');
  const prior = clonePrior({ counterparty, pool,
    settled: { n: inHistory.length, k: inHistory.filter(r => r.y === 1).length } });
  let p = prior.p;
  if (replies.length) {
    let a = prior.p * prior.strength;
    let b = (1 - prior.p) * prior.strength;
    for (const r of replies) {
      if (r.y) a += relevance(r, gainPct); else b += relevance(r, gainPct);
    }
    p = a / (a + b);
  }
  const declined = replies.filter(r => r.y === 0 && Number.isFinite(r.gain_pct)).map(r => r.gain_pct);
  const priceBound = declined.length ? { gain_pct: Math.max(...declined), declines: declined.length } : null;
  const reason = replies.length
    ? `${k} of ${replies.length} settled replies accepted, each weighted by how close its price was to this one`
    : 'no settled reply to an offer you sent him yet, so the clone is the population prior';
  const why = `clone P(accept) ${p.toFixed(3)} from a prior of ${prior.p.toFixed(3)} `
    + `(accept rate shrunk to the ${prior.pool.source} pool ${prior.pool.p0}); ${reason}`;
  return { p, prior_p: prior.p, n: replies.length, k, history_n: prior.history_n, gain_pct: gainPct,
    price_bound: priceBound, pool: prior.pool, offsets: prior.offsets, fitted: false, reason,
    why: preview ? previewText(why) : why, ...(preview ? previewFields(CLONE_UNCONFIRMED) : {}) };
}

/** The follow-up after a decline: the cheapest package that clears his price bound. */
export function cheapestAbove(packages, boundPct) {
  if (!Number.isFinite(boundPct)) return null;
  const above = (packages ?? []).filter(x => Number.isFinite(x?.gain_pct) && x.gain_pct > boundPct);
  return above.length ? above.reduce((best, x) => (x.gain_pct < best.gain_pct ? x : best)) : null;
}

/** P(veto) from `vetoRiskFor`'s read of this package, or null with the reason. */
export function vetoFactor(risk) {
  if (!risk) return { p_veto: null, reason: 'no veto read was supplied for this league', fitted: false };
  if (risk.votes_required == null) {
    return { p_veto: null, fitted: false,
      reason: "this league's ESPN settings carry no vetoVotesRequired, so P(veto) is not stated" };
  }
  const base = { votes_required: risk.votes_required, other_owners: risk.other_owners ?? null,
    level: risk.level ?? 'unknown', n: risk.n ?? 0, fitted: false };
  if (risk.veto_reachable === false) {
    return { ...base, p_veto: 0, why: `${risk.votes_required} votes are needed and only `
      + `${risk.other_owners} other owners vote, so a veto cannot happen here` };
  }
  const p = Math.min(ACCEPTANCE_SOURCES.veto.cap, VETO_P[base.level] ?? VETO_P.unknown);
  return { ...base, p_veto: p, why: `veto risk ${base.level} (declared ${p}, not fitted: this league `
    + `family has ${base.n} vetoed trade${base.n === 1 ? '' : 's'} on record)` };
}
