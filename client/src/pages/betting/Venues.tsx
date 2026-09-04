import { useState } from 'react';
import { useApi } from '../../api';

/**
 * Where a bet actually goes, what it costs there, and what is live right now.
 *
 * This is the part of the project that works. Every forecasting surface here is
 * measured negative, but the cost of placing a bet is not a forecast — it is a
 * fact, it varies by more than any edge ever measured here, and it is available
 * to anyone who checks. Sportsbook hold spans 3.09% to 5.54%; Kalshi's tight
 * spread hides a fee that puts it at 4.15% all-in; Polymarket charges no fee and
 * runs a 2.53% median on markets with real depth.
 *
 * The live tab is the one place a validated model meets a tradeable price, and
 * it is deliberately strict about when that combination is worth acting on.
 */

type Tab = 'routing' | 'venues' | 'live';

const pct = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`;

export default function Venues() {
  const [tab, setTab] = useState<Tab>('routing');
  const { data: slate } = useApi<any>(tab === 'routing' ? '/betting/execution/slate?market=spreads' : null);
  const { data: hold } = useApi<any>(tab === 'venues' ? '/betting/hold' : null);
  const { data: poly } = useApi<any>(tab === 'venues' ? '/betting/polymarket/cost' : null);
  const { data: kalshi } = useApi<any>(tab === 'venues' ? '/betting/prediction/cost' : null);
  const { data: live } = useApi<any>(tab === 'live' ? '/betting/live/board' : null);
  const { data: liveStatus } = useApi<any>(tab === 'live' ? '/betting/live/status' : null);

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-slate-200">
        {([['routing', 'Where to bet'], ['venues', 'What it costs'], ['live', 'Live board']] as [Tab, string][])
          .map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                tab === id ? 'border-emerald-500 text-emerald-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
              {label}
            </button>
          ))}
      </div>

      {tab === 'routing' && (
        <>
          <div className="card p-4">
            <h2 className="font-semibold text-slate-900">Where a decided bet should go</h2>
            <p className="mt-1 text-sm text-slate-600">
              This does not pick sides — every attempt to do that here has failed its own audit. It
              takes the bet as given and routes it to whichever book pays most, scoring line and price
              on the same scale so half a point through a key number correctly outranks a cent of juice.
            </p>
          </div>
          {slate && !slate.error && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat label="Routes found" value={String(slate.routes_found ?? 0)} />
                <Stat label="Saved vs median book" value={pct(slate.mean_win_rate_saved_vs_median)}
                  sub="off the break-even rate you need" tone="good" />
                <Stat label="Saved vs worst book" value={pct(slate.mean_win_rate_saved_vs_worst)}
                  tone="good" />
              </div>
              <div className="card overflow-x-auto p-4">
                <h3 className="text-sm font-semibold text-slate-900">Best routing gains</h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Win-rate-saved vs. the median and worst book, aggregated across the slate — built for
                  routing a bet you've already decided on. See also Line Shop's "Best book per side" for
                  the same question priced against the real NFL margin distribution, side by side.
                </p>
                <table className="mt-3 w-full text-sm">
                  <thead className="text-xs uppercase tracking-wide text-slate-400">
                    <tr><th className="py-1 text-left">Side</th><th className="text-left">Book</th>
                      <th className="text-right">Line</th><th className="text-right">Price</th>
                      <th className="text-right">Books</th><th className="text-right">Saves</th></tr>
                  </thead>
                  <tbody>
                    {(slate.routes ?? []).slice(0, 14).map((r: any, i: number) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="py-1.5 text-slate-700">{r.side}</td>
                        <td className="font-medium text-slate-800">{r.place_at}</td>
                        <td className="text-right tabular-nums text-slate-600">{r.line}</td>
                        <td className="text-right tabular-nums text-slate-600">{r.price}</td>
                        <td className="text-right tabular-nums text-slate-400">{r.books_compared}</td>
                        <td className="text-right tabular-nums font-medium text-emerald-700">
                          {pct(r.win_rate_saved_vs_worst)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {tab === 'venues' && (
        <>
          <div className="card p-4">
            <h2 className="font-semibold text-slate-900">What each venue really costs</h2>
            <p className="mt-1 text-sm text-slate-600">
              Costs are compared all-in, because a quoted spread lies. Kalshi looks decisive at two
              cents until its separate trading fee is added — that fee peaks near even money, exactly
              where NFL games price. Polymarket charges nothing, so its book spread is the whole cost.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <VenueCard title="Cheapest sportsbook"
              value={pct(hold?.hold?.books?.[0]?.hold)}
              sub={hold?.hold?.best_book ?? '—'} />
            <VenueCard title="Kalshi all-in"
              value={pct(kalshi?.kalshi_mean_all_in_cost)}
              sub={kalshi ? `${pct(kalshi.kalshi_mean_spread_only)} spread + ${pct(kalshi.kalshi_mean_fee)} fee` : '—'} />
            <VenueCard title="Polymarket, tradeable"
              value={pct(poly?.mean_cost_tradeable)}
              sub={poly ? `${poly.tradeable_markets} markets with depth · no fee` : '—'}
              tone={poly?.cheaper_than_kalshi ? 'good' : undefined} />
          </div>
          {(!kalshi || !poly) && (
            <div className="card p-3 border-slate-200 bg-slate-50 text-xs text-slate-600">
              This is correctly empty, not broken: Kalshi and Polymarket cost cards need a live read from
              their prediction-market APIs, which returns nothing outside of season or without an API key
              configured. The sportsbook hold card above reads from stored snapshots and works regardless.
            </div>
          )}

          {hold?.hold?.books && (
            <div className="card overflow-x-auto p-4">
              <h3 className="text-sm font-semibold text-slate-900">Sportsbook hold</h3>
              <table className="mt-3 w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-400">
                  <tr><th className="py-1 text-left">Book</th><th className="text-right">Hold</th>
                    <th className="text-right">Break-even</th><th className="text-right">Markets</th></tr>
                </thead>
                <tbody>
                  {hold.hold.books.map((b: any) => (
                    <tr key={b.book} className="border-t border-slate-100">
                      <td className="py-1.5 font-medium text-slate-800">{b.book}</td>
                      <td className="text-right tabular-nums text-slate-900">{pct(b.hold)}</td>
                      <td className="text-right tabular-nums text-slate-600">{pct(b.break_even)}</td>
                      <td className="text-right tabular-nums text-slate-400">{b.markets_measured}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {hold.hold.spread_in_hold != null && (
                <p className="mt-3 text-sm text-slate-700">
                  Cheapest to dearest spans <strong>{pct(hold.hold.spread_in_hold)}</strong> of hold —
                  worth <strong>{pct(hold.hold.win_rate_saved)}</strong> off the break-even rate you need,
                  free, and requiring you to be right about nothing.
                </p>
              )}
            </div>
          )}

          {poly?.cost_by_depth && (
            <div className="card overflow-x-auto p-4">
              <h3 className="text-sm font-semibold text-slate-900">Polymarket cost by depth</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                The venue is bimodal — a few liquid markets quote a one-cent spread while a long tail
                of near-empty ones quote anything. The average across both is meaningless; what
                matters is the cost where a bet could actually be filled.
              </p>
              <table className="mt-3 w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-400">
                  <tr><th className="py-1 text-left">Depth tier</th><th className="text-right">Markets</th>
                    <th className="text-right">Mean</th><th className="text-right">Median</th></tr>
                </thead>
                <tbody>
                  {poly.cost_by_depth.map((t: any) => (
                    <tr key={t.tier} className="border-t border-slate-100">
                      <td className="py-1.5 text-slate-700">{t.tier}</td>
                      <td className="text-right tabular-nums text-slate-500">{t.markets}</td>
                      <td className="text-right tabular-nums text-slate-900">{pct(t.mean_cost)}</td>
                      <td className="text-right tabular-nums text-slate-700">{pct(t.median_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'live' && (
        <>
          <div className="card p-4">
            <h2 className="font-semibold text-slate-900">Live in-game board</h2>
            <p className="mt-1 text-sm text-slate-600">
              The one place a validated model meets a tradeable price. The live win-probability model
              is the only forecasting component here that passed its audit — Brier 0.171 against a
              0.25 baseline over 2,196 graded states — and its measured bias is corrected rather than
              paid for.
            </p>
          </div>

          {liveStatus && (
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Brier" value={String(liveStatus.model_validation?.brier ?? '—')}
                sub={`baseline ${liveStatus.model_validation?.baseline}`} tone="good" />
              <Stat label="Skill score" value={String(liveStatus.model_validation?.skill_score ?? '—')} tone="good" />
              <Stat label="Calibration error"
                value={String(liveStatus.model_validation?.calibration_error ?? '—')} />
              <Stat label="States graded"
                value={String(liveStatus.model_validation?.states_graded?.toLocaleString() ?? '—')} />
            </div>
          )}

          {liveStatus?.gates && (
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-slate-900">Gates before anything is actionable</h3>
              <ul className="mt-2 space-y-1">
                {liveStatus.gates.map((g: string, i: number) => (
                  <li key={i} className="flex gap-2 text-sm text-slate-700">
                    <span className="text-slate-300">·</span><span>{g}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-slate-500">
                Most live states clear none of these. That is the correct outcome on a venue where we
                are structurally the slowest participant — anyone at the stadium sees the play first.
              </p>
            </div>
          )}

          {live && (
            live.games_live === 0
              ? <div className="card p-6 text-sm text-slate-600">{live.note}</div>
              : (
                <div className="card p-4">
                  <h3 className="text-sm font-semibold text-slate-900">
                    {live.games_live} game{live.games_live === 1 ? '' : 's'} in progress ·{' '}
                    {live.actionable} actionable
                  </h3>
                  <div className="mt-3 space-y-3">
                    {(live.games ?? []).map((g: any, i: number) => (
                      <div key={i} className="border-t border-slate-100 pt-3">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="text-sm font-medium text-slate-900">{g.game}</span>
                          <span className="font-mono text-xs tabular-nums text-slate-600">
                            {g.score} · {Math.floor((g.seconds_left ?? 0) / 60)}m left
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-3 font-mono text-xs text-slate-600">
                          <span>model {g.calibrated_model_probability ?? '—'}</span>
                          <span>market {g.market_probability ?? '—'}</span>
                          <span>edge {g.raw_edge ?? '—'}</span>
                          <span className={g.actionable ? 'text-emerald-700' : 'text-slate-400'}>
                            {g.actionable ? 'actionable' : 'not eligible'}
                          </span>
                        </div>
                        {g.blockers?.length > 0 && (
                          <p className="mt-1 text-xs text-slate-500">{g.blockers[0]}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: 'good';
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${
        tone === 'good' ? 'text-emerald-700' : 'text-slate-900'}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

function VenueCard({ title, value, sub, tone }: {
  title: string; value: string; sub?: string; tone?: 'good';
}) {
  return (
    <div className={`rounded-xl border p-4 ${
      tone === 'good' ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-white'}`}>
      <div className="text-xs uppercase tracking-wide text-slate-400">{title}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}
