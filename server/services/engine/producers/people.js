/**
 * HUB-PUBLISH-PEOPLE: the people layer published through the engine hub (FIELD-REGISTRY.md
 * hub rule: every producer publishes to engine_state with source + as_of; every screen and
 * Coach reads the hub, not the box).
 *
 *   people.profile      (entity league_team `<league>:<roster>`) one row per manager of every
 *                       league, Nick's own roster included (scope 'self'). Producer
 *                       `people-profile`, which calls the ONE reader
 *                       (people/profile-reader.js#peopleProfile) and publishes its entry as
 *                       LABELS AND COUNTS ONLY: status/reason, the parsed enum slots, message
 *                       and error counts, build stamps and Nick's block without note text
 *                       (profile-reader.js#publicNick). No chat text, no names: the reader's
 *                       rule is that only labels and counts leave the chat DB.
 *   people.counterpart  (same entity) one row per manager: the ONE counterpart model
 *                       (people/counterpart.js#counterpartsFromPeople) as its publicModel,
 *                       built from the same tick's people.profile read. Producer
 *                       `people-counterpart`; it reads people.profile, so the DAG runs it
 *                       second. Nick's own roster is typed unknown (not a counterparty).
 *
 * Typed unknown: a manager the reader has no read for is published with status 'unknown'
 * and the reader's reason (Nick's block still rides along); a league whose read is
 * unavailable (no chat corpus, no chat DB) publishes a null value with absence
 * {status: 'unknown', reason} for every roster. Never a neutral default.
 *
 * The model's clock is the tick's UTC day (wants decay and claim windows are in days), so
 * an unchanged world writes nothing between days (write-on-change).
 *
 * prior_trades (FIX-268-8): the counterpart also reads `tells.prior_trades` from the hub
 * (hub-read.js). Not a DAG edge: producer 'tells' runs from scripts/engine-tells.mjs, off
 * the daemon, so the read is as of the tick and a missing row is the feature's reason.
 *
 * Flag: GRIDIRON_HUB_PEOPLE=1 puts both producers in the daemon DAG, =0 keeps them out;
 * unset follows the local preview switch (preview-mode.js). Registration itself is
 * harmless: nothing runs unless the daemon's producer list includes them.
 */
import { registerProducer } from '../registry.js';
import { previewUnconfirmed } from '../../preview-mode.js';
import {
  peopleProfile, publicNick, PEOPLE_PROFILE_FIELD, READER_VERSION, UNKNOWN,
} from '../../people/profile-reader.js';
import {
  counterpartsFromPeople, publicModel, tradeEvents, PEOPLE_COUNTERPART_FIELD, MODEL_VERSION, P_ACCEPT_CHAT_WEIGHT,
} from '../../people/counterpart.js';
import { hubTellsPriorTrades } from '../../people/hub-read.js';

export const HUB_PEOPLE_ENV = 'GRIDIRON_HUB_PEOPLE';
export const PROFILE_PRODUCER = 'people-profile';
export const COUNTERPART_PRODUCER = 'people-counterpart';
export const PROFILE_SOURCE = 'server/services/people/profile-reader.js';
export const COUNTERPART_SOURCE = 'server/services/people/counterpart.js';
const PROFILE_VERSION = `hub1-${READER_VERSION}`;
const COUNTERPART_VERSION = `hub1-${MODEL_VERSION}`;
const DAY = 864e5;

/** { on, preview }: =1 on, =0 off (vetoes preview), unset follows the preview switch. */
export function hubPeopleFlag(env = process.env) {
  if (env[HUB_PEOPLE_ENV] === '1') return { on: true, preview: false };
  if (env[HUB_PEOPLE_ENV] === '0') return { on: false, preview: false };
  return previewUnconfirmed() ? { on: true, preview: true } : { on: false, preview: false };
}

const PROFILE_WRITERS = registerProducer({
  name: 'people-profile',
  active: PROFILE_VERSION,
  versions: { [PROFILE_VERSION]: { params: { reader: READER_VERSION, publish: 'labels and counts only' } } },
  fields: [
    { field: 'people.profile', valueType: 'object', entityTypes: ['league_team'], maxAgeSec: 3600,
      replaces: ['profile-reader.js#peopleProfile (direct reads by consumers)'],
      description: 'One manager\'s chat read as labels and counts (status, enum slots, Nick\'s block without text)' },
  ],
  inputs: { events: [], fields: [], scope: 'league', schedule: 'tick', cost: 'cheap', budget_ms: 30000 },
});

