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
