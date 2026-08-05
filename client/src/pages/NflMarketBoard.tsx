import { type ReactNode, useMemo, useState } from 'react';
import { api, useApi } from '../api';
import { americanFmt, pct } from './props/lib';
import PickReasoning, { type Reasoning } from '../components/PickReasoning';
import { BettingHero, EmptyState, Notice, SectionHeading, SignalCard, StatusPill } from '../components/betting/BettingUI';
import EnsemblePage from './betting/Ensemble';
import Training from './betting/Training';
import LineShop from './betting/LineShop';
import VariableCatalog from './betting/VariableCatalog';

interface BoardRow {
  market: 'moneyline' | 'spread' | 'total';
  matchup: string; selection: string; side: string;
  american_price: number | null; model_probability: number; implied_probability: number;
  probability_difference: number; detail: string;
  home_team?: string; away_team?: string; line?: number | null;
  reasoning?: Reasoning;
}
interface Accuracy {
  games_graded: number; win_accuracy: number; brier_score: number;
  margin_mae: number; total_mae: number;
  market_margin_mae: number | null; market_total_mae: number | null;
  note: string; evaluation_seasons?: number[];
}
interface AutoPick {
  season: number; week: number; rank: number; home_team: string; away_team: string; matchup: string;
  selection: string; side: string; line: number; american_price: number;
  model_probability: number; implied_probability: number; probability_difference: number;
  detail: string; units_staked: number; edge_points?: number; disagreement?: number;
  book?: string | null; quote_at?: string | null; quote_source?: string | null;
  feature_snapshot?: { margin_models_active?: number; margin_models_available?: number };
}
interface Graded extends AutoPick { status: 'Pending' | 'Won' | 'Lost' | 'Push'; units: number; }
interface Standing { wins: number; losses: number; pushes: number; win_rate: number | null; units: number; weeks_tracked: number; }
interface CandidatePayload {
  season: number; week: number; candidates: AutoPick[];
  abstentions: (AutoPick & { abstention_reason?: string })[];
  policy: { id: string; version: string; markets: string[]; maxPicksPerWeek: number; minEdge: number; maxDisagreement: number };
  clv: { available: boolean; snapshots: number; captures: number; note?: string };
  evidence?: { created_at: string; result: { overall: { bets: number; wins: number; losses: number; units: number; roi: number; uncertainty?: { roi_95: [number, number] } } } } | null;
  evidence_status: string; evidence_note: string;
}
interface RunResult {
  season: number; week: number; trials: number; eligible_candidates: number;
  last_week: { week: number; results: Graded[] }; new_picks: AutoPick[]; standing: Standing;
}
interface EnsembleCatalog {
  count: number; weighting: string;
  models: { margin_n: number; total_n: number; margin_weight: number; total_weight: number }[];
}
interface SystemStatus {
  pbp: { team: { season: number; rows: number; teams: number; through_week: number }[]; player: { season: number; rows: number; players: number }[] };
}

const MARKET_LABEL: Record<string, string> = { moneyline: 'Moneyline', spread: 'Spread', total: 'Total' };
const STATUS_STYLE: Record<string, string> = {
  Won: 'bg-slate-100 text-slate-800 border-slate-300',
  Lost: 'bg-rose-100 text-rose-700 border-rose-300',
  Push: 'bg-slate-100 text-slate-600 border-slate-300',
  Pending: 'bg-white text-slate-600 border-slate-300'
};

type HubTool = 'board' | 'ensemble' | 'training' | 'lines' | 'variables' | 'info';
const HUB_TOOLS: { id: HubTool; label: string; note: string }[] = [
  { id: 'board', label: 'Decision desk', note: 'Eligible picks' },
  { id: 'ensemble', label: 'Model room', note: 'Votes + lines' },
  { id: 'training', label: 'Blind replay', note: 'Evidence audit' },
  { id: 'lines', label: 'Line shop', note: 'Best price' },
  { id: 'variables', label: 'Variables', note: 'Data catalog' },
  { id: 'info', label: 'Method', note: 'Rules + limits' }
];

