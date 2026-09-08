// A stored snapshot can expire even when no ingestion job clears its cache.
export const SHOPPING_MAX_AGE_MS = 15 * 60 * 1000;

export function quoteClockValid(quote, now = Date.now()) {
  const captured = Date.parse(quote.captured_at);
  const kickoff = Date.parse(quote.commence_time);
  return Number.isFinite(captured) && Number.isFinite(kickoff)
    && captured <= now && now - captured <= SHOPPING_MAX_AGE_MS
    && kickoff > now;
}
