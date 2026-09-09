import { useState } from 'react';
import { api, useApi } from '../../api';
import { americanFmt } from '../props/lib';
import { PageLoading, PageError } from '../../components/PageState';
import { SectionHeading, StatusPill, type Tone } from '../../components/betting/BettingUI';

/**
 * Execution brief Phase 2: the one screen where a real accept happens.
 * Everything above it (the ensemble, the frozen policy, the candidate board)
 * already exists and is unchanged; this page is the exact-contract ledger
 * server/services/nfl-execution-pipeline.js and nfl-execution-decision.js
 * build on top of it. "Desk" and "Positions & Results" below are literally
 * the section names the plan asks the betting UI to organize around.
 */
type ReplayOutcome = 'filled_as_decided' | 'repriced' | 'disappeared' | 'suspended' | 'capped'
  | 'no_decision_quote' | 'decision_stale_unknown' | 'stale_unknown';
interface ReplayResult { delay_seconds: number; outcome: ReplayOutcome; obtained_price: number | null;
  breakeven_slippage_bps: number | null; }
interface LifecycleEvent { id: number; state: string; occurred_at: string; book: string | null;
  line: number | null; price: number | null; stake_units: number | null; source: string; detail: {
    delayed_execution_preview?: ReplayResult[]; preview_note?: string; quote_provenance?: string;
    edge_points?: number; settlement_rules?: { overtime_rule_source: string | null }; note?: string } | null;
  result: string | null; realized_pnl_units: number | null; }
interface Opportunity { id: string; contract_key: string; event_key: string; matchup: string | null;
  market: string; side: string; status: string; decision_source: string; events: LifecycleEvent[]; }
interface Funnel { total_opportunities: number; by_stage: Record<string, number>;
  reached_decision: number; reached_accepted: number; survival_rate_decision_to_accepted: number | null;
  settled: number; wins: number; losses: number; pushes_or_voids: number; realized_pnl_units: number; note: string; }

const STAGE_TONE: Record<string, Tone> = { offered: 'neutral', observed: 'neutral', decision: 'warn',
  refreshed: 'warn', accepted: 'good', settled: 'neutral' };
const RESULT_TONE: Record<string, Tone> = { won: 'good', lost: 'bad', push: 'neutral', void: 'neutral' };
const REPLAY_TONE: Record<ReplayOutcome, Tone> = { filled_as_decided: 'good', repriced: 'warn',
  capped: 'warn', disappeared: 'bad', suspended: 'bad', no_decision_quote: 'bad',
  decision_stale_unknown: 'bad', stale_unknown: 'bad' };

function eventOf(o: Opportunity, state: string) { return o.events.find(e => e.state === state) ?? null; }

function AcceptForm({ opportunity, onDone }: { opportunity: Opportunity; onDone: () => void }) {
  const decision = eventOf(opportunity, 'decision');
  const [stakeUnits, setStakeUnits] = useState('1');
  const [price, setPrice] = useState(String(decision?.price ?? ''));
  const [line, setLine] = useState(decision?.line != null ? String(decision.line) : '');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ accepted: boolean; blocked_reason?: string } | null>(null);

  const submit = async () => {
    setBusy(true); setOutcome(null);
    try {
      const result = await api(`/nfl-market/execution/${opportunity.id}/accept`, { method: 'POST', body: JSON.stringify({
        stakeUnits: Number(stakeUnits), price: Number(price), line: line === '' ? null : Number(line),
        book: decision?.book ?? null
      }) });
      setOutcome(result as { accepted: boolean; blocked_reason?: string });
      if ((result as { accepted: boolean }).accepted) onDone();
    } catch (e) { setOutcome({ accepted: false, blocked_reason: e instanceof Error ? e.message : 'request failed' }); }
    finally { setBusy(false); }
  };

  return <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3">
    <label className="text-xs text-slate-600">Stake (units)<input value={stakeUnits} onChange={e => setStakeUnits(e.target.value)}
      className="mt-1 block w-20 rounded border border-slate-300 px-2 py-1 text-sm" type="number" step="0.25" min="0.25" /></label>
    <label className="text-xs text-slate-600">Price<input value={price} onChange={e => setPrice(e.target.value)}
      className="mt-1 block w-20 rounded border border-slate-300 px-2 py-1 text-sm" type="number" /></label>
    <label className="text-xs text-slate-600">Line<input value={line} onChange={e => setLine(e.target.value)}
      className="mt-1 block w-20 rounded border border-slate-300 px-2 py-1 text-sm" type="number" step="0.5" /></label>
    <button onClick={submit} disabled={busy} className="rounded-lg bg-slate-950 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">
      {busy ? 'Recording…' : 'I actually took this'}
    </button>
    {outcome && !outcome.accepted && <span className="text-xs font-semibold text-red-700">Blocked: {outcome.blocked_reason}</span>}
  </div>;
}

