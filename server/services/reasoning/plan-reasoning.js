/**
 * FIX-08: reasoning goes into the plan, one writer.
 *
 * The campaign producer (scripts/campaign/produce-plans.mjs) is the only
 * writer of the War Room plans file. After it plans every league and before
 * its atomic write, it hands the whole file to applyReasoning(), which writes
 * one typed field into every deck move: `move.reasoning`
 * (plans-schema.js `reasoning`: case_for, his_side, devils_advocate,
 * news_check, confidence, counter, cites[], check_first). The deck head is
 * also `next_move`, and it gets the same field.
 *
 * Two gates, both required, decided by the caller and passed in:
 *   enabled  reasoning-flag.js#reasoningFlag (its own switch, or preview)
 *   paid     scripts/paid-run-optin.mjs (GRIDIRON_ALLOW_PAID_RUN)
 * With either off no call is made and every move's reasoning is 'unknown'
 * with the reason, so the War Room can say why the panel is missing.
 *
 * The panels themselves (reasoning/produce.js output) are kept next to the
 * plans file as panels.json. That file is the reuse cache only: an unchanged
 * move_id with unchanged inputs reuses its panel and costs nothing. Nothing
 * reads it for display.
 */
import fs from 'node:fs';
import path from 'node:path';
import { produceReasoning as liveProduceReasoning } from './produce.js';
import { MODEL_SECTIONS, REASON_FOR } from './panel.js';
import { leagueIdOf } from './cards.js';
import { REASONING_SLOTS } from '../campaign/plans-schema.js';

export const REASONING_SOURCE = 'coach.text';
export const PANELS_CACHE = 'panels.json';

export const REASON_OFF = 'Reasoning panels are off for this run.';
export const REASON_UNPAID = 'Reasoning panels need a paid run, and this run was not allowed to spend.';
export const REASON_STEP_FAILED = 'The reasoning step failed, so no panel was written.';
export const REASON_ALL_UNGROUNDED = 'Every section of this panel failed its fact check, so it is hidden.';
export const REASON_NOT_COVERED = 'This move was not in the deck the reasoning covered.';

/** Where the reuse cache lives: next to the plans file, never under server/data. */
export const panelsCachePath = plansFile => path.join(path.dirname(path.resolve(plansFile)), PANELS_CACHE);

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const okValue = f => (isObj(f) && f.status === 'ok' ? f.value : undefined);

function typed(status, { value, reason, asOf }) {
  const f = { status, source: REASONING_SOURCE };
  if (status === 'ok') f.value = value;
  else f.reason = reason;
  if (asOf && Number.isFinite(Date.parse(asOf))) f.as_of = asOf;
  return f;
}

/** Every move a panel belongs to, per league entry: the deck, and its head again as next_move. */
function eachMove(plans, visit) {
  for (const entry of Array.isArray(plans?.leagues) ? plans.leagues : []) {
    if (!isObj(entry) || entry.error !== undefined) continue;
    const deck = okValue(entry.alternatives);
    for (const move of Array.isArray(deck) ? deck : []) if (isObj(move)) visit(move, entry);
    const next = okValue(entry.next_move);
    if (isObj(next)) visit(next, entry);
  }
}

const texts = claims => (Array.isArray(claims) ? claims.map(c => c?.text).filter(t => typeof t === 'string' && t.trim()) : []);

/** One section of a produce.js panel, as the sentence the contract slot carries. */
function slotText(name, section) {
  if (!section || !['ok', 'thin'].includes(section.status)) return section?.reason ?? 'Not written.';
  const v = section.value ?? {};
  switch (name) {
    case 'case_for':
    case 'his_side':
      return texts(v.claims).join(' ');
    case 'devils_advocate': {
      const change = texts(v.would_change);
      return [...texts(v.claims), ...(change.length ? [`What would change it: ${change.join(' ')}`] : [])].join(' ');
    }
    case 'news_check': {
      const hits = texts((v.contradictions ?? []).map(c => c?.claim));
      if (hits.length) return hits.join(' ');
      return v.checked ? 'The news from the last two days does not contradict the plan.'
        : 'No news on these players in the last two days.';
    }
    case 'counter':
      return [v.likely?.text, v.answer?.text].filter(Boolean).join(' ');
    case 'confidence':
      return v.why ?? section.reason ?? 'Not written.';
    default:
      return 'Not written.';
  }
}

