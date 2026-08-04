import { useState } from 'react';
import { api } from '../../api';

interface Segment {
  dimension: string; segment: string; bets: number;
  win_rate: number | null; units: number; roi: number;
  mean_signed_error: number | null; beats_vig: boolean; z: number;
}
interface SeasonSummary {
  season: number; bets: number; wins: number; losses: number; pushes: number;
  win_rate: number | null; units: number; roi: number; beat_vig: boolean | null; error?: string;
}
interface Training {
  seasons: number[];
  overall: {
    bets: number; wins: number; losses: number; win_rate: number | null;
    units: number; roi: number; break_even_needed: number; beat_vig: boolean | null;
  };
  per_season: SeasonSummary[];
  analysis: { segments: Segment[]; weakest: Segment[]; strongest: Segment[]; note: string };
}

const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const u = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}u`);

/**
 * The training loop, made visible.
 *
 * Replays past seasons betting the model's own picks and grades every one. The
 * headline number is deliberately the ROI against the break-even a -110 bet
 * needs, not the raw win count — 50% looks fine and loses money.
 *
 * The segment table below is where improvement actually comes from: places the
 * model is wrong across many games, not individual losses. Chasing individual
 * losses is how a model ends up perfect on last season and useless on the next.
 */
export default function Training() {
  const [seasons, setSeasons] = useState('2022,2023,2024,2025');
  const [minEdge, setMinEdge] = useState(1.5);
  const [data, setData] = useState<Training | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true); setErr(null); setData(null);
    try {
      setData(await api(`/nfl-betting/replay/train?seasons=${seasons}&min_edge=${minEdge}&min_bets=30`));
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const o = data?.overall;

  return (
    <div>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">Training</h1>
        <div className="flex items-center gap-2 text-xs ml-auto">
          <input className="input py-1 w-44" value={seasons} onChange={e => setSeasons(e.target.value)} />
          <label className="text-slate-500">min edge</label>
          <input type="number" step="0.5" className="input py-1 w-16" value={minEdge}
            onChange={e => setMinEdge(Number(e.target.value))} />
          <button className="btn-primary text-xs" onClick={run} disabled={busy}>
            {busy ? 'Replaying…' : '▶ Replay & analyze'}
          </button>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Replays each season week by week, betting only on information available at the time, then
        looks for where the model is systematically wrong.
      </p>

      {busy && (
        <div className="card p-3 mb-4 text-xs text-slate-500">
          Running the full ensemble on every game of every season selected. This takes about 20 seconds
          per season.
        </div>
      )}
      {err && <div className="card p-3 mb-4 text-xs text-rose-600">{err}</div>}

      {o && (
        <>
          <div className={`card p-3 mb-4 border ${o.beat_vig ? 'border-emerald-300 bg-emerald-50' : 'border-amber-300 bg-amber-50'}`}>
            <div className="text-xs font-bold text-slate-800">
              {o.beat_vig
                ? `Beat the vig — ${pct(o.win_rate)} clears the ${pct(o.break_even_needed)} a -110 bet needs.`
                : `Did not beat the vig — ${pct(o.win_rate)} is below the ${pct(o.break_even_needed)} a -110 bet needs to break even.`}
            </div>
            <p className="text-[11px] text-slate-600 mt-1">
              {o.wins}-{o.losses} across {o.bets} bets for {u(o.units)} ({(o.roi * 100).toFixed(1)}% ROI).
              A win rate near 50% is a losing model once the juice is paid, which is why ROI is the
              number that matters here.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5">
            <Metric label="Bets" value={String(o.bets)} />
            <Metric label="Record" value={`${o.wins}-${o.losses}`} />
            <Metric label="Win rate" value={pct(o.win_rate)} />
            <Metric label="Units" value={u(o.units)} tone={o.units > 0 ? 'good' : 'bad'} />
            <Metric label="ROI" value={`${(o.roi * 100).toFixed(1)}%`} tone={o.roi > 0 ? 'good' : 'bad'} />
          </div>

          <h2 className="text-sm font-bold text-slate-700 mb-2">By season</h2>
          <div className="card overflow-hidden mb-5">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-400">
                <tr>{['Season', 'Bets', 'Record', 'Win rate', 'Units', 'Beat vig'].map((h, i) => (
                  <th key={i} className="text-left font-semibold px-3 py-2">{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data!.per_season.map(s => (
                  <tr key={s.season}>
                    <td className="px-3 py-2 font-semibold text-slate-800">{s.season}</td>
                    <td className="px-3 py-2 tabular-nums">{s.bets ?? '—'}</td>
                    <td className="px-3 py-2 tabular-nums">{s.error ? '—' : `${s.wins}-${s.losses}`}</td>
                    <td className="px-3 py-2 tabular-nums">{pct(s.win_rate)}</td>
                    <td className={`px-3 py-2 tabular-nums font-semibold ${
                      (s.units ?? 0) > 0 ? 'text-emerald-700' : 'text-rose-600'}`}>{u(s.units)}</td>
                    <td className="px-3 py-2">{s.beat_vig ? '✓' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="text-sm font-bold text-slate-700 mb-1">Where it is systematically wrong</h2>
          <p className="text-[11px] text-slate-500 mb-2">
            Sorted worst first. <b>z</b> is how far the segment sits from break-even in standard errors
            — anything inside roughly ±1.5 is consistent with chance and not worth acting on.
            <b> Bias</b> is the average signed error: positive means the model projected too high.
          </p>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-400 sticky top-0">
                  <tr>{['Segment', 'Bets', 'Win rate', 'ROI', 'z', 'Bias'].map((h, i) => (
                    <th key={i} className="text-left font-semibold px-3 py-2 whitespace-nowrap">{h}</th>
                  ))}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data!.analysis.segments.map((s, i) => {
                    const real = Math.abs(s.z) >= 1.5;
                    return (
                      <tr key={i} className={real ? '' : 'opacity-50'}>
                        <td className="px-3 py-1.5">
                          <span className="text-slate-400">{s.dimension}:</span>{' '}
                          <span className="font-semibold text-slate-800">{s.segment}</span>
                        </td>
                        <td className="px-3 py-1.5 tabular-nums">{s.bets}</td>
                        <td className={`px-3 py-1.5 tabular-nums font-semibold ${
                          (s.win_rate ?? 0) >= 0.524 ? 'text-emerald-700' : 'text-rose-600'}`}>{pct(s.win_rate)}</td>
                        <td className="px-3 py-1.5 tabular-nums">{(s.roi * 100).toFixed(1)}%</td>
                        <td className={`px-3 py-1.5 tabular-nums ${real ? 'font-bold text-slate-800' : 'text-slate-400'}`}>
                          {s.z > 0 ? '+' : ''}{s.z.toFixed(2)}
                        </td>
                        <td className="px-3 py-1.5 tabular-nums text-slate-500">
                          {s.mean_signed_error == null ? '—' : `${s.mean_signed_error > 0 ? '+' : ''}${s.mean_signed_error.toFixed(2)}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card p-3 mt-4 text-[11px] text-slate-600">
            <b className="text-slate-800">Why this does not just patch every loss.</b> With 328 variables
            and roughly 270 games a season, some variable always "explains" any individual miss. A model
            tuned that way grades beautifully on the season used to build it and loses money on the next
            one. Only segments with a real sample and a meaningful z are worth acting on — and any
            correction has to be validated on seasons it was not derived from, which is what the
            validate endpoint does.
          </div>
        </>
      )}
    </div>
  );
}

const Metric = ({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) => (
  <div className="card p-3">
    <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
    <div className={`text-lg font-bold ${tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-rose-600' : 'text-slate-800'}`}>
      {value}
    </div>
  </div>
);
