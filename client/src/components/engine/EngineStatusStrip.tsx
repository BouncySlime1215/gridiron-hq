import { useEngineStatus } from '../../engine/useEngineView';

/**
 * The engine status strip (UI-ENG-6): one line under the header.
 *   1. daemon: its last heartbeat as an age, red past 3x the tick interval (the server
 *      decides `stale`; this only shows it);
 *   2. every field on its fallback: "<field> fallen back to <fallback> (<reason>)";
 *   3. Jev: "Jev not live" until something writes spend, "$0.00" only on a live $0 day.
 * Its data is one /api/engine/status request (the shared hook).
 */
const DAEMON_STYLE: Record<string, string> = {
  ok: 'text-emerald-700',
  degraded: 'text-amber-700',
  stale: 'text-rose-700 font-semibold',
  unknown: 'text-slate-500',
};

function age(sec: number | null): string {
  if (sec == null) return 'never';
  if (sec < 120) return `${sec} s ago`;
  return `${Math.floor(sec / 60)} min ago`;
}

export default function EngineStatusStrip() {
  const { data, error } = useEngineStatus();
  if (error) return <div className="text-xs text-rose-700 px-3 py-1" data-engine-daemon="error">engine status failed: {error}</div>;
  if (!data) return <div className="text-xs text-slate-500 px-3 py-1" data-engine-daemon="unknown">engine status not loaded</div>;
  const d = data.daemon;
  const fallbacks = data.producers.flatMap(p => p.fallbacks.map(f => ({ ...f, producer: p.producer })));
  const jev = data.jev;
  const jevText = jev.status === 'unknown' ? (jev.reason?.startsWith('Jev not live') ? 'Jev not live' : `Jev: ${jev.reason ?? 'unknown'}`)
    : `Jev today $${(jev.spend_usd ?? 0).toFixed(2)}`;
  return (
    <div className="text-xs px-3 py-1 flex flex-wrap gap-x-3 gap-y-0.5 border-b border-slate-200">
      <span data-engine-daemon={d.status} className={DAEMON_STYLE[d.status] ?? 'text-slate-500'} title={d.reason ?? undefined}>
        engine {d.status === 'unknown' ? 'has not run' : `last ran ${age(d.age_sec)}`}
      </span>
      {fallbacks.map(f => (
        <span key={`${f.field}|${f.league_id}`} className="text-amber-700">
          {f.field} fallen back to {f.fallback_field} ({f.reason})
        </span>
      ))}
      <span className="text-slate-600" data-jev={jev.status}>{jevText}</span>
    </div>
  );
}
