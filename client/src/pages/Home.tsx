import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../api';
import { useLeague } from '../state/league';

export default function Home() {
  const { data: drafts } = useApi<any[]>('/drafts');
  const { data: sets } = useApi<any[]>('/rankings');
  const { data: news, refetch: refetchNews } = useApi<any[]>('/news');
  const { leagues, active: activeLeague } = useLeague();
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const refreshAll = async () => {
    setRefreshing(true); setStatus('Pulling ESPN player database + all 32 team news feeds…');
    try {
      const r = await api('/aggregates/refresh-all', { method: 'POST' });
      const newStories = (r.news?.general ?? 0) + (r.news?.teams ?? 0);
      setStatus(`Data refreshed (${newStories} new stories). Asking AI: did any news change team outlooks…`);
      try {
        const a = await api('/analysis/refresh', { method: 'POST', body: JSON.stringify({}) });
        const changed = (a.refreshed ?? []).filter((t: any) => t.changed);
        setStatus(`Done. ${newStories} new stories · outlooks re-checked for ${a.refreshed?.length ?? 0} teams, ${changed.length} updated${changed.length ? ': ' + changed.map((t: any) => t.abbr).join(', ') : ''}.`);
      } catch (e: any) {
        setStatus(`Data refreshed (${newStories} new stories). AI outlook pass skipped: ${e.message}`);
      }
      refetchNews();
    } catch (e: any) { setStatus(`Refresh failed: ${e.message}`); }
    finally { setRefreshing(false); }
  };

  const active = drafts?.find(d => d.status === 'active');
  const latestNews = news?.slice(0, 5) ?? [];

  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <h1 className="text-3xl font-semibold tracking-[-0.035em]">Dashboard</h1>
        <button className="btn-primary ml-auto" onClick={refreshAll} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh everything'}
        </button>
      </div>
      <p className="text-sm text-slate-600 mb-2">Training camp, July 2026 — draft season is here.</p>
      {status && <p className="text-xs text-amber-600 mb-4">{status}</p>}
      {!status && <div className="mb-4" />}

      <div className="grid md:grid-cols-3 gap-4 mb-6">
        <Link to={active ? `/drafts/${active.id}` : '/drafts'} className="card p-5 hover:border-slate-400 transition-colors">
          <div className="mb-5 text-xs font-semibold text-slate-400">01</div>
          <div className="text-lg font-semibold tracking-tight">{active ? `Continue: ${active.name}` : 'Start a draft'}</div>
          <div className="text-xs text-slate-500 mt-1">
            {active ? `${active.picks_made} picks made` : 'Mock it or track your live draft'}
          </div>
        </Link>
        <Link to="/rankings" className="card p-5 hover:border-slate-400 transition-colors">
          <div className="mb-5 text-xs font-semibold text-slate-400">02</div>
          <div className="text-lg font-semibold tracking-tight">My Rankings</div>
          <div className="text-xs text-slate-500 mt-1">
            {sets?.length ?? 0} board{sets?.length === 1 ? '' : 's'} · seeded with July consensus top 100
          </div>
        </Link>
        <Link to={leagues.length ? '/my-team' : '/leagues'} className="card p-5 hover:border-slate-400 transition-colors">
          <div className="mb-5 text-xs font-semibold text-slate-400">03</div>
          <div className="text-lg font-semibold tracking-tight">{leagues.length ? 'My Team' : 'Connect a league'}</div>
          <div className="text-xs text-slate-500 mt-1">
            {leagues.length
              ? `${activeLeague?.name ?? 'League'}${leagues.length > 1 ? ` +${leagues.length - 1} more` : ''}`
              : 'Link ESPN or Sleeper for rosters & scores'}
          </div>
        </Link>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-sm text-slate-700">Latest Camp News</h2>
            <Link to="/news" className="text-xs text-emerald-600 hover:underline">all news →</Link>
          </div>
          {latestNews.length === 0 ? (
            <p className="text-xs text-slate-500">No stories yet. Add camp news (or paste headlines for AI analysis) on the News page.</p>
          ) : latestNews.map((n: any) => (
            <div key={n.id} className="py-2 border-b border-slate-200/60 last:border-0">
              <div className="flex items-center gap-2 text-xs">
                {n.team_abbr && <span className="font-black px-1.5 py-0.5 rounded text-white text-[10px]" style={{ background: n.primary_color }}>{n.team_abbr}</span>}
                <span className="text-slate-500">{n.date}</span>
                {n.importance === 3 && <span className="text-rose-600 font-bold text-[10px]">MAJOR</span>}
              </div>
              <div className="text-sm mt-0.5">{n.headline}</div>
            </div>
          ))}
        </div>
        <div className="card p-4">
          <h2 className="font-bold text-sm text-slate-700 mb-3">Deep Dives</h2>
          <p className="text-xs text-slate-500 mb-3">Scheme &amp; coaching turnover this offseason — 10 new head coaches. Start with the teams that changed the most:</p>
          <div className="grid grid-cols-2 gap-2">
            {[['NYG', 'Harbaugh era begins'], ['PIT', 'McCarthy + Rodgers'], ['CLE', 'Monken air raid'], ['LV', 'Kubiak + Mendoza'],
              ['ATL', 'Stefanski + Tua/Penix'], ['TEN', 'Saleh rebuild']].map(([abbr, note]) => (
              <Link key={abbr} to={`/teams/${abbr}`} className="rounded-lg border border-slate-200 hover:border-slate-500 p-2 text-xs">
                <span className="font-bold text-slate-800">{abbr}</span>
                <span className="text-slate-500 block">{note}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
