import { useState } from 'react';
import { api, useApi } from '../../api';

interface Nrfi {
  home_first_inning_rate: number; away_first_inning_rate: number;
  games_sampled: number; nrfi_probability: number; yrfi_probability: number;
}
interface Game {
  game_pk: number; matchup: string; home_team: string; away_team: string;
  venue: string; nrfi: Nrfi | null;
}
interface Batter {
  player_id: number; name: string; games: number; expected_ab: number;
  tb_per_ab: number; mean_tb: number; probabilities: Record<string, number>;
}
interface Pitcher {
  player_id: number; name: string; starts: number; expected_bf: number;
  k_per_bf: number; ip_per_start: number; mean_k: number; probabilities: Record<string, number>;
}
interface Board {
  date: string; season: number; games: Game[]; batters: Batter[]; pitchers: Pitcher[];
  source?: string; note?: string;
  fell_back?: { requested: string; showing: string } | null;
}

const pct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(0)}%`;

const bar = (v: number) => Math.max(2, Math.min(100, v * 100));

/**
 * The MLB board, rebuilt on this project's own data.
 *
 * The previous version proxied a separate repo's published CSVs and went stale
 * for sixteen days without failing — it just quietly served old games. Nothing
 * here depends on anyone else's pipeline: the schedule, the game logs and the
 * projections all come from the local database.
 *
 * No market prices are shown because there is no MLB odds feed wired up. Rather
 * than imply an edge that has not been measured, this presents the model side
 * only and says so.
 */
export default function MlbBoard() {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [tab, setTab] = useState<'games' | 'batters' | 'pitchers'>('games');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const { data, loading, error, refetch } = useApi<Board>(`/mlb/board?date=${date}&limit=40`);

  const refreshNow = async () => {
    setRefreshing(true); setRefreshMsg(null);
    try {
      const r = await api('/mlb/sync/now?job=mlb_schedule', { method: 'POST' });
      const detail = r.detail ?? r;
      setRefreshMsg(`Synced — ${detail.games ?? 0} games (${detail.upcoming ?? 0} upcoming).`);
      refetch();
    } catch (e: any) { setRefreshMsg(e.message); }
    finally { setRefreshing(false); }
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">MLB Board</h1>
        <div className="flex items-center gap-2 text-xs ml-auto">
          <input type="date" className="input py-1" value={date} onChange={e => setDate(e.target.value)} />
          <button className="btn-ghost text-xs" onClick={() => setDate(today)}>Today</button>
          <button className="btn-primary text-xs" onClick={refreshNow} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
      </div>
      {refreshMsg && <div className="card p-2 mb-3 text-xs text-slate-600">{refreshMsg}</div>}
      <p className="text-sm text-slate-500 mb-4">
        Built from this project's own MLB Stats API ingestion — schedule, game logs and projections
        all local. Model side only; no market prices are attached.
      </p>

      {loading ? (
        <div className="card p-6 text-sm text-slate-500">Simulating the slate…</div>
      ) : error ? (
        <div className="card p-6 text-sm text-rose-600">{error}</div>
      ) : !data?.games?.length ? (
        <div className="card p-6 text-sm text-slate-500">{data?.note ?? `No games stored for ${date}.`}</div>
      ) : (
        <>
          {data.fell_back && (
            <div className="card p-3 mb-4 border-amber-300 bg-amber-50">
              <div className="text-xs font-bold text-amber-900">
                Showing {data.fell_back.showing}, not {data.fell_back.requested}
              </div>
              <p className="text-[11px] text-amber-800 mt-0.5">{data.note}</p>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <Metric label="Slate" value={data.date} />
            <Metric label="Games" value={String(data.games.length)} />
            <Metric label="Batters projected" value={String(data.batters.length)} />
            <Metric label="Pitchers projected" value={String(data.pitchers.length)} />
            <Metric label="Source" value="first-party" tone="good" />
          </div>

          <div className="flex gap-1 border-b border-slate-200 mb-4">
            {([['games', `Games & NRFI (${data.games.length})`],
               ['batters', `Total Bases (${data.batters.length})`],
               ['pitchers', `Strikeouts (${data.pitchers.length})`]] as const).map(([id, label]) => (
              <button key={id} onClick={() => setTab(id as any)}
                className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
                  tab === id ? 'border-sky-500 text-sky-700' : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}>{label}</button>
            ))}
          </div>

          {tab === 'games' && (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {data.games.map(g => (
                <div key={g.game_pk} className="card p-3">
                  <div className="text-sm font-bold text-slate-800">{g.away_team}</div>
                  <div className="text-[10px] text-slate-400 mb-0.5">at</div>
                  <div className="text-sm font-bold text-slate-800 mb-2">{g.home_team}</div>
                  {g.nrfi ? (
                    <>
                      <div className="flex items-baseline gap-2">
                        <span className="text-2xl font-black text-sky-700">{pct(g.nrfi.nrfi_probability)}</span>
                        <span className="text-[10px] text-slate-400">NRFI</span>
                      </div>
                      <div className="h-1.5 bg-slate-100 rounded overflow-hidden my-1.5">
                        <div className="h-full bg-sky-500 rounded" style={{ width: `${bar(g.nrfi.nrfi_probability)}%` }} />
                      </div>
                      <div className="text-[10px] text-slate-500">
                        1st-inning scoring: {pct(g.nrfi.away_first_inning_rate)} away · {pct(g.nrfi.home_first_inning_rate)} home
                      </div>
                      <div className="text-[9px] text-slate-400 mt-0.5">{g.nrfi.games_sampled} team-games sampled</div>
                    </>
                  ) : (
                    <div className="text-[11px] text-slate-400">Not enough first-inning history yet.</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'batters' && (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-400">
                    <tr>{['Batter', 'G', 'Exp AB', 'TB/AB', 'Mean TB', 'Over 0.5', 'Over 1.5', 'Over 2.5'].map((h, i) => (
                      <th key={i} className="text-left font-semibold px-3 py-2 whitespace-nowrap">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.batters.map(b => (
                      <tr key={b.player_id} className="hover:bg-slate-50">
                        <td className="px-3 py-1.5 font-semibold text-slate-800 whitespace-nowrap">{b.name}</td>
                        <td className="px-3 py-1.5 tabular-nums text-slate-400">{b.games}</td>
                        <td className="px-3 py-1.5 tabular-nums">{b.expected_ab?.toFixed(2)}</td>
                        <td className="px-3 py-1.5 tabular-nums">{b.tb_per_ab?.toFixed(3)}</td>
                        <td className="px-3 py-1.5 tabular-nums font-bold text-slate-800">{b.mean_tb?.toFixed(2)}</td>
                        <Prob v={b.probabilities['over_0.5']} />
                        <Prob v={b.probabilities['over_1.5']} />
                        <Prob v={b.probabilities['over_2.5']} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'pitchers' && (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-400">
                    <tr>{['Pitcher', 'GS', 'Exp BF', 'K/BF', 'IP/start', 'Mean K', 'o4.5', 'o5.5', 'o6.5', 'o7.5'].map((h, i) => (
                      <th key={i} className="text-left font-semibold px-3 py-2 whitespace-nowrap">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.pitchers.map(p => (
                      <tr key={p.player_id} className="hover:bg-slate-50">
                        <td className="px-3 py-1.5 font-semibold text-slate-800 whitespace-nowrap">{p.name}</td>
                        <td className="px-3 py-1.5 tabular-nums text-slate-400">{p.starts}</td>
                        <td className="px-3 py-1.5 tabular-nums">{p.expected_bf?.toFixed(1)}</td>
                        <td className="px-3 py-1.5 tabular-nums">{p.k_per_bf?.toFixed(3)}</td>
                        <td className="px-3 py-1.5 tabular-nums">{p.ip_per_start?.toFixed(1)}</td>
                        <td className="px-3 py-1.5 tabular-nums font-bold text-slate-800">{p.mean_k?.toFixed(2)}</td>
                        <Prob v={p.probabilities['over_4.5']} />
                        <Prob v={p.probabilities['over_5.5']} />
                        <Prob v={p.probabilities['over_6.5']} />
                        <Prob v={p.probabilities['over_7.5']} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="card p-3 mt-4 text-[11px] text-slate-500">
            Rates are shrunk toward the league mean by sample size, so a hitter with twenty at-bats
            does not project as whatever his twenty at-bats happened to produce. Every projection uses
            only games played before {date}. Without an MLB odds feed there is no edge column here —
            these are model probabilities, not priced opportunities.
          </div>
        </>
      )}
    </div>
  );
}

const Prob = ({ v }: { v: number | undefined }) => (
  <td className="px-3 py-1.5">
    <div className="flex items-center gap-1.5">
      <div className="w-10 h-1.5 bg-slate-100 rounded overflow-hidden">
        <div className={`h-full rounded ${(v ?? 0) >= 0.6 ? 'bg-emerald-500' : (v ?? 0) >= 0.45 ? 'bg-sky-500' : 'bg-slate-300'}`}
          style={{ width: `${bar(v ?? 0)}%` }} />
      </div>
      <span className="tabular-nums text-slate-600 w-8">{pct(v)}</span>
    </div>
  </td>
);

const Metric = ({ label, value, tone }: { label: string; value: string; tone?: 'good' }) => (
  <div className="card p-3">
    <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
    <div className={`text-lg font-bold ${tone === 'good' ? 'text-emerald-700' : 'text-slate-800'}`}>{value}</div>
  </div>
);
