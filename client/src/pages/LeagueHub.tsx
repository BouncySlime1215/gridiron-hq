import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Leagues from './Leagues';
import MyTeam from './MyTeam';
import { PageHeader } from '../components/ui/DesignSystem';
import { useLeague } from '../state/league';

type View = 'team' | 'connections';
export default function LeagueHub() {
  const [params] = useSearchParams();
  const { active } = useLeague();
  const [view, setView] = useState<View>(params.get('view') === 'connections' ? 'connections' : 'team');
  return <div>
    <PageHeader eyebrow="Fantasy" title="League Hub" description="One league context for roster, standings, sync health, drafts, trades and projections. Switching in the header updates the whole fantasy product." meta={<><span>{active?.name ?? 'No active league'}</span>{active?.fetched_at && <span>Roster updated {new Date(`${active.fetched_at}Z`).toLocaleString()}</span>}</>} />
    <div role="tablist" aria-label="League Hub views" className="mb-5 flex gap-1 border-b border-slate-200">
      {([['team','My team'],['connections','Connections & league-wide analysis']] as const).map(([id,label]) => <button key={id} role="tab" aria-selected={view === id} onClick={() => setView(id)} className={`border-b-2 px-3 py-2 text-sm font-semibold ${view === id ? 'border-emerald-600 text-emerald-800' : 'border-transparent text-slate-500'}`}>{label}</button>)}
    </div>
    {view === 'team' ? <MyTeam /> : <Leagues />}
  </div>;
}
