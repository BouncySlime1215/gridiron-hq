import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../api';
import { ConnectedNewsHub } from '../features/news/NewsHub';

const today = () => new Date().toISOString().slice(0, 10);

const SIGNAL_LABEL: Record<string, string> = {
  out_for_season: 'Out for season', out: 'Out', doubtful: 'Doubtful', questionable: 'Questionable',
  did_not_practice: 'Did not practice', limited: 'Limited practice', available_positive: 'Cleared',
  starter_confirmed: 'Starter confirmed', role_down: 'Role decreasing', role_up: 'Role increasing',
  role_limited: 'Role limited'
};
const SIGNAL_TONE: Record<string, string> = {
  out_for_season: 'border-rose-500 bg-rose-50', out: 'border-rose-400 bg-rose-50',
  doubtful: 'border-rose-300 bg-rose-50/60', questionable: 'border-amber-400 bg-amber-50',
  did_not_practice: 'border-amber-400 bg-amber-50', limited: 'border-amber-300 bg-amber-50/60',
  available_positive: 'border-emerald-400 bg-emerald-50', starter_confirmed: 'border-emerald-400 bg-emerald-50',
  role_up: 'border-emerald-400 bg-emerald-50', role_down: 'border-rose-400 bg-rose-50',
  role_limited: 'border-amber-300 bg-amber-50/60'
};

/**
 * The typed claim feed — every card here traces to a verbatim quote and a
 * fixed status enum, not freshly-generated prose. This is what actually
 * distinguishes it from the Camp Log's per-story AI blurb: you can check the
 * evidence span against the source yourself.
 */
function TwitterStatus() {
  const { data } = useApi<any>('/news/twitter-status');
  if (!data?.configured) return null;
  const s = data.spend, lc = data.line_correlation;
  return (
    <div className="card p-3 mb-4 text-[11px] text-slate-500 flex flex-wrap gap-x-5 gap-y-1 items-center">
      <span className="font-bold text-slate-600">Twitter ingestion (twitterapi.io):</span>
      <span>${s.spent_usd.toFixed(3)} spent of ${s.budget_usd} budget</span>
      <span className={s.blocked ? 'text-rose-600 font-bold' : 'text-slate-500'}>
        {s.blocked ? 'CAP REACHED — ingestion paused' : `$${s.remaining_usd.toFixed(2)} remaining`}
      </span>
      <span>· {s.calls} calls</span>
      {lc && (
        <span className="ml-auto">
          Tweet→line: {lc.resolved} resolved{lc.resolved > 0 && `, ${lc.moved} moved`}
          {!lc.sample_sufficient && <span className="text-amber-600"> (accumulating, not yet meaningful)</span>}
        </span>
      )}
    </div>
  );
}

