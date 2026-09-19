/**
 * The AI pass: numeric trade ideas in, messages Nick can actually send out.
 *
 * Master plan D4: "once per league per day, Sonnet 5 turns the top ~12 numeric
 * ideas into 5-8 sendable proposals: the package, the one-line why-they-say-yes
 * in their terms, the opening message in Nick's voice, ask / fair / floor, send
 * now or wait-until with the reason, the one risk, and the data it leaned on.
 * It may drop or merge ideas; it may not invent players or numbers (verified
 * after the call). Cached per league-day."
 *
 * **The verifier is the point of this file, not the prompt.** Everything the
 * engine does upstream — the edge test, the valuation map, the acceptance band
 * — is arithmetic a reader can check. The moment a model writes prose over it,
 * a number that was never computed can appear in a sentence Nick then sends to
 * a real person in his league. So every proposal is checked after the call
 * against the ideas it claims to come from, and one that names a player or a
 * number those ideas do not contain is REJECTED WHOLE.
 *
 * Rejected whole, never repaired: a proposal with the invented number stripped
 * out still had it, which means the reasoning that produced the rest of the
 * sentence is not trustworthy either. The original text is kept on the reject
 * so a reviewer sees what the model actually said.
 *
 * **Cost.** The budget key is `trade_proposals:league-<id>` — already declared
 * in `llm-budget.js` with a $0.50/day default and enforced inside `callClaude`,
 * so this file adds no budget logic of its own. The cache is content-keyed the
 * way `nfl_news_event_extraction_cache` is: an unchanged slate returns the
 * stored answer and spends nothing, a changed slate or a bumped PROMPT_VERSION
 * is a miss, and a refusal is never cached so a bad night does not become a
 * permanently empty Trade Lab.
 */
import crypto from 'node:crypto';
import { row, run } from '../db/index.js';

/** Bumping this invalidates every cached answer by construction. */
export const PROMPT_VERSION = 'trade-proposals-v1';

/** The fields D4 names. A proposal missing any of them is not a proposal. */
export const REQUIRED_PROPOSAL_FIELDS = Object.freeze([
  'idea_ids', 'package', 'why_they_say_yes', 'opener', 'ask', 'fair', 'floor', 'timing', 'risk',
  'data_used',
]);

/** Numbers every proposal may use without the ideas containing them. */
const FREE_NUMBERS = new Set([0, 1, 2]);

/**
 * Every number the source ideas actually contain, at the precisions a writer
 * might reasonably render them: 2.4 may appear as "2.4", "2.40" or "+2.4", and
 * a percentage as "6" or "6.0".
 */
function allowedNumbers(ideas) {
  const out = new Set(FREE_NUMBERS);
  const push = n => {
    if (!Number.isFinite(n)) return;
    for (const dp of [0, 1, 2, 3]) out.add(+n.toFixed(dp));
    out.add(+(n * 100).toFixed(0));   // a rate written as a percentage
    out.add(+(n * 100).toFixed(1));
  };
  const walk = v => {
    if (v == null) return;
    if (typeof v === 'number') return push(v);
    if (Array.isArray(v)) { v.forEach(walk); push(v.length); return; }
    if (typeof v === 'object') return Object.values(v).forEach(walk);
  };
  walk(ideas);
  return out;
}

/**
 * Every numeric token in a string, as numbers.
 *
 * The leading `-` counts as a sign only when it is not glued to a word: an
 * identifier like `idea-1` is one token, not a reference to negative one. The
 * first version of this read `idea-1` as -1 and rejected five correct proposals
 * for "inventing" a number that was never in the text.
 */
function numbersIn(text) {
  return (String(text).match(/(?<![\w.])-?\d+(?:\.\d+)?/g) ?? [])
    .map(Number).filter(Number.isFinite);
}

/**
 * Keys that are structure, not something Nick reads. They are checked by their
 * own rules above and must not be scanned for prose numbers.
 */
const NOT_PROSE = new Set(['idea_ids']);

/** Every string a proposal puts in front of Nick. */
function proseOf(proposal) {
  const out = [];
  const walk = v => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) if (!NOT_PROSE.has(k)) walk(val);
    }
  };
  walk(proposal);
  return out;
}

/**
 * Check one batch of proposals against the ideas they claim to come from.
 *
 * @param proposals what the model returned
 * @param ideas     the ideas it was given — every one has already passed the
 *                  edge test, because `findTrades` filters before this stage
 * @param universe  every player name in the league, so a name invented into the
 *                  PROSE ("I'd even add Mahomes") is caught, not just one in the
 *                  structured package
 * @returns `{ ok, rejected: [{ proposal, violations }] }`
 */
