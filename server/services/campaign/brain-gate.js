/**
 * FIX-05: the brain report and the number audit feed the War Room plan.
 *
 * The producer (scripts/campaign/produce-plans.mjs) reads the latest brain
 * report once per run and, for every league, runs EVAL-01's fallback rule
 * (eval/brain-rule.js#brainReportRule) on the requested risk mode BEFORE
 * planLeague. The plan is built on the effective mode, so the deck, the
 * playbook and destination.risk_mode all follow it.
 *
 * Coordinator ruling (INTEGRATION-CHECKS.md, #235's reading): a failing,
 * stale (>48 h), missing or errored report forces BALANCED with testing-tier
 * signals off, and SAFE is never raised. "We could not read the report" is
 * never "nothing is failing".
 *
 * brain_report is written in the War Room contract's shape (#238
 * plans-schema.js `brainReport`): { overall, checks[{id, name, bar, status,
 * result?, n?, as_of?}], blocks[], fell_back_to? }; each check's `result`
 * carries the grader's needs_text ("needs 40 more offers") while it waits.
 *
 * number_health is the league's number_audit rows (number-audit.js
 * #readNumberAudit) in the contract's shape ({ overall, broken, warn, ok,
 * checks[{check_id, status, title, detail?, cause?}] }), worst first, without
 * the raw producer values (those stay on GET /api/number-audit).
 *
 * No DB import here: number-audit.js opens the app DB on import, and the
 * contract fixture (test/fixtures/warroom-contract/make-producer-plans.mjs)
 * runs this gate with no DB. The producer passes readNumberAudit in.
 */
import { brainReportRule } from '../eval/brain-rule.js';
import { latestReport } from '../eval/index.js';
import { MODE_LABELS, tolerancesFor } from './modes.js';

export const CHECK_IDS = Object.freeze(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']);

const message = e => String(e?.message ?? e).slice(0, 300);

/** The latest stored report, or why it could not be read. Never a silent null on a fault. */
export function readBrainReport(database, { latest = latestReport } = {}) {
  try {
    return { report: latest(database), error: null };
  } catch (e) {
    return { report: null, error: message(e) };
  }
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = v => `${Math.round(v * 1000) / 10}`;

/** One check's result line: needs_text while it waits, else the metric and its interval. */
function resultText(c) {
  if (c.status === 'not_enough_data') return c.needs_text || 'not enough data yet';
  const m = num(c.metric);
  if (m == null) return c.status;
  const ci = num(c.ci_low) != null && num(c.ci_high) != null ? ` (95% CI ${c.ci_low} to ${c.ci_high})` : '';
  return `${c.metric_name ?? 'metric'} ${m}${ci}`;
}

/**
 * The contract's brain_report value. A card that is missing, stale or errored
 * is never shown as 'passing' overall: its checks are not a current grade.
 */
export function brainReportSection({ report, rule, error = null, requestedMode }) {
  const current = !!report && !error && !rule.blocking.some(b => b.check == null);
  // Shadow-only rows (LIVING-01b's re-gate, eval/living-gate.js) grade a unit that
  // serves nothing yet; they stay on GET /api/brain-report and out of the War Room.
  const rows = report && !error && Array.isArray(report.checks) ? report.checks.filter(c => c.detail?.shadow_only !== true) : [];
  const checks = rows.length
    ? rows.map(c => ({
      id: String(c.check), name: c.name || String(c.check), bar: c.pass_bar || 'not stated', status: c.status,
      result: resultText(c),
      ...(Number.isInteger(c.n) && c.n >= 0 ? { n: c.n } : {}),
      ...(report.computed_at ? { as_of: report.computed_at } : {}),
    }))
    : CHECK_IDS.map(id => ({ id, name: id, bar: 'not graded yet', status: 'not_run' }));
  const anyFailing = rows.some(c => c.status === 'failing');
  const allPassing = rows.length > 0 && rows.every(c => c.status === 'passing');
  const overall = anyFailing ? 'failing' : allPassing && current ? 'passing' : 'not_enough_data';

  const blocks = rule.blocking.map(b => b.reason);
  if (rule.fell_back) {
    blocks.push(`You asked for ${MODE_LABELS[requestedMode]}; the plan runs ${MODE_LABELS[rule.mode]} until the report card is current and nothing fails.`);
  }
  if (!rule.testing_tier_enabled && (requestedMode === 'all_in' || rule.mode === 'all_in')) {
    blocks.push('Testing-tier signals are off.');
  }
  const e1 = rows.find(c => c.check === 'E1');
  if (!e1 || e1.status !== 'passing' || !current) blocks.push('Until E1 passes, every "chance he says yes" is a guess.');

  return { overall, checks, blocks, ...(rule.fell_back ? { fell_back_to: 'balanced' } : {}) };
}

/**
 * Gate one league's objective on the report. Returns the objective to plan on
 * (effective mode; Balanced's own sliders when it fell back), the rule's
 * verdict and the brain_report section value.
 */
export function applyBrainReport({ objective, report, error = null, now }) {
  const requestedMode = objective.risk_mode;
  const rule = brainReportRule({ requestedMode, report: error ? null : report, now });
  if (error) {
    rule.blocking = [{ check: null, reason: `brain report could not be read: ${error}` }];
    rule.reason = `${rule.fell_back ? 'Fell back to' : 'Kept'} ${rule.mode}; testing-tier signals off: ${rule.blocking[0].reason}`;
  }
  const changed = rule.mode !== requestedMode;
  const effective = {
    ...objective,
    risk_mode: rule.mode,
    tolerances: changed ? tolerancesFor(rule.mode) : objective.tolerances,
    requested_risk_mode: requestedMode,
    testing_tier_enabled: rule.testing_tier_enabled,
  };
  return {
    objective: effective,
    rule,
    section: brainReportSection({ report, rule, error, requestedMode }),
    as_of: !error && report?.computed_at ? report.computed_at : null,
    run_id: !error ? report?.run_id ?? null : null,
  };
}

const HEALTH_OPTIONAL = ['detail', 'cause'];
const nonEmpty = v => typeof v === 'string' && v.trim() !== '';

/**
 * The league's number_health field parts: { status, value?, reason?, as_of? }.
 * unknown when the table or the league's rows do not exist yet; failed when
 * the read threw.
 */
export function readNumberHealth(database, leagueId, { read } = {}) {
  if (typeof read !== 'function') return { status: 'failed', reason: 'No number-audit reader was passed to the producer.' };
  let audit;
  try {
    audit = read(leagueId, { database });
  } catch (e) {
    return { status: 'failed', reason: `The number audit could not be read: ${message(e)}` };
  }
  if (audit.table_missing) {
    return { status: 'unknown', reason: 'The number audit is not built on this database yet (migration 077 has not run).' };
  }
  if (!audit.rows.length) {
    return { status: 'unknown', reason: 'The number audit has not run for this league yet.' };
  }
  return {
    status: 'ok',
    as_of: audit.as_of,
    // The contract's number_health value (plans-schema.js, FIX-03): worst row first.
    value: {
      overall: audit.broken > 0 ? 'broken' : audit.warn > 0 ? 'warn' : 'ok',
      broken: audit.broken, warn: audit.warn, ok: audit.ok,
      checks: audit.rows.map(r => ({
        check_id: String(r.check_id), status: r.status, title: nonEmpty(r.title) ? r.title : String(r.check_id),
        ...Object.fromEntries(HEALTH_OPTIONAL.filter(k => nonEmpty(r[k])).map(k => [k, r[k]])),
      })),
    },
  };
}
