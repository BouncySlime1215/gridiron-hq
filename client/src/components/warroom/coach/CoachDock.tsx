import { useState } from 'react';
import type { WarRoomCoach } from './useWarRoomCoach';

/**
 * The Coach dock: chat, the trade-off preview with its Confirm tap, one-tap
 * undo and the action log. Every Coach reply ends with the destination, stops
 * left and next move. Coach never sends an offer; the dock says so.
 */
function fmt(v: any): string {
  if (v == null) return 'not computed yet';
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  if (typeof v === 'object' && v.value != null) return `${v.value}${v.guess ? ' (guess)' : ''}`;
  return 'not computed yet';
}

function PreviewPanel({ coach }: { coach: WarRoomCoach }) {
  const p = coach.pending;
  if (!p) return null;
  const v = p.preview.value;
  return (
    <div role="dialog" aria-label="Trade-off preview" className="card border-amber-300 p-3">
      <div className="font-bold">Trade-off before anything changes</div>
      {p.preview.status === 'ok' && v ? (
        <ul className="mt-1 text-sm">
          {v.stop_label && <li>{v.stop_label}</li>}
          <li>Costs: {fmt(v.cost)}{v.extra_steps != null ? `, ${v.extra_steps} extra step(s)` : ''}</li>
          <li>Gains: {fmt(v.gain)}{v.gain_text ? ` (${v.gain_text})` : ''}</li>
          <li>Net: {fmt(v.net)}{v.verdict ? `: ${String(v.verdict).replace(/_/g, ' ')}` : ''}</li>
          {v.because && <li>Because {v.because}</li>}
          {v.new_next_move_changes != null && <li>Next move {v.new_next_move_changes ? 'changes' : 'stays the same'}</li>}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-slate-500">{p.preview.reason}</p>
      )}
      <div className="mt-2 flex gap-2">
        <button className="btn-ghost" onClick={coach.cancel}>Cancel</button>
        <button className="btn-primary" onClick={() => { void coach.confirm(); }}>Confirm</button>
      </div>
    </div>
  );
}

export default function CoachDock({ coach }: { coach: WarRoomCoach }) {
  const [text, setText] = useState('');
  const [showLog, setShowLog] = useState(false);
  if (coach.enabled === false) return null;
  const submit = () => { const q = text; setText(''); void coach.ask(q); };
  return (
    <aside aria-label="Coach" className="card flex min-h-0 flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <div>
          <div className="font-bold">Coach</div>
          <div className="text-xs text-slate-500">Changes this screen for you. Never sends an offer.</div>
        </div>
        <span className="flex-1" />
        <button className="btn-ghost text-sm" onClick={coach.undo} disabled={!coach.session.history.length && !coach.pending}>Undo</button>
      </div>
      {coach.error && (
        <div role="alert" className="text-sm text-red-700">
          {coach.error} <button className="btn-ghost text-xs" onClick={coach.clearError}>Dismiss</button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto text-sm" aria-live="polite">
        {coach.messages.map((m, i) => (
          <div key={i} className={m.who === 'nick' ? 'my-1 text-right' : 'my-1'}>
            <div>{m.text}</div>
            {m.refusals?.map((r, j) => <div key={j} className="text-slate-500">{r}</div>)}
            {m.who === 'coach' && <div className="mt-1 text-xs text-slate-500">{m.footer ?? coach.footer.text}</div>}
          </div>
        ))}
      </div>
      <PreviewPanel coach={coach} />
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); submit(); }}>
        <input className="min-w-0 flex-1 rounded-md border px-2 py-1" value={text} onChange={e => setText(e.target.value)}
          placeholder="Ask Coach to change the screen..." aria-label="Ask Coach" disabled={coach.busy} />
        <button className="btn-primary" type="submit" disabled={coach.busy || !text.trim()}>{coach.busy ? 'Working' : 'Ask'}</button>
      </form>
      <button className="btn-ghost text-left text-xs" onClick={() => setShowLog(s => !s)} aria-expanded={showLog}>
        Action log ({coach.log.length})
      </button>
      {showLog && (
        <ul className="max-h-40 overflow-y-auto text-xs">
          {coach.log.slice(0, 30).map((l, i) => (
            <li key={i}><code>{l.type}</code> {l.outcome}: {l.detail}</li>
          ))}
        </ul>
      )}
    </aside>
  );
}
