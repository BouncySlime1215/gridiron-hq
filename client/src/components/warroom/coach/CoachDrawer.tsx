import { useEffect, useRef, useState } from 'react';
import CoachBrief, { SourcesToggle } from './CoachBrief';
import { PreviewPanel } from './CoachDock';
import PlugInCard, { FIELD_LABELS } from './PlugInCard';
import type { CoachMessage, WarRoomCoach } from './useWarRoomCoach';
import Icon from '../icons';

/**
 * WAR-ROOM-UI v2: Coach as a right-side drawer, closed by default. It opens to a short
 * list of fixed questions (no typing needed); a tap asks the existing grounded route
 * (POST /api/coach/ask, via coach.ask) and the answer shows under its question as short
 * sentences with one small "sources" toggle. The free-text box stays, below the
 * questions. Coach never sends an offer; the drawer says so.
 */
export const FIXED_QUESTIONS = [
  "What's my next move and why?",
  'Is it safe to send?',
  'Why is nothing clearing?',
  'Who should I work this week?',
  'What did league-mates say lately?',
  "What's broken right now?",
] as const;

type Slot = CoachMessage | 'asking' | 'failed';

/** A claim that is the context footer (navigator.js#footerClaim, brief's last line). */
const FOOTER_LINE = /^Destination: /;

/** Screen-change notes in words: never a dotted field id, never "engine field". */
export function plainNote(text: string): string {
  return text
    .replace(/\s*I picked the field and the view; the numbers come from the engine, not me\.?/g, '')
    .replace(/from the engine field /g, 'for ')
    .replace(/\b[a-z_]{3,}(?:\.[a-z_]{3,})+\b/g, id => (FIELD_LABELS[id] ?? id.split('.').pop()!.replace(/_/g, ' ')).toLowerCase());
}

