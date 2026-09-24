/**
 * ONE-COUNTERPART: the one counterpart model per manager, and the ONE producer
 * of the field `people.counterpart` (docs/handoff/local/FIELD-REGISTRY.md).
 * Pure: built from `people.profile` (people/profile-reader.js, the one reader of
 * the chat profiles and of Nick's own read) plus the league's own trade rows.
 * No DB, no env, no clock (the flag read below is the only env read).
 *
 * What each feature may move (PEOPLE-03, 9/23: chat-profile features do not
 * improve P(accept) on league 4's 40 decided offers, log loss -0.146
 * [-0.408, +0.022]; "log them, do not weight them" until EVAL E1 grades one
 * positive):
 *
 *   P(accept)           NO chat feature. stepAdjust never changes it: the
 *                       served yes-probability is the activity/edge price the
 *                       adapter gives, with or without chat labels.
 *   wants_player        he said he wants a player Nick has. Target order and
 *                       partner order (P(responds)) only, from the PEOPLE-LAB
 *                       prior (log-lift 2.0), shrunk by how often he said it
 *                       (n / (n + K)) and decayed by age (full for 7 days,
 *                       linear to zero at 21).
 *   untouchable_talk    he called a player untouchable. Targets only: scaled by
 *                       (1 - credibility), skipped outright when credibility >=
 *                       UNTOUCHABLE_EXCLUDE (face cost).
 *   shop_talk           he said a player is available. Target tilt only, scaled
 *                       by credibility.
 *   credibility         per manager, per kind: his own follow-through on the
 *                       claims in his current profile, Beta(1,1) shrunk; no
 *                       resolved claim -> 0.5, status 'prior'. Targets only.
 *   nick (override)     Nick's own read, through the reader's nick block:
 *                       contactable:false -> never a partner (P(responds) 0, no
 *                       target he owns, blocked in every plan); buyer:false or
 *                       trades 'none' -> P(responds) and his targets halved;
 *                       difficulty hard/difficult/tough -> the price ladder is
 *                       capped at fair on his screen: the opening and the
 *                       walk-away never go above fair (no opening at all when
 *                       nothing at or below fair beats Nick's next-best plan).
 *   reply_prior         M6 prior for a reply: ignore .45 / counter .33 /
 *                       decline .17 / accept .05. The P(responds) anchor is
 *                       1 - ignore; every playbook step carries the table.
 *
 * A manager whose profile is 'unknown' (quiet, invalid, or none) gets no chat
 * feature at all: unknown is not neutral and is never scored. Nick's read and
 * the reply prior still apply to him, since neither comes from his chat.
 *
 * Flag: GRIDIRON_COUNTERPART=1 (the producer's switch, default off), or the
 * local preview switch (preview-mode.js); GRIDIRON_COUNTERPART=0 vetoes preview.
 */
import { previewUnconfirmed, previewFields } from '../preview-mode.js';
import { publicNick, UNKNOWN } from './profile-reader.js';

export const WANTS_PRIOR_LOG_LIFT = 2.0;     // PEOPLE-LAB prior (not refit here)
export const WANTS_SHRINK_K = 4;             // hand-set: n=1 keeps 20%, n=4 keeps 50%
export const WANTS_FULL_DAYS = 7;
export const WANTS_ZERO_DAYS = 21;
export const WANTS_TARGET_TILT = 0.5;        // hand-set: full lift -> x1.5 on target order
export const SHOP_TARGET_TILT = 0.5;         // hand-set
export const SHOP_WINDOW_DAYS = 14;          // hand-set: a shop claim resolves after two weeks
export const UNTOUCHABLE_RESOLVE_DAYS = 21;  // hand-set: an untouchable claim held three weeks counts as kept
export const UNTOUCHABLE_EXCLUDE = 0.5;      // at or above: never ask (the prior 0.5 included)
export const OVERRIDE_DEPRIORITIZE = 0.5;    // hand-set
export const OVERRIDE_TOUGH_CAP_PCT = 0;     // his-screen % the ladder never goes above
export const M6_REPLY_PRIOR = Object.freeze({ ignore: 0.45, counter: 0.33, decline: 0.17, accept: 0.05 });
export const M6_LABEL = 'M6 reply prior (PEOPLE-LAB), league-wide, not fitted per manager';
export const MODEL_VERSION = 'one-counterpart.1';
export const PEOPLE_COUNTERPART_FIELD = 'people.counterpart';
export const P_ACCEPT_CHAT_WEIGHT = 0;       // PEOPLE-03: no chat feature in P(accept) until E1 grades one positive
export const COUNTERPART_ENV = 'GRIDIRON_COUNTERPART';
const PREVIEW_REASON = 'counterpart model (ONE-COUNTERPART) is default-off: chat features unproven for P(accept) (PEOPLE-03)';

