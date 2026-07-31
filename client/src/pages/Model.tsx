import { useState } from 'react';
import { api, useApi } from '../api';
import { useLeague } from '../state/league';
import { usePlayerCard } from '../components/PlayerCard';

/**
 * The prediction engine, made inspectable.
 *
 * A model you can't audit is a model you shouldn't trust, so this page leads with
 * measured accuracy against the baselines rather than with the projections themselves.
 */

const TABS = [
  { id: 'accuracy', label: 'Accuracy' },
  { id: 'odds', label: 'Championship odds' },
  { id: 'correlation', label: 'Correlation' },
  { id: 'gamescript', label: 'Game script' },
  { id: 'handcuffs', label: 'Handcuffs' }
] as const;
type Tab = typeof TABS[number]['id'];

export default function Model() {
  const [tab, setTab] = useState<Tab>('accuracy');
  const { data: status } = useApi<any>('/model/status');
  const [syncing, setSyncing] = useState(false);

  const sync = async () => {
    setSyncing(true);
    try { await api('/model/sync', { method: 'POST' }); location.reload(); }
    catch (e: any) { alert(`Sync failed: ${e.message}`); }
    finally { setSyncing(false); }
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">Prediction Engine</h1>
        <button className="btn-ghost ml-auto text-xs" onClick={sync} disabled={syncing}>
          {syncing ? 'Syncing…' : '↻ Resync & refit'}
        </button>
      </div>
      <p className="text-sm text-slate-500 mb-3">
        Projections are built from opportunity and efficiency separately, then simulated
        rather than reported as a single number.
      </p>

      {status && (
        <div className="flex gap-4 flex-wrap text-[11px] text-slate-500 mb-4">
          <span><b className="text-slate-700">{status.players_with_gsis}</b> players linked to nflverse</span>
          <span><b className="text-slate-700">{(status.usage_seasons ?? []).reduce((s: number, x: any) => s + x.rows, 0).toLocaleString()}</b> weekly usage rows
            ({(status.usage_seasons ?? []).map((s: any) => s.season).join(', ')})</span>
          <span><b className="text-slate-700">{status.correlations_fitted}</b> correlation archetypes</span>
          <span><b className="text-slate-700">{(status.lines ?? []).reduce((s: number, x: any) => s + x.n, 0).toLocaleString()}</b> betting lines</span>
        </div>
      )}

      <div className="flex gap-1 border-b border-slate-200 mb-4 overflow-x-auto">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
              tab === t.id ? 'border-emerald-500 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'accuracy' && <Accuracy />}
      {tab === 'odds' && <Odds />}
      {tab === 'correlation' && <Correlation />}
      {tab === 'gamescript' && <GameScript />}
      {tab === 'handcuffs' && <Handcuffs />}
    </div>
  );
}

