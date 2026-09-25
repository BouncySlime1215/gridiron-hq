import { useEffect, useRef, useState } from 'react';
import { useApi } from '../api';
import EspnConnect from './EspnConnect';

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
  const { data: status } = useApi<any>('/espn-connect/status');
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem('espn-gate-dismissed') === '1'; } catch { return false; }
  });
  const [done, setDone] = useState<string | null>(null);
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

  // The one ESPN flow (EspnConnect) adds and syncs every league it finds, then reports here.
  const finished = (message: string) => { setDone(message); setTimeout(() => location.reload(), 900); };

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
    <div className="fixed inset-0 z-[300] flex overflow-y-auto bg-slate-950/60 p-4 backdrop-blur-sm"
      role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="espn-gate-title"
        className="ds-card relative m-auto w-full max-w-lg overflow-hidden outline-none">
        {/* m-auto in a flex scroller: centred when it fits, top-aligned and scrollable when it is taller (a phone). */}

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
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[var(--c-green-tint)] text-2xl text-good">✓</div>
            <p className="mt-3 font-semibold">{done}</p>
            <p className="ds-note mt-1">Reloading…</p>
          </div>
        ) : (
          <div className="px-6 py-5">
            <EspnConnect variant="bare" autoAddAll onDone={finished} />
            <p className="ds-note mt-3 border-t border-slate-200 pt-3">
              Public leagues need no cookies at all: add one by ID under League → Your leagues.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
