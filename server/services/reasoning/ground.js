/**
 * REASON-01 grounding: every section Claude writes is checked by the same
 * verify.js that gates Coach, against the card's own facts. A section with an
 * invented number, an uncited claim or a cite to a fact that is not there is
 * failed and its words are withheld; the other sections of the panel still
 * ship.
 *
 * Three rules on top of verify.js, each specific to a section:
 * - his_side: no quoted speech. Chat reaches the model only as labels, so a
 *   quote here is one it made up.
 * - news_check: a contradiction must name a news id from the 48 h window it
 *   was given. An id outside it is a story it did not see.
 * - counter: the likely counter and the answer both cite the reply table;
 *   the pre-planned answer is the producer's, not the model's.
 */
import { verifyAnswer } from '../coach/verify.js';
import { factLedger } from './cards.js';

export const REASONING_VIOLATIONS = Object.freeze({
  QUOTE_IN_HIS_SIDE: 'quote_in_his_side',
  UNKNOWN_NEWS_ID: 'unknown_news_id',
  COUNTER_NOT_FROM_REPLY_TABLE: 'counter_not_from_reply_table',
  MISSING_SECTION: 'missing_section'
});

const QUOTED = /["“”][^"“”]{3,}["“”]/;

const claimsOf = v => (Array.isArray(v) ? v.filter(c => c && typeof c === 'object') : []);

function verifyClaims(claims, ledger) {
  if (!claims.length) {
    return { ok: false, violations: [{ kind: REASONING_VIOLATIONS.MISSING_SECTION }], numbers_checked: 0 };
  }
  const r = verifyAnswer({ answer: { claims }, ledger });
  return { ok: r.ok, violations: r.violations, numbers_checked: r.numbers_checked };
}

function withExtra(result, extra) {
  if (!extra.length) return result;
  return { ok: false, violations: [...result.violations, ...extra], numbers_checked: result.numbers_checked };
}

/**
 * Check the model's sections for one card.
 *
 * @param {{ written: object, facts: Record<string, unknown>, newsIds: string[] }} args
 * @returns {Record<string, {ok: boolean, violations: object[], numbers_checked: number, value?: object}>}
 */
export function groundSections({ written, facts, newsIds }) {
  const ledger = factLedger(facts);
  const out = {};

  const caseFor = claimsOf(written?.case_for?.claims);
  out.case_for = { ...verifyClaims(caseFor, ledger), value: { claims: caseFor } };

  const his = claimsOf(written?.his_side?.claims);
  const quotes = his.filter(c => QUOTED.test(String(c.text ?? '')))
    .map(c => ({ kind: REASONING_VIOLATIONS.QUOTE_IN_HIS_SIDE, text: c.text }));
  out.his_side = { ...withExtra(verifyClaims(his, ledger), quotes), value: { claims: his } };

  const devil = claimsOf(written?.devils_advocate?.claims);
  const change = claimsOf(written?.devils_advocate?.would_change);
  const devilCheck = verifyClaims([...devil, ...change], ledger);
  out.devils_advocate = { ...(devil.length && change.length ? devilCheck
    : withExtra(devilCheck, [{ kind: REASONING_VIOLATIONS.MISSING_SECTION, detail: 'needs the case against and what would change the call' }])),
  value: { claims: devil, would_change: change } };

  const contradictions = Array.isArray(written?.news_check?.contradictions) ? written.news_check.contradictions : [];
  const known = new Set(newsIds.map(String));
  const badIds = contradictions.filter(c => !known.has(String(c?.quote_id)))
    .map(c => ({ kind: REASONING_VIOLATIONS.UNKNOWN_NEWS_ID, quote_id: c?.quote_id ?? null }));
  const newsClaims = contradictions.map(c => c?.claim).filter(c => c && typeof c === 'object');
  const newsCheck = newsClaims.length ? verifyAnswer({ answer: { claims: newsClaims }, ledger })
    : { ok: true, violations: [], numbers_checked: 0 };
  out.news_check = {
    ok: newsCheck.ok && !badIds.length && newsClaims.length === contradictions.length,
    violations: [...newsCheck.violations, ...badIds],
    numbers_checked: newsCheck.numbers_checked,
    value: { contradictions: contradictions.map(c => ({ quote_id: String(c.quote_id), claim: c.claim })) }
  };

  const likely = written?.counter?.likely;
  const answer = written?.counter?.answer;
  const counterClaims = [likely, answer].filter(c => c && typeof c === 'object');
  const offTable = counterClaims.filter(c => !(Array.isArray(c.cites) && c.cites.some(id => String(id).startsWith('reply.'))))
    .map(c => ({ kind: REASONING_VIOLATIONS.COUNTER_NOT_FROM_REPLY_TABLE, text: c.text }));
  const counterCheck = counterClaims.length === 2 ? verifyClaims(counterClaims, ledger)
    : { ok: false, violations: [{ kind: REASONING_VIOLATIONS.MISSING_SECTION }], numbers_checked: 0 };
  out.counter = { ...withExtra(counterCheck, offTable), value: { likely, answer } };

  return out;
}