function ReplayPreview({ decision }: { decision: LifecycleEvent | null }) {
  const preview = decision?.detail?.delayed_execution_preview;
  if (!preview?.length) return null;
  return <details className="mt-2 text-xs">
    <summary className="cursor-pointer font-semibold text-slate-600">Delayed-execution assessment (would this still have been obtainable?)</summary>
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {preview.map(r => <span key={r.delay_seconds} className={`rounded-full px-2 py-0.5 font-bold ${
        REPLAY_TONE[r.outcome] === 'good' ? 'bg-emerald-100 text-emerald-800'
        : REPLAY_TONE[r.outcome] === 'warn' ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'}`}>
        +{r.delay_seconds}s: {r.outcome.replaceAll('_', ' ')}{r.obtained_price != null ? ` @ ${americanFmt(r.obtained_price)}` : ''}
      </span>)}
    </div>
    {decision?.detail?.quote_provenance && <p className="mt-1 text-[11px] text-slate-500">
      Quote source: {decision.detail.quote_provenance === 'quote_tape' ? 'real multi-book tape' : 'single captured price (see note)'}.
      {decision.detail.preview_note ? ` ${decision.detail.preview_note}` : ''}
    </p>}
  </details>;
}

function OpportunityCard({ o, action }: { o: Opportunity; action?: React.ReactNode }) {
  const decision = eventOf(o, 'decision');
  const accepted = eventOf(o, 'accepted');
  const settled = eventOf(o, 'settled');
  return <div className="rounded-lg border border-slate-200 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <div className="font-bold text-slate-900">{o.matchup ?? o.event_key}</div>
        <div className="text-xs text-slate-500">{o.market} · {o.side} · {decision?.line != null ? decision.line : accepted?.line}
          {' @ '}{americanFmt((decision ?? accepted)?.price ?? null)}
          {decision?.detail?.edge_points != null && ` · model edge ${decision.detail.edge_points.toFixed(1)}pts`}</div>
      </div>
      <div className="flex items-center gap-2">
        {settled?.result && <StatusPill tone={RESULT_TONE[settled.result] ?? 'neutral'}>{settled.result}
          {settled.realized_pnl_units != null ? ` ${settled.realized_pnl_units > 0 ? '+' : ''}${settled.realized_pnl_units.toFixed(3)}u` : ''}</StatusPill>}
        <StatusPill tone={STAGE_TONE[o.status] ?? 'neutral'}>{o.status}</StatusPill>
      </div>
    </div>
    <ReplayPreview decision={decision} />
    {decision?.detail?.settlement_rules?.overtime_rule_source === 'us_default_convention' &&
      <p className="mt-1 text-[11px] text-slate-400">Settlement uses an acknowledged US overtime convention, not a book-verified rule.</p>}
    {action}
  </div>;
}

