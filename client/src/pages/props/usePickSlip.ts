import { useCallback, useEffect, useState } from 'react';
import {
  type Leg, type Ticket, loadSlip, saveSlipStorage, loadTickets, saveTicketsStorage,
  newId, cleanOdds, totalOdds, legKey
} from './lib';

/**
 * The pick slip and saved tickets, backed by localStorage — shared between the
 * Model Board (which only ever adds legs) and My Picks (which manages the full
 * slip and saved-ticket lifecycle). Both read fresh from storage on mount, which
 * is enough here since the two pages are never mounted at the same time.
 */
export function usePickSlip() {
  const [slip, setSlip] = useState<Leg[]>(() => loadSlip());
  const [tickets, setTickets] = useState<Ticket[]>(() => loadTickets());

  useEffect(() => saveSlipStorage(slip), [slip]);
  useEffect(() => saveTicketsStorage(tickets), [tickets]);

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
  const saveTicket = useCallback((): string | null => {
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
    setTickets(prev => [ticket, ...prev]);
    setSlip([]);
    return null;
  }, [slip]);

  const deleteTicket = useCallback((id: string) => {
    setTickets(prev => prev.filter(t => t.id !== id));
  }, []);

  const clearTickets = useCallback(() => setTickets([]), []);

  return { slip, tickets, addLeg, isInSlip, removeLeg, updateOdds, clearSlip, saveTicket, deleteTicket, clearTickets };
}
