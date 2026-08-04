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
  const [tab, setTab] = useState<'prices' | 'numbers' | 'clv'>('prices');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const { data: shop, loading, error, refetch } = useApi<Shop>('/nfl-betting/lines/shop');
  const { data: dis } = useApi<{ disagreements: Disagreement[] }>('/nfl-betting/lines/disagreement');
  const { data: clv, refetch: refetchClv } = useApi<Clv>('/nfl-betting/lines/clv');

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

      {msg && <div className="card p-3 mb-4 text-xs text-slate-600">{msg}</div>}

      <div className="flex gap-1 border-b border-slate-200 mb-4">
        {([['prices', `Best prices (${opps.length})`],
           ['numbers', `Number gaps (${dis?.disagreements?.length ?? 0})`],
           ['clv', 'Closing line value']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id as any)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
              tab === id ? 'border-emerald-500 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}>{label}</button>
        ))}
      </div>

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
