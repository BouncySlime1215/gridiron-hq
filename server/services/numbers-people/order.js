/**
 * NUMBERS-PEOPLE order (Nick, 2026-09-26): best first, from "both say go" down to "both say avoid".
 *
 * Each card's rank comes from both lanes' calls (go = 2, wait = 1, avoid = 0), with agreement
 * ahead of a split at the same total:
 *   0  both go (agree, or the same call for different reasons)
 *   1  one go, one wait
 *   2  both wait
 *   3  one go, one avoid (a real split)
 *   4  one wait, one avoid
 *   5  both avoid
 * No chat read: ranked by Claude's call alone, just below the matching both-agree row
 * (go 0.5, wait 2.5, avoid 5.5).
 * Tie-breaks: the odds gain if landed, descending, then the chance of a deal, descending,
 * then the producer's own order. One order for the Trades tab, "Show all" and Coach.
 */
const PAIR = { 'go|go': 0, 'go|wait': 1, 'wait|wait': 2, 'avoid|go': 3, 'avoid|wait': 4, 'avoid|avoid': 5 };
const ALONE = { go: 0.5, wait: 2.5, avoid: 5.5 };
/** Which fact is "the odds gain if landed" and "the chance of a deal" for each kind of item. */
export const GAIN_KEYS = Object.freeze(['gain_if_landed', 'title_gain_if_complete', 'edge']);
export const DEAL_KEYS = Object.freeze(['p_reach', 'p_complete', 'p_yes_first_step', 'p_responds']);

/** The rank of one card (lower is better); null when Claude's lane has no stance. */
export function rankOf(claude, jev) {
  if (!claude) return null;
  if (!jev) return ALONE[claude] ?? null;
  return PAIR[[claude, jev].sort().join('|')] ?? null;
}

/** The band a card belongs to in the summary line: 'go' | 'split' | 'avoid' | 'wait' | 'no_read'. */
export function bandOf(claude, jev) {
  if (!jev) return 'no_read';
  if (claude !== jev) return 'split';
  return claude;
}

const first = (facts, keys) => {
  for (const k of keys) if (typeof facts?.[k] === 'number') return facts[k];
  return null;
};

/**
 * Sort cards best first. Each card: { claude, jev, facts, order } where facts holds the plan's
 * numbers (items.js keys). Returns a new array.
 */
export function bestFirst(cards) {
  const desc = (a, b) => (b ?? -Infinity) - (a ?? -Infinity);
  return [...cards].sort((a, b) => ((rankOf(a.claude, a.jev) ?? 9) - (rankOf(b.claude, b.jev) ?? 9))
    || desc(first(a.facts, GAIN_KEYS), first(b.facts, GAIN_KEYS))
    || desc(first(a.facts, DEAL_KEYS), first(b.facts, DEAL_KEYS))
    || (a.order - b.order));
}
