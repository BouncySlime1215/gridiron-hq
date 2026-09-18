/**
 * Pricing a trade the way the OTHER manager sees it.
 *
 * The trade engine has always valued both sides with our number. That is the
 * right way to answer "is this good for me" and the wrong way to answer "will
 * he say yes", which is the question that decides whether a suggestion is worth
 * anything. A deal we price as a steal is not a steal if nobody accepts it, and
 * a deal we price as even is a gift if he thinks he won.
 *
 * So this module answers two separate questions and keeps them separate:
 *
 *   perception  - what is this package worth TO HIM, given what he has said
 *                 about these specific players and how he behaves generally
 *   receptiveness - how likely is this person to engage with a trade at all
 *
 * Both are bounded on purpose. Chat sentiment is weak evidence: a few texts
 * must be able to break a tie, never to overturn a valuation. The caps below
 * are the contract that keeps a chatty manager from dominating the ranking.
 */
import { rows } from '../db/index.js';
import { managerSignalsFor, openChatDb, chatDataKey } from './manager-signals.js';
import { identityMap } from './manager-identity.js';
import { talkReads } from './talk-vs-model.js';
import { declarationCredibility, untouchableStance } from './bluff-detector.js';

/** Hard ceiling on how far chat can move a package's perceived value. */
export const PERCEPTION_CAP = 0.15;
/** Receptiveness multiplier range. 1.0 is "no information". */
export const RECEPTIVENESS_RANGE = [0.7, 1.3];

/** Percentile of x within xs, in [0,1]; 0.5 when xs carries no information. */
function percentile(xs, x) {
  const vals = xs.filter(Number.isFinite);
  if (vals.length < 3 || !Number.isFinite(x)) return 0.5;
  const spread = Math.max(...vals) - Math.min(...vals);
  if (spread <= 0) return 0.5;
  return vals.filter(v => v < x).length / (vals.length - 1);
}

/**
 * Per-league counterparty layer, built once per findTrades call.
 *
 * Absolute chat rates are compressed (open-to-trade runs 0.13-0.34 across a
 * whole league), so receptiveness is computed from each manager's RANK inside
 * his own league rather than the raw number. Ranking is what the finder needs
 * anyway: it is choosing between these ten people, not against an abstract
 * baseline.
 */
export function counterpartyLayer(leagueId, { season, week } = {}) {
  const signals = managerSignalsFor(leagueId);
  // Talk crossed with the model, and whether this person's word has held. Both
  // are loaded once for the league: the first decides the SIGN of a sentiment
  // adjustment, the second decides whether a refusal is real.
  const reads = talkReads(leagueId, season, week);
  // Declarations live in the chat, so a league with no trusted chat identity
  // has none to weigh — and no reason to open the private chat DB at all.
  const credibility = identityMap(leagueId).size ? declarationCredibility() : null;
  const tiers = new Map(rows('SELECT roster_id, tradeability FROM manager_profiles WHERE league_id = ?', leagueId)
    .map(r => [String(r.roster_id), r.tradeability]));

  const ids = [...signals.keys()];
  const openVals = ids.map(id => signals.get(id).metrics.chat_open_to_trade);
  const talkVals = ids.map(id => signals.get(id).metrics.chat_trade_talk);

  const profile = new Map();
  for (const id of ids) {
    const s = signals.get(id);
    const m = s.metrics;
    const msgs = m.chat_msgs ?? 0;
    // Someone with 40 messages has not told us much. Shrink the whole chat
    // contribution toward "no information" until there is a real corpus.
    const chatWeight = Math.min(1, msgs / 300);
    const openP = percentile(openVals, m.chat_open_to_trade);
    const talkP = percentile(talkVals, m.chat_trade_talk);
    let score = 0.5 + chatWeight * (0.65 * (openP - 0.5) + 0.35 * (talkP - 0.5));

    // Observed behaviour outranks talk. Only applied once there are enough
    // decided proposals for the rate to mean anything (the metric is withheld
    // below five by manager-signals.js, so its presence is itself the gate).
    if (Number.isFinite(m.tx_accept_rate)) {
      const w = Math.min(1, (s.samples.tx_accept_rate ?? 0) / 15);
      score = score * (1 - w) + m.tx_accept_rate * w;
    }
    // Nick's reads enter as a small nudge, never as a verdict.
    if (m.prior_disengaged) score -= 0.10 * m.prior_disengaged;
    if (m.prior_quiet) score -= 0.05 * m.prior_quiet;
    if (m.prior_seller) score += 0.08 * m.prior_seller;

    const [lo, hi] = RECEPTIVENESS_RANGE;
    const receptiveness = lo + (hi - lo) * Math.max(0, Math.min(1, score));
    // The hand-set tier is reported, not applied: trade-engine.js applies the
    // 0.55 "hard" factor to every deal, with or without this layer, and
    // applying it here as well discounted a hard manager to 0.30.
    const tier = tiers.get(id) ?? 'fair';

    profile.set(id, {
      roster_id: id, receptiveness: +receptiveness.toFixed(3), tier,
      chat_msgs: msgs, chat_weight: +chatWeight.toFixed(2),
      open_to_trade_pct: +openP.toFixed(2), trade_talk_pct: +talkP.toFixed(2),
      accept_rate: m.tx_accept_rate ?? null, accept_rate_n: s.samples.tx_accept_rate ?? 0,
      players: s.players ?? new Map(),
      reads: reads.get(id) ?? new Map(),
      stance: untouchableStance(leagueId, id, credibility),
      priors: Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith('prior_'))),
      untouchable_rate: m.chat_own_untouchable ?? null,
    });
  }
  return profile;
}

