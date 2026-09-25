import { createContext, forwardRef, useCallback, useContext, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import Icon, { type IconName } from '../warroom/icons';

/**
 * The app's primitives, on styles/tokens.css and styles/ui.css (docs/ui/DESIGN-SYSTEM.md):
 * Card, Section, PageHeader, Button, IconButton, Chip, Stat (StatTile), Avatar, Tabs, Table
 * (DataTable), Skeleton, EmptyState, ErrorState, Sheet, Toast, Icon. Pages build from these;
 * a one-off look that duplicates one of them gets replaced, not kept beside it.
 */
export { Icon, type IconName };

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export function Card({ children, className, as: Tag = 'div', lift, pad = true }: {
  children: ReactNode; className?: string; as?: 'div' | 'section' | 'article'; lift?: boolean; pad?: boolean;
}) {
  return <Tag className={cx('ds-card', pad && 'ds-card-pad', lift && 'ds-lift', className)}>{children}</Tag>;
}

export function Button({ variant = 'default', size = 'md', icon, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'quiet'; size?: 'sm' | 'md' | 'lg'; icon?: IconName;
}) {
  return <button type="button" {...rest} className={cx('ds-btn', variant === 'primary' && 'ds-btn-primary', variant === 'quiet' && 'ds-btn-quiet',
    size === 'sm' && 'ds-btn-sm', size === 'lg' && 'ds-btn-lg', className)}>{icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}{children}</button>;
}

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }>(
  function IconButton({ icon, label, ...rest }, ref) {
    return <button ref={ref} type="button" aria-label={label} title={label} {...rest} className={cx('ds-icon-btn', rest.className)}><Icon name={icon} size={18} /></button>;
  });

export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad';
export function Chip({ tone = 'neutral', on, onClick, children, title }: { tone?: Tone; on?: boolean; onClick?: () => void; children: ReactNode; title?: string }) {
  const cls = cx('ds-chip', on && 'ds-chip-on', tone === 'accent' && 'ds-chip-accent', tone === 'good' && 'ds-chip-good', tone === 'warn' && 'ds-chip-warn', tone === 'bad' && 'ds-chip-bad');
  return onClick ? <button type="button" className={cls} aria-pressed={on} onClick={onClick} title={title}>{children}</button> : <span className={cls} title={title}>{children}</span>;
}

const HUES = [230, 160, 25, 280, 340, 190, 45, 120];
/** A round picture with initials on a tinted circle as the fallback (lazy, fixed size, no layout shift). */
export function Avatar({ name, src, size = 32 }: { name: string; src?: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  const words = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean);
  const initials = `${words[0]?.[0] ?? '?'}${words.length > 1 ? words[words.length - 1][0] : ''}`.toUpperCase();
  const hue = HUES[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length];
  return <span className="ds-avatar" style={{ width: size, height: size, fontSize: Math.round(size * .38), '--ds-av-h': String(hue) } as CSSProperties} aria-hidden>
    {src && !failed ? <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(true)} /> : initials}
  </span>;
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (id: T) => void; label: string }) {
  return <div className="ds-tabs" role="tablist" aria-label={label}>
    {tabs.map(t => <button key={t.id} type="button" role="tab" className="ds-tab" aria-selected={t.id === value} onClick={() => onChange(t.id)}>{t.label}</button>)}
  </div>;
}

