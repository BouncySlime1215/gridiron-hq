import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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

export default function DevHub() {
  const [open, setOpen] = useState(false);
  const { data, refetch } = useApi<any>('/dev/status');
  const [keyInput, setKeyInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);

  const saveKey = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api('/dev/key', { method: 'PUT', body: JSON.stringify({ key: keyInput }) });
      setMsg(r.persisted ? 'Saved to .env — AI features are live.' : 'Saved for this session.');
      setKeyInput('');
      refetch();
    } catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  const removeKey = async () => {
    if (!confirm('Remove the stored API key? AI features will stop working.')) return;
    await api('/dev/key', { method: 'DELETE' });
    setMsg('Key removed.');
    refetch();
  };

  const configured = data?.api_key?.configured;
  const today = data?.usage?.today;

  return (
    <>
      <button
        onClick={() => { setOpen(true); refetch(); }}
        title="Dev Hub — API key and usage"
        className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 hover:border-slate-300 hover:bg-slate-50 transition-colors">
        <span className={`w-2 h-2 rounded-full ${configured ? 'bg-emerald-500' : 'bg-slate-300'}`} />
        <span className="text-xs font-semibold text-slate-600">Dev</span>
        {today?.calls > 0 && (
          <span className="text-[10px] font-mono text-slate-400 tabular-nums">{money(today.cost)}</span>
        )}
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-[100] flex items-start justify-end p-4 sm:p-6 overflow-y-auto"
          style={{ background: 'rgba(15,23,42,0.35)' }} onClick={() => setOpen(false)}>
          <section
            onClick={e => e.stopPropagation()}
            aria-label="Developer hub"
            className="card w-full max-w-md shadow-xl">
            <header className="flex items-center gap-2 px-5 py-3 border-b border-slate-200">
              <h2 className="font-bold text-slate-800">Dev Hub</h2>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${configured ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                {configured ? 'AI ENABLED' : 'AI OFF'}
              </span>
              <button onClick={() => setOpen(false)} className="ml-auto text-slate-400 hover:text-slate-700 text-lg leading-none">✕</button>
            </header>

            <div className="p-5 space-y-5">
              {/* API key */}
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Anthropic API key</h3>
                {configured ? (
                  <div className="flex items-center gap-2">
                    <code className="text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1 font-mono text-slate-600">
                      {data.api_key.masked}
                    </code>
                    <button onClick={removeKey} className="text-xs text-rose-600 hover:underline ml-auto">remove</button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={keyInput}
                      onChange={e => setKeyInput(e.target.value)}
                      placeholder="sk-ant-…"
                      className="input flex-1 font-mono text-xs" />
                    <button className="btn-primary" onClick={saveKey} disabled={busy || !keyInput}>
                      {busy ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                )}
                {msg && <p className="text-xs text-amber-600 mt-2">{msg}</p>}
                <p className="text-[11px] text-slate-400 mt-2">
                  Stored locally in <code className="font-mono">.env</code> (gitignored). Powers buy/sell verdicts,
                  news explanations, the camp roundup and team-outlook refreshes.
                </p>
              </div>

              {/* usage */}
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Usage</h3>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  {[
                    ['Today', money(today?.cost), `${today?.calls ?? 0} calls`],
                    ['30 days', money(data?.usage?.period_cost), `${fmt(data?.usage?.daily?.reduce((s: number, d: any) => s + d.calls, 0))} calls`],
                    ['Model', 'Haiku 4.5', `$${data?.pricing?.in}/$${data?.pricing?.out} per Mtok`]
                  ].map(([label, big, sub], i) => (
                    <div key={i} className="rounded-lg border border-slate-200 p-2">
                      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
                      <div className="text-sm font-bold text-slate-800 truncate">{big}</div>
                      <div className="text-[10px] text-slate-400 truncate">{sub}</div>
                    </div>
                  ))}
                </div>

                {data?.usage?.by_feature?.length > 0 ? (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wide text-slate-400">
                        <th className="text-left font-medium pb-1">Feature</th>
                        <th className="text-right font-medium pb-1">Calls</th>
                        <th className="text-right font-medium pb-1">Tokens</th>
                        <th className="text-right font-medium pb-1">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.usage.by_feature.map((f: any) => (
                        <tr key={f.feature}>
                          <td className="py-1 text-slate-700">{f.feature}</td>
                          <td className="py-1 text-right tabular-nums text-slate-500">{f.calls}</td>
                          <td className="py-1 text-right tabular-nums text-slate-500">{fmt(f.input_tokens + f.output_tokens)}</td>
                          <td className="py-1 text-right tabular-nums font-medium text-slate-700">{money(f.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-xs text-slate-500">No AI calls yet.</p>
                )}
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
            </div>
          </section>
        </div>,
        document.body
      )}
    </>
  );
}
