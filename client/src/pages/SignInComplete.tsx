import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { setAuthToken } from '../api';

/**
 * Where Google's redirect lands. Swaps the one-time HttpOnly cookie the
 * callback set for the bearer token the rest of the client already uses, then
 * leaves. Nothing is rendered for longer than that exchange takes.
 *
 * The token is fetched rather than read out of the URL on purpose: a token in
 * a query string or fragment is in browser history, in the referrer of the
 * next request, and in any log between here and the browser.
 */
export default function SignInComplete() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const next = params.get('next');
  const error = params.get('error');
  const [failed, setFailed] = useState<string | null>(null);
  // React 18 StrictMode mounts effects twice in development. The handoff is
  // strictly one-time, so a second redemption would fail and bounce a sign-in
  // that actually worked.
  const redeemed = useRef(false);

  useEffect(() => {
    if (redeemed.current) return;
    redeemed.current = true;
    if (error) { setFailed(error); return; }
    fetch('/api/auth/google/complete', { method: 'POST' })
      .then(async res => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok || typeof body.token !== 'string') throw new Error(body.code || 'expired');
        setAuthToken(body.token);
        // A full navigation, not a router push: every cached API response and
        // every hook's state in this tab belongs to whoever was signed in
        // before, and the cleanest way to be rid of all of it is a fresh load.
        window.location.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/league');
      })
      .catch(e => setFailed(e.message));
  }, [error, next]);

  if (failed) {
    const target = `/sign-in?error=${encodeURIComponent(failed)}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <p className="text-sm text-slate-600">That sign-in did not complete.</p>
        <a href={target} className="mt-4 inline-block rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
          Try again
        </a>
      </div>
    </div>;
  }

  return <div className="flex min-h-screen items-center justify-center bg-slate-50">
    <p className="text-sm text-slate-500" role="status">Signing you in…</p>
  </div>;
}
