#!/usr/bin/env node
/**
 * Giant Plan Step 2e -- Stage 3 of the 2026-09-12 historical-verdict sweep.
 *
 * One common-universe leaderboard, built on stage 1's corrected inputs
 * (docs/evidence/historical/STAGE_1_RESULTS.md) and stage 2's protocol
 * (purged walk-forward, Geyer effective-N, deflated Sharpe, CSCV/PBO --
 * docs/evidence/2026-09-13/STAGE_2_PURGED_EVALUATION.md).
 *
 * Two things this script does that run-purged-evaluation.mjs (stage 2) did
 * not:
 *
 *   1. GENERIC bet-ledger extraction. Stage 2's `betLedgerTrials` hand-
 *      transcribed 2 of the 5 real audit_registry rows that actually carry
 *      a reconstructable bet ledger (ids 1 and 14) from WORK_LOG prose,
 *      leaving out ids 9, 13 and 15 -- all three real, sealed, and all
 *      three losing or non-significant. Read directly here (read-only)
 *      from the real audit_registry.detail_json column, generically, for
 *      every row shaped like a bet ledger (bets/wins/losses, or a
 *      "record": "W-L" string), rather than a hand-picked subset. Id 15 in
 *      particular is the SAME football-first hypothesis as id 14, tested on
 *      its full five-season sample rather than the two-season subset id 14
 *      reports -- and it loses (48.35%, z=-1.256) where id 14 nominally
 *      won (57.89%, z=0.834). That pair is kept in this leaderboard exactly
 *      because it is the clearest real illustration in this project's own
 *      history of what the deflated-Sharpe correction below exists to
 *      catch: the best-looking real result was an early, partial look.
 *
 *   2. Everything else item 17/18/is_market_identity need: is_market_identity
 *      reproduced independently against real nfl_ensemble_fit_artifacts, the
 *      real production decision board's real record, the real execution/
 *      teaser/shadow census, and the declared CLV reference-book set.
 *
 * SAFETY: server/data.sqlite is opened ONLY with `{ readOnly: true }`
 * (readReal(), copied unchanged from backfill-historical-trial-registry.mjs).
 * All writes go to a fresh scratch database under a temp directory --
 * enforced by that same script, reused here unchanged for the registry
 * backfill step.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const REAL_DB_PATH = process.env.GRIDIRON_REAL_DB_PATH
  || new URL('../server/data.sqlite', import.meta.url).pathname;

function readReal(fn) {
  const db = new DatabaseSync(REAL_DB_PATH, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

const scratchDb = process.env.GRIDIRON_DB_PATH || path.join(os.tmpdir(), `gridiron-trial-registry-${Date.now()}.sqlite`);
console.error(`[1/6] Backfilling the real trial registry into ${scratchDb} (same registry stage 2 built) ...`);
execFileSync(process.execPath, [path.join(import.meta.dirname, 'backfill-historical-trial-registry.mjs')],
  { env: { ...process.env, GRIDIRON_DB_PATH: scratchDb, SCHEDULER_DISABLED: '1' }, stdio: 'inherit' });

process.env.GRIDIRON_DB_PATH = scratchDb;
const { db } = await import('../server/db/index.js');
const { listTrials } = await import('../server/services/research-trials.js');
const {
  effectiveTrialCount, deflatedSharpeRatio, reconstructBetReturns, sharpeStatsFromReturns,
  probabilityOfBacktestOverfitting,
} = await import('../server/services/trial-statistics.js');
const { referenceBookQuotes } = await import('../server/services/clv-core.js');

const all = listTrials();

/* ---------------------------------------------------------- Geyer n_eff --
 * Unchanged from stage 2: this is a registry-wide serial-correlation
 * estimate, not scoped to the bet-ledger subset, so adding bet-ledger rows
 * to the Sharpe cross-section below does not change it.
 */
