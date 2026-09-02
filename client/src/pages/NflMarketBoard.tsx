import { lazy, Suspense, useMemo, useState } from 'react';
import { api, useApi } from '../api';
import { americanFmt, pct } from './props/lib';
import { BettingWorkspace, NextAction, WorkspaceNav } from '../components/betting/BettingWorkspace';
import { EmptyState, Notice, StatusPill } from '../components/betting/BettingUI';
import { ModelLoadingSignature } from '../components/betting/ModelLoadingSignature';
import { NflModelOperations } from '../components/betting/ModelOperations';
import Training from './betting/Training';

const Edges = lazy(() => import('./betting/Edges'));
const LineShop = lazy(() => import('./betting/LineShop'));
const Venues = lazy(() => import('./betting/Venues'));
const NflProps = lazy(() => import('./betting/NflProps'));
const FieldSim = lazy(() => import('./betting/FieldSim'));
const Gates = lazy(() => import('./betting/Gates'));
const Decisions = lazy(() => import('./betting/Decisions'));
const Diagnostics = lazy(() => import('./betting/Diagnostics'));
const UnifiedEngineRoom = lazy(() => import('../components/betting/UnifiedEngineRoom'));
// These three were fully built and routed-to, then never rendered: App.tsx sent
// /betting/nfl/ensemble and /betting/catalog here and both fell through to the
// architecture tab. FootballFirst is the frozen forward-ledger surface (record
// this week before kickoff, append-only, settle with CLV) — the exact Week 1 flow.
const FootballFirst = lazy(() => import('./betting/FootballFirst'));
const EnsemblePage = lazy(() => import('./betting/Ensemble'));
const VariableCatalog = lazy(() => import('./betting/VariableCatalog'));

type Section = 'board' | 'execute' | 'live' | 'engine';
type InitialTool = Section | 'edges' | 'board' | 'props' | 'lines' | 'venues' | 'simulator' | 'training' | 'operations' | 'ensemble' | 'variables' | 'model' | 'audit' | 'ai' | 'info' | 'forward';
type DecideView = 'games' | 'props';
type ExecuteView = 'edge' | 'shop' | 'venues';
type ProofView = 'overview' | 'forward' | 'audit' | 'diagnostics' | 'data' | 'ensemble' | 'variables';

interface AllGameRow {
  matchup: string; market: string; selection: string; side: string | null; home_team: string; away_team: string;
  line: number | null; american_price: number | null; model_probability: number | null; implied_probability: number | null;
  edge: number | null; edge_points: number | null; disagreement: number | null; eligible: boolean; is_pick: boolean; detail: string;
}
interface AutoPick extends AllGameRow { season: number; week: number; rank: number; units_staked: number }
interface CandidatePayload {
  season: number; week: number; candidates: AutoPick[]; abstentions: (AutoPick & { abstention_reason?: string })[]; all_games: AllGameRow[];
  policy: { id: string; version: string; maxPicksPerWeek: number; minEdge: number; maxDisagreement: number };
  clv: { available: boolean; snapshots: number; captures: number; note?: string };
  evidence_status: string; evidence_note: string;
}
interface RunResult { season: number; week: number; eligible_candidates: number; new_picks: AutoPick[] }
interface HubStatus {
  edges: { id: string; label: string; live: boolean; headline: string; detail: string; blocked_by: string | null }[];
  model: { calibration_detail: string; sizing_allowed: boolean };
  data: { capture_stale: boolean };
}
interface AiAuditSummary { run: { id: number; status: 'running' | 'complete' | 'failed'; result?: { reviewed: number; kept: number; abstained: number; evidence_status: string } | null } | null }
interface AiExplanation { paragraph: string; limitations: string[]; audit: { id: number; reasoning_hash: string; model: string; authority: string; sequence: string[] } }
interface TrackedBet { id: number; matchup: string; selection: string; side: string | null; american_price: number; status: string }

const normalizeSection = (tool: InitialTool): Section => {
  if (['edges', 'lines', 'venues', 'execute'].includes(tool)) return 'execute';
  if (['simulator', 'replay'].includes(tool)) return 'live';
  if (['training', 'operations', 'ensemble', 'variables', 'model', 'audit', 'ai', 'info', 'proof', 'forward'].includes(tool)) return 'engine';
  return 'board';
};

const initialProofView = (tool: InitialTool): ProofView => {
  if (tool === 'operations') return 'data';
  if (tool === 'training' || tool === 'ai' || tool === 'audit') return 'audit';
  if (tool === 'ensemble') return 'ensemble';
  if (tool === 'variables') return 'variables';
  if (tool === 'forward') return 'forward';
  return 'overview';
};