function citesOf(panel) {
  const out = new Set();
  const add = claims => { for (const c of Array.isArray(claims) ? claims : []) for (const id of c?.cites ?? []) out.add(String(id)); };
  for (const s of Object.values(panel.sections ?? {})) {
    if (!['ok', 'thin'].includes(s?.status)) continue;
    const v = s.value ?? {};
    add(v.claims); add(v.would_change);
    add((v.contradictions ?? []).map(c => c?.claim));
    add([v.likely, v.answer].filter(Boolean));
  }
  return [...out];
}

/** A produce.js panel -> the contract's `reasoning` typed field. */
export function panelToField(panel, asOf) {
  const written = MODEL_SECTIONS.some(n => panel.sections?.[n]?.status === 'ok');
  if (!written) {
    if (panel.missing === 'failed_call' || panel.missing === 'unparsed') {
      return typed('failed', { reason: REASON_FOR[panel.missing], asOf });
    }
    if (panel.missing) return typed('unknown', { reason: REASON_FOR[panel.missing] ?? REASON_NOT_COVERED, asOf });
    return typed('failed', { reason: REASON_ALL_UNGROUNDED, asOf });
  }
  const value = Object.fromEntries(REASONING_SLOTS.map(n => [n, slotText(n, panel.sections?.[n]) || 'Not written.']));
  value.cites = citesOf(panel);
  value.check_first = panel.check_first === true;
  return typed('ok', { value, asOf });
}

/** Set every move's reasoning to one not-ok field. */
function markAll(plans, status, reason, asOf) {
  let moves = 0;
  eachMove(plans, move => { move.reasoning = typed(status, { reason, asOf }); moves += 1; });
  return moves;
}

/**
 * Write `reasoning` into every move of `plans` (mutated in place).
 *
 * @param {object} args
 * @param {object} args.plans           the plans file about to be written (contract shape)
 * @param {{enabled: boolean, paid: boolean}} args.gates
 * @param {object} [args.previous]      the last panels.json, for reuse
 * @param {object} [args.news]          news per league id (produce.js)
 * @param {boolean} [args.dryRun]       build every prompt, make no call (the paid gate does not apply)
 * @returns {Promise<{status: 'off'|'unpaid'|'ran'|'failed', reason?: string, error?: string,
 *   moves: number, cache: object|null, calls: object[], total_cost_usd: number, reused: number}>}
 */
export async function applyReasoning({ plans, gates, previous = null, news, dryRun = false,
  produceReasoning = liveProduceReasoning, ...rest }) {
  const asOf = plans?.generated_at;
  const none = { cache: null, calls: [], total_cost_usd: 0, reused: 0 };
  if (!gates?.enabled) return { status: 'off', reason: REASON_OFF, moves: markAll(plans, 'unknown', REASON_OFF, asOf), ...none };
  if (!gates.paid && !dryRun) return { status: 'unpaid', reason: REASON_UNPAID, moves: markAll(plans, 'unknown', REASON_UNPAID, asOf), ...none };

  let result;
  try {
    result = await produceReasoning({ plans: { as_of: asOf, leagues: plans.leagues ?? [] }, previous, news, dryRun, ...rest });
  } catch (e) {
    // Handled, not swallowed: every move says the step failed, and the caller logs `error`.
    return { status: 'failed', reason: REASON_STEP_FAILED, error: String(e?.message ?? e),
      moves: markAll(plans, 'failed', REASON_STEP_FAILED, asOf), ...none };
  }

  const byKey = new Map();
  for (const l of result.leagues) for (const p of l.panels) byKey.set(`${l.league_id}|${p.card_id}`, p);
  let moves = 0;
  eachMove(plans, (move, entry) => {
    const panel = byKey.get(`${leagueIdOf(entry)}|${move.move_id}`);
    move.reasoning = panel ? panelToField(panel, asOf) : typed('unknown', { reason: REASON_NOT_COVERED, asOf });
    moves += 1;
  });
  const panels = result.leagues.flatMap(l => l.panels);
  return { status: 'ran', moves, cache: result, calls: result.calls, total_cost_usd: result.total_cost_usd,
    reused: panels.filter(p => p.cost?.reused).length };
}

/** The last panels.json: absent -> null; unreadable -> null with a warning (one re-spend, never a crash). */
export function readPanelsCache(file) {
  if (!fs.existsSync(file)) return { previous: null, warning: null };
  try {
    return { previous: JSON.parse(fs.readFileSync(file, 'utf8')), warning: null };
  } catch (e) {
    return { previous: null, warning: `previous panels at ${file} could not be read (${e.message}); every move is rewritten` };
  }
}

/** Atomic write of the reuse cache. */
export function writePanelsCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