export default function NflMarketBoard({ initialTool = 'board' }: { initialTool?: HubTool }) {
  const [tool, setTool] = useState<HubTool>(initialTool);
  const [week, setWeek] = useState(1);
  const [marketFilter, setMarketFilter] = useState('all');
  const [boardLimit, setBoardLimit] = useState(8);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  const boardApi = useApi<{ season: number; week: number; board: BoardRow[] }>(
    `/nfl-betting/board/explained?week=${week}&limit=60`);
  const candidateApi = useApi<CandidatePayload>(`/nfl-market/picks/candidates?season=2026&week=${week}`);
  const { data: acc } = useApi<Accuracy>('/nfl-market/accuracy');
  const historyApi = useApi<{ results: Graded[]; standing: Standing }>('/nfl-market/picks/history');
  const { data: catalog } = useApi<EnsembleCatalog>('/nfl-betting/ensemble/models');
  const { data: system } = useApi<SystemStatus>('/nfl-betting/status');

  const refreshLines = async () => {
    setRefreshing(true); setRefreshMsg(null);
    try {
      const r = await api('/nfl-betting/lines/sync-now', { method: 'POST' });
      const detail = r.detail ?? r;
      setRefreshMsg(r.skipped ? `Lines already fresh · ${r.age_minutes} minutes old`
        : `Synced ${detail.updated ?? 0} line updates`);
      boardApi.refetch(); candidateApi.refetch();
    } catch (e: any) { setRefreshMsg(e.message); }
    finally { setRefreshing(false); }
  };

  const runWeekly = async () => {
    setRunning(true); setRunError(null); setRunResult(null);
    try {
      const r = await api<RunResult>(`/nfl-market/sync-and-pick?week=${week}&trials=20000`, { method: 'POST' });
      setRunResult(r); historyApi.refetch(); candidateApi.refetch(); boardApi.refetch();
    } catch (e: any) { setRunError(e.message); }
    finally { setRunning(false); }
  };

  const board = useMemo(() => (boardApi.data?.board ?? [])
    .filter(b => marketFilter === 'all' || b.market === marketFilter), [boardApi.data, marketFilter]);
  const candidates = candidateApi.data?.candidates ?? [];
  const standing = runResult?.standing ?? historyApi.data?.standing;
  const evidence = candidateApi.data?.evidence?.result.overall;
  const activeMargin = catalog?.models.filter(m => m.margin_n > 0 && m.margin_weight > 0).length ?? 0;
  const activeTotal = catalog?.models.filter(m => m.total_n > 0 && m.total_weight > 0).length ?? 0;
  const pbpRows = system?.pbp.team.reduce((n, s) => n + s.rows, 0) ?? 0;

  return (
    <div className="mx-auto max-w-[1440px] space-y-5">
      <BettingHero
        eyebrow="NFL betting intelligence"
        title="Auto Picks Command Center"
        description="The production decision is separated from the research board. A pick appears here only after the ensemble clears the edge and disagreement guards."
        status={<StatusPill tone="warn">Provisional edge</StatusPill>}
        actions={tool === 'board' ? <>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <span>Week</span>
            <select aria-label="NFL week" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-900"
              value={week} onChange={e => { setWeek(Number(e.target.value)); setBoardLimit(8); }}>
              {Array.from({ length: 18 }, (_, i) => i + 1).map(w => <option key={w} value={w}>{w}</option>)}
            </select>
          </label>
          <button className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50"
            onClick={refreshLines} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh lines'}</button>
          <button className="rounded-lg bg-slate-950 px-3 py-2 text-sm font-black text-white hover:bg-slate-800"
            onClick={runWeekly} disabled={running}>{running ? 'Analyzing…' : 'Lock eligible picks'}</button>
        </> : undefined}
      >
        <StatusPill tone="neutral">2026 · Week {week}</StatusPill>
        <StatusPill tone={pbpRows > 0 ? 'good' : 'warn'}>{pbpRows > 0 ? 'Play-by-play ready' : 'Play-by-play unavailable'}</StatusPill>
        <StatusPill tone="info">Policy: 3+ edge · ≤4.5 disagreement</StatusPill>
      </BettingHero>

      <nav aria-label="NFL Auto Picks tools" className="card grid grid-cols-2 gap-1 p-1.5 sm:grid-cols-3 xl:grid-cols-6">
        {HUB_TOOLS.map(t => (
          <button key={t.id} role="tab" aria-selected={tool === t.id} onClick={() => setTool(t.id)}
            className={`rounded-lg px-3 py-2.5 text-left transition-colors ${tool === t.id
              ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}>
            <div className="text-sm font-black">{t.label}</div>
            <div className={`mt-0.5 text-xs ${tool === t.id ? 'text-slate-400' : 'text-slate-400'}`}>{t.note}</div>
          </button>
        ))}
      </nav>

      {tool === 'ensemble' && <EnsemblePage />}
      {tool === 'training' && <Training />}
      {tool === 'lines' && <LineShop />}
      {tool === 'variables' && <VariableCatalog />}
      {tool === 'info' && <ModelInfo accuracy={acc} catalog={catalog} pbpRows={pbpRows} />}

      {tool === 'board' && <>
        {refreshMsg && <Notice title="Line refresh" tone="info">{refreshMsg}</Notice>}
        {runError && <Notice title="Weekly analysis failed" tone="bad">{runError}</Notice>}
        {running && <Notice title="Evaluating the production policy" tone="info">Lines are refreshing and the walk-forward ensemble is scoring every game. Only eligible spread picks will be locked.</Notice>}

        <section>
          <SectionHeading eyebrow="Decision desk" title={`Week ${week} eligible picks`}
            description="This is the actionable production slate. The much larger base-model board is research-only and lives below." />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,.7fr)]">
            <div className="card overflow-hidden">
              <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
                <div>
                  <div className="text-sm font-black text-slate-900">Production candidates</div>
                  <div className="text-xs text-slate-500">Spread only · maximum five · not locked until you run analysis</div>
                </div>
                <StatusPill tone={candidates.length ? 'warn' : 'neutral'}>{candidateApi.loading ? 'Evaluating' : `${candidates.length} eligible`}</StatusPill>
              </div>
              {candidateApi.loading ? <div className="p-6 text-sm text-slate-500">Running the ensemble against Week {week}…</div>
                : candidateApi.error ? <div className="p-6 text-sm text-rose-600">{candidateApi.error}</div>
                : candidates.length ? <CandidateList rows={candidates} />
                : <EmptyState title="The model is abstaining"
                    description="No spread clears both the 3-point edge floor and the 4.5-point disagreement ceiling. Zero picks is a valid production outcome." />}
            </div>

            <div className="space-y-3">
              <SignalCard label="Active ensemble" value={`${activeMargin}/${catalog?.count ?? 20} margin`}
                detail={`${activeTotal}/${catalog?.count ?? 20} models currently carry a total forecast. Missing sources abstain.`}
                tone={activeMargin >= 15 ? 'good' : 'warn'} />
              <SignalCard label="Evidence status" value="Not proven"
                detail={evidence ? `${evidence.wins}-${evidence.losses} · ${evidence.units >= 0 ? '+' : ''}${evidence.units.toFixed(2)}u · ${(evidence.roi * 100).toFixed(1)}% exact-policy ROI; interval ${((evidence.uncertainty?.roi_95?.[0] ?? 0) * 100).toFixed(1)}% to ${((evidence.uncertainty?.roi_95?.[1] ?? 0) * 100).toFixed(1)}%.` : 'The old non-parity ROI is retired. Exact-policy replay is required.'}
                tone="warn" />
              <SignalCard label="Abstentions" value={`${candidateApi.data?.abstentions?.length ?? 0} games`}
                detail="Every rejected candidate keeps an explicit reason in the decision audit." />
              <SignalCard label="CLV" value={candidateApi.data?.clv?.available ? 'Tracking' : 'Unavailable'}
                detail={candidateApi.data?.clv?.available ? `${candidateApi.data.clv.snapshots} stored quotes` : 'Two or more timed snapshots are required.'}
                tone={candidateApi.data?.clv?.available ? 'info' : 'warn'} />
              <SignalCard label="Tracked result" value={standing ? `${standing.wins}-${standing.losses}` : 'No settled picks'}
                detail={standing ? `${standing.units >= 0 ? '+' : ''}${standing.units.toFixed(2)}u across ${standing.weeks_tracked} tracked week${standing.weeks_tracked === 1 ? '' : 's'}.` : 'The live record begins only when picks are locked before kickoff.'} />
            </div>
          </div>
          {candidateApi.data?.evidence_note && <p className="mt-2 text-xs leading-5 text-slate-500">{candidateApi.data.evidence_note}</p>}
        </section>

        {runResult && (
          <section>
            <SectionHeading eyebrow="Last run" title={`${runResult.new_picks.length} pick${runResult.new_picks.length === 1 ? '' : 's'} locked for Week ${runResult.week}`}
              description={`${runResult.eligible_candidates} candidate${runResult.eligible_candidates === 1 ? '' : 's'} cleared policy before the five-pick cap.`} />
            <div className="card overflow-hidden"><PickTable rows={runResult.new_picks} graded={false} /></div>
          </section>
        )}

        {acc && (
          <section>
            <SectionHeading eyebrow="Reality check" title="Model versus market baseline"
              description="A prediction model earns trust by beating the market baseline on unseen games, not by displaying a large standalone accuracy number." />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SignalCard label="Model margin MAE" value={`${acc.margin_mae} pts`} detail={`${acc.games_graded.toLocaleString()} nested walk-forward games`} />
              <SignalCard label="Market margin MAE" value={acc.market_margin_mae == null ? '—' : `${acc.market_margin_mae} pts`}
                detail={acc.market_margin_mae != null && acc.margin_mae > acc.market_margin_mae ? 'Market remains stronger.' : 'Model is ahead on this measure.'}
                tone={acc.market_margin_mae != null && acc.margin_mae <= acc.market_margin_mae ? 'good' : 'warn'} />
              <SignalCard label="Model total MAE" value={`${acc.total_mae} pts`} detail="Bias-corrected point forecast" />
              <SignalCard label="Market total MAE" value={acc.market_total_mae == null ? '—' : `${acc.market_total_mae} pts`}
                detail={acc.market_total_mae != null && acc.total_mae > acc.market_total_mae ? 'Market remains stronger.' : 'Model is ahead on this measure.'}
                tone={acc.market_total_mae != null && acc.total_mae <= acc.market_total_mae ? 'good' : 'warn'} />
            </div>
          </section>
        )}

        <details className="card overflow-hidden group">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-4 hover:bg-slate-50">
            <div className="min-w-0 flex-1">
              <div className="text-base font-black text-slate-900">Research board</div>
              <div className="text-sm text-slate-500">Base ratings probabilities across every priced market. These rows do not pass the production policy.</div>
            </div>
            <StatusPill tone="neutral">{board.length} rows</StatusPill>
            <span className="text-sm font-bold text-slate-400 group-open:hidden">Open</span>
          </summary>
          <div className="border-t border-slate-200 p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {['all', 'moneyline', 'spread', 'total'].map(v => (
                <button key={v} onClick={() => { setMarketFilter(v); setBoardLimit(8); }}
                  className={`rounded-full border px-3 py-1.5 text-xs font-bold ${marketFilter === v
                    ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-400'}`}>
                  {v === 'all' ? 'All markets' : MARKET_LABEL[v]}
                </button>
              ))}
            </div>
            {boardApi.loading ? <div className="py-8 text-sm text-slate-500">Loading Week {week} research…</div>
              : boardApi.error ? <div className="py-8 text-sm text-rose-600">{boardApi.error}</div>
              : !board.length ? <EmptyState title="No priced markets" description="Books have not posted this slate, or the current line sync has no quote." />
              : <div className="space-y-2">{board.slice(0, boardLimit).map((b, i) => <ResearchRow key={`${b.matchup}-${b.market}-${i}`} row={b} />)}</div>}
            {board.length > boardLimit && <button className="btn-ghost mt-3 text-sm" onClick={() => setBoardLimit(n => Math.min(board.length, n + 12))}>Show 12 more</button>}
          </div>
        </details>

        {!!historyApi.data?.results.length && (
          <details className="card overflow-hidden group">
            <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-4 hover:bg-slate-50">
              <div className="min-w-0 flex-1"><div className="text-base font-black text-slate-900">Live pick ledger</div><div className="text-sm text-slate-500">Every pick locked by the production workflow, including pending results.</div></div>
              <StatusPill tone="neutral">{historyApi.data.results.length} picks</StatusPill>
              <span className="text-sm font-bold text-slate-400 group-open:hidden">Open</span>
            </summary>
            <div className="border-t border-slate-200"><PickTable rows={historyApi.data.results} graded /></div>
          </details>
        )}
      </>}
    </div>
  );
}

function CandidateList({ rows }: { rows: AutoPick[] }) {
  return <div className="divide-y divide-slate-100">{rows.slice(0, 5).map((p, i) => (
    <div key={`${p.matchup}-${p.selection}`} className="grid gap-3 px-4 py-4 sm:grid-cols-[32px_minmax(0,1fr)_auto] sm:items-center">
      <div className="grid h-8 w-8 place-items-center rounded-full bg-slate-900 text-sm font-black text-white">{i + 1}</div>
      <div>
        <div className="flex flex-wrap items-center gap-2"><span className="text-base font-black text-slate-900">{p.selection} {p.side}</span><StatusPill tone="warn">Research grade</StatusPill></div>
        <div className="mt-0.5 text-sm text-slate-500">{p.matchup} · {p.detail}</div>
        <div className="mt-1 text-xs text-slate-400">
          {p.book ?? 'Book unavailable'} · {p.quote_at ? `quoted ${new Date(p.quote_at).toLocaleString()}` : 'quote time unavailable'}
          {p.feature_snapshot?.margin_models_active != null ? ` · ${p.feature_snapshot.margin_models_active}/${p.feature_snapshot.margin_models_available ?? 20} models active` : ''}
        </div>
      </div>
      <div className="flex gap-5 sm:text-right">
        <div><div className="text-xs font-bold uppercase tracking-wide text-slate-400">Price</div><div className="text-base font-black text-slate-800">{americanFmt(p.american_price)}</div></div>
        <div><div className="text-xs font-bold uppercase tracking-wide text-slate-400">Edge</div><div className="text-base font-black text-slate-900">{p.edge_points?.toFixed(1) ?? '—'} pts</div></div>
        <div><div className="text-xs font-bold uppercase tracking-wide text-slate-400">Scatter</div><div className="text-base font-black text-slate-800">{p.disagreement?.toFixed(1) ?? '—'}</div></div>
      </div>
    </div>
  ))}</div>;
}

function ResearchRow({ row: b }: { row: BoardRow }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(120px,1fr)_90px_repeat(4,minmax(72px,auto))] sm:items-center">
        <div><div className="font-black text-slate-900">{b.matchup}</div><div className="text-xs text-slate-500">{b.detail}</div></div>
        <div><div className="text-xs font-bold uppercase tracking-wide text-slate-400">{MARKET_LABEL[b.market]}</div><div className="text-sm font-black text-slate-800">{b.side}</div></div>
        <DataPoint label="Price" value={americanFmt(b.american_price)} />
        <DataPoint label="Model" value={pct(b.model_probability)} />
        <DataPoint label="Market" value={pct(b.implied_probability)} />
        <DataPoint label="Gap" value={`+${pct(b.probability_difference)}`} tone="good" />
      </div>
      {(b.reasoning?.factors_considered ?? 0) > 0
        ? <PickReasoning reasoning={b.reasoning} />
        : <div className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-500">In-season explanatory features are not available yet; no narrative has been generated.</div>}
    </div>
  );
}