/**
 * The model's switch: { on, preview }. GRIDIRON_COUNTERPART=1 turns it on, =0
 * keeps it off even in preview; unset follows the local preview switch.
 */
export function counterpartFlag(env = process.env) {
  if (env[COUNTERPART_ENV] === '1') return { on: true, preview: false };
  if (env[COUNTERPART_ENV] === '0') return { on: false, preview: false };
  return previewUnconfirmed() ? { on: true, preview: true, ...previewFields(PREVIEW_REASON) } : { on: false, preview: false };
}

const DAY = 864e5;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const logit = p => Math.log(p / (1 - p));
const sigmoid = z => 1 / (1 + Math.exp(-z));

const toMs = v => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
  const t = Date.parse(/\dT\d|Z$|[+-]\d\d:?\d\d$/.test(String(v)) ? String(v) : `${String(v).replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : null;
};

/** One player mention in a read profile: a string or { player|name, at|date|last_at, n|count|mentions }. */
export function normaliseMention(x, fallbackAt = null) {
  if (typeof x === 'string') return x.trim() ? { player: x.trim(), at: fallbackAt, n: 1, dated: false } : null;
  if (!x || typeof x !== 'object') return null;
  const player = String(x.player ?? x.name ?? '').trim();
  if (!player) return null;
  const at = toMs(x.at ?? x.date ?? x.last_at ?? x.last_seen);
  const n = Number(x.n ?? x.count ?? x.mentions);
  return { player, at: at ?? fallbackAt, n: Number.isFinite(n) && n > 0 ? n : 1, dated: at != null };
}
const mentions = (list, at) => (Array.isArray(list) ? list.map(x => normaliseMention(x, at)).filter(Boolean) : []);
const VALUES_TALK_KEYS = ['talks_up', 'talks_down', 'untouchable', 'wants', 'shopping'];

/**
 * A people.profile entry's `profile` (already read and normalised by the
 * reader) -> { status, talks_up, talks_down, untouchable, wants, shopping }.
 * roster_read (the 9/18 shape) fills untouchable / shopping when values_talk
 * lacks them, so both profile generations answer the same questions.
 */
export function valuesTalk(profile, builtAt) {
  const vt = profile?.values_talk && typeof profile.values_talk === 'object' ? profile.values_talk : null;
  const rr = profile?.roster_read;
  if (!vt && !rr) return { status: UNKNOWN, reason: 'profile has neither values_talk nor roster_read' };
  const out = { status: 'ok', source: vt ? 'values_talk' : 'roster_read' };
  for (const k of VALUES_TALK_KEYS) out[k] = mentions(vt?.[k], builtAt);
  if (!vt?.untouchable) out.untouchable = mentions(rr?.really_untouchable, builtAt);
  if (!vt?.shopping) out.shopping = mentions(rr?.quietly_available, builtAt);
  return out;
}

const NO_OVERRIDE = Object.freeze({ status: 'none', exclude: false, deprioritize: false, toughen: false, basis: 'no read from Nick', nick: null });

/** The reader's nick block -> what the model does with it (see the header). */
export function overrideFrom(nick) {
  if (!nick || nick.empty) return { ...NO_OVERRIDE };
  const from = [...new Set(Object.values(nick.sources ?? {}))];
  const basis = `Nick's read (${from.length ? from.join(' + ') : 'notes only'})`;
  return { status: 'ok', exclude: !!nick.unreachable, deprioritize: !!nick.deprioritised, toughen: !!nick.hard,
    basis: nick.unreachable ? `${basis}: not contactable` : basis, nick: publicNick(nick) };
}

