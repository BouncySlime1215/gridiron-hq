import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../api';
import { useLeague } from '../state/league';
import { Card, Confidence, PageHeader, Provenance, Section, Skeleton, StatTile } from '../components/ui/DesignSystem';
import { EmptyState, PageError } from '../components/PageState';

interface InboxItem { type: string; priority: 'high' | 'medium' | 'low'; title: string; action: string; link: string; }
interface AccuracyPayload { season: number; players_graded: number; table: { source: string; mae: number; r2: number; spearman: number }[]; distribution?: { coverage_80?: number }; note: string; error?: string; }
interface DecisionRecommendation {
  id: string; leagueId: number | null; sport: string; type: string; subjectIds: (string | number)[];
  title: string; rationale: string | null; expectedValue: number | null; confidence: number | null;
  urgency: 'high' | 'medium' | 'low'; expiresAt: string | null; status: string;
  sourceModel: string; sourceVersion: string | null; link: string | null; createdAt: string;
}
const priorityStyle = { high: 'border-red-200 bg-red-50', medium: 'border-amber-200 bg-amber-50', low: 'border-slate-200 bg-slate-50' };

export default function Home() {
  const draftsApi = useApi<any[]>('/drafts');
  const rankingsApi = useApi<any[]>('/rankings');
  const newsApi = useApi<any[]>('/news');
  const accuracyApi = useApi<AccuracyPayload>('/model/accuracy');
  const { leagues, active: league, error: leagueError, refetch: refetchLeagues } = useLeague();
  const inboxUrl = league ? `/trades/${league.id}/inbox${league.my_team_id ? `?team_id=${league.my_team_id}` : ''}` : null;
  const inboxApi = useApi<{ items: InboxItem[] }>(inboxUrl);
  // Decision Inbox: the persisted, cross-engine recommendation queue (see
  // server/routes/decision-inbox.js). Deliberately fetched unscoped by league
  // — a betting engine's recommendation carries no league_id at all, and this
  // queue is meant to span every engine, not just the active fantasy league.
  const decisionsApi = useApi<DecisionRecommendation[]>('/decision-inbox');
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false), [status, setStatus] = useState<string | null>(null);

  const resolveDecision = async (id: string, resolveStatus: 'actioned' | 'dismissed') => {
    setResolvingIds(prev => new Set(prev).add(id));
    try {
      await api(`/decision-inbox/${id}/resolve`, { method: 'POST', body: JSON.stringify({ status: resolveStatus }) });
      await decisionsApi.refetch();
    } catch { /* the row stays open on failure; the button re-enables so the user can retry */ }
    finally { setResolvingIds(prev => { const next = new Set(prev); next.delete(id); return next; }); }
  };

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
    {sourceError && <div className="mb-4"><PageError message={String(sourceError)} onRetry={() => { draftsApi.refetch(); rankingsApi.refetch(); newsApi.refetch(); refetchLeagues(); }} /></div>}

    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,.7fr)]">
      <div className="space-y-6">
        <Section title="1 · Act now" description="Urgent roster, credential, trade and draft decisions come first.">
          {!league ? <EmptyState title="Connect your first league" description="ESPN and Sleeper context powers every personal recommendation." actionLabel="Connect league" actionTo="/league?view=connections" />
            : inboxApi.loading && !inboxApi.data ? <div className="space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
            : inboxApi.error && !inboxApi.data ? <PageError message={inboxApi.error} onRetry={inboxApi.refetch} />
            : attention.length ? <div className="space-y-2">{attention.map((item, index) => <Link key={`${item.type}:${index}`} to={item.link} className={`block rounded-[10px] border p-4 transition-colors hover:border-slate-400 ${priorityStyle[item.priority]}`}><div className="flex items-center gap-2"><span className="text-[10px] font-extrabold uppercase tracking-wide text-slate-500">{item.priority}</span><span className="font-bold text-slate-900">{item.title}</span></div><p className="mt-1 text-sm text-slate-600">Why: {item.action}</p></Link>)}</div>
            : <EmptyState title="No urgent roster action" description="The current roster, news and trade scans found nothing that clears the action threshold." />}
        </Section>

        <Section title="2 · Decision Inbox" description="Every engine's open recommendations in one ranked queue — lineup, waivers, trades and (soon) betting.">
          {decisionsApi.loading && !decisionsApi.data ? <div className="space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
            : decisionsApi.error && !decisionsApi.data ? <PageError message={decisionsApi.error} onRetry={decisionsApi.refetch} />
            : (decisionsApi.data ?? []).length ? <div className="space-y-2">{(decisionsApi.data ?? []).map(rec => (
                <div key={rec.id} className={`rounded-[10px] border p-4 ${priorityStyle[rec.urgency]}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-extrabold uppercase tracking-wide text-slate-500">{rec.urgency}</span>
                      <span className="font-bold text-slate-900">{rec.title}</span>
                    </div>
                    {rec.expiresAt && <span className="shrink-0 text-[10px] text-slate-400">Expires {new Date(rec.expiresAt).toLocaleString()}</span>}
                  </div>
                  {rec.rationale && <p className="mt-1 text-sm text-slate-600">{rec.rationale}</p>}
                  <div className="mt-2 flex items-center gap-4">
                    {rec.link && <Link to={rec.link} className="text-xs font-bold text-emerald-700 hover:underline">Do this →</Link>}
                    <button className="text-xs font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-50" disabled={resolvingIds.has(rec.id)} onClick={() => resolveDecision(rec.id, 'actioned')}>Mark done</button>
                    <button className="text-xs text-slate-400 hover:text-slate-600 disabled:opacity-50" disabled={resolvingIds.has(rec.id)} onClick={() => resolveDecision(rec.id, 'dismissed')}>Dismiss</button>
                  </div>
                </div>
              ))}</div>
            : <EmptyState title="No open recommendations" description="Once an engine — lineup, waivers, trades or betting — finds something worth acting on, it publishes here automatically. Nothing has cleared the bar yet." />}
        </Section>

        <Section title="3 · What changed" description="Newest information, ranked before general browsing.">
          <Card className="divide-y divide-slate-100 overflow-hidden">
            {changed.length ? changed.map((item: any) => <Link key={item.id} to="/news" className="flex gap-3 p-4 hover:bg-slate-50"><span className="mt-0.5 text-[10px] font-extrabold text-slate-500">{item.team_abbr ?? 'NFL'}</span><div><div className="text-sm font-semibold text-slate-900">{item.headline}</div><div className="mt-1 text-xs text-slate-500">{item.date} · {item.source ?? 'source recorded in News'}</div></div></Link>) : <div className="p-5 text-sm text-slate-500">No new items since the last refresh.</div>}
          </Card>
        </Section>

        <Section title="4 · What to do next" description="Concrete next steps, with the evidence behind each one.">
          <div className="grid gap-3 md:grid-cols-3">
            <Action to={activeDraft ? `/drafts/${activeDraft.id}` : '/draft'} title={activeDraft ? 'Continue draft' : 'Prepare draft'} why={activeDraft ? `${activeDraft.picks_made ?? 0} picks are already recorded.` : 'Your player board and live tracker share one workflow.'} />
            <Action to={league ? '/league' : '/league?view=connections'} title={league ? 'Review roster' : 'Connect league'} why={league ? 'Strength, depth and risk are calculated against this league specifically.' : 'Personal analysis requires a roster source.'} />
            <Action to="/trade-lab" title="Scan trade market" why="The engine separates lineup improvement from market fairness and acceptance likelihood." />
          </div>
        </Section>
      </div>

      <aside className="space-y-4">
        <Section title="5 · Confidence" description="Measured calibration, not a decorative score.">
          <Card className="p-4">
            {accuracyApi.loading && !accuracyApi.data ? <Skeleton className="h-20" />
              : accuracyApi.error && !accuracyApi.data ? <PageError message={accuracyApi.error} onRetry={accuracyApi.refetch} />
              : accuracyApi.data?.error ? <p className="text-sm text-amber-700">{accuracyApi.data.error}</p> : <>
              <Confidence coverage={coverage} sample={accuracyApi.data?.players_graded} />
              <div className="mt-4 grid grid-cols-2 gap-3"><StatTile label="Held-out MAE" value={modelRow ? modelRow.mae.toFixed(1) : '—'} delta="season points" /><StatTile label="Rank correlation" value={modelRow ? modelRow.spearman.toFixed(3) : '—'} delta="Spearman" /></div>
              <p className="mt-3 text-xs leading-5 text-slate-500">{accuracyApi.data?.note}</p>
            </>}
          </Card>
        </Section>
        <Section title="6 · Freshness" description="Each source owns its timestamp.">
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
