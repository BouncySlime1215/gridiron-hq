import { Navigate, useSearchParams } from 'react-router-dom';
import Leagues from './Leagues';
import { PageHeader } from '../components/ui/DesignSystem';
import { useLeague } from '../state/league';
import { PageLoading, PageError } from '../components/PageState';
import { leagueGate } from '../state/leagueGate';
import { legacyLeagueRedirect } from '../navigation';

/**
 * UX-11: "My team" used to be an inner tab here (`?view=team`, rendering
 * `MyTeam.tsx` inline). It is now its own top-level route at `/my-team`
 * (see App.tsx and navigation.ts), so an old `?view=team` deep link redirects
 * there instead of rendering it in place — the content did not move, only
 * where it's reached from.
 */
export default function LeagueHub() {
  const [params] = useSearchParams();
  const { active, leagues, loading, error, refetch } = useLeague();
  const legacyTo = legacyLeagueRedirect(params);
  if (legacyTo) return <Navigate to={legacyTo} replace />;
  const gate = leagueGate({ loading, error, leagues });
  return <div>
    <PageHeader eyebrow="League" title="League" description="Your leagues, their sync health, and every roster's strengths and needs. This week's actions across every league are on Today." meta={<><span>{active?.name ?? 'No active league'}</span>{active?.fetched_at && <span>Roster updated {new Date(`${active.fetched_at}Z`).toLocaleString()}</span>}</>} />
    {gate === 'loading' ? <PageLoading label="Loading your leagues…" />
      : gate === 'error' ? <PageError message={error ?? 'Could not load your leagues.'} onRetry={refetch} />
      : <Leagues />}
  </div>;
}
