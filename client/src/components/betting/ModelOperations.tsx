import { useState } from 'react';
import { api, useApi } from '../../api';
import { Notice, SectionHeading, SignalCard, StatusPill } from './BettingUI';

interface Gate { id: string; label: string; passed: boolean; actual: unknown; target: string; }
interface RegistryRow { market: string; role: string; model_version: string; state: string; reason: string; }
interface Contract { market: string; feature_key: string; source: string; availability_rule: string; missing_behavior: string; leakage_risk: string; }
interface NflOps {
  verdict: string; generated_at: string; gates: Gate[]; registry: RegistryRow[]; contracts: Contract[];
  evidence: { residual: { summary: Record<string, number>; verdict: string }; ensemble: { active_margin: number; active_total: number; count: number };
    exact_policy: { bets: number; roi: number; units: number } | null; forward_settled: number;
    error_analysis?: { weakest?: { dimension: string; segment: string; bets: number; roi: number; z: number }[]; note?: string } | null; };
  latest_ablation: null | { created_at: string; results: { id: string; overall: { bets: number; roi: number; units: number; uncertainty?: { probability_roi_above_zero?: number } } }[] };
}
interface MlbMarketOps { model_version: string; verdict: string; gates: Gate[]; evidence: { metric: { n: number; brier: number | null; calibration_slope?: number | null; expected_calibration_error?: number | null }; forward: number; settled: number; priced: number } }
interface MlbOps { verdict: string; generated_at: string; markets: Record<string, MlbMarketOps>; registry: RegistryRow[]; contracts: Contract[];
  data_coverage: Record<string, { rows: number; first: string | null; latest: string | null }>;
  abstentions: { reason: string; decisions: number }[]; }

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
  const act = async (kind: 'audit' | 'ablations') => {
    setBusy(kind); setError(null);
    try {
      await api(kind === 'audit' ? '/nfl-market/operations/audit' : '/nfl-market/operations/ablations', { method: 'POST', body: kind === 'ablations' ? JSON.stringify({ seasons: [2021, 2022, 2023, 2024, 2025] }) : undefined });
      await ops.refetch();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };
  if (ops.loading) return <div className="card p-6 text-sm text-slate-500">Rebuilding nested NFL evidence and promotion gates…</div>;
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
    <Contracts rows={d.contracts} />
  </div>;
}

export function MlbModelOperations({ through }: { through: string }) {
  const ops = useApi<MlbOps>(`/mlb/operations?through=${through}`);
  const [busy, setBusy] = useState(false);
  if (ops.loading) return <div className="card p-6 text-sm text-slate-500">Auditing all three MLB model families independently…</div>;
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
    <Contracts rows={d.contracts} />
  </section>;
}

function GateGrid({ gates }: { gates: Gate[] }) { return <section><SectionHeading eyebrow="Promotion gates" title={`${gates.filter(x => x.passed).length}/${gates.length} currently pass`} description="A challenger stays blocked until every gate is green at the same immutable cutoff." /><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{gates.map(g => <div key={g.id} className="card p-4"><div className="flex items-center gap-2"><StatusPill tone={g.passed ? 'good' : 'warn'}>{g.passed ? 'pass' : 'blocked'}</StatusPill><div className="font-semibold text-slate-900">{g.label}</div></div><div className="mt-3 text-sm font-black text-slate-800">{show(g.actual)}</div><div className="mt-1 text-xs text-slate-500">Target: {g.target}</div></div>)}</div></section>; }
function GateRow({ gate: g }: { gate: Gate }) { return <div className="rounded-xl border border-slate-200 bg-white/70 p-3"><div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${g.passed ? 'bg-emerald-500' : 'bg-amber-400'}`} /><span className="text-xs font-bold text-slate-700">{g.label}</span></div><div className="mt-1 text-xs text-slate-500">{show(g.actual)} · target {g.target}</div></div>; }
function Registry({ rows }: { rows: RegistryRow[] }) { return <section><SectionHeading eyebrow="Registry" title="Champion / challenger state" description="Roles are explicit, versioned and reversible." /><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{rows.map(x => <div key={`${x.market}-${x.role}`} className="card p-4"><div className="flex items-center gap-2"><StatusPill tone={x.state === 'baseline' ? 'info' : 'warn'}>{x.role}</StatusPill><span className="text-sm font-black text-slate-900">{MARKET[x.market] ?? x.market}</span></div><div className="mt-3 font-semibold text-slate-800">{x.model_version}</div><p className="mt-1 text-xs leading-5 text-slate-500">{x.reason}</p></div>)}</div></section>; }
function Contracts({ rows }: { rows: Contract[] }) { return <details className="card overflow-hidden"><summary className="cursor-pointer px-4 py-4 font-semibold text-slate-900">Feature availability contracts · {rows.length}</summary><div className="overflow-x-auto border-t border-slate-200"><table className="w-full text-sm"><thead className="bg-slate-50 text-xs text-slate-400"><tr>{['Market','Feature','Source','Availability','Missing behavior','Risk'].map(x=><th key={x} className="px-4 py-3 text-left">{x}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{rows.map(x=><tr key={`${x.market}-${x.feature_key}`}><td className="px-4 py-3">{MARKET[x.market] ?? x.market}</td><td className="px-4 py-3 font-semibold">{x.feature_key.replaceAll('_',' ')}</td><td className="px-4 py-3 text-slate-500">{x.source}</td><td className="max-w-sm px-4 py-3 text-slate-500">{x.availability_rule}</td><td className="px-4 py-3">{x.missing_behavior}</td><td className="px-4 py-3"><StatusPill tone={x.leakage_risk === 'critical' ? 'warn' : 'neutral'}>{x.leakage_risk}</StatusPill></td></tr>)}</tbody></table></div></details>; }
function Ablations({ audit }: { audit: NflOps['latest_ablation'] }) { return <section><SectionHeading eyebrow="Feature ablations" title={audit ? `Latest diagnostic · ${new Date(audit.created_at).toLocaleString()}` : 'No family audit recorded'} description="Only-family and leave-one-family-out cuts expose which groups contribute. They are diagnostic, never permission to tune against the opened period." />{audit && <div className="card overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50 text-xs text-slate-400"><tr>{['Cut','Bets','Units','ROI','P(ROI > 0)'].map(x=><th key={x} className="px-4 py-3 text-left">{x}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{audit.results.map(x=><tr key={x.id}><td className="px-4 py-3 font-semibold">{x.id}</td><td className="px-4 py-3">{x.overall.bets}</td><td className="px-4 py-3">{show(x.overall.units)}</td><td className="px-4 py-3">{x.overall.roi == null ? '—' : `${(x.overall.roi*100).toFixed(1)}%`}</td><td className="px-4 py-3">{x.overall.uncertainty?.probability_roi_above_zero == null ? '—' : `${(x.overall.uncertainty.probability_roi_above_zero*100).toFixed(1)}%`}</td></tr>)}</tbody></table></div>}</section>; }
function Mini({ label, value }: { label: string; value: number }) { return <div className="rounded-xl bg-sky-50 p-2"><div className="text-lg font-black text-slate-900">{value}</div><div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div></div>; }