function standardizedEffect(t) {
  const v = t.value;
  if (v == null || !Number.isFinite(v)) return null;
  const m = t.metric ?? '';
  if (/win_rate|_rate$/.test(m)) return v - 0.5;
  if (/roi/.test(m)) return v;
  if (/margin_mae_delta|cover_brier_delta/.test(m)) return -v;
  if (m === 'expected_calibration_error') return -v;
  if (m === 'abs_total_gap' || m === 'abs_p90_gap_pass') return -v;
  if (m === 'skill_score') return v;
  return null;
}
const scoredChrono = all.filter(t => t.status === 'scored' && t.value != null)
  .sort((a, b) => (a.scored_at < b.scored_at ? -1 : a.scored_at > b.scored_at ? 1 : 0));
const sequence = scoredChrono.map(standardizedEffect).filter(Number.isFinite);
console.error(`[2/6] Effective trial count over ${sequence.length} real, chronologically-ordered scored trials ...`);
const effN = effectiveTrialCount(sequence);

/* ---------------------------------------------------- full bet-ledger set
 * Group C (candidate-variant scoring events) -- identical to stage 2.
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

// Group D, GENERIC: every real audit_registry row whose OWN detail_json is
// shaped like a bet ledger, read directly from the live table -- not a
// hand-picked subset. Two real shapes exist: {bets,wins,losses} directly,
// or {record:"W-L"} (audit #9). Anything else (calibration checks,
// win-rate-vs-median-book deltas with no raw bet count, void rows) is
// correctly excluded: a Sharpe ratio needs a reconstructable per-bet
// series, and these two shapes are the only real ones that provide one.
readReal(rdb => {
  for (const r of rdb.prepare(`SELECT id, name, detail_json FROM audit_registry ORDER BY id`).all()) {
    if (!r.detail_json) continue;
    let d; try { d = JSON.parse(r.detail_json); } catch { continue; }
    let bets = d.bets, wins = d.wins, losses = d.losses;
    if (bets == null && typeof d.record === 'string') {
      const m = /^(\d+)-(\d+)$/.exec(d.record.trim());
      if (m) { wins = +m[1]; losses = +m[2]; bets = wins + losses; }
    }
    if (!(bets > 0) || !Number.isFinite(wins) || !Number.isFinite(losses)) continue;
    const units = wins * (100 / 110) - losses; // this project's own standard -110 convention; real prices not persisted
    betLedgerTrials.push({
      id: `audit_registry#${r.id}`, label: `${r.name} (real: ${wins}-${losses}, audit_registry#${r.id})`,
      bets, wins, losses, units, roi: null,
      assumed_pricing: '-110 (not persisted by audit_registry; this project\'s own standard staking convention)',
    });
  }
});

const sharpeByTrial = betLedgerTrials.map(t => {
  const rec = reconstructBetReturns(t);
  const stats = rec ? sharpeStatsFromReturns(rec.returns) : null;
  return { ...t, sharpe: stats?.sharpe ?? null, n: stats?.n ?? null, skewness: stats?.skewness ?? null, kurtosis: stats?.kurtosis ?? null };
}).filter(t => Number.isFinite(t.sharpe));

const sharpeValues = sharpeByTrial.map(t => t.sharpe);
const sharpeMean = sharpeValues.reduce((s, v) => s + v, 0) / sharpeValues.length;
const sharpeStdAcrossTrials = Math.sqrt(sharpeValues.reduce((s, v) => s + (v - sharpeMean) ** 2, 0) / Math.max(1, sharpeValues.length - 1));
const best = sharpeByTrial.reduce((a, b) => (b.sharpe > a.sharpe ? b : a));
console.error(`[3/6] Best observed Sharpe among ${sharpeByTrial.length} real bet-ledger trials (was ${sharpeByTrial.length - 3} in stage 2): ` +
  `${best.label} (sharpe=${best.sharpe.toFixed(4)}, n=${best.n})`);

const dsr = deflatedSharpeRatio({
  sharpe: best.sharpe, n: best.n, skewness: best.skewness, kurtosis: best.kurtosis,
  nTrialsEffective: effN.n_effective, sharpeStdAcrossTrials,
});

// PBO -- identical real 4x4 matrix as stage 2; unaffected by the bet-ledger
// cross-section expansion above (different source table).
const PBO_STRATEGIES = [
  { id: 'champion-inputs-baseline', periods: [0.027, -0.064, 0.057, 0.005] },
  { id: 'unified-all-inputs-v1', periods: [0.151, 0.032, -0.011, -0.003] },
  { id: 'unified-all-inputs-v2-roster', periods: [0.151, 0.032, -0.011, -0.007] },
  { id: 'unified-all-inputs-v3-isolated-roster', periods: [0.151, 0.032, -0.011, -0.007] },
];
const pbo = probabilityOfBacktestOverfitting(PBO_STRATEGIES, { subsets: 4 });

/* ------------------------------------------------------- is_market_identity
 * Reproduced directly against real data, independent of u2's own branch
 * (not yet merged into this worktree): across EVERY real ensemble fit
 * artifact ever persisted, how many component-cutoff rows ever passed the
 * residual gate. market_residual's is_market_identity is true, by
 * construction, exactly when a cutoff has zero gate-passing components.
 */
