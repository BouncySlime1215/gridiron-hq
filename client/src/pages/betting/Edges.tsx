import { useState } from 'react';
import { api, useApi } from '../../api';

/**
 * The edges that need no prediction.
 *
 * Every other betting surface here is trying to out-forecast the market, and
 * the blind replay says that fight is lost — 0 of 21 component models beat
 * 15,096 closing lines. Everything on this page is a different kind of edge:
 * a structural payout quirk, a correlation the book prices with a blanket
 * haircut, or a reference line that moved. None of it requires being right
 * about a game.
 */

interface TeaserLeg {
  team: string; opponent: string; matchup: string; spread: number;
  teaser: { type: string; from: number; to: number; crosses: number[] };
}
interface Teasers {
  season: number; week: number; games_on_slate: number; quoted_price: number;
  count: number; qualifying_legs: TeaserLeg[];
  historical: { win_rate: number; legs: number; standard_error: number };
  ev: { ev_per_bet: number; break_even: number; z: number | null };
  price_acceptable: boolean;
  staking: { units?: number; blocked?: boolean; reason?: string };
  guidance: string; price_note: string;
}
interface Move {
  observed_at: string; home_team: string; away_team: string;
  prev_home_spread: number | null; home_spread: number | null; spread_delta: number | null;
  prev_total: number | null; total: number | null; total_delta: number | null;
  spread_move_value: number | null;
}
interface Movement {
  status: { rows_logged: number; moves_detected: number; events_tracked: number;
    last_poll: string | null; worth_capturing: number; cost: string; note: string };
  moves: Move[];
  worth_capturing: { matchup: string; max_spread_delta: number; max_move_value: number; move_count: number }[];
}
interface Sgp {
  independent_probability: number; correlated_probability: number;
  correlation_multiplier: number | null;
  fair_odds_independent: number | null; fair_odds_correlated: number | null;
  pairwise: { a: string; b: string; correlation: number }[];
  note?: string; error?: string;
}