export function verifyProposals(proposals, ideas, { universe = [] } = {}) {
  const byId = new Map((ideas ?? []).map(i => [String(i.id), i]));
  const ok = [];
  const rejected = [];

  for (const proposal of proposals ?? []) {
    const violations = [];

    // ---------------------------------------------------- the shape (G6)
    for (const field of REQUIRED_PROPOSAL_FIELDS) {
      if (proposal?.[field] == null) violations.push(`missing required field: ${field}`);
    }

    // ------------------------------------- it must trace to real ideas (G5)
    const ids = Array.isArray(proposal?.idea_ids) ? proposal.idea_ids.map(String) : [];
    if (!ids.length) {
      violations.push('cites no source idea, so it cannot be traced to a package that passed the edge test');
    }
    for (const id of ids) {
      if (!byId.has(id)) violations.push(`cites idea ${id}, which was not supplied to this call`);
    }

    // The evidence this proposal is allowed to draw on: only the ideas it cites.
    const sources = ids.map(id => byId.get(id)).filter(Boolean);
    const allowedPlayers = new Set();
    for (const s of sources) {
      for (const p of [...(s.i_give ?? []), ...(s.i_get ?? [])]) {
        if (p?.name) allowedPlayers.add(String(p.name));
      }
    }
    const allowed = allowedNumbers(sources);

    // ------------------------------------------- no invented players (G1)
    const named = new Set([
      ...(proposal?.package?.i_give ?? []).map(String),
      ...(proposal?.package?.i_get ?? []).map(String),
    ]);
    // A name can also arrive in prose, which is where a throw-in gets smuggled in.
    const prose = proseOf(proposal).join(' \u0000 ');
    for (const name of universe) {
      if (prose.includes(name)) named.add(String(name));
    }
    for (const name of named) {
      if (!allowedPlayers.has(name)) {
        violations.push(`names ${name}, who is in none of the ideas it cites`);
      }
    }

    // ------------------------------------------- no invented numbers (G1)
    for (const text of proseOf(proposal)) {
      for (const n of numbersIn(text)) {
        if (!allowed.has(n)) {
          violations.push(`uses the number ${n}, which appears in none of the ideas it cites`);
        }
      }
    }

    if (violations.length) rejected.push({ proposal, violations });
    else ok.push(proposal);
  }
  return { ok, rejected };
}

/**
 * The cache key for one slate. Content-keyed, not day-keyed: an unchanged slate
 * re-uses the answer no matter how much time passed, and a changed slate is a
 * miss on the same day. `PROMPT_VERSION` is inside the hash, so changing how we
 * ask invalidates everything without anyone remembering to clear a table.
 */
export function cacheKeyFor(leagueId, ideas) {
  const material = JSON.stringify({
    v: PROMPT_VERSION,
    league: String(leagueId),
    ideas: (ideas ?? []).map(i => ({
      id: i.id, give: (i.i_give ?? []).map(p => [p.name, p.value]),
      get: (i.i_get ?? []).map(p => [p.name, p.value]),
      me: i.me, their_value_pct: i.their_value_pct, acceptance: i.acceptance?.band ?? null,
    })),
  });
  return crypto.createHash('sha256').update(material).digest('hex');
}

/**
 * What the model is shown and asked for.
 *
 * Deliberately narrow: the ideas are already scored, ranked and edge-tested, so
 * the model's whole job is wording and selection. It is told in the prompt that
 * it may not invent — but the prompt is not what enforces that, `verifyProposals`
 * is. A prompt is a request; the verifier is the guarantee.
 *
 * **Unexercised.** No live call was ever made against this text: the box it was
 * written in has no API key. Whether Sonnet picks the right five ideas or writes
 * an opener that sounds like Nick is not evidenced by anything in this repo yet.
 */
