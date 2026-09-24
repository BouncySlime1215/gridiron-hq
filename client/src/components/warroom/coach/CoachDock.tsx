import { useState } from 'react';
import type { WarRoomCoach } from './useWarRoomCoach';
import PlugInCard from './PlugInCard';
import TradeoffPreview from '../TradeoffPreview';

/**
 * The Coach dock in the War Room's right column (a bottom sheet on a phone):
 * chat, the trade-off preview with its Confirm tap, one-tap undo and the action
 * log. Every Coach reply ends with the destination, stops left and next move.
 * Coach never sends an offer; the dock says so.
 *
 * Cards Coach plugged in (plug_in) draw here, each reading its whitelisted
 * field from `plans`, the same War Room view the panels draw.
 *
 * The preview is the producer's stop_tradeoffs entry, read not computed (../TradeoffPreview).
 */
function PreviewPanel({ coach }: { coach: WarRoomCoach }) {
  const p = coach.pending;
  if (!p) return null;
  return (
    <div role="dialog" aria-label="Trade-off preview" className="wr-state">
      <div className="wr-ch-t">Trade-off before anything changes</div>
      <TradeoffPreview preview={p.preview} />
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
        {coach.error && (
          <div role="alert" className="wr-state wr-state-failed">
            {coach.error} <button type="button" className="wr-link" onClick={coach.clearError}>Dismiss</button>
          </div>
        )}
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
