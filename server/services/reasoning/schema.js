/**
 * The reasoning panel's contract, checked before a panel is written out. A
 * panel that fails this is a producer bug, so the run stops rather than ship
 * something the War Room would have to guess at.
 */
import { SECTIONS } from './panel.js';

const STATUSES = new Set(['ok', 'zero', 'thin', 'stale', 'fallback', 'unknown', 'failed']);
const DIGIT = /\d/;

function claimErrors(claims, where) {
  if (!Array.isArray(claims)) return [`${where} is not a list`];
  return claims.flatMap((c, i) => {
    const e = [];
    if (typeof c?.text !== 'string' || !c.text.trim()) e.push(`${where}[${i}].text is empty`);
    if (!Array.isArray(c?.cites) || !c.cites.length) e.push(`${where}[${i}] has no cites`);
    return e;
  });
}

function valueErrors(name, v) {
  const at = `sections.${name}.value`;
  switch (name) {
    case 'case_for':
    case 'his_side':
      return claimErrors(v?.claims, `${at}.claims`);
    case 'devils_advocate':
      return [...claimErrors(v?.claims, `${at}.claims`), ...claimErrors(v?.would_change, `${at}.would_change`)];
    case 'news_check':
      if (typeof v?.window_hours !== 'number' || !Array.isArray(v?.contradictions)) return [`${at} is malformed`];
      return v.contradictions.flatMap((c, i) => [
        ...(typeof c?.quote_id === 'string' && c.quote_id ? [] : [`${at}.contradictions[${i}].quote_id missing`]),
        ...claimErrors([c?.claim], `${at}.contradictions[${i}].claim`)
      ]);
    case 'confidence':
      return typeof v?.p_yes === 'number' && typeof v?.calibrated === 'boolean' && typeof v?.why === 'string'
        ? [] : [`${at} is malformed`];
    case 'counter':
      return [...claimErrors([v?.likely], `${at}.likely`), ...claimErrors([v?.answer], `${at}.answer`)];
    default:
      return [`${name} is not a section`];
  }
}

/** Every way `panel` breaks the contract; empty when it holds. */
export function panelErrors(panel) {
  const errors = [];
  if (typeof panel?.card_id !== 'string' || !panel.card_id) errors.push('card_id missing');
  if (!Number.isInteger(panel?.rank) || panel.rank < 0) errors.push('rank must be a non-negative integer');
  if (typeof panel?.check_first !== 'boolean') errors.push('check_first must be boolean');
  if (!Array.isArray(panel?.check_first_quote_ids)) errors.push('check_first_quote_ids must be a list');
  else if (panel.check_first !== panel.check_first_quote_ids.length > 0) errors.push('check_first disagrees with its quote ids');
  for (const name of SECTIONS) {
    const f = panel?.sections?.[name];
    if (!f) { errors.push(`sections.${name} missing`); continue; }
    if (!STATUSES.has(f.status)) errors.push(`sections.${name}.status "${f.status}" is not a field status`);
    if (!f.producer || !f.producer_version || !f.source) errors.push(`sections.${name} lacks producer/version/source`);
    if (f.status === 'failed' || f.status === 'unknown') {
      if ('value' in f) errors.push(`sections.${name} is ${f.status} but carries a value`);
      if (typeof f.reason !== 'string' || !f.reason) errors.push(`sections.${name} is ${f.status} with no reason`);
      if (f.status === 'failed' && DIGIT.test(f.reason ?? '')) errors.push(`sections.${name} failed reason contains digits`);
    } else {
      errors.push(...valueErrors(name, f.value));
    }
  }
  return errors;
}
