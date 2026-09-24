import type { ReasonChainV2 } from '../../engine/useEngineView';
import { DriverBars } from '../ui/DesignSystem';

/**
 * A reason chain v2 as signed rows (ENGINE-ARCHITECTURE.md §2.10; UI-RED 4), drawn with the
 * design system's DriverBars (FIX-257-2): the baseline, then every contribution with its
 * delta as stored, then the residual when it is not 0.
 * Deltas are shown as written, never re-derived: no rounding, and no total (the client does
 * no arithmetic on engine values). A contribution with no delta is listed, never drawn as 0.
 */
function signed(d: number): string {
  return d > 0 ? `+${d}` : String(d);
}

export default function ReasonChain({ chain }: { chain: ReasonChainV2 | null }) {
  if (!chain) return <div className="text-xs text-slate-500 italic">no reasons recorded</div>;
  const drivers = chain.contributions.filter(c => c.delta != null)
    .map(c => ({ label: c.text, value: c.delta as number, detail: `${c.kind}: ${c.source}` }));
  const undrawn = chain.contributions.filter(c => c.delta == null);
  return (
    <div className="space-y-2 text-xs">
      {chain.baseline ? <div className="text-slate-600">{chain.baseline.text}</div> : null}
      {drivers.length ? <DriverBars drivers={drivers} format={signed} showTotal={false} /> : null}
      {undrawn.map((c, i) => (
        <div key={i} data-kind={c.kind} className="text-slate-600">
          {c.text} <span className="text-slate-400">(no point delta)</span>
        </div>
      ))}
      {chain.residual ? <div className="text-slate-500">{signed(chain.residual)} not explained by the rows above</div> : null}
    </div>
  );
}
