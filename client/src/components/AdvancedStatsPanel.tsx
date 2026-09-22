import { useApi } from '../api';

interface AdvancedStat {
  key: string;
  label: string;
  value: number | null;
  unit: 'pct' | 'rate' | 'index' | 'yards' | null;
  basis: string | null;
  unavailable_reason: string | null;
}
interface AdvancedStatsReport {
  player_id: number;
  name: string | null;
  position: string | null;
  season: number;
  weeks_measured: number;
  stats: AdvancedStat[];
}

/**
 * Advanced stats for a player, including the ones this platform cannot measure.
 *
 * The three that cannot be measured are shown, not hidden. That is the whole
 * design decision and it is worth stating: an empty space makes no claim a
 * reader can argue with, so a page that silently omits yards per route run
 * reads as a complete page. A reader counts what they can see. Saying "not
 * measured here, and why" is the only version that leaves them knowing what
 * they actually know.
 *
 * The same reason the freshness banner says when its own check failed instead
 * of rendering nothing.
 */
function formatValue(s: AdvancedStat): string {
  if (s.value == null) return 'not measured';
  if (s.unit === 'pct') return `${Math.round(s.value * 1000) / 10}%`;
  if (s.unit === 'rate') return `${(s.value * 100).toFixed(1)}%`;
  if (s.unit === 'index') return s.value.toFixed(2);
  return String(Math.round(s.value * 10) / 10);
}

export default function AdvancedStatsPanel({ playerId }: { playerId: number }) {
  const { data: report, error } = useApi<AdvancedStatsReport>(`/players/${playerId}/advanced-stats`);

  // The request failed. Rendering null here would put an absent block on the
  // page, which reads as "this player has no advanced stats" rather than "we
  // could not load them" — two opposite things that must not look alike.
  if (error) {
    return (
      <div className="card p-4 mt-4">
        <h3 className="text-sm font-bold text-slate-700 mb-1">Advanced stats</h3>
        <p className="text-xs text-slate-500">
          These could not be loaded. Nothing here says anything about this player either way.
        </p>
      </div>
    );
  }
  if (!report) return null;

  const measured = report.stats.filter(s => s.value != null);
  const absent = report.stats.filter(s => s.value == null);

  return (
    <div className="card p-4 mt-4">
      <div className="flex flex-wrap items-baseline gap-2 mb-2">
        <h3 className="text-sm font-bold text-slate-700">Advanced stats</h3>
        <span className="text-xs text-slate-500">
          {report.season} ·{' '}
          {report.weeks_measured === 0
            ? 'no weeks on file'
            : `${report.weeks_measured} week${report.weeks_measured === 1 ? '' : 's'} on file`}
        </span>
      </div>

      {measured.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          {measured.map(s => (
            <div key={s.key}>
              <div className="text-lg font-black text-slate-800">{formatValue(s)}</div>
              <div className="text-xs font-medium text-slate-600">{s.label}</div>
              {/* The denominator, always. "Touchdown rate" on its own is three
                  different statistics depending on who is being described. */}
              {s.basis && <div className="text-[11px] text-slate-400">{s.basis}</div>}
            </div>
          ))}
        </div>
      )}

      {absent.length > 0 && (
        <div className="border-t border-slate-200/60 pt-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">
            Not measured here
          </div>
          {absent.map(s => (
            <div key={s.key} className="py-1">
              <span className="text-xs font-medium text-slate-600">{s.label}</span>
              <span className="text-xs text-slate-500"> — {s.unavailable_reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