const pct1 = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const pct2 = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`);
const am = (v: number | null | undefined) => (v == null ? '—' : v > 0 ? `+${v}` : `${v}`);

export default function Edges() {
  const [tab, setTab] = useState<'live' | 'teasers' | 'sgp' | 'movement' | 'hold' | 'abstentions' | 'pipeline'>('live');
  const [price, setPrice] = useState(-110);

  const { data: teasers, loading: tLoading } = useApi<Teasers>(
    tab === 'teasers' ? `/betting/teasers/candidates?price=${price}` : null);
  const { data: movement } = useApi<Movement>(tab === 'movement' ? '/betting/execution/movement' : null);
  const { data: live } = useApi<any>(tab === 'live' ? '/nfl-betting/live' : null);
  // Both of these were built, tested and left unreachable — routes with no page.
  const { data: hold } = useApi<any>(tab === 'hold' ? '/betting/hold' : null);
  const { data: abst } = useApi<any>(tab === 'abstentions' ? '/betting/abstentions' : null);
  const { data: pipe } = useApi<any>(tab === 'pipeline' ? '/betting/pipeline' : null);
  const { data: lat } = useApi<any>(tab === 'pipeline' ? '/betting/latency' : null);

  return (
    <div>
      <div className="flex items-baseline gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">Edges</h1>
        <span className="text-xs text-slate-400">no forecast required</span>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Structural edges only. A teaser payout that ignores key numbers, a parlay the book prices with a
        blanket correlation haircut, and a free reference line telling us when it is worth spending a
        paid credit. None of these need the model to be right about a game.
      </p>

      <div className="flex gap-1 border-b border-slate-200 mb-4">
        {([['live', 'Live board'], ['teasers', 'Wong teasers'], ['sgp', 'Parlay correlation'], ['movement', 'Line movement'], ['hold', 'Book hold'], ['abstentions', 'Abstention audit'], ['pipeline', 'Data pipeline']] as const)
          .map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
              tab === id ? 'border-emerald-500 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}>{label}</button>
        ))}
      </div>

      {tab === 'live' && (
        !live ? <div className="card p-6 text-sm text-slate-500">Reading the scoreboard…</div>
        : live.error ? <div className="card p-6 text-sm text-rose-600">{live.error}</div>
        : (
          <>
            <div className="card p-3 mb-3 border-emerald-200 bg-emerald-50/40">
              <p className="text-xs text-emerald-900">
                {live.cost} · {live.live_count > 0
                  ? `${live.live_count} game${live.live_count === 1 ? '' : 's'} in progress`
                  : 'No games in progress — showing the slate with pregame win probability'}
              </p>
            </div>
            <div className="card overflow-hidden">
              <div className="divide-y divide-slate-100">
                {live.games.map((g: any) => (
                  <div key={g.event_id} className="grid gap-3 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-black text-slate-900">{g.matchup}</span>
                        {g.state === 'in' && (
                          <span className="text-[10px] font-black uppercase tracking-wide text-rose-600">● live</span>
                        )}
                        <span className="text-[11px] text-slate-500">{g.status}</span>
                      </div>
                      {g.down_distance && (
                        <div className="text-[11px] text-slate-500 mt-0.5">{g.possession} · {g.down_distance}</div>
                      )}
                    </div>
                    <div className="text-right tabular-nums">
                      <div className="text-sm font-bold text-slate-800">
                        {g.away_score != null ? `${g.away_score} – ${g.home_score}` : '—'}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {g.pregame_spread != null ? `line ${g.pregame_spread}` : 'no line'}
                      </div>
                    </div>
                    <div className="text-right w-24">
                      <div className={`text-base font-black tabular-nums ${g.probability_reliable ? 'text-slate-900' : 'text-slate-400'}`}>
                        {(g.home_win_probability * 100).toFixed(0)}%
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden mt-1">
                        <div className="h-full rounded-full bg-emerald-500"
                          style={{ width: `${Math.max(2, g.home_win_probability * 100)}%` }} />
                      </div>
                      <div className="text-[10px] text-slate-400 mt-0.5">
                        {g.home_team} win{!g.probability_reliable && g.state === 'in' ? ' · rough' : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">{live.note}</p>
          </>
        )
      )}

      {tab === 'teasers' && (
        tLoading || !teasers ? <div className="card p-6 text-sm text-slate-500">Checking the slate…</div> : (
          <>
            <div className="card p-4 mb-3">
              <div className="flex items-center gap-3 flex-wrap">
                <label className="text-xs font-bold uppercase tracking-wide text-slate-500">
                  Your book&apos;s price
                </label>
                <div className="flex gap-1">
                  {[-105, -110, -115, -120, -130].map(p => (
                    <button key={p} onClick={() => setPrice(p)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold tabular-nums border transition-colors ${
                        price === p ? 'border-emerald-500 bg-emerald-50 text-emerald-800'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-300'}`}>{p}</button>
                  ))}
                </div>
              </div>
              <p className="text-[11px] text-slate-500 mt-2">{teasers.price_note}</p>
            </div>

            <div className={`card p-4 mb-3 ${teasers.price_acceptable ? 'border-emerald-300 bg-emerald-50/40' : 'border-rose-300 bg-rose-50/40'}`}>
              <div className="flex items-baseline gap-3 flex-wrap">
                <span className={`text-2xl font-black tabular-nums ${teasers.price_acceptable ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {pct2(teasers.ev.ev_per_bet)}
                </span>
                <span className="text-sm text-slate-600">EV per bet at {am(teasers.quoted_price)}</span>
                <span className="ml-auto text-sm font-bold tabular-nums">
                  {teasers.staking.blocked
                    ? <span className="text-rose-700">0 units — blocked</span>
                    : <span className="text-emerald-700">{teasers.staking.units} units</span>}
                </span>
              </div>
              {teasers.staking.blocked && teasers.staking.reason && (
                <p className="text-xs text-rose-800 mt-2">{teasers.staking.reason}</p>
              )}
              <p className="text-[11px] text-slate-500 mt-2 tabular-nums">
                Historical leg rate {pct1(teasers.historical.win_rate)} on {teasers.historical.legs.toLocaleString()} legs ·
                break-even {pct1(teasers.ev.break_even)} · z {teasers.ev.z?.toFixed(2) ?? '—'}
              </p>
            </div>

            <div className="card overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50">
                <div className="text-sm font-bold text-slate-800">
                  {teasers.count} qualifying leg{teasers.count === 1 ? '' : 's'} · Week {teasers.week}
                </div>
                <div className="text-[11px] text-slate-500">{teasers.guidance}</div>
              </div>
              {!teasers.qualifying_legs.length ? (
                <div className="p-6 text-sm text-slate-500">
                  No spread on this slate sits in the qualifying window (favourite −7.5 to −8.5, or underdog +1.5 to +2.5).
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {teasers.qualifying_legs.map((l, i) => (
                    <div key={i} className="flex items-center gap-3 px-4 py-2.5 flex-wrap">
                      <span className="text-sm font-black text-slate-900 w-12">{l.team}</span>
                      <span className="text-sm tabular-nums text-slate-600">
                        {l.spread > 0 ? '+' : ''}{l.spread}
                        <span className="text-slate-400 mx-1.5">→</span>
                        <span className="font-bold text-emerald-700">{l.teaser.to > 0 ? '+' : ''}{l.teaser.to}</span>
                      </span>
                      <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{l.teaser.type}</span>
                      {l.teaser.crosses.length > 0 && (
                        <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
                          crosses {l.teaser.crosses.join(' & ')}
                        </span>
                      )}
                      <span className="text-[11px] text-slate-400 ml-auto">{l.matchup}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )
      )}

      {tab === 'sgp' && <SgpCalculator />}

      {tab === 'movement' && (
        !movement ? <div className="card p-6 text-sm text-slate-500">Loading the movement log…</div> : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              {[['Events tracked', movement.status.events_tracked],
                ['Moves detected', movement.status.moves_detected],
                ['Worth a credit', movement.status.worth_capturing],
                ['Last poll', movement.status.last_poll
                  ? new Date(movement.status.last_poll).toLocaleTimeString() : '—']
              ].map(([k, v]) => (
                <div key={String(k)} className="card p-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{k}</div>
                  <div className="text-lg font-black text-slate-900 tabular-nums">{v}</div>
                </div>
              ))}
            </div>
            <div className="card p-3 mb-3 border-emerald-200 bg-emerald-50/40">
              <p className="text-xs text-emerald-900">{movement.status.cost}</p>
              <p className="text-[11px] text-slate-600 mt-1">{movement.status.note}</p>
            </div>

            {movement.worth_capturing.length > 0 && (
              <div className="card p-4 mb-3">
                <h2 className="text-sm font-bold text-slate-700 mb-2">Spend a credit here</h2>
                <div className="space-y-1.5">
                  {movement.worth_capturing.map((w, i) => (
                    <div key={i} className="flex items-baseline gap-2 text-sm">
                      <span className="font-bold text-slate-800">{w.matchup}</span>
                      <span className="text-xs text-slate-500 tabular-nums">
                        moved {w.max_spread_delta} pt{w.max_spread_delta === 1 ? '' : 's'} · worth {pct1(w.max_move_value)}
                      </span>
                      <span className="text-[11px] text-slate-400 ml-auto">{w.move_count} move{w.move_count === 1 ? '' : 's'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="card overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50">
                <div className="text-sm font-bold text-slate-800">Movement log</div>
                <div className="text-[11px] text-slate-500">A row is written only when a number actually changed.</div>
              </div>
              {!movement.moves.length ? (
                <div className="p-6 text-sm text-slate-500">
                  Nothing has moved since polling began. The log fills as the market re-prices.
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {movement.moves.map((m, i) => (
                    <div key={i} className="flex items-center gap-3 px-4 py-2 flex-wrap text-sm">
                      <span className="font-bold text-slate-800 w-28">{m.away_team} at {m.home_team}</span>
                      {m.spread_delta ? (
                        <span className="tabular-nums text-slate-600">
                          {m.prev_home_spread} <span className="text-slate-400 mx-1">→</span>
                          <span className="font-bold">{m.home_spread}</span>
                          <span className={`ml-2 text-xs font-bold ${Math.abs(m.spread_move_value ?? 0) >= 0.03 ? 'text-emerald-700' : 'text-slate-400'}`}>
                            worth {pct1(m.spread_move_value)}
                          </span>
                        </span>
                      ) : null}
                      {m.total_delta ? (
                        <span className="tabular-nums text-xs text-slate-500">
                          total {m.prev_total} → {m.total}
                        </span>
                      ) : null}
                      <span className="text-[11px] text-slate-400 ml-auto">
                        {new Date(m.observed_at).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )
      )}
      {tab === 'hold' && (
        !hold ? <div className="card p-6 text-sm text-slate-500">Measuring book hold…</div>
        : hold.error ? <div className="card p-6 text-sm text-rose-600">{hold.error}</div>
        : (
          <>
            <div className="card p-4 mb-3">
              <h2 className="font-semibold text-slate-900">What each book charges you</h2>
              <p className="text-sm text-slate-600 mt-1">
                Hold is the book's cut: the two sides' implied probabilities summed, minus one. It is the
                most reliable edge on this whole page because it needs no opinion about any game — the
                spread between the cheapest and dearest book comes straight off your required win rate.
              </p>
            </div>
            <div className="card p-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-400">
                  <tr><th className="py-1 text-left">Book</th><th className="text-right">Hold</th>
                    <th className="text-right">Break-even</th><th className="text-right">Markets</th></tr>
                </thead>
                <tbody>
                  {(hold.hold?.books ?? []).map((b: any) => (
                    <tr key={b.book} className="border-t border-slate-100">
                      <td className="py-1.5 font-medium text-slate-800">{b.book}</td>
                      <td className="text-right tabular-nums text-slate-900">
                        {b.hold == null ? '—' : (b.hold * 100).toFixed(2) + '%'}</td>
                      <td className="text-right tabular-nums text-slate-600">
                        {b.break_even == null ? '—' : (b.break_even * 100).toFixed(2) + '%'}</td>
                      <td className="text-right tabular-nums text-slate-400">{b.markets_measured ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {hold.hold?.spread_in_hold != null && (
                <p className="mt-3 text-sm text-slate-700">
                  Cheapest is <strong>{hold.hold.best_book}</strong>, dearest is <strong>{hold.hold.worst_book}</strong> —
                  a spread of <strong>{(hold.hold.spread_in_hold * 100).toFixed(2)}pp</strong> in hold, worth
                  {' '}<strong>{(hold.hold.win_rate_saved * 100).toFixed(2)}pp</strong> off the win rate you need.
                  That is free, today, and requires being right about nothing.
                </p>
              )}
              {hold.hold?.note && <p className="mt-2 text-xs text-slate-500">{hold.hold.note}</p>}
            </div>
            {hold.comparison && (
              <div className="card p-4 mt-3">
                <h3 className="text-sm font-semibold text-slate-900">Sides vs player props</h3>
                <p className="mt-1 text-sm text-slate-700">
                  Cheapest NFL side is <strong>{hold.comparison.nfl_cheapest.book}</strong> at{' '}
                  {(hold.comparison.nfl_cheapest.hold * 100).toFixed(2)}%; cheapest MLB prop is{' '}
                  <strong>{hold.comparison.mlb_cheapest.book}</strong> at{' '}
                  {(hold.comparison.mlb_cheapest.hold * 100).toFixed(2)}% — a prop premium of{' '}
                  <strong>{(hold.comparison.prop_premium * 100).toFixed(2)}pp</strong>.
                </p>
                <p className="mt-2 text-xs text-slate-500">{hold.comparison.note}</p>
              </div>
            )}
          </>
        )
      )}

      {tab === 'abstentions' && (
        !abst ? <div className="card p-6 text-sm text-slate-500">Grading the games the policy refused…</div>
        : abst.error ? <div className="card p-6 text-sm text-rose-600">{abst.error}</div>
        : (
          <>
            <div className="card p-4 mb-3">
              <h2 className="font-semibold text-slate-900">Did declining actually help?</h2>
              <p className="text-sm text-slate-600 mt-1">
                Every abstention is a claim of skill — that the policy knew which games not to touch. This
                grades the refused games anyway and compares them to the ones it took. If the two rates
                are the same, the filter is costing opportunities and buying nothing.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {(['taken', 'declined'] as const).map(k => abst[k] && (
                <div key={k} className="card p-4">
                  <div className="text-xs uppercase tracking-wide text-slate-400">{k}</div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
                    {abst[k].win_rate == null ? '—' : (abst[k].win_rate * 100).toFixed(1) + '%'}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {abst[k].wins}-{abst[k].losses} · {abst[k].settled} settled
                    {abst[k].win_rate_95 && ` · 95% CI ${(abst[k].win_rate_95[0] * 100).toFixed(1)}–${(abst[k].win_rate_95[1] * 100).toFixed(1)}%`}
                  </div>
                </div>
              ))}
            </div>
            {abst.selection_works && (
              <div className="card p-4 mt-3">
                <p className="text-sm text-slate-700">
                  {abst.selection_works.verdict ?? (abst.selection_works.significant
                    ? 'The games the policy took beat the ones it declined by more than chance.'
                    : 'Taken and declined games are statistically indistinguishable — the filter is not buying selection skill.')}
                </p>
                {abst.selection_works.p_value != null && (
                  <p className="mt-1 text-xs text-slate-500">
                    Two-proportion test p = {abst.selection_works.p_value.toFixed(3)} · break-even {(abst.break_even * 100).toFixed(2)}%
                  </p>
                )}
              </div>
            )}
            {Array.isArray(abst.by_reason) && abst.by_reason.length > 0 && (
              <div className="card p-4 mt-3 overflow-x-auto">
                <h3 className="text-sm font-semibold text-slate-900">Why each game was declined</h3>
                <table className="w-full text-sm mt-2">
                  <thead className="text-xs uppercase tracking-wide text-slate-400">
                    <tr><th className="py-1 text-left">Reason</th><th className="text-right">Settled</th>
                      <th className="text-right">Record</th><th className="text-right">Win rate</th></tr>
                  </thead>
                  <tbody>
                    {abst.by_reason.map((r: any) => (
                      <tr key={r.reason} className="border-t border-slate-100">
                        <td className="py-1.5 text-slate-700">{String(r.reason).replace(/_/g, ' ')}</td>
                        <td className="text-right tabular-nums text-slate-500">{r.settled}</td>
                        <td className="text-right tabular-nums text-slate-600">{r.wins}-{r.losses}</td>
                        <td className="text-right tabular-nums text-slate-900">
                          {r.win_rate == null ? '—' : (r.win_rate * 100).toFixed(1) + '%'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {abst.note && <p className="mt-2 text-xs text-slate-500">{abst.note}</p>}
          </>
        )
      )}

      {tab === 'pipeline' && (
        <>
          <div className="card p-4 mb-3">
            <h2 className="font-semibold text-slate-900">Do we learn things before the market does?</h2>
            <p className="text-sm text-slate-600 mt-1">
              Five seasons say the closing line cannot be out-forecast with public data. What is not
              settled is <em>latency</em>: a line ten minutes after a beat reporter tweets has not
              absorbed that tweet. Edge there is not “we predict better”, it is “we knew at 14:02 and
              the number did not move until 14:40”. This grades signals against subsequent movement,
              which is observable in hours instead of seasons — and costs nothing, because it uses the
              free ESPN reference line rather than the metered odds feed.
            </p>
          </div>

          {lat && (
            <div className={`card p-4 mb-3 ${lat.sufficient_evidence ? '' : 'border-amber-200 bg-amber-50/50'}`}>
              <div className="grid gap-3 sm:grid-cols-4">
                <Stat label="Signals examined" value={String(lat.signals_examined ?? '—')} />
                <Stat label="Moves in log" value={String(lat.line_moves_in_log ?? '—')} />
                <Stat label="Directional matches" value={String(lat.directional_signals ?? '—')} />
                <Stat label="Agreement rate"
                  value={lat.agreement_rate == null ? '—' : (lat.agreement_rate * 100).toFixed(0) + '%'} />
              </div>
              <p className="mt-3 text-sm text-slate-800">{lat.verdict}</p>
              <p className="mt-2 text-xs text-slate-500">{lat.note}</p>
            </div>
          )}

          {pipe && (
            <>
              <div className="card p-4 mb-3">
                <h3 className="text-sm font-semibold text-slate-900">What is actually running</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Free feeds poll on a 90-second tick; metered ones on 30 minutes so credits are not
                  burned; heavy compute stays off unless explicitly enabled.
                  {' '}Scheduler {pipe.scheduler?.running ? 'running' : 'stopped'} ·
                  {' '}live timer {pipe.scheduler?.live_timer_running ? 'on' : 'off'}.
                </p>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs uppercase tracking-wide text-slate-400">
                      <tr><th className="py-1 text-left">Job</th><th className="text-left">Tier</th>
                        <th className="text-right">Runs</th><th className="text-right">Age</th>
                        <th className="text-right">State</th></tr>
                    </thead>
                    <tbody>
                      {(pipe.scheduler?.jobs ?? []).map((j: any) => (
                        <tr key={j.job} className="border-t border-slate-100">
                          <td className="py-1.5 text-slate-700">{j.job}</td>
                          <td>
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                              j.tier === 'live' ? 'bg-emerald-50 text-emerald-700'
                                : j.tier === 'metered' ? 'bg-amber-50 text-amber-700'
                                : 'bg-slate-100 text-slate-500'}`}>{j.tier}</span>
                          </td>
                          <td className="text-right tabular-nums text-slate-600">{j.runs ?? 0}</td>
                          <td className="text-right tabular-nums text-slate-500">
                            {j.age_minutes == null ? 'never'
                              : j.age_minutes < 60 ? `${j.age_minutes}m`
                              : `${(j.age_minutes / 60).toFixed(1)}h`}</td>
                          <td className={`text-right text-xs font-medium ${
                            j.runs === 0 ? 'text-rose-700' : j.stale ? 'text-amber-700' : 'text-emerald-700'}`}>
                            {j.runs === 0 ? 'never run' : j.stale ? 'stale' : 'fresh'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="card p-4">
                <h3 className="text-sm font-semibold text-slate-900">What has actually landed</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Row counts matter more than run counts — a job that runs on time into a table nothing
                  reads is a log, not a pipeline.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {Object.entries(pipe.row_counts ?? {}).map(([t, n]) => (
                    <div key={t} className="rounded-lg bg-slate-50 px-3 py-2">
                      <div className="text-xs text-slate-500">{t}</div>
                      <div className="text-sm font-semibold tabular-nums text-slate-900">
                        {n == null ? '—' : Number(n).toLocaleString()}</div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </>
      )}

    </div>
  );
}

