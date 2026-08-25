import { useState } from 'react';
import { api, headshotUrl, useApi } from '../api';
import PlayerRow, { Trend } from '../components/PlayerRow';

export default function Projections() {
  const { data: agg, refetch, loading } = useApi<any[]>('/aggregates');
  const [filter, setFilter] = useState('ALL');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [limit, setLimit] = useState(100);

  const sync = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api('/aggregates/sync', { method: 'POST' });
      const part = (label: string, v: any) => v?.matched != null ? `${label} ${v.matched}` : v?.error ? `${label} failed` : null;
      setMsg([part('FFC', r.ffc), part('Sleeper', r.sleeper), part('FantasyCalc', r.fantasycalc)].filter(Boolean).join(' · '));
      refetch();
    } catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  const createBoard = async () => {
    const name = prompt('Name for the new consensus board?', `Consensus ${new Date().toISOString().slice(0, 10)}`);
    if (!name) return;
    const r = await api('/aggregates/create-board', { method: 'POST', body: JSON.stringify({ name }) });
    setMsg(`Created “${name}” with ${r.count} players — available in Rankings and the Draft Room.`);
  };

  const all = (agg ?? []).filter(p => filter === 'ALL' || p.position === filter);
  const visible = all.slice(0, limit);

  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">Projections &amp; Market</h1>
        <div className="ml-auto flex gap-1.5 flex-wrap">
          {['ALL', 'QB', 'RB', 'WR', 'TE'].map(p => (
            <button key={p} onClick={() => setFilter(p)}
              className={`btn ${filter === p ? 'bg-sky-100 text-sky-900 border border-sky-200' : 'bg-white text-slate-500 hover:bg-sky-50'}`}>{p}</button>
          ))}
          <button className="btn-ghost" onClick={sync} disabled={busy}>{busy ? 'Pulling…' : '↻ Pull latest'}</button>
          <button className="btn-primary" onClick={createBoard} disabled={!agg?.length}>Create board</button>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-3">
        Blended consensus across FantasyFootballCalculator ADP (real drafts), Sleeper ranks, and FantasyCalc trade values. Click any name for the buy/sell card.
      </p>
      {msg && <p className="text-sm text-amber-600 mb-3">{msg}</p>}

      {loading ? <p className="text-slate-500">Loading…</p> : visible.length === 0 ? (
        <div className="card p-8 text-center text-sm text-slate-500">
          No market data yet — hit <span className="text-emerald-600">↻ Pull latest</span> to fetch ADP, Sleeper ranks and trade values (all free, no keys).
        </div>
      ) : (
        <>
          <div className="card overflow-hidden">
            <div className="flex items-center gap-3 px-3 py-2 bg-slate-50 border-b border-slate-200 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              <span className="w-7 text-right">#</span>
              <span className="w-[36px]" />
              <span className="w-8" />
              <span className="flex-1">Player</span>
              <span className="w-9">Tm</span>
              <span className="w-14 text-right">Value</span>
              <span className="w-14 text-right">30d</span>
              <span className="w-12 text-right">ADP</span>
            </div>
            {visible.map((p, i) => (
              <PlayerRow
                key={p.id}
                playerId={p.id}
                rank={i + 1}
                name={p.name}
                position={p.position}
                teamAbbr={p.team_abbr}
                headshot={headshotUrl(p)}
                dense
                meta={p.injury_flag ? <span className="text-rose-600 font-bold">INJURY</span> : undefined}
                right={
                  <>
                    <span className="w-14 text-right text-xs font-semibold text-slate-700 tabular-nums">
                      {p.fc_value != null ? Math.round(p.fc_value) : '—'}
                    </span>
                    <span className="w-14 text-right text-xs"><Trend v={p.fc_trend_pct} raw={p.fc_trend30} /></span>
                    <span className="w-12 text-right text-xs text-slate-500 tabular-nums">
                      {p.ffc_adp != null ? p.ffc_adp.toFixed(1) : '—'}
                    </span>
                  </>
                }
              />
            ))}
          </div>
          {all.length > visible.length && (
            <button className="btn-ghost w-full mt-3" onClick={() => setLimit(l => l + 100)}>
              Show 100 more ({all.length - visible.length} left)
            </button>
          )}
        </>
      )}
    </div>
  );
}
