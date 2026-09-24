import { useEffect, useReducer, useRef, useState } from 'react';
import type { Move, WarRoomView } from './types';
import { REASONING_SLOTS, namer, teamLabel } from './types';
import { deckReducer, initialDeck, SKIP_REASONS, type DeckLogEntry, type DeckState } from './deck';
import { flushOutbox, postWarRoomRequest, type Poster } from './requests';
import { FieldBlock, SourceTag, Val } from './FieldState';
import { pct, pts, NOT_COMPUTED, isOk } from './format';
import ReplyTable from './ReplyTable';

/**
 * NEXT MOVE: the one decision ("send this to this manager, yes or no") as a swipe deck
 * of the producer's ranked moves, `alternatives.value`, best first (its head is
 * `next_move`). Next / swipe left / left arrow skips; Do it / swipe right / right arrow
 * picks; Back undoes a skip; after a skip an optional one-tap reason fades in and out.
 * Skips, "I sent it" and logged replies post to the request table (deck.ts, requests.ts).
 * Nothing is ever sent from here: Copy, then Nick sends it in ESPN.
 */
export default function NextMoveDeck({ view, big, initialState, onLog, post }: {
  view: WarRoomView;
  big: boolean;
  initialState?: DeckState;
  onLog?: (log: DeckLogEntry[]) => void;
  post?: Poster;
}) {
  const field = view.alternatives;
  const moves: Move[] = isOk(field) ? field.value : [];
  const n = namer(view.names);
  const leagueId = view.league_id ?? view.league ?? 0;
  const [deck, dispatch] = useReducer(deckReducer, initialState ?? initialDeck());
  const total = moves.length;
  const idx = Math.min(deck.index, total);
  const move = idx < total ? moves[idx] : null;

  useEffect(() => { onLog?.(deck.log); }, [deck.log, onLog]);

  // Post each new request once, in order. A failed post is shown, never swallowed.
  const sent = useRef(initialState?.outbox.length ?? 0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    const outbox = deck.outbox;
    queue.current = queue.current.then(async () => {
      try {
        sent.current = await flushOutbox(leagueId, outbox, sent.current, post);
        setSaveError(null);
      } catch (e) {
        sent.current = (e as { sent?: number }).sent ?? sent.current;
        setSaveError(e instanceof Error ? e.message : String(e));
      }
    });
  }, [deck.outbox, leagueId, post]);

  // A skip still waiting on its optional reason is posted when the deck goes away.
  const latest = useRef(deck);
  latest.current = deck;
  useEffect(() => () => {
    const d = latest.current;
    if (d.askingCard) {
      postWarRoomRequest(leagueId, { kind: 'deck.skip', payload: { move_id: d.askingCard } }, post)
        .catch(e => console.error('War Room: could not save a skip', e));
    }
  }, [leagueId, post]);

  // The optional skip reason fades after 5 s if ignored.
  useEffect(() => {
    if (deck.asking == null) return;
    const t = window.setTimeout(() => dispatch({ type: 'dismiss_reason' }), 5000);
    return () => window.clearTimeout(t);
  }, [deck.asking]);

  const next = () => { if (move) dispatch({ type: 'next', total, card: move.move_id, at: Date.now() }); };
  const doIt = () => { if (move) dispatch({ type: 'do_it', card: move.move_id, at: Date.now() }); };
  const back = () => {
    const prev = deck.skipped[deck.skipped.length - 1];
    if (prev != null) dispatch({ type: 'back', card: moves[prev]?.move_id ?? '', at: Date.now() });
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
  const saveNote = saveError ? <div className="wr-hint wr-red" role="status">Could not save that to the planner: {saveError}</div> : null;

  if (!isOk(field)) {
    return <div className="wr-deck"><FieldBlock f={field} label="Next move">{() => null}</FieldBlock></div>;
  }
  if (!total) {
    return <div className="wr-deck"><div className="wr-empty">{view.next_move?.reason ?? 'The planner found no move for this league.'}</div></div>;
  }
  if (!move) {
    return (
      <div className="wr-deck">
        {counter}
        <div className="wr-empty">
          That was every move the planner has for this league.
          <div className="wr-acts">
            <button type="button" className="wr-btn" onClick={back}>← Back to the last one</button>
            <button type="button" className="wr-btn" onClick={() => dispatch({ type: 'reset', at: Date.now() })}>Start over</button>
          </div>
          <span className="wr-hint">Your skips go to the planner; its next run weighs them.</span>
        </div>
        {saveNote}
      </div>
    );
  }

  const s = move.steps[0];
  const partner = teamLabel(s.partner);
  const dealLine = `Offer ${partner}: ${n.text(s.give)} for ${n.text(s.get)}`;
  const skipRow = deck.asking != null ? (
    <div className="wr-reasons" role="group" aria-label="Why skip? (optional)">
      <span className="wr-muted">Why skip? (optional)</span>
      {SKIP_REASONS.map(r => (
        <button type="button" key={r.id} onClick={() => dispatch({ type: 'skip_reason', reason: r.id, card: deck.askingCard ?? '', at: Date.now() })}>
          {r.label}
        </button>
      ))}
    </div>
  ) : null;

  const deal = (
    <div className="wr-gg">
      <span className="wr-k">You give</span><span>{n.text(s.give)}</span>
      <span className="wr-k">You get</span><span>{n.text(s.get)}</span>
    </div>
  );

  if (!big) {
    return (
      <div className="wr-deck">
        <div className="wr-mv-top">{counter}</div>
        <div className="wr-movecard" key={idx} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
          <div className="wr-who wr-who-sm">Send to {partner}</div>
          {deal}
          <div className="wr-sub">
            <Val f={s.p_yes} fmt={v => `${pct(v)} yes`} /> · <Val f={s.title_odds_delta} fmt={pts} />
          </div>
          <div className="wr-acts">
            <button type="button" className="wr-btn" onClick={next}>Next →</button>
          </div>
        </div>
        {skipRow}
        {saveNote}
      </div>
    );
  }

  const titleNow = isOk(view.destination) ? view.destination.value.title_now : undefined;
  const target = move.target != null ? n.one(move.target) : null;
  const messageText = isOk(s.message) ? s.message.value : dealLine;
  const isSent = deck.sent.includes(move.move_id);
  return (
    <div className="wr-deck">
      <div className="wr-mv-top">
        {counter}
        <span className="wr-tag wr-src">{move.rank === 1 ? 'Best plan' : `Plan ${move.rank}`}</span>
        <span className="wr-sp" />
        <span className="wr-hint">send by <Val f={s.send_when} fmt={v => v} /></span>
      </div>
      <div className="wr-movecard" key={idx} data-testid="move-card" data-move={move.move_id}
        style={drag ? { transform: `translateX(${drag}px) rotate(${drag / 40}deg)`, transition: 'none' } : undefined}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
        <div className="wr-who">Send this to {partner}</div>
        {deal}
        {target && (
          <div className="wr-sub">Step 1 of {move.steps.length} toward {target.name}{move.target_owner ? ` (${teamLabel(move.target_owner)})` : ''}</div>
        )}
        <div className="wr-tiles">
          <div className="wr-tile">
            <div className="wr-l">Chance he says yes</div>
            <div className="wr-v wr-amber"><Val f={s.p_yes} fmt={v => pct(v)} /></div>
            <div className="wr-s"><SourceTag id={s.p_yes.source} /></div>
          </div>
          <div className="wr-tile">
            <div className="wr-l">Title odds if he says yes</div>
            <div className="wr-v"><Val f={s.title_odds_delta} fmt={pts} /></div>
            <div className="wr-s">
              {isOk(titleNow) || isOk(s.title_after)
                ? <><Val f={titleNow} fmt={v => pct(v, 1)} /> → <Val f={s.title_after} fmt={v => pct(v, 1)} /></>
                : <span title={titleNow?.reason}>odds now: {NOT_COMPUTED}</span>}
            </div>
          </div>
          <div className="wr-tile">
            <div className="wr-l">Walk away if</div>
            <div className="wr-v wr-v-text"><Val f={s.walk_away} fmt={v => v.text} /></div>
          </div>
        </div>
        <div className="wr-sub">
          Whole path: <Val f={move.expected} fmt={pts} showSe /> expected
          {' · '}finishes <Val f={move.p_complete} fmt={v => pct(v)} /> of the time
          {' · '}finder's best single offer <Val f={view.finder_best_expected} fmt={pts} />
        </div>
        {deck.chosen === idx && (
          <div className="wr-chosen" role="status">
            <b>You picked this one.</b> Copy it and send it yourself in ESPN, then tell the planner.
            <div className="wr-acts">
              <button type="button" className="wr-btn wr-sm wr-primary" disabled={isSent}
                onClick={() => dispatch({ type: 'sent', card: move.move_id, at: Date.now() })}>
                {isSent ? 'Marked as sent' : 'I sent it'}
              </button>
            </div>
          </div>
        )}
        <CopyBlock
          label={isOk(s.message) ? 'Message' : 'Copy the deal'}
          text={messageText}
          note={isOk(s.message) ? undefined : (s.message.reason ?? `Message ${NOT_COMPUTED}.`)}
        />
        <div className="wr-acts">
          <button type="button" className="wr-btn wr-big-btn" onClick={next} title="Left arrow or swipe left">Next →</button>
          <button type="button" className="wr-btn wr-big-btn wr-primary" onClick={doIt} title="Right arrow or swipe right">Do it</button>
        </div>
        {skipRow}
        {saveNote}
        <div className="wr-cap">If he says… (tap what happened)</div>
        <ReplyTable replies={s.reply_table} onLog={deck.chosen === idx ? reply => dispatch({ type: 'reply', card: move.move_id, reply, at: Date.now() }) : undefined} />
        <div className="wr-cap">Reasoning</div>
        <ul className="wr-reasoning">
          {REASONING_SLOTS.map(([k, label]) => (
            <li key={k}><span className="wr-k">{label}</span>
              {isOk(move.reasoning) ? <span>{move.reasoning.value[k]}</span> : <Val f={move.reasoning} fmt={() => ''} />}
            </li>
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
