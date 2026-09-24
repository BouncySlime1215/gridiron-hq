import type { ReasonChainV2 } from '../../engine/useEngineView';

/**
 * A reason chain v2 as signed rows (ENGINE-ARCHITECTURE.md §2.10; UI-RED 4): the baseline,
 * then every contribution with its delta as stored, then the residual when it is not 0.
 * Deltas are shown as written, never re-derived.
 */
function signed(d: number | null): string {
  if (d == null) return '';
  return d > 0 ? `+${d}` : String(d);
}

export default function ReasonChain({ chain }: { chain: ReasonChainV2 | null }) {
  if (!chain) return <div className="text-xs text-slate-500 italic">no reasons recorded</div>;
  return (
    <ul className="text-xs space-y-0.5">
      {chain.baseline ? <li className="text-slate-600">{chain.baseline.text}</li> : null}
      {chain.contributions.map((c, i) => (
        <li key={i} data-kind={c.kind}>
          <span className={`tabular-nums ${c.delta != null && c.delta < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
            {signed(c.delta)}
          </span>{' '}
          {c.text}
        </li>
      ))}
      {chain.residual ? <li className="text-slate-500">{signed(chain.residual)} not explained by the rows above</li> : null}
    </ul>
  );
}
