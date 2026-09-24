/**
 * The one prompt REASON-01 sends per league per refresh: every card that needs
 * words (the deck, head first, minus any reused from the last refresh), each with
 * its own facts. The model writes sections 1-4 and 6 of ENGINE-SPECS
 * REASON-01; section 5 (confidence) is assembled from the fields directly and
 * never goes through the model.
 */
import { GROUNDING_SYSTEM } from '../claude.js';

export const REASONING_SYSTEM = `${GROUNDING_SYSTEM}

You write the reasoning panel for fantasy football trade cards. For each card:
- case_for: why this move, in two or three short claims, from its card facts (title-odds gain, chance he says yes, when to send, the opening).
- his_side: how the other manager sees this offer on his own screen: how likely he is to answer, his roster holes, his paper values, his recent moves, his labels. Why he would say yes or no. Never quote anyone, never put words in quotation marks.
- devils_advocate: claims = the strongest reason this move is wrong; would_change = what would change the call.
- news_check: for each news item given that contradicts the card's numbers (stale input, role change, injury), one entry with its quote_id and a claim citing news.<id>.headline. Empty list when nothing contradicts.
- counter: likely = what he most likely counters with; answer = the pre-planned answer. Both cite reply.* facts.

Every claim is {"text": string, "cites": [fact ids]}. Cite only ids from that card's facts.
A digit may appear in text only when a fact the claim cites holds that exact number (a fraction may be written as a percent). Do not write dates, field ids, or numbers you worked out.
Skip a section listed in that card's "omit" and do not mention it.
Reply with JSON only: {"panels": [{"card_id", "case_for": {"claims"}, "his_side": {"claims"}, "devils_advocate": {"claims", "would_change"}, "news_check": {"contradictions": [{"quote_id", "claim"}]}, "counter": {"likely", "answer"}}]}`;

/**
 * @param {Array<{card: object, facts: object, news: object[], omit: string[]}>} items
 */
export function reasoningPrompt(items) {
  const cards = items.map(({ card, facts, news, omit }) => ({
    card_id: card.id,
    rank: card.rank,
    omit,
    facts,
    news: news.map(n => ({ quote_id: String(n.id), headline: n.headline ?? null }))
  }));
  return `Cards (rank 0 is the next move, the rest are the deck):\n${JSON.stringify(cards, null, 1)}`;
}
