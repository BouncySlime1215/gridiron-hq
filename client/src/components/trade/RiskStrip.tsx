import type { PackageRisk, SideRisk } from './types';

const n0 = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));

/**
 * Floor, and what the number is actually taken over.
 *
 * `seasons` is summed over the players whose career layer could be READ
 * (packageRisk's `withRecord`), so it is not the package's own count whenever
 * `unreadable` is non-zero. Two readings used to collapse into one here: a
 * package with no record, and a package whose record could not be fetched.
 * The second is not a finding about the players, and saying "no record" about
 * a five-year starter because a query threw is the defect this unit exists to
 * remove — one layer above where it was removed from trade-engine.js.
 */
const floorOf = (r: PackageRisk) => {
  if (r.players.length === 0) return '—';
  const unread = r.unreadable ?? 0;
  if (!r.seasons) return unread ? 'not readable' : 'no record';
  return unread
    ? `${r.top24_seasons}/${r.seasons} top-24 (${r.players.length - unread}/${r.players.length})`
    : `${r.top24_seasons}/${r.seasons} top-24`;
};
const swingOf = (r: PackageRisk) => r.swing_pct != null ? `±${r.swing_pct}%` : r.players.length ? 'n/a' : '—';

/**
 * Colour for the Ceiling cell (RL-3-3, WORK-QUEUE C-13). This used to be
 * `risk.in.p80 - risk.out.p80` — a sum of each PACKAGE's own draft-day p80.
 * That mostly tracks who receives more players, and the row's own count
 * puts it in contradiction with the "Weekly ceiling" number already on this
 * same card (TradeCard.tsx's `s.ceiling_delta` / `deal.me.ceiling_delta`,
 * from trade-engine.js `lazyField(out, 'ceiling_delta', ...)`, a lineup-level
 * p90 delta) on 37-62 of 122-180 card sides. The card must show one number,
 * not two: this cell's colour AND its text now follow `ceiling_delta` alone.
 * The summed package p80 pair is no longer printed here either — printing it
 * next to a colour taken from a different number would just move the
 * contradiction inside the cell (RL-3-3 skeptic round, 37/122 sides).
 */
const ceilingBetter = (delta: number | null | undefined) =>
  delta == null || Math.abs(delta) < 1e-9 ? null : delta > 0;

/** The Ceiling cell's text: the same lineup-level ceiling_delta, signed, one decimal. */
const ceilingText = (delta: number | null | undefined) =>
  delta == null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} pts`;

/**
 * Floor / Ceiling / Consistency for one side of a deal. Floor and Consistency
 * are what leaves → what arrives, from each package's multi-season record;
 * Ceiling is the lineup's Weekly-ceiling change (one number, not a pair).
 * Rendered only when at least one player on the side carries a record.
 *
 * `ceilingDelta` is the lineup-level Weekly-ceiling change already shown
 * elsewhere on the card (TradeCard.tsx); it is the Ceiling cell's value and
 * colour, instead of the packages' own summed p80 (see `ceilingBetter` above).
 */
export default function RiskStrip({ risk, compact = false, ceilingDelta = null }: { risk?: SideRisk | null; compact?: boolean; ceilingDelta?: number | null }) {
  if (!risk?.out || !risk?.in) return null;
  // A side whose career AND preseason layers both failed has seasons 0 and p80
  // null, which used to make the whole strip disappear — the failure rendered as
  // nothing at all. It counts as something to say, so the Floor cell can say it.
  const anyRecord = risk.out.seasons > 0 || risk.in.seasons > 0 || risk.out.p80 != null || risk.in.p80 != null
    || (risk.out.unreadable ?? 0) > 0 || (risk.in.unreadable ?? 0) > 0;
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
  // One value, no sends → receives pair: for a lineup-level change there is no
  // "what leaves" number to print, and the value and its colour share a producer.
  const single = (label: string, value: string, title: string, better?: boolean | null) => (
    <div className="min-w-0" title={title}>
      <dt className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</dt>
      <dd className="tabular-nums text-[11px] text-[var(--ink)] whitespace-nowrap">
        <span className={`font-semibold ${better === true ? 'text-good' : better === false ? 'text-crit' : ''}`}>{value}</span>
      </dd>
    </div>
  );

  // Both rates are taken over the readable players only, so with anything
  // unreadable on either side this compares two different-sized samples and
  // colours the cell off the result. No colour is the honest answer there:
  // null leaves the cell neutral, exactly as an absent p80 already does.
  const floorFullyRead = !(risk.out.unreadable ?? 0) && !(risk.in.unreadable ?? 0);
  const floorBetter = risk.out.seasons && risk.in.seasons && floorFullyRead
    ? (risk.in.top24_seasons / risk.in.seasons) - (risk.out.top24_seasons / risk.out.seasons) : null;
  const swingBetter = risk.out.swing_pct != null && risk.in.swing_pct != null ? risk.out.swing_pct - risk.in.swing_pct : null;
  const sign = (d: number | null) => d == null || Math.abs(d) < 1e-9 ? null : d > 0;

  return (
    <div className={compact ? 'mt-1.5' : 'mt-2 pt-2 border-t border-[var(--edge)]'}>
      <dl className="grid grid-cols-3 gap-x-2">
        {cell('Floor', floorOf(risk.out), floorOf(risk.in),
          floorFullyRead
            ? 'Seasons finishing top-24 at the position, out of seasons on record (sends → receives)'
            : 'Seasons finishing top-24 at the position, out of seasons on record (sends → receives). '
              + 'A career record on this deal could not be read, so the count covers only part of the '
              + 'package and the comparison is left uncoloured.',
          sign(floorBetter))}
        {single('Ceiling', ceilingText(ceilingDelta),
          "Change in your starting lineup's total in a good week (1 week in 10) — the same "
          + 'number as Weekly ceiling on this card',
          ceilingBetter(ceilingDelta))}
        {cell('Consistency', swingOf(risk.out), swingOf(risk.in), 'Year-to-year swing in season points (lower is steadier; sends → receives)', sign(swingBetter))}
      </dl>
      {risk.read && !compact && (
        <p className="mt-1 text-[11px] text-[var(--muted)]">You are {risk.read}.</p>
      )}
    </div>
  );
}
