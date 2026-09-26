#!/usr/bin/env node
/**
 * COACH-V2 judge: the 60-question set (judge-questions.json) through Coach's real chat
 * path, then a Haiku grader on the rubric. Reusable for every COACH-V2 unit.
 *
 *   node --env-file=<.env with the Anthropic key> scripts/coach/judge-eval.mjs \
 *     --out <dir> --label after [--root <repo checkout to import Coach from>] [--limit N] [--intents DO,WHY]
 *
 * Needs GRIDIRON_DB_PATH (a COPY of the app DB: this writes threads, audits and ai_usage)
 * and the War Room plans path (server/services/warroom-flag.js). Each question gets a fresh thread (its own user id), so no
 * focus carries between questions. SPENDS REAL MONEY: about $0.02-0.06 a question plus
 * ~$0.001 of grading. Writes <out>/judge-<label>.json (per question) and prints a summary:
 *
 *   catalog_lookup rounds per turn (median), model calls, p50 latency, $ per question and per
 *   DO question, verified answers, format compliance and "answers the question" by rubric.
 *
 * The rendered answer (what the drawer shows) is what the grader reads. Answers contain the
 * league's names: keep the output file local, never commit it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const ROOT = path.resolve(arg('root', path.join(HERE, '..', '..')));
const OUT = arg('out');
const LABEL = arg('label', 'run');
const LIMIT = Number(arg('limit', 0)) || null;
const ONLY = arg('intents') ? new Set(arg('intents').split(',')) : null;
if (!OUT) { console.error('--out <dir> is required'); process.exit(2); }
if (!process.env.GRIDIRON_DB_PATH) { console.error('GRIDIRON_DB_PATH must point at a copy of the app DB'); process.exit(2); }
const imp = rel => import(pathToFileURL(path.join(ROOT, rel)).href);

const SET = JSON.parse(fs.readFileSync(path.join(HERE, 'judge-questions.json'), 'utf8'));
const { run } = await imp('server/db/index.js');
await (await imp('server/db/migrate.js')).runMigrations();
await imp('server/routes/coach.js');
const { chatTurn } = await imp('server/services/coach/chat.js');
const { callClaude, parseJson, getApiKey } = await imp('server/services/claude.js');
if (!getApiKey()) { console.error('no Anthropic key in the environment'); process.exit(2); }

export const GRADER_MODEL = 'claude-haiku-4-5-20251001';
const RUBRIC = `You grade one answer from a fantasy-football assistant. Judge only what is written.
- answers_question: does it answer what was asked (or say plainly that it cannot and why)?
- verdict_first: is the first line a one-line verdict (at most 18 words) that starts with a verb or "No" (or says plainly that it cannot answer)?
- why_bullets: after the verdict, are there 1-3 short reasons (bullets or lines, at most ~22 words each), or a refusal instead?
- concise: is the whole answer under 120 words?
- numbers_labelled: does every number say what it is (odds, points, percent of what)? true when there are no numbers.
- format_ok: true only when verdict_first, why_bullets and concise are all true.
Reply with only the JSON object.`;
const GRADE_SCHEMA = { type: 'object', additionalProperties: false,
  required: ['answers_question', 'verdict_first', 'why_bullets', 'concise', 'numbers_labelled', 'format_ok', 'note'],
  properties: { answers_question: { type: 'boolean' }, verdict_first: { type: 'boolean' }, why_bullets: { type: 'boolean' },
    concise: { type: 'boolean' }, numbers_labelled: { type: 'boolean' }, format_ok: { type: 'boolean' }, note: { type: 'string' } } };

/** What the drawer shows, as text: the shaped answer, or the claims and refusals as lines. */
export function rendered(out) {
  const s = out.answer?.shape;
  if (s?.verdict) {
    return [s.verdict.text, ...s.why.map(w => `- ${w.text}`), ...s.risks.map(r => r.text),
      ...(out.answer.refusals ?? []).filter(r => r !== s.verdict.text)].join('\n');
  }
  return [...(out.answer?.claims ?? []).map(c => c.text), ...(out.answer?.refusals ?? [])].join('\n');
}

