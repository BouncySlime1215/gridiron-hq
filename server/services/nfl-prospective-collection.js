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

export async function runProspectiveCollection({ newsLimit = 10, sinceDays = 2 } = {}) {
  const startedAt = new Date().toISOString();
  const errors = [];

  let quoteCapture;
  if (!hasOddsKey()) {
    quoteCapture = { skipped: true, reason: 'ODDS_API_KEY is not configured' };
  } else {
    try { quoteCapture = await captureCurrentQuoteTape(); }
    catch (e) { quoteCapture = { error: e.message }; errors.push(`quote capture: ${e.message}`); }
  }

  let newsExtraction;
  try { newsExtraction = await extractNewsEventsFromItems({ sinceDays, limit: newsLimit }); }
  catch (e) { newsExtraction = { error: e.message }; errors.push(`news extraction: ${e.message}`); }

  const bothFailed = Boolean(quoteCapture?.error) && Boolean(newsExtraction?.error);
  const status = errors.length === 0 ? 'ok' : bothFailed ? 'error' : 'partial';
  const detail = { quote_capture: quoteCapture, news_extraction: newsExtraction, errors };
  recordSync(PROSPECTIVE_COLLECTION_SOURCE, status, detail);

  return { started_at: startedAt, finished_at: new Date().toISOString(), status,
    quote_capture: quoteCapture, news_extraction: newsExtraction, errors,
    restart_limitation: RESTART_LIMITATION };
}