function ModelInfo({ accuracy, catalog, pbpRows }: { accuracy: Accuracy | null; catalog: EnsembleCatalog | null; pbpRows: number }) {
  const activeMargin = catalog?.models.filter(m => m.margin_n > 0 && m.margin_weight > 0).length ?? 0;
  return <div className="space-y-5">
    <SectionHeading eyebrow="Method" title="What the model knows—and what it does not"
      description="Every production rule is explicit. Missing evidence abstains, and the five-year result remains provisional." />
    <div className="grid gap-3 md:grid-cols-4">
      <SignalCard label="Decision floor" value="3.0 points" detail="Minimum ensemble-to-market margin gap" />
      <SignalCard label="Scatter ceiling" value="4.5 points" detail="Maximum model disagreement" />
      <SignalCard label="Active margin models" value={`${activeMargin}/${catalog?.count ?? 20}`} detail={`${pbpRows.toLocaleString()} stored team-week PBP rows`} tone={pbpRows ? 'good' : 'warn'} />
      <SignalCard label="Evidence" value="Provisional" detail="Holdout ROI interval still crosses zero" tone="warn" />
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="card p-5 space-y-4 text-sm leading-6 text-slate-600">
        <MethodItem n="01" title="Forecast">Rating, efficiency, context and market models produce independent lines. Components without data return no opinion.</MethodItem>
        <MethodItem n="02" title="Weight">Only errors observed before the target week determine exponential model weights.</MethodItem>
        <MethodItem n="03" title="Select">The 3-point edge and 4.5-point scatter guards decide eligibility. Production takes at most five spreads.</MethodItem>
        <MethodItem n="04" title="Track">Locked picks are graded from final scores. Future promotion also requires quote snapshots and closing-line value.</MethodItem>
      </div>
      <Notice title="Current limitation" tone="warn">The market remains a stronger standalone point predictor on the latest nested audit. The system is useful for structured research and forward tracking; it has not established a durable wagering edge.</Notice>
    </div>
    {accuracy && <div className="text-sm text-slate-500">Audit: {accuracy.games_graded.toLocaleString()} games · model margin MAE {accuracy.margin_mae} · market margin MAE {accuracy.market_margin_mae ?? '—'}.</div>}
  </div>;
}

