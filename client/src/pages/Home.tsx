import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../api';
import { useLeague } from '../state/league';
import { Card, Confidence, ErrorState, PageHeader, Provenance, Section, Skeleton, StatTile } from '../components/ui/DesignSystem';

interface InboxItem { type: string; priority: 'high' | 'medium' | 'low'; title: string; action: string; link: string; }
interface AccuracyPayload { season: number; players_graded: number; table: { source: string; mae: number; r2: number; spearman: number }[]; distribution?: { coverage_80?: number }; note: string; error?: string; }
const priorityStyle = { high: 'border-red-200 bg-red-50', medium: 'border-amber-200 bg-amber-50', low: 'border-slate-200 bg-slate-50' };

export default function Home() {
  const draftsApi = useApi<any[]>('/drafts');
  const rankingsApi = useApi<any[]>('/rankings');
  const newsApi = useApi<any[]>('/news');
  const accuracyApi = useApi<AccuracyPayload>('/model/accuracy');
  const { leagues, active: league, error: leagueError, refetch: refetchLeagues } = useLeague();
  const inboxUrl = league ? `/trades/${league.id}/inbox${league.my_team_id ? `?team_id=${league.my_team_id}` : ''}` : null;
  const inboxApi = useApi<{ items: InboxItem[] }>(inboxUrl);
  const [refreshing, setRefreshing] = useState(false), [status, setStatus] = useState<string | null>(null);

  const refreshAll = async () => {
    setRefreshing(true); setStatus('Refreshing player, league and news sources…');
    try {
      const result = await api('/aggregates/refresh-all', { method: 'POST' });
      if (league) await api(`/leagues/${league.id}/sync`, { method: 'POST' });
      setStatus(`Refresh complete · ${(result.news?.general ?? 0) + (result.news?.teams ?? 0)} new stories.`);
      await Promise.all([newsApi.refetch(), inboxApi.refetch(), refetchLeagues()]);
    } catch (e: any) { setStatus(`Refresh failed: ${e.message}`); }
    finally { setRefreshing(false); }
  };

  const activeDraft = draftsApi.data?.find(d => d.status === 'active');
  const attention = inboxApi.data?.items ?? [];
  const changed = newsApi.data?.slice(0, 4) ?? [];
  const modelRow = accuracyApi.data?.table?.find(x => x.source === 'Gridiron model');
  const coverage = accuracyApi.data?.distribution?.coverage_80 ?? null;
  const sourceError = draftsApi.error || rankingsApi.error || newsApi.error || leagueError;

  return <div>
    <PageHeader eyebrow="Fantasy command center" title="What needs your attention" description={league ? `Prioritized for ${league.name}. Every recommendation links to the place you can act on it.` : 'Connect a league to turn roster, news and market data into a personal action list.'}
      actions={<button className="btn-primary" onClick={refreshAll} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh sources'}</button>}
      meta={<><span>{league?.connection_status === 'connected' ? '● League connected' : '○ League needs attention'}</span><span>{leagues.length} league{leagues.length === 1 ? '' : 's'} available</span></>} />
    {status && <div aria-live="polite" className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">{status}</div>}
    {sourceError && <div className="mb-4"><ErrorState message={String(sourceError)} retry={() => { draftsApi.refetch(); rankingsApi.refetch(); newsApi.refetch(); refetchLeagues(); }} /></div>}

    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,.7fr)]">
      <div className="space-y-6">
        <Section title="1 · Act now" description="Urgent roster, credential, trade and draft decisions come first.">
          {!league ? <Card className="p-5"><div className="font-bold">Connect your first league</div><p className="mt-1 text-sm text-slate-500">ESPN and Sleeper context powers every personal recommendation.</p><Link to="/league?view=connections" className="btn-primary mt-4 inline-block">Connect league</Link></Card>
            : inboxApi.loading && !inboxApi.data ? <div className="space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
            : attention.length ? <div className="space-y-2">{attention.map((item, index) => <Link key={`${item.type}:${index}`} to={item.link} className={`block rounded-[10px] border p-4 transition-colors hover:border-slate-400 ${priorityStyle[item.priority]}`}><div className="flex items-center gap-2"><span className="text-[10px] font-extrabold uppercase tracking-wide text-slate-500">{item.priority}</span><span className="font-bold text-slate-900">{item.title}</span></div><p className="mt-1 text-sm text-slate-600">Why: {item.action}</p></Link>)}</div>
            : <Card className="p-5"><div className="font-bold text-slate-900">No urgent roster action</div><p className="mt-1 text-sm text-slate-500">The current roster, news and trade scans found nothing that clears the action threshold.</p></Card>}
        </Section>

        <Section title="2 · What changed" description="Newest information, ranked before general browsing.">
          <Card className="divide-y divide-slate-100 overflow-hidden">
            {changed.length ? changed.map((item: any) => <Link key={item.id} to="/news" className="flex gap-3 p-4 hover:bg-slate-50"><span className="mt-0.5 text-[10px] font-extrabold text-slate-500">{item.team_abbr ?? 'NFL'}</span><div><div className="text-sm font-semibold text-slate-900">{item.headline}</div><div className="mt-1 text-xs text-slate-500">{item.date} · {item.source ?? 'source recorded in News'}</div></div></Link>) : <div className="p-5 text-sm text-slate-500">No new items since the last refresh.</div>}
          </Card>
        </Section>

        <Section title="3 · What to do next" description="Concrete next steps, with the evidence behind each one.">
          <div className="grid gap-3 md:grid-cols-3">
            <Action to={activeDraft ? `/drafts/${activeDraft.id}` : '/draft'} title={activeDraft ? 'Continue draft' : 'Prepare draft'} why={activeDraft ? `${activeDraft.picks_made ?? 0} picks are already recorded.` : 'Your player board and live tracker share one workflow.'} />
            <Action to={league ? '/league' : '/league?view=connections'} title={league ? 'Review roster' : 'Connect league'} why={league ? 'Strength, depth and risk are calculated against this league specifically.' : 'Personal analysis requires a roster source.'} />
            <Action to="/trade-lab" title="Scan trade market" why="The engine separates lineup improvement from market fairness and acceptance likelihood." />
          </div>
        </Section>
      </div>

      <aside className="space-y-4">
        <Section title="4 · Confidence" description="Measured calibration, not a decorative score.">
          <Card className="p-4">
            {accuracyApi.loading && !accuracyApi.data ? <Skeleton className="h-20" /> : accuracyApi.data?.error ? <p className="text-sm text-amber-700">{accuracyApi.data.error}</p> : <>
              <Confidence coverage={coverage} sample={accuracyApi.data?.players_graded} />
              <div className="mt-4 grid grid-cols-2 gap-3"><StatTile label="Held-out MAE" value={modelRow ? modelRow.mae.toFixed(1) : '—'} delta="season points" /><StatTile label="Rank correlation" value={modelRow ? modelRow.spearman.toFixed(3) : '—'} delta="Spearman" /></div>
              <p className="mt-3 text-xs leading-5 text-slate-500">{accuracyApi.data?.note}</p>
            </>}
          </Card>
        </Section>
        <Section title="5 · Freshness" description="Each source owns its timestamp.">
          <Card className="space-y-3 p-4">
            <Fresh label="League roster" value={league?.fetched_at} missing="Never synced" />
            <Fresh label="News" value={changed[0]?.created_at ?? changed[0]?.date} missing="No stories" />
            <Fresh label="Model holdout" value={accuracyApi.data?.season ? `Season ${accuracyApi.data.season}` : null} missing="Not graded" plain />
            <Provenance source="Gridiron local SQLite + ESPN/Sleeper + nflverse" updatedAt={league?.fetched_at} version="Evidence contracts and cutoffs are recorded in Model Lab">Background refresh keeps the prior value visible and cannot overwrite a newer league selection.</Provenance>
          </Card>
        </Section>
      </aside>
    </div>
  </div>;
}

function Action({ to, title, why }: { to: string; title: string; why: string }) { return <Link to={to} className="card block p-4 hover:border-emerald-300"><div className="font-bold text-slate-900">{title} →</div><p className="mt-2 text-xs leading-5 text-slate-500">Why: {why}</p></Link>; }
function Fresh({ label, value, missing, plain = false }: { label: string; value?: string | null; missing: string; plain?: boolean }) { return <div className="flex items-center justify-between gap-3 text-xs"><span className="font-semibold text-slate-600">{label}</span><span className="text-right text-slate-400">{value ? plain ? value : new Date(`${value}${value.includes('T') ? '' : 'Z'}`).toLocaleString() : missing}</span></div>; }
