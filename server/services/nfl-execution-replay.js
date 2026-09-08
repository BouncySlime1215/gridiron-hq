/**
 * The delayed-execution replay — what would actually have been obtainable.
 *
 * A DECISION is made at some instant, against whatever price was quoted then.
 * Nothing takes effect instantly: there is a real gap between seeing a number
 * and being able to act on it, and this module answers, from a FROZEN
 * sequence of historical quotes, what price (if any) would still have been
 * there after a realistic delay.
 *
 * Four honest outcomes, matching the plan's list exactly:
 *
 *   filled_as_decided   the price/line at execution time equals the price/line
 *                       at decision time — nothing moved.
 *   repriced            the book still quotes this exact contract, but at a
 *                       different number. The bet is still takeable; it is
 *                       not the bet that was decided on.
 *   disappeared         the book no longer quotes this contract at all by
 *                       execution time — a removed line, not a moved one.
 *   suspended           the market was explicitly marked suspended (real
 *                       suspensions are rare in an archived quote tape; this
 *                       state exists mainly for the stress-test scenarios in
 *                       nfl-execution-stress.js, e.g. a QB scratch).
 *   capped              a fill would have been available but the requested
 *                       stake exceeds a modeled book limit; only the capped
 *                       amount is obtainable.
 *
 * The core function, `replayDelayedExecution`, is a pure function of its
 * arguments — no wall clock, no randomness — because Package H's own "done
 * when" bar is that the SAME frozen inputs reproduce the SAME decision every
 * time. See test/nfl-execution-replay.test.js for the determinism test that
 * checks this directly, and the exact-reconciliation tests for disappearance/
 * suspension/capping.
 */
import { rows } from '../db/index.js';
import { breakEvenRate } from './nfl-execution.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const iso = v => new Date(v).toISOString();

export const DEFAULT_DELAY_LADDER_SECONDS = Object.freeze([5, 30, 120, 600]); // 5s, 30s, 2m, 10m

/** The last timeline sample at or before `at`. Timeline must already be sorted ascending. */
function latestAtOrBefore(sortedTimeline, at) {
  const target = new Date(at).getTime();
  let chosen = null;
  for (const sample of sortedTimeline) {
    if (new Date(sample.snapshot_at).getTime() <= target) chosen = sample;
    else break;
  }
  return chosen;
}

const sortTimeline = timeline => [...timeline].sort((a, b) => a.snapshot_at.localeCompare(b.snapshot_at));

/**
 * Replay one contract/book's timeline against a decision made at `decisionAt`,
 * realized `delaySeconds` later.
 *
 * `timeline` is an array of samples, oldest first (or any order — it is sorted
 * here): `{ snapshot_at, type: 'quote', price, line }`,
 * `{ snapshot_at, type: 'suspended' }`, or `{ snapshot_at, type: 'removed' }`.
 * A 'removed' sample means the book explicitly stopped quoting this contract
 * as of that instant (used by the feed-outage/QB-scratch stress scenarios);
 * ordinary silence in an archived tape (no sample at all before `decisionAt`)
 * is reported as `no_decision_quote`, which is a different, equally honest
 * failure — there was nothing to decide on, not something that vanished.
 */