/**
 * What one package is worth to a given manager, relative to our valuation.
 *
 * Returns a multiplier and the reasons behind it, because an unexplained
 * multiplier is not usable in an explanation and would be the first thing to
 * silently rot. `sentimentMultiplier` already discounts small samples; the cap
 * here bounds the package as a whole so a three-player package cannot stack
 * three sentiment terms into a 40% swing.
 */
export function perceivedValue(players, managerProfile) {
  const total = players.reduce((s, p) => s + (p.value ?? 0), 0);
  // Either source is enough on its own: a talk-vs-model read can exist for a
  // player nobody has a raw sentiment row for, and vice versa.
  if (total <= 0 || (!managerProfile?.players?.size && !managerProfile?.reads?.size)) {
    return { value: total, multiplier: 1, reasons: [] };
  }
  let adjusted = 0;
  const reasons = [];
  for (const p of players) {
    const key = String(p.name ?? '').toLowerCase();
    const view = managerProfile.players.get(key);
    // The talk-vs-model read wins wherever it exists, because raw sentiment has
    // the wrong SIGN for the one case that costs real money: a manager talking
    // up a player he is quietly shopping. Sentiment alone reads that as
    // attachment and charges us a premium for exactly the guy he wants gone.
    const read = managerProfile.reads?.get(key) ?? null;
    const mult = read?.multiplier ?? view?.multiplier ?? 1;
    adjusted += (p.value ?? 0) * mult;
    if (Math.abs(mult - 1) >= 0.02) {
      reasons.push({
        player: p.name, sentiment: view?.sentiment ?? read?.sentiment,
        mentions: view?.n ?? read?.mentions, last_mention: view?.last,
        multiplier: +mult.toFixed(3),
        verdict: read?.verdict ?? null,
        reading: read?.why ?? (view?.sentiment > 2.2 ? 'he rates him'
          : view?.sentiment < 1.8 ? 'he is down on him' : 'neutral'),
      });
    }
  }
  const raw = total > 0 ? adjusted / total : 1;
  const capped = Math.max(1 - PERCEPTION_CAP, Math.min(1 + PERCEPTION_CAP, raw));
  return { value: +(total * capped).toFixed(2), multiplier: +capped.toFixed(3), reasons };
}

/**
 * The counterparty read on one proposed deal.
 *
 * `perception_delta` is the number that matters: how much better the package he
 * receives looks to him than the one he gives up, as a percentage of what he is
 * giving. Positive means it reads as a win from his side of the table — which
 * is the precondition for acceptance, independent of whether it is good for us.
 *
 * It is null when nothing we know about him moves the price of any player in
 * the deal. His "perception" is then just our own value gap, which the trade
 * engine already prices through its capped fairness term and its value cost;
 * returning it anyway let the ±10% perception factor pay a second time for
 * handing him value — for every manager with no chat read, which after the
 * all-league build is every manager in four of the five leagues.
 * `perception_shift` is the part his views add beyond our own gap, in the same
 * units: the tie-breaker the perception factor was written to be.
 */
