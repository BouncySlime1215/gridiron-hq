import { useEffect, useState } from 'react';
import { api, useApi } from '../../api';
import { Notice, SectionHeading, StatusPill } from '../../components/betting/BettingUI';

interface Segment {
  dimension: string; segment: string; bets: number;
  win_rate: number | null; units: number; roi: number;
  mean_signed_error: number | null; beats_vig: boolean; z: number;
}
interface SeasonSummary {
  season: number; bets: number; wins: number; losses: number; pushes: number;
  win_rate: number | null; units: number; roi: number; beat_vig: boolean | null; error?: string;
}
interface Uncertainty {
  method?: string; clusters?: number; trials?: number;
  win_rate_95: [number | null, number | null];
  roi_95: [number | null, number | null];
  probability_roi_above_zero: number | null;
  sample_warning: string | null;
}
interface Training {
  seasons: number[];
  overall: {
    bets: number; wins: number; losses: number; win_rate: number | null;
    units: number; roi: number; break_even_needed: number; beat_vig: boolean | null;
    uncertainty?: Uncertainty;
  };
  per_season: SeasonSummary[];
  equity_curve: { week: string; week_units: number; cumulative_units: number }[];
  analysis: { segments: Segment[]; weakest: Segment[]; strongest: Segment[]; note: string };
}
interface Protocol {
  production_baseline: { id: string; version: string; minEdge: number; maxDisagreement: number; maxPicksPerWeek: number; markets: string[]; modelOptions: { weighting: string } };
  supported_weightings: string[]; supported_families: string[]; rules: string[];
}
interface Experiment { id: number; name: string; hypothesis: string; created_at: string; verdict: string | null; validation_passed: boolean | null; holdout: unknown; }
interface Calibration {
  model_version: string; trained_from: number; trained_through: number; created_at: string; sample_size: number;
  edge_slope: number; metrics: { walk_forward_n: number; walk_forward_calibrated_brier: number | null;
    walk_forward_market_brier: number | null; forward_gate_passed: boolean };
  reliability: { range: string; n: number; predicted: number | null; actual: number | null }[];
}

