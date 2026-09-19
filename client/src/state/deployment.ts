import { useEffect, useState } from 'react';

/**
 * Where this copy of Gridiron HQ is actually running, asked rather than assumed.
 *
 * The app ships two ways from one codebase: on Nick's Mac, where the server
 * provisions the browser over loopback and the SQLite file sits on that disk;
 * and hosted on Fly, where a Google account signs you in and the data lives on
 * a server volume. Copy that states one of those as a fact is wrong half the
 * time, and it was — the sidebar told every hosted visitor "data stays on your
 * Mac", the Settings card told them local sign-in was automatic, and the phone
 * pairing card told them to run a tunnel on a machine they are not sitting at.
 *
 * `GET /api/auth/providers` already answers this per request, and answers it
 * honestly: `local` is `isDirectLoopback(req)`, computed for the connection in
 * hand rather than asserted from config, so a tunnelled browser correctly reads
 * false. Nothing here hardcodes a deployment; the page renders what it is told.
 *
 * Unauthenticated on purpose (the sign-in page needs it before anyone has a
 * session), so this uses plain fetch rather than the api() helper, which would
 * attach a token and start a sign-in redirect on a 401.
 */
export interface Deployment {
  /** True when this browser reached the server over loopback: the Mac install. */
  local: boolean;
  /** True when Google sign-in is configured, which is how the hosted app works. */
  google: boolean;
  /** True when an 8-digit pairing code can be minted (tunnel access). */
  pairing: boolean;
  /** The origin the server believes it is serving, for setup steps to check against. */
  origin: string | null;
}

let cached: Promise<Deployment | null> | null = null;

/** One request per page load, shared by every caller. */
export function loadDeployment(): Promise<Deployment | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!cached) {
    cached = fetch('/api/auth/providers')
      .then(res => (res.ok ? res.json() : null))
      .then(body => (body && typeof body === 'object'
        ? {
            local: body.local === true,
            google: body.google === true,
            pairing: body.pairing === true,
            origin: typeof body.origin === 'string' ? body.origin : null
          }
        : null))
      // A failed probe means "not known", never "local". Copy that depends on
      // this renders nothing rather than guessing, which is the whole point.
      .catch(() => null);
  }
  return cached;
}

/**
 * The deployment, or null while it is unknown — either still loading or the
 * probe failed. Callers render nothing for null rather than defaulting, because
 * every default here is a claim about where someone's data is.
 */
export function useDeployment(): Deployment | null {
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  useEffect(() => {
    let live = true;
    void loadDeployment().then(d => { if (live) setDeployment(d); });
    return () => { live = false; };
  }, []);
  return deployment;
}
