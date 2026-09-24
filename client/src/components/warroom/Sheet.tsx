import { useCallback, useState, type ReactNode } from 'react';
import type { Recorded, WarRoomRequest } from './requests';

/** What a WR-3 sheet gets from the War Room: record one request (throws on failure), and close. */
export type RecordFn = (req: WarRoomRequest) => Promise<Recorded>;

/**
 * One request per tap: `submit` records it, closes the sheet on success, and on failure
 * keeps the sheet open with the cause on screen (never swallowed).
 */
export function useSubmit(onRecord: RecordFn, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = useCallback(async (req: WarRoomRequest | null) => {
    if (!req || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRecord(req);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, onRecord, onClose]);
  return { busy, error, submit, setError };
}

/** The bottom sheet / dialog the WR-3 controls open in. */
export function Sheet({ title, onClose, error, children }: { title: string; onClose: () => void; error?: string | null; children: ReactNode }) {
  return (
    <div className="wr-sheet-back" onClick={onClose}>
      <section className="wr-sheet" role="dialog" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="wr-row">
          <b className="wr-sheet-t">{title}</b>
          <span className="wr-sp" />
          <button type="button" className="wr-btn wr-sm" onClick={onClose} aria-label="Close">Close</button>
        </div>
        {children}
        {error && <p className="wr-hint wr-red" role="status">Not recorded: {error}</p>}
        <p className="wr-hint">Recorded only. The planner reads it on its next run; nothing is sent to anyone.</p>
      </section>
    </div>
  );
}
