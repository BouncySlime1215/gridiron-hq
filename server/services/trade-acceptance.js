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
});

/**
 * With no decided offers there is no observed rate to anchor on. This is a
 * DECLARED starting point, not an estimate of anything: it exists so the band
 * has a centre, and the width around it is set wide enough to say plainly that
 * the centre is not knowledge.
 */
const UNANCHORED_CENTRE = 0.30;

/** Band widths. Narrower means more evidence, never more confidence in the heuristic. */
const WIDTH = Object.freeze({
  no_counterparty_data: 0.55,
  unanchored: 0.45,
  min_anchored: 0.10,
  max_anchored: 0.35,
  /** Decided offers needed to halve the anchored band's extra width. */
  half_at_n: 12,
});

/** A probability is never reported as certainty or impossibility. */
const FLOOR = 0.02;
const CEILING = 0.97;

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
 */
export function acceptanceBand({ counterparty = null, edge = null, profile = null, zero = [] } = {}) {
  const off = new Set(zero);
  const factors = [];
  const inert = [];
  const add = (source, effect, why) => {
    if (off.has(source)) return;
    const spec = ACCEPTANCE_SOURCES[source];
    if (!Number.isFinite(effect) || Math.abs(effect) < 0.001) return;
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
  const centre = anchor.accept_rate == null ? UNANCHORED_CENTRE : anchor.accept_rate;

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
  const receptiveness = counterparty?.receptiveness;
  if (Number.isFinite(receptiveness) && Math.abs(receptiveness - 1) >= 0.001) {
    add('receptiveness', (receptiveness - 1) * 0.4,
      `receptiveness ${receptiveness.toFixed(2)} against a 1.00 no-information baseline`);
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

  // ------------------------------------------------------------ the band
  const mid = clamp(centre + factors.reduce((s, f) => s + f.effect, 0), FLOOR, CEILING);
  const width = !hasData ? WIDTH.no_counterparty_data
    : anchor.accept_rate == null ? WIDTH.unanchored
      : WIDTH.min_anchored
        + (WIDTH.max_anchored - WIDTH.min_anchored) / (1 + anchor.n / WIDTH.half_at_n);

  const basis = !hasData ? 'no_information'
    : anchor.accept_rate == null ? 'heuristic_unanchored' : 'heuristic_anchored';

  return {
    band: { low: round(clamp(mid - width / 2, 0, 1)), mid: round(mid),
      high: round(clamp(mid + width / 2, 0, 1)) },
    basis,
    fitted: false,
    why: !hasData
      ? 'no counterparty data for this league, so this is a declared starting point with a band '
        + 'wide enough to say it is not knowledge'
      : `a heuristic band around ${anchor.accept_rate == null ? 'a declared starting point'
        : 'his own observed accept rate'}, adjusted by ${factors.length} named `
        + `factor${factors.length === 1 ? '' : 's'} — not a calibrated probability`,
    anchor,
    factors,
    inert,
  };
}

/** The observed accept rate and its sample, reported the way anchorLadder reports it. */
function anchorOf(counterparty) {
  const rate = Number.isFinite(counterparty?.accept_rate) ? counterparty.accept_rate : null;
  const n = Number.isFinite(counterparty?.accept_rate_n) ? counterparty.accept_rate_n : 0;
  return {
    accept_rate: rate, n, calibrated: false, fitted: false,
    why: rate == null || n === 0
      ? 'no decided offers with this manager yet, so there is no accept rate to anchor on'
      : `${Math.round(rate * 100)}% of ${n} decided offers have been accepted — that is the anchor, `
        + 'not a calibrated probability for this package',
  };
}