export function proposalsPrompt(ideas) {
  const slate = ideas.map(i => ({
    id: i.id,
    partner: i.partner,
    i_give: (i.i_give ?? []).map(p => ({ name: p.name, value: p.value })),
    i_get: (i.i_get ?? []).map(p => ({ name: p.name, value: p.value })),
    my_ppg_delta: i.me?.ppg_delta ?? null,
    their_value_pct: i.their_value_pct ?? null,
    acceptance: i.acceptance?.band ?? null,
    acceptance_basis: i.acceptance?.basis ?? null,
    tactics: (i.tactics ?? []).map(t => ({ key: t.key, why: t.why })),
  }));

  return [
    'You are writing trade proposals a fantasy football manager will actually send to the other',
    'people in his league. The analysis is already done: every package below passed a hard filter',
    'that it is positive for him on his own numbers. Your job is selection and wording, not',
    'evaluation.',
    '',
    'Return 5 to 8 proposals as a JSON array and nothing else. You may drop ideas and you may merge',
    'two into one. You may NOT introduce a player who is not in the ideas you cite, and you may NOT',
    'use a number that does not appear in them. Every proposal is checked against its cited ideas',
    'after you answer, and one that names an unknown player or an unknown number is discarded',
    'whole — so a proposal you are unsure about is better dropped than padded.',
    '',
    'Each proposal is an object with exactly these keys:',
    '  idea_ids          the ids from the slate this comes from (at least one)',
    '  package           { i_give: [names], i_get: [names] }',
    '  why_they_say_yes  one line, in terms of what THAT manager values',
    '  opener            the actual opening message, casual, how a person texts a league-mate',
    '  ask / fair / floor  what to open with, what is even, and the most to give up',
    '  timing            { send: "now" | "wait", reason: "..." }',
    '  risk              the one thing that could make this a mistake',
    '  data_used         which numbers you leaned on',
    '',
    'No preamble, no markdown, no commentary. The array only.',
    '',
    'THE SLATE:',
    JSON.stringify(slate, null, 2),
  ].join('\n');
}

/**
 * The production caller: one Sonnet call, budgeted per league.
 *
 * `feature` carries the league id because `llm-budget.js` resolves
 * `trade_proposals:league-4` to the `trade_proposals` budget — so each league
 * gets its own daily cap without any budget code here. `callClaude` enforces it
 * and throws when it is spent, which `proposalsFor` surfaces as a refusal.
 */
export function liveCaller(callClaude) {
  return async ({ leagueId, ideas }) => callClaude({
    feature: `trade_proposals:league-${leagueId}`,
    model: 'claude-sonnet-5',
    maxTokens: 4000,
    prompt: proposalsPrompt(ideas),
  });
}

/**
 * The persisted cache (migration 060), in the two-method shape `proposalsFor`
 * takes. Separate from the orchestration so tests can inject a plain Map and
 * never touch a database.
 *
 * A read that cannot be parsed is treated as a miss rather than thrown: a
 * corrupt row should cost one re-spend, not break Trade Lab.
 */
export function dbCache(leagueId) {
  return {
    get(key) {
      const hit = row('SELECT payload FROM trade_proposal_cache WHERE cache_key = ?', key);
      if (!hit) return null;
      try {
        return JSON.parse(hit.payload);
      } catch {
        return null;
      }
    },
    set(key, value) {
      run(`INSERT INTO trade_proposal_cache (cache_key, league_id, payload, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload,
             created_at = excluded.created_at`,
      key, String(leagueId), JSON.stringify(value), new Date().toISOString());
    },
  };
}

/**
 * The whole pass for one league.
 *
 * `call` is injected so this is testable without a key and without spending:
 * production passes a thunk around `callClaude` with
 * `feature: 'trade_proposals:league-<id>'`, which is where the daily budget is
 * enforced. A refusal from it — budget spent, no key, the model unreachable —
 * comes back as `refused: true` with the reason, never as an empty success that
 * reads like "no good trades today".
 */
export async function proposalsFor(leagueId, { ideas = [], universe = [], call, cache = null } = {}) {
  const none = (reason, extra = {}) => ({ proposals: [], rejected: [], reason, source: 'none', ...extra });

  if (!ideas.length) {
    return none('no ideas passed the edge test for this league, so there is nothing to write up');
  }
  if (typeof call !== 'function') {
    return none('no model caller was supplied', { refused: true });
  }

  const key = cacheKeyFor(leagueId, ideas);
  const hit = cache?.get?.(key) ?? null;
  if (hit) return { proposals: hit.proposals ?? [], rejected: hit.rejected ?? [], reason: hit.reason ?? null, source: 'cache' };

  let raw;
  try {
    raw = await call({ leagueId, ideas, key });
  } catch (error) {
    // A refusal is never cached: the budget resets tomorrow, and a transient
    // failure must not leave this league with a permanently empty Trade Lab.
    return none(`the model call was refused: ${error?.message ?? String(error)}`, { refused: true });
  }

  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return none('the model response could not be read as JSON, so nothing from it is trusted',
      { refused: true });
  }
  if (!Array.isArray(parsed)) {
    return none('the model response was not a list of proposals', { refused: true });
  }

  const { ok, rejected } = verifyProposals(parsed, ideas, { universe });
  if (!ok.length) {
    return { proposals: [], rejected, source: 'model', refused: true,
      reason: `every proposal failed verification and was rejected — ${rejected.length} in total, `
        + 'most likely an invented player or number; see each one\'s violations' };
  }

  const result = { proposals: ok, rejected,
    reason: rejected.length ? `${rejected.length} proposal(s) rejected for inventing a player or number` : null };
  cache?.set?.(key, result);
  return { ...result, source: 'model' };
}
