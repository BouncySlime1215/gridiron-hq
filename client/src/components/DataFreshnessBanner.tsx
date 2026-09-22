import { useState } from 'react';
import { useApi } from '../api';

interface TableFreshness {
  table: string;
  label: string;
  row_count: number;
  earliest: number | string | null;
  latest: number | string | null;
  last_write: string | null;
  current_rule: string | null;
  status: 'fresh' | 'stale' | 'empty' | 'unknown';
  note: string | null;
  grain?: 'week' | 'season' | 'static' | 'fit' | null;
  reader?: string | null;
}
interface FreshnessReport {
  season: number;
  week: number;
  all_fresh: boolean;
  tables: TableFreshness[];
}

/**
 * Replaces the "data healthy" banner, which read the sync log and reported
 * healthy while the weekly usage table held nothing for the season being
 * played. This reads the rows: for each served table it shows how many rows
 * are on file, the seasons they span, when it last took a write, and one word
 * for whether that data is current. A live connection is not freshness, so
 * this never asks about one.
 *
 * Slim while everything is current, like the banner it replaces — it appears
 * only when a table is behind, names which, and expands to the full per-table
 * detail. The X dismisses for this sitting only (sessionStorage), so an install
 * that is genuinely behind is reminded again next launch rather than going
 * quiet forever.
 */
const STATUS_STYLE: Record<TableFreshness['status'], { word: string; chip: string }> = {
  fresh: { word: 'Current', chip: 'bg-emerald-100 text-emerald-800' },
  stale: { word: 'Behind', chip: 'bg-amber-100 text-amber-900' },
  empty: { word: 'Missing', chip: 'bg-rose-100 text-rose-800' },
  // Not a fourth degree of behind. `unknown` means the check could not be run
  // for this source, and it reads in slate rather than amber so it is not
  // mistaken for a late feed: a late feed needs re-running, an unchecked one
  // needs its registry entry repaired.
  unknown: { word: 'Not checked', chip: 'bg-slate-200 text-slate-800' }
};

function span(t: TableFreshness): string {
  if (t.row_count === 0) return t.note ?? 'no rows on file';
  const range = t.earliest != null && t.latest != null
    ? (String(t.earliest) === String(t.latest) ? String(t.earliest) : `${t.earliest}–${t.latest}`)
    : null;
  const written = t.last_write ? `, updated ${t.last_write.slice(0, 10)}` : '';
  return `${t.row_count.toLocaleString()} rows${range ? `, ${range}` : ''}${written}`;
}

/**
 * The four grains are four different failures and must not read alike.
 *
 * A fit store that is behind is not a late feed: the reader names the model
 * that is answering on a fallback right now. A season-grained table that is
 * behind has nothing for the season being played, which a "not updated for the
 * current week" sentence would misdescribe — it is a year out, not a week. A
 * static table has no weekly cadence at all, so the only honest thing to say is
 * that its refresh stopped.
 *
 * `null` grain is the fifth case: nobody classified this table. The sentence
 * says only what the status supports and names no cadence, because inventing
 * one is the same move as the 'feed' default this replaced.
 */
function behindSentence(t: TableFreshness): string {
  if (t.status === 'unknown') {
    return t.note ?? 'This source could not be checked, so whether it is current is unknown.';
  }
  const empty = t.status === 'empty';
  if (t.grain === 'fit') {
    const who = t.reader ? `The ${t.reader} model` : 'A model';
    return empty
      ? `${who} has no fit on file and is answering on a fallback.`
      : `${who} is answering on a fit from an earlier season, not this one.`;
  }
  if (t.grain === 'week') {
    return empty ? 'This feed has no rows on file yet.'
      : 'This feed has not been updated for the current week.';
  }
  if (t.grain === 'season') {
    return empty ? 'This table has no rows on file yet.'
      : 'This table holds nothing for the season being played.';
  }
  if (t.grain === 'static') {
    return empty ? 'This table has never been populated.'
      : 'This table has stopped being refreshed.';
  }
  return empty ? 'This table has no rows on file yet.'
    : 'This table does not hold current data.';
}

