import type { ReactNode } from 'react';
import { freshness, isFirstHand, provenanceLabel, sinceMinutes, titleCase } from './format';

/** A titled card. Matches the `.card` surface every other betting page uses. */
export function Panel({ eyebrow, title, description, action, footer, children, className = '' }: {
  eyebrow?: string; title?: string; description?: ReactNode; action?: ReactNode;
  footer?: ReactNode; children: ReactNode; className?: string;
}) {
  return <section className={`card overflow-hidden ${className}`}>
    {(title || action) && <header className="flex flex-wrap items-end gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
      <div className="min-w-0 flex-1">
        {eyebrow && <div className="text-[10px] font-black uppercase tracking-[.13em] text-slate-400">{eyebrow}</div>}
        {title && <h2 className="text-base font-bold tracking-[-0.02em] text-slate-900">{title}</h2>}
        {description && <p className="mt-0.5 text-xs leading-5 text-slate-500">{description}</p>}
      </div>
      {action}
    </header>}
    {children}
    {footer && <div className="border-t border-slate-100 px-4 py-2 text-[11px] leading-4 text-slate-400">{footer}</div>}
  </section>;
}

export function Stat({ label, value, detail, tone = 'neutral' }: {
  label: ReactNode; value: ReactNode; detail?: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'quiet';
}) {
  const toneClass = {
    neutral: 'text-slate-900', good: 'text-emerald-700', warn: 'text-amber-700',
    bad: 'text-rose-700', quiet: 'text-slate-400'
  }[tone];
  return <div className="min-w-0 bg-white px-4 py-3">
    <div className="text-[10px] font-black uppercase tracking-[.12em] text-slate-400">{label}</div>
    <div className={`mt-0.5 text-xl font-black tabular-nums tracking-[-0.02em] ${toneClass}`}>{value}</div>
    {detail && <div className="mt-0.5 text-[11px] leading-4 text-slate-500">{detail}</div>}
  </div>;
}

/** A row of stats sharing one hairline grid, as used across the betting desk. */
export function StatRow({ children, columns = 'sm:grid-cols-4' }: { children: ReactNode; columns?: string }) {
  return <div className={`grid grid-cols-2 gap-px bg-slate-100 ${columns}`}>{children}</div>;
}

/**
 * How this number reached the screen, and how old it is.
 *
 * A price read straight off the book's own feed and a price lifted from an
 * hourly third-party scrape are different strength claims. Drawing them the
 * same way would be the single most misleading thing this board could do, so
 * they never share a colour, a word, or a shape.
 */
