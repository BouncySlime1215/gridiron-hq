import { lazy, Suspense, type ReactNode, useMemo, useState } from 'react';
import { api, useApi } from '../api';
import { americanFmt, pct } from './props/lib';
import PickReasoning, { type Reasoning } from '../components/PickReasoning';
import { BettingHero, EmptyState, Notice, SectionHeading, SignalCard, StatusPill } from '../components/betting/BettingUI';
import { NflModelOperations } from '../components/betting/ModelOperations';
import { ModelLoadingSignature } from '../components/betting/ModelLoadingSignature';
import Training from './betting/Training';

// These panels are independent, data-heavy tools. Loading them only when the
// tab opens substantially shortens the initial NFL board/model route payload.
const EnsemblePage = lazy(() => import('./betting/Ensemble'));
const LineShop = lazy(() => import('./betting/LineShop'));
const Edges = lazy(() => import('./betting/Edges'));
const GameSimulator = lazy(() => import('./betting/GameSimulator'));
const Gates = lazy(() => import('./betting/Gates'));
const VariableCatalog = lazy(() => import('./betting/VariableCatalog'));
const NflProps = lazy(() => import('./betting/NflProps'));

interface BoardRow {
  market: 'moneyline' | 'spread' | 'total';
  matchup: string; selection: string; side: string;
  american_price: number | null; model_probability: number | null; implied_probability: number | null;
  probability_difference: number | null; detail: string;
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
  model_probability: number | null; implied_probability: number | null; probability_difference: number | null;
  detail: string; units_staked: number; edge_points?: number; disagreement?: number;
  book?: string | null; quote_at?: string | null; quote_source?: string | null;
  feature_snapshot?: { margin_models_active?: number; margin_models_available?: number;
    cover_calibration?: string | null; pregame_snapshot_at?: string | null;
    pregame_context?: { roster_rows?: number; injury_rows?: number; prior_feature_games?: number; production_eligible?: boolean } | null };
}
interface Graded extends AutoPick { status: 'Pending' | 'Won' | 'Lost' | 'Push'; units: number; }
interface Standing { wins: number; losses: number; pushes: number; win_rate: number | null; units: number; weeks_tracked: number; }
interface AllGameRow {
  matchup: string; market: string; selection: string; side: string | null;
  home_team: string; away_team: string; line: number | null;
  american_price: number | null; model_probability: number | null; implied_probability: number | null;
  edge: number | null; edge_points: number | null; disagreement: number | null;
  eligible: boolean; is_pick: boolean; detail: string;
}
interface AiExplanation { paragraph: string; }
interface CandidatePayload {
  season: number; week: number; candidates: AutoPick[];
  abstentions: (AutoPick & { abstention_reason?: string })[];
  all_games: AllGameRow[];
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
  odds_cache?: { cache_key: string; fetched_at: string; bytes: number }[];
}
interface CoverCalibration { created_at: string; sample_size: number; trained_from: number; trained_through: number;
  metrics: { walk_forward_n: number; walk_forward_calibrated_brier: number | null; walk_forward_market_brier: number | null; forward_gate_passed: boolean }; }
interface PregameCoverage { season: number; week: number; teams: number; first_capture: string; last_capture: string; }
interface HubStatus {
  edges: { id: string; label: string; live: boolean; headline: string; detail: string; blocked_by: string | null }[];
  model: { calibration_gate: string; calibration_detail: string; sizing_allowed: boolean };
  data: { credits_remaining: number | null; credits_used: number | null;
    free_detector: { events_tracked: number; moves: number; last_poll: string | null; worth_capturing: number };
    capture_stale: boolean; latest_multibook_capture: string | null };
}
interface TrackedBet {
  id: number; season: number; week: number; matchup: string; market: string; selection: string;
  side: string | null; line: number; american_price: number; model_probability: number | null;
  implied_probability: number | null; edge: number | null; units_staked: number;
  status: 'Pending' | 'Won' | 'Lost' | 'Push'; units: number;
}

