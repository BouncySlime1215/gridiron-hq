import { Link } from 'react-router-dom';

/**
 * Shared page-level states, per the "every API-backed page must show loading,
 * failure, and empty states" gap the platform audit found — most pages either
 * showed nothing on error (silent stale/empty data with zero indication
 * anything broke) or hand-rolled their own one-off version.
 */

export function PageLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2.5 text-sm text-slate-500 py-8">
      <span className="w-3.5 h-3.5 rounded-full border-2 border-slate-300 border-t-[var(--accent)] animate-spin" />
      {label}
    </div>
  );
}

// UX-08: `message` here is whatever the server (or a thrown fetch error) said,
// which has included a file path and a table name (Lineup.tsx, the
// chance-to-play degradation notice). That is an internal detail, not
// something a user can act on, so it never reaches the DOM — it goes to the
// console for whoever is debugging, and the card shows the same plain-words
// state ("what failed" + a retry) no matter what the server actually said.
export function PageError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  if (message) {
    // eslint-disable-next-line no-console
    console.error('[PageError]', message);
  }
  return (
    <div className="card p-6 border-crit">
      <p className="text-sm text-crit font-medium mb-1">Couldn't load this.</p>
      <p className="text-sm text-slate-600">Something went wrong loading this. Try again in a moment.</p>
      {onRetry && (
        <button className="btn-ghost text-xs mt-3" onClick={onRetry}>↻ Retry</button>
      )}
    </div>
  );
}

export function EmptyState({ title, description, actionLabel, actionTo, onAction }: {
  title: string; description?: string;
  actionLabel?: string; actionTo?: string; onAction?: () => void;
}) {
  return (
    <div className="card p-8 text-center">
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {description && <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">{description}</p>}
      {actionLabel && actionTo && (
        <Link to={actionTo} className="btn-primary inline-block mt-3 text-sm">{actionLabel}</Link>
      )}
      {actionLabel && onAction && !actionTo && (
        <button className="btn-primary mt-3 text-sm" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}

/**
 * Wraps the common loading/error/empty triad around whatever a page renders on
 * success, so a page just says what "empty" means instead of re-deriving the
 * loading/error branches every time. `isEmpty` is left to the caller since
 * "empty" means something different per page (no drafts vs. no leagues vs. no
 * news).
 */
export function PageData<T>({ loading, error, data, onRetry, isEmpty, empty, loadingLabel, children }: {
  loading: boolean; error?: string | null; data: T | null | undefined; onRetry?: () => void;
  isEmpty?: (d: T) => boolean; empty?: React.ReactNode; loadingLabel?: string;
  children: (data: T) => React.ReactNode;
}) {
  if (loading && !data) return <PageLoading label={loadingLabel} />;
  if (error && !data) return <PageError message={error} onRetry={onRetry} />;
  if (data == null) return null;
  if (isEmpty?.(data) && empty) return <>{empty}</>;
  return <>{children(data)}</>;
}
