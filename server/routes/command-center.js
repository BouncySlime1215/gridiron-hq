/**
 * GET /api/command-center — SK-01: this week's to-do list across every league
 * the signed-in user belongs to, sorted by deadline. Every number on it comes
 * from an existing producer; see server/services/command-center.js.
 */
import { Router } from 'express';
import { commandCenter } from '../services/command-center.js';

const r = Router();
r.get('/', async (req, res, next) => {
  try {
    res.json(await commandCenter(req.auth.userId));
  } catch (e) { next(e); }
});
export default r;