const MARKET_LABEL: Record<string, string> = { moneyline: 'Moneyline', spread: 'Spread', total: 'Total' };
const STATUS_STYLE: Record<string, string> = {
  Won: 'bg-slate-100 text-slate-800 border-slate-300',
  Lost: 'bg-rose-100 text-rose-700 border-rose-300',
  Push: 'bg-slate-100 text-slate-600 border-slate-300',
  Pending: 'bg-white text-slate-600 border-slate-300'
};

type HubTool = 'edges' | 'board' | 'simulator' | 'model' | 'audit';
type InitialTool = HubTool | 'ensemble' | 'training' | 'lines' | 'variables' | 'operations' | 'info' | 'props' | 'edges';
const HUB_TOOLS: { id: HubTool; label: string; note: string }[] = [
  // Edges leads because it is the part that works. The auto-pick model sits
  // second and is labelled research: 0 of 21 component models beat the closing
  // line, and leading a hub with the one measured-negative component was the
  // clearest thing wrong with the old information architecture.
  { id: 'edges', label: 'Edges', note: 'Shopping · teasers · correlation' },
  { id: 'board', label: 'Board', note: 'Games · props · prices' },
  // The play simulator is a genuinely different kind of model — it plays games
  // rather than predicting margins — so it gets its own slot instead of being
  // buried as a tab under a margin model it does not resemble.
  { id: 'simulator', label: 'Simulator', note: 'Play-by-play · totals · live' },
  { id: 'model', label: 'Model', note: 'Ensemble · variables · method' },
  { id: 'audit', label: 'Audit', note: 'Blind replay · promotion gates' }
];
const normalizeInitial = (tool: InitialTool): HubTool =>
  ['ensemble', 'variables', 'info', 'model'].includes(tool) ? 'model'
    : ['training', 'operations', 'audit'].includes(tool) ? 'audit'
    : tool === 'simulator' ? 'simulator'
    : tool === 'edges' ? 'edges' : 'board';

