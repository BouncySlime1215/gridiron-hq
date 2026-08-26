import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';

/**
 * Client-side durable-sync state machine for the live draft room (Phase 3C).
 *
 * The server does the actual reconciliation (POST /drafts/:id/sync mirrors ESPN's
 * board, idempotently and with rollback on failure — see server/services/espn-draft.js).
 * This hook's job is purely to drive polling safely from the browser and translate
 * whatever comes back into one of a fixed set of health states the UI can render
 * without ever blanking or fabricating the board.
 */

export type SyncHealth =
  | 'connecting'        // no board fetched yet
  | 'scheduled'          // draft hasn't started on ESPN's side yet
  | 'synchronized'       // last poll succeeded and landed on schedule
  | 'delayed'            // a poll failed but we're still retrying on a short backoff
  | 'offline'            // repeated consecutive failures — likely lost connectivity
  | 'reconnect-required' // ESPN auth expired; polling paused pending manual reconnect
  | 'invalid-data'       // server rejected the ESPN snapshot; last valid board kept
  | 'recovering'         // a manual retry/reconnect/reconcile is in flight
  | 'completed';         // draft finished

const BASE_INTERVAL_MS = 4000;
const MAX_BACKOFF_MS = 60_000;
const OFFLINE_AFTER_FAILURES = 3;

export interface LiveDraftSyncState {
  health: SyncHealth;
  board: any | null;
  lastSync: any | null;
  lastSyncedAt: number | null;
  syncNote: string | null;
  error: string | null;
  consecutiveFailures: number;
  nextRetryMs: number | null;
  picksOnEspn: number | null;
  picksMirrored: number | null;
  desynced: boolean;
  paused: boolean;
  retry: () => void;
  reconnect: () => void;
  reconcileNow: () => void;
  togglePause: () => void;
}

export function useLiveDraftSync(draftId: string): LiveDraftSyncState {
  const [board, setBoard] = useState<any>(null);
  const [lastSync, setLastSync] = useState<any>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [invalidData, setInvalidData] = useState(false);
  const [paused, setPaused] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);

  // A slow request racing the next timer tick is exactly how a pick gets mirrored
  // twice client-side or a poll gets counted as failed when it was only late.
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failuresRef = useRef(0);
  const pausedRef = useRef(paused);
  const authRequiredRef = useRef(false);
  const invalidDataRef = useRef(false);

  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

  const backoffFor = (failures: number) => Math.min(BASE_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);

  const scheduleNext = useCallback((delay: number) => {
    clearTimer();
    timer.current = setTimeout(() => { void run(); }, delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(async () => {
    if (inFlight.current || pausedRef.current) return;
    inFlight.current = true;
    try {
      const sync = await api(`/drafts/${draftId}/sync`, { method: 'POST' });
      setLastSync(sync);
      setLastSyncedAt(Date.now());
      if (sync.new_picks?.length) {
        setSyncNote(`+${sync.new_picks.length} pick${sync.new_picks.length > 1 ? 's' : ''} from ESPN`);
      }
      authRequiredRef.current = false;
      invalidDataRef.current = false;
      setAuthRequired(false);
      setInvalidData(!!sync.desynced || (sync.failures?.length ?? 0) > 0);
      setError(null);
      failuresRef.current = 0;
      setConsecutiveFailures(0);
      setRecovering(false);
    } catch (e: any) {
      const apiErr = e as ApiError;
      if (apiErr?.code === 'ESPN_AUTHENTICATION_FAILED' || apiErr?.status === 401 || apiErr?.status === 403) {
        // Terminal for this polling episode: never mutate against a token we know is
        // dead. The mirrored board stays exactly as it was until the user reconnects.
        authRequiredRef.current = true;
        setAuthRequired(true);
        setError(null);
        setRecovering(false);
        inFlight.current = false;
        return; // do not reschedule — reconnect() restarts polling explicitly
      }
      if (apiErr?.code === 'ESPN_INVALID_SNAPSHOT' || apiErr?.code === 'ESPN_MALFORMED_RESPONSE') {
        // The server has stopped this sync episode after rejecting unsafe data.
        // Preserve the last valid board and require an explicit recovery action.
        invalidDataRef.current = true;
        setInvalidData(true);
        setError(apiErr.message);
        setRecovering(false);
      } else {
        setError(apiErr?.message ?? 'Sync failed'); // never blank the board on a failed poll
        failuresRef.current += 1;
        setConsecutiveFailures(failuresRef.current);
        setRecovering(false);
      }
    } finally {
      inFlight.current = false;
    }

    try {
      const s = await api(`/drafts/${draftId}/assist`);
      setBoard(s);
    } catch (e: any) {
      // The board fetch failing independently of sync must not blank what's on screen.
      setError((prev) => prev ?? e.message);
    }

    if (!authRequiredRef.current && !invalidDataRef.current) scheduleNext(backoffFor(failuresRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, scheduleNext]);

  useEffect(() => {
    void run();
    return () => { clearTimer(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  const retry = useCallback(() => {
    clearTimer();
    setError(null);
    setRecovering(true);
    invalidDataRef.current = false;
    setInvalidData(false);
    failuresRef.current = 0;
    setConsecutiveFailures(0);
    void run();
  }, [run]);

  const reconnect = useCallback(() => {
    clearTimer();
    authRequiredRef.current = false;
    setAuthRequired(false);
    setError(null);
    setRecovering(true);
    failuresRef.current = 0;
    setConsecutiveFailures(0);
    void run();
  }, [run]);

  const reconcileNow = useCallback(() => {
    clearTimer();
    setRecovering(true);
    void run();
  }, [run]);

  const togglePause = useCallback(() => {
    setPaused(p => {
      const next = !p;
      pausedRef.current = next;
      if (next) clearTimer(); else void run();
      return next;
    });
  }, [run]);

  const health: SyncHealth = useMemo(() => {
    if (!board && !lastSync) return 'connecting';
    if (recovering) return 'recovering';
    if (authRequired) return 'reconnect-required';
    if (board?.draft?.status === 'completed' || lastSync?.espn_complete) return 'completed';
    if (invalidData) return 'invalid-data';
    if (board?.draft?.status === 'scheduled' && !lastSync?.espn_in_progress) return 'scheduled';
    if (consecutiveFailures >= OFFLINE_AFTER_FAILURES) return 'offline';
    if (consecutiveFailures > 0) return 'delayed';
    return 'synchronized';
  }, [board, lastSync, recovering, authRequired, invalidData, consecutiveFailures]);

  return {
    health,
    board,
    lastSync,
    lastSyncedAt,
    syncNote,
    error,
    consecutiveFailures,
    nextRetryMs: consecutiveFailures > 0 && !authRequired && !paused ? backoffFor(consecutiveFailures) : null,
    picksOnEspn: lastSync?.picks_on_espn ?? null,
    picksMirrored: lastSync?.picks_mirrored ?? null,
    desynced: invalidData,
    paused,
    retry,
    reconnect,
    reconcileNow,
    togglePause
  };
}