const COUNTERPART_WRITERS = registerProducer({
  name: 'people-counterpart',
  active: COUNTERPART_VERSION,
  versions: { [COUNTERPART_VERSION]: { params: { model: MODEL_VERSION, p_accept_chat_weight: P_ACCEPT_CHAT_WEIGHT, clock: 'utc day' } } },
  fields: [
    { field: 'people.counterpart', valueType: 'object', entityTypes: ['league_team'], maxAgeSec: 3600,
      replaces: ['counterpart.js#counterpartsFromPeople (direct builds by consumers)'],
      description: 'One manager\'s counterpart model (wants, untouchable, shop, credibility, Nick override, reply prior)' },
  ],
  inputs: { events: [], fields: ['people.profile'], scope: 'league', schedule: 'tick', cost: 'cheap', budget_ms: 30000 },
});

/* ------------------------------------------------------------------ projections (pure) */

const slot = (v) => (v == null ? null : v);

/**
 * A reader entry (profile-reader.js#peopleProfileEntry) -> the published value. Labels and
 * counts only: never headline, evidence, technique names, roster_read, notes or names.
 */
export function profileLabels(entry, { scope = 'counterparty' } = {}) {
  const p = entry?.profile ?? null;
  return {
    source: PROFILE_SOURCE, reader_version: READER_VERSION, scope,
    roster_id: entry?.roster_id ?? null,
    status: entry?.status ?? UNKNOWN, reason: entry?.reason ?? null,
    valid: !!entry?.valid, errors_n: entry?.errors?.length ?? 0, unparsed_n: entry?.unparsed?.length ?? 0,
    as_of: entry?.as_of ?? null, messages_read: entry?.messages_read ?? null,
    built_at: entry?.built_at ?? null, model: entry?.model ?? null, corpus_hash: entry?.corpus_hash ?? null,
    labels: p ? {
      does_his_no_hold: slot(p.says_no?.does_his_no_hold),
      praise_reading: slot(p.praise_means?.reading),
      hypes_before_selling: typeof p.praise_means?.hypes_before_selling === 'boolean' ? p.praise_means.hypes_before_selling : null,
      inflation: slot(p.calibration?.inflation),
      confidence: slot(p.confidence),
      techniques_how_often: Array.isArray(p.techniques) ? p.techniques.map(t => slot(t?.how_often)) : [],
    } : null,
    nick: publicNick(entry?.nick ?? null),
  };
}

/** A counterpart model -> the published value. */
export function counterpartValue(cp, { modelNow }) {
  return { source: COUNTERPART_SOURCE, model_version: MODEL_VERSION, model_now: new Date(modelNow).toISOString(),
    ...publicModel(cp) };
}

/** The model clock for a tick: midnight UTC of the tick's day. */
export function modelNow(asOf) {
  const t = Date.parse(asOf);
  return Math.floor(t / DAY) * DAY;
}

/* ------------------------------------------------------------------ inputs (one read per tick) */