function SignalFeed() {
  const [team, setTeam] = useState('');
  const { data, refetch } = useApi<any>(`/news/signals${team ? `?team=${team}` : ''}`);
  const { data: teams } = useApi<any[]>('/teams');

  return (
    <div>
      <TwitterStatus />
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Signal Feed</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Typed availability and role claims, extracted with a verbatim quote from the source story.
            {data?.scope === 'my_roster' && <> Scoped to your {data.roster_size} rostered players.</>}
          </p>
        </div>
        <select className="input ml-auto" value={team} onChange={e => setTeam(e.target.value)}>
          <option value="">{data?.scope === 'my_roster' ? 'My roster (default)' : 'All teams'}</option>
          {teams?.map(t => <option key={t.abbr} value={t.abbr}>{t.abbr} — {t.name}</option>)}
        </select>
        <button className="btn-ghost text-xs" onClick={() => refetch()}>Refresh</button>
      </div>

      {data?.coverage && (
        <div className="flex gap-4 text-xs text-slate-500 mb-4 flex-wrap">
          <span><strong className="text-slate-700">{data.coverage.signals ?? 0}</strong> typed claims</span>
          <span><strong className="text-slate-700">{data.coverage.stories ?? 0}</strong> stories covered</span>
          <span><strong className="text-slate-700">{data.coverage.players ?? 0}</strong> players tracked</span>
          {data.coverage.recent_material_untyped > 0 && (
            <span className="text-amber-600">{data.coverage.recent_material_untyped} recent stories look material but haven't been typed yet</span>
          )}
        </div>
      )}

      {data?.signals?.length === 0 && (
        <div className="card p-8 text-center text-sm text-slate-500">
          No typed claims {data.scope === 'my_roster' ? 'for your roster' : 'for this team'} in the last 14 days.
          The extractor runs hourly against ingested news — pull news on the Camp Log tab first if the archive is empty.
        </div>
      )}

      <div className="space-y-2">
        {data?.signals?.map((s: any, i: number) => (
          <div key={i} className={`card p-4 border-l-4 ${SIGNAL_TONE[s.status] ?? 'border-slate-300'}`}>
            <div className="flex items-center gap-2 text-xs mb-1.5 flex-wrap">
              <span className="font-bold text-slate-800">{s.player_name}</span>
              {s.team && <span className="text-slate-400">· {s.team}</span>}
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-white/60 border border-current">
                {SIGNAL_LABEL[s.status] ?? s.status}
              </span>
              {s.body_part && <span className="text-slate-500">{s.body_part}</span>}
              <span className="text-slate-400 ml-auto">{Math.round(s.confidence * 100)}% confidence</span>
              <span className="text-slate-400">{s.published_at?.slice(0, 10)}</span>
            </div>
            <blockquote className="text-sm text-slate-700 italic border-l-2 border-slate-200 pl-2">
              "{s.evidence_span}"
            </blockquote>
            <div className="text-[11px] text-slate-400 mt-1.5">
              {s.source}{s.story_url && <> · <a href={s.story_url} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">source</a></>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function News() {
  const [view, setView] = useState<'log' | 'feed' | 'signals'>('feed');
  const [date, setDate] = useState<string>('');
  const [teamFilter, setTeamFilter] = useState('');
  const { data: dates, refetch: refetchDates } = useApi<string[]>('/news/dates');
  const { data: teams } = useApi<any[]>('/teams');
  const query = `/news?${date ? `date=${date}&` : ''}${teamFilter ? `team=${teamFilter}&` : ''}limit=160`;
  const { data: items, refetch } = useApi<any[]>(query);

  const [showAdd, setShowAdd] = useState(false);
  const [aiText, setAiText] = useState('');
  const [aiTeam, setAiTeam] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [manual, setManual] = useState({ team_abbr: '', headline: '', body: '', importance: 2 });
  const [pulling, setPulling] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [ingestErr, setIngestErr] = useState<string | null>(null);
  const [roundup, setRoundup] = useState<any>(null);
  const [roundupBusy, setRoundupBusy] = useState(false);
  const [roundupErr, setRoundupErr] = useState<string | null>(null);
  const [explaining, setExplaining] = useState<number | null>(null);
  const [explainErr, setExplainErr] = useState<string | null>(null);

  const refresh = () => { refetch(); refetchDates(); };

  const pullNews = async () => {
    setPulling(true);
    try {
      await api(`/espn/sync-news${teamFilter ? `?team=${teamFilter}` : ''}`, { method: 'POST' });
      refresh();
    } catch (e: any) { setRoundupErr(e.message); }
    finally { setPulling(false); }
  };

  // Real RSS ingestion — server/news/ingest.js's attributed, deduped, provenance-tracked
  // pipeline (migration 010), distinct from the ESPN JSON pull above.
  const ingestRss = async () => {
    setIngesting(true); setIngestErr(null);
    try { await api('/news/ingest', { method: 'POST' }); refresh(); }
    catch (e: any) { setIngestErr(e.message); }
    finally { setIngesting(false); }
  };

  const roundupNow = async () => {
    setRoundupBusy(true); setRoundupErr(null);
    try {
      setRoundup(await api('/news/roundup', { method: 'POST', body: JSON.stringify({ date: date || undefined }) }));
    } catch (e: any) { setRoundupErr(e.message); }
    finally { setRoundupBusy(false); }
  };

  const explain = async (id: number) => {
    setExplaining(id); setExplainErr(null);
    try { await api(`/news/${id}/explain`, { method: 'POST' }); refresh(); }
    catch (e: any) { setExplainErr(e.message); }
    finally { setExplaining(null); }
  };

  const analyze = async () => {
    const lines = aiText.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    setAiBusy(true); setAiMsg(null);
    try {
      const items = lines.map(l => {
        const m = l.match(/^\[?([A-Z]{2,3})\]?[:\s-]+(.+)$/);
        return m ? { team_abbr: m[1], headline: m[2] } : { team_abbr: aiTeam || 'FA', headline: l };
      });
      const r = await api('/news/analyze', { method: 'POST', body: JSON.stringify({ date: today(), items }) });
      setAiMsg(`Analyzed ${r.count} stories.`);
      setAiText('');
      refresh();
    } catch (e: any) {
      setAiMsg(e.message);
    } finally { setAiBusy(false); }
  };

  const addManual = async () => {
    if (!manual.headline) return;
    await api('/news', { method: 'POST', body: JSON.stringify({ ...manual, date: today() }) });
    setManual({ team_abbr: '', headline: '', body: '', importance: 2 });
    refresh();
  };

  return (
    <div>
      <div className="mb-3 flex gap-1 border-b border-slate-200" role="tablist" aria-label="News view">
        <button role="tab" aria-selected={view === 'log'}
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${view === 'log' ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          onClick={() => setView('log')}>Archive & Tools</button>
        <button role="tab" aria-selected={view === 'feed'}
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${view === 'feed' ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          onClick={() => setView('feed')}>Intelligence Desk</button>
        <button role="tab" aria-selected={view === 'signals'}
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${view === 'signals' ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          onClick={() => setView('signals')} title="Typed, evidence-quoted claims — not freshly-generated prose">Typed Signals</button>
      </div>
      {view === 'feed' ? <ConnectedNewsHub /> : view === 'signals' ? <SignalFeed /> : <>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div><h1 className="text-2xl font-bold">News archive and tools</h1><p className="mt-0.5 text-xs text-slate-500">Manual research, source pulls and historical stories. The ranked live desk is the default view.</p></div>
        <select className="input" value={date} onChange={e => setDate(e.target.value)}>
          <option value="">All days</option>
          {dates?.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select className="input" value={teamFilter} onChange={e => setTeamFilter(e.target.value)}>
          <option value="">All teams</option>
          {teams?.map(t => <option key={t.abbr} value={t.abbr}>{t.abbr} — {t.name}</option>)}
        </select>
        <button className="btn-ghost ml-auto" onClick={pullNews} disabled={pulling} title="ESPN's team/league news API — team-scoped">
          {pulling ? 'Pulling…' : 'Pull ESPN news'}
        </button>
        <button className="btn-ghost" onClick={ingestRss} disabled={ingesting}
          title="Attributed RSS pipeline with provenance, dedup, and entity extraction (server/news/ingest.js)">
          {ingesting ? 'Ingesting…' : 'Pull RSS (attributed)'}
        </button>
        <button className="btn-primary" onClick={roundupNow} disabled={roundupBusy}>
          {roundupBusy ? 'Reading the day…' : 'Camp roundup'}
        </button>
        <button className="btn-ghost" onClick={() => setShowAdd(v => !v)}>{showAdd ? 'Close' : '+ Add'}</button>
      </div>

      {roundupErr && <p className="text-sm text-rose-600 mb-3">{roundupErr}</p>}
      {ingestErr && <p className="text-sm text-rose-600 mb-3">{ingestErr}</p>}
      {roundup && (
        <div className="card p-5 mb-6 border-emerald-200 bg-emerald-50/30">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="font-bold text-slate-800">Camp Roundup</h2>
            <button className="text-xs text-slate-400 hover:text-slate-700 ml-auto" onClick={() => setRoundup(null)}>dismiss</button>
          </div>
          <p className="text-sm text-slate-700 leading-relaxed">{roundup.summary}</p>
          {roundup.battles?.length > 0 && (
            <div className="mt-4">
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Camp battles to watch</h3>
              <div className="grid sm:grid-cols-2 gap-2">
                {roundup.battles.map((b: any, i: number) => (
                  <div key={i} className="bg-white rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-black text-slate-700">{b.team}</span>
                      <span className="text-xs font-semibold text-slate-800">{b.battle}</span>
                    </div>
                    <p className="text-xs text-slate-600 mt-1">{b.status}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {roundup.teams_affected?.length > 0 && (
            <div className="mt-3">
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">Most affected</h3>
              <ul className="text-xs text-slate-600 space-y-0.5">
                {roundup.teams_affected.map((t: any, i: number) => (
                  <li key={i}><Link to={`/teams/${t.team}`} className="font-bold text-slate-800 hover:text-emerald-700">{t.team}</Link> — {t.why}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {showAdd && (
        <div className="grid md:grid-cols-2 gap-4 mb-6">
          <div className="card p-4">
            <h3 className="text-sm font-bold text-slate-700 mb-2">✨ AI Analysis <span className="text-slate-500 font-normal">(paste headlines, one per line)</span></h3>
            <p className="text-[11px] text-slate-500 mb-2">Format: <span className="font-mono text-slate-600">KC: Rashee Rice looks unguardable in camp</span> — Claude (Haiku) writes the scheme + fantasy analysis. Costs a fraction of a cent per batch.</p>
            <textarea className="input w-full h-28 font-mono text-xs" value={aiText} onChange={e => setAiText(e.target.value)}
              placeholder={'KC: Walker taking first-team reps ahead of Pacheco\nNYG: Skattebo dominating goal-line package'} />
            <div className="flex gap-2 mt-2 items-center">
              <select className="input" value={aiTeam} onChange={e => setAiTeam(e.target.value)}>
                <option value="">Default team (if no prefix)</option>
                {teams?.map(t => <option key={t.abbr} value={t.abbr}>{t.abbr}</option>)}
              </select>
              <button className="btn-primary" onClick={analyze} disabled={aiBusy}>{aiBusy ? 'Analyzing…' : 'Analyze & save'}</button>
            </div>
            {aiMsg && <p className="text-xs text-amber-600 mt-2">{aiMsg}</p>}
          </div>
          <div className="card p-4">
            <h3 className="text-sm font-bold text-slate-700 mb-2">Manual entry</h3>
            <div className="space-y-2">
              <div className="flex gap-2">
                <select className="input" value={manual.team_abbr} onChange={e => setManual(m => ({ ...m, team_abbr: e.target.value }))}>
                  <option value="">Team…</option>
                  {teams?.map(t => <option key={t.abbr} value={t.abbr}>{t.abbr}</option>)}
                </select>
                <select className="input" value={manual.importance} onChange={e => setManual(m => ({ ...m, importance: Number(e.target.value) }))}>
                  <option value={1}>Minor</option><option value={2}>Notable</option><option value={3}>Major</option>
                </select>
              </div>
              <input className="input w-full" placeholder="Headline" value={manual.headline}
                onChange={e => setManual(m => ({ ...m, headline: e.target.value }))} />
              <textarea className="input w-full h-16" placeholder="Details / your own analysis (optional)" value={manual.body}
                onChange={e => setManual(m => ({ ...m, body: e.target.value }))} />
              <button className="btn-ghost" onClick={addManual}>Save story</button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {items?.length === 0 && (
          <div className="card p-8 text-center text-sm text-slate-500">
            No stories yet. Hit <span className="text-emerald-600">+ Add news</span> to log camp reports — paste headlines and let AI write the analysis, or enter your own takes.
          </div>
        )}
        {items?.map((n: any) => (
          <div key={n.id} className="card p-4">
            <div className="flex items-center gap-2 text-xs mb-1">
              {n.team_abbr && (
                <Link to={`/teams/${n.team_abbr}`} className="font-black px-1.5 py-0.5 rounded text-white text-[10px]"
                  style={{ background: n.primary_color }}>{n.team_abbr}</Link>
              )}
              <span className="text-slate-500">{n.date}</span>
              {n.importance === 3 && <span className="text-rose-600 font-bold">MAJOR</span>}
              {n.importance === 1 && <span className="text-slate-400">minor</span>}
              {n.source && <span className="text-slate-400 ml-auto">{n.source}</span>}
              <button className="text-slate-700 hover:text-rose-600"
                onClick={async () => { await api(`/news/${n.id}`, { method: 'DELETE' }); refresh(); }}>✕</button>
            </div>
            <h3 className="font-semibold">{n.headline}</h3>
            {n.body && <p className="text-sm text-slate-600 mt-1">{n.body}</p>}

            {(n.ai_analysis || n.fantasy_impact) ? (
              <div className="mt-3 space-y-2">
                {n.ai_analysis && (
                  <div className="border-l-2 border-slate-300 pl-3">
                    <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">What it means for {n.team_abbr ?? 'the team'}</div>
                    <p className="text-sm text-slate-700">{n.ai_analysis}</p>
                  </div>
                )}
                {n.fantasy_impact && (
                  <div className="border-l-2 border-emerald-500 pl-3">
                    <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-600">What it means for my team</div>
                    <p className="text-sm text-slate-700">{n.fantasy_impact}</p>
                  </div>
                )}
              </div>
            ) : null}

            <button className="btn-ghost text-xs mt-3" onClick={() => explain(n.id)} disabled={explaining === n.id}>
              {explaining === n.id ? 'Reading…' : n.ai_analysis ? '↻ Re-analyze' : '✨ What does this mean?'}
            </button>
            {explainErr && explaining === null && <span className="text-xs text-rose-600 ml-2">{explainErr}</span>}
          </div>
        ))}
      </div>
      </>}
    </div>
  );
}
