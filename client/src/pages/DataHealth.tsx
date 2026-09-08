import { useMemo, useState } from 'react';
import { api, useApi } from '../api';
import { PageError, PageLoading } from '../components/PageState';

/**
 * Data Health — the P0 the platform audit ("4. Create a data health center")
 * asked for: a real, navigable page (not the hidden Dev Hub drawer) showing
 * every ingestion source's cadence, cutoff rule, staleness, and failure mode,
 * plus a one-button resync and the auth/quota state that silently degrades
 * features when it runs out.
 *
 * Every number here comes straight from server/services/source-registry.js
 * via GET /dev/sources — this page presents that data, it does not recompute
 * staleness or confidence itself.
 */

type SourceStatus = {
  source: string;
  label: string;
  cadence: string;
  cutoff: string;
  failure_mode: string;
  max_age_minutes: number;
  scheduled: boolean;
  last_run_at: string | null;
  age_minutes: number | null;
  last_status: string;
  stale: boolean;
  confidence: number | null;
};

type SourcesResponse = { count: number; stale: number; sources: SourceStatus[] };

type RefreshStep = { name: string; ok: boolean; error?: string; [k: string]: unknown };
type RefreshResult = { ok: boolean; steps: RefreshStep[]; failed: string[] };

type DevStatus = { api_key?: { configured: boolean; masked?: string | null } };
type OddsUsage = { has_key?: boolean; requests_used?: number | null; requests_remaining?: number | null; last_call_at?: string | null };
type BettingSummary = { odds_api?: OddsUsage };

