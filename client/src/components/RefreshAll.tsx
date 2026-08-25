import { useState } from 'react';
import { api } from '../api';

/** Repull every live data source. Lives in the header, so it's on every page. */
export default function RefreshAll({ onDone }: { onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const run = async () => {
    setBusy(true); setResult(null);
    try {
      const r = await api('/dev/refresh-all', { method: 'POST' });
      setResult(r);
      onDone?.();
      setTimeout(() => setResult(null), 12000);
    } catch (e: any) {
      setResult({ ok: false, failed: [e.message] });
    } finally { setBusy(false); }
  };

  const okCount = result?.steps?.filter((s: any) => s.ok).length ?? 0;
  const total = result?.steps?.length ?? 0;

  return (
    <div className="relative">
      <button
        onClick={run}
        disabled={busy}
        title="Repull rosters, depth charts, schedules, cap, stats, news and the NFL Top 100"
        className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 hover:border-emerald-300 hover:bg-emerald-50 disabled:opacity-60 transition-colors">
        <span className={`text-sm leading-none ${busy ? 'animate-spin inline-block' : ''}`}>↻</span>
        <span className="text-xs font-semibold text-slate-600">{busy ? 'Refreshing…' : 'Refresh data'}</span>
      </button>

      {result && (
        <div className="absolute right-0 top-full mt-2 w-72 card p-3 shadow-lg z-50">
          <div className="flex items-center gap-2 mb-2">
            <span className={`text-xs font-bold ${result.failed?.length ? 'text-amber-600' : 'text-emerald-700'}`}>
              {result.failed?.length ? `${okCount}/${total} sources updated` : 'All sources updated'}
            </span>
            <button onClick={() => setResult(null)} className="ml-auto text-slate-400 hover:text-slate-700 text-xs">✕</button>
          </div>
          <ul className="space-y-0.5">
            {(result.steps ?? []).map((s: any) => (
              <li key={s.name} className="flex items-center gap-2 text-[11px]">
                <span className={s.ok ? 'text-good' : 'text-crit'}>{s.ok ? '✓' : '✕'}</span>
                <span className="text-slate-600 capitalize">{s.name}</span>
                <span className="ml-auto text-slate-400 truncate max-w-[120px]">
                  {s.ok
                    ? (s.players ?? s.assignments ?? s.games ?? s.teams ?? s.projected ?? s.revealed ?? s.added ?? '') || 'ok'
                    : s.error}
                </span>
              </li>
            ))}
          </ul>
          {result.failed?.length > 0 && (
            <p className="text-[10px] text-amber-600 mt-2">
              Failed sources keep their last-synced data — nothing was wiped.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