export function replayDelayedExecution({ timeline, decisionAt, delaySeconds,
  requestedStakeUnits = 1, bookLimitUnits = Infinity, maxStalenessSeconds = Infinity }) {
  if (!Number.isFinite(requestedStakeUnits) || requestedStakeUnits <= 0) {
    throw new Error('requestedStakeUnits must be a positive number');
  }
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) throw new Error('delaySeconds must be >= 0');
  const sorted = sortTimeline(timeline ?? []);
  const decisionSample = latestAtOrBefore(sorted, decisionAt);

  if (!decisionSample || decisionSample.type !== 'quote') {
    return {
      outcome: 'no_decision_quote', decision_at: iso(decisionAt), delay_seconds: delaySeconds,
      decision_price: null, decision_line: null, obtained_price: null, obtained_line: null,
      requested_stake_units: requestedStakeUnits, obtained_stake_units: 0,
      reason: 'no book quoted this exact contract at or before the decision instant in the frozen timeline'
    };
  }

  const executionAt = new Date(new Date(decisionAt).getTime() + delaySeconds * 1000).toISOString();
  const executionSample = latestAtOrBefore(sorted, executionAt);
  const base = {
    decision_at: iso(decisionAt), execution_at: executionAt, delay_seconds: delaySeconds,
    decision_price: decisionSample.price, decision_line: decisionSample.line,
    requested_stake_units: requestedStakeUnits
  };

  if (!executionSample || executionSample.type === 'removed') {
    return { ...base, outcome: 'disappeared', obtained_price: null, obtained_line: null,
      obtained_stake_units: 0, reason: 'the book no longer quotes this exact contract by execution time' };
  }
  if (executionSample.type === 'suspended') {
    return { ...base, outcome: 'suspended', obtained_price: null, obtained_line: null,
      obtained_stake_units: 0, reason: 'the market was suspended by execution time' };
  }

  // A feed outage does not remove the book's line — it removes OUR ability to
  // see it. The honest response to "our last confirmed quote is older than we
  // are willing to trust" is to refuse the fill, not to reuse a stale number
  // as if it were still current. Reported separately from `disappeared`
  // because the failure is ours, not the book's.
  const stalenessSeconds = (new Date(executionAt).getTime() - new Date(executionSample.snapshot_at).getTime()) / 1000;
  if (Number.isFinite(maxStalenessSeconds) && stalenessSeconds > maxStalenessSeconds) {
    return { ...base, outcome: 'stale_unknown', obtained_price: null, obtained_line: null,
      obtained_stake_units: 0,
      last_known_price: executionSample.price, last_known_line: executionSample.line,
      last_known_at: executionSample.snapshot_at, staleness_seconds: r2(stalenessSeconds),
      reason: `our last confirmed quote for this contract is ${r2(stalenessSeconds)}s old at execution ` +
        `time, past the ${maxStalenessSeconds}s trust window — treated as unknown, not as still available` };
  }

  const stakeUnits = Math.min(requestedStakeUnits, bookLimitUnits);
  const capped = stakeUnits < requestedStakeUnits;
  const priceChanged = executionSample.price !== decisionSample.price || executionSample.line !== decisionSample.line;
  const decisionBreakEven = breakEvenRate(decisionSample.price);
  const executionBreakEven = breakEvenRate(executionSample.price);

  return {
    ...base, outcome: capped ? 'capped' : priceChanged ? 'repriced' : 'filled_as_decided',
    obtained_price: executionSample.price, obtained_line: executionSample.line,
    obtained_stake_units: r2(stakeUnits), capped, book_limit_units: Number.isFinite(bookLimitUnits) ? bookLimitUnits : null,
    // Positive means the price got WORSE (a higher required win rate) by the time it was actually taken.
    breakeven_slippage_bps: (Number.isFinite(decisionBreakEven) && Number.isFinite(executionBreakEven))
      ? r2((executionBreakEven - decisionBreakEven) * 10000) : null,
    line_slippage_points: (Number.isFinite(executionSample.line) && Number.isFinite(decisionSample.line))
      ? r2(executionSample.line - decisionSample.line) : null
  };
}

/** Run the same decision through several delay buckets at once, for one timeline. */
export function replayDelayLadder({ timeline, decisionAt, requestedStakeUnits = 1, bookLimitUnits = Infinity,
  delays = DEFAULT_DELAY_LADDER_SECONDS } = {}) {
  return delays.map(delaySeconds => ({
    delay_seconds: delaySeconds,
    ...replayDelayedExecution({ timeline, decisionAt, delaySeconds, requestedStakeUnits, bookLimitUnits })
  }));
}

/**
 * Build a replay timeline for one exact contract at one book from the raw,
 * immutable quote tape (server/services/nfl-quote-tape.js). This is live/
 * historical data as actually captured — the honest source for a replay,
 * never a synthetic price.
 */
export function timelineFromQuoteTape({ providerEventId, market, sideKey, book, line = null }) {
  const args = [providerEventId, market, sideKey, book];
  let where = 'provider_event_id=? AND market=? AND side_key=? AND bookmaker_key=?';
  if (line != null) { where += ' AND line=?'; args.push(line); }
  return rows(`SELECT snapshot_at, line, american_price FROM nfl_quote_tape
    WHERE ${where} ORDER BY snapshot_at`, ...args)
    .map(q => ({ snapshot_at: q.snapshot_at, type: 'quote', price: q.american_price, line: q.line }));
}

/**
 * Build a replay timeline from a FROZEN evidence-dataset extract
 * (nfl-evidence-dataset.js) instead of a live query — this is what makes a
 * replay re-runnable against a cited, content-hashed input rather than
 * whatever the live tape happens to contain today.
 */
export function timelineFromFrozenRows(frozenRows, { contractKey, book }) {
  return (frozenRows ?? [])
    .filter(r => r.contract_key === contractKey && r.book === book)
    .sort((a, b) => a.snapshot_at.localeCompare(b.snapshot_at))
    .map(r => ({ snapshot_at: r.snapshot_at, type: 'quote', price: r.price, line: r.line }));
}

/**
 * The full replay, cited against a frozen dataset. This is the function that
 * makes the "done when" bar checkable: given the same `frozenRows` (which
 * carry the evidence dataset's own content hash upstream) and the same
 * `decisionAt`/`delaySeconds`, this reproduces byte-identical output every
 * time, because every step underneath it is a pure function of its inputs.
 */
export function replayFromFrozenDataset({ frozenRows, contractKey, book, decisionAt, delaySeconds,
  requestedStakeUnits = 1, bookLimitUnits = Infinity }) {
  const timeline = timelineFromFrozenRows(frozenRows, { contractKey, book });
  return {
    contract_key: contractKey, book,
    ...replayDelayedExecution({ timeline, decisionAt, delaySeconds, requestedStakeUnits, bookLimitUnits })
  };
}
