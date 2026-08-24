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
    walk_forward_market_brier: number | null; walk_forward_calibrated_log_loss?: number | null;
    walk_forward_market_log_loss?: number | null; walk_forward_expected_calibration_error?: number | null;
    walk_forward_calibration_intercept?: number | null; walk_forward_calibration_slope?: number | null;
    forward_gate_passed: boolean };
  reliability: { range: string; n: number; predicted: number | null; actual: number | null }[];
}
interface ValidationFirewall {
  canonical_label: string; total_recorded_trials: number; untouched_gate_passed: boolean;
  forward: { decisions: number; settled: number; target: number };
  multiple_testing: { required: boolean; note: string };
  windows: { window_id: string; seasons: string; state: string; purpose: string; reason: string }[];
}
interface AiReplay {
  id: number; status: 'running' | 'complete' | 'failed'; budget_usd: number; estimated_cost_usd: number;
  error?: string | null;
  progress: { current: number; total: number; season?: number; week?: number; game?: string; state?: string; max_cost_usd?: number };
  result?: { gate_version?: string; candidates: number; reviewed: number; kept: number; abstained: number; wins: number; losses: number; pushes?: number; win_rate: number | null; total_units_staked?: number; units: number; roi: number | null;
    sizing?: { press_2u: number; full_1u: number; half_05u: number; passed_0u: number };
    weekly_coverage?: { weeks: number; average_kept: number; weeks_with_3_plus: number; zero_kept_weeks: number }; evidence_status: string } | null;
}
interface AiReplayLog {
  ordinal: number; season: number; week: number; home: string; away: string; selection: string;
  review: { action: 'press' | 'approve' | 'reduce' | 'abstain'; risk: 'low' | 'medium' | 'high'; risk_score?: number;
    stake_multiplier?: number; flags?: string[]; parser_fallback?: boolean; reasons: string[] } | null;
  learning?: { sample_size: number; press_eligible: boolean; cutoff: string } | null;
  evidence_coverage?: { home_feature_fields: number; away_feature_fields: number; context_fields_present: number; context_fields_total: number } | null;
  outcome: string | null; units: number | null;
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
  const [aiRun, setAiRun] = useState<AiReplay | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [aiLogs, setAiLogs] = useState<AiReplayLog[]>([]);
  const { data: protocol } = useApi<Protocol>('/nfl-betting/experiments/protocol');
  const { data: registry } = useApi<{ experiments: Experiment[] }>('/nfl-betting/experiments');
  const { data: calibrationPayload } = useApi<{ calibration: Calibration | null }>('/nfl-betting/calibration/cover');
  const { data: firewall } = useApi<ValidationFirewall>('/nfl-betting/validation/firewall');
  const { data: latestAudit } = useApi<{ audit: { result: Training } | null }>('/nfl-betting/replay/latest');
  const { data: activeAiPayload } = useApi<{ run: AiReplay | null }>('/nfl-betting/ai-replay/active');
  const { data: latestAiPayload } = useApi<{ run: AiReplay | null }>('/nfl-betting/ai-replay/latest');
  const calibration = calibrationPayload?.calibration;
  useEffect(() => { if (!data && latestAudit?.audit?.result) setData(latestAudit.audit.result); }, [latestAudit, data]);
  // A dev-server refresh should never make an already-running, budgeted job
  // disappear from the UI. Reattach to the persisted local run automatically.
  useEffect(() => { if (!aiRun && activeAiPayload?.run) setAiRun(activeAiPayload.run); }, [activeAiPayload, aiRun]);
  useEffect(() => {
    const latest = latestAiPayload?.run;
    if (aiRun || !latest) return;
    setAiRun(latest);
    api<{ logs: AiReplayLog[] }>(`/nfl-betting/ai-replay/${latest.id}/logs`)
      .then(x => setAiLogs(x.logs)).catch(() => {});
  }, [latestAiPayload, aiRun]);
  useEffect(() => {
    if (!aiRun || aiRun.status !== 'running') return;
    const tick = () => {
      api<AiReplay>(`/nfl-betting/ai-replay/${aiRun.id}`).then(setAiRun).catch(e => setAiErr(e.message));
      api<{ logs: AiReplayLog[] }>(`/nfl-betting/ai-replay/${aiRun.id}/logs`).then(x => setAiLogs(x.logs)).catch(() => {});
    };
    tick();
    const timer = window.setInterval(tick, 800);
    return () => window.clearInterval(timer);
  }, [aiRun?.id, aiRun?.status]);

