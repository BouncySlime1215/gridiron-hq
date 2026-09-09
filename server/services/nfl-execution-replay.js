/**
 * The delayed-execution replay — what would actually have been obtainable.
 *
 * A DECISION is made at some instant, against whatever price was quoted then.
 * Nothing takes effect instantly: there is a real gap between seeing a number
 * and being able to act on it, and this module answers, from a FROZEN
 * sequence of historical quotes, what price (if any) would still have been
 * there after a realistic delay.
 *
 * Five honest outcomes, plus two staleness outcomes that are not price
 * outcomes at all — they mean the timeline could not support a claim either way:
 *
 *   filled_as_decided     the price/line at execution time equals the price/line
 *                         at decision time — nothing moved.
 *   repriced              the book still quotes this exact contract, but at a
 *                         different number. The bet is still takeable; it is
 *                         not the bet that was decided on.
 *   disappeared           the book no longer quotes this contract at all by
 *                         execution time — a removed line, not a moved one.
 *   suspended             the market was explicitly marked suspended (real
 *                         suspensions are rare in an archived quote tape; this
 *                         state exists mainly for the stress-test scenarios in
 *                         nfl-execution-stress.js, e.g. a QB scratch).
 *   capped                a fill would have been available but the requested
 *                         stake exceeds a modeled book limit; only the capped
 *                         amount is obtainable.
 *   no_decision_quote     nothing was quoted at or before the decision instant
 *                         at all — there was no price to decide on.
 *   decision_stale_unknown / stale_unknown   the only quote this system can
 *                         point to (at decision time / at execution time,
 *                         respectively) is older than the trust window below.
 *                         A missing response or a quiet tape is UNKNOWN
 *                         availability, never proof the price disappeared or
 *                         proof it remained obtainable — see the availability
 *                         policy comment on `DEFAULT_MAX_STALENESS_SECONDS`.
 *
 * The core function, `replayDelayedExecution`, is a pure function of its
 * arguments — no wall clock, no randomness — because Package H's own "done
 * when" bar is that the SAME frozen inputs reproduce the SAME decision every
 * time. See test/nfl-execution-replay.test.js for the determinism test that
 * checks this directly, and the exact-reconciliation tests for disappearance/
 * suspension/capping/staleness.
 */
import { rows } from '../db/index.js';
import { breakEvenRate } from './nfl-execution.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const iso = v => new Date(v).toISOString();

export const DEFAULT_DELAY_LADDER_SECONDS = Object.freeze([5, 30, 120, 600]); // 5s, 30s, 2m, 10m

/**
 * The availability/freshness policy every economic replay entry point in this
 * file applies UNLESS a caller explicitly overrides it for a labeled research
 * scenario (see `availabilityAssumptions` below — an override is always
 * disclosed on the result, never silently absorbed).
 *
 * Both defaults used to be `Infinity`. That is the exact defect the
 * architecture assessment's Phase 1 flags: an unbounded trust window means a
 * feed outage of any length is silently reported as "the price was still
 * there," because nothing ever timed out. Replacing `Infinity` with a real
 * number is what makes "unobserved availability" stop being able to become
 * an asserted fill through a default parameter.
 *
 * MAX_STALENESS_SECONDS is derived from this project's own capture cadence,
 * not a borrowed constant: `nfl_quote_batches.snapshot_at`, 624 real polls,
 * has a median gap of 360s and a p90 gap of 1,223s between successful
 * captures. 1,800s (30 minutes) sits comfortably past the p90 — it tolerates
 * one genuinely missed poll cycle without manufacturing false staleness, but
 * a quote older than that is treated as unknown rather than current. Re-derive
 * this if the capture cadence changes materially:
 *   SELECT snapshot_at FROM nfl_quote_batches ORDER BY snapshot_at
 *   (diff consecutive timestamps; recompute the median/p90).
 *
 * BOOK_LIMIT_UNITS has no real-data equivalent to derive from: this project
 * has no sportsbook account connected and no observed limit history (see
 * `nfl-execution-lifecycle.js` — `fill_confirmed` is schema-constrained to 0
 * for exactly this reason). It stays unmodeled — `null`, not a guessed
 * number and not `Infinity` presented as if it were verified — and every
 * result says so explicitly via `book_limit_modeled: false` rather than
 * leaving a caller to infer "no cap was hit" from an absent field.
 */
