import { readField, type PlugCard } from './warroomCoach';

/**
 * A card Coach plugged in: one whitelisted plans field, drawn as a number,
 * list, sparkline or table. The value is read from the plans JSON; nothing
 * here computes one. A missing field says "Not computed yet", never 0.
 * The sparkline only maps the producer's points to pixels.
 */
function label(v: any): string {
  if (v == null) return 'Not computed yet';
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object' && 'value' in v && (typeof v.value === 'number' || typeof v.value === 'string')) return String(v.value);
  if (typeof v === 'object') return v.label ?? v.text ?? v.name ?? v.player ?? v.id ?? JSON.stringify(v).slice(0, 80);
  return String(v);
}

function pointsOf(value: any[]): number[] {
  return value.map(p => (typeof p === 'number' ? p : typeof p?.value === 'number' ? p.value
    : typeof p?.actual === 'number' ? p.actual : typeof p?.planned === 'number' ? p.planned : NaN)).filter(Number.isFinite);
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <p className="text-sm text-slate-500">Not enough points to draw yet.</p>;
  const lo = Math.min(...values); const hi = Math.max(...values); const span = hi - lo || 1;
  const d = values.map((v, i) => `${(i / (values.length - 1)) * 200},${40 - ((v - lo) / span) * 36 - 2}`).join(' ');
  return <svg viewBox="0 0 200 40" className="h-10 w-full" role="img" aria-label="sparkline"><polyline points={d} fill="none" stroke="var(--ink)" strokeWidth="1.5" /></svg>;
}

/** Plain names for the whitelisted fields (warroomCoach.ts PLUG_IN_FIELDS); a dotted id is never shown. */
export const FIELD_LABELS: Record<string, string> = {
  'destination.title_now': 'Title odds now',
  'destination.path': 'Title odds path',
  'itinerary.stops': 'Plan stops',
  targets: 'Suggested targets',
  speed_curve: 'Speed curve',
  flip_map: 'Flips',
  'brain_report.checks': 'Brain checks',
};
const plain = (id: string) => FIELD_LABELS[id] ?? id.split('.').pop()!.replace(/_/g, ' ');
/** Coach's own title when it is words; a dotted or snake_case id becomes the plain name. */
export const cardTitle = (card: { field: string; title?: string | null }) =>
  (card.title && !/[._]/.test(card.title) && card.title !== card.field ? card.title : plain(card.field));

export default function PlugInCard({ card, plans, onRemove }: { card: PlugCard; plans: any; onRemove?: () => void }) {
  const value = readField(plans, card.field);
  const rows = Array.isArray(value) ? value : null;
  let body;
  if (value === undefined || value === null) body = <p className="text-sm text-slate-500">Not computed yet.</p>;
  else if (card.view === 'number') body = <div className="text-2xl font-bold">{label(value)}</div>;
  else if (card.view === 'sparkline') body = rows ? <Spark values={pointsOf(rows)} /> : <p className="text-sm text-slate-500">This field is not a series.</p>;
  else if (card.view === 'list') body = rows ? <ul className="text-sm">{rows.slice(0, 5).map((r, i) => <li key={i}>{label(r)}</li>)}{rows.length > 5 && <li className="text-slate-500">{rows.length - 5} more</li>}</ul> : <div>{label(value)}</div>;
  else {
    const cols = rows && rows.length && typeof rows[0] === 'object' ? Object.keys(rows[0]).filter(k => typeof rows[0][k] !== 'object').slice(0, 4) : [];
    body = rows && cols.length
      ? <table className="w-full text-sm"><thead><tr>{cols.map(c => <th key={c} className="text-left font-semibold">{c.replace(/_/g, ' ')}</th>)}</tr></thead>
          <tbody>{rows.slice(0, 6).map((r, i) => <tr key={i}>{cols.map(c => <td key={c}>{label(r[c])}</td>)}</tr>)}</tbody></table>
      : <div>{label(value)}</div>;
  }
  return (
    <div className="card p-3" data-plug-field={card.field}>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase text-slate-500" title="Coach picked what to show; the planner wrote the numbers">{cardTitle(card)}</span>
        <span className="flex-1" />
        {onRemove && <button className="btn-ghost text-xs" onClick={onRemove} aria-label="Remove card">Remove</button>}
      </div>
      {body}
    </div>
  );
}