  const run = async () => {
    setBusy(true); setErr(null); setData(null);
    try {
      const saved = await api(`/nfl-betting/replay/train?seasons=${seasons}&min_bets=25`, { method: 'POST' });
      setData(saved.result);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const reattachAi = async () => {
    const active = activeAiPayload?.run;
    if (!active) return;
    setAiErr(null); setAiBusy(true);
    try {
      const [saved, trace] = await Promise.all([
        api<AiReplay>(`/nfl-betting/ai-replay/${active.id}`),
        api<{ logs: AiReplayLog[] }>(`/nfl-betting/ai-replay/${active.id}/logs`)
      ]);
      setAiRun(saved); setAiLogs(trace.logs);
    } catch (e: any) { setAiErr(`Could not reattach: ${e.message}`); }
    finally { setAiBusy(false); }
  };
  const runAi = async () => {
    setAiBusy(true); setAiErr(null); setAiRun(null); setAiLogs([]);
    try {
      const started = await api<AiReplay>('/nfl-betting/ai-replay', { method: 'POST', body: JSON.stringify({ seasons: seasons.split(',').map(Number), budgetUsd: 1 }) });
      setAiRun(started);
    } catch (e: any) { setAiErr(e.message); }
    finally { setAiBusy(false); }
  };

  const o = data?.overall;

  return (
    <div>
      <div className="flex items-end gap-3 mb-4 flex-wrap">
        <SectionHeading eyebrow="Evidence lab" title="Outcome-blind development replay"
          description="Replay frozen policies chronologically without releasing game outcomes to the predictor. These opened seasons diagnose the model; they are not untouched profitability proof." />
        <div className="flex items-end gap-2 text-sm ml-auto flex-wrap">
          <label className="text-slate-500"><span className="block text-xs font-bold mb-1">Research seasons</span>
            <input aria-label="Replay seasons" className="input py-2 w-52" value={seasons} onChange={e => setSeasons(e.target.value)} />
          </label>
          <button className="btn-primary text-xs" onClick={run} disabled={busy || activeAiPayload?.run?.status === 'running'}>
            {busy ? 'Replaying…' : '▶ Replay & analyze'}
          </button>
        </div>
      </div>
      <Notice title={firewall?.canonical_label ?? 'Development replay — not an untouched profitability test'} tone="warn">
        This audit uses the same versioned spread-only policy, edge floor, disagreement guard, weekly cap and ranking rule as the live desk. It is mechanically outcome-blind, but 2021–25 has already informed development. Only frozen, pre-kickoff 2026 decisions can become untouched forward evidence.
      </Notice>

      {firewall && <div className="my-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Recorded research trials" value={firewall.total_recorded_trials.toLocaleString()} />
        <Metric label="Forward decisions" value={firewall.forward.decisions.toLocaleString()} />
        <Metric label="Forward settled" value={`${firewall.forward.settled}/${firewall.forward.target}`} />
        <Metric label="Untouched gate" value={firewall.untouched_gate_passed ? 'Passed' : 'Blocked'} tone={firewall.untouched_gate_passed ? 'good' : 'bad'} />
      </div>}

      <div className="card my-5 border-slate-300 bg-slate-50 p-4">
        <div className="flex flex-wrap gap-3 items-start">
          <div className="flex-1 min-w-[16rem]">
            <div className="text-xs font-black uppercase tracking-wide text-slate-600">Claude pregame risk-gate replay</div>
            <div className="text-sm font-semibold text-slate-900 mt-1">Outcome-blind agent review · hard $1 maximum</div>
            <p className="text-xs leading-5 text-slate-600 mt-1">The agent sees a locked pregame packet plus aggregate learning from strictly earlier weeks. It can press to 2u, approve 1u, reduce to 0.5u, or abstain—never see the target, same-week, or future result. Because the seasons are opened development data, this tests workflow behavior rather than proving future profit.</p>
          </div>
          {activeAiPayload?.run?.status === 'running' && aiRun?.id !== activeAiPayload.run.id && <button className="btn-secondary text-xs" onClick={reattachAi} disabled={aiBusy}>Reattach live run</button>}
          <button className="btn-primary text-xs" onClick={runAi} disabled={aiBusy || aiRun?.status === 'running' || activeAiPayload?.run?.status === 'running'}>
            {aiBusy || aiRun?.status === 'running' || activeAiPayload?.run?.status === 'running' ? 'Agent replay running…' : '✦ Run 5-year AI report ($1 max)'}
          </button>
        </div>
        {aiErr && <div className="mt-3 text-xs text-rose-700">{aiErr}</div>}
        {activeAiPayload?.run?.status === 'running' && <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">A paid replay is active. Every replay control is locked until it completes or fails; use <b>Reattach live run</b> to reopen its trace after a reload.</div>}
        {aiRun && <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500"><span>Showing saved run <b className="text-slate-800">#{aiRun.id}</b> · {aiRun.status}</span><span>{aiLogs.length} trace rows loaded</span></div>}
        {aiRun && <AiReplayPanel run={aiRun} logs={aiLogs} />}
      </div>

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

function AiReplayPanel({ run, logs }: { run: AiReplay; logs: AiReplayLog[] }) {
  const p = run.progress;
  const percent = p.total ? Math.min(100, Math.round((p.current / p.total) * 100)) : 0;
  return <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3">
    {run.status === 'running' ? <>
      <div className="flex items-center justify-between gap-3 text-xs"><span className="flex items-center gap-2 font-bold text-slate-800"><span className="relative flex h-3 w-3"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60"/><span className="relative inline-flex h-3 w-3 rounded-full bg-blue-600"/></span>{p.state ?? 'Preparing replay'}</span><span className="tabular-nums text-slate-500">{p.current}/{p.total} · ${run.estimated_cost_usd.toFixed(2)} estimated / ${run.budget_usd.toFixed(2)} cap</span></div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-blue-600 transition-all duration-500" style={{ width: `${percent}%` }} /></div>
      <div className="mt-2 text-sm font-semibold text-slate-900">Week {p.week ?? '—'} · {p.game ?? 'locking packet…'}</div>
      <div className="flex items-center gap-1 text-[11px] text-slate-500"><span>No outcomes are released to the agent while this status is running.</span><span className="inline-flex gap-1 ml-1"><i className="h-1 w-1 rounded-full bg-blue-500 animate-bounce"/><i className="h-1 w-1 rounded-full bg-blue-500 animate-bounce [animation-delay:120ms]"/><i className="h-1 w-1 rounded-full bg-blue-500 animate-bounce [animation-delay:240ms]"/></span></div>
    </> : run.status === 'complete' && run.result ? <>
      <div className="text-xs font-black uppercase tracking-wide text-slate-500">AI replay complete{run.result.gate_version ? ` · ${run.result.gate_version}` : ''}</div>
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 mt-2"><Metric label="Reviewed" value={String(run.result.reviewed)} /><Metric label="Kept" value={String(run.result.kept)} /><Metric label="Record" value={`${run.result.wins}-${run.result.losses}${run.result.pushes ? `-${run.result.pushes}` : ''}`} /><Metric label="Staked" value={run.result.total_units_staked != null ? `${run.result.total_units_staked.toFixed(1)}u` : '—'} /><Metric label="Win rate" value={pct(run.result.win_rate)} /><Metric label="ROI on stake" value={pct(run.result.roi)} tone={(run.result.roi ?? 0) > 0 ? 'good' : 'bad'} /></div>
      {run.result.sizing && <div className="mt-2 text-[11px] text-slate-600">Sizing: {run.result.sizing.press_2u} pressed at 2u · {run.result.sizing.full_1u} full · {run.result.sizing.half_05u} half · {run.result.sizing.passed_0u} passed</div>}
      {run.result.weekly_coverage && <div className="mt-2 text-[11px] text-slate-600">Weekly coverage: {run.result.weekly_coverage.average_kept.toFixed(2)} kept per active week · {run.result.weekly_coverage.weeks_with_3_plus}/{run.result.weekly_coverage.weeks} weeks reached 3+ · {run.result.weekly_coverage.zero_kept_weeks} zero-play weeks</div>}
      <p className="mt-3 text-[11px] text-amber-700">{run.result.evidence_status}</p>
    </> : <div className="text-xs text-rose-700">Agent replay failed: {run.error ?? 'Unknown error'}</div>}
    {logs.length > 0 && <div className="mt-4 border-t border-slate-100 pt-3">
      <div className="mb-2 flex items-center justify-between"><div className="text-[10px] font-black uppercase tracking-wide text-slate-500">Live agent trace</div><div className="text-[10px] text-slate-400">Latest {Math.min(logs.length, 80)} reviews</div></div>
      <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
        {logs.map(log => <div key={log.ordinal} className="rounded-lg border border-slate-100 bg-slate-50 p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2"><b>#{log.ordinal} · {log.season} W{log.week}</b><span>{log.away} at {log.home}</span><span className="text-slate-500">{log.selection}</span>{log.review && <StatusPill tone={log.review.action === 'press' || log.review.action === 'approve' ? 'good' : log.review.action === 'abstain' ? 'warn' : 'neutral'}>{log.review.action} · {log.review.risk_score != null ? `${log.review.risk_score}/100` : log.review.risk} · {log.review.stake_multiplier != null ? `${log.review.stake_multiplier}u` : log.review.action === 'reduce' ? '0.5u' : log.review.action === 'abstain' ? '0u' : '1u'}</StatusPill>}{log.outcome && <span className="ml-auto font-semibold text-slate-700">{log.outcome}</span>}</div>
          {!!log.review?.flags?.length && <div className="mt-1 flex flex-wrap gap-1">{log.review.flags.map(flag => <span key={flag} className="rounded bg-white px-1.5 py-0.5 text-[10px] text-slate-500 ring-1 ring-slate-200">{flag.replaceAll('_', ' ')}</span>)}</div>}
          {log.learning && <div className="mt-1 text-[10px] text-blue-700">Blind learning memory: {log.learning.sample_size} strictly-prior reviews · 2u press {log.learning.press_eligible ? 'unlocked' : 'locked'}</div>}
          {log.evidence_coverage && <div className="mt-0.5 text-[10px] text-slate-400">Evidence: {log.evidence_coverage.home_feature_fields}+{log.evidence_coverage.away_feature_fields} team fields · {log.evidence_coverage.context_fields_present}/{log.evidence_coverage.context_fields_total} context fields</div>}
          {log.review?.reasons?.length ? <ul className="mt-1 list-disc pl-4 text-[11px] leading-4 text-slate-600">{log.review.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul> : <div className="mt-1 text-[11px] text-slate-400 animate-pulse">Pregame packet locked; waiting for structured review…</div>}
        </div>)}
      </div>
    </div>}
  </div>;
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
      <path d={path} fill="none" stroke="#1f3350" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {xy.length > 0 && <circle cx={xy.at(-1)!.x} cy={xy.at(-1)!.y} r="5" fill="#1f3350" />}
    </svg>
    <div className="mt-2 flex justify-between text-xs text-slate-500"><span>{points[0]?.week}</span><span className="font-semibold text-slate-800">Ends {u(values.at(-1))}</span><span>{points.at(-1)?.week}</span></div>
  </section>;
}

function CalibrationPanel({ calibration: c }: { calibration: Calibration }) {
  const m = c.metrics;
  return <section className="card mb-5 p-4 sm:p-5">
    <SectionHeading eyebrow="Probability integrity" title="Market-anchored cover calibration"
      description={`Fit on ${c.trained_from}–${c.trained_through}; promotion requires chronological Brier, log-loss, calibration and forward-evidence gates.`} />
    <div className="grid gap-3 sm:grid-cols-4">
      <Metric label="Walk-forward sample" value={m.walk_forward_n?.toLocaleString() ?? '—'} />
      <Metric label="Calibrated Brier" value={m.walk_forward_calibrated_brier?.toFixed(4) ?? '—'} />
      <Metric label="Market Brier" value={m.walk_forward_market_brier?.toFixed(4) ?? '—'} />
      <Metric label="Production gate" value={m.forward_gate_passed ? 'Passed' : 'Blocked'} tone={m.forward_gate_passed ? 'good' : 'bad'} />
    </div>
    <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Metric label="Model log loss" value={m.walk_forward_calibrated_log_loss?.toFixed(4) ?? '—'} />
      <Metric label="Market log loss" value={m.walk_forward_market_log_loss?.toFixed(4) ?? '—'} />
      <Metric label="Calibration ECE" value={m.walk_forward_expected_calibration_error == null ? '—' : pct(m.walk_forward_expected_calibration_error)} />
      <Metric label="Calibration intercept" value={m.walk_forward_calibration_intercept?.toFixed(3) ?? '—'} />
      <Metric label="Calibration slope" value={m.walk_forward_calibration_slope?.toFixed(3) ?? '—'} />
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
    <p className="mt-3 text-xs leading-5 text-slate-500">Dark blue is predicted cover frequency; light blue is observed. The probability edge stays suppressed unless the model beats the no-vig market on Brier and log loss, stays well calibrated, and later clears the forward-sample gate.</p>
  </section>;
}
