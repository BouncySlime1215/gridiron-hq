import { useCallback, useEffect, useRef, useState } from 'react';
import { api, useApi } from '../../api';
import {
  type Leg, type Ticket, loadSlip, saveSlipStorage, loadLegacyTickets, clearLegacyTickets,
  newId, cleanOdds, totalOdds, legKey
} from './lib';

/**
 * The pick slip and saved tickets, shared between the Model Board (which only
 * ever adds legs) and My Picks (which manages the full slip and saved-ticket
 * lifecycle).
 *
 * The in-progress slip (legs being assembled, not yet saved) is still
 * localStorage-backed — a legitimate per-browser scratch state. Saved tickets
 * (committed singles/parlays) are server-side now (server/routes/props-tickets.js)
 * so a slip saved on one browser/device shows up on every other one — see the
 * file comment in ./lib.ts for why that changed.
 */
export function usePickSlip() {
  const [slip, setSlip] = useState<Leg[]>(() => loadSlip());
  useEffect(() => saveSlipStorage(slip), [slip]);

  const { data: tickets, loading: ticketsLoading, error: ticketsError, refetch: refetchTickets } = useApi<Ticket[]>('/props-tickets');

  // One-time migration: the first time this browser successfully loads the
  // server ticket list, copy over anything it had saved under the old
  // localStorage-only scheme, then clear that key so this never repeats. If a
  // leg fails to post (offline, server hiccup), the legacy key is left alone
  // so the next successful load retries it — better a stray extra attempt
  // than silently losing someone's saved picks.
  const migratingLegacy = useRef(false);
  useEffect(() => {
    if (tickets == null || migratingLegacy.current) return;
    const legacy = loadLegacyTickets();
    if (!legacy.length) return;
    migratingLegacy.current = true;
    (async () => {
      try {
        for (const ticket of legacy) {
          await api('/props-tickets', { method: 'POST', body: JSON.stringify(ticket) });
        }
        clearLegacyTickets();
        refetchTickets();
      } finally {
        migratingLegacy.current = false;
      }
    })();
  }, [tickets, refetchTickets]);

  const addLeg = useCallback((leg: Leg) => {
    setSlip(prev => (prev.some(l => legKey(l) === legKey(leg)) ? prev : [...prev, leg]));
  }, []);

  const isInSlip = useCallback((leg: Leg) => slip.some(l => legKey(l) === legKey(leg)), [slip]);

  const removeLeg = useCallback((index: number) => {
    setSlip(prev => prev.filter((_, i) => i !== index));
  }, []);

  const updateOdds = useCallback((index: number, odds: string) => {
    setSlip(prev => prev.map((l, i) => (i === index ? { ...l, odds } : l)));
  }, []);

  const clearSlip = useCallback(() => setSlip([]), []);

  /** @returns an error message, or null on success. */
  const saveTicket = useCallback(async (): Promise<string | null> => {
    if (!slip.length) return 'Add at least one pick first.';
    if (slip.some(l => cleanOdds(l.odds) == null)) return 'Add American odds for every leg before saving.';
    const odds = totalOdds(slip);
    const ticket: Ticket = {
      id: newId(),
      savedAt: new Date().toISOString(),
      legs: slip.map(l => ({ ...l })),
      totalAmericanOdds: odds.american,
      totalDecimalOdds: odds.decimal
    };
    try {
      await api('/props-tickets', { method: 'POST', body: JSON.stringify(ticket) });
    } catch (e: any) {
      return e?.message || 'Could not save this slip — try again.';
    }
    setSlip([]);
    refetchTickets();
    return null;
  }, [slip, refetchTickets]);

  const deleteTicket = useCallback(async (id: string) => {
    try {
      await api(`/props-tickets/${id}`, { method: 'DELETE' });
    } finally {
      refetchTickets();
    }
  }, [refetchTickets]);

  const clearTickets = useCallback(async () => {
    const current = tickets ?? [];
    try {
      await Promise.all(current.map(t => api(`/props-tickets/${t.id}`, { method: 'DELETE' })));
    } finally {
      refetchTickets();
    }
  }, [tickets, refetchTickets]);

  return {
    slip, tickets: tickets ?? [], ticketsLoading, ticketsError, refetchTickets,
    addLeg, isInSlip, removeLeg, updateOdds, clearSlip, saveTicket, deleteTicket, clearTickets
  };
}
