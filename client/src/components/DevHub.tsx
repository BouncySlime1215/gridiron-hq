import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../api';

const fmt = (n?: number | null) =>
  n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
const money = (n?: number | null) => (n == null ? '—' : `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`);
const ago = (iso?: string | null) => {
  if (!iso) return 'never';
  const then = new Date(iso.replace(' ', 'T') + 'Z').getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (Number.isNaN(mins)) return iso;
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

/**
 * Settings → AI & developer, below API spend / Daily budgets / API key (settings/ApiSpend.tsx):
 * the workspace id, live data and the player identity audit.
 */
export function DevPanel() {
  const { data, refetch } = useApi<any>('/dev/status');
  const [repair, setRepair] = useState<any>(null);
  const [workspaceInput, setWorkspaceInput] = useState('');
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceMsg, setWorkspaceMsg] = useState<string | null>(null);


  const saveWorkspace = async () => {
    setWorkspaceBusy(true); setWorkspaceMsg(null);
    try {
      const r = await api('/dev/workspace-id', { method: 'PUT', body: JSON.stringify({ workspace_id: workspaceInput }) });
      setWorkspaceMsg(r.persisted ? 'Saved to .env.' : 'Saved for this session.');
      setWorkspaceInput('');
      refetch();
    } catch (e: any) { setWorkspaceMsg(e.message); }
    finally { setWorkspaceBusy(false); }
  };

  const removeWorkspace = async () => {
    await api('/dev/workspace-id', { method: 'DELETE' });
    setWorkspaceMsg('Removed.');
    refetch();
  };

  const workspaceConfigured = data?.workspace_id?.configured;

  return (
    <div className="space-y-5" data-testid="dev-panel">
      {/* Workspace ID — only needed for identity-linked keys */}
      <div>
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">
          Workspace ID <span className="font-normal normal-case text-slate-400">(only if your key needs one)</span>
        </h3>
        {workspaceConfigured ? (
          <div className="flex items-center gap-2">
            <code className="text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1 font-mono text-slate-600">
              {data.workspace_id.value}
            </code>
            <button onClick={removeWorkspace} className="text-xs text-rose-600 hover:underline ml-auto">remove</button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              type="text"
              value={workspaceInput}
              onChange={e => setWorkspaceInput(e.target.value)}
              placeholder="wrkspc-…"
              className="input flex-1 font-mono text-xs" />
            <button className="btn-primary" onClick={saveWorkspace} disabled={workspaceBusy || !workspaceInput}>
              {workspaceBusy ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
        {workspaceMsg && <p className="text-xs text-amber-600 mt-2">{workspaceMsg}</p>}
        <p className="text-[11px] text-slate-400 mt-2">
          Only needed if AI features error with something like <em>"anthropic-workspace-id is
          required"</em> — that means your key is Anthropic Console's newer per-person type,
          which has to be told which workspace to act in. Find it in the Console under Settings →
          the workspace's name. A plain API key never needs this — leave it blank.
        </p>
      </div>

      {/* data freshness */}
      <div>
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Live data</h3>
        <ul className="space-y-1">
          {Object.entries(data?.data ?? {}).map(([k, v]: any) => (
            <li key={k} className="flex items-center gap-2 text-xs">
              <span className="capitalize text-slate-600 w-20">{k}</span>
              <span className="text-slate-400 tabular-nums">{fmt(v.n)} rows</span>
              <span className="ml-auto text-slate-400">{ago(v.at)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Player identity audit</h3>
          <button className="btn-ghost text-xs" onClick={async () => setRepair(await api('/dev/player-identity/repair-plan'))}>Run dry-run</button>
        </div>
        {!repair ? <p className="text-[11px] text-slate-400">Scans duplicate names without changing any draft, roster or player row.</p> : <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          <div className="grid grid-cols-3 gap-2 text-center"><div><b className="block text-lg text-slate-900">{repair.duplicate_groups}</b>duplicate</div><div><b className="block text-lg text-emerald-700">{repair.safe_groups}</b>safe</div><div><b className="block text-lg text-amber-700">{repair.review_groups}</b>review</div></div>
          <p className="mt-2 text-[10px] leading-4 text-slate-500">{repair.note}</p>
        </div>}
      </div>
    </div>
  );
}

/** The header's "Dev" button: its status dot and today's spend; it opens Settings → AI & developer. */
export default function DevHub() {
  const { data } = useApi<any>('/dev/status');
  const configured = data?.api_key?.configured;
  const today = data?.usage?.today;
  return (
    <Link to="/settings?view=dev" title="AI & developer: API key and usage"
      className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 transition-colors hover:border-slate-300 hover:bg-slate-50">
      <span className={`h-2 w-2 rounded-full ${configured ? 'bg-emerald-500' : 'bg-slate-300'}`} />
      <span className="text-xs font-semibold text-slate-600">Dev</span>
      {today?.calls > 0 && <span className="font-mono text-[10px] tabular-nums text-slate-500">{money(today.cost)}</span>}
    </Link>
  );
}
