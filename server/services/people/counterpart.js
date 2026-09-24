/**
 * COUNTERPART-01: the counterpart model the campaign producer uses per manager
 * (PEOPLE-WIRING.md, CAMPAIGN-PEOPLE). Pure: built from the PEOPLE-01 profile
 * reader's entries plus the league's own trade rows, no DB, no env, no clock.
 *
 * Features (each one is named in the reason chain, with its basis and n; none
 * is fitted here, every constant is a prior or hand-set and says so):
 *
 *   wants_player        he said he wants a player Nick has. Log-odds lift on
 *                       P(accept) for a step that gives him that player, from
 *                       the PEOPLE-LAB prior (log-lift 2.0), shrunk by how
 *                       often he said it (n / (n + K)) and decayed by age
 *                       (full for 7 days, linear to zero at 21). Also tilts
 *                       target order toward his players and P(responds) up.
 *   untouchable_talk    he called a player untouchable. The ask is scaled by
 *                       (1 - credibility) and the target is skipped outright
 *                       when credibility >= UNTOUCHABLE_EXCLUDE (face cost).
 *   shop_talk           he said a player is available. Log-odds lift on the
 *                       step that asks for him, and a target tilt, both scaled
 *                       by credibility.
 *   credibility         per manager, per kind: his own follow-through on past
 *                       claims (an untouchable he later traded away is a broken
 *                       claim; a shopped player he never proposed or traded in
 *                       SHOP_WINDOW_DAYS is an unfollowed one), Beta(1,1)
 *                       shrunk. No resolved claims -> 0.5, status 'prior'.
 *   nick_override       Nick's note: exclude drops him as a partner (never in a
 *                       plan), deprioritize halves P(responds) and his targets'
 *                       order, toughen caps the price ladder at fair on his
 *                       screen.
 *   reply_prior         M6 prior for a reply: ignore .45 / counter .33 /
 *                       decline .17 / accept .05. The P(responds) anchor is
 *                       1 - ignore; every playbook step carries the table.
 *
 * A manager whose profile is 'unknown' (quiet, or no profile) gets no chat
 * feature at all: unknown is not neutral and is never scored. The override
 * and reply prior still apply to him, since neither comes from his chat.
 */

export const WANTS_PRIOR_LOG_LIFT = 2.0;     // PEOPLE-LAB prior (not refit here)
export const WANTS_SHRINK_K = 4;             // hand-set: n=1 keeps 20%, n=4 keeps 50%
export const WANTS_FULL_DAYS = 7;
export const WANTS_ZERO_DAYS = 21;
export const WANTS_TARGET_TILT = 0.5;        // hand-set: full lift -> x1.5 on target order
export const SHOP_LOG_LIFT = 0.5;            // hand-set
export const SHOP_TARGET_TILT = 0.5;         // hand-set
export const SHOP_WINDOW_DAYS = 14;          // hand-set: a shop claim resolves after two weeks
export const UNTOUCHABLE_RESOLVE_DAYS = 21;  // hand-set: an untouchable claim held three weeks counts as kept
export const UNTOUCHABLE_EXCLUDE = 0.5;      // at or above: never ask (the prior 0.5 included)
export const OVERRIDE_DEPRIORITIZE = 0.5;    // hand-set
export const OVERRIDE_TOUGH_CAP_PCT = 0;     // his-screen % the ladder never goes above
export const M6_REPLY_PRIOR = Object.freeze({ ignore: 0.45, counter: 0.33, decline: 0.17, accept: 0.05 });
export const M6_LABEL = 'M6 reply prior (PEOPLE-LAB), league-wide, not fitted per manager';
export const MODEL_VERSION = 'counterpart-01.1';

const DAY = 864e5;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const logit = p => Math.log(p / (1 - p));
const sigmoid = z => 1 / (1 + Math.exp(-z));

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
 * profiles: readProfiles(...).byRoster; players Map id -> { name }; events: tradeEvents(...).
 * Returns Map team -> counterpart model.
 */
