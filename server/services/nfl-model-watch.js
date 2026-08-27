/**
 * The automated evaluation loop — discover and report, never auto-promote.
 *
 * This is the self-improvement mechanism, built with the one property that
 * distinguishes a useful version from a dangerous one: **the loop can propose,
 * and it cannot approve.** Discovery is automated; the gate is not, and the
 * gate's thresholds do not live in anything this loop can reach.
 *
 * The reason is empirical, not philosophical. Across this model's evaluation
 * work, 564+ candidate/target combinations were tested and 9 of 11 serious
 * candidates were rejected. Two of them — age and injury — PASSED isolated
 * out-of-sample validation with clean confidence intervals and still degraded
 * the shipped pipeline when wired in, caught only by A/B ablation. A loop that
 * generated candidates, scored them, and shipped winners would have shipped
 * both, reported an improvement, and made the model worse.
 *
 * So the failure mode being designed against is specific: a system that
 * optimises against its own evaluation criteria will, given enough iterations,
 * discover that the cheapest route to a passing score is a weaker gate.
 * `MODEL_ROADMAP.md` §15 already states the rule this enforces — "the gates
 * must never be loosened to let a model through."
 *
 * Concretely:
 *   - this module imports the audits and calls them; it never defines a
 *     threshold, an alpha, or a promotion rule
 *   - it writes findings to a table, and nothing downstream reads that table
 *     to decide what ships
 *   - `production_eligible` is always false here, by construction
 *
 * What it is genuinely good for: catching drift. A model that quietly stops
 * beating its baseline, a calibrator that decays, a candidate that starts
 * clearing the bar as another season of data lands — those are all things a
 * human will not notice until they are looking, and this looks every day.
 */
import { db, rows, run } from '../db/index.js';
import { allBaselineGates, propAccuracy } from './nfl-props.js';
import { auditPropHeads, PROP_METRIC_CONFIG } from './nfl-prop-head-validation.js';
import { propEdgeEvidence } from './nfl-prop-clv.js';

db.exec(`CREATE TABLE IF NOT EXISTS nfl_model_watch_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT NOT NULL,
  seasons TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  alerts INTEGER NOT NULL DEFAULT 0
)`);

const SEASONS = [2022, 2023, 2024, 2025];

/**
 * One evaluation pass. Everything here is a read of an existing audit; no
 * thresholds are defined locally, so tightening or loosening a gate is a
 * deliberate edit to the audit that owns it, not a side effect of this loop.
 */
export function runModelWatch({ seasons = SEASONS, includeHeadSearch = true } = {}) {
  const findings = [], alerts = [];

  // 1. Do the shipped gates still pass? This is the drift check that matters
  //    most: the model beating its own baseline is the floor for everything.
  let gates = null;
  try {
    gates = allBaselineGates(seasons);
    for (const [metric, g] of Object.entries(gates)) {
      const finding = { check: 'baseline_gate', metric, n: g.n,
        model_mae: g.model_mae, baseline_mae: g.baseline_mae,
        ci90: g.bootstrap?.ci90, passes: g.gate_passes };
      findings.push(finding);
      if (!g.gate_passes) alerts.push(`REGRESSION: ${metric} no longer beats its season-to-date baseline (${g.verdict})`);
    }
  } catch (e) { alerts.push(`baseline gates failed to run: ${e.message}`); }

  // 2. Has any probability market fallen to or below zero skill? Negative skill
  //    means the market is actively worse than quoting its own base rate, which
  //    is a defect rather than a weak result — that is how the interception bug
  //    surfaced.
  try {
    const acc = propAccuracy(seasons);
    for (const [market, m] of Object.entries(acc.probability_metrics ?? {})) {
      findings.push({ check: 'probability_skill', market, n: m.n, brier: m.brier, skill: m.brier_skill });
      if (m.brier_skill != null && m.brier_skill < 0) {
        alerts.push(`NEGATIVE SKILL: ${market} scores ${m.brier_skill} — worse than quoting its base rate`);
      }
    }
    findings.push({ check: 'coverage', rate: acc.coverage?.rate, eligible: acc.coverage?.eligible });
    if ((acc.coverage?.rate ?? 1) < 0.95) {
      alerts.push(`COVERAGE DROP: identity coverage at ${acc.coverage.rate}, was 0.9734`);
    }
    // The shipped-vs-graded divergence that hid the calibration problem.
    const cal = acc.probability_calibration;
    findings.push({ check: 'calibration_parity', graded: cal?.graded,
      production_calibrates: cal?.production_applies_calibration });
    if (cal?.graded === 'raw' && cal?.production_applies_calibration) {
      findings.push({ check: 'known_divergence', note: 'audit grades raw; production calibrates. Known, documented, needs walk-forward grading to close.' });
    }
  } catch (e) { alerts.push(`accuracy pass failed to run: ${e.message}`); }

  // 3. Has any candidate head started clearing the bar as data accumulates?
  //    A candidate that fails today and passes next season is exactly what a
  //    daily loop is for — and it still only ever produces a proposal.
  if (includeHeadSearch) {
    for (const metric of Object.keys(PROP_METRIC_CONFIG)) {
      try {
        const audit = auditPropHeads(metric, { openValidation: false, persist: false });
        findings.push({ check: 'head_discovery', metric,
          tested: audit.candidates_tested, redundant: audit.candidates_redundant,
          survivors: audit.survivors });
        if (audit.survivors.length) {
          alerts.push(`PROPOSAL (needs human review, NOT promoted): ${metric} has surviving candidate(s) ${audit.survivors.join(', ')} — validation still sealed`);
        }
      } catch (e) { findings.push({ check: 'head_discovery', metric, error: e.message }); }
    }
  }

  // 4. Is there any betting evidence yet? Reports the absence honestly.
  try {
    const edge = propEdgeEvidence();
    findings.push({ check: 'prop_edge_evidence', status: edge.status,
      captured: edge.captured_quotes, settled: edge.settled_bets ?? 0,
      median_clv: edge.median_clv_cents ?? null });
  } catch (e) { findings.push({ check: 'prop_edge_evidence', error: e.message }); }

  const result = {
    ran_at: new Date().toISOString(),
    seasons,
    findings,
    alerts,
    production_eligible: false,
    policy: 'This loop proposes and reports. It cannot promote, and it defines no thresholds — ' +
      'every gate lives in the audit that owns it. A surviving candidate is a review item, ' +
      'never a shipped change.'
  };
  run(`INSERT INTO nfl_model_watch_runs (ran_at, seasons, findings_json, alerts)
       VALUES (?,?,?,?)`, result.ran_at, JSON.stringify(seasons), JSON.stringify(result), alerts.length);
  return result;
}

export function modelWatchHistory(limit = 20) {
  return rows(`SELECT id, ran_at, seasons, alerts, findings_json FROM nfl_model_watch_runs
               ORDER BY ran_at DESC LIMIT ?`, limit)
    .map(r => ({ id: r.id, ran_at: r.ran_at, seasons: JSON.parse(r.seasons),
      alert_count: r.alerts, result: JSON.parse(r.findings_json) }));
}

/** Most recent run, plus whether anything needs a human. */
export function modelWatchStatus() {
  const last = modelWatchHistory(1)[0] ?? null;
  return {
    last_run: last?.ran_at ?? null,
    alerts: last?.result?.alerts ?? [],
    needs_review: (last?.alert_count ?? 0) > 0,
    total_runs: rows(`SELECT COUNT(*) n FROM nfl_model_watch_runs`)[0].n
  };
}
