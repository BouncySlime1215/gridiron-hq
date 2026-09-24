/**
 * An answer ships only if every number in it came back from the database.
 *
 * This is the difference between Coach and the assistant it replaces. That one
 * asks the model not to invent numbers (nfl-page-explain.js:60) and then
 * returns whatever comes back (nfl-page-explain.js:88-133) — the rule is real,
 * the enforcement is a sentence. The shape borrowed here is the one the app
 * already got right: /trades/:leagueId/sense-check (server/routes/trades.js:
 * 705-887) checks Claude's verdict against a simulation and retries once when
 * they disagree. This is that, made deterministic: no second model call and no
 * judgement, only "is this number in the ledger".
 *
 * A number is grounded when a cell cited by THAT claim holds it: exactly, at
 * the precision the claim states it to (0.28351 written as 0.28), or as the
 * percentage form of it (0.284 written as 28.4%). A cell cited by a different
 * claim does not count — a citation is a claim's own evidence, and letting
 * them pool would make one honest cite launder a paragraph.
 *
 * A digit inside a cited TEXT cell grounds the same digit in the claim
 * ("Send step 2 to Team 2." cited, "step 2" stated): the number came back from
 * a tool, spelled the way the tool spelled it.
 *
 * PLAYERS (COACH-TOOLS). A claim that cites a brain tool (plan_read,
 * people_read, pulse_read, brain_read, health_read) must also cite every
 * player it names: a player the claim names is grounded only when a string
 * cell THAT claim cites contains the name. "Names a player" means either a
 * name some brain tool returned in this turn (any `*_name`, wants, shopping,
 * untouchable or player cell), or an initial-style name ("K. Bell"), which is
 * how the plans file writes players and so is how a fabricated one would be
 * written. A player the claim did not cite, or one no tool returned, is
 * UNGROUNDED_PLAYER and blocks like a number.
 *
 * Two things warn rather than block, and they are stated here because they are
 * the honest limit of this check: a number spelled out in words ("three of the
 * last four"), and a full-name proper noun ("Firstname Lastname") that no tool
 * returned. Both are in the audit. Digits block. Closing the word-number gap by
 * rejecting "one" would reject "one of the reasons", which is not a claim
 * about football.
 */
import { newLedger } from './ledger.js';

export const VIOLATIONS = Object.freeze({
  EMPTY_ANSWER: 'empty_answer',
  UNCITED_CLAIM: 'uncited_claim',
  BAD_CITE: 'bad_cite',
  UNGROUNDED_NUMBER: 'ungrounded_number',
  UNGROUNDED_PLAYER: 'ungrounded_player',
  MISSING_AS_OF: 'missing_as_of'
});

/** The brain read tools (brain-tools.js#BRAIN_TOOLS). Their cites turn on the player check. */
export const BRAIN_TOOL_NAMES = Object.freeze(['plan_read', 'people_read', 'pulse_read', 'brain_read', 'health_read']);

/** Columns of a brain-tool row that hold player names (a `; `-joined list for the people lists). */
const NAME_COLUMN = /(?:^|_)(?:name|wants|shopping|untouchable|player)$/;

/** How the plans file writes a player: "K. Bell", "A. St. Brown", "D. O'Neil". */
const INITIAL_NAME = /\b[A-Z]\.\s?(?:[A-Z][a-z]*\.?\s)?[A-Z][A-Za-z'’-]+/g;

/** Digits in prose: 11, 18.4, -3.5, +2, 1,349, 28.4% — the % and , are stripped. */
const NUMBER = /[-+]?\d[\d,]*(?:\.\d+)?/g;

/** Spelled-out quantities worth flagging. "one" is left out deliberately. */
const SPELLED = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|half|third|quarter|twice|double|triple)\b/i;

function numericTokens(text) {
  return [...String(text ?? '').matchAll(NUMBER)].map(match => match[0]);
}

