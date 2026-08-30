import { useState } from 'react';
import type { ReactNode } from 'react';
import { api, useApi } from '../../api';

/**
 * The football read, with the statistics compressed into one number.
 *
 * This page exists because of a specific piece of feedback: the old reasoning
 * opened with a paragraph about nineteen component models arguing over a margin,
 * and the only sentences with football in them came last. That ordering is
 * backwards for anyone actually deciding something.
 *
 * So the layout inverts it. A single confidence percentage carries everything
 * the ensemble discussion used to say, and the space goes to the football: who
 * is playing quarterback, who is hurt and how much of the offence they are, what
 * the staff actually calls, what the defence cannot cover, and the weather. The
 * decomposition is shown as a bar per fact, because the point is which fact is
 * driving the read rather than what the total comes to.
 */

export default function FootballFirst({ embedded = false }: { embedded?: boolean } = {}) {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(1);
  const ledger = useApi<any>('/nfl-betting/forward?source=football-first');
  const walk = useApi<any>('/nfl-betting/walk-forward');
  const calib = useApi<any>('/nfl-betting/confidence/calibration');
  const coef = useApi<any>(`/nfl-betting/football-first/coefficients?season=${season}`);
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<any>(null);

  const record = async () => {
    setRecording(true);
    try {
      setRecorded(await api<any>('/nfl-betting/forward/record', {
        method: 'POST', body: JSON.stringify({ season, week })
      }));
      ledger.refetch();
    } finally { setRecording(false); }
  };

  return (
    <div className={embedded ? "space-y-5" : "mx-auto max-w-[1180px] space-y-5"}>
      {/* Suppressed when this renders inside the workbench, which already has a
          page title — two headers stacked is exactly the noise being removed. */}
      <header className={`tr-rise ${embedded ? 'sr-only' : ''}`}>
        <div className="text-[11px] font-black uppercase tracking-[.16em] text-emerald-700">Football first</div>
        <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">
          The football, not the arithmetic
        </h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-600">
          The old model was nineteen statistical estimators arguing about a number, and it lost at
          46.5%. This one starts from facts with mechanical consequences — who is playing
          quarterback, who is hurt, what the staff calls, whether the wind is up — and asks whether
          they predict where the market is wrong. Everything the ensemble discussion used to say is
          now one confidence percentage.
        </p>
      </header>

      {/* The measured state, stated before anything else. */}
      {walk.data && !walk.data.error && <Verdict walk={walk.data} calib={calib.data} />}

      {/* What the fit currently weights. */}
      {coef.data?.fitted && <Coefficients c={coef.data} />}

      {/* The forward ledger — the only evidence that cannot be re-sliced. */}
      <section className="tr-rise" style={{ animationDelay: '120ms' }}>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-black tracking-tight text-slate-950">Forward ledger</h2>
            <p className="mt-0.5 max-w-2xl text-sm leading-6 text-slate-500">
              Recorded before kickoff, append-only, reasoning frozen. The backtest is used up — three
              measurements, all suggestive, none significant — so this is the only evidence left that
              cannot be re-sliced after the fact.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input type="number" value={season} onChange={e => setSeason(Number(e.target.value))}
              aria-label="Season"
              className="w-24 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm tabular-nums" />
            <input type="number" value={week} onChange={e => setWeek(Number(e.target.value))}
              aria-label="Week" min={1} max={18}
              className="w-20 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm tabular-nums" />
            <button onClick={record} disabled={recording}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white transition hover:bg-emerald-700 disabled:opacity-50">
              {recording ? 'Recording…' : 'Record this week'}
            </button>
          </div>
        </div>

        {recorded && (
          <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700">
            Considered {recorded.considered}, recorded <b>{recorded.recorded}</b>
            {recorded.abstained > 0 && <>, abstained on {recorded.abstained}</>}
            {recorded.below_threshold > 0 && <>, {recorded.below_threshold} under the threshold</>}.
            {recorded.why_nothing_recorded && (
              <span className="mt-1 block text-slate-500">{recorded.why_nothing_recorded}</span>
            )}
          </div>
        )}

        {ledger.data && <Ledger d={ledger.data} />}
      </section>
    </div>
  );
}