export default function CoachDrawer({ coach, plans, open, onClose, autoAsk, onAutoAsked, deckAt }: {
  coach: WarRoomCoach; plans?: any; open: boolean; onClose: () => void;
  /** The plan on screen, sent as ask context so "what else" follow-ups track manual swipes. */
  deckAt?: { deck_index: number; move_id: string } | null;
  /** A fixed question to have answered as the drawer opens ("Ask Coach about this"). */
  autoAsk?: string | null;
  onAutoAsked?: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, Slot>>({});
  const [shown, setShown] = useState<string | null>(null);
  /** Questions asked for Nick by a tap elsewhere (a League card), shown above the fixed ones. */
  const [custom, setCustom] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [showLog, setShowLog] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // A new league is a new conversation.
  const league = plans?.league_id ?? plans?.league ?? null;
  useEffect(() => { setAnswers({}); setShown(null); setCustom([]); }, [league]);

  const run = (q: string) => {
    setShown(q);
    if (!(FIXED_QUESTIONS as readonly string[]).includes(q)) setCustom(c => [q, ...c.filter(x => x !== q)].slice(0, 4));
    if (answers[q] && answers[q] !== 'failed') return;
    setAnswers(a => ({ ...a, [q]: 'asking' }));
    coach.ask(q, deckAt ?? undefined).then(reply => setAnswers(a => ({ ...a, [q]: reply ?? 'failed' })));
  };

  useEffect(() => {
    if (!open || !autoAsk) return;
    run(autoAsk);
    onAutoAsked?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoAsk]);

  useEffect(() => { if (open) closeRef.current?.focus?.(); }, [open]);

  if (coach.enabled === false) return null;
  const fixed = new Set<string>([...FIXED_QUESTIONS, ...custom]);
  // The free-text thread: everything that was not one of the fixed questions.
  const thread = coach.messages.filter(m => (m.who === 'nick' ? !fixed.has(m.text) : !(m.question && fixed.has(m.question))));
  const submit = () => { const q = text; setText(''); void coach.ask(q, deckAt ?? undefined); };

  return (
    <>
      {open && <div className="wr-scrim" onClick={onClose} aria-hidden />}
      <aside className={`wr-drawer${open ? ' wr-open' : ''}`} aria-label="Coach" aria-hidden={!open} data-testid="coach-drawer"
        {...(open ? {} : { inert: '' })}>
        <div className="wr-drawer-h">
          <div>
            <div className="wr-ch-t">Coach</div>
            <div className="wr-ch-s">Answers from this league&apos;s plan. Never sends an offer.</div>
          </div>
          <span className="wr-sp" />
          <button type="button" className="wr-btn wr-sm" onClick={() => coach.undo()}
            disabled={!coach.session.history.length && !coach.pending}
            title={!coach.session.history.length && !coach.pending ? 'Nothing to undo yet: Coach has not changed the screen' : 'Undo the last change Coach made'}>Undo</button>
          <button type="button" className="wr-icon-btn" onClick={onClose} aria-label="Close Coach" ref={closeRef}><Icon name="close" size={18} /></button>
        </div>
        <p className="wr-drawer-ctx" data-testid="coach-context">
          <span>{coach.footer.destination}</span>
          <span>{coach.footer.stops_left} stop{coach.footer.stops_left === '1' ? '' : 's'} left</span>
          <span>Next: {coach.footer.next_move}</span>
        </p>
        <div className="wr-drawer-b" aria-live="polite">
          {coach.error && (
            <div role="alert" className="wr-state wr-state-failed">
              {coach.error} <button type="button" className="wr-link" onClick={coach.clearError}>Dismiss</button>
            </div>
          )}
          <PreviewPanel coach={coach} />
          <ul className="wr-fixedq wr-stagger" aria-label="Ask Coach">
            {[...custom, ...FIXED_QUESTIONS].map(q => {
              const a = answers[q];
              const on = shown === q;
              return (
                <li key={q} data-testid={custom.includes(q) ? 'coach-custom-q' : 'coach-fixed-q'}>
                  <button type="button" className={`wr-q${on ? ' wr-on' : ''}`} aria-expanded={on && !!a}
                    disabled={a === 'asking'} onClick={() => (on && a && a !== 'asking' && a !== 'failed' ? setShown(null) : run(q))}>
                    <span>{q}</span><Icon name="right" size={16} className="wr-q-chev" />
                  </button>
                  {on && a && <Answer slot={a} question={q} onRetry={() => run(q)} />}
                </li>
              );
            })}
          </ul>
          {coach.ui.cards.map(card => <PlugInCard key={card.id} card={card} plans={plans} />)}
          {coach.busy && !Object.values(answers).includes('asking') && (
            <Answer slot="asking" question={[...thread].reverse().find(m => m.who === 'nick')?.text} />
          )}
          {thread.length > 0 && (
            <div className="wr-thread2">
              {thread.map((m, i) => (
                <div key={i} className={m.who === 'nick' ? 'wr-msg-me' : 'wr-msg-coach'}>
                  {m.who === 'nick' ? m.text : <Answer slot={m} />}
                </div>
              ))}
            </div>
          )}
          <details className="wr-drawer-more">
            <summary>Morning brief</summary>
            <CoachBrief leagueId={plans?.league_id} citeStyle="sources" />
          </details>
          <button type="button" className="wr-link" onClick={() => setShowLog(s => !s)} aria-expanded={showLog}>
            Action log ({coach.log.length})
          </button>
          {showLog && (
            <ul className="wr-ch-s">
              {coach.log.slice(0, 30).map((l, i) => <li key={i}><code>{l.type}</code> {l.outcome}: {l.detail}</li>)}
            </ul>
          )}
        </div>
        <form className="wr-ask wr-drawer-ask" onSubmit={e => { e.preventDefault(); submit(); }}>
          <input value={text} onChange={e => setText(e.target.value)} placeholder="Or type your own question..."
            aria-label="Ask Coach" disabled={coach.busy} />
          <button className="wr-btn" type="submit" disabled={coach.busy || !text.trim()}
            title={coach.busy ? 'Coach is answering' : !text.trim() ? 'Type a question first' : undefined}>{coach.busy ? 'Working' : 'Ask'}</button>
        </form>
      </aside>
    </>
  );
}

/** One answer: short sentences, then refusals and screen changes, then one sources toggle. */
function Answer({ slot, question, onRetry }: { slot: Slot; question?: string; onRetry?: () => void }) {
  if (slot === 'asking') {
    return (
      <div className="wr-answer wr-thinking" role="status" aria-live="polite" data-testid="coach-thinking">
        <span className="wr-think-line">Coach is thinking<span className="wr-dots3" aria-hidden><i /><i /><i /></span></span>
        {question && <span className="wr-think-q">“{question}”</span>}
        <span className="wr-skel wr-skel-line" /><span className="wr-skel wr-skel-line wr-skel-short" />
      </div>
    );
  }
  if (slot === 'failed') {
    return (
      <div className="wr-answer wr-answer-err" role="status">
        <span>Coach could not answer this one. The reason is shown at the top.</span>
        {onRetry && <button type="button" className="wr-btn wr-sm" onClick={onRetry}>Try again</button>}
      </div>
    );
  }
  // The destination / where-we-are / next-move footer shows once, at the top of the drawer.
  const claims = (slot.claims ?? []).filter(c => !c.footer && !FOOTER_LINE.test(c.text));
  const cites = [...new Set(claims.flatMap(c => c.cites))];
  const extra = (slot.outcomes ?? []).map(o => o.message).filter(Boolean).map(plainNote);
  return (
    <div className="wr-answer" data-testid="coach-answer">
      {claims.length ? claims.map((c, i) => <p key={i}>{c.text}</p>)
        : !slot.claims?.length && slot.text && !extra.length ? <p>{slot.text}</p> : null}
      {extra.map((t, i) => <p key={`o${i}`} className="wr-muted">{t}</p>)}
      {slot.refusals?.map((r, i) => <p key={`r${i}`} className="wr-muted">{r}</p>)}
      <SourcesToggle cites={cites} ledger={slot.ledger} testid="coach-answer-sources" />
    </div>
  );
}
