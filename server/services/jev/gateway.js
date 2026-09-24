/**
 * JEV-01a: the one Jev client.
 *
 * Every Jev call the server makes goes through `ask` here; nothing else under
 * server/ imports `experimental_evaluate` (test/jev-01a-gateway.test.js greps
 * for it). The call path is the one the scripts already use
 * (build-manager-archetypes.mjs:166-172): `ai`'s experimental_evaluate against
 * `typesafe-ai/jev` on the Vercel AI Gateway, authenticated by
 * AI_GATEWAY_API_KEY from the environment. Only the key's presence is ever
 * read here; its value is never logged.
 *
 * Every call, ok or not, appends one `jev_call` engine event: prompt hash,
 * question type + version, model, input tokens, cost, latency, the ai_usage row
 * id, ok/error. Cost goes to ai_usage through claude.js `recordUsage` with
 * feature `jev:<qtype>`, priced from llm-budget.js PRICING.
 *
 * There is NO spend cap (Nick, 9/23: "idc about JEV limits"), so this never
 * calls `reserveBudget`. The brake is the runaway monitor: it raises a
 * `jev_runaway` event and a status line, and never blocks a call.
 */
import crypto from 'node:crypto';
import { row } from '../../db/index.js';
import { recordUsage as recordUsageRow } from '../claude.js';
import { costOfUsage } from '../llm-budget.js';
import { QUESTION_TYPES } from './questions.js';

export const JEV_MODEL = 'typesafe-ai/jev';
export const KEY_ENV = 'AI_GATEWAY_API_KEY';

const HOUR = 3_600_000;
const TEN_MIN = 600_000;
const WEEK = 7 * 24 * HOUR;
export const RUNAWAY = Object.freeze({ rateMultiple: 5, repeatMax: 3, balanceHours: 24 });

export const promptHash = (model, state, questions) =>
  crypto.createHash('sha256').update(JSON.stringify({ model, state, questions })).digest('hex');

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Runaway detection over this process's own send log. `medianPerHour` defaults
 * to the trailing-7-day hourly median of that log (hours with no calls count
 * as 0 once the daemon has been up that long); inject one that reads
 * engine_events once ENGINE-00a lands.
 */
export function createRunawayMonitor({ now = () => Date.now(), medianPerHour } = {}) {
  const sends = []; // { t, hash, costUsd }
  const startedAt = now();
  const trailingMedian = medianPerHour ?? (() => {
    const t = now();
    const hours = Math.max(1, Math.min(168, Math.floor((t - startedAt) / HOUR)));
    const buckets = new Array(hours).fill(0);
    for (const s of sends) {
      const h = Math.floor((t - s.t) / HOUR);
      if (h >= 1 && h <= hours) buckets[h - 1]++;
    }
    return median(buckets);
  });

  return {
    recordSend({ hash, costUsd = 0 }) {
      const t = now();
      sends.push({ t, hash, costUsd });
      while (sends.length && t - sends[0].t > WEEK) sends.shift();
    },
    /** Reasons this moment looks like a runaway; empty when it doesn't. Never throws, never blocks. */
    check({ balanceUsd = null } = {}) {
      const t = now();
      const reasons = [];
      const lastHour = sends.filter(s => t - s.t <= HOUR);
      const base = Math.max(1, trailingMedian());
      if (lastHour.length > RUNAWAY.rateMultiple * base) {
        reasons.push({ kind: 'rate', calls_last_hour: lastHour.length, trailing_median_per_hour: base,
          text: `${lastHour.length} Jev calls in the last hour vs a trailing median of ${base}/h` });
      }
      const recent = sends.filter(s => t - s.t <= TEN_MIN);
      const byHash = new Map();
      for (const s of recent) byHash.set(s.hash, (byHash.get(s.hash) ?? 0) + 1);
      for (const [hash, n] of byHash) {
        if (n > RUNAWAY.repeatMax) {
          reasons.push({ kind: 'repeat_hash', prompt_hash: hash, count: n,
            text: `the same Jev prompt was sent ${n} times in 10 minutes` });
        }
      }
      const spendPerHour = lastHour.reduce((a, s) => a + (s.costUsd ?? 0), 0);
      if (Number.isFinite(balanceUsd) && spendPerHour > 0) {
        const hoursToZero = balanceUsd / spendPerHour;
        if (hoursToZero <= RUNAWAY.balanceHours) {
          reasons.push({ kind: 'balance', balance_usd: balanceUsd, spend_per_hour_usd: spendPerHour,
            hours_to_zero: hoursToZero, text: `Jev balance $${balanceUsd.toFixed(2)} runs out in ~${hoursToZero.toFixed(1)}h at this pace` });
        }
      }
      return reasons;
    },
  };
}

const defaultEvaluate = async args => (await import('ai')).experimental_evaluate(args);

/** `gateway.getCredits()` if the installed @ai-sdk/gateway exposes it; null when it doesn't. */
async function defaultGetCredits() {
  const mod = await import('@ai-sdk/gateway');
  if (typeof mod.gateway?.getCredits !== 'function') return null;
  return mod.gateway.getCredits();
}

function defaultRecordUsage(feature, model, usage) {
  const cost = recordUsageRow(feature, model, usage);
  return { cost, id: row('SELECT last_insert_rowid() AS id')?.id ?? null };
}

