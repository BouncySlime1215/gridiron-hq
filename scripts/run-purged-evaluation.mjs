#!/usr/bin/env node
/**
 * Giant Plan Step 2 VALIDATE: backfills the real historical trial registry
 * (scripts/backfill-historical-trial-registry.mjs) into a fresh scratch
 * database, then reports the effective trial count (Geyer autocorrelation-
 * time correction), the deflated Sharpe ratio, and the probability of
 * backtest overfitting (CSCV) computed from that REAL history.
 *
 * SAFETY: this script only ever creates/uses a scratch database under a temp
 * directory (enforced by backfill-historical-trial-registry.mjs itself) and
 * reads server/data.sqlite read-only (also enforced inside that script).
 */
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveOutDir, assertEvidenceSources, writeEvidenceReport } from './lib/evidence-report.mjs';

const scratchDb = process.env.GRIDIRON_DB_PATH || path.join(os.tmpdir(), `gridiron-trial-registry-${Date.now()}.sqlite`);
console.error(`[1/4] Backfilling the real trial registry into ${scratchDb} ...`);
execFileSync(process.execPath, [path.join(import.meta.dirname, 'backfill-historical-trial-registry.mjs')],
  { env: { ...process.env, GRIDIRON_DB_PATH: scratchDb, SCHEDULER_DISABLED: '1' }, stdio: 'inherit' });

process.env.GRIDIRON_DB_PATH = scratchDb;
const { db } = await import('../server/db/index.js');
const { listTrials } = await import('../server/services/research-trials.js');
const {
  effectiveTrialCount, deflatedSharpeRatio, reconstructBetReturns, sharpeStatsFromReturns,
  probabilityOfBacktestOverfitting,
} = await import('../server/services/trial-statistics.js');

console.error('[2/4] Loading the backfilled trial history ...');
const all = listTrials(); // every declared+scored trial, chronological by declared_at

/* ---------------------------------------------------- Step 2c inputs --
 * A single, documented normalization turning every scored trial's
 * heterogeneous metric into one comparable "standardized effect" (positive
 * = the direction that would argue for real edge), purely so the Geyer
 * estimator has ONE numeric sequence to compute a serial-correlation
 * structure over. This value is NEVER used as a Sharpe ratio -- that
 * computation (below) is scoped separately, only to trials with a genuine
 * bet-ledger (bets/wins/losses/units), because a Sharpe ratio computed on a
 * calibration-error delta would be a category error.
 */
function standardizedEffect(t) {
  const v = t.value;
  if (v == null || !Number.isFinite(v)) return null;
  const m = t.metric ?? '';
  if (/win_rate|_rate$/.test(m)) return v - 0.5; // distance from a coin flip
  if (/roi/.test(m)) return v; // already centered at 0
  if (/margin_mae_delta|cover_brier_delta/.test(m)) return -v; // lower error is better -> flip sign
  if (m === 'expected_calibration_error') return -v;
  if (m === 'abs_total_gap' || m === 'abs_p90_gap_pass') return -v;
  if (m === 'skill_score') return v;
  return null;
}

const scoredChrono = all.filter(t => t.status === 'scored' && t.value != null)
  .sort((a, b) => (a.scored_at < b.scored_at ? -1 : a.scored_at > b.scored_at ? 1 : 0));
const sequence = scoredChrono.map(standardizedEffect).filter(Number.isFinite);

console.error(`[3/4] Computing the effective trial count over ${sequence.length} real, chronologically-ordered scored trials ...`);
const effN = effectiveTrialCount(sequence);

/* ---------------------------------------------------- Step 2d inputs --
 * The genuine bet-ledger universe: every trial that carries real
 * bets/wins/losses/units (Group C's 11 candidate-variant scoring events,
 * plus the 2 audit_registry win-rate hypotheses with a known real sample --
 * row 1's 84-game simulator ATS test, and row 14's real 33-24 held-out
 * result, per WORK_LOG's own text -- assuming this project's own standard
 * -110 pricing convention, since neither table persists the exact per-bet
 * price). Every other real trial (CLV-rate tests, calibration error,
 * margin-MAE ablations) answers a real question but has no wagering P&L
 * attached to it, so a "Sharpe ratio" does not apply to it -- scoping the
 * DSR calculation to trials where it actually means something, rather than
 * computing a number that looks precise but is not meaningful.
 */
