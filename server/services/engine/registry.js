/**
 * The engine's two registries and its event hook.
 *
 * EVENT TYPES. `engine_events.event_type` is an open string, but a type must be
 * registered before anything may append it, so a typo is a thrown error rather than
 * a stream no reader ever finds. Later stages (offers, Jev calls, Jev grades,
 * autopsy) register their own types from their own modules.
 *
 * FIELDS. Every `engine_state.field` has exactly ONE producer. `registerField`
 * throws when a second producer claims a field, and `writeState` (state.js) throws
 * when anyone but the registered producer writes it. test/engine-spine.test.js also
 * greps server/ and scripts/ so that each field is declared in one place only.
 *
 * onEvent. The hook later learners (ENGINE-00b daemon, per-event Bayesian updates)
 * attach to. `appendEvents` calls the handlers once per NEW event, never on a
 * duplicate. The spine registers no handler itself.
 */

const eventTypes = new Map();
const fields = new Map();
const handlers = new Map();

const NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

function checkName(kind, name) {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new Error(`${kind} "${name}" must be a dotted lower-case name like "espn.transaction"`);
  }
}

export function registerEventType(type, { description = '' } = {}) {
  checkName('event type', type);
  if (!eventTypes.has(type)) eventTypes.set(type, Object.freeze({ type, description }));
  return eventTypes.get(type);
}

export function isEventType(type) {
  return eventTypes.has(type);
}

export function listEventTypes() {
  return [...eventTypes.values()];
}

/**
 * Claim a state field for one producer. Re-registering by the same producer is a
 * no-op (a module imported twice); by any other producer it throws.
 */
export function registerField(field, { producer, version, entityTypes = [], description = '' } = {}) {
  checkName('field', field);
  if (typeof producer !== 'string' || !producer) throw new Error(`field ${field}: producer is required`);
  if (typeof version !== 'string' || !version) throw new Error(`field ${field}: version is required`);
  const existing = fields.get(field);
  if (existing) {
    if (existing.producer !== producer) {
      throw new Error(`field ${field} already has its one producer ${existing.producer}; ${producer} may not claim it`);
    }
    return existing;
  }
  const spec = Object.freeze({ field, producer, version, entityTypes: Object.freeze([...entityTypes]), description });
  fields.set(field, spec);
  return spec;
}

/** The registered spec for a field, or null. */
export function fieldSpec(field) {
  return fields.get(field) ?? null;
}

export function listFields() {
  return [...fields.values()];
}

/**
 * Subscribe to new events of one type, or '*' for all. Returns an unsubscribe
 * function. Handlers run synchronously after the insert commits; a handler that
 * throws propagates to the appender, so a broken learner is loud.
 */
export function onEvent(type, handler) {
  if (typeof handler !== 'function') throw new Error('onEvent needs a handler function');
  if (type !== '*') checkName('event type', type);
  const set = handlers.get(type) ?? new Set();
  set.add(handler);
  handlers.set(type, set);
  return () => set.delete(handler);
}

export function handlersFor(type) {
  return [...(handlers.get(type) ?? []), ...(handlers.get('*') ?? [])];
}

/* ------------------------------------------------ the spine's own registrations */

/** Event types the backfill adapters append (backfill.js). */
export const SPINE_EVENT_TYPES = Object.freeze({
  'espn.transaction': 'An ESPN league transaction (waiver, free agent, trade), from league_transactions_raw',
  'league.lineup': "A fantasy team's lineup slot for one player in one scoring period, from league_roster_snapshots",
  'news.item': 'A news item with its resolved player ids (headline only, no body), from news_items',
  'market.game_line': 'A game spread/total/implied points as captured, from game_lines',
  'nfl.injury': 'An official NFL injury report line, from nfl_injuries',
  'trade.proposed': 'A trade proposal recorded in trade_outcomes',
  'trade.considered': 'A trade the app considered and did not propose, recorded in trade_outcomes',
  'trade.resolved': 'A trade resolution (accepted, declined, ...) recorded in trade_outcomes',
  'manager.chat_signal': 'A chat count or rate per fantasy team (no names, no text), from manager_signals source=chat',
});
for (const [type, description] of Object.entries(SPINE_EVENT_TYPES)) registerEventType(type, { description });

registerField('engine.ingest', {
  producer: 'engine-backfill', version: '1', entityTypes: ['engine'],
  description: 'Per stream: events in the log as of the row, and the highest event id',
});
