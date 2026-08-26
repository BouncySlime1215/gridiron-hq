import { Link } from 'react-router-dom';
import { useLeague } from '../state/league';

/**
 * The one place you pick which league you're looking at. Lives in the header, so it
 * applies to every page — My Team, Trade Lab, the Prediction Engine — rather than each
 * of them needing its own dropdown that only they respect.
 */
export default function LeagueSwitcher() {
  const { leagues, active, activeId, setActiveId, loading } = useLeague();

  if (loading && !leagues.length) return null;

  if (!leagues.length) {
    return (
      <Link to="/leagues"
        className="text-xs text-slate-500 hover:text-emerald-700 px-2.5 py-1.5 rounded-lg border border-dashed border-slate-300 hover:border-emerald-400 whitespace-nowrap transition-colors">
        + Connect a league
      </Link>
    );
  }

  if (leagues.length === 1) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-200 whitespace-nowrap"
        title="Only one league connected — add more on the My Leagues page">
        <span className={`text-[9px] font-black px-1 rounded ${active?.platform === 'sleeper' ? 'bg-violet-100 text-violet-700' : 'bg-rose-100 text-rose-700'}`}>
          {active?.platform?.toUpperCase()}
        </span>
        {active?.name ?? `League ${active?.league_id}`}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
    {active?.connection_status && active.connection_status !== 'connected' && (
      <Link to="/leagues" className="rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] font-bold text-amber-800">
        Reconnect
      </Link>
    )}
    <select
      value={activeId ?? ''}
      onChange={e => setActiveId(Number(e.target.value))}
      title="Switch which league you're viewing — applies across My Team, Trade Lab and the Prediction Engine"
      className="input py-1.5 text-xs max-w-[200px] font-medium">
      {leagues.map(l => (
        <option key={l.id} value={l.id}>
          {l.platform === 'sleeper' ? '🟣 ' : '🔴 '}{l.name ?? `League ${l.league_id}`}
        </option>
      ))}
    </select>
    </div>
  );
}
