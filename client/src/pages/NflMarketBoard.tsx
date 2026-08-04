import { useState } from 'react';
import { api, useApi } from '../api';
import { pct, americanFmt } from './props/lib';
import PickReasoning, { type Reasoning } from '../components/PickReasoning';

interface BoardRow {
  market: 'moneyline' | 'spread' | 'total';
  matchup: string; selection: string; side: string;
  american_price: number | null; model_probability: number; implied_probability: number;
  probability_difference: number; detail: string;
  home_team?: string; away_team?: string; line?: number | null;
  reasoning?: Reasoning;
}
interface Accuracy {
  games_graded: number; win_accuracy: number; brier_score: number;
  margin_mae: number; total_mae: number; margin_std: number; total_std: number;
  fitted_alpha: number; fitted_carryover: number; fitted_hfa: number; note: string;
}
interface AutoPick {
  season: number; week: number; rank: number; home_team: string; away_team: string; matchup: string;
  selection: string; side: string; line: number; american_price: number;
  model_probability: number; implied_probability: number; probability_difference: number;
  detail: string; units_staked: number;
}
interface Graded extends AutoPick { status: 'Pending' | 'Won' | 'Lost' | 'Push'; units: number; }
interface Standing { wins: number; losses: number; pushes: number; win_rate: number | null; units: number; weeks_tracked: number; }
interface RunResult {
  season: number; week: number; trials: number;
  last_week: { week: number; results: Graded[] };
  new_picks: AutoPick[];
  standing: Standing;
}

const MARKET_LABEL: Record<string, string> = { moneyline: 'Moneyline', spread: 'Spread', total: 'Total' };
const STATUS_STYLE: Record<string, string> = {
  Won: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  Lost: 'bg-rose-100 text-rose-700 border-rose-300',
  Push: 'bg-slate-100 text-slate-600 border-slate-300',
  Pending: 'bg-amber-50 text-amber-700 border-amber-200'
};

/**
 * Model vs. no-vig market on real game lines — same pattern as the MLB props
 * board, built on Gridiron HQ's own ratings model (server/services/nfl-market.js)
 * instead of a proxied feed, since a football engine already lives here. Every
 * price shown is real (DraftKings, via ESPN's scoreboard), not assumed vig.
 */
