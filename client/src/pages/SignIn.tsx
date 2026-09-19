import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * The signed-out screen for the hosted app.
 *
 * On the Mac nobody ever sees this: `/api/auth/local-session` provisions the
 * owner from loopback and the app is simply open. Through a proxy that path
 * returns 403 by construction, and until now the only alternative was a
 * bearer token minted over SSH and pasted into localStorage one browser at a
 * time. This is that replacement.
 *
 * Deliberately chrome-free — no sidebar, no league switcher, no ESPN gate —
 * because every one of those reads data this browser is not yet allowed to
 * have, and a wall of failed requests behind a login box is how a login box
 * ends up looking broken.
 */

type Providers = { google: boolean; pairing: boolean; origin: string; redirect_uri: string };

const ERRORS: Record<string, string> = {
  not_invited: 'That Google account has not been invited to Gridiron HQ. Ask Nick to add your address, then try again.',
  disabled: 'That account has been turned off.',
  email_unverified: 'Google has not verified the email address on that account, so it cannot be used to sign in.',
  cancelled: 'Sign-in was cancelled.',
  expired: 'That sign-in took too long and expired. Start again.',
  bad_nonce: 'That sign-in could not be verified. Start again.',
  bad_token: 'Google returned something this server could not verify. Start again.',
  no_code: 'Google did not send back a sign-in code. Start again.',
  not_configured: 'Google sign-in is not configured on this server yet.',
  google_error: 'Google could not complete the sign-in.'
};

export default function SignIn() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const next = params.get('next');
  const error = params.get('error');
  const [providers, setProviders] = useState<Providers | null>(null);
  const [probeFailed, setProbeFailed] = useState(false);

  useEffect(() => {
    // Not through api(): this is the one request that must work with no token,
    // and api()'s 401 handling would send it round the provisioning loop.
    fetch('/api/auth/providers')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setProviders)
      .catch(() => setProbeFailed(true));
  }, []);

  const startUrl = `/api/auth/google/start${next ? `?return_to=${encodeURIComponent(next)}` : ''}`;

  return <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
    <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="text-2xl font-extrabold tracking-tight text-slate-950">
        Gridiron <span className="text-emerald-700">HQ</span>
      </div>
      <p className="mt-1 text-sm text-slate-500">Sign in to see your leagues.</p>

      {error && <div role="alert" className="mt-5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        {ERRORS[error] ?? 'Sign-in did not complete. Start again.'}
      </div>}

      {providers?.google && <a
        href={startUrl}
        className="mt-6 flex w-full items-center justify-center gap-3 rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
      >
        {/* Google's mark, inline: the brand guidelines require it on the button
            and a remote <img> would be the page's only third-party request. */}
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
          <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
          <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
          <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
        </svg>
        Continue with Google
      </a>}

      {providers && !providers.google && <div className="mt-6 rounded-md border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
        Google sign-in is not configured on this server yet. It needs
        <code className="mx-1 rounded bg-white px-1 py-0.5 text-[12px] text-slate-800">GOOGLE_OAUTH_CLIENT_ID</code>
        and
        <code className="mx-1 rounded bg-white px-1 py-0.5 text-[12px] text-slate-800">GOOGLE_OAUTH_CLIENT_SECRET</code>
        set as secrets, with this redirect URI registered on the Google client:
        <span className="mt-2 block break-all rounded bg-white px-2 py-1 font-mono text-[12px] text-slate-800">
          {providers.redirect_uri}
        </span>
      </div>}

      {probeFailed && <div role="alert" className="mt-6 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
        This server did not answer. It may still be starting up — reload in a moment.
      </div>}

      {!providers && !probeFailed && <div className="mt-6 h-11 animate-pulse rounded-md bg-slate-100" aria-label="Loading sign-in options" />}

      <p className="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-400">
        Access is by invitation. Signing in does not give Gridiron HQ access to
        anything in your Google account beyond your name, email address and picture.
      </p>
    </div>
  </div>;
}