export function wantsDecay(ageDays) {
  if (!Number.isFinite(ageDays)) return 0;
  if (ageDays <= WANTS_FULL_DAYS) return 1;
  if (ageDays >= WANTS_ZERO_DAYS) return 0;
  return (WANTS_ZERO_DAYS - ageDays) / (WANTS_ZERO_DAYS - WANTS_FULL_DAYS);
}

export function wantsLift(n, ageDays) {
  const shrink = n / (n + WANTS_SHRINK_K);
  const decay = wantsDecay(ageDays);
  return { lift: WANTS_PRIOR_LOG_LIFT * shrink * decay, shrink, decay };
}

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ').replace(/\s+/g, ' ').trim();

/** players: Map id -> { name } -> resolve(name) -> id or null (exact normalised full name, unique only). */
export function nameResolver(players) {
  const idx = new Map();
  for (const [id, p] of players) {
    const k = norm(p?.name);
    if (!k) continue;
    idx.set(k, idx.has(k) ? null : id);
  }
  return name => idx.get(norm(name)) ?? null;
}

/**
 * Trade rows -> events. rows: league_transactions_raw { type, status, execution_type, items_json,
 * proposed_at, processed_at }. An executed trade is TRADE_ACCEPT / PROCESS / EXECUTED (the row that
 * carries the items, see manager-signals.js#completedTrades); a proposal is TRADE_PROPOSAL.
 */
