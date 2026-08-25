import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useNewsFeed } from './useNewsFeed';

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
}

const tabs = ['For You', 'My Players', 'Injuries', 'Transactions', 'Official Sources', 'Analysis'] as const;

export default function NewsHub({ stories, loading = false, error = null, refreshedAt, myPlayerNames = [] }: {
  stories: NewsStory[]; loading?: boolean; error?: string | null; refreshedAt?: string | null; myPlayerNames?: string[];
}) {
  const [tab, setTab] = useState<(typeof tabs)[number]>('For You');
  const [query, setQuery] = useState('');
  const myPlayers = useMemo(() => new Set(myPlayerNames.map(name => name.toLowerCase())), [myPlayerNames]);
  const visible = useMemo(() => stories.filter(story => {
    if (tab === 'Official Sources' && story.source_type !== 'official') return false;
    if (tab === 'Injuries' && !(story.injury_entities?.length)) return false;
    if (tab === 'Transactions' && !story.transaction_type) return false;
    if (tab === 'Analysis' && !story.ai_analysis) return false;
    if (tab === 'My Players' && !story.entities?.players?.some(p => myPlayers.has(p.name.toLowerCase()))) return false;
    const haystack = `${story.headline} ${story.summary ?? ''} ${story.source}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  }), [stories, tab, query, myPlayers]);

  return <section aria-labelledby="news-title">
    <header className="mb-4 flex flex-wrap items-end gap-3">
      <div><h1 id="news-title" className="text-2xl font-bold">Football Intelligence</h1>
        <p className="text-xs text-slate-500">Every summary links to its reporting source.</p></div>
      <label className="ml-auto text-xs text-slate-600">Search news
        <input className="input ml-2" value={query} onChange={event => setQuery(event.target.value)} /></label>
    </header>
    <div className="mb-3 flex gap-2 overflow-x-auto" role="tablist" aria-label="News feeds">
      {tabs.map(value => <button key={value} role="tab" aria-selected={tab === value}
        className={tab === value ? 'btn-primary whitespace-nowrap' : 'btn-ghost whitespace-nowrap'} onClick={() => setTab(value)}>{value}</button>)}
    </div>
    {refreshedAt && <p className="mb-3 text-xs text-slate-500">Data refreshed {new Date(refreshedAt).toLocaleString()}</p>}
    {loading && <div className="card p-6 text-sm text-slate-500" role="status">Loading attributed reporting…</div>}
    {error && <div className="card border-rose-200 p-6 text-sm text-rose-700" role="alert">News is degraded: {error}</div>}
    {!loading && !error && visible.length === 0 && <div className="card p-6 text-sm text-slate-500">No attributed stories match this view.</div>}
    <div className="space-y-3">
      {visible.map(story => <article key={story.id} className="card p-4">
        <div className="flex flex-wrap gap-2 text-xs text-slate-500"><span>{story.source}</span>
          <span>· {new Date(story.published_at).toLocaleString()}</span>
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
        <div className="mt-2 flex flex-wrap gap-2 text-xs">{story.entities?.players?.map(player => <Link key={player.id} to={`/players/${player.id}`} className="text-emerald-700 hover:underline">{player.name}</Link>)}</div>
      </article>)}
    </div>
  </section>;
}

/** Real ingested data — server/news/ingest.js's RSS pipeline through normalize.js, not fixtures. */
export function ConnectedNewsHub() {
  const { stories, loading, error, refreshedAt, myPlayerNames } = useNewsFeed();
  return <NewsHub stories={stories} loading={loading} error={error} refreshedAt={refreshedAt} myPlayerNames={myPlayerNames} />;
}