export function buildCounterparts({ profiles, players, events = [], now, teams = [] }) {
  const resolve = nameResolver(players);
  const out = new Map();
  // Every counterparty gets a model (the reply prior and typed absence apply to all), chat or not.
  const all = new Map(profiles);
  for (const t of teams) if (!all.has(String(t))) all.set(String(t), { status: 'unknown', reason: 'no confirmed chat identity',
    negotiation: { status: 'unknown', reason: 'no confirmed chat identity' }, override: { status: 'unknown', reason: 'no confirmed chat identity' } });
  for (const [team, pr] of all) {
    let unresolved = 0;
    const idOf = m => { const id = resolve(m.player); if (id == null) unresolved++; return id; };
    const vt = pr.negotiation?.status === 'ok' ? pr.negotiation.values_talk : null;
    const model = { team: String(team), version: MODEL_VERSION, as_of: pr.as_of ?? now,
      status: vt?.status === 'ok' ? 'ok' : 'unknown',
      reason: vt?.status === 'ok' ? null : (pr.negotiation?.reason ?? pr.reason ?? 'no profile'),
      wants: new Map(), untouchable: new Map(), shopping: new Map(),
      credibility: { untouchable: null, shop: null },
      override: pr.override ?? { status: 'unknown', exclude: false, deprioritize: false, toughen: false },
      reply_prior: { ...M6_REPLY_PRIOR, label: M6_LABEL } };
    if (vt?.status === 'ok') {
      for (const m of vt.wants) {
        const id = idOf(m);
        if (id == null) continue;
        const age = (now - (m.at ?? now)) / DAY;
        const w = wantsLift(m.n, age);
        const prev = model.wants.get(id);
        if (w.lift > 0 && (!prev || w.lift > prev.lift)) model.wants.set(id, { player: id, n: m.n, age_days: age, dated: m.dated, ...w });
      }
      // Credibility from every visible version's claims (earliest claim per player), graded forward only.
      const claimsOf = key => {
        const first = new Map();
        for (const h of pr.history ?? []) for (const m of h[key] ?? []) {
          const id = resolve(m.player);
          if (id == null || m.at == null) continue;
          if (!first.has(id) || m.at < first.get(id).at) first.set(id, { player: id, at: m.at });
        }
        return [...first.values()];
      };
      model.credibility.untouchable = credibility('untouchable', team, claimsOf('untouchable'), events, now);
      model.credibility.shop = credibility('shop', team, claimsOf('shopping'), events, now);
      for (const m of vt.untouchable) { const id = idOf(m); if (id != null) model.untouchable.set(id, { player: id }); }
      for (const m of vt.shopping) { const id = idOf(m); if (id != null) model.shopping.set(id, { player: id }); }
    }
    model.unresolved_names = unresolved;
    out.set(String(team), model);
  }
  return out;
}

const feat = (feature, team, extra) => ({ feature, team: String(team), fitted: false, ...extra });

/** Per-step adjustment: he gives `get` (Nick gets), he receives `give` (Nick gives). */
export function stepAdjust(cp, { team, get, give }) {
  const features = [];
  if (!cp) return { lift: 0, mult: 1, features };
  let lift = 0, mult = 1;
  if (cp.status === 'ok') {
    const w = give.map(id => cp.wants.get(id) ?? cp.wants.get(String(id)) ?? cp.wants.get(Number(id))).filter(Boolean)
      .sort((a, b) => b.lift - a.lift)[0];
    if (w) {
      lift += w.lift;
      features.push(feat('wants_player', team, { player: String(w.player), effect: 'log_odds', value: w.lift, n: w.n,
        basis: `prior log-lift ${WANTS_PRIOR_LOG_LIFT} x shrink ${w.shrink.toFixed(2)} x decay ${w.decay.toFixed(2)} (${w.age_days.toFixed(0)} d${w.dated ? '' : ', dated by profile build'})` }));
    }
    const has = (map, id) => map.has(id) || map.has(String(id)) || map.has(Number(id));
    for (const id of get) {
      if (has(cp.untouchable, id)) {
        const c = cp.credibility.untouchable;
        const never = c.value >= UNTOUCHABLE_EXCLUDE;
        mult *= never ? 0 : 1 - c.value;
        features.push(feat('untouchable_talk', team, { player: String(id), effect: never ? 'exclude' : 'multiplier',
          value: never ? 0 : 1 - c.value, n: c.n,
          basis: `he called him untouchable; credibility ${c.value.toFixed(2)}${never ? ` >= ${UNTOUCHABLE_EXCLUDE}: never ask` : ''} (${c.basis})` }));
      } else if (has(cp.shopping, id)) {
        const c = cp.credibility.shop;
        lift += SHOP_LOG_LIFT * c.value;
        features.push(feat('shop_talk', team, { player: String(id), effect: 'log_odds', value: SHOP_LOG_LIFT * c.value, n: c.n,
          basis: `he said he is available; credibility ${c.value.toFixed(2)} (${c.basis})` }));
      }
    }
  }
  return { lift, mult, features };
}

export function adjustP(p, { lift, mult }) {
  if (!(p > 0)) return 0;
  if (p >= 1) return clamp(mult, 0, 1);
  return clamp(sigmoid(logit(p) + lift) * mult, 0, 1);
}

/** The adapter the planner sees with the counterpart model on: priceStep adjusted, excluded partners blocked. */
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

/** A JSON-safe summary of one model (Maps -> arrays) for the plans file. */
export function publicModel(cp) {
  return { team: cp.team, version: cp.version, status: cp.status, reason: cp.reason,
    wants: [...cp.wants.values()].map(w => ({ player: String(w.player), n: w.n, lift: w.lift })),
    untouchable: [...cp.untouchable.keys()].map(String), shopping: [...cp.shopping.keys()].map(String),
    credibility: cp.credibility, override: { status: cp.override.status, exclude: !!cp.override.exclude,
      deprioritize: !!cp.override.deprioritize, toughen: !!cp.override.toughen, basis: cp.override.basis ?? null },
    reply_prior: cp.reply_prior, unresolved_names: cp.unresolved_names ?? 0 };
}
