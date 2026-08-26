import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export function Card({ children, className, as: Tag = 'div' }: { children: ReactNode; className?: string; as?: 'div' | 'section' | 'article' }) {
  return <Tag className={cx('card', className)}>{children}</Tag>;
}

export function Section({ title, description, action, children, className }: {
  title?: string; description?: string; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return <section className={cx('space-y-3', className)}>
    {(title || description || action) && <div className="flex items-end justify-between gap-4">
      <div>{title && <h2 className="text-xl font-extrabold text-slate-900">{title}</h2>}{description && <p className="mt-1 text-sm text-slate-500">{description}</p>}</div>
      {action}
    </div>}
    {children}
  </section>;
}

export function PageHeader({ eyebrow, title, description, actions, meta }: {
  eyebrow?: string; title: string; description?: string; actions?: ReactNode; meta?: ReactNode;
}) {
  return <header className="mb-6 border-b border-slate-200 pb-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-3xl">
        {eyebrow && <div className="mb-1 text-xs font-extrabold uppercase tracking-[.12em] text-emerald-700">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
    {meta && <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">{meta}</div>}
  </header>;
}

export function StatTile({ label, value, delta, freshness, tone = 'neutral' }: {
  label: string; value: ReactNode; delta?: ReactNode; freshness?: string; tone?: 'neutral' | 'good' | 'warn' | 'danger';
}) {
  const toneClass = { neutral: 'text-slate-900', good: 'text-emerald-700', warn: 'text-amber-700', danger: 'text-red-700' }[tone];
  return <Card className="p-4">
    <div className="text-xs font-semibold text-slate-500">{label}</div>
    <div className={cx('mt-1 text-2xl font-extrabold tabular-nums', toneClass)}>{value}</div>
    <div className="mt-2 flex items-center justify-between gap-2 text-xs"><span className="text-slate-600">{delta}</span>{freshness && <span className="text-slate-400">{freshness}</span>}</div>
  </Card>;
}

export function Confidence({ coverage, sample, label }: { coverage: number | null; sample?: number; label?: string }) {
  const value = coverage == null ? null : Math.max(0, Math.min(1, coverage));
  const text = label ?? (value == null ? 'Uncalibrated' : value >= .78 ? 'Calibrated' : value >= .65 ? 'Developing' : 'Low confidence');
  return <div className="inline-flex items-center gap-2" aria-label={`${text}${sample ? `, ${sample} observations` : ''}`}>
    <span className="h-2 w-20 overflow-hidden rounded-full bg-slate-200"><span className="block h-full bg-emerald-600" style={{ width: `${(value ?? 0) * 100}%` }} /></span>
    <span className="text-xs font-semibold text-slate-700">{text}</span>{sample != null && <span className="text-xs text-slate-400">n={sample}</span>}
  </div>;
}

export function Provenance({ source, updatedAt, version, children }: { source: string; updatedAt?: string | null; version?: string | null; children?: ReactNode }) {
  return <details className="text-xs text-slate-500"><summary className="cursor-pointer rounded-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600">Source: {source}{updatedAt ? ` · ${new Date(updatedAt).toLocaleString()}` : ''}</summary>
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3">{version && <div>Version: {version}</div>}{children}</div>
  </details>;
}

export function Distribution({ values, width = 260, height = 72, label = 'Projection distribution' }: { values: number[]; width?: number; height?: number; label?: string }) {
  if (!values.length) return <div className="h-[72px] rounded-md bg-slate-100" aria-label={`${label}: unavailable`} />;
  const sorted = [...values].sort((a, b) => a - b), min = sorted[0], max = sorted.at(-1) ?? min;
  const bins = Array.from({ length: 20 }, () => 0);
  for (const value of sorted) bins[Math.min(19, Math.floor(((value - min) / Math.max(max - min, 1e-9)) * 20))]++;
  const peak = Math.max(...bins, 1), bar = width / bins.length;
  return <svg role="img" aria-label={`${label}, range ${min.toFixed(1)} to ${max.toFixed(1)}`} viewBox={`0 0 ${width} ${height}`} className="w-full max-w-md overflow-visible">
    {bins.map((n, i) => <rect key={i} x={i * bar + 1} y={height - (n / peak) * (height - 14)} width={Math.max(1, bar - 2)} height={(n / peak) * (height - 14)} rx="2" fill="#059669" opacity={.82} />)}
    <text x="0" y={height} fontSize="10" fill="#64748b">{min.toFixed(1)}</text><text x={width} y={height} textAnchor="end" fontSize="10" fill="#64748b">{max.toFixed(1)}</text>
  </svg>;
}

export function DriverBars({ baseline = 0, drivers }: { baseline?: number; drivers: { label: string; value: number; detail?: string }[] }) {
  const total = baseline + drivers.reduce((sum, d) => sum + d.value, 0), max = Math.max(...drivers.map(d => Math.abs(d.value)), 1);
  return <div className="space-y-2" aria-label={`Projection drivers sum to ${total.toFixed(1)}`}>
    {drivers.map(d => <div key={d.label} className="grid grid-cols-[100px_1fr_48px] items-center gap-2 text-xs">
      <span className="font-semibold text-slate-600">{d.label}</span><span className="h-2 rounded-full bg-slate-100"><span className={cx('block h-full rounded-full', d.value >= 0 ? 'bg-emerald-600' : 'bg-red-600')} style={{ width: `${Math.abs(d.value) / max * 100}%` }} title={d.detail} /></span><span className="text-right tabular-nums text-slate-700">{d.value > 0 ? '+' : ''}{d.value.toFixed(1)}</span>
    </div>)}
    <div className="border-t border-slate-200 pt-2 text-right text-xs font-bold text-slate-900">Total {total.toFixed(1)}</div>
  </div>;
}

export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) { return <div aria-hidden="true" className={cx('animate-pulse rounded-md bg-slate-200', className)} />; }
export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) { return <Card className="p-8 text-center"><div className="font-bold text-slate-800">{title}</div>{description && <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{description}</p>}{action && <div className="mt-4">{action}</div>}</Card>; }
export function ErrorState({ title = 'Could not load this', message, retry }: { title?: string; message: string; retry?: () => void }) { return <div className="card border-red-200 p-5" role="alert"><div className="font-bold text-red-800">{title}</div><p className="mt-1 text-sm text-slate-600">{message}</p>{retry && <button className="btn-ghost mt-3" onClick={retry}>Retry</button>}</div>; }

export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!open) return; closeRef.current?.focus(); const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [open, onClose]);
  if (!open) return null;
  return <div className="fixed inset-0 z-[150] bg-slate-900/20 backdrop-blur-sm" onMouseDown={onClose}><aside role="dialog" aria-modal="true" aria-label={title} onMouseDown={e => e.stopPropagation()} className="ml-auto h-full w-full max-w-xl overflow-y-auto border-l border-slate-200 bg-white p-6 shadow-2xl"><div className="mb-5 flex items-center justify-between"><h2 className="text-xl font-extrabold">{title}</h2><button ref={closeRef} className="btn-ghost" onClick={onClose} aria-label={`Close ${title}`}>Close</button></div>{children}</aside></div>;
}

