import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * WR-SWIPE: the frame of the NEXT MOVE deck (WAR-ROOM-UI.md v3 + v2 section 4). One card
 * at a time, in the order the caller gives (the contract's `alternatives.value`, whose head
 * is `next_move`); it never draws a card it was not given.
 *
 *  - swipe left / left arrow: `onNext` (the card wipes out to the left, the next one slides in);
 *  - swipe right / right arrow: `onOpen` (the card's actions: Do it, I sent it);
 *  - the position indicator ("2 of 5"; "all 5 seen" past the last card) and Back;
 *  - past the last card, `end` takes the card's slot.
 *
 * Layout never shifts: the bar keeps its height, the leaving card sits in an absolute layer
 * inside a clipped stage, the optional skip reason (`overlay`) fades into a row that is
 * reserved whether or not it shows (so it never covers Next), and every motion is a CSS
 * transform or opacity (warroom.css, `wr-swipe-*`). No animation library.
 */

/** Past this many px of horizontal travel a drag is a swipe. */
export const SWIPE_PX = 70;
/** How long the leaving card stays in the exit layer (the wr-swipe-out animation). */
export const EXIT_MS = 220;

export type SwipeIntent = 'next' | 'open' | null;

/** A drag of (dx, dy) px: left = next, right = open, short or mostly vertical = nothing. */
export function swipeIntent(dx: number, dy: number): SwipeIntent {
  if (Math.abs(dx) <= Math.abs(dy)) return null;
  if (dx <= -SWIPE_PX) return 'next';
  if (dx >= SWIPE_PX) return 'open';
  return null;
}

/** A key press, unless Nick is typing (`tag` is the focused element's tag) or holds a modifier. */
export function keyIntent(e: { key: string; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }, tag: string): SwipeIntent {
  const t = tag.toUpperCase();
  if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return null;
  if (e.key === 'ArrowLeft') return 'next';
  if (e.key === 'ArrowRight') return 'open';
  return null;
}

/** "2 of 5" for the card at `index`; past the last card, "all 5 seen". */
export const positionLabel = (index: number, total: number) => (index >= total ? `all ${total} seen` : `${index + 1} of ${total}`);

interface Exit<T> { card: T; index: number; from: number; seq: number }

export default function SwipeDeck<T extends { move_id: string }>({ cards, index, onNext, onOpen, onBack, canBack, renderCard, overlay, end, bar, arrows }: {
  cards: T[];
  index: number;
  onNext: () => void;
  onOpen: () => void;
  onBack: () => void;
  canBack: boolean;
  renderCard: (card: T, index: number) => ReactNode;
  /** The optional skip reason: drawn in a reserved row under the card, so it never pushes it. */
  overlay?: ReactNode;
  /** Takes the card's slot past the last card. */
  end: ReactNode;
  /** Extra items on the bar, after the position indicator. */
  bar?: ReactNode;
  /** WAR-ROOM-UI v2: a small "‹ 1 of N ›" switcher (‹ = Back, › = Next) instead of the "← back" link. */
  arrows?: boolean;
}) {
  const total = cards.length;
  const at = Math.min(Math.max(index, 0), total);
  const card = at < total ? cards[at] : null;

  // The card that just left (by swipe, key, button or Coach), drawn once in the exit layer
  // while it wipes out. Derived during render, so the wipe starts on the same frame.
  const [exit, setExit] = useState<Exit<T> | null>(null);
  const [shown, setShown] = useState<{ at: number; card: T | null; seq: number }>({ at, card, seq: 0 });
  const dragFrom = useRef(0);
  if (shown.at !== at || shown.card !== card) {
    const seq = shown.seq + 1;
    if (at === shown.at + 1 && shown.card) setExit({ card: shown.card, index: shown.at, from: dragFrom.current, seq });
    dragFrom.current = 0;
    setShown({ at, card, seq });
  }
  useEffect(() => {
    if (!exit) return;
    const t = window.setTimeout(() => setExit(x => (x?.seq === exit.seq ? null : x)), EXIT_MS);
    return () => window.clearTimeout(t);
  }, [exit]);

  const next = (from = 0) => { if (card) { dragFrom.current = from; onNext(); } };
  const open = () => { if (card) onOpen(); };

  // Arrow keys, unless Nick is typing.
  const keys = useRef({ next, open });
  keys.current = { next, open };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const intent = keyIntent(e, document.activeElement?.tagName ?? '');
      if (!intent) return;
      e.preventDefault();
      if (intent === 'next') keys.current.next(); else keys.current.open();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Swipe (touch): the card follows the finger, then wipes, or springs back.
  const touch = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const [drag, setDrag] = useState(0);
  const onTouchStart = (e: React.TouchEvent) => {
    const p = e.touches[0]; if (!p) return;
    touch.current = { x: p.clientX, y: p.clientY, dx: 0, dy: 0 };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const t = touch.current, p = e.touches[0]; if (!t || !p) return;
    t.dx = p.clientX - t.x; t.dy = p.clientY - t.y;
    if (Math.abs(t.dx) > Math.abs(t.dy)) { setDrag(t.dx); e.stopPropagation(); }
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const t = touch.current; touch.current = null; setDrag(0);
    if (!t) return;
    const intent = swipeIntent(t.dx, t.dy);
    if (intent) e.stopPropagation();
    if (intent === 'next') next(t.dx); else if (intent === 'open') open();
  };

  const dragStyle = drag
    ? { transform: `translateX(${drag}px) rotate(${drag / 40}deg)`, transition: 'none' }
    : undefined;

  return (
    <div className="wr-swipe" data-testid="swipe-deck">
      {arrows ? (
        <div className="wr-swipe-bar wr-plan-switch" role="group" aria-label="Plans">
          <button type="button" className="wr-arrow" aria-label="Previous plan" disabled={!canBack} onClick={onBack}
            title={canBack ? 'Back to the plan you skipped' : 'This is the first plan'}>‹</button>
          <span className="wr-count wr-swipe-pos" data-testid="deck-count" aria-live="polite">{positionLabel(at, total)}</span>
          <button type="button" className="wr-arrow" aria-label="Next plan (skips this one)" title={card ? 'Skip to the next plan. The planner hears that you passed.' : 'That was the last plan'}
            disabled={!card} onClick={() => next()}>›</button>
          {bar}
        </div>
      ) : (
        <div className="wr-swipe-bar">
          <span className="wr-count wr-swipe-pos" data-testid="deck-count" aria-live="polite">{positionLabel(at, total)}</span>
          {canBack && <button type="button" className="wr-link" onClick={onBack}>← back</button>}
          {bar}
        </div>
      )}
      <div className="wr-swipe-stage">
        {card ? (
          <div className="wr-movecard wr-swipe-card" key={card.move_id} data-testid="move-card" data-move={card.move_id}
            style={dragStyle} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
            onTouchCancel={() => { touch.current = null; setDrag(0); }}>
            {renderCard(card, at)}
          </div>
        ) : (
          <div className="wr-swipe-end" data-testid="deck-end">{end}</div>
        )}
        <div className="wr-swipe-layer" aria-hidden="true" {...{ inert: '' }}>
          {exit && (
            <div className="wr-movecard wr-swipe-ghost" key={exit.seq}
              style={{ '--wr-swipe-from': `${exit.from}px` } as React.CSSProperties}>
              {renderCard(exit.card, exit.index)}
            </div>
          )}
        </div>
      </div>
      <div className="wr-swipe-foot">{overlay}</div>
    </div>
  );
}
