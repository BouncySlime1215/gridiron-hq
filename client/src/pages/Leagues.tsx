import { useState } from 'react';
import { api, useApi } from '../api';
import { useLeague } from '../state/league';
import { PlayerName } from '../components/PlayerCard';
import { PageError, PageLoading } from '../components/PageState';

const POS_ORDER = ['QB', 'RB', 'WR', 'TE'];

function StatusPill({ status, ratio }: { status: string; ratio: number }) {
  const style = status === 'need' ? 'bg-crit-tint text-crit'
    : status === 'surplus' ? 'bg-good-tint text-good'
    : 'bg-slate-100 text-slate-500';
  return <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${style}`}>
    {status === 'need' ? 'NEED' : status === 'surplus' ? 'SURPLUS' : 'OK'} {(ratio * 100).toFixed(0)}%
  </span>;
}

export default function Leagues() {
  // Shared with the header switcher — clicking a league card here to view its
  // analysis also makes it the active league on My Team, Trade Lab, etc.
  const { leagues, loading: leaguesLoading, error: leaguesError, refetch, activeId: sel, setActiveId: setSel } = useLeague();
  const { data: analysis, refetch: refetchAnalysis } = useApi<any>(sel ? `/leagues/${sel}/analysis` : null);
  const [form, setForm] = useState({ platform: 'sleeper', league_id: '', season: 2026, espn_s2: '', swid: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const add = async () => {
    if (!form.league_id) return;
    setBusy(true); setMsg(null);
    try {
      const lg = await api('/leagues', { method: 'POST', body: JSON.stringify(form) });
      const s = await api(`/leagues/${lg.id}/sync`, { method: 'POST' });
      setMsg(`Added and synced — ${s.teams} teams${s.fell_back ? `, using ${s.season_used} rosters (this season hasn’t drafted yet)` : ''}.`);
      setForm(f => ({ ...f, league_id: '', espn_s2: '', swid: '' }));
      refetch();
      setSel(lg.id);
    } catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  const sync = async (id: number) => {
    setBusy(true); setMsg(null);
    try {
      const s = await api(`/leagues/${id}/sync`, { method: 'POST' });
      setMsg(`Synced ${s.teams} teams · ${s.roster_players ?? 0} rostered players${s.fell_back ? ` (from ${s.season_used} — this season hasn’t drafted yet)` : ''}.`);
      refetch(); refetchAnalysis();
    }
    catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">My Leagues</h1>
      <p className="text-sm text-slate-500 mb-5">Connect as many leagues as you want — Sleeper (no login needed) or ESPN (cookies for private leagues). Each one gets roster-needs analysis against real trade-market values.</p>

      <div className="card p-4 mb-6 flex flex-wrap gap-3 items-end">
        <label className="text-xs text-slate-600">Platform
          <select className="input block mt-1" value={form.platform}
            onChange={e => setForm(f => ({ ...f, platform: e.target.value }))}>
            <option value="sleeper">Sleeper</option>
            <option value="espn">ESPN</option>
          </select>
        </label>
        <label className="text-xs text-slate-600">League ID
          <input className="input block mt-1 w-48" placeholder={form.platform === 'sleeper' ? '1124...' : '1234567'}
            value={form.league_id} onChange={e => setForm(f => ({ ...f, league_id: e.target.value }))} />
        </label>
        <label className="text-xs text-slate-600">Season
          <input type="number" className="input block mt-1 w-24" value={form.season}
            onChange={e => setForm(f => ({ ...f, season: Number(e.target.value) }))} />
        </label>
        {form.platform === 'espn' && (
          <>
            <label className="text-xs text-slate-600">espn_s2
              <input className="input block mt-1 w-56 font-mono" value={form.espn_s2}
                onChange={e => setForm(f => ({ ...f, espn_s2: e.target.value }))} />
            </label>
            <label className="text-xs text-slate-600">SWID
              <input className="input block mt-1 w-48 font-mono" value={form.swid}
                onChange={e => setForm(f => ({ ...f, swid: e.target.value }))} />
            </label>
          </>
        )}
        <button className="btn-primary" onClick={add} disabled={busy}>{busy ? 'Working…' : '+ Add & sync'}</button>
        {msg && <span className="text-xs text-amber-600">{msg}</span>}
      </div>

      {leaguesLoading && !leagues.length && <PageLoading label="Loading your leagues…" />}
      {leaguesError && !leagues.length && <PageError message={leaguesError} onRetry={refetch} />}

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
        {leagues?.map(lg => (
          <div key={lg.id} className={`card p-4 cursor-pointer transition-colors ${sel === lg.id ? 'border-[var(--accent)]' : 'hover:border-slate-400'}`}
            onClick={() => setSel(lg.id)}>
            <div className="flex items-center gap-2">
              <span className={`text-[10px] font-black px-1.5 py-0.5 rounded ${lg.platform === 'sleeper' ? 'bg-violet-100 text-violet-700' : 'bg-rose-100 text-rose-700'}`}>
                {lg.platform.toUpperCase()}
              </span>
              <span className="font-semibold text-sm truncate">{lg.name ?? `League ${lg.league_id}`}</span>
            </div>
            <div className="text-xs text-slate-500 mt-1">
              {lg.team_count ?? '?'} teams · {lg.season}{lg.superflex ? ' · superflex' : ''}{lg.ppr === 1 ? ' · PPR' : lg.ppr === 0.5 ? ' · half-PPR' : ''}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">{lg.fetched_at ? `synced ${lg.fetched_at}` : 'never synced'}</div>
            <div className="flex gap-3 mt-2">
              <button className="text-xs text-emerald-600 hover:underline"
                onClick={e => { e.stopPropagation(); sync(lg.id); }}>↻ sync</button>
              <button className="text-xs text-rose-600 hover:underline"
                onClick={async e => { e.stopPropagation(); if (confirm('Remove this league?')) { await api(`/leagues/${lg.id}`, { method: 'DELETE' }); if (sel === lg.id) setSel(null); refetch(); } }}>remove</button>
            </div>
          </div>
        ))}
        {!leaguesLoading && !leaguesError && leagues?.length === 0 && <p className="text-sm text-slate-500">No leagues connected yet.</p>}
      </div>

      {analysis?.empty && (
        <div className="card p-6 text-sm text-slate-500">{analysis.message}</div>
      )}

      {analysis && !analysis.empty && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200">
            <h2 className="font-bold text-sm">{analysis.league.name} — roster strength by position</h2>
            <p className="text-xs text-slate-500">Starter value vs league average, priced off real FantasyCalc trade values. Under 80% = need, over 115% = surplus.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="text-left px-4 py-2">Team</th>
                  {POS_ORDER.map(p => <th key={p} className="text-left px-3 py-2">{p}</th>)}
                  <th className="text-left px-4 py-2">Needs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {analysis.rosters.map((ro: any) => (
                  <tr key={ro.roster_id} className="hover:bg-slate-50 align-top">
                    <td className="px-4 py-2 font-medium whitespace-nowrap">{ro.owner}</td>
                    {POS_ORDER.map(pos => (
                      <td key={pos} className="px-3 py-2">
                        <StatusPill status={ro.positions[pos].status} ratio={ro.positions[pos].ratio} />
                        <div className="mt-1 space-y-0.5">
                          {ro.positions[pos].starters.slice(0, 3).map((s: any) => (
                            <div key={s.id} className="text-xs text-slate-600">
                              <PlayerName id={s.id}>{s.name}</PlayerName>
                            </div>
                          ))}
                        </div>
                      </td>
                    ))}
                    <td className="px-4 py-2 text-xs">
                      {ro.needs.length ? <span className="text-crit font-medium">{ro.needs.join(', ')}</span> : <span className="text-slate-400">balanced</span>}
                      {ro.surplus.length > 0 && <div className="text-good">has: {ro.surplus.join(', ')}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
