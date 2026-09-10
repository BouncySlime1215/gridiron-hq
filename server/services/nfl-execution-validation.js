/** Validation shared by execution routes and ledger primitives. No database or model side effects. */
export function executionInputError(message, code = 'invalid_execution_input') {
  return Object.assign(new Error(message), { code, status: 400 });
}

export function validAmericanPrice(value) {
  return Number.isFinite(value) && Number.isInteger(value) && Math.abs(value) >= 100;
}

export function assertExecutionPrice(price) {
  if (!validAmericanPrice(price)) throw executionInputError('price must be integer American odds at or beyond -100/+100');
}

export function assertExecutionStake(stakeUnits, price) {
  if (!Number.isFinite(stakeUnits) || stakeUnits <= 0) {
    throw executionInputError('stakeUnits must be a positive finite number');
  }
  const payout = price > 0 ? price / 100 : 100 / -price;
  if (!Number.isFinite(stakeUnits * payout)) throw executionInputError('stake and price produce a non-finite payout');
}

/** SQLite's timezone-less storage timestamps are UTC, never machine-local time. */
export function executionTime(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z` : value;
  return Date.parse(normalized);
}

/** v1 spread keys have no player/stat fields; read immutable terms, not caller labels. */
export function spreadContractTerms(key) {
  const parts = String(key ?? '').split('|');
  if (parts.length !== 10 || parts[0] !== 'nfl' || parts[3] !== 'spreads'
      || !['home', 'away'].includes(parts[6]) || parts[9] !== 'margin_vs_line') return null;
  const line = Number(parts[7]);
  if (!parts[7].trim() || !Number.isFinite(line) || !Number.isInteger(line * 2) || Math.abs(line) > 60) return null;
  return { line, side: parts[6], period: parts[4], overtime: parts[8] };
}

export function assertSpreadLine(contractKey, line) {
  const terms = spreadContractTerms(contractKey);
  if (!terms) throw executionInputError('unresolved immutable spread contract');
  if (!Number.isFinite(line)) throw executionInputError('the actual spread line is required');
  if (line !== terms.line) {
    throw executionInputError('changed spread line requires a new exact-contract opportunity', 'contract_line_changed');
  }
  return terms;
}
