/**
 * North-star row 12: "how do we catch back up" (pure).
 *
 * The list is ordered by KIND first, then by gain inside a kind:
 *   1. free       moves that cost no player (waiver claims that beat a starter)
 *   2. flip       buy-low / sell-high through Nick, both legs fair on each screen
 *   3. desperate  deals with managers who are out of it (low title odds) or checked out
 *   4. swing      bigger swings when behind (all-in plans), only when Nick is behind
 *   5. timing     wait-or-act flags and the deadline clock
 * Cheap and certain before expensive and risky: that is the whole ordering rule.
 */
import { dealKey, screenPct } from './paths.js';

export const CATCHUP_ORDER = Object.freeze(['free', 'flip', 'desperate', 'swing', 'timing']);

/** items: [{ kind, gain (objective units, may be null), text, ... }] -> ordered copy with rank. */
export function orderCatchUp(items) {
  const rank = k => {
    const i = CATCHUP_ORDER.indexOf(k);
    return i < 0 ? CATCHUP_ORDER.length : i;
  };
  return [...items]
    .filter(x => x && CATCHUP_ORDER.includes(x.kind))
    .sort((a, b) => (rank(a.kind) - rank(b.kind)) || ((b.gain ?? -Infinity) - (a.gain ?? -Infinity)))
    .map((x, i) => ({ ...x, rank: i + 1 }));
}

/** Whether Nick is behind: his odds under an equal share of the league. */
export function isBehind(titleNow, teamCount) {
  return Number.isFinite(titleNow) && teamCount > 0 && titleNow < 1 / teamCount;
}

/**
 * Free moves: free agents whose rest-of-season rate beats Nick's weakest starter at the position.
 * fas: [{ id, name, position, ros_ppg }]; starters: [{ id, name, position, ros_ppg }]
 */
export function freeMoves(fas, starters, { limit = 3 } = {}) {
  const out = [];
  for (const fa of fas) {
    const same = starters.filter(s => s.position === fa.position && Number.isFinite(s.ros_ppg));
    if (!same.length || !Number.isFinite(fa.ros_ppg)) continue;
    const worst = same.reduce((a, b) => (b.ros_ppg < a.ros_ppg ? b : a));
    const edge = fa.ros_ppg - worst.ros_ppg;
    if (edge > 0) {
      out.push({ kind: 'free', gain: null, ppg_gain: edge, player: fa.id, replaces: worst.id,
        text: `Claim ${fa.name}: ${fa.ros_ppg.toFixed(1)} pts a game rest of season vs ${worst.name}'s ${worst.ros_ppg.toFixed(1)}.` });
    }
  }
  return out.sort((a, b) => b.ppg_gain - a.ppg_gain).slice(0, limit);
}

/** Title odds under which a manager is out of contention (Nick 9/24 CATCHUP-LIVE: 5%). */
export const OUT_OF_CONTENTION = 0.05;

/**
 * Who might sell: every league-mate's live contention and engagement read.
 * managers: Map team -> { title_now, checked_out, checked_out_source, p_checked_out }.
 * Returns [{ team, title_now, out_of_contention, checked_out, source, p_checked_out, why }] for the
 * managers that are out of it or checked out, lowest title odds first. title_now null = unknown, never
 * counted as out.
 */
export function sellersRead(managers, { threshold = OUT_OF_CONTENTION } = {}) {
  const out = [];
  for (const [team, m] of managers ?? []) {
    if (!m || m.blocked) continue;
    const t = Number.isFinite(m.title_now) ? m.title_now : null;
    const outOf = t != null && t < threshold;
    const co = !!m.checked_out;
    if (!outOf && !co) continue;
    const why = [];
    if (outOf) why.push(`title odds ${(t * 100).toFixed(1)}%`);
    if (co) {
      why.push(Number.isFinite(m.p_checked_out)
        ? `checked out (${m.checked_out_source ?? 'activity'}: P ${Math.round(m.p_checked_out * 100)}%)`
        : `checked out (${m.checked_out_source ?? 'activity'})`);
    }
    out.push({ team: String(team), title_now: t, out_of_contention: outOf, checked_out: co,
      source: m.checked_out_source ?? null, p_checked_out: Number.isFinite(m.p_checked_out) ? m.p_checked_out : null, why });
  }
  return out.sort((a, b) => (a.title_now ?? 1) - (b.title_now ?? 1));
}

/**
 * Desperate-seller moves: for each seller, the best ranked plan whose first step is with him, and the
 * discount that step asks him to take on his own market screen (what he gets vs what he gives, by
 * player value): discount = max(0, -screen %). ranked: planner plans (best first); sellers:
 * sellersRead(); playerValue(id) -> market value; pResponds(team) -> P(he answers) or null.
 * Sellers no plan reaches are returned in `unreached` (not items: nothing to do with them yet).
 */
export function desperateMoves(ranked, sellers, { playerValue = () => null, pResponds = () => null, names = id => `player ${id}`, limit = 3 } = {}) {
  const found = [], unreached = [];
  for (const s of sellers) {
    const plan = ranked.find(p => String(p.steps[0]?.team) === s.team) ?? null;
    if (plan) found.push({ s, plan }); else unreached.push(s);
  }
  const sum = ids => ids.reduce((t, id) => { const v = playerValue(id); return t == null || !Number.isFinite(v) ? null : t + v; }, 0);
  const items = found.sort((a, b) => (b.plan.expected ?? -Infinity) - (a.plan.expected ?? -Infinity)).slice(0, limit).map(({ s, plan }) => {
    const st = plan.steps[0];
    const his = screenPct(sum(st.give) ?? NaN, sum(st.get) ?? NaN);
    const discount = Number.isFinite(his) ? Math.max(0, -his) : null;
    const pr = pResponds(s.team);
    const priced = discount == null ? 'no market value for this deal'
      : discount > 0 ? `the plan asks him to take ${discount.toFixed(0)}% under his market screen, P(yes) ${Math.round(st.p * 100)}%`
        : `the plan pays him market value or more, P(yes) ${Math.round(st.p * 100)}%`;
    return { kind: 'desperate', gain: plan.expected, steps: plan.steps.length, team: s.team, reason: s.why,
      discount_pct: discount, screen_pct: Number.isFinite(his) ? his : null, p_yes: st.p, p_responds: pr, plan_key: dealKey(st),
      text: `Team ${s.team} (${s.why.join('; ')}): ${st.get.map(names).join(' + ')}; ${priced}`
        + (s.checked_out && Number.isFinite(pr) ? `; he answers ${Math.round(pr * 100)}% of the time.` : '.') };
  });
  return { items, unreached };
}
