import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../api';

export default function Projections() {
  const { data: agg, refetch, loading } = useApi<any[]>('/aggregates');
  const [filter, setFilter] = useState('ALL');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const sync = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api('/aggregates/sync', { method: 'POST' });
      const parts = [];
      if (r.ffc?.matched != null) parts.push(`FFC ADP: ${r.ffc.matched} players`);
      else if (r.ffc?.error) parts.push(`FFC failed: ${r.ffc.error}`);
      if (r.sleeper?.matched != null) parts.push(`Sleeper: ${r.sleeper.matched} players`);
      else if (r.sleeper?.error) parts.push(`Sleeper failed: ${r.sleeper.error}`);
      setMsg(parts.join(' · '));
      refetch();
    } catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  const createBoard = async () => {
    const name = prompt('Name for the new consensus board?', `Consensus ${new Date().toISOString().slice(0, 10)}`);
    if (!name) return;
    const r = await api('/aggregates/create-board', { method: 'POST', body: JSON.stringify({ name }) });
    setMsg(`Created board "${name}" with ${r.count} players — it's now available in Rankings and the Draft Room.`);
  };

  const visible = (agg ?? []).filter(p => filter === 'ALL' || p.position === filter).slice(0, 200);

  return (
    <div>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">Projections & Aggregates</h1>
        <div className="ml-auto flex gap-2">
          {['ALL', 'QB', 'RB', 'WR', 'TE'].map(p => (
            <button key={p} onClick={() => setFilter(p)}
              className={`btn ${filter === p ? 'bg-slate-200 text-slate-900' : 'bg-slate-100 text-slate-500'}`}>{p}</button>
          ))}
          <button className="btn-ghost" onClick={sync} disabled={busy}>{busy ? 'Pulling…' : '↻ Pull latest'}</button>
          <button className="btn-primary" onClick={createBoard} disabled={!agg?.length}>Create board from consensus</button>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-4">Blended ranks across platforms: FantasyFootballCalculator ADP (real drafts) + Sleeper rankings, matched against the ESPN player database.</p>
      {msg && <p className="text-sm text-amber-600 mb-3">{msg}</p>}

      {loading ? <p className="text-slate-500">Loading…</p> : visible.length === 0 ? (
        <div className="card p-8 text-center text-sm text-slate-500">
          No aggregate data yet — hit <span className="text-emerald-600">↻ Pull latest</span> to fetch FFC ADP and Sleeper rankings (free, no keys needed).
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="text-left px-4 py-2 w-16">Cons.</th>
                <th className="text-left px-2 py-2">Player</th>
                <th className="text-left px-2 py-2 w-12">Pos</th>
                <th className="text-left px-2 py-2 w-14">Team</th>
                <th className="text-right px-2 py-2 w-20">FFC ADP</th>
                <th className="text-right px-2 py-2 w-20">FFC #</th>
                <th className="text-right px-4 py-2 w-20">Sleeper #</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visible.map((p, i) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="px-4 py-1.5 font-mono font-bold text-emerald-700">{p.consensus.toFixed(1)}</td>
                  <td className="px-2 py-1.5">
                    <Link to={`/players/${p.id}`} className="font-medium hover:text-emerald-700 hover:underline">{p.name}</Link>
                    {p.injury_flag ? <span className="ml-2 text-[10px] text-rose-600 font-bold">INJ</span> : null}
                  </td>
                  <td className={`px-2 py-1.5 font-bold text-xs pos-${p.position}`}>{p.position}</td>
                  <td className="px-2 py-1.5 text-slate-500 text-xs">{p.team_abbr ?? '—'}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-slate-600">{p.ffc_adp?.toFixed(1) ?? '—'}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-slate-500">{p.ffc_rank ?? '—'}</td>
                  <td className="px-4 py-1.5 text-right font-mono text-slate-500">{p.sleeper_ordinal ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
