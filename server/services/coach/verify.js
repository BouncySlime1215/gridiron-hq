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
 * Two things warn rather than block, and they are stated here because they are
 * the honest limit of this check: a number spelled out in words ("three of the
 * last four"), and a proper noun that appears in no cited row. Both are in the
 * audit. Digits block. Closing the word-number gap by rejecting "one" would
 * reject "one of the reasons", which is not a claim about football.
 *
 * Engine numbers carry their health (HEALTH-01c). A claim citing an engine cell
 * that came without its health (a raw engine table, not engine_read) is
 * HEALTH_MISSING, and so is an answer citing engine cells without the health
 * line that states their as-of and whether their checks passed. A claim that
 * stands on a fallback, a degraded or a failed number and does not say so is
 * DEGRADED_UNSTATED: a stand-in number read as the real one is the error this
 * check exists to stop.
 */
import { newLedger } from './ledger.js';

export const VIOLATIONS = Object.freeze({
  EMPTY_ANSWER: 'empty_answer',
  UNCITED_CLAIM: 'uncited_claim',
  BAD_CITE: 'bad_cite',
  UNGROUNDED_NUMBER: 'ungrounded_number',
  MISSING_AS_OF: 'missing_as_of',
  HEALTH_MISSING: 'health_missing',
  DEGRADED_UNSTATED: 'degraded_unstated'
});

/** A claim that says its number is a stand-in or unhealthy. The fallback field's name also counts. */
const STATES_HEALTH = /\b(fallback|degraded|failed|last good|stale|stand-in)\b/i;

const isEngineTable = table => /^engine_/.test(String(table ?? ''));

/** The cell and every cell it was derived from (ledger.trace), or just the cell. */
const sourcesOf = (book, cite, cell) => (typeof book.trace === 'function' ? book.trace(cite, []) : cell ? [cell] : []);

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
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return false;
  const places = statedPrecision(stated);
  for (const candidate of [numeric, numeric * 100, numeric / 100]) {
    if (candidate === target) return true;
    if (roundTo(candidate, places) === roundTo(target, places)) return true;
  }
  return false;
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
    const unhealthy = new Set();
    for (const cite of cites) {
      const cell = book.cell(cite);
      if (!cell) {
        violations.push({ kind: VIOLATIONS.BAD_CITE, claim_index: claimIndex, cite,
          detail: `${cite} is not in this turn's ledger.` });
        continue;
      }
      cells.push(cell);
      // A derived cite stands on every cell it was computed from, so their health is its health.
      for (const source of sourcesOf(book, cite, cell)) {
        if (!source.health && (source.tables ?? []).some(isEngineTable)) {
          violations.push({ kind: VIOLATIONS.HEALTH_MISSING, claim_index: claimIndex, cite: source.id, text,
            detail: `${source.id} is an engine number read without its health. Read it through engine_read.` });
        }
        const h = source.health;
        if (h && (h.status !== 'ok' || h.fallback_used)) unhealthy.add(h);
      }
    }
    for (const h of unhealthy) {
      if (STATES_HEALTH.test(text) || (h.fallback_field && text.includes(h.fallback_field))) continue;
      violations.push({ kind: VIOLATIONS.DEGRADED_UNSTATED, claim_index: claimIndex, text, field: h.field,
        status: h.status, fallback_field: h.fallback_field,
        detail: `${h.field} for ${h.entity} is served ${h.fallback_used ? `from its fallback ${h.fallback_field}` : h.status}` +
          ` (${h.reason}). Say so in the claim, or leave the number out.` });
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

    if (SPELLED.test(text)) {
      warnings.push({ kind: 'spelled_number', claim_index: claimIndex, text,
        detail: 'A quantity written in words is not checked against the ledger.' });
    }
  });

  const engineCited = allCites.some(cite => sourcesOf(book, cite, book.cell(cite)).some(c => c.health));
  if (engineCited && !String(answer?.health ?? '').trim()) {
    violations.push({ kind: VIOLATIONS.HEALTH_MISSING,
      detail: 'The answer cites engine numbers but does not state their as-of and whether their checks passed.' });
  }

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