/**
 * Two-leg parlay pricer. Marginals are entered by hand from the book's own
 * no-vig prices, which is the point: holding the legs fixed at the book's own
 * numbers isolates the correlation, so any disagreement is about the joint
 * distribution rather than about who is right on a single leg.
 */
function SgpCalculator() {
  const [legs, setLegs] = useState([
    { player: 'QB', team: 'A', position: 'QB', stat: 'passing_yards', side: 'over', probability: 0.5 },
    { player: 'WR', team: 'A', position: 'WR', stat: 'receiving_yards', side: 'over', probability: 0.5 }
  ]);
  const [result, setResult] = useState<Sgp | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (i: number, patch: any) =>
    setLegs(ls => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  const price = async () => {
    setBusy(true);
    try { setResult(await api<Sgp>('/betting/sgp/price', { method: 'POST', body: JSON.stringify({ legs }) })); }
    catch (e: any) { setResult({ error: e.message } as Sgp); }
    finally { setBusy(false); }
  };

  const STATS = ['passing_yards', 'rushing_yards', 'receiving_yards', 'receptions', 'anytime_td'];

  return (
    <>
      <div className="card p-4 mb-3">
        <h2 className="text-sm font-bold text-slate-700 mb-0.5">Two-leg same-game parlay</h2>
        <p className="text-[11px] text-slate-500 mb-3">
          Enter each leg&apos;s marginal probability from the book&apos;s own no-vig price. Same team means
          the legs are correlated; the copula prices that instead of multiplying them.
        </p>
        <div className="space-y-2">
          {legs.map((l, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[70px_60px_1fr_80px_80px] items-center">
              <input className="input text-xs" value={l.player} onChange={e => update(i, { player: e.target.value })} placeholder="Name" />
              <select className="input text-xs" value={l.team} onChange={e => update(i, { team: e.target.value })}>
                <option value="A">Team A</option><option value="B">Team B</option>
              </select>
              <select className="input text-xs" value={l.stat}
                onChange={e => {
                  const stat = e.target.value;
                  const pos = stat === 'passing_yards' ? 'QB' : stat === 'rushing_yards' ? 'RB' : l.position;
                  update(i, { stat, position: pos });
                }}>
                {STATS.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
              <select className="input text-xs" value={l.side} onChange={e => update(i, { side: e.target.value })}>
                <option value="over">over</option><option value="under">under</option>
              </select>
              <input className="input text-xs tabular-nums" type="number" step="0.01" min="0.01" max="0.99"
                value={l.probability} onChange={e => update(i, { probability: Number(e.target.value) })} />
            </div>
          ))}
        </div>
        <button className="btn-primary text-xs mt-3" onClick={price} disabled={busy}>
          {busy ? 'Simulating…' : 'Price it'}
        </button>
      </div>

      {result?.error && <div className="card p-4 text-sm text-rose-600">{result.error}</div>}

      {result && !result.error && (
        <div className="card p-4">
          <div className="grid grid-cols-3 gap-3 mb-3">
            {[['If independent', pct1(result.independent_probability), am(result.fair_odds_independent)],
              ['Correlated', pct1(result.correlated_probability), am(result.fair_odds_correlated)],
              ['Multiplier', `${result.correlation_multiplier}x`,
                (result.correlation_multiplier ?? 1) > 1 ? 'legs move together' : 'legs compete']
            ].map(([k, v, d]) => (
              <div key={k}>
                <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{k}</div>
                <div className="text-xl font-black text-slate-900 tabular-nums">{v}</div>
                <div className="text-[11px] text-slate-500">{d}</div>
              </div>
            ))}
          </div>
          <div className="border-t border-slate-100 pt-2 space-y-1">
            {result.pairwise.map((p, i) => (
              <div key={i} className="text-[11px] text-slate-500 tabular-nums">
                ρ = <span className="font-bold text-slate-700">{p.correlation}</span> · {p.a} vs {p.b}
              </div>
            ))}
          </div>
          {result.note && <p className="text-[11px] text-slate-400 mt-2">{result.note}</p>}
        </div>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}
