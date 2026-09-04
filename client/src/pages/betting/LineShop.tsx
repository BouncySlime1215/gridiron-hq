import { useState } from 'react';
import { api, useApi } from '../../api';

interface Quote { book: string; price: number; line: number | null; }
interface Opportunity {
  matchup: string; commence_time: string; market: string; side: string; line: number | null;
  best_book: string; best_price: number; worst_book: string; worst_price: number;
  books_quoting: number; edge_vs_worst: number; all_quotes: Quote[];
}
interface Shop { games: number; opportunities: Opportunity[]; note: string; error?: string; }
interface Disagreement {
  matchup: string; market: string; side: string;
  best_line: number; worst_line: number; spread_of_numbers: number;
  crosses_key_number: boolean; quotes: { book: string; line: number; price: number }[];
}
interface Clv { available: boolean; snapshots?: number; captures?: number; tracked?: number; note?: string; }

/** Stored-snapshot execution board — no API credits, works with the quota exhausted. */
interface BoardSide {
  event_id: string; matchup: string; side: string; captured_at: string;
  books_compared: number; best_book: string; best_line: number | null; best_price: number;
  median_line: number | null; line_edge: number | null; price_edge: number | null; edge_vs_median: number;
}
interface Middle {
  matchup: string; width: number; hit_probability: number; push_probability: number;
  ev_per_unit: number; arbitrage: boolean; winning_margins: number[];
  home: { team: string; book: string; line: number; price: number };
  away: { team: string; book: string; line: number; price: number };
}
interface BookHold {
  books: { book: string; markets_measured: number; hold: number; break_even: number; cost_per_100_units: number }[];
  best_book?: string; worst_book?: string;
  spread_in_hold?: number; win_rate_saved?: number; note: string;
}
interface BoardResp {
  market: string;
  hold: BookHold;
  summary: {
    sides_priced: number; events: number; shoppable_sides: number;
    mean_edge_when_shoppable: number | null; best_edge: number | null;
    middles_found: number; positive_ev_middles: number; arbitrage_found: number;
    latest_capture: string | null; stale: boolean; note: string;
  };
  sides: BoardSide[];
  middles: Middle[];
}

/** Signed percentage — an edge of exactly zero should read as neutral, not as a gain. */
const spct = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`);
const sgn = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}`);

const american = (v: number | null | undefined) =>
  v == null ? '—' : v > 0 ? `+${v}` : `${v}`;
const pct = (v: number | null | undefined) =>
  v == null ? '—' : `${(v * 100).toFixed(2)}%`;
const MARKET_LABEL: Record<string, string> = { h2h: 'Moneyline', spreads: 'Spread', totals: 'Total' };

/**
 * Line shopping.
 *
 * Every other page here is trying to out-predict a market that already knows
 * what we know, and the replay shows that fight is roughly a coin flip. This
 * page is a different kind of edge: when nine books quote the same bet and one
 * offers a better number, taking it is arithmetic. No forecast is involved.
 *
 * The sizes are not trivial either — the gap between -110 and -105 on the same
 * side is about 2.3% of expected return, which is larger than the edge the
 * model was chasing and does not decay when the market gets sharper.
 */
