import { useState } from 'react';
import { api, useApi } from '../api';

interface SetupStatus {
  needs_setup: boolean;
  missing: { source: string; label: string }[];
  checked: number;
}

/**
 * A fresh `git clone` gets all the code but none of the historical model
 * data — nflverse usage/snaps/NGS/PFR/depth-charts/injuries/play-by-play,
 * the ADP backfill, the fantasy coordinator fit. None of that ships in the
 * repo; it only exists once someone runs the one-time backfill. This banner
 * is how a new install finds out, and how it fixes itself in one click.
 *
 * Deliberately lighter than EspnConnectGate: this is a slim bar, not a
 * blocking modal, because the app is still usable (if thinner) without the
 * historical data. But the X only dismisses for this sitting — sessionStorage,
 * not localStorage — so an install that's still missing data keeps getting
 * reminded on the next launch instead of going quiet forever.
 */
export default function DataSetupBanner() {
  const { data: status, refetch } = useApi<SetupStatus>('/model/setup-status');
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem('data-setup-dismissed') === '1'; } catch { return false; }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!status?.needs_setup || dismissed) return null;

  const close = () => {
    try { sessionStorage.setItem('data-setup-dismissed', '1'); } catch { /* private mode */ }
    setDismissed(true);
  };

  const runSync = async () => {
    if (busy) return;
    setBusy(true); setErr(null); setDone(false);
    try {
      await api('/model/sync', { method: 'POST' });
      await refetch();
      setDone(true);
    } catch (e: any) {
      if (e.message?.includes('403') || e.message?.toLowerCase().includes('permission')) {
        setErr("Your account doesn't have permission to run this — ask whoever set up this install.");
      } else {
        setErr(e.message || 'The update failed — try again in a moment.');
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="flex w-full flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900">
      <span aria-hidden>⚠</span>
      <span className="font-semibold">
        This install is missing historical model data
      </span>
      <span className="text-amber-700">
        ({status.missing.map(m => m.label).join(', ')})
      </span>
      {err && <span className="font-semibold text-rose-700">{err}</span>}
      {done && !err && <span className="font-semibold text-emerald-700">Updated.</span>}
      <button onClick={runSync} disabled={busy}
        className="ml-1 flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-2 py-0.5 font-bold text-amber-900 transition hover:bg-amber-100 disabled:opacity-60">
        {busy && <span className="inline-block animate-spin leading-none">↻</span>}
        {busy ? 'Updating — this can take a few minutes…' : 'Update now'}
      </button>
      <button onClick={close} aria-label="Dismiss for now"
        className="ml-auto text-amber-500 hover:text-amber-800">✕</button>
    </div>
  );
}
