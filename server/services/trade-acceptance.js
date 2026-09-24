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
  /**
   * REP-01: how lopsided the offers Nick already sent him were, decayed on the
   * reputation half-life (selfRead's lopsidedness ledger). Not a price term: it
   * is his memory of the sender, which perception_delta (this package, on his
   * numbers) does not contain. DEFAULT-OFF: only a caller with
   * GRIDIRON_REPUTATION on passes a ledger, and with none passed the band is
   * exactly what it was. Forward-only until ~40 app offers settle (ENGINE-SPECS
   * REP-01 PRE).
   */
  reputation: {
    label: 'how lopsided your recent offers to him were',
    cap: 0.10,
    fitted: false,
    default_off: true,
    needs: 'GRIDIRON_REPUTATION on and offers logged in trade_outcomes',
  },
});

/**
 * P(accept) lost per unit of decayed lopsided spend (one full lowball = 1).
 * DECLARED, not fitted: three fresh lowballs cost about 0.09, just under the
 * cap. The PRE in ENGINE-SPECS REP-01 replaces it.
 */
export const REPUTATION_P_PER_UNIT = 0.03;

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
 * @param {object}   [reputation] this manager's entry in selfRead's lopsidedness
 *   ledger ({ spent, offers, half_life_days }). Omitted (the default, and always
 *   while GRIDIRON_REPUTATION is off) the factor is not read at all.
 */
export function acceptanceBand({ counterparty = null, edge = null, profile = null, zero = [], reputation = null } = {}) {
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

  // ------------------------------------- 4. his memory of your offers (REP-01)
  // Default-off: with no ledger supplied nothing is added, not even an inert
  // line, so a caller with the flag off gets today's band byte for byte.
  if (reputation) {
    const spent = Number(reputation.spent);
    if (!(reputation.offers > 0)) {
      skip('reputation', 'no logged offers to this manager, so there is no lopsidedness to charge');
    } else if (!Number.isFinite(spent) || spent < 0) {
      skip('reputation', `the ledger's decayed spend (${reputation.spent}) is not a usable number`);
    } else {
      add('reputation', -REPUTATION_P_PER_UNIT * spent,
        `${reputation.offers} logged offer${reputation.offers === 1 ? '' : 's'} to him, lopsided spend `
        + `${spent.toFixed(2)} after decay (half-life ${reputation.half_life_days ?? '?'} days)`);
    }
  }

  // ------------------------------------------------------------ the band
  const mid = clamp(centre + factors.reduce((s, f) => s + f.effect, 0), FLOOR, CEILING);
  const width = !hasData ? WIDTH.no_counterparty_data
    : !anchor.usable ? WIDTH.unanchored
      : WIDTH.min_anchored
        + (WIDTH.max_anchored - WIDTH.min_anchored) / (1 + anchor.n / WIDTH.half_at_n);

  const basis = !hasData ? 'no_information'
    : !anchor.usable ? 'heuristic_unanchored' : 'heuristic_anchored';

  return {
    band: bandAround(mid, width),
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