function MethodItem({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return <div className="flex gap-3"><div className="text-xs font-black text-slate-500">{n}</div><div><b className="text-slate-900">{title}.</b> {children}</div></div>;
}

function PickTable({ rows, graded }: { rows: (AutoPick | Graded)[]; graded: boolean }) {
  return <div className="overflow-x-auto"><table className="w-full text-sm">
    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr>
      {['Week', 'Matchup', 'Pick', 'Price', 'Proxy gap', ...(graded ? ['Result', 'Units'] : [])].map(h => <th key={h} className="whitespace-nowrap px-4 py-3 text-left font-bold">{h}</th>)}
    </tr></thead>
    <tbody className="divide-y divide-slate-100">{rows.map((p, i) => {
      const g = 'status' in p ? p as Graded : null;
      return <tr key={`${p.season}-${p.week}-${p.rank}-${i}`}>
        <td className="px-4 py-3 tabular-nums text-slate-500">{p.week}</td>
        <td className="px-4 py-3"><div className="font-bold text-slate-900">{p.matchup}</div><div className="text-xs text-slate-500">{p.detail}</div></td>
        <td className="whitespace-nowrap px-4 py-3 font-bold text-slate-800">{p.selection} {p.side}</td>
        <td className="px-4 py-3 tabular-nums">{americanFmt(p.american_price)}</td>
        <td className="px-4 py-3 font-bold tabular-nums text-slate-900">+{pct(p.probability_difference)}</td>
        {graded && g && <><td className="px-4 py-3"><span className={`rounded-full border px-2 py-1 text-xs font-bold ${STATUS_STYLE[g.status]}`}>{g.status}</span></td><td className="px-4 py-3 font-bold tabular-nums">{g.units === 0 ? '—' : `${g.units > 0 ? '+' : ''}${g.units.toFixed(2)}u`}</td></>}
      </tr>;
    })}</tbody>
  </table></div>;
}

function DataPoint({ label, value, tone }: { label: string; value: string; tone?: 'good' }) {
  return <div><div className="text-xs font-bold uppercase tracking-wide text-slate-400">{label}</div><div className={`text-sm font-black tabular-nums ${tone === 'good' ? 'text-slate-950' : 'text-slate-800'}`}>{value}</div></div>;
}
