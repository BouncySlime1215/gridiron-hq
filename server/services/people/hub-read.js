/**
 * HUB-PUBLISH-PEOPLE: the one hub read of the people layer. Consumers (planner partners,
 * Coach people_read, the War Room people board) call this instead of the reader
 * (profile-reader.js) or the counterpart model (counterpart.js) directly: the engine daemon
 * publishes both as engine_state fields (engine/producers/people.js), and this reads the
 * latest live row per manager, as of a time, with its source, producer version and as_of.
 *
 *   hubPeopleProfile(leagueId)      { available, reason, byRoster: Map roster -> entry, self }
 *   hubPeopleCounterpart(leagueId)  { available, reason, byRoster: Map roster -> entry, self }
 *     entry = { roster, value | null, absence | null, as_of, producer, producer_version,
 *               state_id, health }   value is exactly what the producer published
 *   counterpartsFromHub(result)     Map team -> counterpart model with Maps, the shape
 *                                   counterpart.js#targetTilt / respondsAdjust / priceCap /
 *                                   withCounterparts take (wants keep player, n, lift)
 *
 * No rows (the daemon has not published: GRIDIRON_HUB_PEOPLE off, or the engine tables
 * are missing) is `available: false` with a reason, never an empty-but-ok read. A typed
 * unknown row stays typed unknown. Read-only; importing this file opens no database.
 */
export const HUB_FIELDS = Object.freeze({ profile: 'people.profile', counterpart: 'people.counterpart' });
const TELLS_PRIOR_TRADES_FIELD = 'tells.prior_trades';

const parse = s => (s == null ? null : JSON.parse(s));

async function defaultDb() {
  return (await import('../../db/index.js')).db;
}

/** Latest live, non-failed row per league_team for one people field of one league, as of `asOf`. */
export async function hubRows(field, leagueId, { asOf = new Date(), database = null } = {}) {
  const db = database ?? await defaultDb();
  const at = new Date(asOf).toISOString();
  try {
    return db.prepare(`SELECT id, entity_id, value, as_of, producer, producer_version, health FROM engine_state
        WHERE id IN (SELECT MAX(id) FROM engine_state WHERE field = ? AND league_id = ? AND lane = 'live'
          AND entity_type = 'league_team' AND as_of <= ? AND json_extract(health, '$.status') <> 'failed'
          GROUP BY entity_id)
        ORDER BY id`).all(field, Number(leagueId), at);
  } catch (e) {
    if (/no such table/.test(String(e?.message))) return null;
    throw e;
  }
}

async function hubRead(field, leagueId, opts = {}) {
  const found = await hubRows(field, leagueId, opts);
  const out = { field, league_id: Number(leagueId), source: 'engine_state (hub)', available: false, reason: null,
    as_of: null, byRoster: new Map(), self: null };
  if (found == null) return { ...out, reason: 'engine tables missing (migration 075 not applied)' };
  if (!found.length) {
    return { ...out, reason: field === TELLS_PRIOR_TRADES_FIELD
      ? `no ${field} rows on the hub for this league (producer 'tells' has not run: scripts/engine-tells.mjs)`
      : `no ${field} rows on the hub for this league (the engine daemon has not published it; GRIDIRON_HUB_PEOPLE off?)` };
  }
  const db = opts.database ?? await defaultDb();
  const mine = db.prepare('SELECT my_team_id FROM leagues WHERE id = ?').get(Number(leagueId))?.my_team_id;
  const selfRoster = mine == null ? null : String(mine);
  for (const r of found) {
    const health = parse(r.health) ?? {};
    const roster = String(r.entity_id).slice(String(r.entity_id).indexOf(':') + 1);
    const value = parse(r.value);
    const entry = { roster, value, absence: health.absence ?? null, as_of: r.as_of, producer: r.producer,
      producer_version: r.producer_version, state_id: Number(r.id), health: health.status ?? null };
    if (roster === selfRoster) out.self = entry;
    else out.byRoster.set(roster, entry);
    if (!out.as_of || r.as_of > out.as_of) out.as_of = r.as_of;
  }
  return { ...out, available: true, self_roster: selfRoster };
}

/** people.profile for one league from the hub. */
export const hubPeopleProfile = (leagueId, opts) => hubRead(HUB_FIELDS.profile, leagueId, opts);

/** people.counterpart for one league from the hub. */
export const hubPeopleCounterpart = (leagueId, opts) => hubRead(HUB_FIELDS.counterpart, leagueId, opts);

/**
 * tells.prior_trades for one league from the hub (producer 'tells', run by
 * scripts/engine-tells.mjs): the counterpart's prior_trades feature reads this.
 */
export const hubTellsPriorTrades = (leagueId, opts) => hubRead(TELLS_PRIOR_TRADES_FIELD, leagueId, opts);

/** A published counterpart value -> the model shape counterpart.js's consumers take. */
export function modelFromValue(v) {
  if (!v) return null;
  return {
    team: String(v.team), version: v.version, status: v.status, reason: v.reason, as_of: v.model_now ?? null,
    wants: new Map((v.wants ?? []).map(w => [String(w.player), { player: String(w.player), n: w.n, lift: w.lift }])),
    untouchable: new Map((v.untouchable ?? []).map(p => [String(p), { player: String(p) }])),
    shopping: new Map((v.shopping ?? []).map(p => [String(p), { player: String(p) }])),
    credibility: v.credibility ?? { untouchable: null, shop: null },
    override: v.override ?? { status: 'none', exclude: false, deprioritize: false, toughen: false, basis: null, nick: null },
    reply_prior: v.reply_prior ?? null,
    unresolved_names: v.unresolved_names ?? 0,
    ...(v.prior_trades ? { prior_trades: v.prior_trades } : {}),
  };
}

/** hubPeopleCounterpart result -> Map team -> model (rows typed absent are left out). */
export function counterpartsFromHub(result) {
  const out = new Map();
  if (!result?.available) return out;
  for (const [team, e] of result.byRoster) if (e.value) out.set(String(team), modelFromValue(e.value));
  return out;
}
