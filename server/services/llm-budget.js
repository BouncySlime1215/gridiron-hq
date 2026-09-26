/**
 * The cost side of every Claude call: what each model costs, what a call cost,
 * what each feature has spent today, and the per-feature daily budgets that stop
 * a feature before it overspends.
 *
 * claude.js#callClaude is the one place a budget is enforced — it reserves the
 * pending call's worst-case cost here before anything is sent, then records the
 * true cost (claude.js#recordUsage) and releases the hold. Everything else here
 * only reads.
 *
 * Budget keys: a call's feature name up to the first colon. `coach`,
 * `coach:answer` and `coach:route` all draw on the `coach` budget. A feature with
 * no default and no setting has no budget ("others unchanged").
 *
 * One family is an exception, and `budgetScopeFor` is where it is written down:
 * `trade_proposals` is budgeted PER LEAGUE, so `trade_proposals:league-4` holds
 * its own $0.50 a day. Its scopes are separate questions about separate leagues,
 * and sharing one pot meant the first league opened each day could spend it all.
 *
 * The day is the server's local calendar day (Nick's), not UTC, so "today's
 * Coach budget" resets at his midnight.
 */
import { db, rows, row, run } from '../db/index.js';

// $ per million tokens. Source: platform.claude.com/docs/en/about-claude/pricing,
// checked 2026-09-18 (Sonnet 5's $2/$10 is now its standard price, not an
// introductory one). Cache writes are 1.25x input for the 5-minute TTL and 2x for
// the 1-hour TTL; cache reads are 0.1x input.
const SONNET_5 = Object.freeze({ in: 2.00, out: 10.00, cache_write_5m: 2.50, cache_write_1h: 4.00, cache_read: 0.20 });
const HAIKU_4_5 = Object.freeze({ in: 1.00, out: 5.00, cache_write_5m: 1.25, cache_write_1h: 2.00, cache_read: 0.10 });
// COACH-CHAT (2026-09-25): Opus 5.5 for deep trade analysis. $4/$20, cache reads $0.20 (Claude API
// model table); writes by the same 1.25x / 2x rule as the others.
const OPUS_5_5 = Object.freeze({ in: 4.00, out: 20.00, cache_write_5m: 5.00, cache_write_1h: 8.00, cache_read: 0.20 });

/**
 * Every model the app may call, and nothing else: a model missing here is
 * refused before the call (claude.js), never priced at some other model's rate —
 * that silent fallback is how 35 Sonnet 5 calls were logged at Haiku prices.
 */
export const PRICING = Object.freeze({
  'claude-sonnet-5': SONNET_5,
  'claude-opus-5-5': OPUS_5_5,
  'claude-haiku-4-5-20251001': HAIKU_4_5,
  'claude-haiku-4-5': HAIKU_4_5
});

export const DEFAULT_DAILY_BUDGETS_USD = Object.freeze({ coach: 1.00, trade_proposals: 0.50 });
const LABELS = Object.freeze({ coach: 'Coach', trade_proposals: 'trade proposals' });
const SETTING_PREFIX = 'llm_daily_budget_usd:';
/** A typo guard for the settings hook, not a policy: no feature here needs more than this a day. */
export const MAX_DAILY_BUDGET_USD = 100;
const BUDGET_KEY_RE = /^[a-z0-9_-]{1,64}$/;

/**
 * Characters per token used to estimate a pending call's input. English prose
 * runs ~3-4 characters per token, but number-dense packets — which is what the
 * Coach's situation brief and the trade contexts are — run far denser: the live
 * cache check on 2026-09-18 billed 5,444 Sonnet 5 input tokens for ~12,650
 * characters (2.3 per token). 2 keeps the estimate at or above the bill for
 * those, and over-estimates prose, which only makes the cap stricter. This
 * number only gates a call; the logged cost is the API's own count.
 */
const CHARS_PER_TOKEN_ESTIMATE = 2;
/** Tool definitions add a hidden tool-use system prompt (354-588 tokens across these models). */
const TOOL_SYSTEM_PROMPT_TOKENS = 600;

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

export function priceFor(model) {
  return typeof model === 'string' && Object.hasOwn(PRICING, model) ? PRICING[model] : null;
}

/** The model's prices, or a thrown "No price for model …" (status 500). */
export function requirePrice(model) {
  const price = priceFor(model);
  if (!price) {
    throw httpError(`No price for model ${model} — add its rates to PRICING in server/services/llm-budget.js before calling it.`, 500);
  }
  return price;
}

const tokens = v => (Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Dollar cost of one call from the API's `usage` block (or an ai_usage row,
 * which uses the same field names). `input_tokens` is the uncached remainder;
 * cache reads and writes are billed separately. When the API reports the
 * 5-minute/1-hour split of cache writes, each is priced at its own rate;
 * otherwise writes are taken as 5-minute (the default TTL).
 */
