import { useState } from 'react';
import Edge from './Edge';
import Model from './Model';
import { useApi } from '../api';

/**
 * Edge Tools and the Prediction Engine, merged into one hub.
 *
 * They were always two views of the same engine — Edge asks "who should I
 * start or trade for", the Prediction Engine asks "how good are the numbers
 * behind that". Keeping them apart meant switching pages mid-thought.
 *
 * Nothing was dropped in the merge: all seven Edge tabs and all five engine
 * tabs render the same components as before, just under one bar. Each page
 * still works standalone; passing `tab`/`embedded` is what lets this own the
 * navigation without either page drawing its own.
 */
const GROUPS = [
  {
    id: 'tools', label: 'Edge Tools', blurb: 'Player-level research — who to draft, start, or watch', source: 'edge' as const,
    tabs: [
      ['vor', 'Value Board'], ['movers', 'Breakouts & Regression'],
      ['volatility', 'Boom / Bust'], ['efficiency', 'Efficiency'],
      ['schedule', 'Playoff Schedule'], ['sim', 'Season Simulator']
    ] as [string, string][]
  },
  {
    id: 'engine', label: 'Prediction Engine', blurb: 'How the underlying model itself is doing, and why', source: 'model' as const,
    tabs: [
      ['registry', 'Registry'], ['accuracy', 'Accuracy'], ['odds', 'Championship Odds'],
      ['correlation', 'Correlation'], ['gamescript', 'Game Script'],
      ['handcuffs', 'Handcuffs']
    ] as [string, string][]
  }
];

const BLURB: Record<string, string> = {
  vor: 'Points over replacement — the real draft currency',
  movers: 'Who the projections are moving on, and why',
  volatility: 'Weekly floor, ceiling and consistency from real games',
  efficiency: 'Rate stats — usage share, yards per opportunity, TD-rate regression',
  schedule: 'Weeks 15-17 strength, ranked easiest to hardest',
  sim: 'Monte Carlo your lineup from real distributions',
  accuracy: 'How the model scores against the baselines it has to beat',
  registry: 'Persisted experiments, provenance, metrics, promotion history, and the production pointer',
  odds: 'Championship odds from a correlated season simulation',
  correlation: 'What rises together, and what cannot',
  gamescript: 'What the betting line predicts about volume',
  handcuffs: 'Who inherits the work if someone goes down'
};

export default function FantasyLab() {
  const [group, setGroup] = useState(GROUPS[0].id);
  const [tab, setTab] = useState<string>('vor');

  const active = GROUPS.find(g => g.id === group)!;

  const switchGroup = (id: string) => {
    const g = GROUPS.find(x => x.id === id)!;
    setGroup(id);
    setTab(g.tabs[0][0]);
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Research &amp; Model Lab</h1>
      <p className="text-sm text-slate-500 mb-4">
        Deep analytics that feed the rest of the app — not where you make trades or draft
        (that's Trade Lab and Draft Room). Two workspaces: research on players, or a look under
        the hood at the prediction model itself.
      </p>

      <div className="flex gap-2 mb-4">
        {GROUPS.map(g => (
          <button key={g.id} onClick={() => switchGroup(g.id)}
            className={`text-left px-3.5 py-2 rounded-xl border transition-colors ${
              group === g.id
                ? 'bg-[var(--accent-tint)] border-[var(--accent)] text-[var(--accent)]'
                : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
            }`}>
            <div className="text-sm font-semibold">{g.label}</div>
            <div className="text-[11px] opacity-80">{g.blurb}</div>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <div className="flex gap-1 border-b border-slate-200 flex-1 overflow-x-auto">
          {active.tabs.map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
                tab === id ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}>{label}</button>
          ))}
        </div>
      </div>
      <p className="text-xs text-slate-400 mb-4">{BLURB[tab] ?? ''}</p>

      {tab === 'registry' ? <Registry /> : active.source === 'edge'
        ? <Edge tab={tab as any} embedded />
        : <Model tab={tab as any} embedded />}
    </div>
  );
}

function Registry() {
  const { data, loading, error } = useApi<any>('/model/registry');
  if (loading) return <div className="text-sm text-slate-500">Loading persisted registry…</div>;
  if (error) return <div className="text-sm text-red-600">Registry unavailable: {String(error)}</div>;
  const experiments = data?.experiments ?? [];
  return <div className="space-y-4">
    <div className="grid sm:grid-cols-4 gap-3">
      {[['Production', data?.production?.experiment_id?.slice(0, 12) ?? 'None'], ['Experiments', experiments.length],
        ['Datasets', data?.datasets?.length ?? 0], ['Feature versions', data?.features?.length ?? 0]].map(([label, value]) =>
        <div key={String(label)} className="card p-3"><div className="text-xs text-slate-500">{label}</div><div className="font-semibold mt-1">{value}</div></div>)}
    </div>
    {!experiments.length ? <div className="card p-4 text-sm text-slate-500">No persisted experiments yet. Research analytics are not production models until registered and promoted through every gate.</div> :
      <div className="card overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-slate-500 border-b">
        <th className="p-3">Experiment</th><th className="p-3">Status</th><th className="p-3">Updated</th><th className="p-3">Gates</th>
      </tr></thead><tbody>{experiments.map((x: any) => <tr key={x.id} className="border-b last:border-0">
        <td className="p-3 font-mono text-xs">{x.id.slice(0, 16)}</td><td className="p-3">{x.status}</td>
        <td className="p-3">{new Date(x.updated_at).toLocaleString()}</td>
        <td className="p-3">{x.result?.gates ? Object.values(x.result.gates).filter(Boolean).length + '/' + Object.keys(x.result.gates).length : '—'}</td>
      </tr>)}</tbody></table></div>}
    <p className="text-xs text-slate-400">Promotion and rollback require authenticated model privileges and are recorded in the immutable audit history.</p>
  </div>;
}
