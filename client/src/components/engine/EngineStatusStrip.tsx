import { useCallback, useState } from 'react';
import { useEngineStatus, type EngineProducerRow, type EngineStatusReport } from '../../engine/useEngineView';
import { EmptyState, Sheet } from '../ui/DesignSystem';

/**
 * The engine status strip (UI-ENG-6): one line under the freshness banner.
 *   1. daemon: its last heartbeat as an age, red past 3x the tick interval (the server
 *      decides `stale`; this only shows it);
 *   2. every field on its fallback: "<field> fallen back to <fallback> (<reason>)";
 *   3. Jev: "Jev not live" until something writes spend, "$0.00" only on a live $0 day.
 * A tap opens a Sheet with one typed row per producer (FIX-257-1).
 *
 * Behind the engine strip flag (preview-mode.js#engineStripFields), served as
 * /api/engine/status `strip`: off (or missing) renders nothing; on only because of preview
 * mode shows the "Preview" label. Loading renders nothing, since the flag is not known yet;
 * a failed status read says so. Its data is one /api/engine/status request (the shared hook).
 */
const DAEMON_STYLE: Record<string, string> = {
  ok: 'text-emerald-700',
  degraded: 'text-amber-700',
  stale: 'text-rose-700 font-semibold',
  unknown: 'text-slate-500',
};

const HEALTH: Record<string, { label: string; style: string }> = {
  ok: { label: 'running', style: 'bg-emerald-50 text-emerald-800' },
  fallback: { label: 'on fallback', style: 'bg-amber-50 text-amber-800' },
  error: { label: 'last run failed', style: 'bg-rose-50 text-rose-800' },
  unknown: { label: 'not run yet', style: 'bg-slate-100 text-slate-600' },
};

function age(sec: number | null | undefined): string {
  if (sec == null) return 'never';
  if (sec < 120) return `${sec} s ago`;
  return `${Math.floor(sec / 60)} min ago`;
}

function daemonText(d: EngineStatusReport['daemon']): string {
  return `engine ${d.status === 'unknown' ? 'has not run' : `last ran ${age(d.age_sec)}`}`;
}

function jevText(jev: EngineStatusReport['jev']): string {
  if (jev.status === 'unknown') return jev.reason?.startsWith('Jev not live') ? 'Jev not live' : `Jev: ${jev.reason ?? 'unknown'}`;
  return `Jev today $${(jev.spend_usd ?? 0).toFixed(2)}`;
}

function ProducerRow({ p }: { p: EngineProducerRow }) {
  const health = p.health && HEALTH[p.health] ? p.health : 'unknown';
  return (
    <li data-producer={p.producer} data-producer-health={health} className="py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold text-slate-900">{p.producer}@{p.version}</span>
        <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${HEALTH[health].style}`}>{HEALTH[health].label}</span>
      </div>
      <div className="mt-0.5 text-xs text-slate-500">{p.age_sec == null ? 'has never run' : `last ran ${age(p.age_sec)}`}</div>
      {p.reason ? <div className="mt-0.5 text-xs text-slate-600">{p.reason}</div> : null}
      {p.fallbacks.map(f => (
        <div key={`${f.field}|${f.league_id}`} className="mt-0.5 text-xs text-amber-700">
          {f.field} fallen back to {f.fallback_field} ({f.reason})
        </div>
      ))}
    </li>
  );
}

/** The per-producer sheet the strip opens. Rows are rendered as served. */
export function EngineStatusSheet({ status, open, onClose }: { status: EngineStatusReport; open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} title="Engine status" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <p className="text-slate-600">
          <span data-engine-daemon={status.daemon.status} className={DAEMON_STYLE[status.daemon.status] ?? 'text-slate-500'}>
            {daemonText(status.daemon)}
          </span>
          {status.daemon.reason ? <span className="text-slate-500"> ({status.daemon.reason})</span> : null}
          <span className="text-slate-500"> · {jevText(status.jev)}</span>
        </p>
        {status.producers.length === 0 ? (
          <EmptyState title="No producers registered"
            description="The engine daemon has not registered a producer on this database yet, so there is nothing to show per producer." />
        ) : (
          <ul className="divide-y divide-slate-200">
            {status.producers.map(p => <ProducerRow key={p.producer} p={p} />)}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

export default function EngineStatusStrip() {
  const { data, error, loading } = useEngineStatus();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (error) return <div role="alert" className="text-xs text-rose-700 px-3 py-1" data-engine-daemon="error">engine status failed: {error}</div>;
  if (!data) return loading ? null : <div className="text-xs text-slate-500 px-3 py-1" data-engine-daemon="unknown">engine status not loaded</div>;
  if (data.strip?.enabled !== true) return null;
  const d = data.daemon;
  const fallbacks = data.producers.flatMap(p => p.fallbacks.map(f => ({ ...f, producer: p.producer })));
  const jev = jevText(data.jev);
  const summary = [daemonText(d), ...fallbacks.map(f => `${f.field} fallen back to ${f.fallback_field}`), jev].join('; ');
  return (
    <>
      <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}
        aria-label={`Engine status: ${summary}. Open per-producer details`}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-slate-200 px-3 py-1 text-left text-xs hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600">
        {data.strip.preview ? (
          <span className="rounded bg-amber-50 px-1 font-semibold text-amber-800" title={data.strip.preview_reason}>Preview</span>
        ) : null}
        <span data-engine-daemon={d.status} className={DAEMON_STYLE[d.status] ?? 'text-slate-500'} title={d.reason ?? undefined}>
          {daemonText(d)}
        </span>
        {fallbacks.map(f => (
          <span key={`${f.producer}|${f.field}|${f.league_id}`} className="text-amber-700">
            {f.field} fallen back to {f.fallback_field} ({f.reason})
          </span>
        ))}
        <span className="text-slate-600" data-jev={data.jev.status}>{jev}</span>
        <span className="ml-auto font-semibold text-slate-500" aria-hidden="true">Details</span>
      </button>
      <EngineStatusSheet status={data} open={open} onClose={close} />
    </>
  );
}
