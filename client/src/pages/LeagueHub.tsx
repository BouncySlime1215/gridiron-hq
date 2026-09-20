import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Leagues from './Leagues';
import MyTeam from './MyTeam';
import { PageHeader } from '../components/ui/DesignSystem';
import { useLeague } from '../state/league';
import { PageLoading, PageError } from '../components/PageState';
import { usePageExplain } from '../components/PageExplainContext';

type View = 'team' | 'connections';
export default function LeagueHub() {
  const [params] = useSearchParams();
  const { active, leagues, loading, error, refetch } = useLeague();
  const [view, setView] = useState<View>(params.get('view') === 'connections' ? 'connections' : 'team');
  // Counts and freshness, never roster contents: the assistant is told what is
  // on screen so it can fetch the right record, not handed the page's payload.
  // `roster_updated` is here because "which league" and "how old is it" are the
  // two questions every answer about this page depends on.
  usePageExplain('league hub', view, {
    active_league: active?.name ?? null,
    leagues_connected: leagues.length,
    roster_updated: active?.fetched_at ?? null,
    state: loading && !leagues.length ? 'loading' : error && !leagues.length ? 'failed' : 'ready'
  }, active?.id != null ? { league_id: active.id } : null);
  return <div>
    <PageHeader eyebrow="Fantasy" title="League Hub" description="One league context for roster, standings, sync health, drafts, trades and projections. Switching in the header updates the whole fantasy product." meta={<><span>{active?.name ?? 'No active league'}</span>{active?.fetched_at && <span>Roster updated {new Date(`${active.fetched_at}Z`).toLocaleString()}</span>}</>} />
    <div role="tablist" aria-label="League Hub views" className="mb-5 flex gap-1 border-b border-slate-200">
      {([['team','My team'],['connections','Connections & league-wide analysis']] as const).map(([id,label]) => <button key={id} role="tab" aria-selected={view === id} onClick={() => setView(id)} className={`border-b-2 px-3 py-2 text-sm font-semibold ${view === id ? 'border-emerald-600 text-emerald-800' : 'border-transparent text-slate-500'}`}>{label}</button>)}
    </div>
    {loading && !leagues.length ? <PageLoading label="Loading your leagues…" />
      : error && !leagues.length ? <PageError message={error} onRetry={refetch} />
      : view === 'team' ? <MyTeam /> : <Leagues />}
  </div>;
}