const toMs = v => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
  if (/^\d+$/.test(String(v))) return toMs(Number(v));
  const t = Date.parse(/\dT\d|Z$|[+-]\d\d:?\d\d$/.test(String(v)) ? String(v) : `${String(v).replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : null;
};

async function dbRows() {
  return (await import('../../../db/index.js')).rows;
}

/** Every league the app holds: [{ id, season, my_team_id }]. */
export async function peopleLeagues() {
  const rows = await dbRows();
  return rows('SELECT id, season, my_team_id FROM leagues ORDER BY id')
    .map(r => ({ id: Number(r.id), season: r.season == null ? null : Number(r.season), myTeam: r.my_team_id == null ? null : String(r.my_team_id) }));
}

/**
 * The league's rosters (every team, Nick's included), the name index for the counterpart
 * model's name resolution (every player rostered in the league this season), and its trade
 * events. Teams: the trusted identities plus every team in the season's lineup captures.
 */
export async function leagueInputs(league) {
  const rows = await dbRows();
  const { identityMap } = await import('../../manager-identity.js');
  const teams = new Set([...identityMap(league.id).keys()].map(String));
  const players = new Map();
  if (league.season != null) {
    for (const r of rows(`SELECT DISTINCT team_id, espn_player_id, player_name FROM league_roster_snapshots
        WHERE league_id = ? AND season = ?`, league.id, league.season)) {
      if (r.team_id != null && Number(r.team_id) > 0) teams.add(String(r.team_id));
      if (r.espn_player_id != null && r.player_name && !players.has(String(r.espn_player_id))) {
        players.set(String(r.espn_player_id), { name: r.player_name });
      }
    }
  }
  if (league.myTeam != null) teams.add(league.myTeam);
  let tx = [];
  try {
    tx = league.season == null ? [] : rows(`SELECT tx_id, type, status, execution_type, items_json, proposed_at, processed_at
        FROM league_transactions_raw WHERE league_id = ? AND season = ?`, league.id, league.season);
  } catch (e) { if (!/no such table/.test(String(e?.message))) throw e; }
  const byNum = (a, b) => (Number(a) - Number(b)) || String(a).localeCompare(String(b));
  return { teams: [...teams].sort(byNum), players, events: tradeEvents(tx, toMs) };
}

/**
 * The counterpart models for one league exactly as the producer builds them: the reader's
 * people.profile, the league's inputs, and the model clock. Exported so a parity check can
 * rebuild the direct answer the hub row must equal.
 */
export async function directPeople(league, { asOf, people = null } = {}) {
  const read = people ?? await peopleProfile(league.id);
  const inputs = await leagueInputs(league);
  const now = modelNow(asOf);
  const others = inputs.teams.filter(t => t !== league.myTeam);
  // FIX-268-8: tells.prior_trades from the hub, as of the tick (default-off feature, counterpart.js).
  const priorTrades = await hubTellsPriorTrades(league.id, { asOf });
  const cps = counterpartsFromPeople(read, { players: inputs.players, events: inputs.events, now, teams: others, priorTrades });
  return { people: read, inputs, now, counterparts: cps, priorTrades };
}

// The profile producer's read, handed to the counterpart producer in the same tick.
let lastRead = { tick: null, byLeague: new Map() };

/* ------------------------------------------------------------------ runs */

const key = (league, roster) => `${league}:${roster}`;
const chain = (source, text, stateIds = []) => ({ contributions: [{ source, kind: stateIds.length ? 'state' : 'model',
  event_ids: [], state_ids: stateIds, delta: null, text }] });

async function runProfile(ctx) {
  const byLeague = new Map();
  for (const league of await peopleLeagues()) {
    const people = await peopleProfile(league.id);
    byLeague.set(league.id, people);
    const { teams } = await leagueInputs(league);
    const w = PROFILE_WRITERS['people.profile'];
    for (const roster of teams) {
      const base = { entityType: 'league_team', entityId: key(league.id, roster), leagueId: league.id, field: 'people.profile' };
      if (!people.available) {
        ctx.write(w, { ...base, absence: { status: 'unknown', reason: people.reason },
          reasonChain: chain(PROFILE_SOURCE, `reader unavailable: ${people.reason}`) });
        continue;
      }
      const self = roster === league.myTeam;
      const entry = self ? people.self : people.byRoster.get(roster);
      const value = entry ? profileLabels(entry, { scope: self ? 'self' : 'counterparty' })
        : profileLabels({ roster_id: roster, status: UNKNOWN, reason: 'no confirmed chat identity' },
          { scope: self ? 'self' : 'counterparty' });
      ctx.write(w, { ...base, value, reasonChain: chain(PROFILE_SOURCE,
        `${READER_VERSION}: ${value.status}${value.reason ? ` (${value.reason})` : ''}`) });
    }
  }
  lastRead = { tick: ctx.tick.id, byLeague };
}

async function runCounterpart(ctx) {
  const cached = lastRead.tick === ctx.tick.id ? lastRead.byLeague : new Map();
  const w = COUNTERPART_WRITERS['people.counterpart'];
  for (const league of await peopleLeagues()) {
    const { people, inputs, now, counterparts, priorTrades } = await directPeople(league, { asOf: ctx.tick.as_of,
      people: cached.get(league.id) ?? null });
    const profileRows = new Map(ctx.read.latest('people.profile', { leagueId: league.id, entityType: 'league_team' })
      .map(r => [r.entity_id, r.id]));
    for (const roster of inputs.teams) {
      const id = key(league.id, roster);
      const prior = priorTrades.available ? priorTrades.byRoster.get(roster)?.state_id : null;
      const cite = [...(profileRows.has(id) ? [profileRows.get(id)] : []), ...(prior != null ? [prior] : [])];
      const base = { entityType: 'league_team', entityId: id, leagueId: league.id, field: 'people.counterpart', stateIds: cite };
      if (roster === league.myTeam) {
        ctx.write(w, { ...base, absence: { status: 'unknown', reason: 'Nick\'s own roster: not a counterparty' },
          reasonChain: chain(COUNTERPART_SOURCE, 'self: no counterpart model', cite) });
        continue;
      }
      const cp = counterparts.get(roster);
      const value = counterpartValue(cp, { modelNow: now });
      ctx.write(w, { ...base, value, reasonChain: chain(COUNTERPART_SOURCE,
        `${MODEL_VERSION} on ${people.available ? people.version : `no read (${people.reason})`}: ${value.status}`, cite) });
    }
  }
}

export const peopleProfileProducer = Object.freeze({ name: 'people-profile', run: runProfile });
export const peopleCounterpartProducer = Object.freeze({ name: 'people-counterpart', run: runCounterpart });

/** The people producers for the daemon, or none when the flag is off. */
export function peopleProducers(env = process.env) {
  return hubPeopleFlag(env).on ? [peopleProfileProducer, peopleCounterpartProducer] : [];
}
