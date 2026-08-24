import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';

/**
 * A team's draft queue, persisted server-side (server/draft/store.js's
 * draft_queue table) — never localStorage. Keeping the queue only in one
 * browser's localStorage would split-brain the moment the draft is opened
 * from a second tab/device or the draft continues after a reload: the queue
 * one tab sees would silently diverge from what the server (and every other
 * viewer) has. This hook seeds from the server's snapshot once, then owns
 * optimistic local edits and pushes every change back immediately.
 */
export function useDraftQueue(draftId: string | number | undefined, teamSlot: number, serverQueue: number[]) {
  const [queue, setQueue] = useState<number[]>(serverQueue);
  const seeded = useRef(false);

  useEffect(() => {
    if (!seeded.current && serverQueue.length) { setQueue(serverQueue); seeded.current = true; }
  }, [serverQueue]);

  const persist = useCallback((next: number[]) => {
    if (!draftId) return;
    api(`/drafts/${draftId}/queue`, {
      method: 'PUT',
      body: JSON.stringify({ team_slot: teamSlot, player_ids: next })
    }).catch(() => { /* next full refetch reconciles from the server's copy */ });
  }, [draftId, teamSlot]);

  const add = useCallback((playerId: number) => {
    setQueue(q => {
      if (q.includes(playerId)) return q;
      const next = [...q, playerId];
      persist(next);
      return next;
    });
  }, [persist]);

  const remove = useCallback((playerId: number) => {
    setQueue(q => {
      const next = q.filter(id => id !== playerId);
      persist(next);
      return next;
    });
  }, [persist]);

  const reorder = useCallback((fromIndex: number, toIndex: number) => {
    setQueue(q => {
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= q.length || toIndex >= q.length) return q;
      const next = [...q];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      persist(next);
      return next;
    });
  }, [persist]);

  /** Drops anyone the server reports as drafted (by any team) so the queue view never shows a stale entry. */
  const reconcile = useCallback((takenIds: ReadonlySet<number>) => {
    setQueue(q => q.filter(id => !takenIds.has(id)));
  }, []);

  return { queue, add, remove, reorder, reconcile, has: (id: number) => queue.includes(id) };
}
