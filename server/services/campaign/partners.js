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
 *   Nick         his own per-roster read (m.nick, server/services/people/profile-reader.js#nickBlock)
 *                beats every activity and chat read above (FIX-02c):
 *                unreachable -> excluded, P(responds) 0, never a step, flip leg or
 *                target owner; not trading -> capped at CHECKED_OUT_RESPONDS;
 *                active -> floored at BASE_RESPONDS and first at equal score;
 *                hard to deal with -> tougher pricing (playbook.js#priceLadder).
 */

export const UNKNOWN = 'unknown';
/** P(responds) at receptiveness 1.0 (no information). Hand-set anchor, not fitted. */
export const BASE_RESPONDS = 0.5;
/** P(responds) of a checked-out manager, and the cap for one Nick says is not trading. Hand-set, not fitted. */
export const CHECKED_OUT_RESPONDS = 0.05;
/** Skip weights per reason (hand-set). */
export const SKIP_WEIGHT = Object.freeze({ player: 0.5, cost: 0.7, manager: 0.4, not_now: 0.8, other: 0.6 });
export const NOT_NOW_DAYS = 7;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Nick says this manager cannot be reached: he is never a step, a flip leg or a target owner. */
export const unreachable = m => m?.nick?.unreachable === true;
/** Excluded from every plan: marked never-trading, or unreachable per Nick. */
export const excluded = m => !!m?.blocked || unreachable(m);

/** Partner order among equal scores: Nick's active pool, then neutral, then deprioritised, then excluded. */
export function nickTier(m) {
  if (excluded(m)) return 3;
  if (m?.nick?.deprioritised) return 2;
  if (m?.nick?.in_active_pool) return 0;
  return 1;
}

/** m: counterparty-layer entry ({ receptiveness, tier }) + { checked_out, blocked, nick }. */
export function pResponds(m) {
  if (unreachable(m)) return { p: 0, basis: 'Nick: unreachable' };
  if (!m) return { p: BASE_RESPONDS * 0.8, basis: 'no manager read; below the neutral anchor' };
  if (m.blocked) return { p: 0, basis: 'marked as never trading' };
  const read = pRespondsRead(m);
  if (m.nick?.deprioritised) {
    return read.p > CHECKED_OUT_RESPONDS
      ? { p: CHECKED_OUT_RESPONDS, basis: `Nick: not trading (capped at ${CHECKED_OUT_RESPONDS}, hand-set; ${read.basis})` }
      : { p: read.p, basis: `Nick: not trading; ${read.basis}` };
  }
  if (m.nick?.in_active_pool && read.p < BASE_RESPONDS) {
    return { p: BASE_RESPONDS, basis: `Nick: active (floored at ${BASE_RESPONDS}, hand-set; ${read.basis})` };
  }
  return m.nick?.in_active_pool ? { p: read.p, basis: `Nick: active; ${read.basis}` } : read;
}

function pRespondsRead(m) {
  if (m.checked_out) return { p: CHECKED_OUT_RESPONDS, basis: 'checked out (no recent activity)' };
  const r = Number.isFinite(m.receptiveness) ? m.receptiveness : 1;
  return { p: clamp(BASE_RESPONDS * r, 0.05, 0.9), basis: `activity read (receptiveness ${r.toFixed(2)})` };
}

const band = (v, hi, lo) => (!Number.isFinite(v) ? UNKNOWN : v >= hi ? 'high' : v >= lo ? 'medium' : 'low');

/**
 * Chat rows -> labels. profile: manager_chat_profile row or null; negotiation: parsed profile or null;
 * sentiment: [{ player, sentiment_mean (0-4, 2 neutral), n }]; nick: the per-roster nick block or null.
 * Nick's block wins over the chat read on every label it speaks to (`overridden` names them).
 */
export function chatLabels({ profile = null, negotiation = null, sentiment = [], nick = null } = {}) {
  return withNick(chatRead({ profile, negotiation, sentiment }), nick);
}

/** Nick's read over the chat labels: open_to_trade, and engagement when he cannot be reached. */
export function withNick(labels, nick) {
  if (!nick || nick.empty) return labels;
  const set = {};
  if (nick.unreachable) Object.assign(set, { open_to_trade: 'none', engagement: 'unreachable' });
  else if (nick.deprioritised) set.open_to_trade = 'low';
  else if (nick.in_active_pool) set.open_to_trade = 'high';
  if (nick.hard) set.difficulty = 'hard';
  const overridden = Object.keys(set).filter(k => labels[k] !== set[k]);
  return { ...labels, ...set, overridden, nick_source: 'nick_override', status: labels.status === UNKNOWN && overridden.length ? 'nick' : labels.status };
}

function chatRead({ profile, negotiation, sentiment }) {
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
  if (!labels || (labels.status !== 'ok' && labels.status !== 'nick')) return null;
  const tilt = { high: 1.15, medium: 1, low: 0.85, none: 0 }[labels.open_to_trade] ?? 1;
  return clamp(pr * tilt, 0, 0.95);
}

/**
 * Rank partners: edge = best expected gain available through him (objective units).
 * managers: Map team -> { ...layer entry, checked_out, blocked, chat, nick }
 * Order: score (P(responds) x edge), then Nick's tier (active pool first, excluded last), then P(responds).
 * An excluded manager stays in the list (so the reason shows) with excluded: true and score 0.
 */
export function rankPartners(managers, edgeByTeam) {
  const out = [];
  for (const [team, m] of managers) {
    const pr = pResponds(m);
    const edge = edgeByTeam.get(String(team)) ?? 0;
    const chat = m.chat ?? chatLabels();
    out.push({ team: String(team), p_responds: pr.p, basis: pr.basis, edge, score: pr.p * Math.max(0, edge),
      chat, shadow_score: (shadowResponds(pr.p, chat) ?? pr.p) * Math.max(0, edge),
      checked_out: !!m.checked_out, blocked: !!m.blocked, excluded: excluded(m), tier: nickTier(m),
      nick: m.nick ? nickSummary(m.nick) : null,
      needs: (Array.isArray(m.needs) ? m.needs : m.needs ? Object.keys(m.needs) : []).map(String), sent_this_week: m.sent_this_week ?? null });
  }
  return out.sort((a, b) => (b.score - a.score) || (a.tier - b.tier) || (b.p_responds - a.p_responds));
}

const nickSummary = n => ({ unreachable: !!n.unreachable, active: !!n.in_active_pool, deprioritised: !!n.deprioritised,
  hard: !!n.hard, source: 'nick_override' });

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
