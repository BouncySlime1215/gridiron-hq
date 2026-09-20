import { useState } from 'react';
import { api, useApi } from '../api';
import { coverageState, canRetry, coverageHeadline, coverageDetail } from '../lib/usage-coverage';
import type { UsageCoverage } from '../lib/usage-coverage';

interface SetupStatus {
  needs_setup: boolean;
  missing: { source: string; label: string }[];
  checked: number;
  /**
   * Whether the player-usage table actually holds rows for the season being
   * played — which `needs_setup` cannot answer, because it only counts sources
   * that never ran. Not served yet; the banner is correct before and after.
   */
  usage_coverage?: UsageCoverage | null;
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

  // Two independent reasons to show this bar. `needs_setup` is "a source never
  // ran"; `usage_coverage` is "a source ran and the table is still empty", which
  // the old check reported as healthy. Either one renders it.
  const coverage = coverageState(status?.usage_coverage);
  const coverageWrong = coverage != null && coverage !== 'healthy';
  if (dismissed) return null;
  if (!status?.needs_setup && !coverageWrong) return null;

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

  // The state that must not offer a retry. Running the same pull again is what
  // produced the empty table; a button that cannot help teaches a reader to
  // ignore the bar, and this is the one bar they most need to not ignore.
  const retryable = coverage == null ? true : canRetry(coverage);
  const headline = coverageWrong
    ? coverageHeadline(coverage, status?.usage_coverage)
    : 'This install is missing historical model data';
  const detail = coverageWrong ? coverageDetail(coverage, status?.usage_coverage) : null;
  // A table that reports success and holds nothing is worse than a gap, so it
  // is not dressed in the same amber as "you have not run the backfill yet".
  const alarm = coverage === 'ok_no_rows' || coverage === 'unrecognised';
  const skin = alarm
    ? 'border-rose-200 bg-rose-50 text-rose-900'
    : 'border-amber-200 bg-amber-50 text-amber-900';

  return (
    <div className={`flex w-full flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs ${skin}`}>
      <span aria-hidden>⚠</span>
      <span className="font-semibold">{headline}</span>
      {detail && <span className={alarm ? 'text-rose-700' : 'text-amber-700'}>{detail}</span>}
      {!coverageWrong && status?.missing?.length ? (
        <span className="text-amber-700">
          ({status.missing.map(m => m.label).join(', ')})
        </span>
      ) : null}
      {err && <span className="font-semibold text-rose-700">{err}</span>}
      {done && !err && <span className="font-semibold text-emerald-700">Updated.</span>}
      {retryable && (
        <button onClick={runSync} disabled={busy}
          className="ml-1 flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-2 py-0.5 font-bold text-amber-900 transition hover:bg-amber-100 disabled:opacity-60">
          {busy && <span className="inline-block animate-spin leading-none">↻</span>}
          {busy ? 'Updating — this can take a few minutes…' : 'Update now'}
        </button>
      )}
      <button onClick={close} aria-label="Dismiss for now"
        className={`ml-auto ${alarm ? 'text-rose-500 hover:text-rose-800' : 'text-amber-500 hover:text-amber-800'}`}>✕</button>
    </div>
  );
}