// Same relative-time convention as DevHub.tsx's ago()/fmt() helpers.
const ago = (iso?: string | null) => {
  if (!iso) return 'never';
  const then = new Date(iso.replace(' ', 'T') + 'Z').getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (Number.isNaN(mins)) return iso;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

const dur = (mins?: number | null) => {
  if (mins == null || !Number.isFinite(mins)) return '—';
  if (mins < 60) return `${Math.round(mins)}m`;
  if (mins < 60 * 24) return `${(mins / 60).toFixed(mins % 60 === 0 ? 0 : 1)}h`;
  return `${(mins / 1440).toFixed(mins % 1440 === 0 ? 0 : 1)}d`;
};

/** "next check" for a scheduled source: last_run_at + its own staleness budget. Pure arithmetic on fields the backend already returns — not a new staleness rule. */
const dueHint = (s: SourceStatus) => {
  if (!s.last_run_at || s.age_minutes == null) return null;
  const remaining = s.max_age_minutes - s.age_minutes;
  return remaining >= 0 ? `due in ${dur(remaining)}` : `${dur(-remaining)} overdue`;
};

type Health = 'stale' | 'degraded' | 'fresh';

function healthOf(s: SourceStatus): Health {
  if (s.stale) return 'stale';
  if (s.confidence != null && s.confidence < 1) return 'degraded';
  return 'fresh';
}

const HEALTH_STYLE: Record<Health, { label: string; pill: string; dot: string }> = {
  stale: { label: 'Stale', pill: 'border-rose-200 bg-rose-50 text-rose-700', dot: 'bg-rose-500' },
  degraded: { label: 'Degraded', pill: 'border-amber-200 bg-amber-50 text-amber-700', dot: 'bg-amber-500' },
  fresh: { label: 'Fresh', pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' }
};

const SEVERITY: Record<Health, number> = { stale: 0, degraded: 1, fresh: 2 };

function stalestFirst(a: SourceStatus, b: SourceStatus) {
  const sev = SEVERITY[healthOf(a)] - SEVERITY[healthOf(b)];
  if (sev !== 0) return sev;
  const ca = a.confidence ?? 0, cb = b.confidence ?? 0;
  if (ca !== cb) return ca - cb;
  return (b.age_minutes ?? 0) - (a.age_minutes ?? 0);
}

/**
 * A rough, label-driven guess at what breaks downstream when a source goes
 * stale. source-registry.js has no source -> feature graph to read, so this
 * pattern-matches the source id/label for known keywords. Hedged as "likely"
 * on screen since it's a heuristic, unlike everything else on this page.
 */
function likelyImpact(s: SourceStatus): string {
  const t = `${s.source} ${s.label}`.toLowerCase();
  const hit = (...kws: string[]) => kws.some(k => t.includes(k));
  if (hit('roster')) return 'Rosters, Trade Lab, Draft, depth charts';
  if (hit('depth_chart', 'depth chart')) return "Depth charts, Start/Sit, X's & O's";
  if (hit('cap')) return 'Salary cap pages, offseason planner';
  if (hit('news')) return 'News page, camp roundup';
  if (hit('top100', 'accolade')) return 'Accolades / Top 100 list';
  if (hit('adp', 'fantasycalc')) return 'Trade Lab market values, Draft rankings';
  if (hit('mlb')) return 'MLB betting board';
  if (hit('poly', 'sharp', 'pick_watch', 'clv', 'forward', 'beat_the_close', 'shopping', 'book_feed', 'line', 'odds', 'sgo'))
    return 'Betting Desk, market board, execution/CLV tracking';
  if (hit('model', 'coordinator', 'calibration', 'decision_ledger', 'reports', 'weekly_learning', 'growth'))
    return 'The Model / Lab accuracy pages';
  if (hit('ngs', 'pfr', 'snap', 'nflverse', 'usage', 'pbp')) return 'Player stats, Start/Sit, Trends';
  if (hit('schedule')) return 'Matchups, schedule-dependent views';
  if (hit('qbr', 'weather', 'nfelo', 'external_ratings')) return 'The Model inputs';
  if (hit('injur')) return 'Start/Sit, News, player status badges';
  if (hit('press')) return 'Camp roundup context';
  if (hit('college', 'rookie')) return 'Rookie prior / draft grades';
  return 'Background pipeline feeding the model';
}

function SourceRow({ s }: { s: SourceStatus }) {
  const h = healthOf(s);
  const style = HEALTH_STYLE[h];
  const due = s.scheduled ? dueHint(s) : null;
  return (
    <tr className="align-top">
      <td className="py-2 pr-3">
        <div className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
          <span className="text-sm font-semibold text-slate-800">{s.label}</span>
        </div>
        <div className="mt-0.5 text-[11px] text-slate-400">{s.source}</div>
      </td>
      <td className="py-2 pr-3">
        <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${style.pill}`}>
          {style.label}
        </span>
        {s.confidence != null && <div className="mt-1 text-[10px] text-slate-400 tabular-nums">{Math.round(s.confidence * 100)}% confidence</div>}
      </td>
      <td className="py-2 pr-3 text-xs text-slate-600 tabular-nums whitespace-nowrap">
        {ago(s.last_run_at)}
        <div className="text-[10px] text-slate-400">{s.last_status}</div>
      </td>
      <td className="py-2 pr-3 text-xs text-slate-600 whitespace-nowrap">
        {s.cadence}
        {due && <div className="text-[10px] text-slate-400">{due}</div>}
        {!s.scheduled && <div className="text-[10px] text-slate-400">budget {dur(s.max_age_minutes)}</div>}
      </td>
      <td className="py-2 pr-3 text-xs text-slate-500 max-w-[240px]" title={s.cutoff}>{s.cutoff}</td>
      <td className="py-2 pr-3 text-xs text-slate-500 max-w-[260px]" title={s.failure_mode}>{s.failure_mode}</td>
      <td className="py-2 text-xs text-slate-500 max-w-[220px]">{likelyImpact(s)}</td>
    </tr>
  );
}

function SourceTable({ title, hint, sources }: { title: string; hint: string; sources: SourceStatus[] }) {
  if (sources.length === 0) return null;
  const sorted = useMemo(() => [...sources].sort(stalestFirst), [sources]);
  return (
    <div className="card p-5 mb-4">
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-sm font-bold text-slate-800">{title}</h2>
        <span className="text-xs text-slate-400">{hint} · {sources.length}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-slate-400">
              <th className="pb-1.5 pr-3 font-medium">Source</th>
              <th className="pb-1.5 pr-3 font-medium">State</th>
              <th className="pb-1.5 pr-3 font-medium">Last sync</th>
              <th className="pb-1.5 pr-3 font-medium">Cadence</th>
              <th className="pb-1.5 pr-3 font-medium">Cutoff</th>
              <th className="pb-1.5 pr-3 font-medium">If it fails</th>
              <th className="pb-1.5 font-medium">Likely affects</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.map(s => <SourceRow key={s.source} s={s} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function DataHealth() {
  const { data, loading, error, refetch } = useApi<SourcesResponse>('/dev/sources');
  const { data: devStatus } = useApi<DevStatus>('/dev/status');
  const { data: betting } = useApi<BettingSummary>('/betting/summary');

  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshResult, setRefreshResult] = useState<RefreshResult | null>(null);

  const runRefreshAll = async () => {
    setRefreshing(true); setRefreshError(null); setRefreshResult(null);
    try {
      const r = await api<RefreshResult>('/dev/refresh-all', { method: 'POST' });
      setRefreshResult(r);
      refetch();
    } catch (e: any) { setRefreshError(e.message); }
    finally { setRefreshing(false); }
  };

  const sources = data?.sources ?? [];
  const counts = useMemo(() => {
    const c = { fresh: 0, degraded: 0, stale: 0 };
    for (const s of sources) c[healthOf(s)]++;
    return c;
  }, [sources]);
  const attention = useMemo(() => sources.filter(s => healthOf(s) === 'stale').sort(stalestFirst), [sources]);
  const scheduled = sources.filter(s => s.scheduled);
  const manual = sources.filter(s => !s.scheduled);

  const oddsApi = betting?.odds_api;

  return (
    <div className="max-w-6xl">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Data Health</h1>
          <p className="text-sm text-slate-600">
            Every ingestion source Gridiron HQ depends on — cadence, last sync, failure mode, and what breaks if it goes stale.
          </p>
        </div>
        <button className="btn-primary" disabled={refreshing} onClick={runRefreshAll}>
          {refreshing ? 'Refreshing…' : '↻ Refresh everything'}
        </button>
      </div>

      {loading && !data && <PageLoading label="Loading data sources…" />}
      {error && !data && <PageError message={error} onRetry={refetch} />}

      {data && <>
        {/* Summary strip */}
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="card p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">Sources tracked</div>
            <div className="text-xl font-bold text-slate-900 tabular-nums">{data.count}</div>
          </div>
          <div className="card p-3 border-crit">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">Stale</div>
            <div className="text-xl font-bold text-crit tabular-nums">{counts.stale}</div>
          </div>
          <div className="card p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">Degraded</div>
            <div className="text-xl font-bold text-amber-600 tabular-nums">{counts.degraded}</div>
          </div>
          <div className="card p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">Fresh</div>
            <div className="text-xl font-bold text-emerald-700 tabular-nums">{counts.fresh}</div>
          </div>
        </div>

        {/* Auth / quota state */}
        <div className="card p-5 mb-4">
          <h2 className="mb-3 text-sm font-bold text-slate-800">Authentication &amp; quota</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 p-3">
              <span className={`h-2 w-2 rounded-full ${devStatus?.api_key?.configured ? 'bg-emerald-500' : 'bg-slate-300'}`} />
              <div>
                <div className="text-xs font-semibold text-slate-700">Anthropic API key (AI features)</div>
                <div className="text-[11px] text-slate-500">
                  {devStatus?.api_key?.configured ? `Configured · ${devStatus.api_key.masked}` : 'Not configured — AI verdicts, news explanations and roundups are off'}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 p-3">
              <span className={`h-2 w-2 rounded-full ${oddsApi?.has_key ? (oddsApi.requests_remaining != null && oddsApi.requests_remaining <= 0 ? 'bg-rose-500' : 'bg-emerald-500') : 'bg-slate-300'}`} />
              <div>
                <div className="text-xs font-semibold text-slate-700">The Odds API (betting lines/props)</div>
                <div className="text-[11px] text-slate-500 tabular-nums">
                  {!oddsApi?.has_key
                    ? 'No key configured — betting board runs model-only'
                    : oddsApi.requests_remaining == null
                      ? 'Key configured — no usage recorded yet'
                      : `${oddsApi.requests_remaining} requests remaining (${oddsApi.requests_used ?? '—'} used) · last call ${ago(oddsApi.last_call_at)}`}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Refresh result */}
        {refreshError && <div className="card p-4 mb-4 border-crit"><p className="text-sm text-crit">Refresh failed: {refreshError}</p></div>}
        {refreshResult && (
          <div className="card p-5 mb-4">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-sm font-bold text-slate-800">Last refresh result</h2>
              {refreshResult.failed.length === 0
                ? <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700">All steps ok</span>
                : <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-bold uppercase text-rose-700">{refreshResult.failed.length} failed</span>}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {refreshResult.steps.map(step => (
                <div key={step.name} className={`rounded-lg border p-2 text-xs ${step.ok ? 'border-slate-200' : 'border-rose-200 bg-rose-50'}`}>
                  <div className={`font-semibold ${step.ok ? 'text-slate-700' : 'text-rose-700'}`}>{step.ok ? '✓' : '✕'} {step.name}</div>
                  {step.ok
                    ? <div className="text-[10px] text-slate-400 tabular-nums">
                        {['added', 'updated', 'fetched', 'count'].filter(k => typeof step[k] === 'number')
                          .map(k => `${k} ${step[k]}`).join(' · ') || 'done'}
                      </div>
                    : <div className="text-[10px] text-rose-600">{String(step.error ?? 'error')}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Needs attention */}
        {attention.length > 0 && (
          <div className="card p-4 mb-4 border-crit">
            <h2 className="mb-1 text-sm font-bold text-crit">Needs attention ({attention.length})</h2>
            <ul className="space-y-0.5 text-xs text-slate-700">
              {attention.map(s => (
                <li key={s.source} className="flex justify-between gap-3">
                  <span>{s.label}</span>
                  <span className="text-slate-400 tabular-nums">{ago(s.last_run_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <SourceTable title="Scheduled sources" hint="run automatically on a timer" sources={scheduled} />
        <SourceTable title="Manual sources" hint="on-demand only — refreshed by Refresh everything or their own sync route" sources={manual} />
      </>}
    </div>
  );
}
