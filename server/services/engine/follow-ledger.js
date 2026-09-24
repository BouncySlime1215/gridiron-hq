/** SELF-01a follow ledger. RED stub: every entry point is present and does nothing. */
export const NEAR_TIE_EPSILON = 0;
export function decisionsFromRecs() { return []; }
export function logShown() { return { state: 'not_built', inserted: 0, skipped: 0 }; }
export function logNextMove() { return { state: 'not_built', inserted: 0, skipped: 0 }; }
export function backfillFromRecLedger() { return { state: 'not_built', inserted: 0, skipped: 0 }; }
export function resolveDue() { return { state: 'not_built', resolved: 0 }; }
export function followSummary() { return { unresolved: {} }; }
