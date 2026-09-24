import { Router } from 'express';
import { readNumberAudit } from '../services/number-audit.js';

const r = Router();

/**
 * BROKEN-01b: which numbers are broken for a league, read-only.
 *
 * Serves the `number_audit` rows the refresh loop writes (server/services/number-audit.js
 * #runNumberAudit, run from scripts/refresh-live-data.mjs). Nothing is computed here: no
 * simulation, no projection, no producer is called on the request thread. The Settings
 * "Number health" card and the nav dot read this.
 *
 * `?league_id=` narrows to one league (the app's own leagues.id); without it, every
 * league's rows. An id that is not a positive integer is a 400, not an empty list.
 */
r.get('/', (req, res, next) => {
  try {
    const raw = req.query.league_id;
    if (raw == null || raw === '') return res.json(readNumberAudit(null));
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'league_id must be a positive integer' });
    res.json(readNumberAudit(id));
  } catch (e) { next(e); }
});

export default r;