export function readDeal({ theirGive, theirGet, managerProfile }) {
  const give = perceivedValue(theirGive, managerProfile);
  const get = perceivedValue(theirGet, managerProfile);
  const base = give.value || 1;
  const delta = (get.value - give.value) / base;
  const sum = list => list.reduce((s, p) => s + (p.value ?? 0), 0);
  const ourDelta = (sum(theirGet) - sum(theirGive)) / (sum(theirGive) || 1);
  const informed = give.reasons.length > 0 || get.reasons.length > 0;
  return {
    receptiveness: managerProfile?.receptiveness ?? 1,
    their_perceived_give: give.value, their_perceived_get: get.value,
    perception_informed: informed,
    perception_delta: informed ? +(delta * 100).toFixed(1) : null,
    perception_shift: informed ? +((delta - ourDelta) * 100).toFixed(1) : null,
    perception_reasons: [...give.reasons.map(r => ({ ...r, side: 'they_give' })),
      ...get.reasons.map(r => ({ ...r, side: 'they_get' }))],
    chat_msgs: managerProfile?.chat_msgs ?? 0,
    accept_rate: managerProfile?.accept_rate ?? null,
    word_credibility: managerProfile?.stance?.credibility?.credibility ?? null,
    word_note: managerProfile?.stance?.note ?? null,
  };
}

// untouchablesFor lived here until 2026-09-18. It had no caller: declared
// untouchables are decided by bluff-detector.js#untouchableStance, which reads
// the same rows and also weighs whether the manager's word has held.

/**
 * Signature of every counterparty input for one league, for a cache
 * fingerprint (the findTrades cache left these out, so a rebuild served stale
 * rankings). Stable across an idle rebuild — the builders only write when
 * something changed — and different after any real change: signals and player
 * views (one stamp, see buildManagerSignals), identities, hand-set tiers, and
 * for a chat league the chat data and the negotiation profiles.
 */
export function counterpartyDataKey(leagueId) {
  const part = (table, stamp) => {
    try {
      const r = rows(`SELECT COUNT(*) AS n, MAX(${stamp}) AS m FROM ${table} WHERE league_id = ?`, leagueId)[0];
      return `${r?.n ?? 0}:${r?.m ?? ''}`;
    } catch { return 'absent'; }
  };
  let chat = 'none';
  if (identityMap(leagueId).size) {
    const c = openChatDb();
    if (!c) chat = 'absent';
    else {
      try {
        let np = 'absent';
        try {
          const r = c.prepare('SELECT COUNT(*) AS n, MAX(built_at) AS m FROM negotiation_profiles').get();
          np = `${r.n}:${r.m ?? ''}`;
        } catch { np = 'absent'; }
        chat = `${chatDataKey(c)}|np:${np}`;
      } finally { c.close(); }
    }
  }
  return `ms:${part('manager_signals', 'computed_at')}|id:${part('league_member_identity', 'updated_at')}`
    + `|mp:${part('manager_profiles', 'updated_at')}|chat:${chat}`;
}

/**
 * Shape of one stored negotiation profile — the input schema of the tool
 * scripts/build-negotiation-profiles.mjs forces the model to call. Kept here so
 * the server has one reader that checks what it reads; the script should import
 * it rather than carry a second copy.
 */
const strings = { type: 'array', items: { type: 'string' } };
export const NEGOTIATION_PROFILE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    headline: { type: 'string' },
    says_no: { type: 'object', properties: {
      how: { type: 'string' }, hard_no_looks_like: strings, soft_no_looks_like: strings,
      does_his_no_hold: { type: 'string', enum: ['yes', 'usually', 'rarely', 'unknown'] }, evidence: strings,
    }, required: ['how', 'does_his_no_hold', 'evidence'] },
    praise_means: { type: 'object', properties: {
      reading: { type: 'string', enum: ['belief', 'marketing', 'habit', 'mixed', 'unknown'] },
      why: { type: 'string' }, hypes_before_selling: { type: 'boolean' }, agrees_with_numbers: { type: 'string' },
      evidence: strings,
    }, required: ['reading', 'why', 'evidence'] },
    techniques: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, how_he_does_it: { type: 'string' }, evidence: strings,
      how_often: { type: 'string', enum: ['often', 'sometimes', 'once'] },
    }, required: ['name', 'how_he_does_it', 'how_often'] } },
    calibration: { type: 'object', properties: {
      enthusiasm_scale: { type: 'string' }, baseline_tone: { type: 'string' },
      inflation: { type: 'string', enum: ['none', 'mild', 'heavy', 'unknown'] },
    }, required: ['enthusiasm_scale', 'inflation'] },
    roster_read: { type: 'object', properties: {
      really_untouchable: strings, quietly_available: strings, overvalues: strings, undervalues: strings,
      reasoning: { type: 'string' },
    } },
    what_moves_him: strings,
    what_shuts_him_down: strings,
    how_to_approach: { type: 'string' },
    best_bait: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    caveats: strings,
  },
  required: ['headline', 'says_no', 'praise_means', 'techniques', 'calibration',
    'what_moves_him', 'how_to_approach', 'confidence', 'caveats'],
});

