import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { setAuthToken } from '../api';

/**
 * Sign-in screen for a browser that is not on the Mac (the phone, through the
 * tunnel). The code comes from Settings → Phone access on the Mac and is good
 * for ten minutes and one use.
 */
export default function Pair() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') || '/draft?view=live';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/auth/pair', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `${res.status}`);
      setAuthToken(body.token);
      navigate(next, { replace: true });
    } catch (error: any) {
      setErr(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm pt-6">
      <div className="card p-5 space-y-4">
        <div>
          <div className="text-xl font-extrabold tracking-tight text-slate-950">Gridiron <span className="text-emerald-700">HQ</span></div>
          <h1 className="mt-2 text-lg font-bold">Pair this phone</h1>
          <p className="mt-1 text-sm text-slate-600">On the Mac open <b>Settings → Phone access → Generate code</b>, then type the 8 digits here.</p>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <input
            inputMode="numeric" autoComplete="one-time-code" autoFocus
            value={code} onChange={e => setCode(e.target.value.replace(/[^\d-]/g, '').slice(0, 9))}
            placeholder="1234-5678"
            className="w-full rounded-lg border border-slate-300 px-3 py-3 text-center text-2xl font-mono tracking-[.2em] focus:border-emerald-500 focus:outline-none" />
          <button type="submit" disabled={busy || code.replace(/\D/g, '').length !== 8}
            className="w-full rounded-lg bg-emerald-700 py-3 text-sm font-bold text-white disabled:opacity-40">
            {busy ? 'Pairing…' : 'Sign in'}
          </button>
          {err && <p className="text-sm text-rose-600">{err}</p>}
        </form>
        <p className="text-[11px] text-slate-400">Codes expire after 10 minutes and work once. This phone stays signed in for 30 days.</p>
      </div>
    </div>
  );
}
