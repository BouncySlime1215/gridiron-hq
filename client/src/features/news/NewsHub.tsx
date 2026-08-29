import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { useNewsFeed, type NewsDeskStats } from './useNewsFeed';

export interface NewsEntity { id: string | number; name: string }
export interface NewsStory {
  id: string | number; headline: string; summary?: string | null; source: string; source_url: string;
  source_type: string; published_at: string; canonical_url: string; fantasy_impact?: string;
  confidence?: number | null; reliability?: { tier?: string; score?: number | null };
  entities?: { players?: NewsEntity[]; teams?: NewsEntity[] }; projection_change?: { before: number; after: number } | null;
  injury_entities?: NewsEntity[]; transaction_type?: string | null; ingested_at?: string | null;
  // Claude's read of the story, if any — never a reporting source. Must always
  // render as a visibly distinct, separately labeled block from the byline/source
  // line above, so it can never be mistaken for sourced reporting.
  ai_analysis?: string | null;
  age_minutes?: number | null; priority_score?: number; priority_reasons?: string[]; my_player?: boolean;
}

const tabs = ['Priority', 'My Players', 'Injuries', 'Transactions', 'Official Sources', 'AI Analysis'] as const;

export default function NewsHub({ stories, stats, loading = false, refreshing = false, error = null, refreshedAt,
  myPlayerNames = [], onRefresh }: {
  stories: NewsStory[]; stats?: NewsDeskStats | null; loading?: boolean; refreshing?: boolean;
  error?: string | null; refreshedAt?: string | null; myPlayerNames?: string[]; onRefresh?: () => void | Promise<void>;
}) {
  const [tab, setTab] = useState<(typeof tabs)[number]>('Priority');
  const [query, setQuery] = useState('');
  const myPlayers = useMemo(() => new Set(myPlayerNames.map(name => name.toLowerCase())), [myPlayerNames]);
  const visible = useMemo(() => stories.filter(story => {
    if (tab === 'Official Sources' && story.source_type !== 'official') return false;
    if (tab === 'Injuries' && !(story.injury_entities?.length)) return false;
    if (tab === 'Transactions' && !story.transaction_type) return false;
    if (tab === 'AI Analysis' && !story.ai_analysis) return false;
    if (tab === 'My Players' && !story.entities?.players?.some(p => myPlayers.has(p.name.toLowerCase()))) return false;
    const haystack = `${story.headline} ${story.summary ?? ''} ${story.source}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  }), [stories, tab, query, myPlayers]);

  return <section aria-labelledby="news-title">
    <header className="mb-4 rounded-[24px] border border-sky-100 bg-[#fafdff] p-6 shadow-[0_12px_36px_rgba(70,120,150,.06)]">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1"><div className="text-xs font-semibold tracking-wide text-slate-500">NFL intelligence</div><h1 id="news-title" className="mt-1 text-3xl font-black tracking-tight">News Command Center</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Roster-first reporting, typed injury and role claims, and source-grounded AI interpretation. Reporting stays separate from analysis, and fresh stories are ranked before the archive.</p></div>
        <button className="btn-primary text-sm" onClick={onRefresh} disabled={refreshing}>{refreshing ? 'Refreshing intelligence…' : 'Refresh intelligence'}</button>
      </div>
      {stats && <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <DeskMetric label="Fresh 24h" value={String(stats.fresh_24h ?? 0)} />
        <DeskMetric label="Your roster" value={`${stats.roster_players ?? 0} players`} />
        <DeskMetric label="Typed claims" value={String(stats.signals?.signals ?? 0)} tone={(stats.signals?.recent_material_untyped ?? 0) ? 'warn' : 'good'} />
        <DeskMetric label="Sources" value={String(stats.sources ?? 0)} />
        <DeskMetric label="Last ingest" value={ageLabel(stats.latest_ingest_age_minutes)} tone={(stats.latest_ingest_age_minutes ?? 999) <= 30 ? 'good' : 'warn'} />
      </div>}
    </header>
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2" role="tablist" aria-label="News feeds">
      {tabs.map(value => <button key={value} role="tab" aria-selected={tab === value}
        className={`rounded-lg px-3 py-2 text-sm font-bold ${tab === value ? 'bg-white text-sky-900 shadow-sm ring-1 ring-sky-200' : 'text-slate-500 hover:bg-white'}`} onClick={() => setTab(value)}>{value}</button>)}
      <label className="ml-auto text-xs text-slate-600">Search
        <input aria-label="Search news" className="input ml-2" value={query} onChange={event => setQuery(event.target.value)} /></label>
    </div>
    {refreshedAt && <p className="mb-3 text-xs text-slate-500">Showing the top {stats?.returned ?? stories.length} of {stats?.stories?.toLocaleString() ?? stories.length} ranked stories · data refreshed {new Date(refreshedAt).toLocaleString()}</p>}
    {loading && <div className="card p-6 text-sm text-slate-500" role="status">Loading attributed reporting…</div>}
    {error && <div className="card border-rose-200 p-6 text-sm text-rose-700" role="alert">News is degraded: {error}</div>}
    {!loading && !error && visible.length === 0 && <div className="card p-6 text-sm text-slate-500">No attributed stories match this view.</div>}
    <div className="space-y-3">
      {visible.map(story => <article key={story.id} className={`card p-4 ${story.my_player ? 'border-emerald-200 ring-1 ring-emerald-100' : ''}`}>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          {story.my_player && <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-black text-emerald-800">MY ROSTER</span>}
          <span className="font-semibold text-slate-700">{story.source}</span>
          <span>· {story.age_minutes == null ? new Date(story.published_at).toLocaleString() : ageLabel(story.age_minutes)}</span>
          {story.reliability?.tier && <span className="rounded bg-slate-100 px-2 py-0.5">{story.reliability.tier}</span>}</div>
        <h2 className="mt-1 font-semibold"><a href={story.source_url} target="_blank" rel="noreferrer" className="hover:underline">{story.headline}</a></h2>
        {story.summary && <p className="mt-2 text-sm text-slate-600">{story.summary}</p>}
        {story.ai_analysis && (
          <div className="mt-2 rounded border border-indigo-200 bg-indigo-50 px-2 py-1.5">
            <span className="rounded-full bg-indigo-600 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-white">
              AI analysis — not a source
            </span>
            <p className="mt-1 text-xs text-indigo-900">{story.ai_analysis}</p>
          </div>
        )}
        {story.projection_change && <p className="mt-2 text-xs font-semibold text-amber-700">Projection: {story.projection_change.before.toFixed(1)} → {story.projection_change.after.toFixed(1)}</p>}
        {!!story.priority_reasons?.length && <div className="mt-2 flex flex-wrap gap-1">{story.priority_reasons.map(reason => <span key={reason} className="rounded bg-slate-50 px-2 py-1 text-[10px] text-slate-500 ring-1 ring-slate-200">{reason}</span>)}</div>}
        <div className="mt-2 flex flex-wrap gap-2 text-xs">{story.entities?.players?.map(player => <Link key={player.id} to={`/players/${player.id}`} className="text-emerald-700 hover:underline">{player.name}</Link>)}</div>
      </article>)}
    </div>
  </section>;
}

/** Real ingested data — server/news/ingest.js's RSS pipeline through normalize.js, not fixtures. */
export function ConnectedNewsHub() {
  const { stories, stats, loading, refreshing, error, refreshedAt, myPlayerNames, refetch } = useNewsFeed();
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refresh = async () => {
    setRefreshError(null);
    try { await api('/news/ingest', { method: 'POST' }); await refetch(); }
    catch (error: any) { setRefreshError(error.message); }
  };
  return <><NewsHub stories={stories} stats={stats} loading={loading} refreshing={refreshing} error={error}
    refreshedAt={refreshedAt} myPlayerNames={myPlayerNames} onRefresh={refresh} />
    {refreshError && <div className="mt-3 rounded-xl border border-rose-200 bg-white p-3 text-sm text-rose-700">Refresh failed: {refreshError}</div>}</>;
}

const ageLabel = (minutes: number | null | undefined) => minutes == null ? 'unknown'
  : minutes < 2 ? 'just now' : minutes < 60 ? `${Math.round(minutes)}m ago`
    : minutes < 1440 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`;

function DeskMetric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' }) {
  return <div className="rounded-xl border border-slate-200 bg-white px-3 py-2"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div><div className={`mt-0.5 text-sm font-black ${tone === 'good' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : 'text-slate-900'}`}>{value}</div></div>;
}
