import { useState } from 'react';
import Edge from './Edge';
import Model from './Model';
import { api, useApi } from '../api';

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
  const { data, loading, error, refetch } = useApi<any>('/model/registry');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (loading) return <div className="text-sm text-slate-500">Loading persisted registry…</div>;
  if (error) return <div className="text-sm text-red-600">Registry unavailable: {String(error)}</div>;
  const experiments = data?.experiments ?? [];
  const act = async (id: string, action: 'backtests' | 'promote' | 'rollback') => {
    setBusy(`${id}:${action}`); setActionError(null);
    try { await api(`/model/registry/experiments/${id}/${action}`, { method: 'POST' }); await refetch(); }
    catch (e: any) { setActionError(e.message); }
    finally { setBusy(null); }
  };
  const json = (value: unknown) => JSON.stringify(value ?? {}, null, 2);
  return <div className="space-y-4">
    <div className="grid sm:grid-cols-4 gap-3">
      {[['Production', data?.production?.experiment_id?.slice(0, 12) ?? 'None'], ['Experiments', experiments.length],
        ['Datasets', data?.datasets?.length ?? 0], ['Feature versions', data?.features?.length ?? 0]].map(([label, value]) =>
        <div key={String(label)} className="card p-3"><div className="text-xs text-slate-500">{label}</div><div className="font-semibold mt-1">{value}</div></div>)}
    </div>
    {!experiments.length ? <div className="card p-4 text-sm text-slate-500">No persisted experiments yet. Research analytics are not production models until registered and promoted through every gate.</div> :
      <div className="card overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-slate-500 border-b">
        <th className="p-3">Experiment</th><th className="p-3">Status</th><th className="p-3">Pinned inputs</th><th className="p-3">Gates</th><th className="p-3">Actions</th>
      </tr></thead><tbody>{experiments.map((x: any) => <tr key={x.id} className="border-b last:border-0">
        <td className="p-3 font-mono text-xs">{x.id.slice(0, 16)}</td><td className="p-3">{x.status}</td>
        <td className="p-3 text-[11px] font-mono">{(() => { const input = data?.experiment_inputs?.find((i: any) => i.experiment_id === x.id); return input ? `${String(input.dataset_version_id).slice(0, 8)} / ${String(input.feature_version_id).slice(0, 8)}` : 'Missing'; })()}</td>
        <td className="p-3">{x.result?.gates ? Object.values(x.result.gates).filter(Boolean).length + '/' + Object.keys(x.result.gates).length : '—'}</td>
        <td className="p-3 whitespace-nowrap space-x-1">
          {x.status === 'queued' && <button className="btn-ghost" disabled={!!busy} onClick={() => act(x.id, 'backtests')}>Run backtest</button>}
          {x.status === 'completed' && <button className="btn-ghost" disabled={!!busy} onClick={() => act(x.id, 'promote')}>Promote</button>}
          {x.status === 'completed' && data?.production?.experiment_id !== x.id && <button className="btn-ghost" disabled={!!busy} onClick={() => act(x.id, 'rollback')}>Rollback to</button>}
        </td>
      </tr>)}</tbody></table></div>}
    {actionError && <p className="text-sm text-red-600">Action failed: {actionError}</p>}
    <div className="grid lg:grid-cols-2 gap-4">
      <RegistryEvidence title="Dataset versions" items={data?.datasets} render={(x: any) => `${x.name} · ${x.row_count} rows · cutoff ${x.cutoff_at} · ${x.content_hash?.slice(0, 12)}`} />
      <RegistryEvidence title="Feature versions" items={data?.features} render={(x: any) => `${x.name}@${x.version} · ${x.content_hash?.slice(0, 12)} · ${Object.keys(x.contract?.features ?? x.contract ?? {}).length} features`} />
      <RegistryEvidence title="Backtests" items={data?.backtests} render={(x: any) => `${x.protocol} · ${x.status} · ${x.result?.sample_size ?? 0} rows · MAE ${x.result?.mae ?? '—'}`} />
      <RegistryEvidence title="Metrics" items={data?.metrics} render={(x: any) => `${x.split} ${x.metric}: ${x.value} · n=${x.sample_size}`} />
      <RegistryEvidence title="Promotion history" items={data?.promotions} render={(x: any) => `${x.action} ${String(x.experiment_id).slice(0, 12)} · ${new Date(x.created_at).toLocaleString()}`} />
    </div>
    <details className="card p-4"><summary className="font-semibold cursor-pointer">Register persisted model inputs</summary>
      <p className="text-xs text-slate-500 my-3">Authenticated trainers can register content-addressed datasets and feature contracts, then pin both to an experiment. The server validates hashes, timestamps, schemas, and promotion gates.</p>
      <div className="grid lg:grid-cols-3 gap-3">
        <RegistryCreate title="Dataset version" endpoint="datasets" example={{ name: 'observations-v1', content_hash: 'configuration hash of metadata.observations', cutoff_at: '2026-01-01T00:00:00.000Z', row_count: 0, metadata: { observations: [] } }} onCreated={refetch} />
        <RegistryCreate title="Feature version" endpoint="features" example={{ name: 'core', version: '1', content_hash: 'configuration hash of contract', contract: { features: {} } }} onCreated={refetch} />
        <RegistryCreate title="Experiment" endpoint="experiments" example={{ dataset_version_id: 'dataset id', feature_version_id: 'feature id', spec: { candidate: 'mean_baseline', holdout_season: 2025, min_validation_rows: 1 } }} onCreated={refetch} />
      </div>
    </details>
    <details className="card p-4"><summary className="font-semibold cursor-pointer">Audit log ({data?.audit_log?.length ?? 0})</summary>
      <pre className="mt-3 max-h-72 overflow-auto text-[11px] whitespace-pre-wrap">{json(data?.audit_log)}</pre></details>
    <p className="text-xs text-slate-400">Promotion and rollback require authenticated model privileges and are recorded in the immutable audit history.</p>
  </div>;
}

function RegistryCreate({ title, endpoint, example, onCreated }: { title: string; endpoint: string; example: unknown; onCreated: () => unknown }) {
  const [value, setValue] = useState(JSON.stringify(example, null, 2));
  const [message, setMessage] = useState<string | null>(null);
  const submit = async () => {
    setMessage(null);
    try {
      await api(`/model/registry/${endpoint}`, { method: 'POST', body: JSON.stringify(JSON.parse(value)) });
      setMessage('Persisted successfully.'); await onCreated();
    } catch (e: any) { setMessage(e.message); }
  };
  return <div><h4 className="text-sm font-semibold mb-2">{title}</h4>
    <textarea aria-label={`${title} JSON`} className="w-full h-44 p-2 border rounded-lg font-mono text-[11px]" value={value} onChange={e => setValue(e.target.value)} />
    <button className="btn-ghost mt-2" onClick={submit}>Register</button>
    {message && <p className="text-xs mt-2 text-slate-600">{message}</p>}
  </div>;
}

function RegistryEvidence({ title, items, render }: { title: string; items: any[]; render: (item: any) => string }) {
  return <div className="card p-4"><h3 className="font-semibold mb-2">{title}</h3>
    {!items?.length ? <p className="text-xs text-slate-500">No persisted records.</p> :
      <ul className="space-y-2 text-xs">{items.slice(0, 20).map((x: any, i: number) => <li key={x.id ?? i} className="border-b border-slate-100 pb-2 last:border-0">{render(x)}</li>)}</ul>}
  </div>;
}