const toUsd = v => (v == null || v === '' ? null : Number(v));

/**
 * @param {object} deps
 * @param {Function} [deps.evaluate]     experimental_evaluate stand-in (tests inject; default imports `ai` lazily)
 * @param {Function} [deps.getCredits]   () => {balance, totalUsed} | null
 * @param {Function} [deps.recordUsage]  (feature, model, usage) => {cost, id}
 * @param {object}   deps.sink           { appendEvent({type, as_of, payload}) } — the engine event log
 */
export function createJevGateway({
  evaluate = defaultEvaluate, getCredits = defaultGetCredits, recordUsage = defaultRecordUsage,
  sink, env = process.env, now = () => Date.now(), runaway = createRunawayMonitor({ now }), model = JEV_MODEL,
} = {}) {
  if (!sink?.appendEvent) throw new Error('Jev gateway needs an engine sink with appendEvent');
  let balance = { balance_usd: null, total_used_usd: null, checked_at: null, status: 'unchecked' };
  let lastAlert = { text: null, at: null };
  const alerted = new Map(); // kind(+hash) -> last alert ms, so one runaway raises one event an hour

  function raiseRunaway(asOf) {
    const reasons = runaway.check({ balanceUsd: balance.balance_usd });
    const t = now();
    const fresh = reasons.filter(r => {
      const key = r.kind === 'repeat_hash' ? `${r.kind}:${r.prompt_hash}` : r.kind;
      if (alerted.has(key) && t - alerted.get(key) < HOUR) return false;
      alerted.set(key, t);
      return true;
    });
    if (!fresh.length) return;
    lastAlert = { text: fresh.map(r => r.text).join('; '), at: new Date(t).toISOString() };
    sink.appendEvent({ type: 'jev_runaway', as_of: asOf ?? lastAlert.at, payload: { reasons: fresh } });
  }

  return {
    model,
    hasKey: () => Boolean(env[KEY_ENV]),

    /** Read the gateway balance. A failure is returned typed, never thrown away. */
    async checkBalance() {
      const at = new Date(now()).toISOString();
      try {
        const c = await getCredits();
        if (!c) balance = { balance_usd: null, total_used_usd: null, checked_at: at, status: 'unsupported',
          reason: '@ai-sdk/gateway does not expose getCredits' };
        else balance = { balance_usd: toUsd(c.balance), total_used_usd: toUsd(c.totalUsed ?? c.total_used), checked_at: at, status: 'ok' };
      } catch (err) {
        balance = { balance_usd: null, total_used_usd: null, checked_at: at, status: 'unavailable',
          reason: String(err?.message ?? err).slice(0, 200) };
      }
      return balance;
    },

    /**
     * One Jev call. Returns { ok:true, answers, usage, costUsd, eventId, usageId, promptHash }
     * or { ok:false, error, eventId }. Never throws for a gateway failure.
     */
    async ask({ qtype, arm, state, questions, asOf, stateIds = [] }) {
      const spec = QUESTION_TYPES[qtype];
      if (!spec) throw new Error(`unknown Jev question type "${qtype}"`);
      const hash = promptHash(model, state, questions);
      const base = { qtype, question_version: spec.version, arm, model, prompt_hash: hash, state_ids: stateIds };
      if (!env[KEY_ENV]) {
        const eventId = sink.appendEvent({ type: 'jev_call', as_of: asOf,
          payload: { ...base, ok: 0, error: `no_key: ${KEY_ENV} is not set`, input_tokens: 0, cost_usd: 0, latency_ms: 0, ai_usage_id: null } });
        return { ok: false, error: 'no_key', eventId };
      }
      const t0 = now();
      let result;
      try {
        result = await evaluate({ model, state, questions });
      } catch (err) {
        runaway.recordSend({ hash, costUsd: 0 });
        const status = err?.statusCode ?? err?.status ?? null;
        const error = `${status ? `${status} ` : ''}${String(err?.message ?? err)}`.slice(0, 300);
        const eventId = sink.appendEvent({ type: 'jev_call', as_of: asOf,
          payload: { ...base, ok: 0, error, input_tokens: 0, cost_usd: 0, latency_ms: now() - t0, ai_usage_id: null } });
        raiseRunaway(asOf);
        return { ok: false, error, eventId };
      }
      const latency = now() - t0;
      const inputTokens = result?.usage?.inputTokens ?? 0;
      const outputTokens = result?.usage?.outputTokens ?? 0;
      const usage = { input_tokens: inputTokens, output_tokens: outputTokens };
      const { cost, id: usageId } = recordUsage(`jev:${qtype}`, model, usage);
      const costUsd = cost ?? costOfUsage(model, usage);
      runaway.recordSend({ hash, costUsd });
      const eventId = sink.appendEvent({ type: 'jev_call', as_of: asOf,
        payload: { ...base, ok: 1, error: null, input_tokens: inputTokens, output_tokens: outputTokens,
          cost_usd: costUsd, latency_ms: latency, ai_usage_id: usageId } });
      raiseRunaway(asOf);
      return { ok: true, answers: result.answers, usage, costUsd, eventId, usageId, promptHash: hash };
    },

    status: () => ({ key: Boolean(env[KEY_ENV]) ? 'present' : 'absent', balance, runaway: lastAlert.text, runaway_at: lastAlert.at }),
  };
}
