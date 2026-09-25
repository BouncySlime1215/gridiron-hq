import { Link } from 'react-router-dom';
import { useLeague } from '../state/league';
import { Icon, Skeleton } from './ui/DesignSystem';

/**
 * The one place you pick which league you're looking at. Lives in the header, so it
 * applies to every page — My Team, Trade Lab, the Prediction Engine — rather than each
 * of them needing its own dropdown that only they respect.
 */
export default function LeagueSwitcher() {
  const { leagues, active, activeId, setActiveId, loading } = useLeague();

  // A picker-sized placeholder while the list loads, so the header does not shift when it lands.
  if (loading && !leagues.length) return <Skeleton className="h-[30px] w-full sm:w-[180px]" />;

  if (!leagues.length) {
    return (
      <Link to="/league"
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
    <div className="flex min-w-0 items-center gap-2">
    {active?.connection_status && active.connection_status !== 'connected' && (
      <Link to="/league" className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-1 text-[10px] font-bold text-amber-800 sm:px-2"
        aria-label={active.connection_status === 'needs_reconnect' ? 'Reconnect this league' : 'Sync failed for this league'}
        title={active.connection_status === 'needs_reconnect' ? 'ESPN credentials were removed: reconnect on League' : 'The last sync of this league failed: retry it on League'}>
        {/* On a phone the chip is the icon alone, so the league name keeps its room. */}
        <Icon name="warn" size={12} /><span className="hidden sm:inline">{active.connection_status === 'needs_reconnect' ? 'Reconnect' : 'Sync failed'}</span>
      </Link>
    )}
    <select
      value={activeId ?? ''}
      onChange={e => setActiveId(Number(e.target.value))}
      title="Switch which league you're viewing — applies across My Team, Trade Lab and the Prediction Engine"
      className="input league-select min-w-[5.5rem] w-full py-1.5 text-xs max-w-[200px] font-medium">
      {leagues.map(l => (
        <option key={l.id} value={l.id}>
          {l.name ?? `League ${l.league_id}`}{l.platform === 'sleeper' ? ' (Sleeper)' : ''}
        </option>
      ))}
    </select>
    </div>
  );
}