export default function NflMarketBoard({ initialTool = 'edges' }: { initialTool?: InitialTool }) {
  const [section, setSection] = useState<Section>(() => normalizeSection(initialTool));
  const [decideView, setDecideView] = useState<DecideView>(initialTool === 'props' ? 'props' : 'games');
  const [executeView, setExecuteView] = useState<ExecuteView>(initialTool === 'venues' ? 'venues' : initialTool === 'lines' ? 'shop' : 'edge');
  const [proofView, setProofView] = useState<ProofView>(() => initialProofView(initialTool));
  const [week, setWeek] = useState(1);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [openExplain, setOpenExplain] = useState<string | null>(null);
  const [explanations, setExplanations] = useState<Record<string, AiExplanation | { error: string } | 'loading'>>({});
  const [tracking, setTracking] = useState<string | null>(null);

  const hub = useApi<HubStatus>('/betting/status');
  const aiAudit = useApi<AiAuditSummary>('/nfl-betting/ai-replay/latest');
  const candidates = useApi<CandidatePayload>(section === 'board' && decideView === 'games' ? `/nfl-market/picks/candidates?season=2026&week=${week}` : null);
  const bets = useApi<{ bets: TrackedBet[] }>(section === 'board' && decideView === 'games' ? `/nfl-market/bets?season=2026&week=${week}` : null);
  const rows = useMemo(() => candidates.data?.all_games?.filter(game => game.market === 'spread') ?? [], [candidates.data]);
  const teaser = hub.data?.edges.find(edge => edge.id === 'teasers');
  const latestAi = aiAudit.data?.run;

  const runPolicy = async () => {
    setRunning(true); setMessage(null);
    try {
      const result = await api<RunResult>(`/nfl-market/sync-and-pick?week=${week}&trials=20000`, { method: 'POST' });
      setRunResult(result); setMessage(`${result.new_picks.length} paper pick${result.new_picks.length === 1 ? '' : 's'} preserved for Week ${week}.`);
      await candidates.refetch();
    } catch (error: any) { setMessage(error.message); }
    finally { setRunning(false); }
  };

  const refreshLines = async () => {
    setRunning(true); setMessage(null);
    try {
      const result = await api('/nfl-betting/lines/sync-now', { method: 'POST' });
      setMessage(result.skipped ? `Quotes are already fresh (${result.age_minutes} minutes old).` : `Synced ${result.detail?.updated ?? 0} quote updates.`);
      await candidates.refetch();
    } catch (error: any) { setMessage(error.message); }
    finally { setRunning(false); }
  };

  const trackBet = async (game: AllGameRow) => {
    const key = `${game.matchup}:${game.selection}`; setTracking(key);
    try {
      await api('/nfl-market/bets', { method: 'POST', body: JSON.stringify({ season: 2026, week, matchup: game.matchup, market: game.market, selection: game.selection, side: game.side, line: game.line, american_price: game.american_price, model_probability: game.model_probability, implied_probability: game.implied_probability, edge: game.edge }) });
      await bets.refetch(); setMessage(`${game.selection} added to the paper ledger.`);
    } catch (error: any) { setMessage(error.message); }
    finally { setTracking(null); }
  };

  const explain = async (game: AllGameRow) => {
    const key = `${game.matchup}:${game.selection}`;
    if (openExplain === key) { setOpenExplain(null); return; }
    setOpenExplain(key);
    if (explanations[key]) return;
    setExplanations(current => ({ ...current, [key]: 'loading' }));
    try {
      const result = await api<AiExplanation>('/nfl-betting/explain/ai', { method: 'POST', body: JSON.stringify({ season: 2026, week, market: game.market, matchup: game.matchup, home_team: game.home_team, away_team: game.away_team, selection: game.selection, side: game.side, line: game.line, american_price: game.american_price, model_probability: game.model_probability, implied_probability: game.implied_probability, detail: game.detail }) });
      setExplanations(current => ({ ...current, [key]: result }));
    } catch (error: any) { setExplanations(current => ({ ...current, [key]: { error: error.message } })); }
  };

  const activeStage = section === 'execute' ? 'price' : section === 'engine' ? 'review' : section === 'live' ? 'track' : 'scan';
  return <BettingWorkspace sport="nfl" title="NFL Betting Desk"
    description="One board for decisions, one execution workflow, one live view, and one engine room. Every component feeds the same evidence-gated system."
    activeStage={activeStage}
    actions={section === 'board' ? <><select aria-label="NFL week" value={week} onChange={event => setWeek(Number(event.target.value))} className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-xs font-bold text-white">{Array.from({ length: 18 }, (_, index) => <option className="text-slate-900" key={index + 1} value={index + 1}>Week {index + 1}</option>)}</select><button onClick={refreshLines} disabled={running} className="rounded-lg bg-white px-3 py-2 text-xs font-black text-slate-950">Refresh prices</button></> : undefined}>

    <WorkspaceNav value={section} onChange={setSection} items={[
      { id: 'board', label: 'Board', detail: 'Rank, filter, review, track', count: rows.length || undefined },
      { id: 'execute', label: 'Execute', detail: 'Edges, prices, venues' },
      { id: 'live', label: 'Live', detail: 'Game state + field replay' },
      { id: 'engine', label: 'Engine', detail: 'Architecture, audit, health' }
    ]} />

    {message && <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">{message}</div>}

    {section === 'board' && <>
      <Subnav value={decideView} onChange={setDecideView} items={[['games', 'Games'], ['props', 'Player props']]} />
      {decideView === 'props' && <Panel fallback="Loading prop model…"><NflProps /></Panel>}
      {decideView === 'games' && <DecisionQueue rows={rows} loading={candidates.loading} error={candidates.error} policy={candidates.data} bets={bets.data?.bets ?? []} tracking={tracking} openExplain={openExplain} explanations={explanations} onExplain={explain} onTrack={trackBet} onRun={runPolicy} running={running} runResult={runResult} />}
    </>}

    {section === 'execute' && <>
      <Subnav value={executeView} onChange={setExecuteView} items={[['edge', 'Ticket builder'], ['shop', 'Line shop'], ['venues', 'Venue routing']]} />
      {executeView === 'edge' && <><NextAction eyebrow="Execution focus" title={teaser?.live ? teaser.headline : 'Verify the payout before building a ticket'} detail={teaser?.detail ?? 'Reading the latest price gate…'} action={() => setExecuteView('shop')} tone="light" /><Panel fallback="Loading ticket evidence…"><Edges /></Panel></>}
      {executeView === 'shop' && <Panel fallback="Loading line shop…"><LineShop /></Panel>}
      {executeView === 'venues' && <Panel fallback="Loading venue routes…"><Venues /></Panel>}
    </>}

    {section === 'live' && <Panel fallback="Building field replay…"><FieldSim /></Panel>}

    {section === 'engine' && <>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,.8fr)]">
        <NextAction eyebrow="Blind-audit answer" title={!latestAi ? 'Run the first saved AI review' : latestAi.status === 'complete' && latestAi.result ? `${latestAi.result.reviewed} reviewed · ${latestAi.result.kept} survived` : `Review #${latestAi.id} is ${latestAi.status}`} detail={latestAi?.result ? `${latestAi.result.abstained} candidates were rejected. Open the trace to see exactly why each pick survived or failed.` : 'The review lives here with its evidence verdict and decision trace.'} action={() => setProofView('audit')} />
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="text-[10px] font-black uppercase tracking-[.14em] text-slate-400">AI authority</div><div className="mt-2 text-xl font-black text-slate-950">Explanation only</div><p className="mt-1 text-sm leading-5 text-slate-500">Selection happens first. The factor packet is frozen and hashed. AI translates that packet afterward and cannot change the pick, line, price, stake, or audit verdict.</p></div>
      </div>
      {/* Four tabs, not six. "AI review" and "Blind replay" are both the audit;
          "Promotion gates" and "Decision bases" are both what the model is
          allowed to claim. Splitting each pair bought nothing but another click
          and another thing to scan. */}
      <Subnav value={proofView} onChange={setProofView} items={[['overview', 'Architecture'], ['forward', 'Forward ledger'], ['ensemble', 'Ensemble'], ['audit', 'Audit'], ['diagnostics', 'Diagnostics'], ['data', 'Data health'], ['variables', 'Variables']]} />
      {proofView === 'overview' && <Panel fallback="Loading the unified engine…"><UnifiedEngineRoom /></Panel>}
      {proofView === 'forward' && <Panel fallback="Loading the forward ledger…"><FootballFirst embedded /></Panel>}
      {proofView === 'ensemble' && <Panel fallback="Loading ensemble lines…"><EnsemblePage /></Panel>}
      {proofView === 'variables' && <Panel fallback="Loading the variable catalog…"><VariableCatalog /></Panel>}
      {proofView === 'audit' && <><Training focus="ai" /><Training focus="replay" /><Panel fallback="Reading promotion gates…"><Gates /></Panel><Panel fallback="Compiling decision bases…"><Decisions /></Panel></>}
      {proofView === 'diagnostics' && <Panel fallback="Measuring model health…"><Diagnostics /></Panel>}
      {proofView === 'data' && <NflModelOperations />}
    </>}
  </BettingWorkspace>;
}