export const AVAILABILITY_POLICY_VERSION = 'nfl-execution-availability-policy-v1';
export const DEFAULT_MAX_STALENESS_SECONDS = 1800;
export const DEFAULT_BOOK_LIMIT_UNITS = null;

function availabilityAssumptions(maxStalenessSeconds, bookLimitUnits) {
  return {
    policy_version: AVAILABILITY_POLICY_VERSION,
    max_staleness_seconds: Number.isFinite(maxStalenessSeconds) ? maxStalenessSeconds : null,
    max_staleness_disabled: !Number.isFinite(maxStalenessSeconds),
    max_staleness_is_default: maxStalenessSeconds === DEFAULT_MAX_STALENESS_SECONDS,
    book_limit_units: Number.isFinite(bookLimitUnits) ? bookLimitUnits : null,
    book_limit_modeled: Number.isFinite(bookLimitUnits),
    note: Number.isFinite(bookLimitUnits)
      ? null
      : 'no observed or modeled book limit for this replay — a fill here is unconstrained by size, ' +
        'which is a labeled absence of data, not evidence that no real limit exists'
  };
}

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
 * as of that instant (used by the feed-outage/QB-scratch stress scenarios, and
 * by `timelineFromQuoteTape`'s sibling-row evidence below); ordinary silence
 * in an archived tape (no sample at all before `decisionAt`, or the last
 * sample older than the trust window) is reported as `no_decision_quote` or
 * `*_stale_unknown` — a different, equally honest failure. There was nothing
 * to decide on, or nothing recent enough to trust, not something that vanished.
 */
export function replayDelayedExecution({ timeline, decisionAt, delaySeconds,
  requestedStakeUnits = 1, bookLimitUnits = DEFAULT_BOOK_LIMIT_UNITS,
  maxStalenessSeconds = DEFAULT_MAX_STALENESS_SECONDS }) {
  if (!Number.isFinite(requestedStakeUnits) || requestedStakeUnits <= 0) {
    throw new Error('requestedStakeUnits must be a positive number');
  }
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) throw new Error('delaySeconds must be >= 0');
  const assumptions = availabilityAssumptions(maxStalenessSeconds, bookLimitUnits);
  const sorted = sortTimeline(timeline ?? []);
  const decisionSample = latestAtOrBefore(sorted, decisionAt);

  if (!decisionSample || decisionSample.type !== 'quote') {
    return {
      outcome: 'no_decision_quote', decision_at: iso(decisionAt), delay_seconds: delaySeconds,
      decision_price: null, decision_line: null, obtained_price: null, obtained_line: null,
      requested_stake_units: requestedStakeUnits, obtained_stake_units: 0,
      reason: 'no book quoted this exact contract at or before the decision instant in the frozen timeline',
      availability_assumptions: assumptions
    };
  }

  // A decision made off a quote that was already too old to trust is not a
  // valid decision to begin with — the same "unknown, not current" rule that
  // applies at execution time applies here first. Checked before computing
  // anything downstream so a stale decision quote can never silently become
  // the reference price for an edge calculation.
  const decisionStalenessSeconds = (new Date(decisionAt).getTime() - new Date(decisionSample.snapshot_at).getTime()) / 1000;
  if (Number.isFinite(maxStalenessSeconds) && decisionStalenessSeconds > maxStalenessSeconds) {
    return {
      outcome: 'decision_stale_unknown', decision_at: iso(decisionAt), delay_seconds: delaySeconds,
      decision_price: null, decision_line: null, obtained_price: null, obtained_line: null,
      requested_stake_units: requestedStakeUnits, obtained_stake_units: 0,
      last_known_price: decisionSample.price, last_known_line: decisionSample.line,
      last_known_at: decisionSample.snapshot_at, staleness_seconds: r2(decisionStalenessSeconds),
      reason: `the last quote at or before the decision instant is ${r2(decisionStalenessSeconds)}s old, past ` +
        `the ${maxStalenessSeconds}s trust window — the decision itself would have been made on a price that ` +
        'may no longer have reflected the book, not merely one that later moved',
      availability_assumptions: assumptions
    };
  }

  const executionAt = new Date(new Date(decisionAt).getTime() + delaySeconds * 1000).toISOString();
  const executionSample = latestAtOrBefore(sorted, executionAt);
  const base = {
    decision_at: iso(decisionAt), execution_at: executionAt, delay_seconds: delaySeconds,
    decision_price: decisionSample.price, decision_line: decisionSample.line,
    requested_stake_units: requestedStakeUnits, availability_assumptions: assumptions
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
  // because the failure is ours, not the book's. An UNCHANGED but directly
  // refreshed quote is not stale by this rule: every successful poll writes
  // its own sample (see `timelineFromQuoteTape`), so a repeated identical
  // price with a later `snapshot_at` correctly resets this clock — staleness
  // measures time since our last successful look, not time since the price
  // last changed.
  const stalenessSeconds = (new Date(executionAt).getTime() - new Date(executionSample.snapshot_at).getTime()) / 1000;
  if (Number.isFinite(maxStalenessSeconds) && stalenessSeconds > maxStalenessSeconds) {
    return { ...base, outcome: 'stale_unknown', obtained_price: null, obtained_line: null,
      obtained_stake_units: 0,
      last_known_price: executionSample.price, last_known_line: executionSample.line,
      last_known_at: executionSample.snapshot_at, staleness_seconds: r2(stalenessSeconds),
      reason: `our last confirmed quote for this contract is ${r2(stalenessSeconds)}s old at execution ` +
        `time, past the ${maxStalenessSeconds}s trust window — treated as unknown, not as still available` };
  }

  const stakeUnits = Math.min(requestedStakeUnits, Number.isFinite(bookLimitUnits) ? bookLimitUnits : Infinity);
  const capped = Number.isFinite(bookLimitUnits) && stakeUnits < requestedStakeUnits;
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

/**
 * Run the same decision through several delay buckets at once, for one
 * timeline. `maxStalenessSeconds`/`bookLimitUnits` used to be silently
 * dropped here — this ladder is the primary way Package H reports economic
 * results, so a caller who set a real freshness policy on the underlying
 * call had it thrown away at exactly the entry point that matters most.
 */
export function replayDelayLadder({ timeline, decisionAt, requestedStakeUnits = 1,
  bookLimitUnits = DEFAULT_BOOK_LIMIT_UNITS, maxStalenessSeconds = DEFAULT_MAX_STALENESS_SECONDS,
  delays = DEFAULT_DELAY_LADDER_SECONDS } = {}) {
  return delays.map(delaySeconds => ({
    delay_seconds: delaySeconds,
    ...replayDelayedExecution({ timeline, decisionAt, delaySeconds, requestedStakeUnits, bookLimitUnits, maxStalenessSeconds })
  }));
}

/**
 * Build a replay timeline for one exact contract at one book from the raw,
 * immutable quote tape (server/services/nfl-quote-tape.js). This is live/
 * historical data as actually captured — the honest source for a replay,
 * never a synthetic price.
 *
 * Every successful poll writes its own row with its own `snapshot_at` (see
 * `nfl-quote-tape.js#ingestQuoteSnapshot` — `quote_id` hashes the full record
 * including `snapshot_at`, so an unchanged price from a fresh poll is a new
 * row, not a dedup no-op). That is what makes "last successful retrieval" and
 * "last price change" genuinely different, recoverable facts from this table,
 * exactly as the plan asks: a run of identical-price rows is repeated
 * confirmation the quote was current, not one stale sample stretched forward.
 *
 * This used to map every row to `type: 'quote'` and nothing else, so a book
 * that stopped offering this exact side/line was indistinguishable from a
 * book we simply failed to poll — both looked like silence. It is now able to
 * report a genuine `removed` sample: at any batch where this exact book DID
 * report something else for the same event and market (a different side, or
 * the same side at a different line) but NOT this exact contract, that is
 * real evidence the book chose not to quote it at that instant, not evidence
 * that our capture failed. Ordinary silence — no row for this book at all in
 * a batch, while other books may or may not have reported — is never
 * synthesized into a sample at any type: it stays absent, and the staleness
 * check in `replayDelayedExecution` is what turns a long enough absence into
 * an honest `stale_unknown` rather than a manufactured `disappeared`.
 */
export function timelineFromQuoteTape({ providerEventId, market, sideKey, book, line = null }) {
  const exactArgs = [providerEventId, market, sideKey, book];
  let exactWhere = 'provider_event_id=? AND market=? AND side_key=? AND bookmaker_key=?';
  if (line != null) { exactWhere += ' AND line=?'; exactArgs.push(line); }
  const quotes = rows(`SELECT snapshot_at, line, american_price FROM nfl_quote_tape
    WHERE ${exactWhere} ORDER BY snapshot_at`, ...exactArgs)
    .map(q => ({ snapshot_at: q.snapshot_at, type: 'quote', price: q.american_price, line: q.line }));

  const siblingArgs = [providerEventId, market, book];
  let excludeExact = 'side_key=?'; siblingArgs.push(sideKey);
  if (line != null) { excludeExact += ' AND line=?'; siblingArgs.push(line); }
  const siblingBatches = rows(`SELECT DISTINCT snapshot_at FROM nfl_quote_tape
    WHERE provider_event_id=? AND market=? AND bookmaker_key=? AND NOT (${excludeExact})
    ORDER BY snapshot_at`, ...siblingArgs);
  const quotedAt = new Set(quotes.map(q => q.snapshot_at));
  const removed = siblingBatches
    .filter(b => !quotedAt.has(b.snapshot_at))
    .map(b => ({ snapshot_at: b.snapshot_at, type: 'removed' }));

  return [...quotes, ...removed].sort((a, b) => a.snapshot_at.localeCompare(b.snapshot_at));
}

/**
 * Build a replay timeline from a FROZEN evidence-dataset extract
 * (nfl-evidence-dataset.js) instead of a live query — this is what makes a
 * replay re-runnable against a cited, content-hashed input rather than
 * whatever the live tape happens to contain today.
 *
 * KNOWN LIMITATION, disclosed rather than silently inherited: the frozen
 * evidence-dataset row shape carries no market-status concept at all (see
 * `nfl-evidence-dataset.js` — its rows are `{contract_key, book, snapshot_at,
 * price, line}`, nothing else). Every sample built from it is therefore
 * `type: 'quote'`; a frozen-dataset replay can report `stale_unknown` for a
 * long gap, but it can never report a genuine `disappeared` the way a live
 * `timelineFromQuoteTape` replay now can, because the frozen format has
 * nowhere to record that a book explicitly stopped quoting something.
 * `replayFromFrozenDataset` labels this on its result (`market_status_source`)
 * so a reader does not mistake "never saw a disappearance" for "confirmed this
 * never disappeared."
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
  requestedStakeUnits = 1, bookLimitUnits = DEFAULT_BOOK_LIMIT_UNITS,
  maxStalenessSeconds = DEFAULT_MAX_STALENESS_SECONDS }) {
  const timeline = timelineFromFrozenRows(frozenRows, { contractKey, book });
  return {
    contract_key: contractKey, book, market_status_source: 'frozen_dataset_no_status_history',
    ...replayDelayedExecution({ timeline, decisionAt, delaySeconds, requestedStakeUnits, bookLimitUnits, maxStalenessSeconds })
  };
}
