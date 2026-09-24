import { useEffect, useReducer, useRef, useState } from 'react';
import type { Move, WarRoomView } from './types';
import { REASONING_SLOTS, namer, teamLabel } from './types';
import { deckReducer, initialDeck, SKIP_REASONS, type DeckLogEntry, type DeckState } from './deck';
import { flushOutbox, openNegotiation, postWarRoomRequest, type Poster } from './requests';
import { FieldBlock, SourceTag, Val } from './FieldState';
import { pct, pts, NOT_COMPUTED, isOk } from './format';
import ReplyTable from './ReplyTable';
import Negotiate from './Negotiate';
import type { Negotiations, Thread, ThreadResponse } from './negotiateModel';
import { HisScreenToggle } from './HisScreen';
import NoMoveCard from './NoMoveCard';
import SwipeDeck from './SwipeDeck';

/**
 * NEXT MOVE: the one decision ("send this to this manager, yes or no") as a swipe deck
 * of the producer's ranked moves, `alternatives.value`, best first (its head is
 * `next_move`), one card at a time (SwipeDeck.tsx: gestures, keys, the wipe, "2 of 5").
 * Next / swipe left / left arrow skips; Do it / swipe right / right arrow opens the card's
 * actions (I sent it); Back undoes a skip; after a skip an optional one-tap reason fades in
 * and out. Past the last card: "That's every option that cleared; see near-misses".
 * Skips, "I sent it" and logged replies post to the request table (deck.ts, requests.ts).
 * Nothing is ever sent from here: Copy, then Nick sends it in ESPN.
 * With negotiation mode on (`negotiation.enabled`), "I sent it" also opens a live
 * thread on the server and the card flips to it (Negotiate.tsx).
 */
