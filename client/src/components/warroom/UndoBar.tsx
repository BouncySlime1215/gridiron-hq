import { useCallback, useEffect, useState } from 'react';
import {
  UNDO_WINDOW_MS, canUndo, recordWarRoomRequest, undoWarRoomRequest,
  type Poster, type Recorded, type RequestKind, type WarRoomRequest,
} from './requests';

const KIND_TEXT: Partial<Record<RequestKind, string>> = {
  'objective.set': 'Goal change', 'mode.set': 'Risk mode change', 'tolerance.set': 'Tolerance change',
  'stop.add': 'New stop', 'stop.remove': 'Stop removal',
};

/**
 * The War Room's recorder for the WR-3 sheets: `record` posts one request and keeps its
 * row for Undo; `undo` posts one retract for it inside the 10-minute window. The Undo
 * affordance disappears when the window closes. A failed undo is shown, never swallowed.
 */
export function useRecorder(leagueId: number, post?: Poster) {
  const [last, setLast] = useState<Recorded | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [, tick] = useState(0);

  useEffect(() => { setLast(null); setNote(null); }, [leagueId]);

  // Re-render when the undo window closes, so Undo goes away on time.
  useEffect(() => {
    if (!last) return;
    const t = window.setTimeout(() => tick(n => n + 1), Math.max(0, last.at + UNDO_WINDOW_MS - Date.now()) + 50);
    return () => window.clearTimeout(t);
  }, [last]);

  const record = useCallback(async (req: WarRoomRequest) => {
    const rec = await recordWarRoomRequest(leagueId, req, post);
    setLast(rec);
    setNote({ tone: 'ok', text: `${KIND_TEXT[rec.kind] ?? 'Request'} recorded. The planner picks it up on its next run.` });
    return rec;
  }, [leagueId, post]);

  const undo = useCallback(async () => {
    if (!last) return;
    try {
      const out = await undoWarRoomRequest(leagueId, last, post);
      setLast(null);
      setNote(out.posted ? { tone: 'ok', text: 'Taken back. The planner will ignore it.' } : { tone: 'err', text: out.reason ?? 'Nothing to take back.' });
    } catch (e) {
      setNote({ tone: 'err', text: `Could not take it back: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, [last, leagueId, post]);

  return { last, note, record, undo, undoable: canUndo(last), dismiss: () => setNote(null) };
}

export type Recorder = ReturnType<typeof useRecorder>;

export default function UndoBar({ recorder }: { recorder: Recorder }) {
  const { note, undoable, undo, dismiss } = recorder;
  if (!note) return null;
  return (
    <div className={`wr-toast${note.tone === 'err' ? ' wr-red' : ''}`} role="status">
      <span>{note.text}</span>
      {undoable && <button type="button" className="wr-btn wr-sm" onClick={() => { void undo(); }}>Undo (10 min)</button>}
      <button type="button" className="wr-link" onClick={dismiss} aria-label="Dismiss">×</button>
    </div>
  );
}
