import { useApi } from '../../api';

/**
 * Consumption-only: renders whatever GET /api/model/registry/candidates returns.
 * No local schema/availability assumptions — a feature only shows "Available"
 * when the server-side feature contract (server/modeling/candidates.js) says so.
 */
interface FeatureDefinition {
  type?: string; required?: boolean; available?: boolean; status?: string;
  unavailable_reason?: string; description?: string;
}
interface FeatureContract { name: string; version: string; features: Record<string, FeatureDefinition> }
interface CandidatesResponse { candidates: { name: string; version: string }[]; feature_contract: FeatureContract }

export default function ModelRegistryPanel() {
  const { data, loading, error } = useApi<CandidatesResponse>('/model/registry/candidates');

  if (loading) return <div className="card p-6 text-sm text-slate-500" role="status">Loading registered backtest candidates…</div>;
  if (error) return <div className="card p-6 text-sm text-rose-700" role="alert">Model registry is unavailable: {error}</div>;

  const features = Object.entries(data?.feature_contract?.features ?? {});

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h3 className="text-sm font-bold text-slate-700 mb-2">Backtest candidates</h3>
        <p className="text-[11px] text-slate-500 mb-2">
          Every candidate below runs inside the same walk-forward auditor, on the same pinned
          dataset and feature versions, and is graded against the same frozen baseline.
        </p>
        <ul className="flex flex-wrap gap-2">
          {(data?.candidates ?? []).map(c => (
            <li key={c.name} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
              {c.name} <span className="text-slate-400 font-normal">v{c.version}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="card overflow-hidden">
        <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
          <h3 className="text-sm font-bold text-slate-700">
            Feature contract — {data?.feature_contract?.name} v{data?.feature_contract?.version}
          </h3>
          <p className="text-[10px] text-slate-400">
            Fields marked unavailable are declared for forward compatibility only and are never populated.
          </p>
        </div>
        <div className="divide-y divide-slate-100">
          {features.map(([name, def]) => (
            <div key={name} className="px-3 py-2 flex items-start gap-3 text-xs">
              <span className="font-semibold text-slate-800 w-48 shrink-0">{name}</span>
              <span className="flex-1 text-slate-500">{def.description}</span>
              {def.available === false ? (
                <span title={def.unavailable_reason}
                  className="rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide whitespace-nowrap">
                  Unavailable
                </span>
              ) : (
                <span className="rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide whitespace-nowrap">
                  Available
                </span>
              )}
            </div>
          ))}
          {!features.length && <p className="p-4 text-xs text-slate-500">No feature contract registered yet.</p>}
        </div>
      </div>
    </div>
  );
}
