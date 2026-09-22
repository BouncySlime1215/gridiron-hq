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
  status: 'fresh' | 'stale' | 'empty';
  note: string | null;
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
  empty: { word: 'Missing', chip: 'bg-rose-100 text-rose-800' }
};

function span(t: TableFreshness): string {
  if (t.row_count === 0) return t.note ?? 'no rows on file';
  const range = t.earliest != null && t.latest != null
    ? (String(t.earliest) === String(t.latest) ? String(t.earliest) : `${t.earliest}–${t.latest}`)
    : null;
  const written = t.last_write ? `, updated ${t.last_write.slice(0, 10)}` : '';
  return `${t.row_count.toLocaleString()} rows${range ? `, ${range}` : ''}${written}`;
}

export default function DataFreshnessBanner() {
  const { data: report } = useApi<FreshnessReport>('/data-freshness');
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem('data-freshness-dismissed') === '1'; } catch { return false; }
  });

  if (!report || report.all_fresh || dismissed) return null;

  const behind = report.tables.filter(t => t.status !== 'fresh');
  const close = () => {
    try { sessionStorage.setItem('data-freshness-dismissed', '1'); } catch { /* private mode */ }
    setDismissed(true);
  };

  return (
    <div className="w-full border-b border-amber-200 bg-amber-50 text-amber-900">
      <div className="flex w-full flex-wrap items-center gap-2 px-4 py-1.5 text-xs">
        <span aria-hidden>⚠</span>
        <span className="font-semibold">
          {behind.length} data {behind.length === 1 ? 'source is' : 'sources are'} not current for {report.season} week {report.week}
        </span>
        <span className="text-amber-700">({behind.map(t => t.label).join(', ')})</span>
        <button onClick={() => setOpen(v => !v)}
          className="ml-1 rounded-md border border-amber-300 bg-white px-2 py-0.5 font-bold text-amber-900 transition hover:bg-amber-100">
          {open ? 'Hide detail' : 'What is behind'}
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
                    <td className="py-1.5 pr-3 text-slate-600">{span(t)}</td>
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
