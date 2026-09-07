import type { PackageRisk, SideRisk } from './types';

const n0 = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));

const floorOf = (r: PackageRisk) => r.players.length === 0 ? '—'
  : r.seasons ? `${r.top24_seasons}/${r.seasons} top-24` : 'no record';
const ceilingOf = (r: PackageRisk) => r.p80 != null ? `${n0(r.p80)} pts` : '—';
const swingOf = (r: PackageRisk) => r.swing_pct != null ? `±${r.swing_pct}%` : r.players.length ? 'n/a' : '—';

/**
 * Floor / Ceiling / Consistency for one side of a deal: what leaves → what
 * arrives, from each package's multi-season record and this season's p80.
 * Rendered only when at least one player on the side carries a record.
 */
export default function RiskStrip({ risk, compact = false }: { risk?: SideRisk | null; compact?: boolean }) {
  if (!risk?.out || !risk?.in) return null;
  const anyRecord = risk.out.seasons > 0 || risk.in.seasons > 0 || risk.out.p80 != null || risk.in.p80 != null;
  if (!anyRecord) return null;

  const cell = (label: string, out: string, inn: string, title: string, better?: boolean | null) => (
    <div className="min-w-0" title={title}>
      <dt className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</dt>
      <dd className="tabular-nums text-[11px] text-[var(--ink)] whitespace-nowrap">
        <span className="text-[var(--muted)]">{out}</span>
        <span className="text-[var(--muted)] mx-1">→</span>
        <span className={`font-semibold ${better === true ? 'text-good' : better === false ? 'text-crit' : ''}`}>{inn}</span>
      </dd>
    </div>
  );

  const floorBetter = risk.out.seasons && risk.in.seasons
    ? (risk.in.top24_seasons / risk.in.seasons) - (risk.out.top24_seasons / risk.out.seasons) : null;
  const swingBetter = risk.out.swing_pct != null && risk.in.swing_pct != null ? risk.out.swing_pct - risk.in.swing_pct : null;
  const ceilBetter = risk.out.p80 != null && risk.in.p80 != null ? risk.in.p80 - risk.out.p80 : null;
  const sign = (d: number | null) => d == null || Math.abs(d) < 1e-9 ? null : d > 0;

  return (
    <div className={compact ? 'mt-1.5' : 'mt-2 pt-2 border-t border-[var(--edge)]'}>
      <dl className="grid grid-cols-3 gap-x-2">
        {cell('Floor', floorOf(risk.out), floorOf(risk.in), 'Seasons finishing top-24 at the position, out of seasons on record (sends → receives)', sign(floorBetter))}
        {cell('Ceiling', ceilingOf(risk.out), ceilingOf(risk.in), 'This season, p80 of our preseason model (sends → receives)', sign(ceilBetter))}
        {cell('Consistency', swingOf(risk.out), swingOf(risk.in), 'Year-to-year swing in season points (lower is steadier; sends → receives)', sign(swingBetter))}
      </dl>
      {risk.read && !compact && (
        <p className="mt-1 text-[11px] text-[var(--muted)]">You are {risk.read}.</p>
      )}
    </div>
  );
}