function asNumber(token) {
  const value = Number(String(token).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/** Decimal places the claim stated the number to. 0.28 → 2, 11 → 0. */
function statedPrecision(token) {
  const dot = String(token).indexOf('.');
  return dot === -1 ? 0 : String(token).length - dot - 1;
}

function roundTo(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Does `stated` match `value`? Exactly, at the precision it was stated to, or
 * as the percentage form of a fraction (and the fraction form of a
 * percentage, which is the same comparison the other way round).
 */
function grounds(value, stated) {
  const target = asNumber(stated);
  if (target === null) return false;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isFinite(Number(value))) {
    // A text cell: the number must be one of the numbers written in it.
    return numericTokens(value).some(token => asNumber(token) === target);
  }
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return false;
  const places = statedPrecision(stated);
  for (const candidate of [numeric, numeric * 100, numeric / 100]) {
    if (candidate === target) return true;
    if (roundTo(candidate, places) === roundTo(target, places)) return true;
  }
  return false;
}

/** "K. Bell (RB)" -> "K. Bell": the name without the position tag the plans file adds. */
const nameCore = s => String(s).replace(/\s*\([^)]*\)\s*$/, '').trim();

/** Every player name a brain tool returned in this turn. */
function brainVocabulary(book) {
  const names = new Set();
  for (const q of book.queries ?? []) {
    if (!BRAIN_TOOL_NAMES.includes(q.tool)) continue;
    for (const row of q.rows) {
      for (const [col, value] of Object.entries(row)) {
        if (typeof value !== 'string' || !NAME_COLUMN.test(col)) continue;
        for (const part of value.split(';')) {
          const core = nameCore(part);
          if (core.length >= 3 && /[A-Za-z]/.test(core)) names.add(core);
        }
      }
    }
  }
  return names;
}

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The players a claim names: tool-returned names found in it, plus initial-style names. */
function playersNamed(text, vocabulary) {
  const found = new Set();
  for (const name of vocabulary) {
    if (new RegExp(`(^|[^A-Za-z])${escape(name)}([^A-Za-z]|$)`).test(text)) found.add(name);
  }
  for (const match of text.matchAll(INITIAL_NAME)) {
    const name = match[0].trim();
    if (![...found].some(f => f.includes(name) || name.includes(f))) found.add(name);
  }
  return [...found];
}

/**
 * Check one answer against the ledger of the turn that produced it.
 *
 * @param {{answer: object, ledger: ReturnType<typeof newLedger>, question?: string}} args
 * @returns {{ok: boolean, violations: object[], warnings: object[], numbers_checked: number,
 *   hand_collected: string[]}}
 */
export function verifyAnswer({ answer, ledger, question = '' } = {}) {
  const violations = [];
  const warnings = [];
  let numbersChecked = 0;

  const book = ledger ?? newLedger();
  const claims = Array.isArray(answer?.claims) ? answer.claims : [];
  const refusals = Array.isArray(answer?.refusals) ? answer.refusals : [];

  if (!claims.length && !refusals.length) {
    violations.push({ kind: VIOLATIONS.EMPTY_ANSWER,
      detail: 'Coach returned neither a claim nor a refusal. Silence is not an answer.' });
  }

  const allCites = [];
  const toolOf = cell => (cell?.query ? book.queries?.find(q => q.id === cell.query)?.tool ?? null : null);
  let vocabulary = null;

  claims.forEach((claim, claimIndex) => {
    const text = String(claim?.text ?? '');
    const cites = Array.isArray(claim?.cites) ? claim.cites : [];
    allCites.push(...cites);

    if (!cites.length) {
      violations.push({ kind: VIOLATIONS.UNCITED_CLAIM, claim_index: claimIndex, text,
        detail: 'Every claim carries at least one cite. If nothing supports it, refuse instead of asserting it.' });
      return;
    }

    const cells = [];
    for (const cite of cites) {
      const cell = book.cell(cite);
      if (!cell) {
        violations.push({ kind: VIOLATIONS.BAD_CITE, claim_index: claimIndex, cite,
          detail: `${cite} is not in this turn's ledger.` });
        continue;
      }
      cells.push(cell);
    }

    for (const token of numericTokens(text)) {
      numbersChecked += 1;
      if (cells.some(cell => grounds(cell.value, token))) continue;
      violations.push({
        kind: VIOLATIONS.UNGROUNDED_NUMBER, claim_index: claimIndex, number: token, text,
        detail: `${token} is in no cell this claim cites. Retrieve it, or derive it through the ledger, ` +
          'or leave it out — a number Coach worked out in prose is not evidence.'
      });
    }

    if (cells.some(cell => BRAIN_TOOL_NAMES.includes(toolOf(cell)))) {
      vocabulary ??= brainVocabulary(book);
      const cited = cells.filter(cell => typeof cell.value === 'string').map(cell => cell.value);
      for (const player of playersNamed(text, vocabulary)) {
        if (cited.some(value => value.includes(player))) continue;
        violations.push({
          kind: VIOLATIONS.UNGROUNDED_PLAYER, claim_index: claimIndex, player, text,
          detail: vocabulary.has(player)
            ? `${player} is in a tool result but not in a cell this claim cites. Cite the cell that names him.`
            : `${player} is in no tool result this turn. Coach names only players a tool returned.`
        });
      }
    }

    if (SPELLED.test(text)) {
      warnings.push({ kind: 'spelled_number', claim_index: claimIndex, text,
        detail: 'A quantity written in words is not checked against the ledger.' });
    }
  });

  const handCollected = book.handCollected(allCites);
  if (handCollected.length && !String(answer?.as_of ?? '').trim()) {
    violations.push({ kind: VIOLATIONS.MISSING_AS_OF, tables: handCollected,
      detail: `${handCollected.join(', ')} ${handCollected.length === 1 ? 'is' : 'are'} collected by hand, ` +
        'so the answer has to say when. Data that is only as fresh as the last time someone ran something ' +
        'must not read as current.' });
  }

  return { ok: violations.length === 0, violations, warnings,
    numbers_checked: numbersChecked, hand_collected: handCollected, question };
}

/** The violation kinds that belong to one claim, so dropping that claim clears them. */
const CLAIM_KINDS = new Set([VIOLATIONS.UNCITED_CLAIM, VIOLATIONS.BAD_CITE,
  VIOLATIONS.UNGROUNDED_NUMBER, VIOLATIONS.UNGROUNDED_PLAYER]);

/**
 * The answer with every claim that failed the check dropped, and a refusal
 * that says how many went. What survives is exactly the claims whose every
 * number and player matched a cited tool result. `dropped` is the count.
 * Answer-level violations (missing as_of, empty answer) are not fixed by
 * dropping a claim and are left for the caller.
 */
export function groundAnswer(answer, verification) {
  const bad = new Set((verification?.violations ?? [])
    .filter(v => CLAIM_KINDS.has(v.kind) && Number.isInteger(v.claim_index)).map(v => v.claim_index));
  const claims = (answer?.claims ?? []).filter((_, i) => !bad.has(i));
  const refusals = [...(answer?.refusals ?? [])];
  if (bad.size) {
    refusals.unshift(`Coach dropped ${bad.size} claim${bad.size === 1 ? '' : 's'} it could not trace to a tool result.`);
  }
  return { ...answer, claims, refusals, dropped: bad.size };
}