/**
 * Every violation of the schema, recursively: type, enum, required keys,
 * unexpected keys, and tool-call markup leaked into a string — the failure
 * that left six of nine profiles unusable on 2026-09-18 while still parsing.
 */
function schemaErrors(schema, value, where = 'profile') {
  if (value == null) return [];
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return [`${where}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`];
      }
      const errs = [];
      for (const k of schema.required ?? []) if (value[k] == null) errs.push(`${where}.${k}: missing`);
      const known = schema.properties ?? {};
      for (const k of Object.keys(value)) {
        if (!(k in known)) errs.push(`${where}.${k}: unexpected key`);
        else errs.push(...schemaErrors(known[k], value[k], `${where}.${k}`));
      }
      return errs;
    }
    case 'array':
      if (!Array.isArray(value)) return [`${where}: expected array, got ${typeof value}`];
      return value.flatMap((v, i) => schemaErrors(schema.items, v, `${where}[${i}]`));
    case 'string':
      if (typeof value !== 'string') return [`${where}: expected string, got ${typeof value}`];
      if (/<\/?parameter\b/.test(value)) return [`${where}: leaked tool-call markup`];
      if (schema.enum && !schema.enum.includes(value)) return [`${where}: "${value}" not in ${schema.enum.join('/')}`];
      return [];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${where}: expected boolean, got ${typeof value}`];
    default:
      return [];
  }
}
export function negotiationProfileErrors(profile) {
  if (profile == null || typeof profile !== 'object') return ['profile: expected object'];
  return schemaErrors(NEGOTIATION_PROFILE_SCHEMA, profile);
}

/**
 * The one server reader for negotiation_profiles (private chat DB, written by
 * scripts/build-negotiation-profiles.mjs with Sonnet 5).
 *
 * Returns, for one league:
 *   byRoster  roster_id -> { name, profile, built_at, messages_read, model } for
 *             every VALID profile whose person is a trusted identity here
 *   self      'ME' — Nick as the league-4 chat experiences him. Never a
 *             counterparty; it answers "how do I look to them".
 *   invalid   [{ name, errors }] — stored rows that fail the schema; not used
 *   unmapped  valid profiles with no trusted identity in this league
 *
 * A league with no trusted chat identity returns available=false: the profiles
 * are read from one chat, and attaching them to namesakes elsewhere would be
 * worse than having none.
 */
export function negotiationProfilesFor(leagueId) {
  const result = (available, reason = null) => ({
    league_id: leagueId, available, reason, byRoster: new Map(), self: null, invalid: [], unmapped: [],
  });
  const ids = identityMap(leagueId);
  if (!ids.size) return result(false, 'no chat corpus for this league (no confirmed chat identities)');
  const chat = openChatDb();
  if (!chat) return result(false, 'chat DB not found');
  let stored;
  try {
    stored = chat.prepare(`SELECT name, profile_json, messages_read, model, built_at, corpus_hash
                           FROM negotiation_profiles ORDER BY name`).all();
  } catch (e) {
    if (/no such table/.test(String(e?.message))) {
      return result(false, 'no negotiation_profiles table (scripts/build-negotiation-profiles.mjs has not run)');
    }
    throw e;
  } finally { chat.close(); }

  const out = result(true);
  const rosterByName = new Map([...ids.values()].map(i => [i.chat_name, i.roster_id]));
  const myTeam = rows('SELECT my_team_id FROM leagues WHERE id = ?', leagueId)[0]?.my_team_id ?? null;
  for (const r of stored) {
    let profile = null;
    let errors;
    try { profile = JSON.parse(r.profile_json); errors = negotiationProfileErrors(profile); }
    catch { errors = ['unparseable JSON']; }
    if (errors.length) { out.invalid.push({ name: r.name, errors }); continue; }
    const entry = { name: r.name, profile, built_at: r.built_at, messages_read: r.messages_read,
      model: r.model, corpus_hash: r.corpus_hash };
    if (r.name === 'ME') {
      out.self = { ...entry, roster_id: rosterByName.get('ME') ?? (myTeam == null ? null : String(myTeam)),
        scope: 'how the league chat sees Nick' };
      continue;
    }
    const rosterId = rosterByName.get(r.name);
    if (rosterId == null || String(rosterId) === String(myTeam)) { out.unmapped.push(r.name); continue; }
    out.byRoster.set(String(rosterId), { ...entry, roster_id: String(rosterId) });
  }
  return out;
}