function DecisionQueue({ rows, loading, error, policy, bets, tracking, openExplain, explanations, onExplain, onTrack, onRun, running, runResult }: {
  rows: AllGameRow[]; loading: boolean; error: string | null; policy: CandidatePayload | null; bets: TrackedBet[]; tracking: string | null;
  openExplain: string | null; explanations: Record<string, AiExplanation | { error: string } | 'loading'>;
  onExplain: (game: AllGameRow) => void; onTrack: (game: AllGameRow) => void; onRun: () => void; running: boolean; runResult: RunResult | null;
}) {
  const [queueFilter, setQueueFilter] = useState<'all' | 'eligible' | 'tracked' | 'observe'>('all');
  const [queueSort, setQueueSort] = useState<'best' | 'confidence' | 'price' | 'matchup'>('best');
  const [query, setQuery] = useState('');
  if (loading) return <ModelLoadingSignature sport="NFL" compact stages={['Reading the slate', 'Applying policy rules', 'Freezing decision packets']} />;
  if (error) return <Notice title="Decision queue unavailable" tone="bad">{error}</Notice>;
  const eligible = rows.filter(row => row.eligible);
  const isTracked = (row: AllGameRow) => bets.some(bet => bet.matchup === row.matchup && bet.selection === row.selection);
  const visibleRows = rows.filter(row => {
    if (query && !`${row.matchup} ${row.selection}`.toLowerCase().includes(query.toLowerCase())) return false;
    if (queueFilter === 'eligible') return row.eligible;
    if (queueFilter === 'tracked') return isTracked(row);
    if (queueFilter === 'observe') return !row.eligible;
    return true;
  }).sort((a, b) => {
    if (queueSort === 'matchup') return a.matchup.localeCompare(b.matchup);
    if (queueSort === 'price') return (b.american_price ?? -10000) - (a.american_price ?? -10000);
    if (queueSort === 'confidence') return (b.model_probability ?? -1) - (a.model_probability ?? -1);
    return Number(b.eligible) - Number(a.eligible) || (b.edge_points ?? -Infinity) - (a.edge_points ?? -Infinity);
  });
  return <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_310px]">
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><div className="text-[10px] font-black uppercase tracking-[.15em] text-emerald-700">Model output</div><h2 className="text-2xl font-black">Spread decision queue</h2><p className="mt-1 text-sm text-slate-500">Every matchup is visible. Eligibility comes from the fixed policy, not AI wording.</p></div><button onClick={onRun} disabled={running} className="btn-primary">{running ? 'Running policy…' : 'Preserve paper slate'}</button></div>
      {!!rows.length && <div className="grid gap-2 rounded-2xl border border-slate-200 bg-white p-3 md:grid-cols-[minmax(180px,1fr)_auto_auto]">
        <input aria-label="Search teams" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search team or matchup" className="input py-2 text-sm" />
        <select aria-label="Filter decision queue" value={queueFilter} onChange={event => setQueueFilter(event.target.value as typeof queueFilter)} className="input py-2 text-sm"><option value="all">All decisions</option><option value="eligible">Policy passes</option><option value="tracked">Paper tracked</option><option value="observe">Observe only</option></select>
        <select aria-label="Sort decision queue" value={queueSort} onChange={event => setQueueSort(event.target.value as typeof queueSort)} className="input py-2 text-sm"><option value="best">Best edge first</option><option value="confidence">Highest probability</option><option value="price">Best price</option><option value="matchup">Matchup A–Z</option></select>
      </div>}
      {!rows.length ? <EmptyState title="No priced Week 1 slate yet" description="Refresh prices when books post the market. The model will not invent a line." /> : !visibleRows.length ? <EmptyState title="No decisions match these filters" description="Clear the search or widen the decision-state filter." /> : visibleRows.map(game => {
        const key = `${game.matchup}:${game.selection}`;
        const explanation = explanations[key];
        const tracked = isTracked(game);
        return <article key={key} className={`overflow-hidden rounded-2xl border bg-white ${game.eligible ? 'border-emerald-300 shadow-[0_8px_24px_rgba(5,150,105,.08)]' : 'border-slate-200'}`}>
          <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_repeat(3,minmax(82px,auto))_auto] md:items-center">
            <div><div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-black text-slate-950">{game.matchup}</h3><StatusPill tone={game.eligible ? 'good' : 'neutral'}>{game.eligible ? 'Policy pass' : 'Observe'}</StatusPill></div><div className="mt-1 text-sm font-bold text-slate-700">{game.selection} {game.side ?? ''}</div><div className="mt-0.5 text-xs text-slate-400">{game.detail}</div></div>
            <Metric label="Price" value={americanFmt(game.american_price)} />
            <Metric label="Model" value={pct(game.model_probability)} />
            <Metric label="Gap" value={game.edge_points == null ? '—' : `${game.edge_points > 0 ? '+' : ''}${game.edge_points.toFixed(1)} pts`} />
            <div className="flex gap-2 md:flex-col"><button className="btn-ghost text-xs" onClick={() => onExplain(game)}>{openExplain === key ? 'Close reasoning' : 'Why this pick?'}</button><button className="btn-primary text-xs" disabled={tracked || tracking === key || game.american_price == null} onClick={() => onTrack(game)}>{tracked ? 'Tracked' : tracking === key ? 'Saving…' : 'Paper track'}</button></div>
          </div>
          {openExplain === key && <div className="border-t border-slate-200 bg-slate-50 px-4 py-4 text-sm leading-6 text-slate-700">{explanation === 'loading' ? 'Translating the frozen factor packet…' : explanation && 'error' in explanation ? <span className="text-rose-700">{explanation.error}</span> : explanation ? <><p>{explanation.paragraph}</p><div className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-xs"><b>Audit #{explanation.audit.id}</b> · reasoning {explanation.audit.reasoning_hash.slice(0, 12)} · authority: {explanation.audit.authority}{!!explanation.limitations.length && <div className="mt-1 text-slate-500">Limits: {explanation.limitations.join(' · ')}</div>}</div></> : null}</div>}
        </article>;
      })}
    </section>
    <aside className="space-y-3">
      <div className="rounded-2xl border border-slate-200 bg-slate-950 p-5 text-white"><div className="text-[10px] font-black uppercase tracking-[.14em] text-emerald-300">Policy result</div><div className="mt-2 text-3xl font-black">{eligible.length}</div><div className="text-sm text-slate-300">of {rows.length} spreads eligible</div><div className="mt-4 space-y-2 border-t border-white/10 pt-4 text-xs text-slate-300"><Line label="Minimum gap" value={`${policy?.policy.minEdge ?? 3} pts`} /><Line label="Max disagreement" value={`${policy?.policy.maxDisagreement ?? 4.5} pts`} /><Line label="Weekly cap" value={policy?.policy.maxPicksPerWeek ?? 5} /></div></div>
      <div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="text-[10px] font-black uppercase tracking-[.14em] text-slate-400">Evidence state</div><div className="mt-2 text-lg font-black text-slate-950">{policy?.evidence_status ?? 'No slate loaded'}</div><p className="mt-1 text-xs leading-5 text-slate-500">{policy?.evidence_note ?? 'Waiting for model candidates.'}</p><div className="mt-3 text-xs font-bold text-slate-600">{policy?.clv.captures ?? 0} captures · {policy?.clv.snapshots ?? 0} snapshots</div></div>
      {runResult && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"><b>{runResult.new_picks.length} picks preserved.</b><div className="mt-1 text-xs">This is a paper ledger action, not staking authorization.</div></div>}
    </aside>
  </div>;
}

function Panel({ fallback, children }: { fallback: string; children: React.ReactNode }) { return <Suspense fallback={<div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">{fallback}</div>}>{children}</Suspense>; }
function Subnav<T extends string>({ value, onChange, items }: { value: T; onChange: (value: T) => void; items: [T, string][] }) { return <div className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1">{items.map(([id, label]) => <button key={id} onClick={() => onChange(id)} className={`rounded-lg px-3 py-2 text-xs font-black ${value === id ? 'bg-slate-950 text-white' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}>{label}</button>)}</div>; }
function Metric({ label, value }: { label: string; value: string }) { return <div><div className="text-[10px] font-black uppercase tracking-wide text-slate-400">{label}</div><div className="mt-1 whitespace-nowrap text-sm font-black text-slate-900">{value}</div></div>; }
function Line({ label, value }: { label: string; value: React.ReactNode }) { return <div className="flex justify-between gap-3"><span>{label}</span><b className="text-white">{value}</b></div>; }
