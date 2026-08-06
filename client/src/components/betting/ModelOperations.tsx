import { useState } from 'react';
import { api, useApi } from '../../api';
import { Notice, SectionHeading, SignalCard, StatusPill } from './BettingUI';
import { ModelLoadingSignature } from './ModelLoadingSignature';

interface Gate { id: string; label: string; passed: boolean; actual: unknown; target: string; }
interface RegistryRow { market: string; role: string; model_version: string; state: string; reason: string; }
interface Contract { market: string; feature_key: string; source: string; availability_rule: string; missing_behavior: string; leakage_risk: string; }
interface NflOps {
  verdict: string; generated_at: string; gates: Gate[]; registry: RegistryRow[]; contracts: Contract[];
  evidence: { residual: { summary: Record<string, number>; verdict: string }; ensemble: { active_margin: number; active_total: number; count: number };
    exact_policy: { bets: number; roi: number; units: number } | null; forward_settled: number;
    error_analysis?: { weakest?: { dimension: string; segment: string; bets: number; roi: number; z: number }[]; note?: string } | null; };
  latest_ablation: null | { created_at: string; results: { id: string; overall: { bets: number; roi: number; units: number; uncertainty?: { probability_roi_above_zero?: number } } }[] };
  intelligence?: Intelligence;
}
interface MlbMarketOps { model_version: string; verdict: string; gates: Gate[]; evidence: { metric: { n: number; brier: number | null; calibration_slope?: number | null; expected_calibration_error?: number | null }; forward: number; settled: number; priced: number } }
interface MlbOps { verdict: string; generated_at: string; markets: Record<string, MlbMarketOps>; registry: RegistryRow[]; contracts: Contract[];
  data_coverage: Record<string, { rows: number; first: string | null; latest: string | null }>;
  abstentions: { reason: string; decisions: number }[]; intelligence?: Intelligence; }
interface Daemon { odds_feed: boolean; by_status: { status: string; count: number }[]; by_horizon: { horizon: string; status: string; count: number }[]; next: { sport: string; event_key: string; horizon: string; due_at: string; status: string }[]; alerts: { severity: string; code: string; message: string }[]; }
interface Intelligence {
  status: string; evidence_daemon: Daemon;
  uncertainty?: { aggregate?: { n: number; margin_80_coverage: number | null; margin_95_coverage: number | null; total_80_coverage: number | null; total_95_coverage: number | null } };
  regimes?: { seasons: { season: number; n: number; margin_mae: number; total_mae: number; drift: number; regime: string }[] };
  bayesian_pooling?: { global_bias: number | null; seasons: { season: number; pooled_bias: number | null; shrinkage: number | null }[] };
  red_team?: { checks: { id: string; passed: boolean; detail: string }[]; passed: number; total: number };
  market_movement?: { available: boolean; quotes: number; captures: number; moves: unknown[]; note: string };
  shadow?: { shadow_ledger?: { total: number; settled: number; open: number; mode: string }; portfolio?: { max_real_stake: number; verdict: string; constraints: string[] }; execution_enabled?: boolean; max_real_stake?: number; policy?: string };
  hypotheses?: { id: string; title: string; hypothesis: string; source: string; status: string; holdout_rule: string }[];
}

