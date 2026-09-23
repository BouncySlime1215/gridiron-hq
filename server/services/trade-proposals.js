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
 * **What it still cannot catch, stated so nobody reads it as airtight.**
 * (1) A player it has never heard of. Names are recognised against the
 *     `universe` the caller supplies; anything outside it is invisible, so the
 *     universe must be EVERY player in the league, not just the ones in the
 *     ideas. A wholly invented person — a name no league holds — is outside any
 *     universe and passes.
 * (2) What a number MEANS. It checks that a number appears in the cited ideas,
 *     never that it is being used for the thing it measures: an acceptance
 *     probability of 0.31 makes "31" a verified number, and "he is a 31% target
 *     share guy" then verifies clean.
 * (3) Numbers written as words. "nine straight double-digit weeks" contains no
 *     digits and is not scanned.
 * (4) Claims made with 0, 1 or 2, which are free (FREE_NUMBERS) so that "2 for
 *     1" does not need an idea to contain a 2. "He has missed 2 games" is an
 *     invented injury that costs nothing to make.
 * Each of these is a sentence Nick could send believing we computed it. They
 * are open, not solved.
 *
 * **Cost.** The budget key is `trade_proposals:league-<id>`, declared in
 * `llm-budget.js` with a $0.50/day default and enforced inside `callClaude`, so
 * this file adds no budget logic of its own. Since 2026-09-19 that $0.50 is per
 * LEAGUE rather than shared across all of them (`budgetScopeFor`). The cache is
 * content-keyed the way `nfl_news_event_extraction_cache` is: an unchanged slate
 * returns the stored answer and spends nothing, and a changed slate or a bumped
 * PROMPT_VERSION is a miss.
 *
 * A failure is never cached AS PROPOSALS, and a call that threw is not cached at
 * all — the budget resets, keys get pasted in, overloaded APIs recover. What IS
 * remembered, for `FAILED_SLATE_TTL_MS` and under a key of its own, is a slate
 * whose answer arrived and could not be used: cut off, declined, unreadable,
 * the wrong shape, or every proposal rejected. That verdict cannot change while
 * the slate and the parser are the same, so paying for it twice buys nothing.
 * See `proposalsFor` for the three bounds that keep it from sticking.
 */
import crypto from 'node:crypto';
import { row, run } from '../db/index.js';

/** Bumping this invalidates every cached answer by construction. */
export const PROMPT_VERSION = 'trade-proposals-v1';

/**
 * How long a slate the model could not answer usably is remembered, so the same
 * unanswerable slate is paid for once rather than on every page load. Bounded on
 * purpose: see `FAILURE_RECORD_VERSION`.
 */
export const FAILED_SLATE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How many ideas the model is shown — D4's "the top ~12 numeric ideas".
 *
 * Fixed rather than caller-controlled, and the route must not expose it. The
 * cache key is a hash of the slate, so a caller free to vary this could mint a
 * distinct key per value and pay for a fresh Sonnet call each time, on the same
 * league, on the same day.
 */
export const PROPOSAL_SLATE_SIZE = 12;

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
 *
 * The percentage form is offered only for values that could BE a rate (|n| <=
 * 1). Offering it for everything meant a lineup gain of 2.4 points a week also
 * licensed the digits 240, and "he is averaging 240 receiving yards a game"
 * verified clean.
 */