const betLedgerTrials = [];
for (const t of all) {
  if (t.kind === 'candidate_input_audit' && t.detail?.combined_all_inputs_overall) {
    const o = t.detail.combined_all_inputs_overall;
    betLedgerTrials.push({ id: t.identity_hash, label: t.detail.candidate_id, ...o });
  } else if (t.kind === 'candidate_robustness_audit' && t.detail?.candidate) {
    const o = t.detail.candidate;
    betLedgerTrials.push({ id: t.identity_hash, label: t.detail.candidate_id, ...o });
  }
}
/* Counted BEFORE the two constants below join the array. Everything after this
 * line is a literal in this file, so this is the only number that says whether
 * the registry read actually returned anything -- and it is the number the
 * guard requires. Without it the two constants alone carry an empty run all the
 * way to a written report and exit 0.
 */
const dbDerivedBetLedgerTrials = betLedgerTrials.length;

// The two audit_registry win-rate hypotheses with a real, known sample size / bet split.
betLedgerTrials.push({ id: 'audit_registry#1', label: 'simulator beats closing line ATS',
  bets: 84, wins: 36, losses: 48, units: 36 * (100 / 110) - 48, roi: null, assumed_pricing: '-110 (not persisted; this project\'s own standard convention)' });
betLedgerTrials.push({ id: 'audit_registry#14', label: 'football-first beats the closing spread (33-24 per WORK_LOG)',
  bets: 57, wins: 33, losses: 24, units: 33 * (100 / 110) - 24, roi: null, assumed_pricing: '-110 (not persisted; WORK_LOG text gives the 33-24 split)' });

const sharpeByTrial = betLedgerTrials.map(t => {
  const rec = reconstructBetReturns(t);
  const stats = rec ? sharpeStatsFromReturns(rec.returns) : null;
  return { ...t, sharpe: stats?.sharpe ?? null, n: stats?.n ?? null, skewness: stats?.skewness ?? null, kurtosis: stats?.kurtosis ?? null };
}).filter(t => Number.isFinite(t.sharpe));

/* Every real source this run read, with its row count, and which of them must
 * be non-empty for the numbers below to mean anything. Asserted HERE, before
 * the reduce two lines down: with an empty cross-section that reduce throws
 * `Reduce of empty array with no initial value`, which names no cause, and
 * with a cross-section made only of the two constants it throws nothing at all.
 *
 * `constant_bet_ledger_trials` is recorded and deliberately NOT required: it
 * counts literals in this file, which are always present, so requiring it would
 * assert nothing and would fire on a correct run. The same goes for
 * `pbo_strategies_constant`, added at write time below because PBO_STRATEGIES
 * is not declared until after this point.
 */
const SOURCES = {
  trial_registry_rows_read: all.length,
  scored_trials_read: scoredChrono.length,
  standardized_effect_sequence_length: sequence.length,
  db_derived_bet_ledger_trials: dbDerivedBetLedgerTrials,
  constant_bet_ledger_trials: betLedgerTrials.length - dbDerivedBetLedgerTrials,
  sharpe_cross_section_trials: sharpeByTrial.length,
};
const REQUIRED_SOURCES = [
  'trial_registry_rows_read', 'scored_trials_read', 'standardized_effect_sequence_length',
  'db_derived_bet_ledger_trials', 'sharpe_cross_section_trials',
];
assertEvidenceSources(SOURCES, REQUIRED_SOURCES, 'purged-evaluation-report.json');

const sharpeValues = sharpeByTrial.map(t => t.sharpe);
const sharpeMean = sharpeValues.reduce((s, v) => s + v, 0) / sharpeValues.length;
const sharpeStdAcrossTrials = Math.sqrt(sharpeValues.reduce((s, v) => s + (v - sharpeMean) ** 2, 0) / Math.max(1, sharpeValues.length - 1));

const best = sharpeByTrial.reduce((a, b) => (b.sharpe > a.sharpe ? b : a));
console.error(`[4/4] Best observed Sharpe among ${sharpeByTrial.length} real bet-ledger trials: ` +
  `${best.label} (sharpe=${best.sharpe.toFixed(4)}, n=${best.n}). Computing DSR and PBO ...`);

const dsr = deflatedSharpeRatio({
  sharpe: best.sharpe, n: best.n, skewness: best.skewness, kurtosis: best.kurtosis,
  nTrialsEffective: effN.n_effective, sharpeStdAcrossTrials,
});