export default function NflMarketBoard({ initialTool = 'board' }: { initialTool?: InitialTool }) {
  const [tool, setTool] = useState<HubTool>(() => normalizeInitial(initialTool));
  const [decisionView, setDecisionView] = useState<'games' | 'props' | 'lines'>(() =>
    initialTool === 'props' ? 'props' : initialTool === 'lines' ? 'lines' : 'games');
  const [modelView, setModelView] = useState<'ensemble' | 'variables' | 'method'>(() =>
    initialTool === 'variables' ? 'variables' : initialTool === 'info' ? 'method' : 'ensemble');
  const [auditView, setAuditView] = useState<'replay' | 'gates' | 'operations'>(() =>
    initialTool === 'operations' ? 'operations' : 'replay');
  const [week, setWeek] = useState(1);
  const [marketFilter, setMarketFilter] = useState('all');
  const [boardLimit, setBoardLimit] = useState(8);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  // Cheap integrity endpoints mount first so the server can paint factual
  // evidence before the CPU-heavy ensemble request begins.
  const { data: system, loading: systemLoading } = useApi<SystemStatus>('/nfl-betting/status');
  const { data: calibrationPayload } = useApi<{ calibration: CoverCalibration | null }>('/nfl-betting/calibration/cover');
  const { data: pregamePayload, loading: pregameLoading } = useApi<{ coverage: PregameCoverage[] }>('/nfl-betting/pregame/snapshots');
  // One honest read on what works and what is blocked. Cheap and free of credits,
  // so it loads on every tab rather than only where it happens to be rendered.
  const { data: hub } = useApi<HubStatus>('/betting/status');
  const boardVisible = tool === 'board' && decisionView === 'games';
  const { data: acc } = useApi<Accuracy>(boardVisible || (tool === 'model' && modelView === 'method') ? '/nfl-market/accuracy' : null);
  const historyApi = useApi<{ results: Graded[]; standing: Standing }>(boardVisible ? '/nfl-market/picks/history' : null);
  const boardApi = useApi<{ season: number; week: number; board: BoardRow[] }>(
    boardVisible ? `/nfl-betting/board/explained?week=${week}&limit=60` : null);
  const candidateApi = useApi<CandidatePayload>(boardVisible ? `/nfl-market/picks/candidates?season=2026&week=${week}` : null);
  const userBetsApi = useApi<{ bets: TrackedBet[]; standing: Standing }>(boardVisible ? `/nfl-market/bets?season=2026&week=${week}` : null);
  const [trackingKey, setTrackingKey] = useState<string | null>(null);
  const [openExplainKey, setOpenExplainKey] = useState<string | null>(null);
  const [explainCache, setExplainCache] = useState<Record<string, AiExplanation | { error: string } | 'loading'>>({});
  const { data: catalog, loading: catalogLoading } = useApi<EnsembleCatalog>(boardVisible || (tool === 'model' && modelView === 'method') ? '/nfl-betting/ensemble/models' : null);

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

  const trackBet = async (g: AllGameRow) => {
    const key = `${g.matchup}-${g.market}-${g.selection}`;
    setTrackingKey(key);
    try {
      await api('/nfl-market/bets', { method: 'POST', body: JSON.stringify({
        season: 2026, week, matchup: g.matchup, market: g.market, selection: g.selection,
        side: g.side, line: g.side ? Number(g.side.replace('+', '')) : null,
        american_price: g.american_price, model_probability: g.model_probability,
        implied_probability: g.implied_probability, edge: g.edge
      }) });
      userBetsApi.refetch();
    } catch (e: any) { setRunError(e.message); }
    finally { setTrackingKey(null); }
  };

  const untrackBet = async (id: number) => {
    await api(`/nfl-market/bets/${id}`, { method: 'DELETE' });
    userBetsApi.refetch();
  };

  const toggleExplain = async (g: AllGameRow, key: string) => {
    if (openExplainKey === key) { setOpenExplainKey(null); return; }
    setOpenExplainKey(key);
    if (explainCache[key]) return;
    setExplainCache(c => ({ ...c, [key]: 'loading' }));
    try {
      const r = await api<AiExplanation>('/nfl-betting/explain/ai', { method: 'POST', body: JSON.stringify({
        season: 2026, week, market: g.market, matchup: g.matchup, home_team: g.home_team, away_team: g.away_team,
        selection: g.selection, side: g.side, line: g.line, american_price: g.american_price,
        model_probability: g.model_probability, implied_probability: g.implied_probability, detail: g.detail
      }) });
      setExplainCache(c => ({ ...c, [key]: r }));
    } catch (e: any) { setExplainCache(c => ({ ...c, [key]: { error: e.message } })); }
  };

  const board = useMemo(() => (boardApi.data?.board ?? [])
    .filter(b => marketFilter === 'all' || b.market === marketFilter), [boardApi.data, marketFilter]);
  const standing = runResult?.standing ?? historyApi.data?.standing;
  const pbpRows = system?.pbp.team.reduce((n, s) => n + s.rows, 0) ?? 0;
  const calibration = calibrationPayload?.calibration;
  const pregame = pregamePayload?.coverage.find(x => x.season === 2026 && x.week === week);
  const latestQuote = system?.odds_cache?.[0]?.fetched_at ?? null;

  return (
    <div className="mx-auto max-w-[1440px] space-y-5">
      <BettingHero
        eyebrow="NFL betting"
        title="Edge Desk"
        description="Structural edges first, because those are the ones that work. The forecasting model sits under Board and is research — it has never beaten a closing line, and it is not allowed to size a bet until it does."
        status={<StatusPill tone={hub?.model.sizing_allowed ? 'good' : 'warn'}>
          {hub ? (hub.model.sizing_allowed ? 'Model cleared to size' : 'Model sizing blocked') : 'Checking…'}
        </StatusPill>}
        actions={tool === 'board' && decisionView === 'games' ? <>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <span>Week</span>
            <select aria-label="NFL week" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-900"
              value={week} onChange={e => { setWeek(Number(e.target.value)); setBoardLimit(8); }}>
              {Array.from({ length: 18 }, (_, i) => i + 1).map(w => <option key={w} value={w}>{w}</option>)}
            </select>
          </label>
          <button className="btn-ghost text-sm"
            onClick={refreshLines} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh lines'}</button>
          <button className="btn-primary text-sm"
            onClick={runWeekly} disabled={running}>{running ? 'Analyzing…' : 'Lock eligible picks'}</button>
        </> : undefined}
      >
        <StatusPill tone="neutral">2026 · Week {week}</StatusPill>
        {hub?.edges.map(e => (
          <StatusPill key={e.id} tone={e.live ? 'good' : 'warn'}>
            {e.live ? '● ' : '○ '}{e.label}{e.blocked_by ? ` · needs ${e.blocked_by}` : ''}
          </StatusPill>
        ))}
        <StatusPill tone={(hub?.data.credits_remaining ?? 0) < 200 ? 'warn' : 'neutral'}>
          {hub?.data.credits_remaining ?? '—'} API credits left
        </StatusPill>
        <StatusPill tone={systemLoading ? 'neutral' : pbpRows > 0 ? 'good' : 'warn'}>{systemLoading ? 'Checking play-by-play…' : pbpRows > 0 ? 'Play-by-play ready' : 'Play-by-play unavailable'}</StatusPill>
      </BettingHero>

      <nav aria-label="NFL betting tools" className="card grid grid-cols-2 gap-1 p-1.5 sm:grid-cols-4">
        {HUB_TOOLS.map(t => (
          <button key={t.id} role="tab" aria-selected={tool === t.id} onClick={() => setTool(t.id)}
            className={`rounded-xl px-3 py-2.5 text-left transition-colors ${tool === t.id
              ? 'bg-sky-100 text-sky-900 ring-1 ring-sky-200' : 'text-slate-600 hover:bg-sky-50 hover:text-slate-900'}`}>
            <div className="text-sm font-black">{t.label}</div>
            <div className={`mt-0.5 text-xs ${tool === t.id ? 'text-sky-700/70' : 'text-slate-400'}`}>{t.note}</div>
          </button>
        ))}
      </nav>

      {tool === 'board' && <FeatureTabs value={decisionView} onChange={setDecisionView} items={[
        ['games', 'Game picks'], ['props', 'Player props'], ['lines', 'Line shopping']
      ]} />}
      {tool === 'model' && <FeatureTabs value={modelView} onChange={setModelView} items={[
        ['ensemble', '21-model ensemble'], ['variables', 'Variable catalog'], ['method', 'Method & limits']
      ]} />}
      {tool === 'audit' && <FeatureTabs value={auditView} onChange={setAuditView} items={[
        ['replay', 'Blind replay'], ['gates', 'Staking gates'], ['operations', 'Promotion gates']
      ]} />}

      {tool === 'board' && decisionView === 'props' && <Suspense fallback={<ModelLoadingSignature sport="NFL" compact stages={['Loading shared player engine', 'Simulating joint events', 'Rendering prop board']} />}><NflProps /></Suspense>}
      {tool === 'board' && decisionView === 'lines' && <Suspense fallback={<ModelLoadingSignature sport="NFL" compact stages={['Loading line shop', 'Checking quote cache', 'Rendering market view']} />}><LineShop /></Suspense>}
      {tool === 'simulator' && <Suspense fallback={<ModelLoadingSignature sport="NFL" compact stages={['Loading team rates', 'Building expected-points surface', 'Simulating games']} />}><GameSimulator /></Suspense>}
      {tool === 'edges' && <Suspense fallback={<ModelLoadingSignature sport="NFL" compact stages={['Loading structural edges', 'Fitting parlay correlations', 'Reading the movement log']} />}><Edges /></Suspense>}
      {tool === 'model' && modelView === 'ensemble' && <Suspense fallback={<ModelLoadingSignature sport="NFL" compact stages={['Loading model room', 'Hydrating ensemble controls', 'Ready for live inputs']} />}><EnsemblePage /></Suspense>}
      {tool === 'model' && modelView === 'variables' && <Suspense fallback={<ModelLoadingSignature sport="NFL" compact stages={['Loading variable catalog', 'Checking source contracts', 'Rendering catalog']} />}><VariableCatalog /></Suspense>}
      {tool === 'model' && modelView === 'method' && <ModelInfo accuracy={acc} catalog={catalog} pbpRows={pbpRows} />}
      {tool === 'audit' && auditView === 'replay' && <Training />}
      {tool === 'audit' && auditView === 'gates' && <Suspense fallback={<ModelLoadingSignature sport="NFL" compact stages={['Loading calibration', 'Reading walk-forward metrics', 'Rendering gate status']} />}><Gates /></Suspense>}
      {tool === 'audit' && auditView === 'operations' && <NflModelOperations />}

      {tool === 'board' && decisionView === 'games' && <>
        {refreshMsg && <Notice title="Line refresh" tone="info">{refreshMsg}</Notice>}
        {runError && <Notice title="Weekly analysis failed" tone="bad">{runError}</Notice>}
        {running && <Notice title="Evaluating the production policy" tone="info">Lines are refreshing and the walk-forward ensemble is scoring every game. Only eligible spread picks will be locked.</Notice>}

        <section>
          <SectionHeading eyebrow="Full slate" title={`Week ${week} · ${candidateApi.data?.all_games?.length ?? '—'} games`}
            description="Every priced game, ranked by how much the model and the market disagree. A game lights up green the moment it clears the production policy." />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,.6fr)]">
            <div className="card overflow-hidden">
              {candidateApi.loading ? <div className="p-4"><ModelLoadingSignature sport="NFL" compact stages={[`Scoring Week ${week} games`, 'Applying frozen policy', 'Publishing eligible decisions']} /></div>
                : candidateApi.error ? <div className="p-6 text-sm text-rose-600">{candidateApi.error}</div>
                : !candidateApi.data?.all_games?.length ? <EmptyState title="No priced games yet" description="Refresh lines to pull this week's board." />
                : <div className="divide-y divide-slate-100">
                  {[...candidateApi.data.all_games]
                    .sort((a, b) => Number(b.is_pick) - Number(a.is_pick) || Number(b.eligible) - Number(a.eligible) || (b.edge_points ?? 0) - (a.edge_points ?? 0))
                    .map((g, i) => {
                    const key = `${g.matchup}-${g.market}-${g.selection}`;
                    const alreadyTracked = userBetsApi.data?.bets.some(b => b.matchup === g.matchup && b.market === g.market && b.selection === g.selection);
                    const eligible = g.is_pick || g.eligible;
                    const explain = explainCache[key];
                    return (
                    <div key={`${g.matchup}-${g.market}-${i}`} className={eligible ? 'bg-emerald-50/70' : ''}>
                      <div className={`grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center ${eligible ? 'ring-1 ring-inset ring-emerald-200' : ''}`}>
                        <button className="text-left" onClick={() => toggleExplain(g, key)}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-black text-slate-900">{g.matchup}</span>
                            {eligible && <StatusPill tone="good">{g.is_pick ? '★ Locked pick' : '★ Clears policy'}</StatusPill>}
                          </div>
                          <div className="mt-0.5 text-sm text-slate-500">{MARKET_LABEL[g.market] ?? g.market} · {g.selection} {g.side ?? ''} · <span className="underline decoration-dotted">{openExplainKey === key ? 'Hide reasoning' : 'Why?'}</span></div>
                        </button>
                        <div className="flex gap-5 sm:text-right">
                          <div><div className="text-xs font-bold uppercase tracking-wide text-slate-400">Price</div><div className="text-base font-black text-slate-800">{americanFmt(g.american_price)}</div></div>
                          <div><div className="text-xs font-bold uppercase tracking-wide text-slate-400">Edge</div>
                            <div className={`text-base font-black ${(g.edge_points ?? 0) > 0 ? 'text-emerald-700' : 'text-slate-800'}`}>{g.edge_points != null ? `${g.edge_points > 0 ? '+' : ''}${g.edge_points.toFixed(1)} pts` : '—'}</div></div>
                          <div><div className="text-xs font-bold uppercase tracking-wide text-slate-400">Confidence</div>
                            {g.model_probability != null
                              ? <div className={`text-base font-black ${g.model_probability >= 0.55 ? 'text-emerald-700' : 'text-slate-900'}`}>{pct(g.model_probability)}</div>
                              : <div className="text-xs font-bold text-slate-400">Unvalidated</div>}
                          </div>
                        </div>
                        <button className="btn-ghost text-xs whitespace-nowrap" disabled={alreadyTracked || trackingKey === key || g.american_price == null}
                          onClick={() => trackBet(g)}>{alreadyTracked ? 'Tracked' : trackingKey === key ? 'Tracking…' : 'Track bet'}</button>
                      </div>
                      {openExplainKey === key && (
                        <div className="border-t border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-700">
                          {explain === 'loading' ? 'Reading the model\'s own factors…'
                            : explain && 'error' in explain ? <span className="text-rose-600">{explain.error}</span>
                            : explain ? explain.paragraph
                            : null}
                        </div>
                      )}
                    </div>
                  );})}
                </div>}
            </div>

            <div className="space-y-3">
              <SignalCard label="Best game this week"
                value={candidateApi.data?.all_games?.length
                  ? [...candidateApi.data.all_games].sort((a, b) => (b.edge_points ?? 0) - (a.edge_points ?? 0))[0].matchup
                  : '—'}
                detail={candidateApi.data?.all_games?.length
                  ? `${Math.abs([...candidateApi.data.all_games].sort((a, b) => (b.edge_points ?? 0) - (a.edge_points ?? 0))[0].edge_points ?? 0).toFixed(1)}pt edge — the model and market disagree most here.` : 'Waiting on this week\'s lines.'}
                tone="info" />
              <SignalCard label="Locked + tracked record"
                value={standing || userBetsApi.data?.standing
                  ? `${(standing?.wins ?? 0) + (userBetsApi.data?.standing.wins ?? 0)}-${(standing?.losses ?? 0) + (userBetsApi.data?.standing.losses ?? 0)}`
                  : 'No settled bets'}
                detail={`Auto-picks ${standing ? `${standing.units >= 0 ? '+' : ''}${standing.units.toFixed(2)}u` : '—'} · your tracked bets ${userBetsApi.data?.standing ? `${userBetsApi.data.standing.units >= 0 ? '+' : ''}${userBetsApi.data.standing.units.toFixed(2)}u` : '—'}.`}
                tone={((standing?.units ?? 0) + (userBetsApi.data?.standing.units ?? 0)) >= 0 ? 'good' : 'warn'} />
              <SignalCard label="Model vs. market"
                value={calibration?.metrics.forward_gate_passed ? 'Model validated' : 'Market still favored'}
                detail={calibration?.metrics.forward_gate_passed ? 'The model beats the market on out-of-sample cover accuracy — confidence numbers reflect that.' : 'The market still predicts covers better than the model on out-of-sample seasons, so confidence is withheld rather than shown as a guess. Full numbers are on the Audit tab.'}
                tone={calibration?.metrics.forward_gate_passed ? 'good' : 'warn'} />
              <SignalCard label="Data freshness" value={systemLoading || pregameLoading ? 'Checking…' : latestQuote ? new Date(latestQuote).toLocaleDateString() : 'No live quote'}
                detail={pregame?.teams === 32 ? `Full ${pregame.teams}/32 team roster + injury snapshot captured.` : 'Roster/injury context for this week has not been captured yet — refresh lines.'}
                tone={pregame?.teams === 32 ? 'good' : 'warn'} />
            </div>
          </div>
        </section>

        {boardVisible && (
          <section>
            <SectionHeading eyebrow="Your bets" title="Tracked bets"
              description="Games you chose to bet yourself from the full slate — graded the same way as the auto-picks, tallied week by week." />
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(220px,.5fr)]">
              <div className="card overflow-hidden">
                {!userBetsApi.data?.bets.length
                  ? <EmptyState title="No bets tracked yet" description="Use “Track bet” on any game in the full slate above." />
                  : <div className="divide-y divide-slate-100">
                    {userBetsApi.data.bets.map(b => (
                      <div key={b.id} className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-black text-slate-900">{b.matchup}</span>
                            <span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${STATUS_STYLE[b.status]}`}>{b.status}</span>
                          </div>
                          <div className="mt-0.5 text-sm text-slate-500">{b.selection} {b.side ?? ''} · {americanFmt(b.american_price)}</div>
                        </div>
                        <div className="text-right"><div className="text-xs font-bold uppercase tracking-wide text-slate-400">Units</div>
                          <div className={`text-base font-black ${b.units > 0 ? 'text-emerald-700' : b.units < 0 ? 'text-rose-600' : 'text-slate-800'}`}>{b.units >= 0 ? '+' : ''}{b.units.toFixed(2)}u</div></div>
                        <button className="btn-ghost text-xs" onClick={() => untrackBet(b.id)}>Remove</button>
                      </div>
                    ))}
                  </div>}
              </div>
              <SignalCard label="Your record" value={userBetsApi.data?.standing ? `${userBetsApi.data.standing.wins}-${userBetsApi.data.standing.losses}` : 'No settled bets'}
                detail={userBetsApi.data?.standing ? `${userBetsApi.data.standing.units >= 0 ? '+' : ''}${userBetsApi.data.standing.units.toFixed(2)}u across ${userBetsApi.data.standing.weeks_tracked} tracked week${userBetsApi.data.standing.weeks_tracked === 1 ? '' : 's'}.` : 'Track a game above to start your own record.'} />
            </div>
          </section>
        )}

        {runResult && (
          <section>
            <SectionHeading eyebrow="Last run" title={`${runResult.new_picks.length} pick${runResult.new_picks.length === 1 ? '' : 's'} locked for Week ${runResult.week}`}
              description={`${runResult.eligible_candidates} candidate${runResult.eligible_candidates === 1 ? '' : 's'} cleared policy before the five-pick cap.`} />
            <div className="card overflow-hidden"><PickTable rows={runResult.new_picks} graded={false} /></div>
          </section>
        )}

        {acc && (
          <details className="card overflow-hidden group">
            <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-4 hover:bg-slate-50">
              <div className="min-w-0 flex-1"><div className="text-base font-black text-slate-900">Reality check: model vs. market</div>
                <div className="text-sm text-slate-500">Full accuracy audit — the numbers behind the "Market still favored" card above.</div></div>
              <span className="text-sm font-bold text-slate-400 group-open:hidden">Open</span>
            </summary>
            <div className="grid gap-3 border-t border-slate-200 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <SignalCard label="Model margin MAE" value={`${acc.margin_mae} pts`} detail={`${acc.games_graded.toLocaleString()} nested walk-forward games`} />
              <SignalCard label="Market margin MAE" value={acc.market_margin_mae == null ? '—' : `${acc.market_margin_mae} pts`}
                detail={acc.market_margin_mae != null && acc.margin_mae > acc.market_margin_mae ? 'Market remains stronger.' : 'Model is ahead on this measure.'}
                tone={acc.market_margin_mae != null && acc.margin_mae <= acc.market_margin_mae ? 'good' : 'warn'} />
              <SignalCard label="Model total MAE" value={`${acc.total_mae} pts`} detail="Bias-corrected point forecast" />
              <SignalCard label="Market total MAE" value={acc.market_total_mae == null ? '—' : `${acc.market_total_mae} pts`}
                detail={acc.market_total_mae != null && acc.total_mae > acc.market_total_mae ? 'Market remains stronger.' : 'Model is ahead on this measure.'}
                tone={acc.market_total_mae != null && acc.total_mae <= acc.market_total_mae ? 'good' : 'warn'} />
            </div>
          </details>
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
                    ? 'border-sky-200 bg-sky-100 text-sky-900' : 'border-slate-200 bg-white text-slate-600 hover:border-sky-300'}`}>
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

function FeatureTabs<T extends string>({ value, onChange, items }: {
  value: T; onChange: (value: T) => void; items: [T, string][];
}) {
  return <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2">
    {items.map(([id, label]) => <button key={id} onClick={() => onChange(id)}
      className={`rounded-lg px-3 py-2 text-sm font-bold transition-colors ${value === id
        ? 'bg-white text-sky-900 shadow-sm ring-1 ring-sky-200' : 'text-slate-500 hover:bg-white hover:text-slate-900'}`}>{label}</button>)}
  </div>;
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
      description="Every production rule is explicit. Missing evidence abstains, and the five-year development replay is never presented as untouched proof." />
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
