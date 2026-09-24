/**
 * RL-19-3: the "title-mutual" trade class.
 *
 * findTrades' points gate asks one question: does this week's optimal lineup
 * go up (me.ppg_delta >= 0.4, and for the mutual class both sides past 0.15)?
 * Title odds ask another: does the rest of the season, simulated to the final,
 * go better? They disagree whenever WHEN the points land matters more than how
 * many land this week, and a 1-for-1 that raised both teams' title odds but
 * failed the points gate used to vanish without a trace.
 *
 * The gate itself is unchanged. This module takes the 1-for-1s it dropped (and
 * the ones that cleared the week gate but not the both-sides one), simulates a
 * bounded shortlist of them on the same paired-seed tradeImpact every other
 * title-odds surface uses (one world per search, fast rescore), and returns the
 * ones where BOTH teams gain past TRADE_DELTA_NOISE_SE paired standard errors.
 * They are a class of their own, beside the points-mutual list, never mixed
 * into it: the edge test and the score that order that list are lineup-points
 * numbers, and these deals fail them by construction.
 *
 * Default off. GRIDIRON_TITLE_MUTUAL_ENABLED=1 turns it on; so does preview
 * mode (preview-mode.js), in which case the block carries `preview: true`.
 */
import { previewUnconfirmed, previewFields, unconfirmedForwardOff } from './preview-mode.js';

export const TITLE_MUTUAL_ENV = 'GRIDIRON_TITLE_MUTUAL_ENABLED';
export const TITLE_MUTUAL_OFF_REASON = 'Title-mutual trades (RL-19-3) are default-off: the class is '
  + 'measured on a fixture league only, not yet on a synced league.';

/**
 * How many dropped 1-for-1s are simulated per search. Each costs one two-lineup
 * rescore inside the shared world (RL-19-2); the world itself is built once and
 * only when there is at least one candidate.
 */
export const TITLE_MUTUAL_BUDGET = 12;

/**
 * Both sides gain title odds, and both gains are past their own noise band
 * (tradeImpact's `*_clears_noise`, TRADE_DELTA_NOISE_SE paired SEs). The Title-
 * impact tab (title-odds-trades.js) re-exports it, so the two surfaces share it.
 */
export function mutualTitleGain(me, them) {
  return me.title_delta > 0 && them.title_delta > 0
    && me.title_delta_clears_noise === true && them.title_delta_clears_noise === true;
}

/** Read per call, like every preview-converted site, so a test can flip it. */
export function titleMutualMode() {
  if (unconfirmedForwardOff()) return { on: false, preview: false };   // FIX-274-1: the brain gate fell back
  if (process.env[TITLE_MUTUAL_ENV] === '1') return { on: true, preview: false };
  if (previewUnconfirmed()) return { on: true, preview: true };
  return { on: false, preview: false };
}

/**
 * A dropped 1-for-1 worth simulating: the non-points gates all hold (no hole
 * left in their lineup, no red flag, market value inside the finder's band) and
 * it is not already on the points-mutual list.
 */
export function titleCandidate(give, get, ev) {
  return give.length === 1 && get.length === 1 && !ev.mutual
    && ev.red_flags.length === 0 && ev.them.new_holes.length === 0
    && ev.their_value_pct >= -12 && ev.their_value_pct <= 18;
}

/**
 * The shortlist: one per partner+pair, least-bad joint lineup change first (the
 * playoff-weeks leg counted when it is known), then the closest on market value.
 */
export function titleShortlist(pool, budget = TITLE_MUTUAL_BUDGET) {
  const joint = d => d.joint_ppg + (d.me.playoff_ppg_delta ?? 0) + (d.them.playoff_ppg_delta ?? 0);
  const seen = new Set();
  const out = [];
  for (const d of [...pool].sort((a, b) => joint(b) - joint(a)
    || Math.abs(a.their_value_pct) - Math.abs(b.their_value_pct))) {
    const k = `${d.partner_id}|${d.i_give[0].id}|${d.i_get[0].id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
    if (out.length >= budget) break;
  }
  return out;
}

const titleSide = s => ({
  title_before: s.title_before, title_after: s.title_after,
  title_delta: s.title_delta, title_delta_se: s.title_delta_se,
  title_delta_clears_noise: s.title_delta_clears_noise,
  playoff_delta: s.playoff_delta, playoff_delta_se: s.playoff_delta_se,
});

/**
 * Simulate the shortlist and keep the deals both sides win on title odds.
 * `sim` is season-sim's { tradeImpact, tradeImpactWorld }, handed in by the
 * caller so this module never imports the simulator itself.
 *
 * A failure is reported, never swallowed: a world that cannot be built sets
 * `status: 'failed'` with the simulator's own error, and a deal that errors is
 * counted in `errors`.
 */
export function titleMutualDeals(lg, pool, { myTeamId, mode, sim, budget = TITLE_MUTUAL_BUDGET }) {
  const shortlist = titleShortlist(pool, budget);
  const base = { status: 'on', considered: pool.length, simulated: 0, errors: 0, budget,
    ...(mode.preview ? previewFields(TITLE_MUTUAL_OFF_REASON) : {}) };
  if (!shortlist.length) return { ...base, deals: [] };

  const world = sim.tradeImpactWorld(lg, {});
  if (world.fail) return { ...base, status: 'failed', error: world.fail.error ?? 'season sim unavailable', deals: [] };

  const deals = [];
  let errors = 0;
  for (const d of shortlist) {
    const impact = sim.tradeImpact(lg, { myTeamId, theirTeamId: d.partner_id,
      iGive: d.i_give.map(p => p.id), iGet: d.i_get.map(p => p.id), world });
    if (impact.error) { errors++; continue; }
    if (!mutualTitleGain(impact.me, impact.them)) continue;
    deals.push({ ...d, title_mutual: true, class: 'title_mutual',
      title: { runs: impact.runs, seed: impact.seed, from_week: impact.from_week,
        me: titleSide(impact.me), them: titleSide(impact.them) } });
  }
  deals.sort((a, b) => Math.min(b.title.me.title_delta, b.title.them.title_delta)
    - Math.min(a.title.me.title_delta, a.title.them.title_delta));
  return { ...base, simulated: shortlist.length, errors, deals };
}