/**
 * Where the model actually stands, with the number that matters made unavoidable.
 *
 * A win rate on its own invites the reader to compare it to 50%, which is the
 * wrong bar and flatters every losing model. Break-even is drawn as the line and
 * the bar is positioned against it.
 */
function Verdict({ walk, calib }: { walk: any; calib: any }) {
  const rate = walk.win_rate ?? 0;
  const be = walk.break_even ?? 0.5238;
  // Scaled across a narrow window, because everything interesting lives between
  // 45% and 56% and a zero-anchored bar would hide all of it.
  const pos = (v: number) => Math.max(0, Math.min(100, ((v - 0.44) / 0.14) * 100));
  const beats = rate > be;

  return (
    <section className="tr-rise surface-deep rounded-2xl p-5" style={{ animationDelay: '50ms' }}>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-black uppercase tracking-[.15em] text-emerald-300">
            Weekly walk-forward · refit every week on everything known by then
          </div>
          <div className="mt-2 flex items-baseline gap-3">
            <span className={`text-5xl font-black tabular-nums ${beats ? 'text-emerald-300' : 'text-white'}`}>
              {(rate * 100).toFixed(1)}%
            </span>
            <span className="text-sm text-slate-400">
              {walk.wins}–{walk.losses} over {walk.bets} held-out bets
            </span>
          </div>

          <div className="relative mt-4 h-8">
            <div className="absolute inset-x-0 top-3 h-2 rounded-full bg-white/10" />
            <div className={`absolute top-3 h-2 rounded-full ${beats ? 'bg-emerald-400' : 'bg-slate-400'}`}
              style={{ left: 0, width: `${pos(rate)}%` }} />
            <div className="absolute top-0 h-8 w-px bg-amber-300" style={{ left: `${pos(be)}%` }} />
            <div className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[10px] font-bold text-amber-300"
              style={{ left: `${pos(be)}%` }}>
              break-even {(be * 100).toFixed(2)}%
            </div>
          </div>

          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            {beats
              ? `Above break-even by ${walk.vs_break_even_pp} points at z = ${walk.z}. A z below 1.96 still means this could be luck.`
              : `Short of break-even by ${Math.abs(walk.vs_break_even_pp)} points, at z = ${walk.z}. `}
            {Math.abs(walk.z ?? 0) < 1.96 && 'Statistically indistinguishable from break-even either way — which is progress from significantly losing, and is not an edge.'}
          </p>
        </div>

        <div className="grid shrink-0 gap-px overflow-hidden rounded-xl bg-white/10">
          {calib && !calib.error && (
            <div className="bg-slate-900/80 px-4 py-3">
              <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">Confidence bias</div>
              <div className="mt-0.5 text-xl font-black tabular-nums text-white">
                {calib.bias > 0 ? '+' : ''}{(calib.bias * 100).toFixed(1)}pp
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">out of sample, n={calib.n}</div>
            </div>
          )}
          <div className="bg-slate-900/80 px-4 py-3">
            <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">Learning curve</div>
            <div className="mt-0.5 text-xl font-black tabular-nums text-white">
              {walk.learning_curve?.difference_pp > 0 ? '+' : ''}{walk.learning_curve?.difference_pp}pp
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">
              z={walk.learning_curve?.z} · {walk.learning_curve?.significant ? 'real' : 'noise'}
            </div>
          </div>
        </div>
      </div>

      {walk.learning_curve?.reading && (
        <p className="mt-4 border-t border-white/10 pt-3 text-sm leading-6 text-slate-400">
          {walk.learning_curve.reading}
        </p>
      )}
    </section>
  );
}

