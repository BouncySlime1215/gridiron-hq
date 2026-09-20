import { useState } from 'react';
import { api, setAuthToken, useApi } from '../api';
import { useDeployment } from '../state/deployment';

/**
 * Who you are signed in as, who else can sign in, and who is already here.
 *
 * Google sign-in shipped with a complete API and no surface: `/api/auth/session`
 * knew who you were, `/api/auth/invites` could add someone, `/api/auth/accounts`
 * could disable someone, and the app rendered none of it. So the sign-in screen
 * told a rejected visitor "ask Nick to add your address" while Nick's only way
 * to add it was a hand-written request. That is this project's standing failure
 * mode — a working backend nobody can reach — sitting on the feature whose whole
 * point was that the app stops being one person's.
 *
 * Scope is decided by what the deployment actually offers rather than by a flag:
 * invites and accounts only appear where Google sign-in is configured and the
 * signed-in account holds the admin grant, because the endpoints behind them
 * answer 403 otherwise and a button that always fails is worse than no button.
 */

interface Account {
  id: number;
  display_name: string | null;
  email: string | null;
  admin?: boolean;
  leagues?: number;
  providers?: { provider: string; email: string | null; last_login_at: string | null }[];
  last_login_at?: string | null;
}

interface Invite {
  id: number; email: string; note: string | null;
  created_at: string; expires_at: string | null;
  accepted_at: string | null; revoked_at: string | null; accepted_by: string | null;
}

interface AccountRow {
  id: number; display_name: string | null; email: string | null;
  disabled_at: string | null; last_login_at: string | null;
  leagues: number; google_linked: number; admin: boolean;
}

