/**
 * Saved MLB prop slips (My Picks -> Saved Slips) — durable server-side
 * storage for the tickets a user has actually committed to, replacing the
 * localStorage-only version that split across browsers/devices. See
 * server/migrations/018_saved_prop_tickets.js for why this table exists and
 * what stays client-side (the in-progress slip).
 *
 * Grading, odds math and filtering all stay client-side exactly as before
 * (client/src/pages/props/lib.ts) — this route only persists the Ticket shape
 * the client already builds, unchanged.
 */
import { Router } from 'express';
import { rows, row, run } from '../db/index.js';

const r = Router();

function toTicket(t) {
  return {
    id: t.id,
    savedAt: t.saved_at,
    legs: JSON.parse(t.legs_json),
    totalAmericanOdds: t.total_american_odds,
    totalDecimalOdds: t.total_decimal_odds
  };
}

r.get('/', (req, res, next) => {
  try {
    res.json(rows('SELECT * FROM saved_prop_tickets ORDER BY saved_at DESC').map(toTicket));
  } catch (e) { next(e); }
});

r.post('/', (req, res, next) => {
  try {
    const { id, savedAt, legs, totalAmericanOdds, totalDecimalOdds } = req.body ?? {};
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id is required' });
    if (!Array.isArray(legs) || !legs.length) return res.status(400).json({ error: 'at least one leg is required' });

    run(`INSERT INTO saved_prop_tickets (id, saved_at, legs_json, total_american_odds, total_decimal_odds)
         VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET saved_at = excluded.saved_at, legs_json = excluded.legs_json,
           total_american_odds = excluded.total_american_odds, total_decimal_odds = excluded.total_decimal_odds`,
      id, savedAt ?? new Date().toISOString(), JSON.stringify(legs),
      totalAmericanOdds ?? null, totalDecimalOdds ?? null);

    res.json(toTicket(row('SELECT * FROM saved_prop_tickets WHERE id = ?', id)));
  } catch (e) { next(e); }
});

r.delete('/:id', (req, res, next) => {
  try {
    run('DELETE FROM saved_prop_tickets WHERE id = ?', req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