/* -------------------------------------------------------------- accuracy */
function Accuracy() {
  const [season, setSeason] = useState(2025);
  const { data, loading } = useApi<any>(`/model/accuracy?season=${season}`);

  if (loading) return <div className="card p-6 text-sm text-slate-500">Rebuilding the model on held-out data and grading it…</div>;
  if (data?.error) return <div className="card p-6 text-sm text-slate-600">{data.error}</div>;

  const best = data?.table?.[0];
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-slate-500">Held-out season</span>
        <select className="input py-1" value={season} onChange={e => setSeason(Number(e.target.value))}>
          {[2025, 2024, 2023].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {data && <span className="text-slate-400 ml-auto">{data.players_graded} players graded</span>}
      </div>

      <div className="card overflow-hidden">
        <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
          <h3 className="text-sm font-bold text-slate-700">Season-total accuracy</h3>
          <p className="text-[10px] text-slate-400">
            Model rebuilt using only seasons before {season}. Every source graded on the same players.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50/60 text-slate-400">
              <tr>
                {['Source', 'MAE', 'RMSE', 'Bias', 'R²', 'Spearman', 'Top-36 hit'].map(h => (
                  <th key={h} className="text-left font-semibold px-3 py-1.5 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(data?.table ?? []).map((t: any) => {
                const mine = t.source.startsWith('Gridiron');
                return (
                  <tr key={t.source} className={mine ? 'bg-emerald-50/40' : ''}>
                    <td className={`px-3 py-1.5 ${mine ? 'font-bold text-emerald-700' : 'text-slate-700'}`}>{t.source}</td>
                    <td className="px-3 py-1.5 tabular-nums">{t.mae}</td>
                    <td className="px-3 py-1.5 tabular-nums">{t.rmse}</td>
                    <td className="px-3 py-1.5 tabular-nums text-slate-500">{t.bias > 0 ? '+' : ''}{t.bias}</td>
                    <td className="px-3 py-1.5 tabular-nums font-semibold">{t.r2}</td>
                    <td className="px-3 py-1.5 tabular-nums font-semibold">{t.spearman}</td>
                    <td className="px-3 py-1.5 tabular-nums">{(t.top_n_hit_rate * 100).toFixed(0)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="px-3 py-2 text-[10px] text-slate-400 border-t border-slate-100">
          Lower MAE and RMSE are better; higher R² and Spearman are better. Bias is signed —
          positive means the source systematically over-projects.
        </p>
      </div>

      {data?.distribution && !data.distribution.error && (
        <div className="card p-4">
          <h3 className="text-sm font-bold text-slate-700 mb-1">Are the ranges honest?</h3>
          <p className="text-[11px] text-slate-500 mb-3">
            A point projection can only be graded on accuracy. A distribution can also be graded on
            whether its uncertainty was truthful — an 80% interval should contain the real answer
            about 80% of the time.
          </p>
          <div className="flex gap-6 flex-wrap">
            <Stat label="CRPS" value={data.distribution.crps}
              hint="Accuracy and honest uncertainty in one number, in fantasy points. Lower is better." />
            <Stat label="80% interval coverage" value={`${(data.distribution.coverage_80 * 100).toFixed(0)}%`}
              hint="Should be near 80%. Below means the model is overconfident." />
            <Stat label="Calibration error" value={data.distribution.calibration_error}
              hint="0 is perfectly calibrated." />
          </div>
          <div className="mt-3">
            <div className="text-[10px] text-slate-400 mb-1">
              Where actual results landed in the predicted range — a flat bar chart means well calibrated
            </div>
            <div className="flex items-end gap-1 h-14">
              {data.distribution.pit_histogram.map((b: number, i: number) => {
                const max = Math.max(...data.distribution.pit_histogram);
                return (
                  <div key={i} className="flex-1 bg-emerald-400/70 rounded-t" title={`${i * 10}–${i * 10 + 10}th percentile: ${b}`}
                    style={{ height: `${(b / max) * 100}%` }} />
                );
              })}
            </div>
            <div className="flex justify-between text-[9px] text-slate-400 mt-0.5"><span>worst case</span><span>median</span><span>best case</span></div>
          </div>
        </div>
      )}

      {best && (
        <p className="text-[11px] text-slate-500">
          Best source for {season} by rank correlation: <b className="text-slate-700">{best.source}</b>.
        </p>
      )}
    </div>
  );
}

const Stat = ({ label, value, hint }: { label: string; value: any; hint?: string }) => (
  <div title={hint}>
    <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
    <div className="text-xl font-black tabular-nums text-slate-800">{value}</div>
  </div>
);

/* --------------------------------------------------------- champ odds */
function Odds() {
  // Follows the league picked in the header — previously this silently always used
  // whichever league synced first, with no way to see odds for a second league.
  const { activeId: id } = useLeague();
  const { data, loading } = useApi<any>(id ? `/model/${id}/simulate?runs=2000` : null);

  if (!id) return <div className="card p-6 text-sm text-slate-500">Connect a league first.</div>;
  if (loading) return <div className="card p-6 text-sm text-slate-500">Simulating the season 2,000 times…</div>;
  if (data?.error) return <div className="card p-6 text-sm text-slate-600">{data.error}</div>;

  const max = Math.max(...(data?.teams ?? []).map((t: any) => t.title_odds), 0.01);
  return (
    <div className="card overflow-hidden">
      <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
        <h3 className="text-sm font-bold text-slate-700">Championship odds</h3>
        <p className="text-[10px] text-slate-400">
          {data?.runs?.toLocaleString()} simulated seasons over {data?.weeks} weeks, with correlated
          player outcomes and the real playoff bracket in NFL weeks 15–17.
        </p>
      </div>
      <div className="divide-y divide-slate-100">
        {(data?.teams ?? []).map((t: any) => (
          <div key={t.roster_id} className="px-3 py-2 flex items-center gap-3 text-xs">
            <span className="w-40 truncate font-semibold text-slate-700">{t.owner}</span>
            <div className="flex-1 h-4 bg-slate-100 rounded overflow-hidden relative">
              <div className="h-full bg-emerald-500 rounded" style={{ width: `${(t.title_odds / max) * 100}%` }} />
            </div>
            <span className="w-12 text-right tabular-nums font-bold text-emerald-700">{(t.title_odds * 100).toFixed(1)}%</span>
            <span className="w-24 text-right tabular-nums text-slate-500">{(t.playoff_odds * 100).toFixed(0)}% playoffs</span>
            <span className="w-16 text-right tabular-nums text-slate-400">{t.expected_wins} W</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------- correlation */
function Correlation() {
  const { data } = useApi<any[]>('/model/correlations');
  return (
    <div className="card overflow-hidden">
      <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
        <h3 className="text-sm font-bold text-slate-700">How player outcomes move together</h3>
        <p className="text-[10px] text-slate-400">
          Fitted on residuals from four seasons of boxscores. Positive means they boom together.
        </p>
      </div>
      <div className="divide-y divide-slate-100">
        {(data ?? []).map((c: any) => (
          <div key={c.key} className="px-3 py-1.5 flex items-center gap-3 text-xs">
            <span className="w-20 font-bold text-slate-700">{c.pair}</span>
            <span className="w-24 text-slate-500">{c.relationship}</span>
            <div className="flex-1 h-2 bg-slate-100 rounded relative overflow-hidden">
              <div className="absolute top-0 bottom-0 w-px bg-slate-300" style={{ left: '50%' }} />
              <div className={`absolute top-0 bottom-0 ${c.correlation >= 0 ? 'bg-emerald-500' : 'bg-rose-400'}`}
                style={{
                  left: c.correlation >= 0 ? '50%' : `${50 + c.correlation * 100}%`,
                  width: `${Math.abs(c.correlation) * 100}%`
                }} />
            </div>
            <span className={`w-14 text-right tabular-nums font-semibold ${c.correlation >= 0.1 ? 'text-emerald-700' : c.correlation < 0 ? 'text-rose-600' : 'text-slate-500'}`}>
              {c.correlation >= 0 ? '+' : ''}{c.correlation.toFixed(3)}
            </span>
            <span className="w-16 text-right text-[10px] text-slate-400">{c.pairs.toLocaleString()}</span>
          </div>
        ))}
      </div>
      <p className="px-3 py-2 text-[10px] text-slate-400 border-t border-slate-100">
        A quarterback and his receivers rise together; two quarterbacks on the same roster cannot.
        These are what stop the simulator from treating a lineup as nine independent coin flips.
      </p>
    </div>
  );
}

/* -------------------------------------------------------- game script */
function GameScript() {
  const [week, setWeek] = useState(1);
  const { data } = useApi<any>(`/model/gamescript?season=2026&week=${week}`);
  const model = data?.model ?? [];

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h3 className="text-sm font-bold text-slate-700 mb-1">What the betting line predicts about volume</h3>
        <p className="text-[11px] text-slate-500 mb-3">
          Fitted on four seasons of games. A favourite runs more; a high total means more passing.
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          {model.map((m: any) => (
            <div key={m.target} className="rounded-lg border border-slate-200 p-3">
              <div className="text-xs font-bold text-slate-700 mb-1">
                {m.target === 'pass_att' ? 'Pass attempts' : 'Rush attempts'}
              </div>
              <div className="text-[11px] text-slate-600 space-y-0.5 tabular-nums">
                <div>Per point of spread: <b className={m.b_spread > 0 ? 'text-emerald-700' : 'text-rose-600'}>{m.b_spread > 0 ? '+' : ''}{m.b_spread.toFixed(3)}</b></div>
                <div>Per point of total: <b className={m.b_total > 0 ? 'text-emerald-700' : 'text-rose-600'}>{m.b_total > 0 ? '+' : ''}{m.b_total.toFixed(3)}</b></div>
                <div className="text-slate-400">R² {m.r2.toFixed(4)} over {m.n.toLocaleString()} team-games</div>
              </div>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-slate-400 mt-2">
          The R² is deliberately shown: the line moves volume in the direction everyone assumes, but
          explains only a few percent of it. Team identity matters far more, and the model already
          knows that separately.
        </p>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="text-slate-500">Week</span>
        <select className="input py-1" value={week} onChange={e => setWeek(Number(e.target.value))}>
          {Array.from({ length: 18 }, (_, i) => i + 1).map(w => <option key={w} value={w}>{w}</option>)}
        </select>
      </div>

      <div className="card overflow-hidden">
        <div className="divide-y divide-slate-100 max-h-[50vh] overflow-y-auto">
          {(data?.lines ?? []).filter((l: any) => l.home).map((l: any) => (
            <div key={`${l.team}${l.week}`} className="px-3 py-1.5 flex items-center gap-2 text-xs">
              <span className="font-bold text-slate-700 w-12">{l.team}</span>
              <span className="text-slate-400 w-12">vs {l.opponent}</span>
              <span className="tabular-nums text-slate-500 w-16">{l.spread > 0 ? '+' : ''}{l.spread}</span>
              <span className="tabular-nums text-slate-500 w-16">O/U {l.total}</span>
              <span className="tabular-nums text-slate-600 w-24">implied {l.implied_points?.toFixed(1)}</span>
              <span className="ml-auto tabular-nums text-[11px]">
                <span className={l.pass_mult > 1 ? 'text-emerald-600' : 'text-slate-400'}>pass ×{l.pass_mult}</span>
                <span className="mx-1 text-slate-300">·</span>
                <span className={l.rush_mult > 1 ? 'text-emerald-600' : 'text-slate-400'}>rush ×{l.rush_mult}</span>
              </span>
            </div>
          ))}
          {(data?.lines ?? []).length === 0 && (
            <p className="p-4 text-xs text-slate-500">No lines for this week yet — hit “Resync &amp; refit”.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- handcuffs */
function Handcuffs() {
  const { data } = useApi<any[]>('/model/handcuffs?limit=40');
  const open = usePlayerCard();
  return (
    <div className="card overflow-hidden">
      <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
        <h3 className="text-sm font-bold text-slate-700">Contingent value</h3>
        <p className="text-[10px] text-slate-400">
          Who actually absorbs the work when a starter sits — measured from games the starter
          really missed, not assumed from a depth chart.
        </p>
      </div>
      <div className="divide-y divide-slate-100">
        {(data ?? []).map((h: any) => (
          <div key={h.player_id} className="px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <span className={`text-[9px] font-black pos-${h.position} w-6`}>{h.position}</span>
              <button onClick={() => open(h.player_id)} className="font-semibold text-slate-800 hover:text-emerald-700 hover:underline">
                {h.name}
              </button>
              <span className="ml-auto tabular-nums font-bold text-emerald-700">+{h.contingent_score}</span>
              <span className="text-[10px] text-slate-400">pts/g if called on</span>
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 ml-8">
              behind {h.paths.slice(0, 2).map((p: any) => `${p.starter} (${(p.starter_miss_rate * 100).toFixed(0)}% miss rate)`).join(', ')}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
