import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, useApi } from '../api';

/**
 * The first thing a new install asks for.
 *
 * Almost nothing in this app is interesting without a league attached — the
 * projections have no roster to rank, the trade engine has no partners, the
 * lineup pages have no lineup. Someone who installs this and lands on an empty
 * dashboard concludes it is broken, and they are not wrong to.
 *
 * So connecting is put in front of them rather than filed under Settings. It is
 * a real modal over a real scrim, and it is the only thing on screen until they
 * deal with it.
 *
 * On the X, deliberately: it is a genuine close button, always visible, and
 * clicking it always works. What it does not do is remember forever — the
 * dismissal lives in sessionStorage, so it stays gone for this sitting and the
 * modal returns next launch, with a permanent slim bar in the meantime. Someone
 * who wants to look around unconnected can, every time, in one click. Someone
 * who meant to connect and got distracted gets asked again. Anything harsher —
 * a hidden close, a fake X, a countdown — would be a dark pattern, and this is
 * the user's own machine reading the user's own league.
 *
 * The cookies never leave the machine: the bookmarklet runs on espn.com in the
 * user's browser and posts to their own localhost.
 */
export default function EspnConnectGate() {
  const { data: status, refetch } = useApi<any>('/espn-connect/status');
  const { data: bm } = useApi<any>('/espn-connect/bookmarklet');
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem('espn-gate-dismissed') === '1'; } catch { return false; }
  });
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [copied, setCopied] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  const connected = !!status?.connected;
  const open = !connected && !dismissed && !!status;

  const close = () => {
    try { sessionStorage.setItem('espn-gate-dismissed', '1'); } catch { /* private mode */ }
    setDismissed(true);
  };

  // Escape closes it, because a modal that traps the keyboard is the kind of
  // thing that makes people force-quit the browser.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    panel.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open]);

  const submitPaste = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<any>('/espn-connect/cookies', { method: 'POST', body: JSON.stringify({ raw: paste }) });
      setPaste('');
      setDone(r.leagues_found > 0
        ? `Connected. Found ${r.leagues_found} league${r.leagues_found === 1 ? '' : 's'} — syncing them now.`
        : 'Connected to ESPN.');
      // Pull the leagues in immediately; the point of connecting is the data.
      try {
        const d = await api<any>('/espn-connect/discover');
        const added = await Promise.all((d.leagues ?? []).map((l: any) => api<any>('/espn-connect/add', {
            method: 'POST',
            body: JSON.stringify({ league_id: l.league_id, season: l.season, my_team_id: l.team_id, name: l.name })
          })));
        const syncs = await Promise.allSettled(added.map((league: any) =>
          api(`/leagues/${league.id}/sync`, { method: 'POST' })));
        const failed = syncs.filter(result => result.status === 'rejected').length;
        setDone(failed
          ? `ESPN is connected. ${added.length - failed} league${added.length - failed === 1 ? '' : 's'} synced; ${failed} can be retried from My Leagues.`
          : `ESPN is connected and ${added.length} league${added.length === 1 ? '' : 's'} ${added.length === 1 ? 'is' : 'are'} ready.`);
      } catch { /* discovery is a convenience; the cookies are already saved */ }
      await refetch();
      location.reload();
    } catch (e: any) {
      setErr(e.message);
    } finally { setBusy(false); }
  };

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(bm?.copy_snippet ?? 'copy(document.cookie)');
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked — the snippet is visible on screen anyway */ }
  };

  // Connected and quiet: render nothing at all.
  if (connected) return null;

  // Dismissed for this sitting: a slim, permanent reminder that reopens it.
  if (!open) {
    if (!status) return null;
    return (
      <button onClick={() => setDismissed(false)}
        className="flex w-full items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs font-semibold text-amber-900 transition hover:bg-amber-100">
        <span aria-hidden>⚠</span>
        No ESPN league connected — most of Gridiron HQ is empty until you do.
        <span className="underline underline-offset-2">Connect now</span>
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-[300] grid place-items-center overflow-y-auto bg-slate-950/60 p-4 backdrop-blur-sm"
      role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="espn-gate-title"
        className="relative w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl outline-none">

        <button onClick={close} aria-label="Close and continue without connecting"
          className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>

        <div className="surface-deep px-6 py-5">
          <div className="text-[10px] font-black uppercase tracking-[.16em] text-emerald-300">One-time setup</div>
          <h2 id="espn-gate-title" className="mt-1 text-2xl font-black tracking-tight text-white">Connect your ESPN league</h2>
          <p className="mt-1.5 text-sm leading-5 text-slate-300">
            Rosters, projections, trades and matchups all read from your league. Until it is connected
            there is very little here to look at.
          </p>
        </div>

        {done ? (
          <div className="px-6 py-8 text-center">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-100 text-2xl">✓</div>
            <p className="mt-3 font-bold text-slate-900">{done}</p>
            <p className="mt-1 text-sm text-slate-500">Reloading…</p>
          </div>
        ) : (
          <div className="space-y-4 px-6 py-5">
            <ol className="space-y-3">
              <Step n={1} title="Open ESPN and sign in">
                <a href="https://fantasy.espn.com/football/team" target="_blank" rel="noreferrer"
                  className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white transition hover:bg-emerald-700">
                  Open ESPN Fantasy ↗
                </a>
              </Step>
              <Step n={2} title="Drag this button to your bookmarks bar">
                <p className="text-sm leading-5 text-slate-500">
                  Then click it while you are on the ESPN page. It reads the two cookies ESPN
                  already set for you and sends them to this app on your own computer.
                </p>
                {bm?.href && (
                  <a href={bm.href} onClick={e => e.preventDefault()} draggable
                    title="Drag me to your bookmarks bar"
                    className="mt-2 inline-flex cursor-grab items-center gap-2 rounded-lg border-2 border-dashed border-emerald-400 bg-emerald-50 px-3 py-1.5 text-sm font-black text-emerald-800 active:cursor-grabbing">
                    ⚡ Connect Gridiron HQ
                  </a>
                )}
              </Step>
            </ol>

            <div className="border-t border-slate-100 pt-3">
              <button onClick={() => setShowPaste(v => !v)}
                className="text-xs font-bold text-slate-500 underline underline-offset-2 hover:text-slate-800">
                {showPaste ? 'Hide the manual way' : "Bookmarks bar hidden, or on Safari? Do it manually instead"}
              </button>

              {showPaste && (
                <div className="mt-3 space-y-2 rounded-xl bg-slate-50 p-3">
                  <p className="text-xs leading-5 text-slate-600">
                    On the ESPN tab press <Kbd>F12</Kbd> (Mac: <Kbd>⌥</Kbd><Kbd>⌘</Kbd><Kbd>I</Kbd>), open the
                    <b> Console</b> tab, paste the line below, press Enter — then paste the result here.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 overflow-x-auto rounded-lg bg-slate-900 px-2.5 py-1.5 font-mono text-xs text-emerald-300">
                      {bm?.copy_snippet ?? 'copy(document.cookie)'}
                    </code>
                    <button onClick={copySnippet}
                      className="shrink-0 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100">
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <textarea value={paste} onChange={e => setPaste(e.target.value)} rows={3}
                    placeholder="Paste it here — the whole thing is fine, it finds the parts it needs"
                    className="w-full rounded-lg border border-slate-300 p-2 font-mono text-xs focus:border-emerald-500 focus:outline-none" />
                  {err && <p className="text-xs font-semibold text-rose-700">{err}</p>}
                  <button onClick={submitPaste} disabled={busy || paste.trim().length < 10}
                    className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-bold text-white transition hover:bg-emerald-700 disabled:opacity-40">
                    {busy ? 'Checking with ESPN…' : 'Connect'}
                  </button>
                </div>
              )}
            </div>

            <p className="border-t border-slate-100 pt-3 text-[11px] leading-4 text-slate-400">
              Your cookies are stored in a file on this computer and are sent only to ESPN.
              Public leagues need no cookies at all — you can add one by ID under My Leagues.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-slate-900 text-xs font-black text-white">{n}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-slate-900">{title}</div>
        {children}
      </div>
    </li>
  );
}

const Kbd = ({ children }: { children: ReactNode }) =>
  <kbd className="rounded border border-slate-300 bg-white px-1 font-mono text-[10px] text-slate-700">{children}</kbd>;