export function costOfUsage(model, usage = {}) {
  const price = requirePrice(model);
  const cacheWrites = tokens(usage.cache_creation_input_tokens);
  const oneHourWrites = Math.min(cacheWrites, tokens(usage.cache_creation?.ephemeral_1h_input_tokens));
  const fiveMinuteWrites = cacheWrites - oneHourWrites;
  return (tokens(usage.input_tokens) * price.in
    + tokens(usage.output_tokens) * price.out
    + tokens(usage.cache_read_input_tokens) * price.cache_read
    + fiveMinuteWrites * price.cache_write_5m
    + oneHourWrites * price.cache_write_1h) / 1e6;
}

/** The original (model, input, output) signature, kept for existing callers. */
export const costOf = (model, inTok, outTok) => costOfUsage(model, { input_tokens: inTok, output_tokens: outTok });

/**
 * Cost of an ai_usage row: the stored cost when the writer recorded one,
 * otherwise priced by model (rows from a process still running pre-057 code).
 * Null only for a model with no price, which callers report rather than guess.
 */
export function rowCostUsd(r) {
  if (r.cost_usd != null) return r.cost_usd;
  return priceFor(r.model) ? costOfUsage(r.model, r) : null;
}

/**
 * Upper-leaning estimate of what a request can cost: its whole serialized body
 * as input (at the cache-write rate when it asks for caching, since a cold
 * cache writes) plus `maxTokens` of output — output, thinking included, cannot
 * exceed max_tokens.
 */
export function estimateCallCostUsd({ model, maxTokens, request, cacheTtl = null }) {
  const price = requirePrice(model);
  const inputTokens = Math.ceil(JSON.stringify(request ?? '').length / CHARS_PER_TOKEN_ESTIMATE)
    + (request?.tools?.length ? TOOL_SYSTEM_PROMPT_TOKENS : 0);
  const inputRate = cacheTtl === '1h' ? price.cache_write_1h : cacheTtl ? price.cache_write_5m : price.in;
  return (inputTokens * inputRate + tokens(maxTokens) * price.out) / 1e6;
}

// ---------------------------------------------------------------- budgets

/** The FAMILY a feature belongs to: its name up to the first colon. */
export const budgetKeyFor = feature => String(feature ?? '').split(':')[0];

/**
 * Families whose allowance is per scope rather than shared across the family.
 *
 * `trade_proposals` is the one, because its scope is a league and its five
 * leagues are five unrelated questions: one league's slate being written up is
 * no reason for another league's page to go empty. Every other feature keeps the
 * family behaviour exactly — `coach` and `coach:answer` still draw on one $1 a
 * day, and a feature listed nowhere still has no budget at all.
 */
const PER_SCOPE_BUDGET_FAMILIES = Object.freeze(new Set(['trade_proposals']));

/**
 * The key a call's allowance is actually held and counted against: the family
 * for everything, EXCEPT a per-scope family, which gets `family:scope`.
 *
 * This is the per-league budget fix of 2026-09-19. `reserveBudget` used
 * `budgetKeyFor`, so `trade_proposals:league-1` … `league-5` all drew on one
 * $0.50 a day — the first league to be opened could spend the lot and the other
 * four got a budget refusal they had done nothing to earn. `budgetKeyFor` itself
 * is unchanged, because it is what answers "which budget setting is this?" and
 * `trade_proposals` is still that setting. Only the pot is per league.
 *
 * `family:scope` and nothing deeper: `trade_proposals:league-4:retry` shares
 * league 4's allowance rather than minting a sixth pot.
 */
export function budgetScopeFor(feature) {
  const name = String(feature ?? '');
  const family = budgetKeyFor(name);
  if (!PER_SCOPE_BUDGET_FAMILIES.has(family)) return family;
  const scope = name.slice(family.length + 1).split(':')[0];
  return scope ? `${family}:${scope}` : family;
}

/** `trade proposals (league 4)` — a scope wears its family's label plus its own name. */
function labelFor(key) {
  if (Object.hasOwn(LABELS, key)) return LABELS[key];
  const family = budgetKeyFor(key);
  if (family === key || !Object.hasOwn(LABELS, family)) return key;
  return `${LABELS[family]} (${key.slice(family.length + 1).replace(/^league-/, 'league ')})`;
}

function validateKey(key) {
  if (typeof key !== 'string' || !BUDGET_KEY_RE.test(key)) {
    throw httpError('A budget key is a feature name: lowercase letters, digits, "_" or "-", up to 64 characters.', 400);
  }
  return key;
}