const when = (iso: string | null | undefined) =>
  (iso ? new Date(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`).toLocaleDateString() : null);

/** Open, accepted, revoked or expired — the four states an invite can be in. */
function inviteState(i: Invite): { label: string; cls: string } {
  if (i.accepted_at) return { label: `accepted${i.accepted_by ? ` by ${i.accepted_by}` : ''}`, cls: 'text-emerald-700' };
  if (i.revoked_at) return { label: 'revoked', cls: 'text-slate-400' };
  if (i.expires_at && new Date(`${i.expires_at}Z`).getTime() < Date.now()) {
    return { label: 'expired', cls: 'text-amber-700' };
  }
  return { label: i.expires_at ? `open until ${when(i.expires_at)}` : 'open, no expiry', cls: 'text-slate-600' };
}

export default function AccountPanel() {
  const deployment = useDeployment();
  const session = useApi<{ authenticated: boolean; account: Account | null }>('/auth/session');
  const account = session.data?.account ?? null;
  // Both lists are admin-only on the server. Asking for them as a non-admin
  // would be a guaranteed 403, so the request is not made at all.
  const canAdminister = account?.admin === true && deployment?.google === true;
  const invites = useApi<Invite[]>(canAdminister ? '/auth/invites' : null);
  const accounts = useApi<AccountRow[]>(canAdminister ? '/auth/accounts' : null);

  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const signOut = async (everywhere: boolean) => {
    setBusy(true); setErr(null);
    try {
      await api(everywhere ? '/auth/logout-all' : '/auth/logout', { method: 'POST' });
      // The token outlives the server-side session otherwise: it keeps being
      // sent, keeps being rejected, and nothing clears it.
      setAuthToken(null);
      window.location.assign('/sign-in');
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };

  const invite = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await api('/auth/invites', { method: 'POST', body: JSON.stringify({ email: email.trim(), note: note.trim() || null }) });
      setMsg(`${email.trim()} can now sign in with that Google address.`);
      setEmail(''); setNote('');
      invites.refetch();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const revoke = async (id: number, who: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await api(`/auth/invites/${id}`, { method: 'DELETE' });
      setMsg(`The invite for ${who} is revoked.`);
      invites.refetch();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const setDisabled = async (row: AccountRow, disabled: boolean) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await api(`/auth/accounts/${row.id}/disabled`, { method: 'POST', body: JSON.stringify({ disabled }) });
      setMsg(disabled
        ? `${row.display_name ?? row.email} is signed out everywhere and cannot sign back in.`
        : `${row.display_name ?? row.email} can sign in again.`);
      accounts.refetch();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  if (!account) return null;

  return (
    <>
      <div className="card p-5 mb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-600" />
          <h2 className="text-lg font-bold">
            Signed in as {account.display_name || account.email || 'this account'}
          </h2>
          {account.admin && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600 ring-1 ring-slate-200">
              Admin
            </span>
          )}
        </div>
        <p className="text-xs leading-5 text-slate-600">
          {account.email ?? 'No email on this account'}
          {account.leagues != null && ` · ${account.leagues} league${account.leagues === 1 ? '' : 's'}`}
          {account.last_login_at && ` · last signed in ${when(account.last_login_at)}`}
        </p>
        {/* On the Mac, signing out is theatre: the next page load provisions the
            browser again over loopback. Offering a button that undoes itself
            would be the same kind of lie the rest of this pass removed. */}
        {deployment && !deployment.local && (
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost" disabled={busy} onClick={() => signOut(false)}>Sign out</button>
            <button className="btn-ghost" disabled={busy} onClick={() => signOut(true)}
              title="Ends every session on every device, including this one">
              Sign out everywhere
            </button>
          </div>
        )}
      </div>

      {canAdminister && (
        <div className="card p-5 mb-4 space-y-3">
          <h2 className="text-lg font-bold">Who can sign in</h2>
          <p className="text-xs leading-5 text-slate-600">
            Sign-in is invite-only. Add the Google address someone actually uses — the invite is
            matched against what Google reports for a real, verified account, and nothing is emailed
            from here, so tell them yourself once it is added.
          </p>
          <div className="flex flex-wrap gap-2">
            <input className="input flex-1 min-w-[16rem]" type="email" placeholder="name@gmail.com"
              value={email} onChange={e => setEmail(e.target.value)} />
            <input className="input flex-1 min-w-[10rem]" placeholder="Note (optional)"
              value={note} onChange={e => setNote(e.target.value)} />
            <button className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-bold text-white disabled:opacity-40"
              disabled={busy || !email.trim()} onClick={invite}>
              {busy ? 'Working…' : 'Invite'}
            </button>
          </div>
          {invites.error && <p className="text-xs text-rose-600">{invites.error}</p>}
          {invites.data?.length === 0 && (
            <p className="text-xs text-slate-500">Nobody has been invited yet — this install is still just you.</p>
          )}
          {!!invites.data?.length && (
            <div className="divide-y divide-slate-100">
              {invites.data.map(i => {
                const state = inviteState(i);
                return (
                  <div key={i.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2 text-sm">
                    <span className="font-semibold text-slate-800">{i.email}</span>
                    {i.note && <span className="text-xs text-slate-400">{i.note}</span>}
                    <span className={`text-xs ${state.cls}`}>{state.label}</span>
                    {!i.accepted_at && !i.revoked_at && (
                      <button className="ml-auto text-xs font-semibold text-rose-700 disabled:opacity-40"
                        disabled={busy} onClick={() => revoke(i.id, i.email)}>
                        Revoke
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {canAdminister && !!accounts.data?.length && (
        <div className="card p-5 mb-4 space-y-3">
          <h2 className="text-lg font-bold">Accounts</h2>
          <p className="text-xs leading-5 text-slate-600">
            Everyone with an account here. Turning one off ends its sessions immediately rather than
            only blocking the next sign-in, so access stops the moment you press it.
          </p>
          {accounts.error && <p className="text-xs text-rose-600">{accounts.error}</p>}
          <div className="divide-y divide-slate-100">
            {accounts.data.map(u => (
              <div key={u.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2 text-sm">
                <span className="font-semibold text-slate-800">{u.display_name || u.email || `Account ${u.id}`}</span>
                {u.email && u.display_name && <span className="text-xs text-slate-400">{u.email}</span>}
                {u.admin && <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">admin</span>}
                <span className="text-xs text-slate-400">
                  {u.leagues} league{u.leagues === 1 ? '' : 's'}
                  {u.last_login_at ? ` · last in ${when(u.last_login_at)}` : ' · never signed in'}
                </span>
                {u.disabled_at && <span className="text-xs font-semibold text-rose-700">turned off</span>}
                {u.id !== account.id && (
                  <button className="ml-auto text-xs font-semibold text-slate-600 disabled:opacity-40"
                    disabled={busy} onClick={() => setDisabled(u, !u.disabled_at)}>
                    {u.disabled_at ? 'Turn back on' : 'Turn off'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {(msg || err) && (
        <p className={`mb-4 text-sm ${err ? 'text-rose-600' : 'text-emerald-700'}`}>{err ?? msg}</p>
      )}
    </>
  );
}