export default function NflMarketBoard() {
  const [week, setWeek] = useState(1);
  const [marketFilter, setMarketFilter] = useState<string>('all');
  // The explained endpoint returns the same board with a computed rationale on
  // every row, which is what the "Why this pick" panel renders.
  const { data, loading, error } = useApi<{ season: number; week: number; board: BoardRow[] }>(
    `/nfl-betting/board/explained?week=${week}&limit=60`);
  const { data: acc } = useApi<Accuracy>('/nfl-market/accuracy');
  const { data: history, refetch: refetchHistory } = useApi<{ results: Graded[]; standing: Standing }>('/nfl-market/picks/history');

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);

  const runWeekly = async () => {
    setRunning(true); setRunError(null); setRunResult(null);
    try {
      const r = await api(`/nfl-market/sync-and-pick?week=${week}&trials=20000`, { method: 'POST' });
      setRunResult(r);
      refetchHistory();
    } catch (e: any) { setRunError(e.message); }
    finally { setRunning(false); }
  };

  const board = (data?.board ?? []).filter(b => marketFilter === 'all' || b.market === marketFilter);
  const standing = runResult?.standing ?? history?.standing;

  return (
    <div>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">NFL Board</h1>
        <div className="flex items-center gap-2 text-xs ml-auto">
          <span className="text-slate-500">Week</span>
          <select className="input py-1" value={week} onChange={e => setWeek(Number(e.target.value))}>
            {Array.from({ length: 18 }, (_, i) => i + 1).map(w => <option key={w} value={w}>{w}</option>)}
          </select>
          <button className="btn-primary text-xs" onClick={runWeekly} disabled={running}>
            {running ? 'Analyzing…' : '▶ Run Weekly Analysis'}
          </button>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Model win/cover/total probability against the no-vig market price, on real DraftKings lines. Ranked by
        the size of the disagreement — a big gap is a reason to look closer, not a guarantee.
      </p>

      {running && (
        <div className="card p-3 mb-4 text-xs text-slate-500">
          Re-syncing every current-season line (which is also how last week's final scores arrive), refitting the
          ratings model, then running 20,000 bootstrapped scenarios per bet across the week's games. This finishes
          in seconds, not the ~20 minutes a truly manual version of this would take by hand — the computation
          itself is fast; nothing here is padded to look slower or more impressive than it is.
        </div>
      )}
      {runError && <div className="card p-3 mb-4 text-xs text-rose-600">{runError}</div>}

      {standing && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
          <Metric label="Record" value={`${standing.wins}-${standing.losses}${standing.pushes ? `-${standing.pushes}` : ''}`} />
          <Metric label="Win rate" value={standing.win_rate == null ? '—' : pct(standing.win_rate)} />
          <Metric label="Units (flat stake)" value={`${standing.units >= 0 ? '+' : ''}${standing.units.toFixed(2)}u`}
            tone={standing.units > 0 ? 'good' : standing.units < 0 ? 'bad' : undefined} />
          <Metric label="Weeks tracked" value={String(standing.weeks_tracked)} />
          <Metric label="Bet type" value="Spread, straight" />
        </div>
      )}

      {runResult && (
        <div className="mb-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            Last run — week {runResult.week}, {runResult.trials.toLocaleString()} scenarios per bet
          </h2>
          {runResult.last_week.week >= 1 && (
            <div className="card overflow-hidden mb-3">
              <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-600">
                How week {runResult.last_week.week} went
              </div>
              {runResult.last_week.results.length === 0 ? (
                <div className="p-3 text-xs text-slate-500">No picks were tracked for week {runResult.last_week.week}.</div>
              ) : (
                <PickTable rows={runResult.last_week.results} graded />
              )}
            </div>
          )}
          <div className="card overflow-hidden">
            <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-600">
              This week's 5 picks (locked in — straight bets, 1 unit each)
            </div>
            <PickTable rows={runResult.new_picks} graded={false} />
          </div>
        </div>
      )}

      {acc && !('error' in acc) && (
        <div className="card p-3 mb-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-600">
          <span><b className="text-slate-800">{pct(acc.win_accuracy)}</b> straight-up win accuracy</span>
          <span><b className="text-slate-800">{acc.margin_mae}</b> pt margin MAE</span>
          <span><b className="text-slate-800">{acc.total_mae}</b> pt total MAE</span>
          <span><b className="text-slate-800">{acc.fitted_hfa}</b> pt fitted home-field edge</span>
          <span className="text-slate-400">·  {acc.games_graded.toLocaleString()} games, walk-forward (no leakage)</span>
        </div>
      )}

      <div className="flex gap-1 mb-3">
        {['all', 'moneyline', 'spread', 'total'].map(v => (
          <button key={v} onClick={() => setMarketFilter(v)}
            className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
              marketFilter === v ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
            }`}>{v === 'all' ? 'All' : MARKET_LABEL[v]}</button>
        ))}
      </div>

      {loading ? (
        <div className="card p-6 text-sm text-slate-500">Loading week {week}…</div>
      ) : error ? (
        <div className="card p-6 text-sm text-rose-600">{error}</div>
      ) : board.length === 0 ? (
        <div className="card p-6 text-sm text-slate-500">
          No priced lines for week {week} yet — books haven't posted this far out, or the season hasn't reached it.
        </div>
      ) : (
        <div className="space-y-2">
          {board.map((b, i) => {
            const strong = Math.abs(b.probability_difference) >= 0.08;
            return (
              <div key={i} className="card p-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="font-semibold text-slate-800 w-28 shrink-0">{b.matchup}</div>
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                    {MARKET_LABEL[b.market]}
                  </span>
                  <div className="text-xs font-semibold text-slate-700 min-w-[80px]">{b.side}</div>
                  <Col label="Price" value={americanFmt(b.american_price)} />
                  <Col label="Model" value={pct(b.model_probability)} />
                  <Col label="Market" value={pct(b.implied_probability)} />
                  <div className="min-w-[64px]">
                    <div className="text-[9px] uppercase tracking-wide text-slate-400">Edge</div>
                    <div className={`text-sm font-bold tabular-nums text-emerald-700 ${strong ? '' : 'opacity-60'}`}>
                      +{pct(b.probability_difference)}
                    </div>
                  </div>
                  <div className="text-[10px] text-slate-400 ml-auto whitespace-nowrap">{b.detail}</div>
                </div>
                <PickReasoning reasoning={b.reasoning} />
              </div>
            );
          })}
        </div>
      )}

      {history && history.results.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Track record — every auto-pick so far</h2>
          <div className="card overflow-hidden">
            <PickTable rows={history.results} graded />
          </div>
        </div>
      )}

      <div className="card p-3 mt-4 text-xs text-slate-500">
        The model is one pair of ratings per team (offense/defense, in points), updated after every game since
        1999 — the same idea as Elo, just in points instead of an abstract scale, which is what lets one system
        drive win, cover, and total probability together. Every prediction above only ever used games that
        happened before it. This is a from-scratch model with no injury, weather, or QB-specific inputs yet —
        treat it as a research signal, not a guarantee.
      </div>
    </div>
  );
}

function PickTable({ rows, graded }: { rows: (AutoPick | Graded)[]; graded: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-slate-400">
          <tr>{['Wk', 'Matchup', 'Pick', 'Price', 'Edge', ...(graded ? ['Result', 'Units'] : [])].map((h, i) => (
            <th key={i} className="text-left font-semibold px-3 py-2 whitespace-nowrap">{h}</th>
          ))}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((p, i) => {
            const g = 'status' in p ? p as Graded : null;
            return (
              <tr key={i}>
                <td className="px-3 py-2 text-slate-400 tabular-nums">{p.week}</td>
                <td className="px-3 py-2">
                  <div className="font-semibold text-slate-800">{p.matchup}</div>
                  <div className="text-[10px] text-slate-400">{p.detail}</div>
                </td>
                <td className="px-3 py-2 text-slate-700">{p.selection} {p.side}</td>
                <td className="px-3 py-2 tabular-nums">{americanFmt(p.american_price)}</td>
                <td className="px-3 py-2 tabular-nums text-emerald-700 font-semibold">+{pct(p.probability_difference)}</td>
                {graded && g && (
                  <>
                    <td className="px-3 py-2">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${STATUS_STYLE[g.status]}`}>{g.status}</span>
                    </td>
                    <td className="px-3 py-2 tabular-nums text-right font-semibold"
                      style={{ color: g.units > 0 ? '#047857' : g.units < 0 ? '#e11d48' : undefined }}>
                      {g.units === 0 ? '—' : `${g.units > 0 ? '+' : ''}${g.units.toFixed(2)}u`}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="card p-3">
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`text-lg font-bold mt-0.5 ${tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-rose-600' : 'text-slate-800'}`}>
        {value}
      </div>
    </div>
  );
}

const Col = ({ label, value }: { label: string; value: string }) => (
  <div className="min-w-[58px]">
    <div className="text-[9px] uppercase tracking-wide text-slate-400">{label}</div>
    <div className="text-xs font-semibold text-slate-700 tabular-nums">{value}</div>
  </div>
);