export default function DataFreshnessBanner() {
  const { data: report, error } = useApi<FreshnessReport>('/data-freshness');
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem('data-freshness-dismissed') === '1'; } catch { return false; }
  });

  const close = () => {
    try { sessionStorage.setItem('data-freshness-dismissed', '1'); } catch { /* private mode */ }
    setDismissed(true);
  };

  // The check itself failed — a 404 because the route is not mounted yet, a
  // network error, a 500. Returning null here would put the user in front of a
  // silent page, and a page with no warning on it reads as "everything is
  // current". That is the exact lie the banner this one replaced used to tell,
  // so the failure gets said out loud instead of swallowed.
  if (error && !dismissed) {
    return (
      <div className="w-full border-b border-slate-300 bg-slate-100 text-slate-800">
        <div className="flex w-full flex-wrap items-center gap-2 px-4 py-1.5 text-xs">
          <span aria-hidden>●</span>
          <span className="font-semibold">Data freshness could not be checked.</span>
          <span className="text-slate-600">
            No warning on this page does not mean your data is current — nothing was read.
          </span>
          <button onClick={close} aria-label="Dismiss for now"
            className="ml-auto text-slate-400 hover:text-slate-700">✕</button>
        </div>
      </div>
    );
  }

  if (!report || report.all_fresh || dismissed) return null;

  // Counted apart, because they are different problems: `behind` is data that
  // did not arrive, `unchecked` is a question that was never asked. Folding the
  // second into "not current" would state a fact nobody established.
  const behind = report.tables.filter(t => t.status === 'stale' || t.status === 'empty');
  const unchecked = report.tables.filter(t => t.status === 'unknown');
  const flagged = [...behind, ...unchecked];
  const headline = behind.length > 0
    ? `${behind.length} data ${behind.length === 1 ? 'source is' : 'sources are'} not current for ${report.season} week ${report.week}`
    : `${unchecked.length} data ${unchecked.length === 1 ? 'source' : 'sources'} could not be checked for ${report.season} week ${report.week}`;
  const tail = behind.length > 0 && unchecked.length > 0
    ? `, and ${unchecked.length} more could not be checked`
    : '';
  return (
    <div className="w-full border-b border-amber-200 bg-amber-50 text-amber-900">
      <div className="flex w-full flex-wrap items-center gap-2 px-4 py-1.5 text-xs">
        <span aria-hidden>⚠</span>
        <span className="font-semibold">{headline}{tail}</span>
        <span className="text-amber-700">({flagged.map(t => t.label).join(', ')})</span>
        <button onClick={() => setOpen(v => !v)}
          className="ml-1 rounded-md border border-amber-300 bg-white px-2 py-0.5 font-bold text-amber-900 transition hover:bg-amber-100">
          {open ? 'Hide detail' : behind.length > 0 ? 'What is behind' : 'What was not checked'}
        </button>
        <button onClick={close} aria-label="Dismiss for now" className="ml-auto text-amber-500 hover:text-amber-800">✕</button>
      </div>
      {open && (
        <div className="border-t border-amber-200 bg-white px-4 py-3 text-xs text-slate-700">
          <p className="mb-2 text-slate-500">
            Why this matters: a working connection is not the same as current data. This reads the rows on file, not
            whether a download ran, so a table that fetched successfully but holds nothing for this week still shows as behind.
          </p>
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                <th className="py-1 pr-3 font-semibold">Data</th>
                <th className="py-1 pr-3 font-semibold">On file</th>
                <th className="py-1 pr-3 font-semibold">Should have</th>
                <th className="py-1 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {report.tables.map(t => {
                const s = STATUS_STYLE[t.status];
                return (
                  <tr key={t.table} className="border-t border-slate-100 align-top">
                    <td className="py-1.5 pr-3 font-semibold text-slate-800">{t.label}</td>
                    <td className="py-1.5 pr-3 text-slate-600">
                      {span(t)}
                      {t.status !== 'fresh' && (
                        <div className="mt-0.5 text-[11px] text-amber-700">{behindSentence(t)}</div>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-slate-500">{t.current_rule ?? '—'}</td>
                    <td className="py-1.5">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${s.chip}`}>{s.word}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
