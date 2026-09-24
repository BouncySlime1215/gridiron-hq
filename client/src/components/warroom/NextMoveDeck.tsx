import { useEffect, useReducer, useRef, useState } from 'react';
import type { Field, MoveCard } from './types';
import { REASONING_SLOTS } from './types';
import { deckReducer, initialDeck, SKIP_REASONS, type DeckLogEntry, type DeckState } from './deck';
import { FieldBlock, SourceTag, Val } from './FieldState';
import { pct, pts, NOT_COMPUTED, isOk } from './format';
import ReplyTable from './ReplyTable';

/**
 * NEXT MOVE: the one decision ("send this to this manager, yes or no") as a swipe deck
 * of the planner's top alternatives. Next / swipe left / left arrow skips; Do it / swipe
 * right / right arrow picks; Back undoes a skip; after a skip an optional one-tap reason
 * fades in and out. Nothing is ever sent from here: Copy, then Nick sends it in ESPN.
 */
export default function NextMoveDeck({ field, big, initialState, onLog }: {
  field: Field<{ cards: MoveCard[]; deck_note: string }> | undefined;
  big: boolean;
  initialState?: DeckState;
  onLog?: (log: DeckLogEntry[]) => void;
}) {
  const cards = isOk(field) ? field.value.cards : [];
  const [deck, dispatch] = useReducer(deckReducer, initialState ?? initialDeck());
  const total = cards.length;
  const idx = Math.min(deck.index, total);
  const card = idx < total ? cards[idx] : null;

  useEffect(() => { onLog?.(deck.log); }, [deck.log, onLog]);

  // The optional skip reason fades after 5 s if ignored.
  useEffect(() => {
    if (deck.asking == null) return;
    const t = window.setTimeout(() => dispatch({ type: 'dismiss_reason' }), 5000);
    return () => window.clearTimeout(t);
  }, [deck.asking]);

  const next = () => { if (card) dispatch({ type: 'next', total, card: card.deal_line, at: Date.now() }); };
  const doIt = () => { if (card) dispatch({ type: 'do_it', card: card.deal_line, at: Date.now() }); };
  const back = () => {
    const prev = deck.skipped[deck.skipped.length - 1];
    if (prev != null) dispatch({ type: 'back', card: cards[prev]?.deal_line ?? '', at: Date.now() });
  };

  // Arrow keys, unless Nick is typing.
  const keys = useRef({ next, doIt });
  keys.current = { next, doIt };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); keys.current.next(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); keys.current.doIt(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Swipe on the card (touch).
  const touch = useRef<{ x: number; y: number; dx: number } | null>(null);
  const [drag, setDrag] = useState(0);
  const onTouchStart = (e: React.TouchEvent) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0 }; e.stopPropagation(); };
  const onTouchMove = (e: React.TouchEvent) => {
    const t = touch.current; if (!t) return;
    const dx = e.touches[0].clientX - t.x, dy = e.touches[0].clientY - t.y;
    if (Math.abs(dx) > Math.abs(dy)) { t.dx = dx; setDrag(dx); }
    e.stopPropagation();
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const dx = touch.current?.dx ?? 0; touch.current = null; setDrag(0); e.stopPropagation();
    if (dx < -70) next(); else if (dx > 70) doIt();
  };

  const counter = total ? (
    <span className="wr-count" data-testid="deck-count">
      {Math.min(idx + 1, total)} of {total}
      {deck.skipped.length > 0 && <button type="button" className="wr-link" onClick={back}>← back</button>}
    </span>
  ) : null;

  if (!isOk(field)) {
    return <div className="wr-deck"><FieldBlock f={field} label="Next move">{() => null}</FieldBlock></div>;
  }
  if (!card) {
    return (
      <div className="wr-deck">
        {counter}
        <div className="wr-empty">
          That was every move the planner has for this league.
          <div className="wr-acts">
            <button type="button" className="wr-btn" onClick={back}>← Back to the last one</button>
            <button type="button" className="wr-btn" onClick={() => dispatch({ type: 'reset', at: Date.now() })}>Start over</button>
          </div>
          <span className="wr-hint">Want me to look wider? More partners, bigger packages or another risk mode come with the campaign producer.</span>
        </div>
      </div>
    );
  }

  const asking = deck.asking != null ? cards[deck.asking] : null;
  const skipRow = asking ? (
    <div className="wr-reasons" role="group" aria-label="Why skip? (optional)">
      <span className="wr-muted">Why skip? (optional)</span>
      {SKIP_REASONS.map(r => (
        <button type="button" key={r.id} onClick={() => dispatch({ type: 'skip_reason', reason: r.id, card: asking.deal_line, at: Date.now() })}>
          {r.label}
        </button>
      ))}
    </div>
  ) : null;

  const deal = (
    <div className="wr-gg">
      <span className="wr-k">You give</span><span>{card.give.map(p => p.name).join(' + ')}</span>
      <span className="wr-k">You get</span><span>{card.get.map(p => p.name).join(' + ')}</span>
    </div>
  );

  if (!big) {
    return (
      <div className="wr-deck">
        <div className="wr-mv-top">{counter}</div>
        <div className="wr-movecard" key={idx} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
          <div className="wr-who wr-who-sm">Send to {card.partner_label}</div>
          {deal}
          <div className="wr-sub">
            <Val f={card.p_yes} fmt={v => `${pct(v)} yes`} /> · <Val f={card.odds_effect.delta} fmt={pts} />
          </div>
          <div className="wr-acts">
            <button type="button" className="wr-btn" onClick={next}>Next →</button>
          </div>
        </div>
        {skipRow}
      </div>
    );
  }

  const messageText = isOk(card.message) ? card.message.value.text : card.deal_line;
  return (
    <div className="wr-deck">
      <div className="wr-mv-top">
        {counter}
        <span className="wr-tag wr-src">{card.origin_label}</span>
        <span className="wr-sp" />
        <span className="wr-hint">send by <Val f={card.send_when} fmt={v => v} /></span>
      </div>
      <div className="wr-movecard" key={idx} data-testid="move-card"
        style={drag ? { transform: `translateX(${drag}px) rotate(${drag / 40}deg)`, transition: 'none' } : undefined}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
        <div className="wr-who">Send this to {card.partner_label}</div>
        {deal}
        {card.target && (
          <div className="wr-sub">Step {card.step_index} of {card.of_steps} toward {card.target.name}{card.target_owner ? ` (${card.target_owner})` : ''}</div>
        )}
        <div className="wr-tiles">
          <div className="wr-tile">
            <div className="wr-l">Chance he says yes</div>
            <div className="wr-v wr-amber"><Val f={card.p_yes} fmt={v => pct(v)} /></div>
            <div className="wr-s"><SourceTag id={card.p_yes.source} guess={card.p_yes.guess ?? true} /></div>
          </div>
          <div className="wr-tile">
            <div className="wr-l">Title odds if he says yes</div>
            <div className="wr-v"><Val f={card.odds_effect.delta} fmt={pts} /></div>
            <div className="wr-s">
              {isOk(card.odds_effect.before) || isOk(card.odds_effect.after)
                ? <><Val f={card.odds_effect.before} fmt={v => pct(v, 1)} /> → <Val f={card.odds_effect.after} fmt={v => pct(v, 1)} /></>
                : <span title={card.odds_effect.before.reason}>odds now: {NOT_COMPUTED}</span>}
            </div>
          </div>
          <div className="wr-tile">
            <div className="wr-l">Walk away if</div>
            <div className="wr-v wr-v-text"><Val f={card.walk_away} fmt={v => v} /></div>
          </div>
        </div>
        <div className="wr-sub">
          Whole path: <Val f={card.path_effect.expected} fmt={pts} showSe /> expected
          {' · '}finishes <Val f={card.path_effect.p_complete} fmt={v => pct(v)} /> of the time
          {' · '}finder's best single offer <Val f={card.vs_finder.finder_expected} fmt={pts} />
        </div>
        {deck.chosen === idx && (
          <div className="wr-chosen" role="status"><b>You picked this one.</b> Copy it and send it yourself in ESPN, then tap his answer below.</div>
        )}
        <CopyBlock
          label={isOk(card.message) ? 'Message' : 'Copy the deal'}
          text={messageText}
          note={isOk(card.message) ? undefined : (card.message.reason ?? `Message ${NOT_COMPUTED}.`)}
        />
        <div className="wr-acts">
          <button type="button" className="wr-btn wr-big-btn" onClick={next} title="Left arrow or swipe left">Next →</button>
          <button type="button" className="wr-btn wr-big-btn wr-primary" onClick={doIt} title="Right arrow or swipe right">Do it</button>
        </div>
        {skipRow}
        <div className="wr-cap">If he says… (tap what happened)</div>
        <ReplyTable replies={card.replies} />
        <div className="wr-cap">Reasoning</div>
        <ul className="wr-reasoning">
          {REASONING_SLOTS.map(([k, label]) => (
            <li key={k}><span className="wr-k">{label}</span><Val f={card.reasoning[k]} fmt={v => v} /></li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The copyable message. The clipboard can be blocked over plain HTTP; then the text stays selectable. */
function CopyBlock({ label, text, note }: { label: string; text: string; note?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      setState('copied');
      window.setTimeout(() => setState('idle'), 2000);
    } catch { setState('failed'); }
  };
  return (
    <div className="wr-msg">
      <div className="wr-row">
        <span className="wr-cap">{label}</span>
        <span className="wr-sp" />
        <button type="button" className="wr-btn wr-sm wr-primary" onClick={copy}>{state === 'copied' ? 'Copied' : 'Copy'}</button>
      </div>
      <p className="wr-msg-text">{text}</p>
      {note && <div className="wr-hint">{note}</div>}
      <div className="wr-hint">Coach never sends offers. Sending stays your tap in ESPN.</div>
      {state === 'failed' && <div className="wr-hint wr-red" role="status">Copy was blocked here. The text above selects in one tap.</div>}
    </div>
  );
}