console.error('[4/6] Reproducing is_market_identity directly against real nfl_ensemble_fit_artifacts ...');
const marketIdentity = readReal(rdb => {
  const artifacts = rdb.prepare(`SELECT artifact_key, cutoff, result_json FROM nfl_ensemble_fit_artifacts`).all();
  let componentCutoffRows = 0, gatePassed = 0, nonzeroResidualWeight = 0, artifactsAllZero = 0;
  for (const a of artifacts) {
    let rj; try { rj = JSON.parse(a.result_json); } catch { continue; }
    const models = Array.isArray(rj.models) ? rj.models : [];
    let anyPass = false;
    for (const m of models) {
      componentCutoffRows++;
      if (m.residual_gate_passed === true) { gatePassed++; anyPass = true; }
      if (Number(m.residual_weight) > 0) nonzeroResidualWeight++;
    }
    if (!anyPass) artifactsAllZero++;
  }
  return {
    real_fit_artifacts: artifacts.length,
    component_cutoff_rows: componentCutoffRows,
    residual_gate_passed_count: gatePassed,
    nonzero_residual_weight_count: nonzeroResidualWeight,
    artifacts_with_zero_residual_components: artifactsAllZero,
    fraction_market_identity: artifacts.length ? +(artifactsAllZero / artifacts.length).toFixed(4) : null,
  };
});

// The real production decision board -- every row nfl_pick_decisions has
// ever recorded, from a live capture process, not a backtest.
const productionBoard = readReal(rdb => {
  const rows = rdb.prepare(`SELECT edge, eligible, abstention_reason FROM nfl_pick_decisions`).all();
  const eligible = rows.filter(r => r.eligible).length;
  const zeroEdge = rows.filter(r => Number(r.edge) === 0).length;
  const reasons = {};
  for (const r of rows) { const k = r.abstention_reason ?? '(eligible)'; reasons[k] = (reasons[k] ?? 0) + 1; }
  return { real_rows: rows.length, eligible, zero_edge: zeroEdge, abstention_reasons: reasons };
});

/* ------------------------------------------------------- execution census
 * Item 18. Every real ledger a genuine accepted or paper position would
 * live in, counted directly.
 */
console.error('[5/6] Real execution/teaser/shadow census (item 18) ...');
const executionCensus = readReal(rdb => {
  const count = table => rdb.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
  const teaserExecutions = rdb.prepare(`SELECT id, candidate_id, logged_at, mode, book, status, settled_at, profit_units FROM nfl_teaser_executions`).all();
  const shadow = rdb.prepare(`SELECT decision, result FROM shadow_decisions`).all();
  const shadowSettled = shadow.filter(s => s.result != null && s.result !== '');
  return {
    nfl_execution_opportunities: count('nfl_execution_opportunities'),
    nfl_execution_log: count('nfl_execution_log'),
    nfl_bet_log: count('nfl_bet_log'),
    nfl_replay_bets: count('nfl_replay_bets'),
    forward_picks: count('forward_picks'),
    nfl_teaser_executions: teaserExecutions,
    nfl_teaser_execution_legs: count('nfl_teaser_execution_legs'),
    nfl_teaser_price_ledger: count('nfl_teaser_price_ledger'),
    shadow_decisions_total: shadow.length,
    shadow_decisions_by_decision: shadow.reduce((a, s) => ((a[s.decision] = (a[s.decision] ?? 0) + 1), a), {}),
    shadow_decisions_settled: shadowSettled.length,
  };
});

