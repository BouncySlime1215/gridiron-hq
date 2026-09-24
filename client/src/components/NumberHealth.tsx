import { useApi } from '../api';
import { useLeague } from '../state/league';
import { sanitizedMessage } from '../lib/errorSanitize';

/**
 * BROKEN-01b: "Number health". Which numbers the app shows are broken for the
 * selected league, in plain words: what is wrong, which pages it affects, and what
 * to trust meanwhile.
 *
 * Reads GET /api/number-audit, which serves the rows the refresh loop writes
 * (server/services/number-audit.js). Nothing is computed in the browser or on the
 * request: if the loop has not run, the card says so instead of guessing.
 */

export interface NumberAuditRow {
  league_id: number;
  check_id: string;
  status: 'ok' | 'warn' | 'broken';
  inventory_row: string | null;
  title: string;
  detail: string;
  cause: string | null;
  trust: string | null;
  pages_affected: string[];
  as_of: string;
  first_seen_at: string;
}

export interface NumberAuditPayload {
  league_id: number | null;
  table_missing: boolean;
  as_of: string | null;
  broken: number;
  warn: number;
  ok: number;
  rows: NumberAuditRow[];
}

const STALE_AUDIT_HOURS = 6;

function when(iso: string | null) {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const minutes = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = minutes / 60;
  return hours < 48 ? `${hours.toFixed(hours < 10 ? 1 : 0)} h ago` : `${Math.round(hours / 24)} days ago`;
}

const TONE: Record<NumberAuditRow['status'], { chip: string; label: string }> = {
  broken: { chip: 'bg-rose-100 text-rose-800 ring-rose-200', label: 'Broken' },
  warn: { chip: 'bg-amber-100 text-amber-800 ring-amber-200', label: 'Check' },
  ok: { chip: 'bg-slate-100 text-slate-600 ring-slate-200', label: 'OK' },
};

/** One problem, in plain words. */
function ProblemRow({ row }: { row: NumberAuditRow }) {
  const tone = TONE[row.status];
  return <li className="rounded-md border border-slate-200 p-3" data-number-check={row.check_id} data-status={row.status}>
    <div className="flex items-start gap-2">
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ring-1 ${tone.chip}`}>{tone.label}</span>
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-semibold text-slate-900">{row.title}{row.inventory_row && <span className="ml-1 text-[10px] font-normal text-slate-400">(inventory {row.inventory_row})</span>}</div>
        <p className="text-xs text-slate-700">{row.detail}</p>
        {row.cause && <p className="text-xs text-slate-500"><span className="font-semibold">Why:</span> {row.cause}</p>}
        {row.pages_affected.length > 0 && <p className="text-xs text-slate-500" data-pages><span className="font-semibold">Pages:</span> {row.pages_affected.join(', ')}</p>}
        {row.trust && <p className="text-xs text-emerald-800" data-trust><span className="font-semibold">Meanwhile:</span> {row.trust}</p>}
        <p className="text-[10px] text-slate-400">Since {when(row.first_seen_at)}</p>
      </div>
    </div>
  </li>;
}

/** The card's body for a payload. Pure: exported for tests. */
export function NumberHealthView({ payload, loading = false, error = null }: {
  payload: NumberAuditPayload | null; loading?: boolean; error?: string | null;
}) {
  if (loading && !payload) return <p className="text-xs text-slate-500">Loading number health…</p>;
  if (error) return <p className="text-xs text-amber-700">{sanitizedMessage('NumberHealth', 'Could not load number health', error)}</p>;
  if (!payload) return <p className="text-xs text-slate-500">Pick a league to see its number health.</p>;
  if (payload.table_missing) {
    return <p className="text-xs text-slate-500">Number health is not set up yet. Restart the app once so the database update runs.</p>;
  }
  if (!payload.rows.length) {
    return <p className="text-xs text-slate-500">Not checked yet for this league. The background refresh checks each league after its next sync.</p>;
  }
  const problems = payload.rows.filter(r => r.status !== 'ok');
  const auditAge = payload.as_of ? (Date.now() - Date.parse(payload.as_of)) / 3600000 : null;
  return <div className="space-y-3">
    <p className="text-xs text-slate-600" data-summary>
      {payload.broken > 0
        ? <><span className="font-semibold text-rose-700">{payload.broken} broken</span>{payload.warn > 0 && `, ${payload.warn} to check`}</>
        : payload.warn > 0 ? <span className="font-semibold text-amber-700">Nothing broken, {payload.warn} to check</span>
          : <span className="font-semibold text-slate-700">All {payload.ok} checks pass</span>}
      {' '}· checked {when(payload.as_of)}
    </p>
    {auditAge != null && auditAge > STALE_AUDIT_HOURS && <p className="text-xs text-amber-700">This check is more than {STALE_AUDIT_HOURS} hours old; the background refresh may not be running.</p>}
    {problems.length > 0 && <ul className="space-y-2">{problems.map(r => <ProblemRow key={r.check_id} row={r} />)}</ul>}
    {payload.ok > 0 && problems.length > 0 && <p className="text-[11px] text-slate-400">{payload.ok} other checks pass.</p>}
  </div>;
}

const auditPath = (leagueId: number | null) => (leagueId ? `/number-audit?league_id=${leagueId}` : null);

/** Settings card for the selected league. */
export default function NumberHealthCard() {
  const { activeId, active } = useLeague();
  const { data, loading, error } = useApi<NumberAuditPayload>(auditPath(activeId));
  return <section className="card p-5 mb-4 space-y-3" aria-labelledby="number-health-heading">
    <div className="flex items-center gap-2">
      <BrokenDot broken={data?.broken ?? 0} />
      <h2 id="number-health-heading" className="text-lg font-bold">Number health</h2>
      {active?.name && <span className="text-xs text-slate-500">{active.name}</span>}
    </div>
    <p className="text-xs text-slate-500">Numbers that disagree between pages or fail a sanity check, and what to trust until they are fixed.</p>
    <NumberHealthView payload={data} loading={loading} error={error} />
  </section>;
}

/** The red dot. Renders nothing when nothing is broken. Pure: exported for tests. */
export function BrokenDot({ broken }: { broken: number }) {
  if (!(broken > 0)) return null;
  return <span data-broken-dot className="inline-block h-2 w-2 shrink-0 rounded-full bg-rose-600" role="img"
    aria-label={`${broken} broken number${broken === 1 ? '' : 's'} in this league`} title={`${broken} broken number${broken === 1 ? '' : 's'}: see Settings, Number health`} />;
}

/** The nav's dot for the selected league. */
export function NumberHealthNavDot() {
  const { activeId } = useLeague();
  const { data } = useApi<NumberAuditPayload>(auditPath(activeId), { staleTime: 5 * 60 * 1000 });
  return <BrokenDot broken={data?.broken ?? 0} />;
}
