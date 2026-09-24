/**
 * EVAL-01 "Is the brain working?" — read-only.
 *
 *   GET /api/brain-report   the latest stored grader run (E1-E7 + E3-live), its
 *                           summary, and what the fallback rule does with it
 *
 * Nothing is computed here: the graders run in scripts/eval/run-graders.mjs
 * (refresh loop) and store rows in brain_report; this reads the latest run and
 * applies the pure rule to it.
 *
 * Default OFF (RULES.md §3, new served numbers ship behind a flag): on with
 * GRIDIRON_BRAIN_REPORT=1, or locally with preview mode.
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { latestReport } from '../services/eval/index.js';
import { brainReportRule, RISK_MODES } from '../services/eval/brain-rule.js';
import { previewUnconfirmed, previewFields } from '../services/preview-mode.js';

export const BRAIN_REPORT_FLAG = 'GRIDIRON_BRAIN_REPORT';
const OFF_REASON = 'EVAL-01 report card is default-off until the graders have run on live data';

const r = Router();

r.get('/', (req, res, next) => {
  try {
    const flagOn = process.env[BRAIN_REPORT_FLAG] === '1';
    const preview = !flagOn && previewUnconfirmed();
    if (!flagOn && !preview) return res.json({ enabled: false, reason: OFF_REASON });
    const report = latestReport(db);
    const now = new Date();
    res.json({
      enabled: true,
      ...(preview ? previewFields(OFF_REASON) : {}),
      report,
      fallback_if_all_in: brainReportRule({ requestedMode: RISK_MODES.ALL_IN, report, now }),
    });
  } catch (error) {
    next(error);
  }
});

export default r;