/* ------------------------------------------------------------- PBO ---
 * Real per-season (2022-2025) ROI series for 4 real strategies, taken
 * directly from nfl_candidate_input_audits (read-only source, values
 * transcribed in backfill-historical-trial-registry.mjs's Group C comments
 * and verified against the live database during this stage's investigation):
 * the champion-only baseline policy, and the "combined" (candidate-inputs-
 * included) result for each of the three real candidate_ids tried in
 * sequence. Genuinely real numbers; genuinely small (4 periods) -- reported
 * as a small-sample demonstration on real data, not a high-power estimate.
 */
const PBO_STRATEGIES = [
  { id: 'champion-inputs-baseline', periods: [0.027, -0.064, 0.057, 0.005] },
  { id: 'unified-all-inputs-v1', periods: [0.151, 0.032, -0.011, -0.003] },
  { id: 'unified-all-inputs-v2-roster', periods: [0.151, 0.032, -0.011, -0.007] },
  { id: 'unified-all-inputs-v3-isolated-roster', periods: [0.151, 0.032, -0.011, -0.007] },
];
const pbo = probabilityOfBacktestOverfitting(PBO_STRATEGIES, { subsets: 4 });

const report = {
  generated_at: new Date().toISOString(),
  registry_summary: {
    total_trials_registered: all.length,
    scored: all.filter(t => t.status === 'scored').length,
    declared_pending: all.filter(t => t.status === 'declared').length,
    void_or_error: all.filter(t => ['void', 'error'].includes(t.status)).length,
    by_kind: Object.fromEntries([...new Set(all.map(t => t.kind))].map(k => [k, all.filter(t => t.kind === k).length])),
  },
  effective_trial_count: effN,
  deflated_sharpe_ratio: {
    ...dsr,
    best_observed_trial: { label: best.label, sharpe: best.sharpe, n: best.n, skewness: best.skewness, kurtosis: best.kurtosis },
    sharpe_cross_section: { n_trials: sharpeByTrial.length, mean: sharpeMean, std: sharpeStdAcrossTrials,
      trials: sharpeByTrial.map(t => ({ label: t.label, sharpe: +t.sharpe.toFixed(4), n: t.n })) },
  },
  probability_of_backtest_overfitting: pbo,
  honest_gaps: [
    'The individual per-component observed statistic behind "0 of 21 models beat the closing line" ' +
      '(commit 73f930f, 2026-08-27) does not survive anywhere in the repo, git history, or server/data.sqlite ' +
      '-- only the aggregate finding does. Each of the 21 components is registered with a real family-level ' +
      'ablation-delta proxy (docs/evidence/2026-09-10/family-contribution-2021-2025.json), flagged ' +
      '`individual_value_reconstructable: false`, and EXCLUDED from the Sharpe cross-section (no bet ledger).',
    'Segment/bucket combinations that fell below nfl-replay.js\'s minBets threshold (25, or 30 from the ' +
      'season-end orchestrator) in any specific historical run are never logged by analyzeErrors() and cannot ' +
      'be reconstructed. The search space and threshold rule are registered (real, from source); individual ' +
      'dropped attempts are not.',
    'The PBO/CSCV calculation uses a real but small (4-period, 4-strategy) matrix -- the only real, ' +
      'same-window, multi-strategy per-period series this project\'s surviving evidence provides. Treat it as ' +
      'a demonstration on genuine data, not a high-power estimate. Its low PBO here is mechanical, not strong ' +
      'robustness evidence: three of the four strategies (v1/v2-roster/v3-isolated-roster) are near-duplicates ' +
      'of each other and all dominate the fourth (the champion-only baseline) in most periods, so the IS-best ' +
      'is almost always also above the OOS median regardless of genuine skill. A real PBO estimate needs more, ' +
      'genuinely distinct strategies and more periods than survive in this project\'s evidence.',
    'audit_registry rows 1 and 14 do not persist real per-bet prices; both are treated at this project\'s own ' +
      'standard -110 convention (the same convention its own break-even thresholds, e.g. 0.5238, assume).',
  ],
};

const ROOT = path.join(import.meta.dirname, '..');
const outDir = resolveOutDir(process.argv,
  path.join(ROOT, 'docs', 'evidence', '2026-09-13'), ROOT);

// Re-asserted on the write path, not only above, so the guard cannot be
// bypassed by a later edit that computes the report some other way.
const { file, report: written } = writeEvidenceReport({
  outDir, filename: 'purged-evaluation-report.json',
  report,
  sources: { ...SOURCES, pbo_strategies_constant: PBO_STRATEGIES.length },
  required: REQUIRED_SOURCES,
});
console.error(`Wrote ${file}`);
console.log(JSON.stringify(written, null, 2));

db.close();
