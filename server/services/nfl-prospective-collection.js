/**
 * Execution brief Phase 3: prospective evidence collection.
 *
 * Runs a real quote-tape snapshot (nfl-quote-tape.js) and bounded typed-news
 * extraction (nfl-news-events.js) TOGETHER, in one action, because that is
 * the only way a forward claim/quote pair can ever form. Package E's own
 * frozen report already found the reason zero pairs exist: every claim is
 * stamped with the moment the extractor ran, and that moment is after the
 * one real week of quote tape that exists — see
 * docs/PROFITABILITY_EXECUTION_PLAN.md. Running the extractor again without
 * the quote tape also moving forward would reproduce exactly the same null
 * result; running them together is what gives a genuinely new claim a
 * chance to land inside a genuinely current tape.
 *
 * DELIBERATELY NOT A SCHEDULED JOB. `SCHEDULER_DISABLED` is set by an
 * explicit operator decision (server/services/scheduler.js's own dated
 * comment), and this phase does not depend on it or attempt to change it.
 * `runProspectiveCollection` runs once, when called, the same manual-action
 * pattern `nfl-execution-pipeline.js` already established for Phase 2 — a
 * button press, not a cron entry. That has a real, honest consequence,
 * stated on every result rather than left for someone to discover the hard
 * way: collection stops the instant this app is closed or the machine
 * sleeps. There is no restartable background collector in this build, and
 * this function does not claim to be one.
 *
 * BOTH HALVES COST REAL MONEY. The Odds API quota (already metered
 * elsewhere in this app — see /betting/summary's odds_api block) for the
 * quote-tape capture, and Anthropic API spend (Haiku 4.5; Package E's own
 * measured cost for a bounded run was $0.0148) for the news extraction.
 * `newsLimit` bounds the extraction batch size; there is no automatic
 * retry on failure — a failed attempt is reported and stops, never
 * silently retried and re-charged. This module never calls itself; nothing
 * in this codebase invokes it from a timer.
 */
import { captureCurrentQuoteTape } from './nfl-quote-tape.js';
import { hasKey as hasOddsKey } from './odds-api.js';
import { extractNewsEventsFromItems } from './nfl-news-events.js';
import { recordSync } from './scheduler.js';

export const PROSPECTIVE_COLLECTION_SOURCE = 'nfl_prospective_collection';
export const RESTART_LIMITATION = 'Manual, on-demand collection only — not a background daemon. ' +
  'Collection stops the moment this app is closed or the machine sleeps. SCHEDULER_DISABLED is set ' +
  'by an explicit operator decision; this function does not depend on it or attempt to change it.';

/**
 * What one half of the collection actually did (Codex audit finding E10).
 *
 * The old status logic only counted a half as failed if it THREW. Both
 * halves routinely return `{ error }` or `{ skipped }` instead — a provider
 * returning no snapshot, a missing API key — and those runs were reported
 * `ok`, which then advanced a sync heartbeat as though data had been
 * collected. "Nothing ran" and "everything worked" have to be different
 * answers.
 *
 *   error    it returned or threw an error.
 *   skipped  it did not run at all (no key configured, nothing to do).
 *   empty    it ran successfully and found nothing new. Honest and common;
 *            distinguished from `ok` so a long run of empties is visible
 *            rather than looking like continuous successful collection.
 *   ok       it ran and produced something.
 */
function classifyHalf(result, countOf) {
  if (!result || result.error) return 'error';
  if (result.skipped) return 'skipped';
  const count = countOf(result);
  return Number.isFinite(count) && count > 0 ? 'ok' : 'empty';
}

/**
 * One truthful status for the whole run, from what each half actually did.
 * The rule that matters: a run is only `ok` when every half genuinely
 * produced data. Nothing running at all is `blocked`, not success.
 */
function overallStatus(halves) {
  if (halves.every(s => s === 'skipped')) return 'blocked';
  // Nothing was collected AND something broke: not a partial success.
  if (halves.every(s => s === 'error' || s === 'skipped')) return 'error';
  if (halves.every(s => s === 'empty')) return 'empty';
  if (halves.some(s => s === 'error' || s === 'skipped' || s === 'empty')) return 'partial';
  return 'ok';
}

/**
 * Only a half that genuinely produced data may set a successful-data
 * watermark. A skipped or empty run must not leave behind a timestamp that
 * later reads as "we had fresh data at this moment" — that is exactly how a
 * silent collection outage comes to look healthy on a status page.
 */
function watermarkFor(halves, finishedAt) {
  return halves.some(s => s === 'ok') ? finishedAt : null;
}

export async function runProspectiveCollection({ newsLimit = 10, sinceDays = 2 } = {}) {
  const startedAt = new Date().toISOString();
  const errors = [];

  let quoteCapture;
  if (!hasOddsKey()) {
    quoteCapture = { skipped: true, reason: 'ODDS_API_KEY is not configured' };
  } else {
    try { quoteCapture = await captureCurrentQuoteTape(); }
    catch (e) { quoteCapture = { error: e.message }; }
  }

  let newsExtraction;
  try { newsExtraction = await extractNewsEventsFromItems({ sinceDays, limit: newsLimit }); }
  catch (e) { newsExtraction = { error: e.message }; }

  // A returned `{ error }` counts exactly like a thrown one. This is the
  // defect: both halves can fail by RETURNING, and the old code only looked
  // for throws.
  const quoteStatus = classifyHalf(quoteCapture, r => r.quotes ?? r.events ?? null);
  const newsStatus = classifyHalf(newsExtraction, r => r.accepted);
  if (quoteCapture?.error) errors.push(`quote capture: ${quoteCapture.error}`);
  if (newsExtraction?.error) errors.push(`news extraction: ${newsExtraction.error}`);

  const halves = [quoteStatus, newsStatus];
  const status = overallStatus(halves);
  const finishedAt = new Date().toISOString();
  const lastSuccessfulDataAt = watermarkFor(halves, finishedAt);

  const detail = { quote_capture: quoteCapture, news_extraction: newsExtraction, errors,
    half_status: { quote_capture: quoteStatus, news_extraction: newsStatus },
    last_successful_data_at: lastSuccessfulDataAt,
    note: lastSuccessfulDataAt
      ? null
      : 'no half of this run produced new data — this run advances no successful-data watermark' };
  recordSync(PROSPECTIVE_COLLECTION_SOURCE, status, detail);

  return { started_at: startedAt, finished_at: finishedAt, status,
    half_status: detail.half_status, last_successful_data_at: lastSuccessfulDataAt,
    quote_capture: quoteCapture, news_extraction: newsExtraction, errors,
    restart_limitation: RESTART_LIMITATION };
}

/** Pure status decisions, exported for direct test coverage of every
 * combination without spending real API money on either half. */
export const __test = { classifyHalf, overallStatus, watermarkFor };