export default function NextMoveDeck({ view, big, initialState, onLog, post, negotiation, onAsk }: {
  view: WarRoomView;
  big: boolean;
  initialState?: DeckState;
  onLog?: (log: DeckLogEntry[]) => void;
  post?: Poster;
  negotiation?: Negotiations | null;
  /** Ask Coach (the no-move card's prompts). */
  onAsk?: (q: string) => void;
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

  // Negotiation mode: threads opened or changed here win over the ones the page loaded.
  const negotiating = negotiation?.enabled === true;
  const [threads, setThreads] = useState<Record<string, Thread | null>>({});
  const threadFor = (moveId: string): Thread | null => {
    const t = moveId in threads ? threads[moveId]
      : (negotiation?.threads ?? []).find(x => x.move_id === moveId && x.step_index === 0) ?? null;
    return t && t.closed_reason !== 'undone' ? t : null;
  };
  const onThread = (moveId: string) => (t: Thread | null) => {
    setThreads(m => ({ ...m, [moveId]: t }));
    if (t?.closed_reason === 'undone') dispatch({ type: 'unsent', card: moveId });
  };

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

  const [showNear, setShowNear] = useState(false);

  const saveNote = saveError ? <div className="wr-hint wr-red" role="status">Could not save that to the planner: {saveError}</div> : null;

  if (!isOk(field)) {
    return <div className="wr-deck"><FieldBlock f={field} label="Next move">{() => null}</FieldBlock></div>;
  }
  if (!total) {
    // Audit defect 2: the reason, then the closest path and the all-in option, never a blank slot.
    return <div className="wr-deck"><NoMoveCard view={view} onAsk={onAsk} /></div>;
  }

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

  // WR-SWIPE: past the last card, every option that cleared has been seen; the near-misses
  // (NoMoveCard, minus any path that is one of the cards) are one tap away.
  const end = (
    <div className="wr-empty wr-swipe-done">
      <b>That&apos;s every option that cleared; see near-misses.</b>
      <div className="wr-hint">That was every move the planner has for this league. Your skips go to the planner; its next run weighs them.</div>
      <div className="wr-acts">
        <button type="button" className="wr-btn wr-primary" aria-expanded={showNear} onClick={() => setShowNear(v => !v)}>
          {showNear ? 'Hide near-misses' : 'See near-misses'}
        </button>
        <button type="button" className="wr-btn" onClick={back}>← Back to the last one</button>
        <button type="button" className="wr-btn" onClick={() => { setShowNear(false); dispatch({ type: 'reset', at: Date.now() }); }}>Start over</button>
      </div>
      {showNear && <div className="wr-swipe-near"><NoMoveCard view={nearMissView(view, moves)} onAsk={onAsk} /></div>}
    </div>
  );

  const card = (m: Move, i: number) => {
    const s = m.steps[0];
    const partner = teamLabel(s.partner);
    const isSent = deck.sent.includes(m.move_id);
    const thread = negotiating ? threadFor(m.move_id) : null;
    const markSent = () => {
      dispatch({ type: 'sent', card: m.move_id, at: Date.now() });
      if (!negotiating) return;
      openNegotiation(leagueId, m.move_id, 0, post)
        .then(r => onThread(m.move_id)((r as ThreadResponse)?.thread ?? null))
        .catch(e => setSaveError(e instanceof Error ? e.message : String(e)));
    };
    const deal = (
      <div className="wr-gg">
        <span className="wr-k">You give</span><span>{n.text(s.give)}</span>
        <span className="wr-k">You get</span><span>{n.text(s.get)}</span>
      </div>
    );
    const picked = !thread && deck.chosen === i ? (
      <div className="wr-chosen" role="status">
        <b>You picked this one.</b> Copy it and send it yourself in ESPN, then tell the planner.
        <div className="wr-acts">
          <button type="button" className="wr-btn wr-sm wr-primary" disabled={isSent}
            onClick={markSent}>
            {isSent ? 'Marked as sent' : 'I sent it'}
          </button>
        </div>
      </div>
    ) : null;
    const buttons = (
      <div className="wr-acts">
        <button type="button" className={`wr-btn${big ? ' wr-big-btn' : ''}`} onClick={next} title="Left arrow or swipe left">Next →</button>
        <button type="button" className={`wr-btn${big ? ' wr-big-btn' : ''} wr-primary`} onClick={doIt} title="Right arrow or swipe right">Do it</button>
      </div>
    );
    const dealLine = `Offer ${partner}: ${n.text(s.give)} for ${n.text(s.get)}`;

    if (!big) {
      return (
        <>
          <div className="wr-who wr-who-sm">Send to {partner}</div>
          {deal}
          <div className="wr-sub">
            <Val f={s.p_yes} fmt={v => `${pct(v)} yes`} /> · <Val f={s.title_odds_delta} fmt={pts} />
          </div>
          {thread && <Negotiate thread={thread} onThread={onThread(m.move_id)} post={post} />}
          {picked}
          {picked && <CopyBlock label={isOk(s.message) ? messageLabel(s) : 'Copy the deal'} text={isOk(s.message) ? s.message.value : dealLine}
            note={isOk(s.message) ? undefined : (s.message.reason ?? `Message ${NOT_COMPUTED}.`)} />}
          {buttons}
        </>
      );
    }

    const titleNow = isOk(view.destination) ? view.destination.value.title_now : undefined;
    const target = m.target != null ? n.one(m.target) : null;
    const messageText = isOk(s.message) ? s.message.value : dealLine;
    return (
      <>
        <div className="wr-who">Send this to {partner}</div>
        {deal}
        {target && (
          <div className="wr-sub">Step 1 of {m.steps.length} toward {target.name}{m.target_owner ? ` (${teamLabel(m.target_owner)})` : ''}</div>
        )}
        <div className="wr-tiles wr-tiles-2">
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
        </div>
        {/* UI-POLISH-2: the walk-away lives on the ladder's "Walk away at" rung only (no separate tile). */}
        <Ladder s={s} text={n.text} />
        {/* HIS-SCREEN-FIX: the card's offer as he sees it (precomputed by the planner; the route only reads). */}
        <HisScreenToggle leagueId={leagueId} offer={{ partner: String(s.partner), give: s.give.map(String), get: s.get.map(String) }} />
        <div className="wr-sub">
          Whole path: <Val f={m.expected} fmt={pts} showSe /> expected
          {' · '}finishes <Val f={m.p_complete} fmt={v => pct(v)} /> of the time
          {' · '}finder's best single offer <Val f={view.finder_best_expected} fmt={pts} />
        </div>
        {thread && <Negotiate thread={thread} onThread={onThread(m.move_id)} post={post} />}
        {picked}
        {!thread && <CopyBlock
          label={isOk(s.message) ? messageLabel(s) : 'Copy the deal'}
          text={messageText}
          note={isOk(s.message) ? undefined : (s.message.reason ?? `Message ${NOT_COMPUTED}.`)}
        />}
        {buttons}
        {!thread && <>
          <div className="wr-cap">If he says… (tap what happened)</div>
          <ReplyTable replies={s.reply_table} onLog={deck.chosen === i ? reply => dispatch({ type: 'reply', card: m.move_id, reply, at: Date.now() }) : undefined} />
        </>}
        <div className="wr-cap">Reasoning</div>
        <ul className="wr-reasoning">
          {REASONING_SLOTS.map(([k, label]) => (
            <li key={k}><span className="wr-k">{label}</span>
              {isOk(m.reasoning) ? <span>{m.reasoning.value[k]}</span> : <Val f={m.reasoning} fmt={() => ''} />}
            </li>
          ))}
        </ul>
      </>
    );
  };

  const bar = big && move ? (
    <>
      <span className="wr-tag wr-src">{move.rank === 1 ? 'Best plan' : `Plan ${move.rank}`}</span>
      <span className="wr-sp" />
      <span className="wr-hint">When to send: <Val f={move.steps[0].send_when} fmt={v => v} /></span>
    </>
  ) : null;

  return (
    <div className="wr-deck">
      <SwipeDeck cards={moves} index={idx} onNext={next} onOpen={doIt} onBack={back} canBack={deck.skipped.length > 0}
        renderCard={card} overlay={skipRow} end={end} bar={bar} />
      {saveNote}
    </div>
  );
}

const sameStep = (a: { partner: string; give: string[]; get: string[] }, b: { partner: string; give: string[]; get: string[] }) =>
  a.partner === b.partner && a.give.join('|') === b.give.join('|') && a.get.join('|') === b.get.join('|');

/**
 * The view NoMoveCard reads at the end of the deck: risk-mode rows whose first step is one
 * of the deck's cards cleared, so they are not near-misses and are left out.
 */
export function nearMissView(view: WarRoomView, moves: Move[]): WarRoomView {
  if (!isOk(view.risk_modes)) return view;
  const rows = view.risk_modes.value.filter(r => !r.first_step || !moves.some(m => m.steps[0] && sameStep(r.first_step!, m.steps[0])));
  return { ...view, risk_modes: { ...view.risk_modes, value: rows } };
}

type Step = Move['steps'][number];
const samePkg = (a: string[], b: string[]) => [...a].sort().join('|') === [...b].sort().join('|');
/** CARD-CLARITY: the step's opening ask, when it is a different package from the planned step. */
const openingAsk = (s: Step) => (isOk(s.opening) && !samePkg(s.opening.value.give, s.give) ? s.opening.value : null);
/** The message is written from the opening ask; say so whenever that differs from the plan. */
const messageLabel = (s: Step) => (openingAsk(s) ? 'Opening message (the opening ask, not the plan)' : 'Message');

/**
 * CARD-CLARITY: the negotiation ladder, from the contract fields the step already carries:
 * Open with (step.opening, only when it differs from the plan), Plan (the step's give/get),
 * Walk away at (walk_away.max_give). One package per labelled rung, never an unlabelled third.
 */
function Ladder({ s, text }: { s: Step; text: (ids: string[]) => string }) {
  const open = openingAsk(s);
  return (
    <ol className="wr-ladder" aria-label="Negotiation ladder">
      {open && (
        <li data-rung="open"><span className="wr-k">Open with</span>
          <span>{text(open.give)} for {text(open.get)}<span className="wr-hint"> Coach&apos;s opening ask, lower than the plan</span></span></li>
      )}
      <li data-rung="plan"><span className="wr-k">Plan</span><span>{text(s.give)} for {text(s.get)}</span></li>
      <li data-rung="walk"><span className="wr-k">Walk away at</span>
        <span title={isOk(s.walk_away) ? s.walk_away.value.text : undefined}>
          <Val f={s.walk_away} fmt={v => `${text(v.max_give)} for ${text(s.get)}`} showReason /></span></li>
    </ol>
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