const show = (value: unknown): string => {
  if (value == null) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(3);
  if (typeof value === 'string') return value;
  return Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k.replaceAll('_', ' ')}: ${show(v)}`).join(' · ');
};
const MARKET: Record<string, string> = { spread: 'NFL spread', total: 'NFL total', nrfi: 'NRFI / YRFI', pitcher_strikeouts: 'Pitcher strikeouts', batter_total_bases: 'Batter total bases' };

export function NflModelOperations() {
  const ops = useApi<NflOps>('/nfl-market/operations');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (kind: 'audit' | 'ablations' | 'capture') => {
    setBusy(kind); setError(null);
    try {
      await api(kind === 'audit' ? '/nfl-market/operations/audit' : kind === 'ablations' ? '/nfl-market/operations/ablations' : '/nfl-market/evidence/capture?force=1', { method: 'POST', body: kind === 'ablations' ? JSON.stringify({ seasons: [2021, 2022, 2023, 2024, 2025] }) : undefined });
      await ops.refetch();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };
  if (ops.loading) return <ModelLoadingSignature sport="NFL" stages={['Loading immutable gate audit', 'Checking market residual evidence', 'Rendering champion controls']} />;
  if (ops.error || !ops.data) return <Notice title="NFL operations unavailable" tone="bad">{ops.error ?? 'No operations report returned.'}</Notice>;
  const d = ops.data, residual = d.evidence.residual.summary;
  return <div className="space-y-5">
    <SectionHeading eyebrow="Model operations" title="NFL champion and challenger control"
      description="The sportsbook consensus remains champion. The football ensemble can replace it only after every unseen, calibration, CLV and forward-evidence gate passes." />
    <div className="flex flex-wrap items-center gap-2"><StatusPill tone={d.verdict === 'promotion_eligible' ? 'good' : 'warn'}>{d.verdict.replaceAll('_', ' ')}</StatusPill>
      <button className="btn-ghost text-sm" disabled={!!busy} onClick={() => act('audit')}>{busy === 'audit' ? 'Recording…' : 'Record immutable gate audit'}</button>
      <button className="btn-primary text-sm" disabled={!!busy} onClick={() => act('ablations')}>{busy === 'ablations' ? 'Running nine blind cuts…' : 'Run feature-family ablations'}</button></div>
    {error && <Notice title="Operations action failed" tone="bad">{error}</Notice>}
    <Registry rows={d.registry} />
    <GateGrid gates={d.gates} />
    <section><SectionHeading eyebrow="Market residual" title="Does football information improve the market?"
      description={d.evidence.residual.verdict} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SignalCard label="Market margin MAE" value={show(residual.market_margin_mae)} detail="Unseen sportsbook baseline" />
        <SignalCard label="Residual margin MAE" value={show(residual.residual_margin_mae)} detail="Market plus shrinkage-weighted model signal" tone={residual.residual_margin_mae < residual.market_margin_mae ? 'good' : 'warn'} />
        <SignalCard label="Market total MAE" value={show(residual.market_total_mae)} detail="Unseen sportsbook total" />
        <SignalCard label="Residual total MAE" value={show(residual.residual_total_mae)} detail="Tiny changes still require forward proof" tone={residual.residual_total_mae < residual.market_total_mae ? 'good' : 'warn'} />
      </div>
    </section>
    {!!d.evidence.error_analysis?.weakest?.length && <section><SectionHeading eyebrow="Error diagnosis" title="Weak segments requiring new causal features"
      description={d.evidence.error_analysis.note ?? 'These are research hypotheses, not filters to apply after seeing outcomes.'} />
      <div className="grid gap-3 md:grid-cols-2">{d.evidence.error_analysis.weakest.map(x => <div key={`${x.dimension}-${x.segment}`} className="card p-4"><div className="text-xs font-bold uppercase tracking-wide text-slate-400">{x.dimension}</div><div className="mt-1 text-lg font-black text-slate-900">{x.segment}</div><div className="mt-3 text-sm text-slate-600">{x.bets} bets · {(x.roi * 100).toFixed(1)}% ROI · z {x.z.toFixed(2)}</div></div>)}</div>
    </section>}
    <Ablations audit={d.latest_ablation} />
    {d.intelligence && <ResearchControl intelligence={d.intelligence} onCapture={() => act('capture')} busy={busy === 'capture'} />}
    <Contracts rows={d.contracts} />
  </div>;
}

export function MlbModelOperations({ through }: { through: string }) {
  const ops = useApi<MlbOps>(`/mlb/operations?through=${through}`);
  const [busy, setBusy] = useState(false);
  if (ops.loading) return <ModelLoadingSignature sport="MLB" stages={['Loading market-separated audits', 'Checking forward evidence', 'Rendering independent gates']} />;
  if (ops.error || !ops.data) return <Notice title="MLB operations unavailable" tone="bad">{ops.error ?? 'No operations report returned.'}</Notice>;
  const d = ops.data;
  const record = async () => { setBusy(true); try { await api(`/mlb/operations/audit?through=${through}`, { method: 'POST' }); await ops.refetch(); } finally { setBusy(false); } };
  return <section className="space-y-5">
    <SectionHeading eyebrow="Model operations" title="Three markets, three independent promotion decisions"
      description="NRFI, strikeouts and total bases cannot share a record or rescue one another. Each market needs cutoff-valid history, calibration, real prices, CLV and forward evidence." />
    <div className="flex flex-wrap items-center gap-2"><StatusPill tone={d.verdict === 'promotion_eligible' ? 'good' : 'warn'}>{d.verdict}</StatusPill><button className="btn-ghost text-sm" disabled={busy} onClick={record}>{busy ? 'Recording…' : 'Record immutable gate audits'}</button></div>
    <div className="grid gap-4 xl:grid-cols-3">{Object.entries(d.markets).map(([market, x]) => <div key={market} className="card overflow-hidden">
      <div className="border-b border-slate-200 bg-sky-50/60 p-4"><div className="flex items-center gap-2"><div className="font-black text-slate-900">{MARKET[market] ?? market}</div><StatusPill tone="warn">{x.verdict}</StatusPill></div><div className="mt-1 text-xs text-slate-500">{x.model_version}</div></div>
      <div className="p-4"><div className="grid grid-cols-3 gap-2 text-center"><Mini label="Historical" value={x.evidence.metric.n} /><Mini label="Forward" value={x.evidence.settled} /><Mini label="Priced" value={x.evidence.priced} /></div><div className="mt-4 space-y-2">{x.gates.map(g => <GateRow key={g.id} gate={g} />)}</div></div>
    </div>)}</div>
    {!!d.abstentions.length && <section><SectionHeading eyebrow="Decision audit" title={`${d.abstentions.reduce((n, x) => n + x.decisions, 0)} explicit abstentions`} description="Every rejected candidate keeps a machine-readable reason instead of disappearing from the record." /><div className="grid gap-3 md:grid-cols-3">{d.abstentions.map(x => <SignalCard key={x.reason} label={x.reason.replaceAll('_', ' ')} value={x.decisions.toLocaleString()} detail="No bet; retained for audit" tone="warn" />)}</div></section>}
    <Registry rows={d.registry} />
    {d.intelligence && <ResearchControl intelligence={d.intelligence} onCapture={async () => { setBusy(true); try { await api('/mlb/evidence/capture?force=1', { method: 'POST' }); await ops.refetch(); } finally { setBusy(false); } }} busy={busy} />}
    <Contracts rows={d.contracts} />
  </section>;
}

function GateGrid({ gates }: { gates: Gate[] }) { return <section><SectionHeading eyebrow="Promotion gates" title={`${gates.filter(x => x.passed).length}/${gates.length} currently pass`} description="A challenger stays blocked until every gate is green at the same immutable cutoff." /><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{gates.map(g => <div key={g.id} className="card p-4"><div className="flex items-center gap-2"><StatusPill tone={g.passed ? 'good' : 'warn'}>{g.passed ? 'pass' : 'blocked'}</StatusPill><div className="font-semibold text-slate-900">{g.label}</div></div><div className="mt-3 text-sm font-black text-slate-800">{show(g.actual)}</div><div className="mt-1 text-xs text-slate-500">Target: {g.target}</div></div>)}</div></section>; }
function GateRow({ gate: g }: { gate: Gate }) { return <div className="rounded-xl border border-slate-200 bg-white/70 p-3"><div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${g.passed ? 'bg-emerald-500' : 'bg-amber-400'}`} /><span className="text-xs font-bold text-slate-700">{g.label}</span></div><div className="mt-1 text-xs text-slate-500">{show(g.actual)} · target {g.target}</div></div>; }
function Registry({ rows }: { rows: RegistryRow[] }) { return <section><SectionHeading eyebrow="Registry" title="Champion / challenger state" description="Roles are explicit, versioned and reversible." /><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{rows.map(x => <div key={`${x.market}-${x.role}`} className="card p-4"><div className="flex items-center gap-2"><StatusPill tone={x.state === 'baseline' ? 'info' : 'warn'}>{x.role}</StatusPill><span className="text-sm font-black text-slate-900">{MARKET[x.market] ?? x.market}</span></div><div className="mt-3 font-semibold text-slate-800">{x.model_version}</div><p className="mt-1 text-xs leading-5 text-slate-500">{x.reason}</p></div>)}</div></section>; }
function Contracts({ rows }: { rows: Contract[] }) { return <details className="card overflow-hidden"><summary className="cursor-pointer px-4 py-4 font-semibold text-slate-900">Feature availability contracts · {rows.length}</summary><div className="overflow-x-auto border-t border-slate-200"><table className="w-full text-sm"><thead className="bg-slate-50 text-xs text-slate-400"><tr>{['Market','Feature','Source','Availability','Missing behavior','Risk'].map(x=><th key={x} className="px-4 py-3 text-left">{x}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{rows.map(x=><tr key={`${x.market}-${x.feature_key}`}><td className="px-4 py-3">{MARKET[x.market] ?? x.market}</td><td className="px-4 py-3 font-semibold">{x.feature_key.replaceAll('_',' ')}</td><td className="px-4 py-3 text-slate-500">{x.source}</td><td className="max-w-sm px-4 py-3 text-slate-500">{x.availability_rule}</td><td className="px-4 py-3">{x.missing_behavior}</td><td className="px-4 py-3"><StatusPill tone={x.leakage_risk === 'critical' ? 'warn' : 'neutral'}>{x.leakage_risk}</StatusPill></td></tr>)}</tbody></table></div></details>; }
function Ablations({ audit }: { audit: NflOps['latest_ablation'] }) { return <section><SectionHeading eyebrow="Feature ablations" title={audit ? `Latest diagnostic · ${new Date(audit.created_at).toLocaleString()}` : 'No family audit recorded'} description="Only-family and leave-one-family-out cuts expose which groups contribute. They are diagnostic, never permission to tune against the opened period." />{audit && <div className="card overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50 text-xs text-slate-400"><tr>{['Cut','Bets','Units','ROI','P(ROI > 0)'].map(x=><th key={x} className="px-4 py-3 text-left">{x}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{audit.results.map(x=><tr key={x.id}><td className="px-4 py-3 font-semibold">{x.id}</td><td className="px-4 py-3">{x.overall.bets}</td><td className="px-4 py-3">{show(x.overall.units)}</td><td className="px-4 py-3">{x.overall.roi == null ? '—' : `${(x.overall.roi*100).toFixed(1)}%`}</td><td className="px-4 py-3">{x.overall.uncertainty?.probability_roi_above_zero == null ? '—' : `${(x.overall.uncertainty.probability_roi_above_zero*100).toFixed(1)}%`}</td></tr>)}</tbody></table></div>}</section>; }
function Mini({ label, value }: { label: string; value: number }) { return <div className="rounded-xl bg-sky-50 p-2"><div className="text-lg font-black text-slate-900">{value}</div><div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div></div>; }

function ResearchControl({ intelligence: x, onCapture, busy }: { intelligence: Intelligence; onCapture: () => void | Promise<void>; busy: boolean }) {
  const d = x.evidence_daemon, counts = Object.fromEntries(d.by_status.map(v => [v.status, v.count]));
  const coverage = x.uncertainty?.aggregate;
  return <section className="space-y-4">
    <SectionHeading eyebrow="Forward evidence control" title="Capture the information arrival, not just the result"
      description="Opening, T-24h, T-6h, T-60m, T-15m and close are scheduled as immutable windows. The research layer is shadow-only: it cannot change selections, stakes or champion state." />
    <div className="flex flex-wrap items-center gap-2"><StatusPill tone="warn">research only</StatusPill><StatusPill tone={d.odds_feed ? 'good' : 'warn'}>{d.odds_feed ? 'odds feed connected' : 'odds feed missing'}</StatusPill><button className="btn-primary text-sm" disabled={busy} onClick={onCapture}>{busy ? 'Capturing…' : 'Run due evidence captures'}</button></div>
    {!!d.alerts.length && <div className="grid gap-3 md:grid-cols-2">{d.alerts.map(a => <Notice key={a.code} title={a.code.replaceAll('_',' ')} tone={a.severity === 'warn' ? 'warn' : 'bad'}>{a.message}</Notice>)}</div>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><SignalCard label="Queued windows" value={(counts.queued ?? 0).toLocaleString()} detail="Upcoming capture horizons" /><SignalCard label="Captured" value={(counts.captured ?? 0).toLocaleString()} detail="Context and real prices preserved" tone="good" /><SignalCard label="Partial" value={(counts.partial ?? 0).toLocaleString()} detail="Context saved; price feed still missing" tone={(counts.partial ?? 0) ? 'warn' : 'good'} /><SignalCard label="Market movements" value={(x.market_movement?.moves.length ?? 0).toLocaleString()} detail={x.market_movement?.available ? 'At least two priced snapshots' : 'Awaiting quoted history'} tone={x.market_movement?.available ? 'info' : 'warn'} /><SignalCard label="Conformal sample" value={coverage?.n?.toLocaleString() ?? '—'} detail={coverage ? `Margin 80% coverage ${show(coverage.margin_80_coverage)}` : 'NFL uncertainty audit only'} /></div>
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="card p-4"><div className="text-sm font-black text-slate-900">Uncertainty & regime guardrails</div>{coverage && <div className="mt-3 grid grid-cols-2 gap-2 text-sm"><Mini label="Margin 80% coverage" value={Math.round((coverage.margin_80_coverage ?? 0) * 100)} /><Mini label="Margin 95% coverage" value={Math.round((coverage.margin_95_coverage ?? 0) * 100)} /></div>}{x.regimes?.seasons && <div className="mt-3 flex flex-wrap gap-2">{x.regimes.seasons.map(r => <StatusPill key={r.season} tone={r.regime === 'degraded' ? 'warn' : 'neutral'}>{r.season} · {r.regime}</StatusPill>)}</div>}<p className="mt-3 text-xs leading-5 text-slate-500">Intervals and regime labels are diagnostics. They do not filter picks or set stake sizes.</p></div>
      <div className="card p-4"><div className="flex items-center gap-2"><div className="text-sm font-black text-slate-900">Red-team & shadow execution</div><StatusPill tone={x.red_team?.passed === x.red_team?.total ? 'good' : 'warn'}>{x.red_team ? `${x.red_team.passed}/${x.red_team.total} checks` : 'MLB policy'}</StatusPill></div><div className="mt-3 space-y-2">{x.red_team?.checks?.map(c => <div key={c.id} className="flex gap-2 text-xs text-slate-600"><span className={c.passed ? 'text-emerald-600' : 'text-amber-600'}>{c.passed ? '●' : '●'}</span><span>{c.detail}</span></div>) ?? <p className="text-sm text-slate-500">{x.shadow?.policy ?? 'Shadow-only until market-specific gates pass.'}</p>}</div><div className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">Real stake: <b>{x.shadow?.portfolio?.max_real_stake ?? x.shadow?.max_real_stake ?? 0}</b> · {x.shadow?.portfolio?.verdict ?? 'paper only'}</div></div>
    </div>
    {!!x.hypotheses?.length && <details className="card overflow-hidden"><summary className="cursor-pointer px-4 py-4 font-semibold text-slate-900">Preregistered causal research · {x.hypotheses.length}</summary><div className="grid gap-3 border-t border-slate-200 p-4 md:grid-cols-2">{x.hypotheses.map(h => <div key={h.id} className="rounded-xl border border-slate-200 bg-white/70 p-3"><div className="flex gap-2"><div className="min-w-0 flex-1 font-semibold text-slate-900">{h.title}</div><StatusPill tone="neutral">{h.status.replaceAll('_',' ')}</StatusPill></div><p className="mt-2 text-xs leading-5 text-slate-600">{h.hypothesis}</p><p className="mt-2 text-[11px] text-slate-400">Source: {h.source} · {h.holdout_rule}</p></div>)}</div></details>}
  </section>;
}
