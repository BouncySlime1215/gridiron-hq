/**
 * WEAK-01: people.weakness published through the engine hub (FIELD-REGISTRY.md hub rule:
 * every producer publishes to engine_state with source + as_of; screens, Coach and the
 * planner read the hub). Same pattern as producers/people.js (HUB-PUBLISH-PEOPLE).
 *
 *   people.weakness  (entity league_team `<league>:<roster>`) one row per counterparty of
 *                    every league: the scanner's ranked attack surfaces
 *                    (people/weakness.js#scanLeague), each with evidence, as_of and a
 *                    confidence label, plus the kinds it could not read (typed unknown)
 *                    and the kinds it read clear. Producer `people-weakness`.
 *                    Nick's own roster is published typed unknown (not a counterparty).
 *
 * Inputs: people.counterpart from the hub (the wants_player signal and credibility); a
 * league with no counterpart rows publishes in_market as absent with that reason, never as
 * zero. The rest is read from the app DB as of the tick (rosters, byes, scores, ledger,
 * served odds, CRED-01 rows when that table exists) and the valuation map.
 *
 * Labels and ids only: no chat text, no names (player ids, positions, counts).
 * The scan's day stamp is the tick's UTC day and its day counts are whole days, so an
 * unchanged league writes nothing between days (write-on-change).
 *
 * Flag: GRIDIRON_WEAKNESS=1 puts the producer in the daemon DAG (weaknessProducers), =0
 * keeps it out; unset follows the local preview switch (preview-mode.js). Default off.
 * Registration itself is harmless: nothing runs unless the daemon's list includes it.
 */
import { registerProducer } from '../registry.js';
import {
  weaknessFlag, weaknessInputs, valueReads, scanLeague, PEOPLE_WEAKNESS_FIELD, WEAKNESS_VERSION, WEAKNESS_SOURCE,
  CONFIDENCE_WEIGHT, SCALES,
} from '../../people/weakness.js';

export const WEAKNESS_PRODUCER = 'people-weakness';
const VERSION = `hub1-${WEAKNESS_VERSION}`;
const DAY = 864e5;

// The field name comes from the model module (one spelling); this file is its one declaration.
const WRITERS = registerProducer({
  name: 'people-weakness',
  active: VERSION,
  versions: { [VERSION]: { params: { model: WEAKNESS_VERSION, confidence_weight: CONFIDENCE_WEIGHT, scales: SCALES, clock: 'utc day' } } },
  fields: [
    { field: PEOPLE_WEAKNESS_FIELD, valueType: 'object', entityTypes: ['league_team'], maxAgeSec: 3600,
      replaces: [],
      description: 'One counterparty\'s ranked attack surfaces (roster holes, value gaps, desperation, attention gaps, in-market), each with evidence, as_of and a proven/measured/unproven label' },
  ],
  inputs: { events: [], fields: ['people.counterpart'], scope: 'league', schedule: 'tick', cost: 'cheap', budget_ms: 30000 },
});

const key = (league, roster) => `${league}:${roster}`;
const dayOf = asOf => Math.floor(Date.parse(asOf) / DAY) * DAY;
const chain = (text, stateIds = []) => ({ contributions: [{ source: WEAKNESS_SOURCE, kind: stateIds.length ? 'state' : 'model',
  event_ids: [], state_ids: stateIds, delta: null, text }] });

async function leagues() {
  return (await import('./people.js')).peopleLeagues();
}

/** The published value for one scan (JSON-safe; already labels, ids and counts only). */
export function weaknessValue(scan, { flag = null } = {}) {
  return { ...scan, ...(flag?.preview ? { preview: true, preview_reason: flag.preview_reason } : {}) };
}

/** One league's scan exactly as the producer builds it (exported for the parity check). */
export async function directWeakness(leagueId, { asOf, counterparts = new Map(), counterpartAsOf = null } = {}) {
  const cutMs = Date.parse(asOf);
  const stampMs = dayOf(asOf);
  const inp = await weaknessInputs(leagueId, { cutMs });
  let vr;
  try { vr = await valueReads(inp, { asOfMs: stampMs }); } catch (e) { vr = { reads: null, reason: `valuation map failed: ${e.message}` }; }
  const scan = scanLeague(inp, { counterparts, counterpartAsOf, valueReads: vr.reads, valueReason: vr.reason, valueAsOf: vr.as_of, stampMs });
  return { inp, scan };
}

async function runWeakness(ctx) {
  const w = WRITERS[PEOPLE_WEAKNESS_FIELD];
  const flag = weaknessFlag();
  for (const league of await leagues()) {
    const rows = ctx.read.latest('people.counterpart', { leagueId: league.id, entityType: 'league_team' });
    const counterparts = new Map();
    const cite = new Map();
    let cpAsOf = null;
    for (const r of rows) {
      const roster = String(r.entity_id).slice(String(r.entity_id).indexOf(':') + 1);
      cite.set(roster, r.id);
      if (r.value) counterparts.set(roster, r.value);
      if (!cpAsOf || r.as_of > cpAsOf) cpAsOf = r.as_of;
    }
    const { inp, scan } = await directWeakness(league.id, { asOf: ctx.tick.as_of, counterparts, counterpartAsOf: cpAsOf });
    for (const roster of inp.teams) {
      const stateIds = cite.has(roster) ? [cite.get(roster)] : [];
      const base = { entityType: 'league_team', entityId: key(league.id, roster), leagueId: league.id, field: PEOPLE_WEAKNESS_FIELD, stateIds };
      if (roster === inp.me) {
        ctx.write(w, { ...base, absence: { status: 'unknown', reason: 'Nick\'s own roster: not a counterparty' },
          reasonChain: chain('self: no weakness scan', stateIds) });
        continue;
      }
      const s = scan.teams.get(roster);
      if (!s) continue;
      ctx.write(w, { ...base, value: weaknessValue(s, { flag }), reasonChain: chain(
        `${WEAKNESS_VERSION}: ${s.surfaces.length} surface(s)${s.surfaces[0] ? `, top ${s.surfaces[0].kind} (${s.surfaces[0].confidence})` : ''}; league rank ${s.league_rank} of ${s.league_size}`
        + `${s.absent.length ? `; unread: ${s.absent.map(a => a.kind).join(', ')}` : ''}`, stateIds) });
    }
  }
}

export const weaknessProducer = Object.freeze({ name: 'people-weakness', run: runWeakness });

/** The weakness producer for the daemon, or none when the flag is off. */
export function weaknessProducers(env = process.env) {
  return weaknessFlag(env).on ? [weaknessProducer] : [];
}