/* --------------------------------------------------- item 17: book set --
 * Declare the CLV reference book set explicitly, using clv-core.js's own
 * mechanism (referenceBookQuotes), rather than leaving it implicit.
 */
console.error('[6/6] Item 17 -- declaring the CLV reference book set via clv-core.referenceBookQuotes() ...');
const bookDeclaration = readReal(rdb => {
  const books = rdb.prepare(`SELECT DISTINCT bookmaker_key FROM nfl_quote_tape ORDER BY bookmaker_key`).all().map(r => r.bookmaker_key);
  const executionBook = rdb.prepare(`SELECT book FROM nfl_teaser_executions ORDER BY id LIMIT 1`).get()?.book ?? null;
  const asQuotes = books.map(bookmaker_key => ({ bookmaker_key }));
  const reference = referenceBookQuotes(asQuotes, { executionBook }).map(q => q.bookmaker_key);
  return {
    full_tape_book_universe: books,
    execution_book_for_the_one_real_teaser_position: executionBook,
    declared_reference_book_set: reference,
    mechanism: 'clv-core.js#referenceBookQuotes(quotes, { executionBook }) -- excludes the accepted/execution book from the close reference set by default',
  };
});

/* ---------------------------------------------- item 18: archive book depth
 * Own explicit grouping (event_id, market) over nfl_line_snapshots -- the
 * real multi-book capture table the shopping board and execution pipeline
 * both read. Documented, reproducible; NOT claimed to reproduce any
 * differently-grouped figure computed elsewhere.
 */
const archiveDepth = readReal(rdb => {
  const rows = rdb.prepare(`
    SELECT event_id, market, commence_time, COUNT(DISTINCT book) bc,
           (julianday(MAX(captured_at)) - julianday(MIN(captured_at))) AS span_days
    FROM nfl_line_snapshots GROUP BY event_id, market
  `).all();
  const preSept = rows.filter(r => r.commence_time && r.commence_time < '2026-09-01');
  const summarize = set => ({
    total_groups: set.length,
    single_book_groups: set.filter(r => r.bc === 1).length,
    mean_span_days: set.length ? +(set.reduce((s, r) => s + (r.span_days || 0), 0) / set.length).toFixed(2) : null,
  });
  return { grouping: '(event_id, market) over nfl_line_snapshots', overall: summarize(rows), pre_september_2026: summarize(preSept) };
});

const report = {
  generated_at: new Date().toISOString(),
  registry_summary: {
    total_trials_registered: all.length,
    scored: all.filter(t => t.status === 'scored').length,
  },
  effective_trial_count: effN,
  deflated_sharpe_ratio: {
    ...dsr,
    best_observed_trial: { label: best.label, sharpe: best.sharpe, n: best.n },
    sharpe_cross_section: { n_trials: sharpeByTrial.length, mean: sharpeMean, std: sharpeStdAcrossTrials,
      trials: sharpeByTrial.map(t => ({ label: t.label, sharpe: +t.sharpe.toFixed(4), n: t.n })) },
  },
  probability_of_backtest_overfitting: pbo,
  is_market_identity: marketIdentity,
  production_decision_board: productionBoard,
  execution_census: executionCensus,
  clv_reference_book_declaration: bookDeclaration,
  archive_book_depth: archiveDepth,
};

const outDir = path.join(import.meta.dirname, '..', 'docs', 'evidence', '2026-09-13');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'historical-leaderboard-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

db.close();
