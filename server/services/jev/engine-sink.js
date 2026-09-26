/**
 * JEV-01a on #216's engine spine: the adapter from the stage's
 * {appendEvent, writeState} sink to engine/events.js `appendEvents` and
 * engine/state.js `writeState`, and producer 'jev' in the one-writer registry.
 *
 * Producer 'jev' owns every jev.* field below and nothing else; the registry
 * refuses any other producer's claim or write (the stage's guardSink is the same
 * rule for a non-engine sink). Two versions:
 *   - JEV_PRODUCER_VERSIONS.ops (active, lane live): jev.status and jev.balance,
 *     operational facts the status line reads;
 *   - JEV_PRODUCER_VERSIONS.shadow (lane shadow): every answer and disagreement
 *     row. Weight 0: getState never serves them by default.
 *
 * Event types: the gateway's `jev_call` / `jev_runaway` become the registered
 * dotted types `jev.call` / `jev.runaway` (the registry's name grammar).
 *
 * `jevCallMedianPerHour` is the runaway monitor's trailing-7-day hourly median,
 * read from jev.call events rather than one process's memory, so a daemon
 * restart does not reset the baseline. `createEngineJevGateway` wires both.
 */
import crypto from 'node:crypto';
import { db as appDb } from '../../db/index.js';
import { registerEventType, registerProducer } from '../engine/registry.js';
import { appendEvents, getEvents } from '../engine/events.js';
import { isLeagueScoped, writeState } from '../engine/state.js';
import { createJevGateway, createRunawayMonitor } from './gateway.js';

export const JEV_EVENT_TYPES = Object.freeze({ jev_call: 'jev.call', jev_runaway: 'jev.runaway' });
export const JEV_PRODUCER_VERSIONS = Object.freeze({ ops: '1-ops', shadow: '1-shadow' });

registerEventType('jev.call', { description: 'One Jev gateway call, ok or failed: prompt hash, question type + version, arm, model, tokens, cost, latency, ai_usage id' });
registerEventType('jev.runaway', { description: 'A Jev runaway alert (call rate, repeated prompt, balance near zero); never blocks a call' });

const ANSWER = ['player', 'offer', 'league_team_week'];
const OPS = ['engine'];
const W = registerProducer({ name: 'jev', active: '1-ops', versions: { '1-ops': {}, '1-shadow': {} }, shadow: ['1-shadow'],
  fields: [
    { field: 'jev.status', entityTypes: OPS, description: 'Why Jev was not asked (no_key), with the reason' },
    { field: 'jev.balance', entityTypes: OPS, description: 'Vercel AI Gateway balance from getCredits, at stage start and hourly' },
    { field: 'jev.plays_sunday.jev_a', entityTypes: ANSWER },
    { field: 'jev.plays_sunday.jev_b', entityTypes: ANSWER },
    { field: 'jev.plays_sunday.disagreement', entityTypes: ANSWER },
    { field: 'jev.role_change.jev_a', entityTypes: ANSWER },
    { field: 'jev.role_change.jev_b', entityTypes: ANSWER },
    { field: 'jev.role_change.disagreement', entityTypes: ANSWER },
    { field: 'jev.p_accept.jev_a', entityTypes: ANSWER },
    { field: 'jev.p_accept.jev_b', entityTypes: ANSWER },
    { field: 'jev.p_accept.disagreement', entityTypes: ANSWER },
    { field: 'jev.sim_contradiction.jev_a', entityTypes: ANSWER },
    { field: 'jev.sim_contradiction.jev_b', entityTypes: ANSWER },
    { field: 'jev.sim_contradiction.disagreement', entityTypes: ANSWER },
    { field: 'jev.pitch_framing.jev_a', entityTypes: ANSWER },
    { field: 'jev.pitch_framing.jev_b', entityTypes: ANSWER },
    { field: 'jev.pitch_framing.disagreement', entityTypes: ANSWER },
    { field: 'jev.startsit_tiebreak.jev_a', entityTypes: ANSWER },
    { field: 'jev.startsit_tiebreak.jev_b', entityTypes: ANSWER },
    { field: 'jev.startsit_tiebreak.disagreement', entityTypes: ANSWER },
  ],
});

