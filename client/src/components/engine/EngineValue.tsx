import type { EngineRow } from '../../engine/useEngineView';
import { Provenance } from '../ui/DesignSystem';

/**
 * One engine value, rendered by its typed status (UI-RED 2; HEALTH-01b). Each status
 * reads differently, and none of them can pass for another:
 *   ok         the value
 *   zero       0 (a measured absence, not a missing row)
 *   unknown    "not computed yet" and the reason; never 0, never a dash
 *   stale      the value, "stale, N min old"
 *   fallback   the fallback's value, "fallback: <field>" and why
 *   thin       the value, amber "thin (n=N)"
 *   degraded   the value, "degraded"
 *   last_good  the last good value, "last good, N min old" (the newest row failed)
 * A status this component does not know renders as unknown, so a failed value can never
 * slip through as if it were fine. `format` only formats; it never computes.
 * The source line (producer@version, as of) is the design system's Provenance (FIX-257-2).
 */
function defaultFormat(v: unknown): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

const NOTE: Record<string, string> = {
  stale: 'text-amber-700',
  fallback: 'text-amber-700',
  thin: 'text-amber-700 bg-amber-50 rounded px-1',
  degraded: 'text-rose-700',
  last_good: 'text-amber-700',
};

export default function EngineValue({ row, format = defaultFormat }: { row: EngineRow; format?: (v: any) => string }) {
  const source = row.producer ? `${row.producer}@${row.producer_version}` : null;
  const known = ['ok', 'zero', 'stale', 'fallback', 'thin', 'degraded', 'last_good'].includes(String(row.status));
  if (!known || (row.status !== 'zero' && row.value == null)) {
    return (
      <span data-engine-status="unknown" className="text-slate-500 italic">
        not computed yet{row.reason ? ` (${row.reason})` : ''}
      </span>
    );
  }
  const shown = row.status === 'zero' ? '0' : format(row.value);
  let note: string | null = null;
  if (row.status === 'stale') note = `stale, ${row.age_min ?? '?'} min old`;
  else if (row.status === 'fallback') note = `fallback: ${row.fallback_field ?? 'baseline'}${row.reason ? `; ${row.reason}` : ''}`;
  else if (row.status === 'thin') {
    const n = (row.value && typeof row.value === 'object' ? row.value.n : null) ?? row.reason_chain?.n ?? null;
    note = `thin (n=${n ?? '?'})`;
  } else if (row.status === 'degraded') note = 'degraded';
  else if (row.status === 'last_good') note = `last good, ${row.age_min ?? '?'} min old`;
  else if (row.status === 'zero' && row.reason) note = row.reason;
  return (
    <span data-engine-status={row.status} title={row.reason ?? undefined}>
      <span className="tabular-nums">{shown}</span>
      {note ? <span className={`ml-1 text-xs ${NOTE[row.status] ?? 'text-slate-500'}`}>{note}</span> : null}
      {source ? (
        <span className="ml-1 inline-block align-baseline">
          <Provenance source={source} updatedAt={row.as_of} version={row.producer_version}>
            {row.fresh_at ? <div>Last computed: {new Date(row.fresh_at).toLocaleString()}</div> : null}
          </Provenance>
        </span>
      ) : null}
    </span>
  );
}
