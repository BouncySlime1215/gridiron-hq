import type { Preview } from './coach/warroomCoach';
import { NOT_COMPUTED, pts, size } from './format';

/**
 * The producer's stop_tradeoffs entry for one plan change, read not computed (the Coach
 * dock and the WR-3 sheets both draw it). A title-odds number (source sim.title) prints
 * in points, anything else as written. A missing entry prints the preview's reason
 * ("Trade-off not computed yet: ..."), never a number.
 */
function fmt(f: any, signed = false): string {
  if (f == null) return NOT_COMPUTED;
  if (typeof f === 'number' || typeof f === 'string') return String(f);
  if (typeof f !== 'object' || f.status !== 'ok' || typeof f.value !== 'number') return NOT_COMPUTED;
  const text = f.source === 'sim.title' ? (signed ? pts(f.value) : size(f.value)) : String(f.value);
  return `${text}${f.guess ? ' (guess)' : ''}`;
}

export default function TradeoffPreview({ preview }: { preview: Preview }) {
  const v = preview.value;
  if (preview.status !== 'ok' || !v) return <p data-testid="tradeoff-preview">{preview.reason}</p>;
  return (
    <ul data-testid="tradeoff-preview">
      {v.stop_label && <li>{v.stop_label}</li>}
      <li>Costs: {fmt(v.cost)}{v.extra_steps != null ? `, ${v.extra_steps} extra step(s)` : ''}</li>
      <li>Gains: {fmt(v.gain)}{v.gain_text ? ` (${v.gain_text})` : ''}</li>
      <li>Net: {fmt(v.net, true)}{v.verdict ? `: ${String(v.verdict).replace(/_/g, ' ')}` : ''}</li>
      {v.because && <li>Because {v.because}</li>}
      {v.new_next_move_changes != null && <li>Next move {v.new_next_move_changes ? 'changes' : 'stays the same'}</li>}
    </ul>
  );
}
