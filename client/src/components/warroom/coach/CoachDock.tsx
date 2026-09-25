import { useState } from 'react';
import CoachBrief from './CoachBrief';
import type { WarRoomCoach } from './useWarRoomCoach';
import PlugInCard from './PlugInCard';
import { NOT_COMPUTED, pts, size } from '../format';

/** WR-POLISH (audit defect 5): what Nick can ask first; a tap sends it. */
export const STARTER_PROMPTS = [
  "What's my next move and why?",
  'Why is nothing clearing?',
  'Show me the all-in plan',
  'Who should I message first?',
] as const;

/** The empty dock: a greeting, the four prompts, and where we stand (the footer). */
export function CoachStarter({ coach }: { coach: WarRoomCoach }) {
  return (
    <div className="wr-starter" data-testid="coach-starter">
      <p className="wr-starter-hi">I read this league's plan. Ask me anything about it, or tap one:</p>
      <div className="wr-starter-prompts">
        {STARTER_PROMPTS.map(q => (
          <button key={q} type="button" className="wr-prompt" disabled={coach.busy} onClick={() => { void coach.ask(q); }}>{q}</button>
        ))}
      </div>
      <div className="wr-ch-s" data-testid="coach-footer">{coach.footer.text}</div>
    </div>
  );
}

/**
 * The Coach dock in the War Room's right column (a bottom sheet on a phone):
 * chat, the trade-off preview with its Confirm tap, one-tap undo and the action
 * log. Every Coach reply ends with the destination, stops left and next move.
 * Coach never sends an offer; the dock says so.
 *
 * Cards Coach plugged in (plug_in) draw here, each reading its whitelisted
 * field from `plans`, the same War Room view the panels draw.
 *
 * The preview is the producer's stop_tradeoffs entry, read not computed: a
 * title-odds number (source sim.title) prints in points, anything else as written.
 */
function fmt(f: any, signed = false): string {
  if (f == null) return NOT_COMPUTED;
  if (typeof f === 'number' || typeof f === 'string') return String(f);
  if (typeof f !== 'object' || f.status !== 'ok' || typeof f.value !== 'number') return NOT_COMPUTED;
  const text = f.source === 'sim.title' ? (signed ? pts(f.value) : size(f.value)) : String(f.value);
  return `${text}${f.guess ? ' (guess)' : ''}`;
}

export function PreviewPanel({ coach }: { coach: WarRoomCoach }) {
  const p = coach.pending;
  if (!p) return null;
  const v = p.preview.value;
  return (
    <div role="dialog" aria-label="Trade-off preview" className="wr-state">
      <div className="wr-ch-t">Trade-off before anything changes</div>
      {p.preview.status === 'ok' && v ? (
        <ul>
          {v.stop_label && <li>{v.stop_label}</li>}
          <li>Costs: {fmt(v.cost)}{v.extra_steps != null ? `, ${v.extra_steps} extra step(s)` : ''}</li>
          <li>Gains: {fmt(v.gain)}{v.gain_text ? ` (${v.gain_text})` : ''}</li>
          <li>Net: {fmt(v.net, true)}{v.verdict ? `: ${String(v.verdict).replace(/_/g, ' ')}` : ''}</li>
          {v.because && <li>Because {v.because}</li>}
          {v.new_next_move_changes != null && <li>Next move {v.new_next_move_changes ? 'changes' : 'stays the same'}</li>}
        </ul>
      ) : (
        <p>{p.preview.reason}</p>
      )}
      <div className="wr-ask">
        <button type="button" className="wr-btn" onClick={coach.cancel}>Cancel</button>
        <button type="button" className="wr-btn wr-primary" onClick={() => { void coach.confirm(); }}>Confirm</button>
      </div>
    </div>
  );
}

export default function CoachDock({ coach, plans, open = true, onToggle }: { coach: WarRoomCoach; plans?: any; open?: boolean; onToggle?: () => void }) {
  const [text, setText] = useState('');
  const [showLog, setShowLog] = useState(false);
  if (coach.enabled === false) return null;
  const submit = () => { const q = text; setText(''); void coach.ask(q); };
  const toggle = () => onToggle?.();
  return (
    <aside className={`wr-coach${open ? ' wr-open' : ''}`} aria-label="Coach">
      <div className="wr-ch" onClick={toggle} role="button" tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') toggle(); }}>
        <div>
          <div className="wr-ch-t">Coach</div>
          <div className="wr-ch-s">Changes this screen for you. Never sends an offer.</div>
        </div>
        <button type="button" className="wr-btn wr-sm" onClick={e => { e.stopPropagation(); coach.undo(); }}
          disabled={!coach.session.history.length && !coach.pending}>Undo</button>
        <span className="wr-tog" aria-hidden>{open ? '▼' : '▲'}</span>
      </div>
      <div className="wr-chat" aria-live="polite">
        <CoachBrief leagueId={plans?.league_id} />
        {coach.error && (
          <div role="alert" className="wr-state wr-state-failed">
            {coach.error} <button type="button" className="wr-link" onClick={coach.clearError}>Dismiss</button>
          </div>
        )}
        {!coach.messages.length && !coach.pending && <CoachStarter coach={coach} />}
        {coach.messages.map((m, i) => (
          <div key={i} style={{ margin: '4px 0', textAlign: m.who === 'nick' ? 'right' : 'left' }}>
            <div>{m.text}</div>
            {m.refusals?.map((r, j) => <div key={j} className="wr-muted">{r}</div>)}
            {m.who === 'coach' && <div className="wr-ch-s">{m.footer ?? coach.footer.text}</div>}
          </div>
        ))}
        {coach.ui.cards.map(card => <PlugInCard key={card.id} card={card} plans={plans} />)}
        <PreviewPanel coach={coach} />
        <button type="button" className="wr-link" onClick={() => setShowLog(s => !s)} aria-expanded={showLog}>
          Action log ({coach.log.length})
        </button>
        {showLog && (
          <ul className="wr-ch-s">
            {coach.log.slice(0, 30).map((l, i) => (
              <li key={i}><code>{l.type}</code> {l.outcome}: {l.detail}</li>
            ))}
          </ul>
        )}
      </div>
      <form className="wr-ask" onSubmit={e => { e.preventDefault(); submit(); }}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Ask Coach to change the screen..."
          aria-label="Ask Coach" disabled={coach.busy} />
        <button className="wr-btn wr-primary" type="submit" disabled={coach.busy || !text.trim()}>{coach.busy ? 'Working' : 'Ask'}</button>
      </form>
    </aside>
  );
}