const OPS_FIELDS = new Set(['jev.status', 'jev.balance']);
const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const MAX_READ = 50000;
const ints = xs => (Array.isArray(xs) ? xs.filter(Number.isInteger) : []);

/** The stage's loose reason chain -> #216's v2 chain, citing the jev.call event and the rows Jev read. */
function toChain(rc = {}) {
  const eventIds = [...new Set([...(Number.isInteger(rc.jev_call_event_id) ? [rc.jev_call_event_id] : []), ...ints(rc.event_ids)])];
  const stateIds = [...new Set(ints(rc.state_ids))];
  const text = rc.text ?? (rc.checked_at ? `gateway.getCredits at ${rc.checked_at}` : 'Jev answer, weight 0 (shadow)');
  const contributions = eventIds.length || stateIds.length
    ? [{ source: rc.source ?? 'jev', kind: 'model', event_ids: eventIds, state_ids: stateIds, text }]
    : [];
  return { eventIds, stateIds, reasonChain: { contributions, ...(contributions.length ? {} : { baseline: { text } }) } };
}

/** The engine sink: {appendEvent, writeState} over #216's one event log and one state writer. */
export function createEngineSink({ database = appDb } = {}) {
  return {
    appendEvent({ type, as_of: asOf, payload = {} }) {
      const eventType = JEV_EVENT_TYPES[type];
      if (!eventType) throw new Error(`Jev engine sink: unknown event "${type}"`);
      const r = appendEvents([{ event_type: eventType, source: 'jev', natural_key: `${eventType}:${crypto.randomUUID()}`,
        as_of: asOf, provenance: 'derived', payload, entities: [{ type: 'engine', id: 'jev', role: 'subject' }] }], { database });
      if (r.inserted !== 1) throw new Error(`Jev engine sink: ${eventType} was not appended`);
      return r.events[0].id;
    },
    writeState({ entity_type: entityType, entity_id: entityId, field, producer, as_of: asOf, value, reason_chain: rc }) {
      if (producer !== 'jev') throw new Error(`${field}: the Jev engine sink writes producer 'jev' only, not '${producer}'`);
      const writer = W[field];
      if (!writer) throw new Error(`${field} is not a registered jev.* field`);
      const { eventIds, stateIds, reasonChain } = toChain(rc);
      const leagueId = isLeagueScoped(entityType) ? Number(String(entityId).split(':')[0]) : null;
      const r = writeState({ entityType, entityId: String(entityId), field, value, asOf, writer, leagueId,
        producerVersion: OPS_FIELDS.has(field) ? JEV_PRODUCER_VERSIONS.ops : JEV_PRODUCER_VERSIONS.shadow,
        reasonChain, eventIds, stateIds }, database);
      return r.id;
    },
  };
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * () => the median calls per hour over the trailing 7 days of jev.call events, the
 * current hour excluded. The window starts at the oldest call in it (so a log younger
 * than a week is not padded with empty hours); no calls -> 0. Over MAX_READ calls in a
 * week the read keeps the oldest MAX_READ, so the median is a lower bound and the rate
 * alert fires sooner, never later.
 */
export function jevCallMedianPerHour({ now = () => Date.now(), database = appDb } = {}) {
  return () => {
    const t = now();
    const asOf = new Date(t).toISOString();
    const from = new Date(t - WEEK).toISOString();
    const { events } = getEvents({ asOf, from, types: ['jev.call'], limit: MAX_READ, allowTruncated: true }, database);
    if (!events.length) return 0;
    const hours = Math.max(1, Math.min(168, Math.floor((t - Date.parse(events[0].as_of)) / HOUR)));
    const buckets = new Array(hours).fill(0);
    for (const e of events) {
      const h = Math.floor((t - Date.parse(e.as_of)) / HOUR);
      if (h >= 1 && h <= hours) buckets[h - 1]++;
    }
    return median(buckets);
  };
}

/** The gateway as the engine daemon runs it: the engine sink, and a runaway median read from jev.call events. */
export function createEngineJevGateway({ database = appDb, now = () => Date.now(), ...opts } = {}) {
  const sink = createEngineSink({ database });
  const runaway = createRunawayMonitor({ now, medianPerHour: jevCallMedianPerHour({ now, database }) });
  return { sink, gateway: createJevGateway({ ...opts, sink, now, runaway }) };
}