/** The setting for one key, as dollars, or null when Nick has not set one. */
function settingFor(k) {
  const stored = row('SELECT value FROM app_settings WHERE key = ?', SETTING_PREFIX + k)?.value;
  if (stored == null) return null;
  const usd = Number(stored);
  if (!Number.isFinite(usd) || usd < 0) {
    // Only a hand edit can put this here (setDailyBudget validates); refusing
    // loudly beats silently running without the cap Nick set.
    throw httpError(`The daily budget setting ${SETTING_PREFIX + k} holds "${stored}", which is not a dollar amount — fix or clear it in Settings.`, 500);
  }
  return usd;
}

/**
 * `{key, label, budget_usd, source}`; source is 'setting', 'default' or 'none'
 * (budget_usd null).
 *
 * A per-scope key (`trade_proposals:league-4`) has no setting of its own — the
 * settings hook takes family names only — so it inherits its family's amount and
 * gets THAT MUCH EACH. Raising `trade_proposals` to $0.75 raises every league to
 * $0.75, which is the only reading of "the daily trade-proposals budget" that
 * does not depend on how many leagues Nick happens to have.
 */
export function getDailyBudget(key) {
  const k = String(key);
  const label = labelFor(k);
  const own = settingFor(k);
  if (own != null) return { key: k, label, budget_usd: own, source: 'setting' };
  if (Object.hasOwn(DEFAULT_DAILY_BUDGETS_USD, k)) {
    return { key: k, label, budget_usd: DEFAULT_DAILY_BUDGETS_USD[k], source: 'default' };
  }
  const family = budgetKeyFor(k);
  if (family !== k && PER_SCOPE_BUDGET_FAMILIES.has(family)) {
    const inherited = settingFor(family);
    if (inherited != null) return { key: k, label, budget_usd: inherited, source: 'setting' };
    if (Object.hasOwn(DEFAULT_DAILY_BUDGETS_USD, family)) {
      return { key: k, label, budget_usd: DEFAULT_DAILY_BUDGETS_USD[family], source: 'default' };
    }
  }
  return { key: k, label, budget_usd: null, source: 'none' };
}

/**
 * The settings hook: set a feature's daily budget in dollars (0 turns the
 * feature off), or pass null to go back to its default. Persists in
 * app_settings; takes effect on the next call.
 */
export function setDailyBudget(key, usd) {
  validateKey(key);
  if (usd == null) {
    run('DELETE FROM app_settings WHERE key = ?', SETTING_PREFIX + key);
    return getDailyBudget(key);
  }
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 || usd > MAX_DAILY_BUDGET_USD) {
    throw httpError(`A daily budget is a dollar amount from 0 to ${MAX_DAILY_BUDGET_USD}.`, 400);
  }
  run(`INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`, SETTING_PREFIX + key, String(usd));
  return getDailyBudget(key);
}

/** Dollars recorded today (local day) against a budget key: `key` itself and every `key:*` feature. */
export function spentTodayUsd(key) {
  const k = String(key);
  const today = rows(`SELECT model, cost_usd, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
                      FROM ai_usage
                      WHERE created_at >= datetime('now', 'localtime', 'start of day', 'utc')
                        AND (feature = ? OR substr(feature, 1, ?) = ?)`, k, k.length + 1, `${k}:`);
  return today.reduce((sum, r) => sum + (rowCostUsd(r) ?? 0), 0);
}

function resetsAt() {
  const t = row(`SELECT datetime('now', 'localtime', 'start of day', '+1 day', 'utc') AS t`).t;
  return `${t.replace(' ', 'T')}Z`;
}

/** Dollars held by calls in flight, per budget key (this process). */
const held = new Map();

export function budgetStatus(key) {
  const { key: k, label, budget_usd, source } = getDailyBudget(key);
  const spent = spentTodayUsd(k);
  const reserved = held.get(k) ?? 0;
  return {
    key: k, label, budget_usd, source,
    spent_usd: spent,
    reserved_usd: reserved,
    remaining_usd: budget_usd == null ? null : Math.max(0, budget_usd - spent - reserved),
    resets_at: resetsAt()
  };
}

/**
 * Every default budget plus every feature Nick has set one for, with today's
 * spend — and one row per per-scope pot that has actually been spent against
 * today, since that pot, not the family, is what a call is held against. Without
 * those rows the Dev Hub showed five leagues' trade-proposal spend against one
 * league's $0.50 and read as permanently overdrawn.
 */
export function listBudgets() {
  const configured = rows('SELECT key FROM app_settings WHERE key LIKE ?', `${SETTING_PREFIX}%`)
    .map(r => r.key.slice(SETTING_PREFIX.length));
  const scopedToday = rows(`SELECT DISTINCT feature FROM ai_usage
                            WHERE created_at >= datetime('now', 'localtime', 'start of day', 'utc')`)
    .map(r => budgetScopeFor(r.feature))
    .filter(k => k.includes(':'));
  const keys = [...new Set([...Object.keys(DEFAULT_DAILY_BUDGETS_USD), ...configured, ...scopedToday])].sort();
  return keys.map(budgetStatus);
}

