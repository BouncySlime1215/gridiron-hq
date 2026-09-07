/**
 * Tiny inline bar series — pure divs, no chart library. Bars share one scale so a
 * 300-point season visibly towers over a 90-point one. Renders nothing for empty input.
 */
export default function SparkBar({ values, labels, height = 18, className = '' }:
  { values: number[]; labels?: (string | number)[]; height?: number; className?: string }) {
  if (!values.length) return null;
  const max = Math.max(...values, 1);
  return (
    <div className={`flex items-end gap-0.5 ${className}`} style={{ height }} aria-hidden>
      {values.map((v, i) => (
        <div key={i} title={labels?.[i] != null ? `${labels[i]}: ${Math.round(v)}` : String(Math.round(v))}
          className={`w-2 rounded-sm ${i === values.length - 1 ? 'bg-sky-600' : 'bg-slate-300'}`}
          style={{ height: `${Math.max(8, (v / max) * 100)}%` }} />
      ))}
    </div>
  );
}

/** A single horizontal bar, used per row in the evidence table. */
export function InlineBar({ value, max, className = '' }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={`h-1.5 w-full rounded-full bg-slate-100 overflow-hidden ${className}`} aria-hidden>
      <div className="h-full rounded-full bg-sky-500" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * The p20–p80 preseason band as a bar rather than two numbers: the same track as
 * `InlineBar` (identical height, radius and slate-100 rail, so a row that carries
 * both reads as one family), with the band drawn between the quantiles and a tick
 * at the median.
 *
 * `max` is the shared scale for the list the bar sits in — pass the largest p80 on
 * screen so two players' bands are directly comparable by width and position. A
 * band that is only 4 points wide would otherwise vanish, so it is floored at 3%.
 */
export function RangeBar({ low, high, mid, max, className = '', title }: {
  low: number; high: number; mid?: number | null; max: number; className?: string; title?: string;
}) {
  if (!(max > 0) || !Number.isFinite(low) || !Number.isFinite(high)) return null;
  const clamp = (v: number) => Math.max(0, Math.min(100, (v / max) * 100));
  const left = clamp(Math.min(low, high));
  const width = Math.max(3, clamp(Math.max(low, high)) - left);
  const tick = mid != null && Number.isFinite(mid) ? clamp(mid) : null;
  return (
    <div className={`relative h-1.5 w-full rounded-full bg-slate-100 ${className}`}
      title={title ?? `${Math.round(low)}–${Math.round(high)} pts (p20–p80)`} aria-hidden>
      <div className="absolute inset-y-0 rounded-full bg-sky-200" style={{ left: `${left}%`, width: `${width}%` }} />
      {tick != null && (
        <div className="absolute inset-y-0 w-0.5 -ml-px rounded-full bg-sky-700" style={{ left: `${tick}%` }} />
      )}
    </div>
  );
}
