/**
 * The NEXT MOVE swipe deck, as a pure reducer (WAR-ROOM-UI.md v2 section 4).
 *
 * Next (button, swipe left, left arrow) wipes the card and shows the next-best; Back
 * undoes the last skip; Do it (swipe right, right arrow) picks the card. After a skip an
 * optional one-tap reason is offered. Every step lands in `log`, an in-memory action
 * log: WR-3 sends it to the request table so skips teach the planner; until then it
 * lives only in this tab.
 */
export const SKIP_REASONS = [
  { id: 'player', label: "Don't like the player" },
  { id: 'cost', label: 'Costs too much' },
  { id: 'manager', label: "Don't trust this manager" },
  { id: 'not_now', label: 'Not now' },
] as const;
export type SkipReason = typeof SKIP_REASONS[number]['id'];

export interface DeckLogEntry {
  kind: 'next' | 'back' | 'do_it' | 'skip_reason' | 'reset';
  index: number;
  card: string;
  reason?: SkipReason;
  at: number;
}

export interface DeckState {
  index: number;            // the card on screen; === total means the deck ran out
  skipped: number[];        // stack of skipped indices, for Back
  chosen: number | null;    // the card picked with Do it
  asking: number | null;    // the skipped card whose optional reason is on offer
  log: DeckLogEntry[];
}

export type DeckAction =
  | { type: 'next'; total: number; card: string; at: number }
  | { type: 'back'; card: string; at: number }
  | { type: 'do_it'; card: string; at: number }
  | { type: 'skip_reason'; reason: SkipReason; card: string; at: number }
  | { type: 'dismiss_reason' }
  | { type: 'reset'; at: number };

export const initialDeck = (index = 0): DeckState => ({ index, skipped: [], chosen: null, asking: null, log: [] });

export function deckReducer(s: DeckState, a: DeckAction): DeckState {
  switch (a.type) {
    case 'next': {
      if (s.index >= a.total) return s;
      return {
        ...s, index: s.index + 1, skipped: [...s.skipped, s.index], chosen: s.chosen === s.index ? null : s.chosen,
        asking: s.index, log: [...s.log, { kind: 'next', index: s.index, card: a.card, at: a.at }],
      };
    }
    case 'back': {
      if (!s.skipped.length) return s;
      const prev = s.skipped[s.skipped.length - 1];
      return { ...s, index: prev, skipped: s.skipped.slice(0, -1), asking: null,
        log: [...s.log, { kind: 'back', index: prev, card: a.card, at: a.at }] };
    }
    case 'do_it':
      return { ...s, chosen: s.index, asking: null, log: [...s.log, { kind: 'do_it', index: s.index, card: a.card, at: a.at }] };
    case 'skip_reason': {
      if (s.asking == null) return s;
      return { ...s, asking: null,
        log: [...s.log, { kind: 'skip_reason', index: s.asking, card: a.card, reason: a.reason, at: a.at }] };
    }
    case 'dismiss_reason':
      return s.asking == null ? s : { ...s, asking: null };
    case 'reset':
      return { ...initialDeck(0), log: [...s.log, { kind: 'reset', index: 0, card: '', at: a.at }] };
    default:
      return s;
  }
}
