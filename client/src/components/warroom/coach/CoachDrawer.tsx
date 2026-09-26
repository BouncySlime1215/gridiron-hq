import { useEffect, useRef, useState } from 'react';
import CoachBrief, { SourcesToggle } from './CoachBrief';
import PlugInCard, { FIELD_LABELS } from './PlugInCard';
import { DraftCard, PlanChangeCard, ProposalCard } from './ActionCards';
import type { CoachMessage, WarRoomCoach } from './useWarRoomCoach';
import { api } from '../../../api';
import Icon from '../icons';
import NumbersPeopleCard from '../../trade/NumbersPeopleCard';

/**
 * WAR-ROOM-UI v2 + COACH-CHAT: Coach as a right-side drawer, closed by default,
 * holding one conversation per league. An empty conversation opens on a short list
 * of starter questions (no typing needed). Each answer shows as a chat bubble of
 * short grounded sentences with one small "sources" toggle, then 2-3 follow-up
 * chips and any action cards Coach proposes (nothing runs without a tap). The
 * conversation lives on the server, so it survives closing the drawer, moving
 * between pages and reloading; "New conversation" starts over. Coach never sends
 * an offer; the drawer says so.
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

const money = (n: number) => `$${n < 0.01 && n > 0 ? '0.01' : n.toFixed(2)}`;

export default function CoachDrawer({ coach, plans, open, onClose, autoAsk, onAutoAsked, deckAt, onChanged }: {
  coach: WarRoomCoach; plans?: any; open: boolean; onClose: () => void;
  /** The plan on screen, sent as ask context so "what else" follow-ups track manual swipes. */
  deckAt?: { deck_index: number; move_id: string } | null;
  /** A fixed question to have answered as the drawer opens ("Ask Coach about this"). */
  autoAsk?: string | null;
  onAutoAsked?: () => void;
  /** After an action card is done: refresh the view it changed. */
  onChanged?: () => void;
}) {
  const [text, setText] = useState('');
  const [showLog, setShowLog] = useState(false);
  const [spend, setSpend] = useState<{ model_on: boolean; spent_today_usd: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const ask = (q: string) => { void coach.ask(q, deckAt ?? undefined); };

  useEffect(() => {
    if (!open || !autoAsk) return;
    ask(autoAsk);
    onAutoAsked?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoAsk]);

  useEffect(() => { if (open) closeRef.current?.focus?.(); }, [open]);

  // The newest message in view.
  const count = coach.messages.length;
  useEffect(() => {
    const el = bodyRef.current;
    if (open && el && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight });
  }, [open, count, coach.busy]);

  // Today's AI spend, for the one-line hint under the box (only when the model is on).
  useEffect(() => {
    if (!open) return;
    let live = true;
    api<{ model_on: boolean; spent_today_usd: number }>('/coach/spend')
      .then(res => { if (live) setSpend(res); })
      .catch((e: unknown) => console.warn('Coach: today\'s AI spend could not be read', e));
    return () => { live = false; };
  }, [open, count]);

  if (coach.enabled === false) return null;
  const messages = coach.messages;
  const lastCoach = [...messages].reverse().find(m => m.who === 'coach');
  const lastAsked = [...messages].reverse().find(m => m.who === 'nick')?.text;
  const empty = messages.length === 0 && !coach.busy;
  const draft = coach.ui.drafts?.[String(coach.ui.league ?? 'current')] ?? null;
  const submit = () => { const q = text; setText(''); ask(q); };

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
          <button type="button" className="wr-btn wr-sm" onClick={() => { void coach.newConversation(); }} data-testid="coach-new"
            disabled={!messages.length || coach.busy}
            title={!messages.length ? 'This conversation is already empty' : coach.busy ? 'Coach is answering' : 'Start a new conversation'}>New</button>
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
        <div className="wr-drawer-b" aria-live="polite" ref={bodyRef}>
          {coach.error && (
            <div role="alert" className="wr-state wr-state-failed">
              {coach.error} <button type="button" className="wr-link" onClick={coach.clearError}>Dismiss</button>
            </div>
          )}
          {empty && (
            <ul className="wr-fixedq wr-stagger" aria-label="Ask Coach">
              {FIXED_QUESTIONS.map(q => (
                <li key={q} data-testid="coach-fixed-q">
                  <button type="button" className="wr-q" onClick={() => ask(q)} disabled={coach.busy}>
                    <span>{q}</span><Icon name="right" size={16} className="wr-q-chev" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {messages.length > 0 && (
            <div className="wr-thread2" data-testid="coach-thread">
              {messages.map((m, i) => (
                <div key={i} className={m.who === 'nick' ? 'wr-msg-me' : 'wr-msg-coach'} data-testid={m.who === 'nick' ? 'coach-msg-me' : 'coach-msg-coach'}>
                  {m.who === 'nick' ? m.text : <Answer slot={m} />}
                </div>
              ))}
            </div>
          )}
          {coach.busy && <div className="wr-msg-coach"><Answer slot="asking" question={lastAsked} /></div>}
          {!coach.busy && coach.pending && <PlanChangeCard pending={coach.pending} coach={coach} onChanged={onChanged} />}
          {!coach.busy && draft && <DraftCard text={draft} />}
          {!coach.busy && lastCoach?.proposals?.map(p => (
            <ProposalCard key={`${lastCoach.question ?? ''}:${p.kind}`} proposal={p} coach={coach} onChanged={onChanged} />
          ))}
          {!coach.busy && lastCoach?.followups && lastCoach.followups.length > 0 && (
            <div className="wr-chat-chips" aria-label="Ask next" data-testid="coach-followups">
              {/* The design system's Chip (ds-chip, accent tone), by its classes. */}
              {lastCoach.followups.map(q => (
                <button key={q} type="button" className="ds-chip ds-chip-accent" onClick={() => ask(q)} data-testid="coach-followup">{q}</button>
              ))}
            </div>
          )}
          {/* One card per field and view: asking the same question twice does not stack the same number twice. */}
          {[...new Map(coach.ui.cards.map(card => [`${card.field}|${card.view}`, card])).values()]
            .map(card => <PlugInCard key={card.id} card={card} plans={plans} />)}
          <details className="wr-drawer-more">
            <summary>Morning brief</summary>
            <CoachBrief leagueId={plans?.league_id} citeStyle="sources" />
          </details>
          <button type="button" className="wr-link" onClick={() => setShowLog(s => !s)} aria-expanded={showLog}>
            Action log ({coach.log.length})
          </button>
          {showLog && (
            <ul className="wr-ch-s">
              {coach.log.slice(0, 30).map((l, i) => <li key={i}>{l.outcome}: {l.detail}</li>)}
            </ul>
          )}
        </div>
        <form className="wr-ask wr-drawer-ask" onSubmit={e => { e.preventDefault(); submit(); }}>
          <input value={text} onChange={e => setText(e.target.value)} placeholder={messages.length ? 'Ask a follow-up...' : 'Or type your own question...'}
            aria-label="Ask Coach" disabled={coach.busy} />
          <button className="wr-btn" type="submit" disabled={coach.busy || !text.trim()}
            title={coach.busy ? 'Coach is answering' : !text.trim() ? 'Type a question first' : undefined}>{coach.busy ? 'Working' : 'Ask'}</button>
        </form>
        {spend?.model_on && (
          <p className="wr-drawer-spend" data-testid="coach-spend">AI today: {money(spend.spent_today_usd)}. Answers from your plan cost nothing.</p>
        )}
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
  // COACH-V2: the answer format. The verdict leads, then the why bullets and at most two risk lines.
  const shape = slot.shape;
  if (shape?.verdict) {
    return (
      <div className="wr-answer" data-testid="coach-answer">
        <p className="wr-verdict" data-testid="coach-verdict">{shape.verdict.text}</p>
        {shape.why.length > 0 && <ul className="wr-why" data-testid="coach-why">{shape.why.map((w, i) => <li key={i}>{w.text}</li>)}</ul>}
        {shape.risks.map((r, i) => <p key={`k${i}`} className="wr-muted">{r.text}</p>)}
        {shape.more && shape.more.length > 0 && (
          <details className="wr-more" data-testid="coach-more">
            <summary>More from your plan ({shape.more.length})</summary>
            {shape.more.map((m, i) => <p key={`m${i}`}>{m.text}</p>)}
          </details>
        )}
        {extra.map((t, i) => <p key={`o${i}`} className="wr-muted">{t}</p>)}
        {slot.refusals?.filter(r => r !== shape.verdict?.text).map((r, i) => <p key={`r${i}`} className="wr-muted">{r}</p>)}
        <SourcesToggle cites={cites} ledger={slot.ledger} testid="coach-answer-sources" />
      </div>
    );
  }
  return (
    <div className="wr-answer" data-testid="coach-answer">
      {claims.length ? claims.map((c, i) => <p key={i}>{c.text}</p>)
        : !slot.claims?.length && slot.text && !extra.length && !slot.refusals?.length ? <p>{slot.text}</p> : null}
      {extra.map((t, i) => <p key={`o${i}`} className="wr-muted">{t}</p>)}
      {slot.refusals?.map((r, i) => <p key={`r${i}`} className="wr-muted">{r}</p>)}
      <SourcesToggle cites={cites} ledger={slot.ledger} testid="coach-answer-sources" />
      {slot.lanes && <LanesReveal lanes={slot.lanes} />}
      {/* NUMBERS-PEOPLE: the item this answer is about has a stored read: both lanes, compact (the shared card). */}
      {slot.numbersPeople && <div className="mt-2" data-testid="coach-numbers-people"><NumbersPeopleCard item={slot.numbersPeople} variant="compact" /></div>}
    </div>
  );
}

/**
 * COACH-LANES: a model answer built from the numbers lane and the people lane shows a small
 * "Claude + Jev" (or, where Jev is not wired, "Numbers + People") toggle; open, it shows what each lane said (collapsed by default), and
 * a disagreement between them as one highlighted line.
 */
function LanesReveal({ lanes }: { lanes: NonNullable<CoachMessage['lanes']> }) {
  const [open, setOpen] = useState(false);
  const people = lanes.people?.claims ?? [];
  if (!people.length && !lanes.disagreement) return null;
  return (
    <div className="wr-lanes" data-testid="coach-lanes">
      <button type="button" className={`wr-srcs${open ? ' wr-on' : ''}`} aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {lanes.title ?? 'Numbers + People'}{lanes.disagreement ? ' (they disagree)' : ''}
      </button>
      {lanes.disagreement && <p className="wr-lanes-dis" data-testid="coach-lanes-disagree">{lanes.disagreement}{lanes.action ? ` ${lanes.action}` : ''}</p>}
      {open && (
        <div className="wr-srcs-list" data-testid="coach-lanes-detail">
          <b>{lanes.people?.source === 'jev' ? 'Claude (numbers)' : 'Numbers'}</b>
          <ul>{(lanes.numbers?.claims ?? []).map((t, i) => <li key={`n${i}`}>{t}</li>)}{!(lanes.numbers?.claims ?? []).length && <li>Nothing the numbers could stand up.</li>}</ul>
          <b>{lanes.people?.source === 'jev' ? 'Jev' : 'People'} ({lanes.people?.source === 'jev' ? 'chat read, ungraded' : lanes.people?.label ?? 'chat read (ungraded)'})</b>
          <ul>{people.map((t, i) => <li key={`p${i}`}>{t}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
