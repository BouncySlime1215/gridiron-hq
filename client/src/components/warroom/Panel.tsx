import { Component, useState, type ReactNode } from 'react';
import type { PanelId } from './types';

/**
 * One dashboard panel. Panels never grow the page: the body scrolls inside itself only
 * as a last resort, lists page with <Pager>, and Expand swaps the panel into the NEXT
 * MOVE slot (Esc restores). On a phone every panel is one full-width deck page.
 */
export function Panel({ id, area, title, extra, big, expanded, onExpand, onRestore, children }: {
  id: PanelId; area: string; title: ReactNode; extra?: ReactNode; big: boolean; expanded?: boolean;
  onExpand?: () => void; onRestore?: () => void; children: ReactNode;
}) {
  return (
    <section className={`wr-panel${big ? ' wr-big' : ''}`} data-panel={id} aria-label={typeof title === 'string' ? title : id}
      style={{ gridArea: area }}>
      <div className="wr-ph">
        <h2>{title}</h2>
        <span className="wr-sp" />
        {extra}
        {expanded && onRestore && <button type="button" className="wr-xp" onClick={onRestore}>Back (Esc)</button>}
        {!expanded && !big && onExpand && <button type="button" className="wr-xp" onClick={onExpand}>Expand</button>}
      </div>
      <div className="wr-pb">
        <PanelBoundary name={typeof title === 'string' ? title : id}>{children}</PanelBoundary>
      </div>
    </section>
  );
}

/** Page through a list inside a panel: "1-4 of 11 ‹ ›". Returns the slice bounds and the control. */
export function usePager(total: number, size: number) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(total / size));
  const pg = Math.min(page, pages - 1);
  const a = pg * size, b = Math.min(total, a + size);
  const control = total > size ? (
    <span className="wr-pg">
      <button type="button" aria-label="Previous page" disabled={pg === 0} onClick={() => setPage(pg - 1)}>‹</button>
      {a + 1}-{b} of {total}
      <button type="button" aria-label="Next page" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>›</button>
    </span>
  ) : total ? <span className="wr-pg">{total} total</span> : null;
  return { a, b, control };
}

/** One failed card never blanks the page (UX-06). */
export class PanelBoundary extends Component<{ name: string; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : 'render error' }; }
  render() {
    if (this.state.error) {
      return <div className="wr-state wr-state-failed" role="status">{this.props.name} could not be drawn. The rest of the War Room still works.</div>;
    }
    return this.props.children;
  }
}
