import { useState } from 'react';
import { api, useApi } from '../../api';
import { EmptyState, StatusPill } from '../../components/betting/BettingUI';

/**
 * Live pick watch.
 *
 * Re-shops every currently open spread/total pick against the live multi-book
 * market and flags whether the situation has drifted in our favor or against
 * it since the pick was generated. It is a monitoring board, not an order
 * ticket: `status` reads "watching — no action" for every row until a
 * market's champion model actually clears model-governance.js's production
 * gate, at which point `recommended_stake_units` stops being zero and the row
 * switches to "actionable" on its own — nothing here fabricates that state,
 * it only reads it live.
 *
 * The de-vig methodology comparison (naive proportional split vs. Shin's
 * method) used to live here as a second tab. It answers an unrelated
 * question about how the model prices fair odds, not pick-tracking, so it
 * now lives under Engine > Diagnostics > Methodology.
 */

interface WatchRow {
  id: number; checked_at: string; pick_source: 'spread' | 'total';
  season: number; week: number; rank: number;
  matchup: string; market: string; selection: string | null; side: string | null;
  line_at_generation: number | null; price_at_generation: number | null; book_at_generation: string | null;
  best_book: string | null; best_line: number | null; best_price: number | null; books_compared: number;
  break_even_at_generation: number | null; break_even_now: number | null;
  direction: 'more_favorable' | 'less_favorable' | 'unchanged' | 'unknown';
  model_probability: number | null; model_edge_at_generation: number | null;
  gate_open: 0 | 1; recommended_stake_units: number;
  status: string; note: string | null;
}
interface WatchBoard {
  picks: WatchRow[]; open: number; actionable: number;
  more_favorable: number; less_favorable: number; any_gate_open: boolean; note: string;
}
interface RunResult {
  checked_at: string; picks_checked: number; spread_checked: number; total_checked: number;
  more_favorable: number; less_favorable: number; actionable: number; note: string;
}
const am = (v: number | null | undefined) => (v == null ? '—' : v > 0 ? `+${v}` : `${v}`);
const sgn = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}`);
const pct1 = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const timeAgo = (iso: string | null) => {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
};

const DIRECTION_LABEL: Record<string, string> = {
  more_favorable: '▲ more favorable', less_favorable: '▼ less favorable',
  unchanged: 'unchanged', unknown: 'no live quote'
};
const DIRECTION_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  more_favorable: 'good', less_favorable: 'bad', unchanged: 'neutral', unknown: 'neutral'
};

export default function PickWatch() {
  const { data: board, loading, error, refetch } = useApi<WatchBoard>('/betting/watch/board');
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const reshopNow = async () => {
    setRunning(true); setRunError(null);
    try {
      const result = await api<RunResult>('/betting/watch/run', { method: 'POST' });
      setRunResult(result);
      await refetch();
    } catch (e: any) { setRunError(e.message); }
    finally { setRunning(false); }
  };

  const lastChecked = board?.picks[0]?.checked_at ?? runResult?.checked_at ?? null;

  return (
    <div>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">Pick Watch</h1>
        <div className="flex items-center gap-2 text-xs ml-auto">
          <button className="btn-ghost text-xs" onClick={() => refetch()}>↻ Refresh</button>
          <button className="btn-primary text-xs" onClick={reshopNow} disabled={running}>
            {running ? 'Re-shopping…' : '⟳ Re-shop now'}
          </button>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-2">
        Every currently open pick, re-shopped against the live multi-book market on a schedule. This is a
        monitoring board, not an order ticket — nothing here is a recommendation to bet money.
      </p>
      <div className="card p-2.5 mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
        <span>Last checked: <b className="text-slate-700">{lastChecked ? `${timeAgo(lastChecked)} (${new Date(lastChecked).toLocaleString()})` : 'never'}</b></span>
        <span>Refresh cadence: tolerant book/exchange feeds every 2–5 min, fragile scrapes hourly, all day</span>
        {runResult && <span className="text-emerald-700 font-semibold">Last manual re-shop: {runResult.picks_checked} picks checked</span>}
        {runError && <span className="text-rose-600">{runError}</span>}
      </div>

      {(
        loading ? <div className="card p-6 text-sm text-slate-500">Reading the watch log…</div>
        : error ? <div className="card p-6 text-sm text-rose-600">{error}</div>
        : !board || !board.picks.length ? (
          <EmptyState title="Nothing open to watch right now"
            description="This board only has rows once there is at least one open (ungraded) spread or total pick. Generate picks from the Board tab, or check back once a slate is posted — this is the honest empty state, not an error." />
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              {[['Open picks', board.open, 'currently being watched'],
                ['More favorable', board.more_favorable, 'price improved since generation'],
                ['Less favorable', board.less_favorable, 'price worsened since generation'],
                ['Actionable', board.actionable, board.any_gate_open ? 'a champion is in production' : 'zero — no market has cleared the gate yet']
              ].map(([k, v, d]) => (
                <div key={String(k)} className="card p-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{k}</div>
                  <div className="text-lg font-black text-slate-900 tabular-nums">{String(v)}</div>
                  <div className="text-[10px] text-slate-500">{d}</div>
                </div>
              ))}
            </div>

            <div className={`card p-3 mb-3 ${board.any_gate_open ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200'}`}>
              <p className={`text-xs ${board.any_gate_open ? 'text-emerald-900' : 'text-slate-600'}`}>{board.note}</p>
            </div>

            <div className="card overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50">
                <div className="text-sm font-bold text-slate-800">Open picks vs. the live market</div>
                <div className="text-[11px] text-slate-500">Frozen model view at generation, compared against the current best book/price/line.</div>
              </div>
              <div className="divide-y divide-slate-100">
                {board.picks.map(row => (
                  <div key={row.id} className="grid gap-2 px-4 py-3 lg:grid-cols-[minmax(0,1.2fr)_repeat(3,minmax(0,1fr))_auto] lg:items-center">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-slate-800 truncate">{row.matchup}</span>
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 uppercase">{row.pick_source}</span>
                        <StatusPill tone={row.status === 'actionable' ? 'good' : 'neutral'}>
                          {row.status === 'actionable' ? 'actionable' : row.status === 'watching_no_market_data' ? 'no live quote' : 'watching only'}
                        </StatusPill>
                      </div>
                      <div className="text-[11px] text-slate-500 truncate mt-0.5">
                        {row.selection ?? row.side} {row.side && row.selection ? `· ${row.side}` : ''} · Wk {row.week}
                      </div>
                    </div>
                    <div className="tabular-nums">
                      <div className="text-[10px] font-bold uppercase text-slate-400">At generation</div>
                      <div className="text-sm font-semibold text-slate-700">{sgn(row.line_at_generation)} @{am(row.price_at_generation)}</div>
                      <div className="text-[10px] text-slate-400">{row.book_at_generation ?? '—'}</div>
                    </div>
                    <div className="tabular-nums">
                      <div className="text-[10px] font-bold uppercase text-slate-400">Current best</div>
                      <div className="text-sm font-black text-slate-900">{sgn(row.best_line)} @{am(row.best_price)}</div>
                      <div className="text-[10px] text-slate-400">{row.best_book ?? '—'} · {row.books_compared} book{row.books_compared === 1 ? '' : 's'}</div>
                    </div>
                    <div>
                      <div className="text-[10px] font-bold uppercase text-slate-400">Since generation</div>
                      <StatusPill tone={DIRECTION_TONE[row.direction]}>{DIRECTION_LABEL[row.direction]}</StatusPill>
                      <div className="text-[10px] text-slate-400 mt-1">
                        break-even {row.break_even_at_generation != null ? pct1(row.break_even_at_generation) : '—'}
                        {' → '}{row.break_even_now != null ? pct1(row.break_even_now) : '—'}
                      </div>
                    </div>
                    <div className="text-right lg:text-right">
                      <div className="text-[10px] font-bold uppercase text-slate-400">Recommended stake</div>
                      <div className={`text-sm font-black tabular-nums ${row.gate_open ? 'text-emerald-700' : 'text-slate-400'}`}>
                        {row.recommended_stake_units}u
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}
