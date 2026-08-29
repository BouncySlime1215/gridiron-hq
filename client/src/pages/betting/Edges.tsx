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

interface TeaserRouteLeg {
  event_id: string; team: string; opponent: string; matchup: string;
  market_line: number; teased_line: number; type: string; crosses: number[];
}
interface TeaserCandidate {
  candidate_id: string; book: string; american_price: number | null;
  expected_ev: number | null; expected_ticket_probability: number;
  line_age_minutes: number; eligible: boolean; blocked_reasons: string[];
  legs: TeaserRouteLeg[];
}
interface TeaserExecutionBoard {
  status: string; instruction: string; eligible_candidates: number;
  historical: { win_rate: number; legs: number; standard_error: number };
  policy: { operating_price_floor: number; mathematical_break_even_price: number;
    max_line_age_minutes: number; max_price_age_hours: number };
  books: { book: string; qualifying_legs: number; cross_game_pairs: number;
    price: number | null; eligible_price: boolean; blocked_reasons: string[] }[];
  candidates: TeaserCandidate[];
}
interface TeaserExecution {
  id: number; logged_at: string; mode: 'paper' | 'placed'; book: string;
  american_price: number; stake_units: number; expected_ev: number;
  status: string; profit_units: number | null;
  legs: (TeaserRouteLeg & { slot: number; result: string | null;
    team_score: number | null; opponent_score: number | null })[];
}
interface TeaserLedger {
  summary: { tickets: number; paper_tickets: number; placed_tickets: number;
    open_tickets: number; forward_leg_rate: number | null; graded_legs: number;
    placed_profit_units: number };
  executions: TeaserExecution[]; note: string;
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
  capture_triggers?: { by_state: Record<string, number>; reserve: number; note: string };
  book_latency?: { observations: number; target_per_book: number; note: string;
    books: { book: string; observations: number; median_lag_minutes: number; mean_lag_minutes: number; sufficient_evidence: boolean }[] };
}
interface Sgp {
  independent_probability: number; correlated_probability: number;
  correlation_multiplier: number | null;
  fair_odds_independent: number | null; fair_odds_correlated: number | null;
  offered_odds?: number | null; offered_implied_probability?: number | null;
  expected_value_at_offer?: number | null;
  pairwise: { a: string; b: string; correlation: number }[];
  note?: string; error?: string;
}