export function tradeEvents(rows, toMs) {
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const executed = r.type === 'TRADE_ACCEPT' && r.execution_type === 'PROCESS' && r.status === 'EXECUTED';
    const proposed = r.type === 'TRADE_PROPOSAL';
    if (!executed && !proposed) continue;
    let items;
    try { items = JSON.parse(r.items_json || '[]'); } catch (e) { throw new Error(`tx ${r.tx_id}: items_json is not JSON (${e.message})`); }
    const at = toMs(r.processed_at) ?? toMs(r.proposed_at);
    if (at == null) continue;
    for (const i of items) {
      if (i.playerId == null || !(Number(i.fromTeamId) > 0)) continue;
      const kind = executed ? 'executed' : 'proposed';
      const k = `${r.tx_id}|${kind}|${i.playerId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ at, player: String(i.playerId), from_team: String(i.fromTeamId), kind });
    }
  }
  return out;
}

/**
 * Follow-through on his own claims. claims: [{ player (id), at }] for one kind; events for the league.
 * untouchable: kept = not traded away within UNTOUCHABLE_RESOLVE_DAYS (and the window has passed);
 *              broken = traded away after the claim.
 * shop:        followed = he proposed or traded the player within SHOP_WINDOW_DAYS;
 *              unfollowed = the window passed with neither.
 */
export function credibility(kind, team, claims, events, now) {
  let kept = 0, broken = 0, open = 0;
  for (const c of claims) {
    const after = events.filter(e => e.player === String(c.player) && e.from_team === String(team) && e.at > c.at);
    if (kind === 'untouchable') {
      if (after.some(e => e.kind === 'executed')) broken++;
      else if (now - c.at >= UNTOUCHABLE_RESOLVE_DAYS * DAY) kept++;
      else open++;
    } else {
      if (after.some(e => e.at <= c.at + SHOP_WINDOW_DAYS * DAY)) kept++;
      else if (now - c.at >= SHOP_WINDOW_DAYS * DAY) broken++;
      else open++;
    }
  }
  const n = kept + broken;
  return { value: (kept + 1) / (n + 2), n, kept, broken, open, status: n ? 'follow_through' : 'prior',
    basis: `Beta(1,1) on ${n} resolved ${kind} claim${n === 1 ? '' : 's'} (${open} still open)` };
}

/**
 * profiles: Map roster -> people.profile entry (profile-reader.js#peopleProfile*: { status, reason,
 * profile, built_at, nick }); players Map id -> { name }; events: tradeEvents(...).
 * Returns Map team -> counterpart model. Every team in `teams` gets one, typed unknown without a read.
 */
export function buildCounterparts({ profiles, players, events = [], now, teams = [] }) {
  const resolve = nameResolver(players);
  const out = new Map();
  const all = new Map([...(profiles ?? new Map())].map(([k, v]) => [String(k), v]));
  for (const t of teams) if (!all.has(String(t))) all.set(String(t), { status: UNKNOWN, reason: 'no confirmed chat identity', profile: null, nick: null });
  for (const [team, entry] of all) {
    let unresolved = 0;
    const idOf = m => { const id = resolve(m.player); if (id == null) unresolved++; return id; };
    const builtAt = toMs(entry.built_at);
    const vt = entry.status === 'ok' ? valuesTalk(entry.profile, builtAt) : null;
    const known = vt?.status === 'ok';
    const model = { team: String(team), version: MODEL_VERSION, as_of: now, profile_built_at: builtAt,
      status: known ? 'ok' : UNKNOWN,
      reason: known ? null : (vt?.reason ?? entry.reason ?? 'no profile'),
      wants: new Map(), untouchable: new Map(), shopping: new Map(),
      credibility: { untouchable: null, shop: null },
      override: overrideFrom(entry.nick),
      reply_prior: { ...M6_REPLY_PRIOR, label: M6_LABEL } };
    if (known) {
      for (const m of vt.wants) {
        const id = idOf(m);
        if (id == null) continue;
        const age = (now - (m.at ?? now)) / DAY;
        const w = wantsLift(m.n, age);
        const prev = model.wants.get(id);
        if (w.lift > 0 && (!prev || w.lift > prev.lift)) model.wants.set(id, { player: id, n: m.n, age_days: age, dated: m.dated, ...w });
      }
      // Credibility from the claims in his current profile (earliest dated claim per player), graded forward only.
      const claimsOf = list => {
        const first = new Map();
        for (const m of list) {
          const id = resolve(m.player);
          if (id == null || m.at == null) continue;
          if (!first.has(id) || m.at < first.get(id).at) first.set(id, { player: id, at: m.at });
        }
        return [...first.values()];
      };
      model.credibility.untouchable = credibility('untouchable', team, claimsOf(vt.untouchable), events, now);
      model.credibility.shop = credibility('shop', team, claimsOf(vt.shopping), events, now);
      for (const m of vt.untouchable) { const id = idOf(m); if (id != null) model.untouchable.set(id, { player: id }); }
      for (const m of vt.shopping) { const id = idOf(m); if (id != null) model.shopping.set(id, { player: id }); }
    }
    model.unresolved_names = unresolved;
    out.set(String(team), model);
  }
  return out;
}

/** people.profile (the reader's result) -> counterpart models. An unavailable read types every team unknown. */
export function counterpartsFromPeople(people, { players, events = [], now, teams = [] }) {
  const profiles = people?.available ? people.byRoster : new Map();
  return buildCounterparts({ profiles, players, events, now, teams });
}

const feat = (feature, team, extra) => ({ feature, team: String(team), fitted: false, ...extra });

/**
 * Per-step adjustment of P(accept): none. PEOPLE-03 found the chat features do
 * not help P(yes), so no chat label (wants, shop, untouchable, credibility)
 * moves it; wants / untouchable / shop act on targets and partner order only.
 * Kept as the one seam where a feature enters once EVAL E1 grades it positive.
 */
export function stepAdjust(_cp, _step) {
  return { lift: 0, mult: 1, features: [] };
}

export function adjustP(p, { lift, mult }) {
  if (lift === 0 && mult === 1) return p;
  if (!(p > 0)) return 0;
  if (p >= 1) return clamp(mult, 0, 1);
  return clamp(sigmoid(logit(p) + lift) * mult, 0, 1);
}

/** The adapter the planner sees with the counterpart model on: P(accept) unchanged, unreachable partners blocked. */
export function withCounterparts(adapter, cps) {
  const managers = new Map([...adapter.managers].map(([t, m]) => {
    const o = cps.get(String(t))?.override;
    return [t, o?.exclude ? { ...m, blocked: true, blocked_by: 'nick_override' } : m];
  }));
  const priceStep = (team, theyGive, theyGet) => {
    const base = adapter.priceStep(team, theyGive, theyGet);
    const adj = stepAdjust(cps.get(String(team)), { team, get: theyGive, give: theyGet });
    return { ...base, p: adjustP(base.p, adj), p_before_counterpart: base.p, features: adj.features };
  };
  return { ...adapter, managers, priceStep, counterparts: cps };
}

/** Target order tilt for player pid owned by `owner`; myIds = Nick's roster. */
export function targetTilt(cps, owner, pid, myIds) {
  const cp = cps?.get(String(owner));
  const features = [];
  if (!cp) return { tilt: 1, exclude: false, features };
  if (cp.override?.exclude) {
    return { tilt: 0, exclude: true, features: [feat('nick_override', owner, { effect: 'exclude', value: 0, basis: cp.override.basis })] };
  }
  let tilt = 1;
  if (cp.override?.deprioritize) {
    tilt *= OVERRIDE_DEPRIORITIZE;
    features.push(feat('nick_override', owner, { effect: 'multiplier', value: OVERRIDE_DEPRIORITIZE, basis: cp.override.basis }));
  }
  if (cp.status === 'ok') {
    const has = (map, id) => map.has(id) || map.has(String(id)) || map.has(Number(id));
    if (has(cp.untouchable, pid)) {
      const c = cp.credibility.untouchable;
      if (c.value >= UNTOUCHABLE_EXCLUDE) {
        return { tilt: 0, exclude: true, features: [...features, feat('untouchable_talk', owner, { player: String(pid), effect: 'exclude', value: 0, n: c.n,
          basis: `credibility ${c.value.toFixed(2)} >= ${UNTOUCHABLE_EXCLUDE}: never ask (${c.basis})` })] };
      }
      tilt *= 1 - c.value;
      features.push(feat('untouchable_talk', owner, { player: String(pid), effect: 'multiplier', value: 1 - c.value, n: c.n, basis: c.basis }));
    } else if (has(cp.shopping, pid)) {
      const c = cp.credibility.shop;
      tilt *= 1 + SHOP_TARGET_TILT * c.value;
      features.push(feat('shop_talk', owner, { player: String(pid), effect: 'multiplier', value: 1 + SHOP_TARGET_TILT * c.value, n: c.n, basis: c.basis }));
    }
    const w = myIds.map(id => cp.wants.get(id) ?? cp.wants.get(String(id))).filter(Boolean).sort((a, b) => b.lift - a.lift)[0];
    if (w) {
      const m = 1 + WANTS_TARGET_TILT * (w.lift / WANTS_PRIOR_LOG_LIFT);
      tilt *= m;
      features.push(feat('wants_player', owner, { player: String(w.player), effect: 'multiplier', value: m, n: w.n,
        basis: `he wants a player you have (lift ${w.lift.toFixed(2)} of ${WANTS_PRIOR_LOG_LIFT})` }));
    }
  }
  return { tilt, exclude: false, features };
}

/** P(responds) with the counterpart model: M6 anchor, override, wants lift. pr: partners.js#pResponds result. */
export function respondsAdjust(pr, cp, myIds, { baseAnchor }) {
  const features = [];
  if (!cp) return { p: pr.p, features };
  let p = pr.p;
  if (pr.p > 0 && !/checked out|never trading/.test(pr.basis)) {
    const anchor = 1 - M6_REPLY_PRIOR.ignore;
    p = clamp(pr.p * (anchor / baseAnchor), 0, 0.95);
    features.push(feat('reply_prior', cp.team, { effect: 'anchor', value: anchor, basis: `${M6_LABEL}: P(responds) anchor 1 - ignore` }));
  }
  if (cp.override?.exclude) {
    return { p: 0, features: [...features, feat('nick_override', cp.team, { effect: 'exclude', value: 0, basis: cp.override.basis })] };
  }
  if (cp.override?.deprioritize) {
    p *= OVERRIDE_DEPRIORITIZE;
    features.push(feat('nick_override', cp.team, { effect: 'multiplier', value: OVERRIDE_DEPRIORITIZE, basis: cp.override.basis }));
  }
  if (cp.status === 'ok' && p > 0 && p < 1) {
    const w = myIds.map(id => cp.wants.get(id) ?? cp.wants.get(String(id))).filter(Boolean).sort((a, b) => b.lift - a.lift)[0];
    if (w) {
      p = clamp(sigmoid(logit(p) + w.lift), 0, 0.95);
      features.push(feat('wants_player', cp.team, { player: String(w.player), effect: 'log_odds', value: w.lift, n: w.n,
        basis: 'he wants a player you have' }));
    }
  }
  return { p, features };
}

/** The his-screen cap the price ladder respects for him, or null. */
export function priceCap(cp) {
  return cp?.override?.toughen ? { max_his_pct: OVERRIDE_TOUGH_CAP_PCT,
    feature: feat('nick_override', cp.team, { effect: 'price_cap', value: OVERRIDE_TOUGH_CAP_PCT,
      basis: `${cp.override.basis}: never above fair on his screen` }) } : null;
}

/** A JSON-safe summary of one model (Maps -> arrays) for the plans file. No names, no note text. */
export function publicModel(cp) {
  return { team: cp.team, version: cp.version, status: cp.status, reason: cp.reason,
    wants: [...cp.wants.values()].map(w => ({ player: String(w.player), n: w.n, lift: w.lift })),
    untouchable: [...cp.untouchable.keys()].map(String), shopping: [...cp.shopping.keys()].map(String),
    credibility: cp.credibility, override: { status: cp.override.status, exclude: !!cp.override.exclude,
      deprioritize: !!cp.override.deprioritize, toughen: !!cp.override.toughen, basis: cp.override.basis ?? null,
      nick: cp.override.nick ?? null },
    p_accept_chat_weight: P_ACCEPT_CHAT_WEIGHT,
    reply_prior: cp.reply_prior, unresolved_names: cp.unresolved_names ?? 0 };
}

/**
 * people.counterpart for one league: the published field (FIELD-REGISTRY.md), one model per
 * counterparty, JSON-safe. `people` is the reader's people.profile it was built from.
 */
export function peopleCounterpart(cps, { leagueId = null, asOf = null, people = null, flag = null } = {}) {
  const models = [...cps.values()].map(publicModel);
  return {
    field: PEOPLE_COUNTERPART_FIELD, source: 'server/services/people/counterpart.js', version: MODEL_VERSION,
    league_id: leagueId, as_of: asOf,
    inputs: { profile: people?.field ?? null, profile_version: people?.version ?? null, profile_available: people?.available ?? false,
      profile_reason: people?.reason ?? null, notes_reason: people?.notes_reason ?? null },
    p_accept: { chat_weight: P_ACCEPT_CHAT_WEIGHT, basis: 'PEOPLE-03: chat features do not improve P(accept) on league 4 (40 offers); graded by EVAL E1 before any weight' },
    ...(flag?.preview ? previewFields(PREVIEW_REASON) : {}),
    counts: { managers: models.length, known: models.filter(m => m.status === 'ok').length,
      nick_read: models.filter(m => m.override.status === 'ok').length,
      unreachable: models.filter(m => m.override.exclude).length },
    models,
  };
}