export default function NflExecutionDesk() {
  const [tab, setTab] = useState<'desk' | 'positions'>('desk');
  const pending = useApi<{ pending: Opportunity[] }>('/nfl-market/execution/pending');
  const positions = useApi<{ open: Opportunity[] }>('/nfl-market/execution/positions');
  const settled = useApi<{ settled: Opportunity[] }>('/nfl-market/execution/settled');
  const funnel = useApi<Funnel>('/nfl-market/execution/funnel');
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<{ candidates_selected: number; results: unknown[] } | null>(null);

  const runPipeline = async () => {
    setRunning(true);
    try {
      const result = await api('/nfl-market/execution/run', { method: 'POST', body: JSON.stringify({}) });
      setRunResult(result as { candidates_selected: number; results: unknown[] });
      pending.refetch(); funnel.refetch();
    } finally { setRunning(false); }
  };
  const runSettlement = async () => {
    await api('/nfl-market/execution/settle', { method: 'POST', body: JSON.stringify({}) });
    positions.refetch(); settled.refetch(); funnel.refetch();
  };
  const refreshAll = () => { pending.refetch(); positions.refetch(); settled.refetch(); };

  return <div className="space-y-5">
    <SectionHeading eyebrow="Execution · Phase 2" title="Execution Desk"
      description="The exact-contract ledger connecting the frozen spread policy to a real accept/settle path. Nothing here places a bet — every ACCEPTED row is your own recorded claim, never a confirmed sportsbook fill." />

    <div className="flex flex-wrap items-center gap-2">
      <button onClick={runPipeline} disabled={running} className="rounded-lg bg-slate-950 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">
        {running ? 'Running…' : 'Run pipeline for this week'}
      </button>
      <button onClick={runSettlement} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold text-slate-700">
        Settle finished games
      </button>
      {runResult && <span className="text-xs text-slate-500">
        {runResult.candidates_selected} policy-selected candidate{runResult.candidates_selected === 1 ? '' : 's'} this run
        {runResult.candidates_selected === 0 && ' — the production policy currently has none eligible (calibration not yet proven; see Research Lab).'}
      </span>}
    </div>

    {funnel.data && <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
      {(['offered', 'observed', 'decision', 'refreshed', 'accepted', 'settled'] as const).map(stage => (
        <div key={stage} className="rounded-lg border border-slate-200 bg-white p-3 text-center">
          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{stage}</div>
          <div className="mt-1 text-xl font-black text-slate-900">{funnel.data!.by_stage[stage] ?? 0}</div>
        </div>
      ))}
    </div>}
    {funnel.data && funnel.data.settled > 0 && <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
      {funnel.data.wins}-{funnel.data.losses}{funnel.data.pushes_or_voids ? `-${funnel.data.pushes_or_voids}` : ''}, {' '}
      {funnel.data.realized_pnl_units > 0 ? '+' : ''}{funnel.data.realized_pnl_units.toFixed(3)}u real realized P&amp;L from this ledger.
    </p>}

    <div className="flex gap-1 border-b border-slate-200">
      {(['desk', 'positions'] as const).map(t => <button key={t} onClick={() => setTab(t)}
        className={`px-3 py-2 text-sm font-bold ${tab === t ? 'border-b-2 border-slate-950 text-slate-950' : 'text-slate-500'}`}>
        {t === 'desk' ? `Desk (${pending.data?.pending.length ?? 0})` : `Positions & Results (${(positions.data?.open.length ?? 0) + (settled.data?.settled.length ?? 0)})`}
      </button>)}
    </div>

    {tab === 'desk' && (pending.loading ? <PageLoading /> : pending.error ? <PageError message={pending.error} onRetry={() => pending.refetch()} /> :
      !pending.data?.pending.length ? <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">
        No opportunity is awaiting a decision. Run the pipeline above once the production policy has a real candidate.</p> :
      <div className="space-y-3">{pending.data.pending.map(o => <OpportunityCard key={o.id} o={o}
        action={<AcceptForm opportunity={o} onDone={refreshAll} />} />)}</div>)}

    {tab === 'positions' && <div className="space-y-4">
      <div>
        <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">Open (real exposure, not yet settled)</h4>
        {!positions.data?.open.length ? <p className="text-sm text-slate-500">No open positions.</p> :
          <div className="space-y-3">{positions.data.open.map(o => <OpportunityCard key={o.id} o={o} />)}</div>}
      </div>
      <div>
        <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">Settled</h4>
        {!settled.data?.settled.length ? <p className="text-sm text-slate-500">Nothing settled yet.</p> :
          <div className="space-y-3">{settled.data.settled.map(o => <OpportunityCard key={o.id} o={o} />)}</div>}
      </div>
    </div>}
  </div>;
}
