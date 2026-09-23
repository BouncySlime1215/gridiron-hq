import { Navigate, useSearchParams } from 'react-router-dom';
import Leagues from './Leagues';
import { PageHeader } from '../components/ui/DesignSystem';
import { useLeague } from '../state/league';
import { PageLoading, PageError } from '../components/PageState';

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
  if (params.get('view') === 'team') return <Navigate to="/my-team" replace />;
  return <div>
    <PageHeader eyebrow="Fantasy" title="League Hub" description="One league context for roster, standings, sync health, drafts, trades and projections. Switching in the header updates the whole fantasy product." meta={<><span>{active?.name ?? 'No active league'}</span>{active?.fetched_at && <span>Roster updated {new Date(`${active.fetched_at}Z`).toLocaleString()}</span>}</>} />
    {loading && !leagues.length ? <PageLoading label="Loading your leagues…" />
      : error && !leagues.length ? <PageError message={error} onRetry={refetch} />
      : <Leagues />}
  </div>;
}
