/**
 * Beat-the-dumb-baseline gates (plan item C12). Read-only: every gate is computed by
 * its weekly scheduler job, off the request thread, and stored in model_gate_audits;
 * a request only reads the latest stored result.
 *
 *   GET /api/gates/start-sit   our served projection vs ESPN's weekly projection (the plan's
 *                              rule), with "start the higher season average" as a floor check
 *                              (services/gates/start-sit-gate.js, job start_sit_gate)
 */
import { Router } from 'express';
import { latestStartSitGate } from '../services/gates/start-sit-gate.js';

const r = Router();

r.get('/start-sit', (req, res, next) => {
  try {
    res.json(latestStartSitGate());
  } catch (error) {
    next(error);
  }
});

export default r;
