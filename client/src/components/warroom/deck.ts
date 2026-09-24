/**
 * The NEXT MOVE swipe deck, as a pure reducer (WAR-ROOM-UI.md v2 section 4).
 *
 * Next (button, swipe left, left arrow) wipes the card and shows the next-best; Back
 * undoes the last skip; Do it (swipe right, right arrow) picks the card. After a skip an
 * optional one-tap reason is offered. Every step lands in `log` (this tab only), and the
 * taps that teach the planner land in `outbox`, which the deck posts to the request
 * table (requests.ts): one `deck.skip` per skip, carrying its reason when one was
 * tapped; `offer.sent` for "I sent it"; `offer.reply` for a logged reply.
 *
 * A skip is posted when its reason prompt closes (reason tapped, prompt dismissed, the
 * next skip, Do it, or start over), so one skip is one request. Back before then
 * cancels it; Back after it was posted leaves the row (retracting it is FIX-07's).
 * `card` in every action is the move's `move_id`.
 */
import type { ReplyKind } from './types';
import type { WarRoomRequest } from './requests';

/** Shared with the producer's SKIP_WEIGHT (#233); #230's schema moves to these ids in FIX-06. */
export const SKIP_REASONS = [
  { id: 'player', label: "Don't like the player" },
  { id: 'cost', label: 'Costs too much' },
  { id: 'manager', label: "Don't trust this manager" },
  { id: 'not_now', label: 'Not now' },
] as const;
export type SkipReason = typeof SKIP_REASONS[number]['id'];

export interface DeckLogEntry {
  kind: 'next' | 'back' | 'do_it' | 'skip_reason' | 'reset' | 'sent' | 'reply';
  index: number;
  card: string;
  reason?: SkipReason;
  reply?: ReplyKind;
  at: number;
}

export interface DeckState {
  index: number;            // the card on screen; === total means the deck ran out
  skipped: number[];        // stack of skipped indices, for Back
  chosen: number | null;    // the card picked with Do it
  asking: number | null;    // the skipped card whose optional reason is on offer
  askingCard: string | null; // its move_id
  sent: string[];           // move_ids marked "I sent it"
  log: DeckLogEntry[];
  outbox: WarRoomRequest[];
}

export type DeckAction =
  | { type: 'next'; total: number; card: string; at: number }
  | { type: 'back'; card: string; at: number }
  | { type: 'do_it'; card: string; at: number }
  | { type: 'skip_reason'; reason: SkipReason; card: string; at: number }
  | { type: 'dismiss_reason' }
  | { type: 'sent'; card: string; at: number }
  | { type: 'unsent'; card: string }
  | { type: 'reply'; card: string; reply: ReplyKind; at: number }
  | { type: 'reset'; at: number };

export const initialDeck = (index = 0): DeckState =>
  ({ index, skipped: [], chosen: null, asking: null, askingCard: null, sent: [], log: [], outbox: [] });

const skip = (moveId: string, reason?: SkipReason): WarRoomRequest =>
  ({ kind: 'deck.skip', payload: reason ? { move_id: moveId, reason } : { move_id: moveId } });

/** Close the open reason prompt: its skip goes to the outbox without a reason. */
function settle(s: DeckState): DeckState {
  if (s.asking == null || s.askingCard == null) return s;
  return { ...s, asking: null, askingCard: null, outbox: [...s.outbox, skip(s.askingCard)] };
}

export function deckReducer(s: DeckState, a: DeckAction): DeckState {
  switch (a.type) {
    case 'next': {
      if (s.index >= a.total) return s;
      const t = settle(s);
      return {
        ...t, index: s.index + 1, skipped: [...s.skipped, s.index], chosen: s.chosen === s.index ? null : s.chosen,
        asking: s.index, askingCard: a.card, log: [...s.log, { kind: 'next', index: s.index, card: a.card, at: a.at }],
      };
    }
    case 'back': {
      if (!s.skipped.length) return s;
      const prev = s.skipped[s.skipped.length - 1];
      // Undoing the skip whose reason is still on offer: it was never posted, so it never happened.
      const t = s.asking === prev ? { ...s, asking: null, askingCard: null } : settle(s);
      return { ...t, index: prev, skipped: s.skipped.slice(0, -1),
        log: [...s.log, { kind: 'back', index: prev, card: a.card, at: a.at }] };
    }
    case 'do_it':
      return { ...settle(s), chosen: s.index, log: [...s.log, { kind: 'do_it', index: s.index, card: a.card, at: a.at }] };
    case 'skip_reason': {
      if (s.asking == null || s.askingCard == null) return s;
      return { ...s, asking: null, askingCard: null, outbox: [...s.outbox, skip(s.askingCard, a.reason)],
        log: [...s.log, { kind: 'skip_reason', index: s.asking, card: s.askingCard, reason: a.reason, at: a.at }] };
    }
    case 'dismiss_reason':
      return settle(s);
    case 'sent': {
      if (s.sent.includes(a.card)) return s;
      return { ...s, sent: [...s.sent, a.card], outbox: [...s.outbox, { kind: 'offer.sent', payload: { move_id: a.card } }],
        log: [...s.log, { kind: 'sent', index: s.index, card: a.card, at: a.at }] };
    }
    case 'unsent':
      // Negotiation mode's Undo closed the thread server-side; the card offers "I sent it" again.
      return s.sent.includes(a.card) ? { ...s, sent: s.sent.filter(c => c !== a.card) } : s;
    case 'reply':
      return { ...s, outbox: [...s.outbox, { kind: 'offer.reply', payload: { move_id: a.card, reply: a.reply } }],
        log: [...s.log, { kind: 'reply', index: s.index, card: a.card, reply: a.reply, at: a.at }] };
    case 'reset': {
      const t = settle(s);
      return { ...initialDeck(0), sent: t.sent, outbox: t.outbox, log: [...s.log, { kind: 'reset', index: 0, card: '', at: a.at }] };
    }
    default:
      return s;
  }
}