const usd = v => `$${v.toFixed(2)}`;

export class LlmBudgetError extends Error {
  constructor({ key, label, budgetUsd, spentUsd, reservedUsd, estimateUsd, resetsAtIso }) {
    const committed = spentUsd + reservedUsd;
    const detail = committed < budgetUsd
      ? ` — ${usd(budgetUsd - committed)} is left and this request could cost up to ${usd(estimateUsd)}`
      : '';
    super(`Today's ${label} budget is used (${usd(committed)} of ${usd(budgetUsd)}${detail}). `
      + 'It resets at midnight, or you can raise it in Settings.');
    this.name = 'LlmBudgetError';
    this.status = 429;
    this.code = 'LLM_BUDGET_EXHAUSTED';
    this.feature = key;
    this.budget_usd = budgetUsd;
    this.spent_usd = spentUsd;
    this.reserved_usd = reservedUsd;
    this.estimate_usd = estimateUsd;
    this.resets_at = resetsAtIso;
  }
}

/**
 * Hold `estimateUsd` against the call's budget, or throw LlmBudgetError if
 * today's spend + calls in flight + this call would pass it. Returns the
 * release function; call it once the real cost is recorded (or the call
 * failed). Unbudgeted features get a no-op release.
 */
export function reserveBudget(feature, estimateUsd) {
  // The pot, which for a per-scope family is this league's own (budgetScopeFor).
  const key = budgetScopeFor(feature);
  const { label, budget_usd: budgetUsd } = getDailyBudget(key);
  if (budgetUsd == null) return () => {};
  const spentUsd = spentTodayUsd(key);
  const reservedUsd = held.get(key) ?? 0;
  if (spentUsd + reservedUsd + estimateUsd > budgetUsd + 1e-12) {
    throw new LlmBudgetError({ key, label, budgetUsd, spentUsd, reservedUsd, estimateUsd, resetsAtIso: resetsAt() });
  }
  held.set(key, reservedUsd + estimateUsd);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (held.get(key) ?? 0) - estimateUsd;
    if (left > 1e-12) held.set(key, left);
    else held.delete(key);
  };
}

// ---------------------------------------------------------------- one-off correction

const TABLE_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The 2026-09-18 correction: back ai_usage up to `backupTable` (once — an
 * existing backup is never replaced), then set every priced row's cost_usd from
 * its tokens at today's PRICING. Rows for an unpriced model keep their cost and
 * are listed in `unpriced`. Assumes 5-minute cache writes (the table does not
 * keep the TTL split), which is exact for every row written before this change.
 * `previously_reported_usd` is what the old reporting showed: every row at
 * Haiku 4.5's input/output rates.
 */
export function recomputeUsageCosts({ backupTable = 'ai_usage_backup_20260918' } = {}) {
  if (typeof backupTable !== 'string' || !TABLE_NAME_RE.test(backupTable) || backupTable === 'ai_usage') {
    throw httpError(`Invalid backup table name: ${String(backupTable)}`, 400);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const exists = row(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, backupTable);
    if (!exists) db.exec(`CREATE TABLE ${backupTable} AS SELECT * FROM ai_usage`);
    const all = rows(`SELECT id, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
                      FROM ai_usage ORDER BY id`);
    const update = db.prepare('UPDATE ai_usage SET cost_usd = ? WHERE id = ?');
    const byModel = {};
    const unpriced = {};
    let updated = 0;
    let totalAfter = 0;
    let previouslyReported = 0;
    for (const r of all) {
      previouslyReported += costOfUsage('claude-haiku-4-5-20251001', { input_tokens: r.input_tokens, output_tokens: r.output_tokens });
      if (!priceFor(r.model)) {
        unpriced[r.model] = (unpriced[r.model] ?? 0) + 1;
        continue;
      }
      const cost = costOfUsage(r.model, r);
      update.run(cost, r.id);
      updated++;
      totalAfter += cost;
      const m = (byModel[r.model] ??= { rows: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 });
      m.rows++;
      m.input_tokens += tokens(r.input_tokens);
      m.output_tokens += tokens(r.output_tokens);
      m.cost_usd += cost;
    }
    const backupRows = row(`SELECT COUNT(*) AS n FROM ${backupTable}`).n;
    db.exec('COMMIT');
    return {
      backup: { table: backupTable, created: !exists, rows: backupRows },
      rows_updated: updated,
      unpriced: Object.entries(unpriced).map(([model, n]) => ({ model, rows: n })),
      total_after_usd: totalAfter,
      previously_reported_usd: previouslyReported,
      by_model: byModel
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