export function ProvenanceTag({ provenance, ageMinutes, source, compact = false }: {
  provenance: string | null | undefined; ageMinutes?: number | null;
  source?: string | null; compact?: boolean;
}) {
  const first = isFirstHand(provenance);
  const age = freshness(ageMinutes);
  const stale = age === 'aging' || age === 'stale';
  const tone = first
    ? (stale ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-emerald-300 bg-emerald-50 text-emerald-800')
    : (stale ? 'border-rose-300 bg-rose-50 text-rose-800' : 'border-amber-300 bg-amber-50 text-amber-900');
  const title = [
    `${provenanceLabel(provenance)} quote`,
    provenance ? `provenance: ${provenance}` : null,
    source ? `source: ${source}` : null,
    ageMinutes == null ? 'age unknown' : `captured ${sinceMinutes(ageMinutes)}`,
    first
      ? 'Read from the book’s own feed.'
      : 'Reached us through a third party, not from the book directly. Confirm it at the book.'
  ].filter(Boolean).join(' · ');

  return <span title={title}
    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone}`}>
    <span aria-hidden="true">{first ? '◆' : '◇'}</span>
    <span>{compact ? (first ? '1st' : '2nd') : provenanceLabel(provenance)}</span>
    {ageMinutes != null && <><span className="opacity-40">·</span><span className="tabular-nums">{sinceMinutes(ageMinutes)}</span></>}
    {stale && <span className="ml-0.5 uppercase tracking-wide">{age === 'stale' ? 'stale' : 'aging'}</span>}
  </span>;
}

/**
 * Required on the board, not decoration: a captured line is a pointer to a
 * bet, never the bet itself.
 */
export function ConfirmAtBookWarning({ className = '' }: { className?: string }) {
  return <div role="note" className={`rounded-xl border border-amber-300 bg-amber-50 p-4 ${className}`}>
    <div className="flex items-start gap-3">
      <span aria-hidden="true" className="mt-px grid h-6 w-6 shrink-0 place-items-center rounded-full bg-amber-500 text-[13px] font-black text-white">!</span>
      <div className="min-w-0">
        <div className="text-sm font-black text-amber-950">Confirm every number at the book before you place it</div>
        <p className="mt-1 text-xs leading-5 text-amber-900">
          Nothing here is an executable price. Second-hand lines arrive through an hourly aggregator scrape and
          can be an hour stale the moment you read them; even a first-hand quote moves between the capture and
          your bet slip. Open the book, check the spread and the teaser payout, and only then take the ticket.
        </p>
      </div>
    </div>
  </div>;
}

/**
 * Why a book produced nothing. An empty table with no explanation is the
 * failure mode this panel exists to prevent — the reason is usually the most
 * useful thing on the screen.
 */
export function BlockedReasons({ reasons, title = 'No qualifying ticket from this book', className = '' }: {
  reasons: string[] | null | undefined; title?: string; className?: string;
}) {
  const list = (reasons ?? []).filter(Boolean);
  return <div className={`rounded-xl border border-slate-200 bg-slate-50 p-4 ${className}`}>
    <div className="text-sm font-bold text-slate-800">{title}</div>
    {list.length === 0 ? (
      <p className="mt-1 text-xs leading-5 text-slate-500">
        The board returned no candidates and gave no reason. That is itself worth reporting — refresh, and if it
        stays empty and silent the capture never ran.
      </p>
    ) : (
      <ul className="mt-2 space-y-1.5">
        {list.map((reason, index) => <li key={`${index}:${reason}`} className="flex items-start gap-2 text-xs leading-5 text-slate-700">
          <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400" />
          <span>{reason}</span>
        </li>)}
      </ul>
    )}
  </div>;
}

const MISSING = /\b(404|not found|cannot get|cannot post|cannot put|503|unavailable|service unavailable|failed to fetch|networkerror)\b/i;

/** Is this error "the route does not exist yet" rather than "the data is bad"? */
export function isBackendMissing(error: string | null | undefined) {
  return !!error && MISSING.test(error);
}

/**
 * The state this hub spends its first life in: built against a written
 * contract, pointed at routes that are still being written. It says exactly
 * which endpoint is missing rather than showing a spinner forever.
 */
export function BackendNotReady({ error, endpoints, onRetry }: {
  error: string | null; endpoints: string[]; onRetry?: () => void;
}) {
  const missing = isBackendMissing(error);
  return <div className="card border-amber-200 p-6" role="status">
    <div className="flex flex-wrap items-center gap-2">
      <span className="rounded-full bg-amber-500 px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wide text-white">
        {missing ? 'Backend not ready' : 'Request failed'}
      </span>
      <div className="text-base font-bold text-slate-900">
        {missing ? 'The Wong routes are not answering yet' : 'The Wong service returned an error'}
      </div>
    </div>
    <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
      {missing
        ? 'This hub is built against the /api/betting/wong contract. Everything on this page renders the moment the service answers — nothing here is mocked, and no number is shown that the server has not sent.'
        : 'The service answered, but not with a board. The message it returned is below.'}
    </p>
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-[10px] font-black uppercase tracking-[.12em] text-slate-400">Waiting on</div>
      <ul className="mt-1 space-y-0.5">
        {endpoints.map(endpoint => <li key={endpoint} className="font-mono text-xs text-slate-600">{endpoint}</li>)}
      </ul>
      {error && <div className="mt-2 border-t border-slate-200 pt-2 text-xs text-rose-700">{error}</div>}
    </div>
    {onRetry && <button onClick={onRetry} className="btn-ghost mt-3 text-sm">Try again</button>}
  </div>;
}

export function BookChip({ book, active, onClick, detail }: {
  book: string; active?: boolean; onClick?: () => void; detail?: ReactNode;
}) {
  const className = `rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${active
    ? 'bg-slate-950 text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900'}`;
  if (!onClick) return <span className={className}>{titleCase(book)}{detail}</span>;
  return <button type="button" onClick={onClick} aria-pressed={!!active} className={className}>{titleCase(book)}{detail}</button>;
}

export function Loading({ label }: { label: string }) {
  return <div className="card p-6 text-sm text-slate-500">{label}</div>;
}
