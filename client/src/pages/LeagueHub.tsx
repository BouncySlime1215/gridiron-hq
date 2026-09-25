import { Navigate, useSearchParams } from 'react-router-dom';
import Leagues from './Leagues';
import Standings from '../components/Standings';
import { PageHeader, Tabs } from '../components/ui/DesignSystem';
import { useLeague } from '../state/league';
import { PageLoading, PageError } from '../components/PageState';
import { leagueGate } from '../state/leagueGate';
import { legacyLeagueRedirect } from '../navigation';

/**
 * The League area (docs/ui/CONSOLIDATION-MAP.md): Standings (every team's record and points),
 * Roster strength (every roster's needs and surplus) and Your leagues (connect, sync, disconnect),
 * one title, views on `?view=`.
 *
 * UX-11: "My team" used to be an inner tab here (`?view=team`, rendering
 * `MyTeam.tsx` inline). It is now its own top-level route at `/my-team`
 * (see App.tsx and navigation.ts), so an old `?view=team` deep link redirects
 * there instead of rendering it in place — the content did not move, only
 * where it's reached from.
 */
type View = 'standings' | 'rosters' | 'leagues';
const VIEWS: { id: View; label: string }[] = [
  { id: 'standings', label: 'Standings' }, { id: 'rosters', label: 'Roster strength' }, { id: 'leagues', label: 'Your leagues' }
];
// `?view=connections` was linked from several places before any page read it; it meant this.
const viewOf = (v: string | null): View | null => (v === 'connections' ? 'leagues' : VIEWS.some(x => x.id === v) ? v as View : null);

export default function LeagueHub() {
  const [params, setParams] = useSearchParams();
  const { active, leagues, loading, error, refetch } = useLeague();
  const legacyTo = legacyLeagueRedirect(params);
  if (legacyTo) return <Navigate to={legacyTo} replace />;
  const gate = leagueGate({ loading, error, leagues });
  // With nothing connected the only useful view is the connect form.
  const view: View = gate === 'empty' ? 'leagues' : viewOf(params.get('view')) ?? 'standings';
  const setView = (v: View) => setParams(() => (v === 'standings' ? new URLSearchParams() : new URLSearchParams(`view=${v}`)), { replace: true });
  return <div>
    <PageHeader eyebrow="League" title="League"
      description="Standings, every roster's strengths and needs, and the leagues you have connected."
      meta={<><span>{active?.name?.trim() ?? 'No active league'}</span>{active?.fetched_at && <span>Roster updated {new Date(`${active.fetched_at}Z`).toLocaleString()}</span>}</>} />
    {gate === 'loading' ? <PageLoading label="Loading your leagues…" />
      : gate === 'error' ? <PageError message={error ?? 'Could not load your leagues.'} onRetry={refetch} />
      : <>
        {gate !== 'empty' && <div className="mb-5"><Tabs tabs={VIEWS} value={view} onChange={setView} label="League views" /></div>}
        {view === 'standings' ? <Standings /> : <Leagues view={view} />}
      </>}
  </div>;
}
