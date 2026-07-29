import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../api';

const today = () => new Date().toISOString().slice(0, 10);

export default function News() {
  const [date, setDate] = useState<string>('');
  const [teamFilter, setTeamFilter] = useState('');
  const { data: dates, refetch: refetchDates } = useApi<string[]>('/news/dates');
  const { data: teams } = useApi<any[]>('/teams');
  const query = `/news?${date ? `date=${date}&` : ''}${teamFilter ? `team=${teamFilter}` : ''}`;
  const { data: items, refetch } = useApi<any[]>(query);

  const [showAdd, setShowAdd] = useState(false);
  const [aiText, setAiText] = useState('');
  const [aiTeam, setAiTeam] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [manual, setManual] = useState({ team_abbr: '', headline: '', body: '', importance: 2 });

  const refresh = () => { refetch(); refetchDates(); };

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
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h1 className="text-2xl font-bold">Training Camp News</h1>
        <select className="input" value={date} onChange={e => setDate(e.target.value)}>
          <option value="">All days</option>
          {dates?.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select className="input" value={teamFilter} onChange={e => setTeamFilter(e.target.value)}>
          <option value="">All teams</option>
          {teams?.map(t => <option key={t.abbr} value={t.abbr}>{t.abbr} — {t.name}</option>)}
        </select>
        <button className="btn-primary ml-auto" onClick={() => setShowAdd(v => !v)}>{showAdd ? 'Close' : '+ Add news'}</button>
      </div>

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
            {n.ai_analysis && (
              <p className="text-sm text-slate-700 mt-2 border-l-2 border-emerald-700 pl-3">{n.ai_analysis}</p>
            )}
            {n.fantasy_impact && (
              <p className="text-xs text-amber-600 mt-2">🎯 {n.fantasy_impact}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
