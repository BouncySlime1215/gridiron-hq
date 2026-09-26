/**
 * JEV-01a: Jev as a DECIDE stage of the engine loop, shadow only.
 *
 * For each ask ({qtype, subject}) the stage builds the as-of pack from the
 * snapshot view, asks Jev in both phrasings, and writes each arm's answer as an
 * engine_state row `jev.<qtype>.jev_<arm>` (producer 'jev', weight 0, lane
 * shadow) whose reason_chain names the state rows and events it read. It
 * returns, per ask, a probability, a recommended action and the cited fields.
 *
 * Weight is 0 everywhere: nothing here is served. JEV-01b grades these rows
 * and earns (or doesn't) Jev a weight; JEV-01c serves the blend.
 *
 * The sink is {appendEvent, writeState}. In the engine it is engine-sink.js's
 * adapter over #216's appendEvents/writeState, where the one-writer registry
 * owns jev.*; `guardSink` applies the same rule to any other sink (tests).
 *
 * Operational rows (jev.status, jev.balance) are keyed engine:jev.
 */
import { buildJevState } from './state.js';
import { ARMS, QUESTION_TYPES, askable, buildQuestions, interpret, recommend } from './questions.js';
import { KEY_ENV } from './gateway.js';

export const PRODUCER = 'jev';
export const WEIGHT = 0;
export const LANE = 'shadow';
export const DISAGREEMENT = 0.25;
const BALANCE_EVERY_MS = 3_600_000;

/** jev.* fields have producer 'jev' only, and 'jev' writes nothing else. */
export function assertJevWrite({ field, producer }) {
  const isJevField = typeof field === 'string' && field.startsWith('jev.');
  if (isJevField && producer !== PRODUCER) {
    throw new Error(`${field} belongs to producer '${PRODUCER}'; '${producer}' may not write it`);
  }
  if (producer === PRODUCER && !isJevField) throw new Error(`jev may only write jev.* fields, not ${field}`);
}

export function guardSink(sink) {
  return {
    ...sink,
    appendEvent: e => sink.appendEvent(e),
    writeState: r => { assertJevWrite(r); return sink.writeState(r); },
  };
}

const dedupe = new WeakMap(); // gateway -> { asOf, map: Map(question + pack -> ask result) }
const balanceAt = new WeakMap(); // gateway -> ms of the last balance read

function spread(vectors) {
  let max = 0;
  for (let i = 0; i < vectors[0].length; i++) {
    const xs = vectors.map(v => v[i]);
    max = Math.max(max, Math.max(...xs) - Math.min(...xs));
  }
  return max;
}

async function askArm({ gateway, qtype, arm, subject, pack, asOf }) {
  const questions = buildQuestions(qtype, arm, subject);
  // One as-of window at a time: a new asOf starts a fresh cache, so a long-lived daemon doesn't grow it.
  if (dedupe.get(gateway)?.asOf !== asOf) dedupe.set(gateway, { asOf, map: new Map() });
  const cache = dedupe.get(gateway).map;
  const key = `${qtype}|${arm}|${asOf}|${pack.text}|${JSON.stringify(questions)}`;
  if (cache.has(key)) return { ...cache.get(key), deduped: true };
  const res = await gateway.ask({ qtype, arm, state: pack.text, questions, asOf, stateIds: pack.stateIds });
  if (res.ok) cache.set(key, res);
  return res;
}

/**
 * @param {object} args
 * @param {object} args.view     snapshot view (see state.js)
 * @param {string} args.asOf     decision time; nothing after it is read
 * @param {Array}  args.asks     [{ qtype, subject: {entity_type, entity_id, label, counterparty?, links?} }]
 * @param {object} args.gateway  createJevGateway(...)
 * @param {object} args.sink     { appendEvent, writeState } (ENGINE-00a)
 */
