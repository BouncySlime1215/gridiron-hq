import { Router } from 'express';
import { commandCenter } from '../services/command-center.js';

const r = Router();
r.get('/', async (req, res, next) => {
  try { res.json(await commandCenter(req.auth?.userId)); } catch (e) { next(e); }
});
export default r;
