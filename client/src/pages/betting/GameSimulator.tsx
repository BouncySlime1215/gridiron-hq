import { useState } from 'react';
import { useApi } from '../../api';

/**
 * The play-by-play simulator.
 *
 * Everything else in this hub predicts a margin. This plays the game — downs,
 * clock, fourth-down decisions, overtime — thousands of times, and reports the
 * distribution of what happened. Moneyline, spread and total all come off the
 * same simulated games, which is why they can never disagree here.
 *
 * The page leads with what the model gets wrong. It is well calibrated against
 * real NFL scoring and it still does not beat the closing line, and burying
 * that under a confident-looking cover percentage would be the single most
 * misleading thing this page could do.
 */

interface Sim {
  home: string; away: string; trials: number; season: number;
  profile_fell_back?: boolean;
  projection: { home_score: number; away_score: number; margin: number; total: number;
    margin_sd: number; total_sd: number };
  distribution: {
    margin: { p10: number; p25: number; p50: number; p75: number; p90: number };
    total: { p10: number; p25: number; p50: number; p75: number; p90: number };
  };
  key_numbers: { margin: number; probability: number }[];
  moneyline: { home_win: number; tie: number; away_win: number };
  spread: { line: number; home_cover: number; push: number; away_cover: number } | null;
  total: { line: number; over: number; push: number; under: number } | null;
  example_drives: { half: number | string; possession: string; start_yard: number; points: number;
    result: string; plays: number | null; seconds: number | null }[] | null;
  policy_modules: number;
  error?: string; available?: string[];
}
interface Calibration {
  simulated_matchups: number; trials_each: number; actual_games: number; season: number;
  checks: { check: string; simulated: number; actual: number; gap: number; tolerance: number; pass: boolean }[];
  calibrated: boolean; failing: string[]; note: string;
}
interface Backtest {
  season: number; games_tested: number; profiles_from_season: number;
  simulator_mae: number; market_mae: number; difference: number; beats_market: boolean;
  ats: { record: string; rate: number; break_even_at_minus_110: number; profitable: boolean } | null;
  verdict: string; note: string; error?: string;
}
interface Modules {
  count: number;
  modules: { id: string; n: number; name: string; source: string; what: string }[];
  by_source: Record<string, string[]>;
  note: string;
}
interface Pbp {
  plays: number; games: number; last_fetched: string | null;
  by_season: { season: number; games: number; plays: number }[];
  by_type: { play_type: string; n: number }[];
  source: string; ready_for_audit: boolean;
}

const pct = (v: number | null | undefined) =>
  v == null ? '—' : `${(v * 100).toFixed(1)}%`;
const TEAMS = ['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB',
  'HOU', 'IND', 'JAX', 'KC', 'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI',
  'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WSH'];

type View = 'run' | 'honesty' | 'modules' | 'feed';