const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const u = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}u`);

/**
 * The training loop, made visible.
 *
 * Replays past seasons betting the model's own picks and grades every one. The
 * headline number is ROI settled at each stored historical price, not a
 * synthetic flat -110 assumption.
 *
 * The segment table below is where improvement actually comes from: places the
 * model is wrong across many games, not individual losses. Chasing individual
 * losses is how a model ends up perfect on last season and useless on the next.
 */
export default function Training() {
  const [seasons, setSeasons] = useState('2021,2022,2023,2024,2025');
  const [data, setData] = useState<Training | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { data: protocol } = useApi<Protocol>('/nfl-betting/experiments/protocol');
  const { data: registry } = useApi<{ experiments: Experiment[] }>('/nfl-betting/experiments');
  const { data: calibrationPayload } = useApi<{ calibration: Calibration | null }>('/nfl-betting/calibration/cover');
  const { data: latestAudit } = useApi<{ audit: { result: Training } | null }>('/nfl-betting/replay/latest');
  const calibration = calibrationPayload?.calibration;
  useEffect(() => { if (!data && latestAudit?.audit?.result) setData(latestAudit.audit.result); }, [latestAudit, data]);

  const run = async () => {
    setBusy(true); setErr(null); setData(null);
    try {
      const saved = await api(`/nfl-betting/replay/train?seasons=${seasons}&min_bets=25`, { method: 'POST' });
      setData(saved.result);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const o = data?.overall;

  return (
    <div>
      <div className="flex items-end gap-3 mb-4 flex-wrap">
        <SectionHeading eyebrow="Evidence lab" title="Blind replay"
          description="Replay frozen policies chronologically and inspect uncertainty before any candidate reaches a holdout." />
        <div className="flex items-end gap-2 text-sm ml-auto flex-wrap">
          <label className="text-slate-500"><span className="block text-xs font-bold mb-1">Research seasons</span>
            <input aria-label="Replay seasons" className="input py-2 w-52" value={seasons} onChange={e => setSeasons(e.target.value)} />
          </label>
          <button className="btn-primary text-xs" onClick={run} disabled={busy}>
            {busy ? 'Replaying…' : '▶ Replay & analyze'}
          </button>
        </div>
      </div>
      <Notice title="Exact production-policy replay" tone="info">
        This audit uses the same versioned spread-only policy, three-point edge floor, disagreement guard, weekly five-pick cap, ranking rule, and stored prices as the live decision desk.
      </Notice>

      {protocol && (
        <div className="card my-5 border-slate-300 bg-slate-50 p-4">
          <div className="text-xs font-black uppercase tracking-wide text-slate-600">Locked improvement protocol</div>
          <div className="grid md:grid-cols-2 gap-4 mt-2">
            <ol className="list-decimal pl-4 space-y-2 text-sm leading-5 text-slate-600">
              {protocol.rules.map((rule, i) => <li key={i}>{rule}</li>)}
            </ol>
            <div className="text-sm leading-5 text-slate-600">
              <div><b>Production:</b> {protocol.production_baseline.id}@{protocol.production_baseline.version} · {protocol.production_baseline.minEdge}+ edge · ≤{protocol.production_baseline.maxDisagreement} disagreement · max {protocol.production_baseline.maxPicksPerWeek}/week · {protocol.production_baseline.modelOptions.weighting} weighting</div>
              <div className="mt-2"><b>Testable weighting:</b> {protocol.supported_weightings.join(', ')}</div>
              <div className="mt-1"><b>Ablation families:</b> {protocol.supported_families.join(', ')}</div>
            </div>
          </div>
        </div>
      )}

      {!!registry?.experiments?.length && (
        <div className="card overflow-hidden mb-5">
          <div className="px-3 py-2 bg-slate-50 border-b text-xs font-bold text-slate-700">Immutable experiment registry</div>
          <div className="divide-y divide-slate-100">
            {registry.experiments.map(x => <div key={x.id} className="px-4 py-3 text-sm flex flex-col gap-2 lg:flex-row lg:items-center"><b>#{x.id} {x.name}</b><span className="text-slate-500">{x.hypothesis}</span><span className="lg:ml-auto"><StatusPill tone={x.validation_passed ? 'good' : x.verdict ? 'warn' : 'neutral'}>{x.verdict ?? 'Locked; not run'}</StatusPill></span></div>)}
          </div>
        </div>
      )}

      {busy && (
        <div className="card p-3 mb-4 text-xs text-slate-500">
          Running the full ensemble on every game of every season selected. This takes about 20 seconds
          per season.
        </div>
      )}
      {err && <div className="card p-3 mb-4 text-xs text-rose-600">{err}</div>}

      {o && (
        <>
          <div className={`card mb-4 border p-3 ${o.beat_vig ? 'border-slate-300 bg-slate-50' : 'border-slate-300 bg-white'}`}>
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

          {!!data!.equity_curve?.length && <EquityCurve points={data!.equity_curve} />}

          {calibration && <CalibrationPanel calibration={calibration} />}

          {o.uncertainty && (
            <div className={`card p-4 mb-5 border ${
              (o.uncertainty.roi_95?.[0] ?? -1) > 0 ? 'border-slate-300 bg-slate-50' : 'border-blue-200 bg-blue-50/40'
            }`}>
              <div className="flex items-start gap-3 flex-wrap">
                <div>
                  <div className="text-[10px] font-black uppercase tracking-wide text-slate-500">Uncertainty audit</div>
                  <div className="text-sm font-bold text-slate-800 mt-0.5">
                    ROI 95% interval: {pct(o.uncertainty.roi_95?.[0])} to {pct(o.uncertainty.roi_95?.[1])}
                  </div>
                  <div className="text-[11px] text-slate-600 mt-1">
                    Win-rate interval {pct(o.uncertainty.win_rate_95?.[0])}–{pct(o.uncertainty.win_rate_95?.[1])}
                    {' · '}estimated chance true ROI is positive {pct(o.uncertainty.probability_roi_above_zero)}
                  </div>
                  {o.uncertainty.method && <div className="mt-1 text-[11px] text-slate-500">
                    {o.uncertainty.method} · {o.uncertainty.clusters ?? 0} NFL weeks · {o.uncertainty.trials?.toLocaleString() ?? 0} trials
                  </div>}
                </div>
                <div className={`ml-auto text-xs font-bold rounded-full px-3 py-1 ${
                  (o.uncertainty.roi_95?.[0] ?? -1) > 0 ? 'bg-slate-200 text-slate-900' : 'bg-white text-slate-700 border border-slate-300'
                }`}>
                  {(o.uncertainty.roi_95?.[0] ?? -1) > 0 ? 'Signal clears zero' : 'Not proven yet'}
                </div>
              </div>
              {o.uncertainty.sample_warning && <p className="mt-2 text-[11px] text-slate-600">{o.uncertainty.sample_warning}</p>}
            </div>
          )}

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
                      (s.units ?? 0) > 0 ? 'text-slate-900' : 'text-rose-600'}`}>{u(s.units)}</td>
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
                          (s.win_rate ?? 0) >= 0.524 ? 'text-slate-900' : 'text-rose-600'}`}>{pct(s.win_rate)}</td>
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
    <div className={`text-lg font-bold ${tone === 'good' ? 'text-slate-950' : tone === 'bad' ? 'text-rose-600' : 'text-slate-800'}`}>
      {value}
    </div>
  </div>
);

function EquityCurve({ points }: { points: Training['equity_curve'] }) {
  const width = 900, height = 210, pad = 24;
  const values = points.map(p => p.cumulative_units);
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values), span = Math.max(1, hi - lo);
  const xy = points.map((p, i) => ({
    x: pad + (i / Math.max(1, points.length - 1)) * (width - pad * 2),
    y: pad + ((hi - p.cumulative_units) / span) * (height - pad * 2)
  }));
  const path = xy.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const zeroY = pad + ((hi - 0) / span) * (height - pad * 2);
  return <section className="card mb-5 overflow-hidden p-4 sm:p-5">
    <SectionHeading eyebrow="Path, not just endpoint" title="Weekly equity curve"
      description="Cumulative units are ordered chronologically and grouped by NFL week, preserving clustered winning and losing runs." />
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="Cumulative units by week">
      <line x1={pad} x2={width - pad} y1={zeroY} y2={zeroY} stroke="#d2d2d7" strokeDasharray="5 5" />
      <path d={path} fill="none" stroke="#0071e3" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {xy.length > 0 && <circle cx={xy.at(-1)!.x} cy={xy.at(-1)!.y} r="5" fill="#0071e3" />}
    </svg>
    <div className="mt-2 flex justify-between text-xs text-slate-500"><span>{points[0]?.week}</span><span className="font-semibold text-slate-800">Ends {u(values.at(-1))}</span><span>{points.at(-1)?.week}</span></div>
  </section>;
}

function CalibrationPanel({ calibration: c }: { calibration: Calibration }) {
  const m = c.metrics;
  return <section className="card mb-5 p-4 sm:p-5">
    <SectionHeading eyebrow="Probability integrity" title="Market-anchored cover calibration"
      description={`Fit on ${c.trained_from}–${c.trained_through}; promotion is decided only by chronological walk-forward Brier score.`} />
    <div className="grid gap-3 sm:grid-cols-4">
      <Metric label="Walk-forward sample" value={m.walk_forward_n?.toLocaleString() ?? '—'} />
      <Metric label="Calibrated Brier" value={m.walk_forward_calibrated_brier?.toFixed(4) ?? '—'} />
      <Metric label="Market Brier" value={m.walk_forward_market_brier?.toFixed(4) ?? '—'} />
      <Metric label="Production gate" value={m.forward_gate_passed ? 'Passed' : 'Blocked'} tone={m.forward_gate_passed ? 'good' : 'bad'} />
    </div>
    <div className="mt-5 grid grid-cols-5 gap-2">
      {c.reliability.filter(b => b.n > 0).map(b => <div key={b.range} className="rounded-xl bg-slate-50 p-3">
        <div className="text-[10px] font-semibold text-slate-500">{b.range} · n={b.n}</div>
        <div className="mt-2 h-20 rounded-md bg-white p-1 flex items-end gap-1">
          <div title="Predicted" className="w-1/2 rounded-sm bg-blue-500" style={{ height: `${(b.predicted ?? 0) * 100}%` }} />
          <div title="Actual" className="w-1/2 rounded-sm bg-sky-500" style={{ height: `${(b.actual ?? 0) * 100}%` }} />
        </div>
        <div className="mt-1 text-[10px] text-slate-500">P {pct(b.predicted)} · A {pct(b.actual)}</div>
      </div>)}
    </div>
    <p className="mt-3 text-xs leading-5 text-slate-500">Blue is predicted cover frequency; black is observed. If calibration cannot beat the no-vig market baseline out of sample, the UI suppresses model probability edge.</p>
  </section>;
}