async function grade(question, text) {
  const msg = await callClaude({ feature: 'coach:judge', model: GRADER_MODEL, maxTokens: 400, system: RUBRIC,
    messages: [{ role: 'user', content: `QUESTION: ${question}\n\nANSWER:\n${text || '(empty)'}` }], outputSchema: GRADE_SCHEMA });
  return { ...parseJson(msg), cost_usd: msg.cost_usd ?? 0 };
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

const items = [];
for (const [intent, qs] of Object.entries(SET.questions)) {
  if (ONLY && !ONLY.has(intent)) continue;
  qs.forEach((q, i) => items.push({ intent, question: q, league: SET.leagues[i % SET.leagues.length] }));
}
const todo = LIMIT ? items.slice(0, LIMIT) : items;
const base = 990000 + Math.floor(Date.now() / 1000) % 9000 * 10;
const results = [];
for (const [n, it] of todo.entries()) {
  const userId = base + n;
  run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (?, ?, 'Judge')`, userId, `judge-${userId}`);
  const events = [];
  const t0 = Date.now();
  let out;
  let error = null;
  try {
    out = await chatTurn({ userId, leagueId: it.league, question: it.question, hasModel: true,
      context: { surface: 'app', league: it.league }, onEvent: e => events.push(e) });
  } catch (e) { error = `${e.status ?? ''} ${e.message}`.trim(); }
  const ms = Date.now() - t0;
  const plan = out?.plan ?? events;
  const tools = plan.filter(e => e.t === 'planning').flatMap(e => e.tools ?? []);
  const text = out ? rendered(out) : '';
  let g = null;
  if (out) {
    try { g = await grade(it.question, text); } catch (e) {
      // A grader failure (the account out of credits, say) stops the run: the rest would be ungraded.
      console.error(`${LABEL}: the grader failed on question ${n + 1} (${e.code ?? e.status ?? ''} ${e.message}); stopping`);
      break;
    }
  }
  const r = { ...it, ms, error, cost_usd: out?.cost_usd ?? 0, path: out ? (out.cost_usd > 0 ? 'model' : 'plan') : 'error',
    route: out?.route?.intent ?? null, verified: out?.verification?.ok ?? false,
    claims: out?.answer?.claims?.length ?? 0, refusals: out?.answer?.refusals?.length ?? 0,
    catalog_lookups: tools.filter(t => t === 'catalog_lookup').length, tool_calls: tools.length,
    model_rounds: plan.filter(e => e.t === 'planning').length + (out?.cost_usd > 0 ? 1 : 0),
    shaped: !!out?.answer?.shape?.verdict, grade: g, text,
    number_retries: plan.filter(e => e.t === 'rejected').length, shape_retries: plan.filter(e => e.t === 'reshaping').length,
    nudges: plan.filter(e => e.t === 'drafting' && e.nudged).length, route_by: out?.route?.by ?? null };
  results.push(r);
  console.log(`${LABEL} ${String(n + 1).padStart(2)} ${it.intent.padEnd(7)} L${it.league} ${r.path.padEnd(5)} ${String(ms).padStart(6)} ms $${r.cost_usd.toFixed(4)} `
    + `cat ${r.catalog_lookups} ok ${r.verified} fmt ${g?.format_ok ?? '-'} ans ${g?.answers_question ?? '-'}${error ? ` ERR ${error}` : ''}`);
}

const model = results.filter(r => r.path === 'model');
const graded = results.filter(r => r.grade);
const summary = {
  label: LABEL, root: ROOT, questions: results.length, model_turns: model.length,
  catalog_lookups_median_model_turn: median(model.map(r => r.catalog_lookups)),
  catalog_lookups_mean_model_turn: model.length ? +(model.reduce((n, r) => n + r.catalog_lookups, 0) / model.length).toFixed(2) : null,
  p50_latency_ms_model_turn: median(model.map(r => r.ms)),
  cost_per_question_usd: +(results.reduce((n, r) => n + r.cost_usd, 0) / Math.max(1, results.length)).toFixed(4),
  cost_per_do_usd_median: +(median(results.filter(r => r.intent === 'DO').map(r => r.cost_usd)) ?? 0).toFixed(4),
  cost_per_do_usd_mean: +(results.filter(r => r.intent === 'DO').reduce((n, r) => n + r.cost_usd, 0) / Math.max(1, results.filter(r => r.intent === 'DO').length)).toFixed(4),
  verified: results.filter(r => r.verified).length,
  format_ok_pct: graded.length ? +(100 * graded.filter(r => r.grade.format_ok).length / graded.length).toFixed(1) : null,
  answers_question_pct: graded.length ? +(100 * graded.filter(r => r.grade.answers_question).length / graded.length).toFixed(1) : null,
  errors: results.filter(r => r.error).length,
  model_calls_mean_model_turn: model.length ? +(model.reduce((n, r) => n + r.model_rounds + r.number_retries + r.shape_retries + r.nudges, 0) / model.length).toFixed(2) : null,
  number_retries: results.reduce((n, r) => n + r.number_retries, 0), shape_retries: results.reduce((n, r) => n + r.shape_retries, 0),
  grader_cost_usd: +graded.reduce((n, r) => n + (r.grade.cost_usd ?? 0), 0).toFixed(4)
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `judge-${LABEL}.json`), JSON.stringify({ summary, results }, null, 1));
console.log(JSON.stringify(summary, null, 1));