export default function GameSimulator() {
  const [view, setView] = useState<View>('run');
  const [home, setHome] = useState('KC');
  const [away, setAway] = useState('BUF');
  const [spread, setSpread] = useState('-2.5');
  const [total, setTotal] = useState('47.5');
  const [submitted, setSubmitted] = useState<string | null>(null);

  const { data: sim, loading } = useApi<Sim>(submitted);
  const { data: cal } = useApi<Calibration>(view === 'honesty' ? '/nfl-betting/sim/calibration?trials=200&games=25' : null);
  const { data: back } = useApi<Backtest>(view === 'honesty' ? '/nfl-betting/sim/backtest?trials=200&games=70' : null);
  const { data: mods } = useApi<Modules>(view === 'modules' ? '/nfl-betting/sim/modules' : null);
  const { data: pbp } = useApi<Pbp>(view === 'feed' ? '/nfl-betting/pbp/status' : null);

  const run = () => {
    const q = new URLSearchParams({ home, away, trials: '8000', drives: '1' });
    if (spread.trim()) q.set('spread', spread.trim());
    if (total.trim()) q.set('total', total.trim());
    setSubmitted(`/nfl-betting/sim/matchup?${q}`);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="text-base font-semibold text-slate-900">Play-by-play simulator</h2>
        <p className="mt-1 text-sm text-slate-600">
          Simulates downs, field position, the clock, fourth-down decisions and overtime — thousands
          of times — and reports the distribution of what happened. The moneyline, the spread and the
          total are all counted off the <em>same</em> simulated games, so they cannot contradict each
          other the way three separately-fitted models can.
        </p>
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <strong>It does not beat the closing line.</strong> Measured walk-forward it is 1.65 points
          worse on margin than the market and 36–48 against the spread. It is well calibrated to real
          NFL scoring, which is a floor, not an edge. Read the Honesty tab before using any number here.
        </p>
      </div>

      <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1">
        {([['run', 'Simulate a game'], ['honesty', 'Does it work?'],
          ['modules', 'Decision modules'], ['feed', 'Live play feed']] as [View, string][]).map(([id, label]) => (
          <button key={id} onClick={() => setView(id)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              view === id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>
            {label}
          </button>
        ))}
      </div>

      {view === 'run' && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <label className="text-xs font-medium text-slate-500">Home
                <select value={home} onChange={e => setHome(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900">
                  {TEAMS.map(t => <option key={t}>{t}</option>)}
                </select>
              </label>
              <label className="text-xs font-medium text-slate-500">Away
                <select value={away} onChange={e => setAway(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900">
                  {TEAMS.map(t => <option key={t}>{t}</option>)}
                </select>
              </label>
              <label className="text-xs font-medium text-slate-500">Home spread
                <input value={spread} onChange={e => setSpread(e.target.value)} placeholder="-2.5"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900" />
              </label>
              <label className="text-xs font-medium text-slate-500">Total
                <input value={total} onChange={e => setTotal(e.target.value)} placeholder="47.5"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900" />
              </label>
              <button onClick={run} disabled={loading}
                className="mt-5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50">
                {loading ? 'Simulating…' : 'Run 8,000 games'}
              </button>
            </div>
          </div>

          {sim?.error && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">{sim.error}</div>
          )}

          {sim && !sim.error && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Card label="Simulated score" value={`${sim.projection.away_score} – ${sim.projection.home_score}`}
                  sub={`${sim.away} at ${sim.home} · ${sim.trials.toLocaleString()} games`} />
                <Card label="Margin" value={sim.projection.margin > 0 ? `${sim.home} by ${sim.projection.margin}` : `${sim.away} by ${Math.abs(sim.projection.margin)}`}
                  sub={`spread of outcomes ±${sim.projection.margin_sd}`} />
                <Card label="Total" value={String(sim.projection.total)} sub={`±${sim.projection.total_sd}`} />
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <h3 className="text-sm font-semibold text-slate-900">Moneyline</h3>
                  <Row k={sim.home} v={pct(sim.moneyline.home_win)} />
                  <Row k={sim.away} v={pct(sim.moneyline.away_win)} />
                  <Row k="Tie" v={pct(sim.moneyline.tie)} muted />
                </div>
                {sim.spread && (
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <h3 className="text-sm font-semibold text-slate-900">Spread {sim.spread.line}</h3>
                    <Row k={`${sim.home} covers`} v={pct(sim.spread.home_cover)} />
                    <Row k={`${sim.away} covers`} v={pct(sim.spread.away_cover)} />
                    <Row k="Push" v={pct(sim.spread.push)} muted />
                  </div>
                )}
                {sim.total && (
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <h3 className="text-sm font-semibold text-slate-900">Total {sim.total.line}</h3>
                    <Row k="Over" v={pct(sim.total.over)} />
                    <Row k="Under" v={pct(sim.total.under)} />
                    <Row k="Push" v={pct(sim.total.push)} muted />
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <h3 className="text-sm font-semibold text-slate-900">Key numbers</h3>
                <p className="mt-1 text-xs text-slate-500">
                  The reason to simulate discrete scoring instead of drawing from a bell curve: real
                  NFL margins pile up on 3 and 7, and a continuous distribution cannot represent that.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {sim.key_numbers.map(k => (
                    <div key={k.margin} className={`rounded-lg px-3 py-2 text-center ${
                      k.margin === 3 || k.margin === 7 ? 'bg-sky-50 ring-1 ring-sky-200' : 'bg-slate-50'}`}>
                      <div className="text-xs text-slate-500">margin {k.margin}</div>
                      <div className="text-sm font-semibold tabular-nums text-slate-900">{pct(k.probability)}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Spread title="Margin range" d={sim.distribution.margin} suffix="" />
                <Spread title="Total range" d={sim.distribution.total} suffix=" pts" />
              </div>

              {sim.example_drives && sim.example_drives.length > 0 && (
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <h3 className="text-sm font-semibold text-slate-900">One simulated game, drive by drive</h3>
                  <p className="mt-1 text-xs text-slate-500">
                    A single trial out of {sim.trials.toLocaleString()} — shown so the engine is
                    inspectable rather than a black box that emits a percentage.
                  </p>
                  <div className="mt-3 max-h-72 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="text-xs uppercase tracking-wide text-slate-400">
                        <tr><th className="py-1 text-left">Half</th><th className="text-left">Off</th>
                          <th className="text-left">Start</th><th className="text-left">Result</th>
                          <th className="text-right">Plays</th><th className="text-right">Pts</th></tr>
                      </thead>
                      <tbody>
                        {sim.example_drives.map((d, i) => (
                          <tr key={i} className="border-t border-slate-100">
                            <td className="py-1 text-slate-500">{d.half}</td>
                            <td className="font-medium text-slate-700">{d.possession === 'home' ? sim.home : sim.away}</td>
                            <td className="text-slate-500 tabular-nums">own {d.start_yard}</td>
                            <td className="text-slate-700">{d.result}</td>
                            <td className="text-right tabular-nums text-slate-500">{d.plays ?? '—'}</td>
                            <td className="text-right tabular-nums font-medium text-slate-900">{d.points || ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {view === 'honesty' && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-slate-900">Does it reproduce real football?</h3>
            {!cal && <p className="mt-2 text-sm text-slate-500">Simulating…</p>}
            {cal && (
              <>
                <table className="mt-3 w-full text-sm">
                  <thead className="text-xs uppercase tracking-wide text-slate-400">
                    <tr><th className="py-1 text-left">Check</th><th className="text-right">Simulated</th>
                      <th className="text-right">Real NFL</th><th className="text-right">Gap</th><th className="text-right">Result</th></tr>
                  </thead>
                  <tbody>
                    {cal.checks.map(c => (
                      <tr key={c.check} className="border-t border-slate-100">
                        <td className="py-1.5 text-slate-700">{c.check}</td>
                        <td className="text-right tabular-nums text-slate-900">{c.simulated}</td>
                        <td className="text-right tabular-nums text-slate-500">{c.actual}</td>
                        <td className="text-right tabular-nums text-slate-500">{c.gap > 0 ? '+' : ''}{c.gap}</td>
                        <td className={`text-right font-medium ${c.pass ? 'text-emerald-700' : 'text-rose-700'}`}>
                          {c.pass ? 'pass' : 'fail'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-3 text-xs text-slate-500">
                  Compared against {cal.actual_games.toLocaleString()} completed games. {cal.note}
                </p>
              </>
            )}
          </div>

          <div className={`rounded-2xl border p-4 ${back && !back.beats_market ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
            <h3 className="text-sm font-semibold text-slate-900">Does it beat the market?</h3>
            {!back && <p className="mt-2 text-sm text-slate-500">Running walk-forward backtest…</p>}
            {back?.error && <p className="mt-2 text-sm text-rose-700">{back.error}</p>}
            {back && !back.error && (
              <>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <Card label="Simulator error" value={`${back.simulator_mae} pts`} sub="mean absolute error" />
                  <Card label="Closing line error" value={`${back.market_mae} pts`} sub="the benchmark" />
                  <Card label="Against the spread" value={back.ats?.record ?? '—'}
                    sub={`${pct(back.ats?.rate)} · need ${pct(back.ats?.break_even_at_minus_110)} at −110`} />
                </div>
                <p className="mt-3 text-sm text-slate-700">{back.verdict}</p>
                <p className="mt-2 text-xs text-slate-500">
                  {back.games_tested} games from {back.season}, simulated from {back.profiles_from_season} profiles
                  only. {back.note}
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {view === 'modules' && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-900">
            {mods?.count ?? 20} strategic decision modules
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            A drive engine that always punts on fourth down and always kicks the extra point is
            simulating a scrimmage, not football. Most of the variance that decides real games lives
            in decisions, and each of these is a computation over game state.
          </p>
          {mods && (
            <div className="mt-4 space-y-2">
              {mods.modules.map(m => (
                <div key={m.id} className="flex gap-3 border-t border-slate-100 pt-2">
                  <div className="w-6 shrink-0 text-right text-xs tabular-nums text-slate-400">{m.n}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-slate-900">{m.name}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                        m.source === 'measured' ? 'bg-emerald-50 text-emerald-700'
                          : m.source === 'derived' ? 'bg-sky-50 text-sky-700' : 'bg-slate-100 text-slate-600'}`}>
                        {m.source}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600">{m.what}</p>
                  </div>
                </div>
              ))}
              <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">{mods.note}</p>
            </div>
          )}
        </div>
      )}

      {view === 'feed' && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-slate-900">Live play-by-play feed</h3>
            <p className="mt-1 text-sm text-slate-600">
              ESPN publishes every play of every game — down, distance, yards to the end zone,
              yardage gained, clock — with no key and no quota. It is polled every three minutes, and
              only for games actually in progress. Each ingested play does two things: it feeds the
              live simulator real game state, and it sharpens the team ratings the pregame model runs
              on, so the model gets better as the season goes rather than standing still.
            </p>
          </div>
          {pbp && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Card label="Plays stored" value={pbp.plays.toLocaleString()} sub={`${pbp.games} games`} />
                <Card label="Last fetched" value={pbp.last_fetched ? new Date(pbp.last_fetched).toLocaleString() : 'never'} sub="polls only during live games" />
                <Card label="Audit corpus" value={pbp.ready_for_audit ? 'ready' : 'building'} sub="validates play distributions" />
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <h4 className="text-sm font-semibold text-slate-900">What is in the corpus</h4>
                <div className="mt-3 flex flex-wrap gap-2">
                  {pbp.by_type.map(t => (
                    <div key={t.play_type} className="rounded-lg bg-slate-50 px-3 py-2">
                      <div className="text-xs text-slate-500">{t.play_type}</div>
                      <div className="text-sm font-semibold tabular-nums text-slate-900">{t.n.toLocaleString()}</div>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs text-slate-500">{pbp.source}</p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

function Row({ k, v, muted }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className="mt-2 flex items-baseline justify-between border-t border-slate-100 pt-2">
      <span className={`text-sm ${muted ? 'text-slate-400' : 'text-slate-700'}`}>{k}</span>
      <span className={`text-sm font-semibold tabular-nums ${muted ? 'text-slate-400' : 'text-slate-900'}`}>{v}</span>
    </div>
  );
}

function Spread({ title, d, suffix }: {
  title: string; suffix: string;
  d: { p10: number; p25: number; p50: number; p75: number; p90: number };
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <div className="mt-3 grid grid-cols-5 gap-1 text-center">
        {([['10th', d.p10], ['25th', d.p25], ['median', d.p50], ['75th', d.p75], ['90th', d.p90]] as [string, number][])
          .map(([k, v]) => (
            <div key={k} className={k === 'median' ? 'rounded-lg bg-slate-100 py-1.5' : 'py-1.5'}>
              <div className="text-[10px] uppercase tracking-wide text-slate-400">{k}</div>
              <div className="text-sm font-semibold tabular-nums text-slate-900">{v}{suffix}</div>
            </div>
          ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        The middle 80% of {title.toLowerCase().replace(' range', '')} outcomes across every simulated game.
      </p>
    </div>
  );
}