export function Section({ title, description, action, children, className }: {
  title?: string; description?: string; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return <section className={className}>
    {(title || description || action) && <div className="ds-section-h">
      <div>{title && <h2 className="ds-section-t">{title}</h2>}{description && <p className="ds-section-d">{description}</p>}</div>
      {action}
    </div>}
    {children}
  </section>;
}

export function PageHeader({ eyebrow, title, description, actions, meta }: {
  eyebrow?: string; title: string; description?: string; actions?: ReactNode; meta?: ReactNode;
}) {
  return <header className="ds-page-h">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-3xl">
        {eyebrow && <div className="ds-eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p className="ds-page-d">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
    {meta && <div className="mt-3 flex flex-wrap gap-2 text-xs">{meta}</div>}
  </header>;
}

/** One number with its label: the stat block. `StatTile` is the same thing in a card. */
export function Stat({ label, value, foot, tone = 'neutral' }: { label: string; value: ReactNode; foot?: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'danger' }) {
  return <div><div className="ds-stat-l">{label}</div>
    <div className={cx('ds-stat-v', tone === 'good' && 'ds-good', tone === 'warn' && 'ds-warn', tone === 'danger' && 'ds-bad')}>{value}</div>
    {foot && <div className="ds-stat-f">{foot}</div>}</div>;
}

export function StatTile({ label, value, delta, freshness, tone = 'neutral' }: {
  label: string; value: ReactNode; delta?: ReactNode; freshness?: string; tone?: 'neutral' | 'good' | 'warn' | 'danger';
}) {
  return <Card className="!p-4"><Stat label={label} value={value} tone={tone} foot={(delta || freshness) ? <><span>{delta}</span>{freshness && <span>{freshness}</span>}</> : undefined} /></Card>;
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

export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) { return <div aria-hidden="true" className={cx('ds-skel', className)} />; }
export function EmptyState({ title, description, action, icon = 'inbox' }: { title: string; description?: string; action?: ReactNode; icon?: IconName }) {
  return <Card><div className="ds-empty" role="status"><span className="ds-empty-ic"><Icon name={icon} size={20} /></span><div className="ds-empty-t">{title}</div>
    {description && <p className="ds-empty-d">{description}</p>}{action && <div className="mt-3">{action}</div>}</div></Card>;
}
export function ErrorState({ title = 'Could not load this', message, retry }: { title?: string; message: string; retry?: () => void }) {
  return <div className="ds-error" role="alert"><div className="ds-error-t">{title}</div><p className="mt-1 text-sm">{message}</p>{retry && <Button size="sm" className="mt-3" onClick={retry}>Retry</Button>}</div>;
}

export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!open) return; closeRef.current?.focus(); const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [open, onClose]);
  if (!open) return null;
  return <div className="ds-scrim" onMouseDown={onClose}><aside role="dialog" aria-modal="true" aria-label={title} onMouseDown={e => e.stopPropagation()} className="ds-sheet">
    <div className="ds-sheet-h"><h2 className="ds-section-t">{title}</h2><IconButton ref={closeRef} icon="close" label={`Close ${title}`} onClick={onClose} /></div>{children}</aside></div>;
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
  return <div className="ds-table-wrap" style={{ height }} onScroll={e => setScrollTop(e.currentTarget.scrollTop)}>
    <table className="ds-table"><thead><tr>{columns.map(c => <th key={c.key}><button disabled={!c.sortValue} title={c.sortValue ? `Sort by ${c.label}` : undefined} onClick={() => c.sortValue && setSort(s => ({ key: c.key, dir: s?.key === c.key ? (s.dir === 1 ? -1 : 1) : 1 }))}>{c.label}{sort?.key === c.key ? sort.dir === 1 ? ' ↑' : ' ↓' : ''}</button></th>)}</tr></thead>
      <tbody><tr aria-hidden="true" style={{ height: start * rowHeight }} /><>{slice.map(row => <tr key={rowKey(row)} style={{ height: rowHeight }}>{columns.map(c => <td key={c.key} className={c.className}>{c.value(row)}</td>)}</tr>)}</><tr aria-hidden="true" style={{ height: Math.max(0, filtered.length - start - slice.length) * rowHeight }} /></tbody></table>
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
  return <ToastContext.Provider value={push}>{children}<div aria-live="polite" className="ds-toasts">{toasts.map(t => <div key={t.id} className={cx('ds-toast', t.tone === 'good' && 'ds-toast-good', t.tone === 'bad' && 'ds-toast-bad')}>{t.message}</div>)}</div></ToastContext.Provider>;
}
export const useToast = () => useContext(ToastContext);