export type DataColumn<T> = { key: string; label: string; value: (row: T) => ReactNode; sortValue?: (row: T) => string | number | null; className?: string };
export function DataTable<T>({ rows, columns, rowKey, height = 560, rowHeight = 44, filterText = '', searchText }: { rows: T[]; columns: DataColumn<T>[]; rowKey: (row: T) => string | number; height?: number; rowHeight?: number; filterText?: string; searchText?: (row: T) => string }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null), [scrollTop, setScrollTop] = useState(0);
  const filtered = useMemo(() => {
    let out = filterText && searchText ? rows.filter(r => searchText(r).toLowerCase().includes(filterText.toLowerCase())) : rows;
    if (sort) { const col = columns.find(c => c.key === sort.key); if (col?.sortValue) out = [...out].sort((a, b) => String(col.sortValue!(a) ?? '').localeCompare(String(col.sortValue!(b) ?? ''), undefined, { numeric: true }) * sort.dir); }
    return out;
  }, [rows, columns, filterText, searchText, sort]);
  const visible = Math.ceil(height / rowHeight) + 8, start = Math.max(0, Math.floor(scrollTop / rowHeight) - 4), slice = filtered.slice(start, start + visible);
  return <div className="overflow-auto rounded-[10px] border border-slate-200 bg-white" style={{ height }} onScroll={e => setScrollTop(e.currentTarget.scrollTop)}>
    <table className="w-full text-sm"><thead className="sticky top-0 z-10 bg-slate-50"><tr>{columns.map(c => <th key={c.key} className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-500"><button className="text-left" disabled={!c.sortValue} onClick={() => c.sortValue && setSort(s => ({ key: c.key, dir: s?.key === c.key ? (s.dir === 1 ? -1 : 1) : 1 }))}>{c.label}{sort?.key === c.key ? sort.dir === 1 ? ' ↑' : ' ↓' : ''}</button></th>)}</tr></thead>
      <tbody><tr aria-hidden="true" style={{ height: start * rowHeight }} /><>{slice.map(row => <tr key={rowKey(row)} style={{ height: rowHeight }} className="border-b border-slate-100">{columns.map(c => <td key={c.key} className={cx('px-3 py-2', c.className)}>{c.value(row)}</td>)}</tr>)}</><tr aria-hidden="true" style={{ height: Math.max(0, filtered.length - start - slice.length) * rowHeight }} /></tbody></table>
  </div>;
}

type Toast = { id: string; message: string; tone: 'info' | 'good' | 'bad' };
const ToastContext = createContext<(message: string, tone?: Toast['tone']) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = `${tone}:${message}`;
    setToasts(current => current.some(t => t.id === id) ? current : [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts(current => current.filter(t => t.id !== id)), 4500);
  }, []);
  return <ToastContext.Provider value={push}>{children}<div aria-live="polite" className="fixed bottom-4 right-4 z-[200] space-y-2">{toasts.map(t => <div key={t.id} className={cx('rounded-[10px] border bg-white px-4 py-3 text-sm shadow-lg', t.tone === 'good' ? 'border-emerald-300' : t.tone === 'bad' ? 'border-red-300' : 'border-slate-200')}>{t.message}</div>)}</div></ToastContext.Provider>;
}
export const useToast = () => useContext(ToastContext);
