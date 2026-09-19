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