/** Which football facts the fit weights, drawn so the biggest one is obvious. */
function Coefficients({ c }: { c: any }) {
  const entries = (c.features ?? []).map((f: any) => ({
    ...f, coefficient: c.coefficients?.[f.key] ?? 0
  })).sort((a: any, b: any) => Math.abs(b.coefficient) - Math.abs(a.coefficient));
  const max = Math.max(...entries.map((e: any) => Math.abs(e.coefficient)), 0.001);

  return (
    <section className="tr-rise rounded-2xl border border-slate-200 bg-white p-4" style={{ animationDelay: '90ms' }}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-black tracking-tight text-slate-950">What the model weights</h2>
        <span className="font-mono text-xs text-slate-400">
          fitted on {c.n} games before {c.trained_before_season} · R² {c.r_squared} on the market residual
        </span>
      </div>
      <div className="mt-3 space-y-2.5">
        {entries.map((e: any) => (
          <div key={e.key}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-semibold text-slate-800">{e.label}</span>
              <span className="font-mono text-xs tabular-nums text-slate-500">
                {e.coefficient > 0 ? '+' : ''}{e.coefficient}
              </span>
            </div>
            <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className={`h-full rounded-full ${e.coefficient >= 0 ? 'bg-emerald-600' : 'bg-rose-500'}`}
                style={{ width: `${(Math.abs(e.coefficient) / max) * 100}%` }} />
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-500">{e.story}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 border-t border-slate-100 pt-2 text-xs leading-5 text-slate-500">
        An R² this small is expected against a closing line — most of what remains after it is
        genuine randomness. What matters is whether the remainder is real, and only the forward
        ledger below can decide that.
      </p>
    </section>
  );
}

function Ledger({ d }: { d: any }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-4">
        <Stat label="Open" value={String(d.open ?? 0)} hint="recorded, not yet played" />
        <Stat label="Settled" value={String(d.settled ?? 0)} hint={d.record ?? 'nothing graded yet'} />
        <Stat label="Win rate" value={d.win_rate != null ? `${(d.win_rate * 100).toFixed(1)}%` : '—'}
          hint={`need ${(d.break_even * 100).toFixed(2)}%`} />
        <Stat label="Closing line value"
          value={d.clv?.mean_points != null ? `${d.clv.mean_points > 0 ? '+' : ''}${d.clv.mean_points}` : '—'}
          hint={d.clv ? `${Math.round((d.clv.beat_close_rate ?? 0) * 100)}% beat the close` : 'no closes yet'} />
      </div>

      <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700">
        {d.distance_to_proof?.reading}
      </p>

      {d.clv?.reading && (
        <p className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm leading-6 text-sky-900">
          <b>Closing line value:</b> {d.clv.reading}
        </p>
      )}

      {d.recent?.length > 0 ? (
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-[10px] uppercase tracking-wide text-slate-400">
              <tr className="border-b border-slate-200">
                <th className="px-4 py-2.5 text-left">Game</th>
                <th className="px-4 py-2.5 text-left">Side</th>
                <th className="px-4 py-2.5 text-left">Leading reason</th>
                <th className="px-4 py-2.5 text-right">Lean</th>
                <th className="px-4 py-2.5 text-right">Conf.</th>
                <th className="px-4 py-2.5 text-right">CLV</th>
                <th className="px-4 py-2.5 text-right">Result</th>
              </tr>
            </thead>
            <tbody>
              {d.recent.map((p: any, i: number) => (
                <tr key={i} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2.5 text-slate-700">{p.matchup}</td>
                  <td className="px-4 py-2.5 font-semibold text-slate-900">{p.side}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">{p.leading_reason ?? '—'}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-600">{p.lean}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-600">
                    {p.confidence != null ? `${Math.round(p.confidence * 100)}%` : '—'}
                  </td>
                  <td className={`px-4 py-2.5 text-right font-mono tabular-nums ${
                    p.clv_points > 0 ? 'text-emerald-700' : p.clv_points < 0 ? 'text-rose-700' : 'text-slate-400'}`}>
                    {p.clv_points != null ? `${p.clv_points > 0 ? '+' : ''}${p.clv_points}` : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {p.result
                      ? <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        p.result === 'Won' ? 'bg-emerald-50 text-emerald-800'
                          : p.result === 'Lost' ? 'bg-rose-50 text-rose-800' : 'bg-slate-100 text-slate-600'}`}>
                        {p.result}
                      </span>
                      : <span className="text-xs text-slate-400">open</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm leading-6 text-slate-500">
          Nothing recorded yet. Pick a season and week that has not been played and press
          <b> Record this week</b> — the ledger refuses games that already have a result, which is
          the whole point of it.
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 text-xl font-black tabular-nums text-slate-900">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] leading-4 text-slate-500">{hint}</div>}
    </div>
  );
}
