/**
 * Partner choice (RULING 2026-09-23 ~8:40 PM, WORK-QUEUE): P(responds) x edge (pure).
 *
 *   P(responds)  from ACTIVITY (the proven who-trades signal): today's
 *                counterparty layer receptiveness, a checked-out manager near 0,
 *                a "never trades" manager exactly 0.
 *   chat labels  engagement / tone / open-to-trade / negotiation-profile labels
 *                from the local chat DB, as LABELS and counts only (no text).
 *                They run in SHADOW: a `shadow_score` is computed and shown but
 *                does not steer, until EVAL-01 lets them earn weight.
 *   sentiment    who loves / hates which player: a TARGETING hint (who to ask),
 *                labelled "from chat", never a price.
 *   skip log     options Nick skipped sink (a multiplier on the positive score),
 *                they are not hidden; "not now" fades after a week.
 */

export const UNKNOWN = 'unknown';
/** P(responds) at receptiveness 1.0 (no information). Hand-set anchor, not fitted. */
export const BASE_RESPONDS = 0.5;
export const CHECKED_OUT_RESPONDS = 0.05;
/** Skip weights per reason (hand-set). */
export const SKIP_WEIGHT = Object.freeze({ player: 0.5, cost: 0.7, manager: 0.4, not_now: 0.8, other: 0.6 });
export const NOT_NOW_DAYS = 7;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** m: counterparty-layer entry ({ receptiveness, tier }) + { checked_out, blocked }. */
export function pResponds(m) {
  if (!m) return { p: BASE_RESPONDS * 0.8, basis: 'no manager read; below the neutral anchor' };
  if (m.blocked) return { p: 0, basis: 'marked as never trading' };
  if (m.checked_out) return { p: CHECKED_OUT_RESPONDS, basis: 'checked out (no recent activity)' };
  const r = Number.isFinite(m.receptiveness) ? m.receptiveness : 1;
  return { p: clamp(BASE_RESPONDS * r, 0.05, 0.9), basis: `activity read (receptiveness ${r.toFixed(2)})` };
}

const band = (v, hi, lo) => (!Number.isFinite(v) ? UNKNOWN : v >= hi ? 'high' : v >= lo ? 'medium' : 'low');

/**
 * Chat rows -> labels. profile: manager_chat_profile row or null; negotiation: parsed profile or null;
 * sentiment: [{ player, sentiment_mean (0-4, 2 neutral), n }].
 */
export function chatLabels({ profile = null, negotiation = null, sentiment = [] } = {}) {
  if (!profile && !negotiation && !sentiment.length) {
    return { engagement: UNKNOWN, tone: UNKNOWN, open_to_trade: UNKNOWN, no_holds: UNKNOWN,
      loves: [], hates: [], messages: 0, source: 'chat', status: UNKNOWN };
  }
  const msgs = Number(profile?.msgs ?? 0);
  const tones = [['competitive', profile?.p_competitive], ['friendly', profile?.p_friendly], ['defensive', profile?.p_defensive]]
    .filter(([, v]) => Number.isFinite(v));
  const tone = tones.length ? tones.reduce((a, b) => (b[1] > a[1] ? b : a))[0] : UNKNOWN;
  const noHolds = negotiation?.says_no?.does_his_no_hold ?? null;
  const loves = sentiment.filter(s => s.n >= 2 && s.sentiment_mean >= 3).map(s => String(s.player));
  const hates = sentiment.filter(s => s.n >= 2 && s.sentiment_mean <= 1).map(s => String(s.player));
  return {
    engagement: profile ? (msgs >= 200 ? 'high' : msgs >= 30 ? 'medium' : msgs > 0 ? 'low' : UNKNOWN) : UNKNOWN,
    tone, open_to_trade: band(profile?.p_open_to_trade, 0.3, 0.1),
    no_holds: typeof noHolds === 'string' ? noHolds : UNKNOWN,
    loves, hates, messages: msgs, source: 'chat', status: 'ok',
  };
}

/** Shadow-only chat adjustment of P(responds): shown, never used to rank. */
export function shadowResponds(pr, labels) {
  if (!labels || labels.status !== 'ok') return null;
  const tilt = { high: 1.15, medium: 1, low: 0.85 }[labels.open_to_trade] ?? 1;
  return clamp(pr * tilt, 0, 0.95);
}

/**
 * Rank partners: edge = best expected gain available through him (objective units).
 * managers: Map team -> { ...layer entry, checked_out, blocked, chat }
 */
export function rankPartners(managers, edgeByTeam) {
  const out = [];
  for (const [team, m] of managers) {
    const pr = pResponds(m);
    const edge = edgeByTeam.get(String(team)) ?? 0;
    out.push({ team: String(team), p_responds: pr.p, basis: pr.basis, edge, score: pr.p * Math.max(0, edge),
      chat: m.chat ?? chatLabels(), shadow_score: (shadowResponds(pr.p, m.chat) ?? pr.p) * Math.max(0, edge),
      checked_out: !!m.checked_out, blocked: !!m.blocked,
      needs: (Array.isArray(m.needs) ? m.needs : m.needs ? Object.keys(m.needs) : []).map(String), sent_this_week: m.sent_this_week ?? null });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * The skip log for one league -> weights. skips: [{ league, player?, manager?, reason, at }].
 * Returns { player: Map id -> w, manager: Map team -> w }; weights multiply (two skips sink more).
 */
export function skipWeights(skips, leagueId, now = Date.now()) {
  const player = new Map(), manager = new Map();
  for (const s of skips ?? []) {
    if (String(s.league) !== String(leagueId)) continue;
    const reason = SKIP_WEIGHT[s.reason] != null ? s.reason : 'other';
    if (reason === 'not_now' && Number.isFinite(Date.parse(s.at)) && now - Date.parse(s.at) > NOT_NOW_DAYS * 864e5) continue;
    const w = SKIP_WEIGHT[reason];
    if (s.player != null) player.set(String(s.player), (player.get(String(s.player)) ?? 1) * w);
    if (s.manager != null) manager.set(String(s.manager), (manager.get(String(s.manager)) ?? 1) * w);
  }
  return { player, manager };
}

/** A plan's skip weight: the product over every player it gets and every partner it offers. */
export function planSkipWeight(plan, weights) {
  let w = 1;
  for (const s of plan.steps) {
    w *= weights.manager.get(String(s.team)) ?? 1;
    for (const id of s.get) w *= weights.player.get(String(id)) ?? 1;
  }
  return w;
}
