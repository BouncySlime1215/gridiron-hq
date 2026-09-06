import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Settings card: mint a one-time pairing code for a phone and show the tunnel
 * address (if `npm run tunnel` is running). Only rendered usefully on the Mac —
 * the endpoints behind it refuse anything that isn't direct loopback.
 */
export default function PhoneAccess() {
  const [info, setInfo] = useState<{ tunnel_url: string | null; active_codes: number; sessions: number } | null>(null);
  const [code, setCode] = useState<{ code: string; expires_in_minutes: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api('/auth/pairing-info').then(setInfo).catch(e => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  const generate = async () => {
    setBusy(true); setErr(null);
    try { setCode(await api('/auth/pairing-code', { method: 'POST' })); load(); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="card p-5 mb-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${info?.tunnel_url ? 'bg-emerald-600' : 'bg-slate-300'}`} />
        <h2 className="text-lg font-bold">Phone access</h2>
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-xs leading-5 text-slate-600">
        <li>In a terminal on this Mac run <span className="font-mono text-slate-800">npm run tunnel</span> and leave it open.</li>
        <li>Open the address it prints on your phone{info?.tunnel_url ? <>: <a className="font-mono text-[var(--accent)] underline break-all" href={info.tunnel_url} target="_blank" rel="noreferrer">{info.tunnel_url}</a></> : ' (it will show here once the tunnel is up).'}</li>
        <li>Generate a code here and type it on the phone.</li>
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={generate} disabled={busy} className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-bold text-white disabled:opacity-40">
          {busy ? 'Generating…' : 'Generate code'}
        </button>
        {code && <span className="font-mono text-2xl font-extrabold tracking-[.15em] text-slate-900">{code.code}</span>}
        {code && <span className="text-[11px] text-slate-500">good for {code.expires_in_minutes} min, one use</span>}
      </div>
      {info && <p className="text-[11px] text-slate-400">{info.sessions} signed-in device{info.sessions === 1 ? '' : 's'} · {info.active_codes} unused code{info.active_codes === 1 ? '' : 's'}</p>}
      {err && <p className="text-xs text-rose-600">{err}</p>}
      <p className="text-[11px] text-slate-400">Nobody can sign in through the tunnel without a code minted here, and the address dies when you close the tunnel.</p>
    </div>
  );
}