export async function runJevStage({ view, asOf, asks = [], gateway, sink, now = () => Date.now() } = {}) {
  if (!sink?.appendEvent || !sink?.writeState) {
    throw new Error('Jev stage needs the engine sink (appendEvent + writeState from ENGINE-00a)');
  }
  const out = guardSink(sink);
  const at = asOf ?? view?.as_of;

  if (!gateway.hasKey()) {
    const reason = `${KEY_ENV} is not set in the daemon's environment; Jev was not asked and no probability was written`;
    out.writeState({ entity_type: 'engine', entity_id: 'jev', field: 'jev.status', producer: PRODUCER, as_of: at,
      value: { status: 'no_key', reason }, reason_chain: { source: 'jev', text: reason } });
    return { status: 'no_key', reason, results: [] };
  }

  const last = balanceAt.get(gateway);
  if (last == null || now() - last >= BALANCE_EVERY_MS) {
    const b = await gateway.checkBalance();
    balanceAt.set(gateway, now());
    const value = b.status === 'ok'
      ? { balance_usd: b.balance_usd, total_used_usd: b.total_used_usd }
      : { status: b.status, reason: b.reason };
    out.writeState({ entity_type: 'engine', entity_id: 'jev', field: 'jev.balance', producer: PRODUCER, as_of: at,
      value, reason_chain: { source: 'gateway.getCredits', checked_at: b.checked_at } });
  }

  const results = [];
  for (const { qtype, subject } of asks) {
    if (!QUESTION_TYPES[qtype]) throw new Error(`unknown Jev question type "${qtype}"`);
    const gate = askable(qtype, subject);
    if (!gate.ok) {
      results.push({ qtype, subject: subject.entity_id, status: 'not_asked', reason: gate.reason, p: null, action: null,
        weight: WEIGHT, lane: LANE });
      continue;
    }
    const pack = buildJevState(view, { asOf: at, subject });
    const cited = { state_ids: pack.stateIds, event_ids: pack.eventIds };
    const arms = [];
    for (const arm of ARMS) {
      const res = await askArm({ gateway, qtype, arm, subject, pack, asOf: at });
      if (!res.ok) { arms.push({ arm, ok: false, error: res.error, event_id: res.eventId }); continue; }
      const ans = interpret(qtype, res.answers);
      arms.push({ arm, ok: true, ...ans, event_id: res.eventId, deduped: Boolean(res.deduped) });
      if (res.deduped) continue;
      const { vector, ...value } = ans;
      out.writeState({ entity_type: subject.entity_type, entity_id: subject.entity_id, field: `jev.${qtype}.jev_${arm}`,
        producer: PRODUCER, as_of: at,
        value: { ...value, weight: WEIGHT, lane: LANE, question_version: QUESTION_TYPES[qtype].version, model: gateway.model },
        reason_chain: { source: 'jev', jev_call_event_id: res.eventId, ...cited } });
    }

    const good = arms.filter(a => a.ok);
    if (!good.length) {
      results.push({ qtype, subject: subject.entity_id, status: 'error', p: null, action: null, weight: WEIGHT, lane: LANE,
        cited, errors: arms.map(a => a.error) });
      continue;
    }
    const p = good.reduce((s, a) => s + a.p, 0) / good.length;
    const summary = { p, choice: good[0].choice, link: good[0].link };
    if (good.length > 1) {
      const d = spread(good.map(a => a.vector));
      if (d > DISAGREEMENT && !good.every(a => a.deduped)) {
        out.writeState({ entity_type: subject.entity_type, entity_id: subject.entity_id, field: `jev.${qtype}.disagreement`,
          producer: PRODUCER, as_of: at, value: { spread: d, arms: good.map(a => ({ arm: a.arm, p: a.p })), weight: WEIGHT, lane: LANE },
          reason_chain: { source: 'jev', text: `Jev's phrasings disagree by ${d.toFixed(2)}`, ...cited } });
      }
    }
    results.push({ qtype, subject: subject.entity_id, status: 'ok', ...summary, action: recommend(qtype, summary),
      weight: WEIGHT, lane: LANE, cited, arms: good.map(a => ({ arm: a.arm, p: a.p })) });
  }
  return { status: 'ok', results, gateway: gateway.status() };
}