function allowedNumbers(ideas) {
  const out = new Set(FREE_NUMBERS);
  const push = n => {
    if (!Number.isFinite(n)) return;
    for (const dp of [0, 1, 2, 3]) out.add(+n.toFixed(dp));
    if (Math.abs(n) <= 1) {          // a rate, and only a rate, may be a percentage
      out.add(+(n * 100).toFixed(0));
      out.add(+(n * 100).toFixed(1));
    }
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
 *
 * Two forms the first version missed, in opposite directions: `.85` written
 * without its leading zero produced no token at all (so it was never checked),
 * and `3,400` produced the two tokens 3 and 400 (so a correct proposal was
 * rejected for inventing both). A thousands separator is removed before the
 * scan; only `\d,\d\d\d` is a separator, so "in 2023, 400 yards" is untouched.
 */
function numbersIn(text) {
  const cleaned = String(text).replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  return (cleaned.match(/(?<![\w.])-?(?:\d+(?:\.\d+)?|\.\d+)/g) ?? [])
    .map(Number).filter(Number.isFinite);
}

/**
 * Keys that are structure, not something Nick reads. `idea_ids` is checked by
 * its own rule against the supplied ideas, so scanning it for prose numbers
 * read `idea-1` as a claim about the number 1.
 *
 * Skipped at the TOP LEVEL ONLY. Skipping it at every depth meant a whole
 * sentence hid under `data_used: { idea_ids: "he is averaging 27.4 ppg" }`.
 */
const NOT_PROSE = new Set(['idea_ids']);

/**
 * Everything in a proposal that carries a claim: the strings Nick reads, and
 * the bare numbers too.
 *
 * The numbers matter as much as the prose. The prompt asks for `ask / fair /
 * floor` and `data_used  which numbers you leaned on` — a model answering
 * those with JSON numbers rather than sentences was, in the first version,
 * never checked at all, because only strings were collected.
 */
function readableOf(proposal) {
  const strings = [];
  const numbers = [];
  const walk = v => {
    if (typeof v === 'string') strings.push(v);
    else if (typeof v === 'number') numbers.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  if (typeof proposal === 'string') strings.push(proposal);
  else if (typeof proposal === 'number') numbers.push(proposal);
  else if (proposal && typeof proposal === 'object') {
    for (const [k, val] of Object.entries(proposal)) if (!NOT_PROSE.has(k)) walk(val);
  }
  return { strings, numbers };
}

/** Suffixes that are part of a name but never the surname. */
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/**
 * One spelling for one player: accents stripped, every apostrophe variant
 * dropped, punctuation flattened, lower case. "De’Von Achane", "De'Von
 * Achane" and "devon  achane" all become `devon achane`.
 *
 * Without this, a model rendering De'Von with a typographic apostrophe read as
 * an invented player and a correct proposal was thrown away, while `patrick
 * mahomes` in lower case read as no player at all and went through.
 */
function normalizeName(text) {
  return String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ´`']/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The last real token of a normalized name: `amon ra st brown` -> `brown`. */
function surnameOf(normalized) {
  const parts = normalized.split(' ').filter(Boolean);
  while (parts.length > 1 && NAME_SUFFIXES.has(parts.at(-1))) parts.pop();
  return parts.at(-1) ?? '';
}

/**
 * Every capitalised word in the prose, normalized.
 *
 * This is how a surname on its own is caught. Nick's league-mates are texted
 * by surname — the fixture's own opener is "Waddle for Achane" — so matching
 * full names only left the one form the model actually writes in unchecked.
 * Requiring a capital is what keeps "I'd love to do this" from reading as a
 * mention of Jordan Love; a capitalised common word at the start of a sentence
 * can still cost a good proposal, which fails in the visible direction.
 */
function capitalisedWords(strings) {
  const out = new Set();
  for (const s of strings) {
    for (const w of String(s).match(/[A-Z][A-Za-zÀ-ɏ'’-]+/g) ?? []) {
      const n = normalizeName(w);
      if (n) out.add(n);
    }
  }
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
      // An empty string, [] or {} is as missing as an absent key: a proposal
      // with `opener: ""` has no opening message, whatever the shape says.
      if (isEmpty(proposal?.[field])) violations.push(`missing required field: ${field}`);
    }
    // The package is the one field with a shape of its own. Allowed to be a
    // prose string, it skips the name check below entirely and the swap hides
    // in a sentence: "Waddle plus a bench flier for Achane".
    const pkg = proposal?.package;
    if (pkg != null && (typeof pkg !== 'object' || Array.isArray(pkg)
      || !Array.isArray(pkg.i_give) || !Array.isArray(pkg.i_get))) {
      violations.push('package must be { i_give: [names], i_get: [names] }, not prose');
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
    const { strings, numbers } = readableOf(proposal);
    const allowedSpellings = new Set([...allowedPlayers].map(normalizeName));

    // Every spelling worth recognising: the players this proposal may name, and
    // every other player in the league, so one swapped in is caught too.
    const canonical = new Map();                 // normalized full name -> as written
    for (const name of [...allowedPlayers, ...(universe ?? [])]) {
      const n = normalizeName(name);
      if (n && !canonical.has(n)) canonical.set(n, String(name));
    }
    const bySurname = new Map();                 // surname -> {normalized full names}
    for (const full of canonical.keys()) {
      const s = surnameOf(full);
      if (!s) continue;
      if (!bySurname.has(s)) bySurname.set(s, new Set());
      bySurname.get(s).add(full);
    }

    // A name in the structured package is checked by its spelling, not its
    // bytes, so a typographic apostrophe is the same player rather than an
    // invented one.
    for (const raw of [...(pkg?.i_give ?? []), ...(pkg?.i_get ?? [])]) {
      const n = normalizeName(raw);
      if (!allowedSpellings.has(n)) {
        violations.push(`names ${String(raw)}, who is in none of the ideas it cites`);
      }
    }

    // A name can also arrive in prose, which is where a throw-in gets smuggled
    // in — as a full name in any case or spacing, or as a bare surname.
    const blob = ` ${normalizeName(strings.join(' \u0000 '))} `;
    for (const [full, asWritten] of canonical) {
      if (blob.includes(` ${full} `) && !allowedSpellings.has(full)) {
        violations.push(`names ${asWritten}, who is in none of the ideas it cites`);
      }
    }
    for (const word of capitalisedWords(strings)) {
      const candidates = bySurname.get(word);
      // Ambiguity resolves in favour of the proposal: if any player with this
      // surname IS in the cited ideas, the sentence is about him.
      if (!candidates || [...candidates].some(full => allowedSpellings.has(full))) continue;
      violations.push(`names ${[...candidates].map(f => canonical.get(f)).join(' / ')}, `
        + 'who is in none of the ideas it cites');
    }

    // ------------------------------------------- no invented numbers (G1)
    // Both the numbers written into sentences and the ones returned as JSON:
    // `ask: 4800` is a number Nick reads off the card like any other.
    const claimed = [...numbers];
    for (const text of strings) claimed.push(...numbersIn(text));
    for (const n of claimed) {
      if (!allowed.has(n)) {
        violations.push(`uses the number ${n}, which appears in none of the ideas it cites`);
      }
    }

    if (violations.length) rejected.push({ proposal, violations: [...new Set(violations)] });
    else ok.push(proposal);
  }
  return { ok, rejected };
}

/** Absent, blank, or an empty list or object — none of which is a field. */
function isEmpty(v) {
  if (v == null) return true;
  if (typeof v === 'string') return !v.trim();
  if (Array.isArray(v)) return !v.length;
  if (typeof v === 'object') return !Object.keys(v).length;
  return false;
}

/**
 * The cache key for one slate. Content-keyed, not day-keyed: an unchanged slate
 * re-uses the answer no matter how much time passed, and a changed slate is a
 * miss on the same day. `PROMPT_VERSION` is inside the hash, so changing how we
 * ask invalidates everything without anyone remembering to clear a table.
 */
export function cacheKeyFor(leagueId, ideas) {
  // The key hashes THE PROMPT, not a hand-picked subset of each idea. The first
  // version listed the fields it thought mattered and left out `partner`, the
  // tactics and the acceptance basis — all of which the prompt shows the model
  // and the model writes its reasoning from. A slate whose tactic had changed
  // from "sell the crush" to "he just lost by 40" hashed identically and was
  // served the old answer, still saying send it now for the old reason.
  const material = JSON.stringify({
    v: PROMPT_VERSION,
    league: String(leagueId),
    prompt: proposalsPrompt(ideas ?? []),
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
 * Every way the answer we paid for can be unusable, each its own `problem` code
 * so the page can say which one happened. `reason` is the sentence Nick reads;
 * the code is what a test or a log line can be precise about.
 *
 * These are distinguished because they are different events with different
 * fixes: `truncated` means raise maxTokens or shrink the slate, `declined`
 * means the model would not answer this slate at all, `no_text` means it
 * answered with something that was not text (thinking or a tool call only),
 * `unreadable` means it wrote prose where JSON was asked for, `not_a_list`
 * means it wrote JSON of the wrong shape, and `all_rejected` means it wrote
 * proposals that invented a player or a number. One generic "malformed
 * response" for all six is what made the live bug invisible.
 */
export const RESPONSE_PROBLEMS = Object.freeze(['truncated', 'declined', 'no_text', 'unreadable',
  'not_a_list', 'all_rejected', 'call_failed']);

/** Fenced output is formatting, not content: ```json ... ``` (or an unclosed fence when truncated). */
function stripFence(text) {
  let t = String(text).trim();
  if (!t.startsWith('```')) return t;
  t = t.replace(/^```[a-zA-Z0-9_+-]*[ \t]*\r?\n?/, '');
  return t.replace(/\s*```\s*$/, '').trim();
}

/**
 * Read whatever the injected caller handed back into one shape `proposalsFor`
 * can act on: `{ kind: 'model-text', text, truncated, cost_usd }`, or a
 * pre-parsed `{ value }`, or a `{ problem, reason }` that no parsing can fix.
 *
 * This is the fix for the live bug of 2026-09-19. `callClaude` returns an
 * Anthropic Message — `{ id, type: 'message', content: [{ type: 'text', text }],
 * stop_reason, usage, cost_usd }` — and `liveCaller` returned it unchanged, so
 * `proposalsFor` saw an object that was neither a string nor an array, failed
 * its `Array.isArray` check, and answered "the model response was not a list of
 * proposals" on every single live request. The call was made and paid for; the
 * answer inside `content[0].text` was thrown away. `claude.js#parseJson` had
 * done this correctly for every other feature since the start.
 *
 * Idempotent, so it is safe to apply in `liveCaller` and again in
 * `proposalsFor` — the second caller wired straight to `callClaude` should not
 * burn the budget the way the first one did.
 */
export function readModelResponse(raw) {
  const problem = (code, reason, cost = null) => ({ problem: code, reason, cost_usd: cost });

  if (raw == null) return problem('no_text', 'the model call came back empty, with no answer in it at all');
  if (typeof raw === 'string') return { kind: 'model-text', text: stripFence(raw), truncated: false, cost_usd: null };
  if (Array.isArray(raw)) return { value: raw, cost_usd: null };
  if (typeof raw !== 'object') {
    return problem('unreadable', `the model call came back as a ${typeof raw}, which is not an answer`);
  }
  // Already read once (liveCaller), or already a problem: hand it straight back.
  if (raw.kind === 'model-text' || typeof raw.problem === 'string') return raw;

  const cost = Number.isFinite(raw.cost_usd) ? raw.cost_usd : null;
  const content = Array.isArray(raw.content) ? raw.content : null;
  // Not a Message at all — a plain object the model or a caller produced. Left
  // as a value so the shape check below names what is wrong with it.
  if (!content) return { value: raw, cost_usd: cost };

  if (raw.stop_reason === 'refusal' || content.some(b => b?.type === 'refusal')) {
    return problem('declined', 'the model declined to write up this slate, so there is nothing to check '
      + '— the call was made and paid for, but it returned no proposals', cost);
  }
  const texts = content.filter(b => b?.type === 'text' && typeof b.text === 'string' && b.text.trim());
  if (!texts.length) {
    const kinds = [...new Set(content.map(b => b?.type ?? 'unknown'))];
    if (raw.stop_reason === 'max_tokens') {
      return problem('truncated', 'the model ran out of output room before it wrote any proposals at all, '
        + 'so the answer was cut off with nothing usable in it', cost);
    }
    return problem('no_text', 'the model answered with no text at all '
      + `(${kinds.length ? kinds.join(', ') : 'an empty answer'}), so there is nothing to read`, cost);
  }
  // Several text blocks are one answer split up, and a thinking block before
  // them is not part of it: join the text in order and skip everything else.
  return { kind: 'model-text', text: stripFence(texts.map(b => b.text).join('')),
    truncated: raw.stop_reason === 'max_tokens', cost_usd: cost };
}

/**
 * The production caller: one Sonnet call, under this league's own budget, read
 * into something `proposalsFor` can parse.
 *
 * `feature` carries the league id, which is both how the spend is attributed in
 * `ai_usage` and — since the per-league budget fix — the budget it is held
 * against: `llm-budget.js#budgetScopeFor` gives `trade_proposals:league-4` its
 * own $0.50 a day instead of a fifth of one shared pot. `callClaude` enforces it
 * and throws when it is spent, which `proposalsFor` surfaces as a refusal.
 */
export function liveCaller(callClaude) {
  return async ({ leagueId, ideas }) => readModelResponse(await callClaude({
    feature: `trade_proposals:league-${leagueId}`,
    model: 'claude-sonnet-5',
    // Sonnet 5 thinks by default and thinking counts toward max_tokens: at
    // 4,000 it spent all of it thinking and wrote nothing (2026-09-23).
    // Low effort keeps thinking short; 12,000 leaves room for the answer.
    maxTokens: 12000,
    effort: 'low',
    prompt: proposalsPrompt(ideas),
  }));
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
 * A slate the model could not answer usably is remembered under this suffix,
 * next to (never instead of) the slate's own answer key, so a failure can never
 * be mistaken for a payload.
 */
const failureKeyFor = key => `${key}.failed`;

/**
 * Stamped into every remembered failure and checked on the way back out: a
 * record written by different parsing code is ignored, so shipping a fix to
 * `readModelResponse` retries every slate the old code could not read instead of
 * serving its verdict for another six hours. Bump it with any change to how a
 * response is read.
 */
export const FAILURE_RECORD_VERSION = 'trade-proposals-parse-v2';

/**
 * The whole pass for one league.
 *
 * `call` is injected so this is testable without a key and without spending:
 * production passes `liveCaller(callClaude)`, whose feature key
 * `trade_proposals:league-<id>` is where this league's daily budget is enforced.
 * A refusal from it — budget spent, no key, the model unreachable — comes back
 * as `refused: true` with the reason, never as an empty success that reads like
 * "no good trades today".
 *
 * **Two classes of failure, handled differently, because they are different.**
 * A call that THREW (budget, key, network, overload) says nothing about this
 * slate: it is never remembered, and the next page load may try again. A call
 * that came back and could not be used — cut off, declined, prose instead of
 * JSON, JSON of the wrong shape, or proposals that all failed the verifier —
 * will do exactly the same thing next time for the same slate, so it is
 * remembered for `FAILED_SLATE_TTL_MS` and the second request costs one cache
 * read and no model call. Bounded three ways so it cannot become a permanently
 * empty Trade Lab: the TTL, the slate hash (any change to the ideas is a new
 * question), and `FAILURE_RECORD_VERSION` (any change to the parser retries
 * everything). Successful answers are still the only thing cached as proposals.
 */
export async function proposalsFor(leagueId, { ideas = [], universe = [], call, cache = null,
  now = Date.now() } = {}) {
  const none = (reason, extra = {}) => ({ proposals: [], rejected: [], reason, source: 'none', ...extra });

  if (!ideas.length) {
    return none('no ideas passed the edge test for this league, so there is nothing to write up');
  }
  if (typeof call !== 'function') {
    return none('no model caller was supplied', { refused: true });
  }

  // Every proposal has to cite the idea it came from, so a slate whose ideas
  // carry no usable id cannot produce a single valid proposal. Refusing here
  // costs nothing; not refusing pays for a call whose every answer is then
  // rejected, and the refusal is not cached, so the next page load pays again.
  const ids = ideas.map(i => (i?.id == null ? '' : String(i.id).trim()));
  if (ids.some(id => !id)) {
    return none(`${ids.filter(id => !id).length} of ${ideas.length} idea(s) arrived without an id, `
      + 'so no proposal could be traced back to the package that passed the edge test', { refused: true });
  }
  if (new Set(ids).size !== ids.length) {
    return none('two ideas in this slate share an id, so a proposal citing it could be checked '
      + 'against the wrong package', { refused: true });
  }

  const key = cacheKeyFor(leagueId, ideas);
  const hit = cache?.get?.(key) ?? null;
  // Only a real payload is a hit. A row that parses but is not one — a corrupt
  // or foreign write — otherwise returned an empty list with no reason at all,
  // which reads on the page as "no good trades today".
  if (hit && Array.isArray(hit.proposals) && hit.proposals.length) {
    return { proposals: hit.proposals, rejected: hit.rejected ?? [], reason: hit.reason ?? null,
      source: 'cache' };
  }

  // This exact slate already came back unusable, recently, from this parser:
  // paying again buys the same answer. One cache read, no model call.
  const failure = cache?.get?.(failureKeyFor(key)) ?? null;
  if (failure?.v === FAILURE_RECORD_VERSION && Number.isFinite(failure.at)
    && now - failure.at < FAILED_SLATE_TTL_MS) {
    return { proposals: [], rejected: failure.rejected ?? [], source: 'cache', refused: true,
      problem: failure.problem, attempts: failure.attempts ?? 1, cost_usd: null,
      retry_after: new Date(failure.at + FAILED_SLATE_TTL_MS).toISOString(),
      reason: `${failure.reason} — this slate was already sent once and came back the same way, so it `
        + 'was not paid for again; it will be tried again once the slate changes or the hold expires' };
  }

  let raw;
  try {
    raw = await call({ leagueId, ideas, key });
  } catch (error) {
    // Never remembered: the budget resets at midnight, a key gets pasted in, an
    // overloaded API recovers. None of that is a fact about this slate, and a
    // transient failure must not leave this league with an empty Trade Lab.
    return none(`the model call was refused: ${error?.message ?? String(error)}`,
      { refused: true, problem: 'call_failed' });
  }

  const read = readModelResponse(raw);
  const cost = read.cost_usd ?? null;

  /**
   * The answer arrived, cost money, and cannot be used. Remember it against the
   * slate hash so the next page load is free, and hand back the honest reason
   * with its problem code.
   */
  const unusable = (problem, reason, rejected = []) => {
    const attempts = (failure?.v === FAILURE_RECORD_VERSION ? (failure.attempts ?? 0) : 0) + 1;
    const at = now;
    // The one line that makes a discarded paid call visible in the logs; the
    // response says the same thing, but nobody is watching the response when
    // the page just looks empty.
    console.warn(`[trade-proposals] league ${leagueId}: paid for a response that cannot be used `
      + `(${problem}, attempt ${attempts}${cost == null ? '' : `, $${cost.toFixed(4)}`}) — ${reason}`);
    cache?.set?.(failureKeyFor(key), { v: FAILURE_RECORD_VERSION, problem, reason, rejected, attempts, at });
    return { proposals: [], rejected, source: 'model', refused: true, problem, attempts, cost_usd: cost,
      retry_after: new Date(at + FAILED_SLATE_TTL_MS).toISOString(), reason };
  };

  if (read.problem) return unusable(read.problem, read.reason);

  let parsed;
  if ('value' in read) {
    parsed = read.value;
  } else {
    try {
      parsed = JSON.parse(read.text);
    } catch {
      // A cut-off answer and a model that wrote prose are different problems
      // with different fixes, and a single "malformed response" for both is how
      // a truncated slate looks like a broken model for a week.
      return read.truncated
        ? unusable('truncated', 'the model ran out of output room part-way through, so its list of '
          + 'proposals was cut off mid-answer and could not be read — nothing from a half-written '
          + 'proposal is trusted')
        : unusable('unreadable', 'the model response could not be read as JSON, so nothing from it '
          + 'is trusted');
    }
  }
  if (!Array.isArray(parsed)) {
    return unusable('not_a_list', 'the model response was not a list of proposals');
  }

  const { ok, rejected } = verifyProposals(parsed, ideas, { universe });
  if (!ok.length) {
    // Not a parse problem — the verifier did its job. Still the same answer next
    // time for the same slate, so it is remembered like the others, with the
    // violations kept so the page can show what was actually wrong.
    return unusable('all_rejected',
      `every proposal failed verification and was rejected — ${rejected.length} in total, `
        + 'most likely an invented player or number; see each one\'s violations', rejected);
  }

  const result = { proposals: ok, rejected,
    reason: rejected.length ? `${rejected.length} proposal(s) rejected for inventing a player or number` : null };
  cache?.set?.(key, result);
  return { ...result, source: 'model' };
}
