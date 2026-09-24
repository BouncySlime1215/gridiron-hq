/**
 * EVAL-01 report card: run every grader, store one run in `brain_report`
 * (migration 078), read the latest run back.
 *
 * Run OFF the request thread only: scripts/eval/run-graders.mjs, a step of the
 * refresh loop (scripts/refresh-live-data.mjs). GET /api/brain-report only
 * reads the stored rows.
 *
 * A grader that throws does not take the others down and is not hidden: its row
 * is written as not_enough_data with detail.grader_error, the runner exits
 * non-zero, and brainReportRule treats that row as blocking (fail closed).
 */
import crypto from 'node:crypto';
import * as e1 from './e1.js';
import * as e2 from './e2.js';
import * as e3 from './e3.js';
import * as e4 from './e4-planner.js';   // FIX-294-1: E4 = planner vs simple baselines (historical + E4-live)
import * as e5 from './e5.js';
import * as e6 from './e6.js';
import * as e7 from './e7.js';
import * as e3espn from './e3-espn.js';
import { result, STATUS } from './common.js';

// FIX-322-1: E3-ESPN (week-7 title-odds replay on Nick's past ESPN seasons) runs with the report card,
// so the one brain_report producer stores it every run; its id is in plans-schema.js BRAIN_CHECK_IDS.
export const GRADERS = Object.freeze([e1, e2, e3, e4, e5, e6, e7, e3espn]);

export function runAll(database, opts = {}) {
  const out = [];
  const errors = [];
  for (const g of GRADERS) {
    try {
      const r = g.run(database, opts[g.CHECK] ?? {});
      out.push(...(Array.isArray(r) ? r : [r]));
    } catch (e) {
      const message = String(e?.message ?? e).slice(0, 300);
      errors.push({ check: g.CHECK, message });
      out.push(result({
        check: g.CHECK, name: g.NAME, status: STATUS.NOT_ENOUGH_DATA, metricName: 'grader_error',
        needsN: 1, needsUnit: 'runs', needsText: `grader could not run: ${message}`,
        passBar: 'grader must run', detail: { grader_error: message },
      }));
    }
  }
  return { results: out, errors };
}

export function writeReport(database, results, { now = new Date() } = {}) {
  const computedAt = now.toISOString();
  const runId = `${computedAt}-${crypto.randomBytes(3).toString('hex')}`;
  const ins = database.prepare(`INSERT INTO brain_report
    (run_id, computed_at, check_id, name, status, metric_name, metric, ci_low, ci_high, n,
     needs_n, needs_unit, needs_text, pass_bar, source, detail_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const r of results) {
      ins.run(runId, computedAt, r.check, r.name, r.status, r.metric_name, r.metric, r.ci_low, r.ci_high, r.n,
        r.needs_n, r.needs_unit, r.needs_text, r.pass_bar, r.source, JSON.stringify(r.detail ?? {}));
    }
    database.exec('COMMIT');
  } catch (e) {
    database.exec('ROLLBACK');
    throw e;
  }
  return { run_id: runId, computed_at: computedAt, rows: results.length };
}

/** The latest stored run, or null when the graders have never run. */
export function latestReport(database) {
  const last = database.prepare('SELECT run_id, computed_at FROM brain_report ORDER BY id DESC LIMIT 1').get();
  if (!last) return null;
  const checks = database.prepare('SELECT * FROM brain_report WHERE run_id = ? ORDER BY id').all(last.run_id).map(r => ({
    check: r.check_id, name: r.name, status: r.status, metric_name: r.metric_name, metric: r.metric,
    ci_low: r.ci_low, ci_high: r.ci_high, n: r.n, needs_n: r.needs_n, needs_unit: r.needs_unit,
    needs_text: r.needs_text, pass_bar: r.pass_bar, source: r.source, detail: JSON.parse(r.detail_json),
  }));
  const count = s => checks.filter(c => c.status === s).length;
  return {
    run_id: last.run_id, computed_at: last.computed_at, checks,
    summary: { passing: count(STATUS.PASSING), not_enough_data: count(STATUS.NOT_ENOUGH_DATA), failing: count(STATUS.FAILING) },
  };
}