const pct1 = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const pct2 = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`);
const am = (v: number | null | undefined) => (v == null ? '—' : v > 0 ? `+${v}` : `${v}`);

export default function Edges() {
  // The measured-positive workflow is the default. A live scoreboard is useful,
  // but it is not an edge and should not be the first thing a profit desk opens.
  const [tab, setTab] = useState<'live' | 'teasers' | 'sgp' | 'movement'>('teasers');
  const [price, setPrice] = useState(-110);
  const [priceBook, setPriceBook] = useState('');
  const [teaserBusy, setTeaserBusy] = useState<string | null>(null);
  const [teaserMessage, setTeaserMessage] = useState<string | null>(null);

  const { data: teaserBoard, loading: tLoading, refetch: refetchTeaserBoard } = useApi<TeaserExecutionBoard>(
    tab === 'teasers' ? '/betting/teasers/execution-board' : null);
  const { data: teaserLedger, refetch: refetchTeaserLedger } = useApi<TeaserLedger>(
    tab === 'teasers' ? '/betting/teasers/executions' : null);
  const { data: movement } = useApi<Movement>(tab === 'movement' ? '/betting/execution/movement' : null);
  const { data: live } = useApi<any>(tab === 'live' ? '/nfl-betting/live' : null);
  // Venue costs moved to their own hub surface, where routing and live pricing
  // sit alongside them — they belong together, not buried as a tab.
  // Abstentions and pipeline health moved to Audit > Diagnostics — they are
  // measurements of the system, not edges anyone can act on.

  const saveTeaserPrice = async () => {
    if (!priceBook.trim()) return;
    setTeaserBusy('price'); setTeaserMessage(null);
    try {
      await api('/nfl-betting/teasers/prices', { method: 'POST', body: JSON.stringify({
        book: priceBook.trim(), teaser_points: 6, legs: 2,
        american_price: price, reachable: true,
        notes: 'Manually verified from teaser execution board'
      }) });
      setTeaserMessage(`Verified ${priceBook.trim()} at ${am(price)}.`);
      await refetchTeaserBoard();
    } catch (error: any) { setTeaserMessage(error.message); }
    finally { setTeaserBusy(null); }
  };

  const logTeaser = async (candidate: TeaserCandidate, mode: 'paper' | 'placed') => {
    const key = `${candidate.candidate_id}:${mode}`;
    setTeaserBusy(key); setTeaserMessage(null);
    try {
      await api('/betting/teasers/executions', { method: 'POST', body: JSON.stringify({
        candidate_id: candidate.candidate_id, mode, stake_units: 1
      }) });
      setTeaserMessage(mode === 'placed'
        ? `Recorded a 1-unit ticket at ${candidate.book}. No wager was transmitted by Gridiron HQ.`
        : `Added ${candidate.book} to the forward paper ledger.`);
      await refetchTeaserLedger();
    } catch (error: any) { setTeaserMessage(error.message); }
    finally { setTeaserBusy(null); }
  };

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
        {([['teasers', 'Wong teasers'], ['movement', 'Line movement'], ['sgp', 'Correlation research'], ['live', 'Live scores']] as const)
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
        tLoading || !teaserBoard ? <div className="card p-6 text-sm text-slate-500">Building executable tickets…</div> : (
          <>
            <div className="card p-4 mb-3 border-emerald-200 bg-emerald-50/40">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-white">money gate</span>
                <div>
                  <div className="text-sm font-black text-emerald-950">One ticket · one book · two different games</div>
                  <p className="mt-1 text-xs leading-5 text-emerald-900">{teaserBoard.instruction}</p>
                </div>
              </div>
            </div>

            <div className="grid gap-3 mb-3 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.72fr)]">
              <div className="card p-4">
                <div className="text-xs font-bold uppercase tracking-wide text-slate-400">Forward-safe rule</div>
                <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div><div className="text-xl font-black text-slate-900 tabular-nums">{pct1(teaserBoard.historical.win_rate)}</div><div className="text-[10px] text-slate-500">historical leg rate</div></div>
                  <div><div className="text-xl font-black text-slate-900 tabular-nums">{teaserBoard.historical.legs.toLocaleString()}</div><div className="text-[10px] text-slate-500">graded legs</div></div>
                  <div><div className="text-xl font-black text-rose-700 tabular-nums">{am(teaserBoard.policy.mathematical_break_even_price)}</div><div className="text-[10px] text-slate-500">mathematical stop</div></div>
                  <div><div className="text-xl font-black text-emerald-700 tabular-nums">{am(teaserBoard.policy.operating_price_floor)}</div><div className="text-[10px] text-slate-500">conservative gate</div></div>
                </div>
                <p className="mt-3 text-[11px] leading-5 text-slate-500">
                  The server rejects any stale line, stale price, same-game pair, price below break-even,
                  or price worse than the stricter {am(teaserBoard.policy.operating_price_floor)} operating rule.
                </p>
              </div>

              <div className="card p-4">
                <div className="text-xs font-bold uppercase tracking-wide text-slate-400">Verify a reachable payout</div>
                <div className="mt-2 grid grid-cols-[minmax(0,1fr)_88px] gap-2">
                  <input list="teaser-books" value={priceBook} onChange={event => setPriceBook(event.target.value)}
                    placeholder="Book key, e.g. draftkings" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                  <input type="number" value={price} onChange={event => setPrice(Number(event.target.value))}
                    aria-label="American teaser price" className="rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums" />
                  <datalist id="teaser-books">{teaserBoard.books.map(book => <option key={book.book} value={book.book} />)}</datalist>
                </div>
                <div className="mt-2 flex gap-1">{[-105, -110, -115, -120, -130].map(value => (
                  <button key={value} onClick={() => setPrice(value)} className={`rounded border px-2 py-1 text-[11px] font-bold ${price === value ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'border-slate-200 text-slate-500'}`}>{value}</button>
                ))}</div>
                <button onClick={saveTeaserPrice} disabled={!priceBook.trim() || teaserBusy === 'price'} className="btn-primary mt-3 w-full text-sm">
                  {teaserBusy === 'price' ? 'Verifying…' : 'Save verified price'}
                </button>
                <p className="mt-2 text-[10px] leading-4 text-slate-400">Prices expire after {teaserBoard.policy.max_price_age_hours} hours. Recheck the book before logging a ticket.</p>
              </div>
            </div>

            {teaserMessage && <div className="card p-3 mb-3 text-xs font-medium text-slate-700">{teaserMessage}</div>}

            <div className="card overflow-hidden mb-3">
              <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
                <div><div className="text-sm font-bold text-slate-800">Execution board</div><div className="text-[11px] text-slate-500">{teaserBoard.eligible_candidates} server-validated ticket{teaserBoard.eligible_candidates === 1 ? '' : 's'}</div></div>
                <span className={`ml-auto rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wide ${teaserBoard.status === 'ready' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{teaserStatusLabel(teaserBoard.status)}</span>
              </div>
              {!teaserBoard.candidates.some(candidate => candidate.eligible) ? (
                <div className="p-5">
                  <div className="text-sm font-bold text-slate-700">No executable ticket right now</div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">A ticket needs two qualifying spreads at the same book in different games, a fresh multi-book capture, and a recently verified payout.</p>
                  {teaserBoard.books.length > 0 && <div className="mt-3 space-y-2">{teaserBoard.books.slice(0, 8).map(book => (
                    <button key={book.book} onClick={() => { setPriceBook(book.book); if (book.price != null) setPrice(book.price); }} className="flex w-full items-start gap-3 rounded-lg border border-slate-200 px-3 py-2 text-left hover:border-emerald-300">
                      <span className="text-xs font-black text-slate-800">{book.book}</span>
                      <span className="text-[11px] text-slate-500">{book.qualifying_legs} legs · {book.cross_game_pairs} pairs</span>
                      <span className="ml-auto text-[11px] text-rose-600">{book.blocked_reasons[0] ?? 'No cross-game pair'}</span>
                    </button>
                  ))}</div>}
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {teaserBoard.candidates.filter(candidate => candidate.eligible).slice(0, 20).map(candidate => (
                    <div key={candidate.candidate_id} className="p-4">
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="text-sm font-black text-slate-900">{candidate.book}</span>
                        <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-black tabular-nums text-emerald-800">{am(candidate.american_price)}</span>
                        <span className="text-xs font-bold tabular-nums text-emerald-700">{pct2(candidate.expected_ev)} EV</span>
                        <span className="text-[10px] text-slate-400">lines {Math.round(candidate.line_age_minutes)}m old</span>
                        <div className="ml-auto flex gap-2">
                          <button onClick={() => logTeaser(candidate, 'paper')} disabled={teaserBusy != null} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-700 hover:border-emerald-400">{teaserBusy === `${candidate.candidate_id}:paper` ? 'Logging…' : 'Paper track'}</button>
                          <button onClick={() => logTeaser(candidate, 'placed')} disabled={teaserBusy != null} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700">{teaserBusy === `${candidate.candidate_id}:placed` ? 'Logging…' : 'I placed this'}</button>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">{candidate.legs.map(leg => (
                        <div key={`${leg.event_id}:${leg.team}`} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                          <div className="flex items-baseline gap-2"><span className="text-sm font-black text-slate-900">{leg.team}</span><span className="text-sm tabular-nums text-slate-600">{leg.market_line > 0 ? '+' : ''}{leg.market_line} → <b className="text-emerald-700">{leg.teased_line > 0 ? '+' : ''}{leg.teased_line}</b></span></div>
                          <div className="mt-0.5 text-[10px] text-slate-400">{leg.matchup} · crosses {leg.crosses.join(' & ')}</div>
                        </div>
                      ))}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {teaserLedger && <TeaserForwardLedger ledger={teaserLedger} onSettled={refetchTeaserLedger} />}
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
              {movement.capture_triggers && <p className="mt-2 text-[11px] font-semibold text-emerald-900">Capture dispatcher: {movement.capture_triggers.by_state.captured ?? 0} captured · {movement.capture_triggers.by_state.pending ?? 0} pending · {movement.capture_triggers.by_state.deferred ?? 0} deferred · {movement.capture_triggers.reserve}-credit reserve</p>}
            </div>

            {movement.book_latency && <div className="card p-4 mb-3"><div className="flex items-baseline justify-between gap-2"><h2 className="text-sm font-bold text-slate-800">Book response latency</h2><span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{movement.book_latency.observations} observations</span></div>
              {!movement.book_latency.books.length ? <p className="mt-2 text-xs text-slate-500">{movement.book_latency.note}</p> : <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{movement.book_latency.books.map(book => <div key={book.book} className="rounded-xl border border-slate-200 p-3"><div className="text-xs font-black text-slate-900">{book.book}</div><div className="mt-1 text-xl font-black tabular-nums text-slate-950">{book.median_lag_minutes}m</div><div className="text-[10px] text-slate-500">median · {book.observations}/{movement.book_latency!.target_per_book} preserved moves</div></div>)}</div>}
            </div>}

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
    </div>
  );
}

function teaserStatusLabel(status: string) {
  if (status === 'ready') return 'ready to paper track';
  if (status === 'teaser_prices_required') return 'verify a book payout';
  if (status === 'no_multi_book_spreads') return 'waiting for fresh spreads';
  return 'no eligible ticket';
}

function TeaserForwardLedger({ ledger, onSettled }: { ledger: TeaserLedger; onSettled: () => any }) {
  const s = ledger.summary;
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <div className="text-sm font-bold text-slate-800">Forward execution ledger</div>
        <div className="text-[11px] text-slate-500">Historical evidence stays frozen; every new ticket starts here.</div>
      </div>
      <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-5">
        {[
          ['Tickets', s.tickets], ['Paper', s.paper_tickets], ['Placed', s.placed_tickets],
          ['Forward leg rate', pct1(s.forward_leg_rate)], ['Placed P/L', `${s.placed_profit_units > 0 ? '+' : ''}${s.placed_profit_units}u`]
        ].map(([label, value]) => (
          <div key={String(label)} className="bg-white px-4 py-3">
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
            <div className="mt-0.5 text-lg font-black tabular-nums text-slate-900">{value}</div>
          </div>
        ))}
      </div>
      {!ledger.executions.length ? (
        <div className="p-5 text-sm text-slate-500">No forward tickets yet. Paper-track the first eligible route before risking money.</div>
      ) : (
        <div className="divide-y divide-slate-100">
          {ledger.executions.slice(0, 20).map(ticket => (
            <div key={ticket.id} className="p-4">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`rounded px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${ticket.mode === 'placed' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{ticket.mode}</span>
                <span className="text-sm font-black text-slate-900">{ticket.book}</span>
                <span className="text-xs font-bold tabular-nums text-slate-600">{am(ticket.american_price)} · {ticket.stake_units}u</span>
                <span className={`ml-auto text-xs font-black uppercase ${ticket.status === 'won' ? 'text-emerald-700' : ticket.status === 'lost' ? 'text-rose-700' : 'text-slate-500'}`}>{ticket.status}</span>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">{ticket.legs.map(leg => (
                <div key={leg.event_id} className="text-xs text-slate-600">
                  <b className="text-slate-800">{leg.team}</b> {leg.market_line > 0 ? '+' : ''}{leg.market_line} → <b>{leg.teased_line > 0 ? '+' : ''}{leg.teased_line}</b>
                  {leg.result && <span className="ml-2 uppercase text-slate-400">{leg.result} {leg.team_score}–{leg.opponent_score}</span>}
                </div>
              ))}</div>
              {ticket.status === 'open' && <TicketSettlement ticket={ticket} onSettled={onSettled} />}
            </div>
          ))}
        </div>
      )}
      <div className="border-t border-slate-100 px-4 py-2 text-[10px] leading-4 text-slate-400">{ledger.note}</div>
    </div>
  );
}

function TicketSettlement({ ticket, onSettled }: { ticket: TeaserExecution; onSettled: () => any }) {
  const [scores, setScores] = useState<Record<string, { team: string; opponent: string }>>(
    Object.fromEntries(ticket.legs.map(leg => [leg.event_id, { team: '', opponent: '' }])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (eventId: string, side: 'team' | 'opponent', value: string) =>
    setScores(current => ({ ...current, [eventId]: { ...current[eventId], [side]: value } }));
  const settle = async () => {
    setBusy(true); setError(null);
    try {
      await api(`/betting/teasers/executions/${ticket.id}/settle`, { method: 'POST', body: JSON.stringify({
        scores: ticket.legs.map(leg => ({ event_id: leg.event_id,
          team_score: Number(scores[leg.event_id]?.team),
          opponent_score: Number(scores[leg.event_id]?.opponent) }))
      }) });
      await onSettled();
    } catch (reason: any) { setError(reason.message); }
    finally { setBusy(false); }
  };
  const complete = ticket.legs.every(leg => scores[leg.event_id]?.team !== '' && scores[leg.event_id]?.opponent !== '');
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Enter final scores to grade both legs</div>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        {ticket.legs.map(leg => <div key={leg.event_id}>
          <div className="mb-1 text-[10px] text-slate-500">{leg.team} – {leg.opponent}</div>
          <div className="flex items-center gap-1">
            <input type="number" min="0" value={scores[leg.event_id]?.team ?? ''} onChange={event => update(leg.event_id, 'team', event.target.value)} className="w-14 rounded border border-slate-300 px-2 py-1 text-xs tabular-nums" aria-label={`${leg.team} score`} />
            <span className="text-slate-400">–</span>
            <input type="number" min="0" value={scores[leg.event_id]?.opponent ?? ''} onChange={event => update(leg.event_id, 'opponent', event.target.value)} className="w-14 rounded border border-slate-300 px-2 py-1 text-xs tabular-nums" aria-label={`${leg.opponent} score`} />
          </div>
        </div>)}
        <button disabled={!complete || busy} onClick={settle} className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40">{busy ? 'Grading…' : 'Grade ticket'}</button>
      </div>
      {error && <div className="mt-2 text-xs text-rose-600">{error}</div>}
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
  const [eventKey, setEventKey] = useState('');
  const [book, setBook] = useState('');
  const [offeredOdds, setOfferedOdds] = useState('');
  const [stage, setStage] = useState<'candidate' | 'close'>('candidate');
  const [message, setMessage] = useState<string | null>(null);
  const evidence = useApi<any>('/betting/sgp/quotes');

  const update = (i: number, patch: any) =>
    setLegs(ls => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  const price = async () => {
    setBusy(true);
    try { setResult(await api<Sgp>('/betting/sgp/price', { method: 'POST', body: JSON.stringify({ legs, offered_odds: Number(offeredOdds) || null }) })); }
    catch (e: any) { setResult({ error: e.message } as Sgp); }
    finally { setBusy(false); }
  };

  const record = async () => {
    setBusy(true); setMessage(null);
    try {
      await api('/betting/sgp/quotes', { method: 'POST', body: JSON.stringify({
        event_key: eventKey, book, stage, legs, offered_odds: Number(offeredOdds)
      }) });
      setMessage(`${stage === 'close' ? 'Closing' : 'Candidate'} quote preserved. No wager was transmitted.`);
      await evidence.refetch();
    } catch (error: any) { setMessage(error.message); }
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
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_120px_100px_120px]">
          <input className="input text-xs" value={eventKey} onChange={e => setEventKey(e.target.value)} placeholder="Game / event key" aria-label="SGP event key" />
          <input className="input text-xs" value={book} onChange={e => setBook(e.target.value)} placeholder="Book" aria-label="SGP book" />
          <input className="input text-xs tabular-nums" value={offeredOdds} onChange={e => setOfferedOdds(e.target.value)} placeholder="Odds, +350" aria-label="Offered SGP odds" />
          <select className="input text-xs" value={stage} onChange={e => setStage(e.target.value as 'candidate' | 'close')} aria-label="SGP quote stage"><option value="candidate">Candidate quote</option><option value="close">Closing quote</option></select>
        </div>
        <div className="mt-3 flex flex-wrap gap-2"><button className="btn-primary text-xs" onClick={price} disabled={busy}>
          {busy ? 'Simulating…' : 'Price against offer'}
        </button><button className="btn-ghost text-xs" onClick={record} disabled={busy || !eventKey || !book || !Number(offeredOdds)}>Preserve quote</button></div>
        {message && <div className="mt-2 text-xs text-slate-600">{message}</div>}
        {evidence.data && <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600">Forward SGP evidence: <b>{evidence.data.paired_closes}/50 candidate-close pairs</b> · mean probability CLV {pct2(evidence.data.mean_probability_clv)} · {evidence.data.staking_authority}</div>}
      </div>

      {result?.error && <div className="card p-4 text-sm text-rose-600">{result.error}</div>}

      {result && !result.error && (
        <div className="card p-4">
          <div className="grid grid-cols-2 gap-3 mb-3 sm:grid-cols-4">
            {[['If independent', pct1(result.independent_probability), am(result.fair_odds_independent)],
              ['Correlated', pct1(result.correlated_probability), am(result.fair_odds_correlated)],
              ['Multiplier', `${result.correlation_multiplier}x`,
                (result.correlation_multiplier ?? 1) > 1 ? 'legs move together' : 'legs compete'],
              ['At book offer', pct2(result.expected_value_at_offer), result.offered_odds ? `${am(result.offered_odds)} offered` : 'enter offered odds']
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