export default function LineShop() {
  const [tab, setTab] = useState<'board' | 'prices' | 'numbers' | 'clv'>('board');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // `/lines/shop` and `/lines/disagreement` both hit the paid Odds API. Fetching
  // them on mount burned credits every time this page was opened, even when the
  // visitor never left the free stored-snapshot board. With the free tier at a
  // few hundred credits a month that is a real leak, so the paid calls are
  // deferred until their own tab is actually selected.
  const { data: shop, loading, error, refetch } = useApi<Shop>(tab === 'prices' ? '/nfl-betting/lines/shop' : null);
  const { data: dis } = useApi<{ disagreements: Disagreement[] }>(tab === 'numbers' ? '/nfl-betting/lines/disagreement' : null);
  const { data: clv, refetch: refetchClv } = useApi<Clv>(tab === 'clv' ? '/nfl-betting/lines/clv' : null);
  // Free: reads snapshots already on disk, so it always loads.
  const { data: board, loading: boardLoading } = useApi<BoardResp>('/betting/execution/board?limit=25');

  const snapshot = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api('/nfl-betting/lines/snapshot', { method: 'POST' });
      setMsg(`Captured ${r.quotes} quotes across ${r.games} games.`);
      refetchClv();
    } catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  const opps = shop?.opportunities ?? [];

  return (
    <div>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">Line Shopping</h1>
        <div className="flex items-center gap-2 text-xs ml-auto">
          <button className="btn-ghost text-xs" onClick={() => refetch()}>↻ Refresh</button>
          <button className="btn-primary text-xs" onClick={snapshot} disabled={busy}>
            {busy ? 'Capturing…' : '📸 Snapshot lines'}
          </button>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        The best available price on every side, across every book quoting it. This is the only edge
        here that needs no prediction — just refusing the worse number.
      </p>
      <div className="card p-3 mb-4 border-emerald-200 bg-emerald-50/40 text-xs text-emerald-900">
        Unlike the rest of Execute, the numbers on this page are always live and actionable, with no
        staking gate. A middle's hit rate and a book's hold are pure arithmetic on prices and lines that
        already exist — they don't depend on a forecast the way a "pick" does, so there is nothing here
        for a model gate to hold back.
      </div>

      {msg && <div className="card p-3 mb-4 text-xs text-slate-600">{msg}</div>}

      <div className="flex gap-1 border-b border-slate-200 mb-4">
        {([['board', `Execution board (${board?.summary.shoppable_sides ?? 0})`],
           ['prices', tab === 'prices' ? `Best prices (${opps.length})` : 'Best prices · live'],
           ['numbers', tab === 'numbers' ? `Number gaps (${dis?.disagreements?.length ?? 0})` : 'Number gaps · live'],
           ['clv', 'Closing line value']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id as any)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
              tab === id ? 'border-emerald-500 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}>{label}</button>
        ))}
      </div>

      {tab === 'board' && (
        boardLoading ? <div className="card p-6 text-sm text-slate-500">Pricing stored quotes…</div>
        : !board || !board.sides.length ? (
          <div className="card p-6 text-sm text-slate-500">
            No multi-book snapshots stored yet. This board reads captures already on disk, so it costs
            no API credits — but it needs at least two books quoting the same side at the same instant.
          </div>
        ) : (
          <>
            {board.hold?.books?.length > 1 && (
              <div className="card p-4 mb-3 border-emerald-200">
                <div className="flex items-baseline gap-2 flex-wrap mb-1">
                  <h2 className="text-sm font-bold text-slate-800">The vig — what each book charges</h2>
                  <span className="text-[11px] text-slate-500">measured from two-sided prices, not assumed</span>
                </div>
                <p className="text-[11px] text-slate-600 mb-3 leading-relaxed">
                  Using <b className="text-emerald-700">{board.hold.best_book}</b> instead of{' '}
                  <b>{board.hold.worst_book}</b> lowers the break-even rate you need by{' '}
                  <b className="text-emerald-700">{spct(board.hold.win_rate_saved)}</b>. No forecast involved —
                  this is the largest cost you control, and the only lever here guaranteed to work.
                </p>
                <div className="space-y-1">
                  {board.hold.books.map((b, i) => {
                    const worst = board.hold.books[board.hold.books.length - 1].hold;
                    const best = board.hold.books[0].hold;
                    const frac = worst > best ? (b.hold - best) / (worst - best) : 0;
                    return (
                      <div key={b.book} className="flex items-center gap-2 text-xs">
                        <span className={`w-24 truncate font-semibold ${i === 0 ? 'text-emerald-700' : 'text-slate-700'}`}>{b.book}</span>
                        <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                          <div className={`h-full rounded-full ${i === 0 ? 'bg-emerald-500' : frac > 0.75 ? 'bg-rose-400' : 'bg-slate-400'}`}
                            style={{ width: `${Math.max(6, frac * 100)}%` }} />
                        </div>
                        <span className="w-14 text-right tabular-nums font-bold text-slate-800">{(b.hold * 100).toFixed(2)}%</span>
                        <span className="w-16 text-right tabular-nums text-slate-500">{(b.break_even * 100).toFixed(2)}%</span>
                        <span className="w-10 text-right tabular-nums text-[10px] text-slate-400">n={b.markets_measured}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-2 mt-2 text-[10px] text-slate-400">
                  <span className="w-24" /><span className="flex-1" />
                  <span className="w-14 text-right">hold</span>
                  <span className="w-16 text-right">break-even</span>
                  <span className="w-10" />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              {[['Shoppable sides', `${board.summary.shoppable_sides}/${board.summary.sides_priced}`,
                 `across ${board.summary.events} games`],
                ['Avg price improvement when shoppable', spct(board.summary.mean_edge_when_shoppable),
                 'vs the median book'],
                ['Best single price improvement', spct(board.summary.best_edge), 'top of the board'],
                ['+EV middles', `${board.summary.positive_ev_middles}/${board.summary.middles_found}`,
                 board.summary.arbitrage_found ? `${board.summary.arbitrage_found} true arb` : 'most lose to vig']
              ].map(([k, v, d]) => (
                <div key={k} className="card p-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{k}</div>
                  <div className="text-lg font-black text-slate-900 tabular-nums">{v}</div>
                  <div className="text-[10px] text-slate-500">{d}</div>
                </div>
              ))}
            </div>

            {board.summary.stale && board.summary.latest_capture && (
              <div className="card p-3 mb-3 border-amber-300 bg-amber-50">
                <p className="text-xs text-amber-800">
                  Latest multi-book capture is {new Date(board.summary.latest_capture).toLocaleString()} — over a
                  day old. These are real historical gaps, not bettable right now. Fresh capture needs Odds API credits.
                </p>
              </div>
            )}

            {board.middles.length > 0 && (
              <div className="card p-4 mb-3">
                <h2 className="text-sm font-bold text-slate-700 mb-0.5">Middles</h2>
                <p className="text-[11px] text-slate-500 mb-2">
                  Both sides bet at different books. Priced against the real margin distribution — a middle
                  only pays if the gap lands on a margin that actually happens.
                </p>
                <div className="space-y-2">
                  {board.middles.slice(0, 6).map((m, i) => (
                    <div key={i} className={`rounded-lg border p-2.5 ${m.ev_per_unit > 0 ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-200'}`}>
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-sm font-bold text-slate-800">{m.matchup}</span>
                        <span className={`text-xs font-black tabular-nums ${m.ev_per_unit > 0 ? 'text-emerald-700' : 'text-slate-400'}`}>
                          {spct(m.ev_per_unit)}/unit
                        </span>
                        {m.arbitrage && <span className="text-[10px] font-black text-emerald-700">ARB</span>}
                        <span className="text-[11px] text-slate-500 ml-auto tabular-nums">
                          hits {(m.hit_probability * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-600 mt-1 tabular-nums">
                        {m.home.team} {sgn(m.home.line)} @{american(m.home.price)} <span className="text-slate-400">({m.home.book})</span>
                        {'  +  '}
                        {m.away.team} {sgn(m.away.line)} @{american(m.away.price)} <span className="text-slate-400">({m.away.book})</span>
                      </div>
                      {m.winning_margins.length > 0 && (
                        <div className="text-[10px] text-slate-500 mt-0.5">
                          Both win when the margin is {m.winning_margins.join(' or ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="card overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50">
                <div className="text-sm font-bold text-slate-800">Best book per side</div>
                <div className="text-[11px] text-slate-500">
                  Ranked by what shopping is worth against the median book — the honest counterfactual.
                  Each side's edge is priced against the real NFL margin distribution (a half-point through
                  a key number counts for more than a half-point that isn't). See also Venue Routing's
                  "Best routing gains" for the same question answered a different way — a slate-wide,
                  win-rate-saved view built for choosing where to place a bet you've already decided on.
                </div>
              </div>
              <div className="divide-y divide-slate-100">
                {board.sides.map((s, i) => (
                  <div key={`${s.event_id}-${s.side}-${i}`}
                    className="grid gap-2 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-slate-800 truncate">{s.side}</div>
                      <div className="text-[11px] text-slate-500 truncate">{s.matchup}</div>
                    </div>
                    <div className="flex gap-4 sm:text-right tabular-nums">
                      <div>
                        <div className="text-[10px] font-bold uppercase text-slate-400">Best</div>
                        <div className="text-sm font-black text-slate-900">{sgn(s.best_line)} @{american(s.best_price)}</div>
                        <div className="text-[10px] text-slate-500">{s.best_book}</div>
                      </div>
                      <div>
                        <div className="text-[10px] font-bold uppercase text-slate-400">Median</div>
                        <div className="text-sm font-semibold text-slate-500">{sgn(s.median_line)}</div>
                        <div className="text-[10px] text-slate-400">{s.books_compared} books</div>
                      </div>
                      <div>
                        <div className="text-[10px] font-bold uppercase text-slate-400">Price improvement</div>
                        <div className={`text-sm font-black ${s.edge_vs_median > 0 ? 'text-emerald-700' : 'text-slate-400'}`}>
                          {spct(s.edge_vs_median)}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          line {spct(s.line_edge)} · px {spct(s.price_edge)}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <p className="text-[11px] text-slate-400 mt-2">{board.summary.note}</p>
          </>
        )
      )}

      {tab === 'prices' && (
        loading ? <div className="card p-6 text-sm text-slate-500">Fetching every book…</div>
        : error || shop?.error ? (
          <div className="card p-6 text-sm text-rose-600">
            {shop?.error ?? error}
            <p className="text-xs text-slate-500 mt-2">
              This needs an Odds API key and a posted slate. Out of season there is nothing to shop.
            </p>
          </div>
        ) : !opps.length ? (
          <div className="card p-6 text-sm text-slate-500">
            No price differences right now — every book is quoting the same numbers, or no slate is posted.
          </div>
        ) : (
          <>
            <div className="card p-3 mb-3 text-xs text-slate-600">{shop?.note}</div>
            <div className="space-y-2">
              {opps.map((o, i) => (
                <div key={i} className="card p-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="font-semibold text-slate-800 w-32">{o.matchup}</div>
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                      {MARKET_LABEL[o.market] ?? o.market}
                    </span>
                    <div className="text-xs text-slate-700 min-w-[110px]">
                      {o.side}{o.line != null ? ` ${o.line > 0 ? '+' : ''}${o.line}` : ''}
                    </div>
                    <div className="min-w-[110px]">
                      <div className="text-[9px] uppercase tracking-wide text-slate-400">Best</div>
                      <div className="text-sm font-bold text-emerald-700 tabular-nums">
                        {american(o.best_price)} <span className="text-[10px] font-normal text-slate-500">{o.best_book}</span>
                      </div>
                    </div>
                    <div className="min-w-[110px]">
                      <div className="text-[9px] uppercase tracking-wide text-slate-400">Worst</div>
                      <div className="text-sm text-rose-600 tabular-nums">
                        {american(o.worst_price)} <span className="text-[10px] text-slate-500">{o.worst_book}</span>
                      </div>
                    </div>
                    <div className="ml-auto text-right">
                      <div className="text-[9px] uppercase tracking-wide text-slate-400">You gain</div>
                      <div className="text-lg font-black text-emerald-700 tabular-nums">{pct(o.edge_vs_worst)}</div>
                    </div>
                  </div>
                  <div className="flex gap-1 mt-2 flex-wrap">
                    {o.all_quotes.map((q, j) => (
                      <span key={j} className={`text-[10px] px-1.5 py-0.5 rounded border tabular-nums ${
                        q.book === o.best_book
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200 font-bold'
                          : 'bg-white text-slate-500 border-slate-200'
                      }`}>{q.book} {american(q.price)}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )
      )}

      {tab === 'numbers' && (
        !dis?.disagreements?.length ? (
          <div className="card p-6 text-sm text-slate-500">
            No number disagreements — every book is hanging the same line, or no slate is posted.
          </div>
        ) : (
          <div className="space-y-2">
            {dis.disagreements.map((d, i) => (
              <div key={i} className={`card p-3 ${d.crosses_key_number ? 'border-amber-300 bg-amber-50/40' : ''}`}>
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="font-semibold text-slate-800 w-32">{d.matchup}</div>
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                    {MARKET_LABEL[d.market] ?? d.market}
                  </span>
                  <div className="text-xs text-slate-700">{d.side}</div>
                  <div className="text-xs tabular-nums">
                    <span className="text-emerald-700 font-bold">{d.best_line}</span>
                    <span className="text-slate-400"> to </span>
                    <span className="text-rose-600">{d.worst_line}</span>
                  </div>
                  {d.crosses_key_number && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
                      crosses a key number
                    </span>
                  )}
                  <div className="ml-auto text-sm font-bold text-slate-800 tabular-nums">
                    {d.spread_of_numbers} pt gap
                  </div>
                </div>
                <div className="flex gap-1 mt-2 flex-wrap">
                  {d.quotes.map((q, j) => (
                    <span key={j} className="text-[10px] px-1.5 py-0.5 rounded border bg-white text-slate-500 border-slate-200 tabular-nums">
                      {q.book} {q.line > 0 ? '+' : ''}{q.line}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            <div className="card p-3 text-[11px] text-slate-500">
              Half a point matters far more when it crosses 3 or 7, because NFL margins cluster there.
              Those rows are highlighted.
            </div>
          </div>
        )
      )}

      {tab === 'clv' && (
        <div className="card p-4">
          <h2 className="text-sm font-bold text-slate-700 mb-2">Closing line value</h2>
          {clv?.available ? (
            <div className="text-xs text-slate-600 space-y-1">
              <div>Tracking <b className="text-slate-800">{clv.tracked}</b> lines across <b className="text-slate-800">{clv.snapshots}</b> snapshots.</div>
            </div>
          ) : (
            <p className="text-xs text-slate-500">{clv?.note}</p>
          )}
          <div className="mt-3 text-[11px] text-slate-500 border-t border-slate-100 pt-3">
            CLV is the fastest honest read on whether a strategy has edge. If your picks consistently
            get a better number than the market closes at, profit follows over time even when the
            short-run record looks bad — and if they do not, a good record proves nothing. It reads in
            roughly fifty bets where win rate needs a thousand. Snapshot the board regularly and this
            becomes measurable within a week of games.
          </div>
        </div>
      )}
    </div>
  );
}
