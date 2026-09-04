/**
 * Decay watch — does an already-approved finding still work?
 *
 * audit-registry.js seals a finding on its first run by design: an audit
 * cannot be re-run once it has a status, because re-rolling a test until it
 * passes is p-hacking. That protects the APPROVAL. It does nothing about
 * what happens AFTER approval. A coordinator weight or a calibration gate
 * that cleared its gate in 2025 is not guaranteed to still be earning its
 * keep in 2026 — real predictors decay. McLean & Pontiff (2016, Journal of
 * Finance, "Does Academic Research Destroy Stock Return Predictability?")
 * tested 97 published return predictors and found returns 26% lower
 * out-of-sample and 58% lower post-publication than the original in-sample
 * estimate, with the decay worst for predictors that looked strongest
 * in-sample — crowding closes the gap fastest where it was most exploitable.
 * The sports-betting analogue is the same mechanism: Levitt (2004) and the
 * "visibility and inefficiency" literature (e.g. Springer 2023, J. Econ. &
 * Finance, on NFL line-movement visibility) find that once an inefficiency
 * becomes visible and widely bet, books reprice around it and the edge
 * shrinks. Nothing in this project checked for that until this file.
 *
 * This is NOT a second audit-registry. It never re-runs a sealed audit, never
 * reopens a preregistration, and never touches audit_registry's rows. It
 * watches a DIFFERENT, later thing: for a finding that already shipped (a
 * persisted fit — fantasy-coordinator.js's coordinator weights, nfl-prop-
 * calibration.js's active calibrator), it grades that exact frozen artifact
 * against data strictly AFTER the finding's own approval boundary (the last
 * season the fit was trained through) — data the fit could not have seen and
 * that did not exist yet when it was approved. That is a genuinely separate,
 * out-of-sample question: not "was this true once" (audit-registry's job,
 * answered once and sealed) but "is it still true" (this file's job, asked
 * again every time fresh data arrives).
 *
 * Asking that question repeatedly as new weeks/seasons land is exactly the
 * situation backtest-significance.js's always-valid p-value (mSPRT, Johari,
 * Pekelis & Walsh 2022) exists for: a sequence that keeps growing, checked
 * more than once, without inflating the false-positive rate the way
 * re-checking a fixed-N test at multiple sample sizes would. See
 * backtest-significance.js#alwaysValidPValue for the full derivation; this
 * file is its second real caller (audit-registry.js is the first) and reuses
 * it rather than inventing another significance test.
 *
 * Verdict, never action: `flag` only ever marks a finding for human review.
 * This module contains no code path that unpromotes a champion, disables a
 * coordinator, or reverts a calibrator. That decision belongs to a human (or
 * a future, separately-reviewed agent), exactly like nfl-model-watch.js's
 * "discovery loop can propose, it cannot approve" — this is the mirror image
 * for things already approved: it can flag, it cannot revert.
 */
import { db, rows, run } from '../db/index.js';
import { alwaysValidPValue } from './backtest-significance.js';

db.exec(`CREATE TABLE IF NOT EXISTS decay_watch_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_key TEXT NOT NULL,
  label TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  approved_at TEXT,
  status TEXT NOT NULL,
  flag INTEGER NOT NULL DEFAULT 0,
  n INTEGER,
  min_n INTEGER,
  mean_post_approval_effect REAL,
  p_always_valid REAL,
  reason TEXT,
  detail_json TEXT
)`);

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const currentSeason = () => Number(process.env.NFL_SEASON) || new Date().getFullYear();

/**
 * The persisted fantasy-coordinator fit (fantasy-coordinator.js), and the
 * fresh, strictly-post-approval player-weeks it has never seen: every season
 * after the one it was fit through. Building examples only for those seasons
 * (not the full 2022-2025 refit range) keeps this cheap relative to
 * refitFantasyCoordinator — it is grading the frozen fit, never refitting it.
 */
async function coordinatorPostApprovalSequence() {
  const fit = rows(`SELECT * FROM fantasy_coordinator_fits ORDER BY id DESC LIMIT 1`)[0];
  if (!fit) return { error: 'no fantasy coordinator fit has been approved yet' };
  const parsed = JSON.parse(fit.fit_json);
  if (!parsed?.ready) return { error: 'latest fantasy coordinator fit never reached ready:true' };
  const fromSeason = Number(fit.through_season) + 1;
  const through = currentSeason();
  if (fromSeason > through) {
    return { error: `no season after the approved fit's through_season (${fit.through_season}) exists yet`,
      approvedAt: fit.created_at };
  }
  const { buildFantasyCoordinatorExamples, coordinateFantasy } = await import('./fantasy-coordinator.js');
  const examples = await buildFantasyCoordinatorExamples({ fromSeason, throughSeason: through });
  const sequence = examples
    .filter(e => Number.isFinite(e.target))
    .map(e => {
      const baselineErr = Math.abs(e.target); // "predict zero correction" = plain structural projection
      const modelErr = Math.abs(e.target - coordinateFantasy(parsed, e.experts, 0).correction);
      return baselineErr - modelErr; // positive: coordinator still reduces error vs. the uncorrected baseline
    })
    .filter(Number.isFinite);
  return { approvedAt: fit.created_at, throughSeason: fit.through_season,
    postApprovalSeasons: [fromSeason, through], sequence };
}

/**
 * The persisted, active anytime-TD calibrator (nfl-prop-calibration.js), and
 * fresh player-props from every season after the one it was trained through
 * — rows that did not exist when the calibrator was selected and validated.
 * Applies the frozen model only; never refits, never reselects a head.
 */
async function calibrationPostApprovalSequence() {
  const fit = rows(`SELECT * FROM nfl_prop_calibration_fits
                     WHERE market='player_anytime_td' AND active=1
                     ORDER BY created_at DESC LIMIT 1`)[0];
  if (!fit) return { error: 'no anytime-TD calibrator has been approved yet' };
  const fromSeason = Number(fit.train_through) + 1;
  const through = currentSeason();
  if (fromSeason > through) {
    return { error: `no season after the approved fit's train_through (${fit.train_through}) exists yet`,
      approvedAt: fit.created_at };
  }
  const model = JSON.parse(fit.params_json);
  const { propReplayRows } = await import('./nfl-props.js');
  const { tdRows, applyTdCalibrator } = await import('./nfl-prop-calibration.js');
  const seasons = Array.from({ length: through - fromSeason + 1 }, (_, i) => fromSeason + i);
  const replay = propReplayRows(seasons, { useCache: false }).rows;
  const sequence = tdRows(replay).map(row => {
    const rawErr = (row.p - row.y) ** 2;
    const calErr = (applyTdCalibrator(model, row.p, row) - row.y) ** 2;
    return rawErr - calErr; // positive: calibration still reduces Brier error vs. the raw probability
  }).filter(Number.isFinite);
  return { approvedAt: fit.created_at, trainThrough: fit.train_through,
    postApprovalSeasons: [fromSeason, through], sequence };
}

/**
 * Every approved finding this file watches. Adding a new one means adding a
 * `computeSequence` that returns fresh, strictly-post-approval per-unit
 * signed values (positive = the finding's own prediction: real advantage
 * over the pre-finding baseline) — never re-deriving the original approval.
 */
const FINDINGS = {
  fantasy_coordinator_weights: {
    label: 'Fantasy coordinator ensemble weights (fantasy-coordinator.js)',
    computeSequence: coordinatorPostApprovalSequence
  },
  nfl_td_calibration_gate: {
    label: 'NFL anytime-TD probability calibration gate (nfl-prop-calibration.js)',
    computeSequence: calibrationPostApprovalSequence
  }
};

/**
 * Classifies one finding's post-approval sequence.
 *
 * The original approval's prediction is that this sequence's true mean is
 * POSITIVE (the shipped thing beats the pre-finding baseline). Four outcomes:
 *
 *   insufficient_data — fewer than `minN` fresh, post-approval observations
 *     exist yet. Too early to say anything; not flagged.
 *   holding — mean is positive AND the always-valid test rejects "no effect"
 *     at this alpha. The edge is still there, confirmed on fresh data. Not
 *     flagged.
 *   reversed — mean is zero-or-negative AND the always-valid test rejects
 *     "no effect". Strong evidence the finding now actively HURTS relative
 *     to the pre-finding baseline. Flagged.
 *   decayed — at least `minN` fresh observations exist, but the always-valid
 *     test cannot distinguish this sequence's mean from zero. The originally
 *     -approved positive effect has not reproduced out-of-sample: it may be
 *     gone, or may just be smaller than the finding's own approval size
 *     enough to still need more data — either way, that ambiguity is itself
 *     the thing worth a human's attention, exactly the McLean & Pontiff
 *     shape (an in-sample edge shrinking toward noise once it is tested on
 *     data it never touched). Flagged.
 *
 * `flag` never changes anything; it is read by callers exactly like
 * nfl-model-watch.js's `alerts` — a review item, not an action.
 */
function assess(key, finding, seq, { minN, alpha } = {}) {
  const base = { finding_key: key, label: finding.label };
  if (seq?.error) {
    return { ...base, status: 'not_applicable', flag: false, approved_at: seq.approvedAt ?? null,
      reason: seq.error };
  }
  const n = seq.sequence.length;
  if (n < minN) {
    return { ...base, status: 'insufficient_data', flag: false, approved_at: seq.approvedAt, n, min_n: minN,
      reason: `only ${n} fresh post-approval observations (need ${minN}) — too early to judge` };
  }
  const av = alwaysValidPValue(seq.sequence);
  if (av.error) {
    return { ...base, status: 'insufficient_data', flag: false, approved_at: seq.approvedAt, n, min_n: minN,
      reason: av.error };
  }
  const significant = av.p_always_valid < alpha;
  const holding = significant && av.mean > 0;
  const reversed = significant && av.mean <= 0;
  const status = holding ? 'holding' : reversed ? 'reversed' : 'decayed';
  return {
    ...base, status, flag: status !== 'holding',
    approved_at: seq.approvedAt, n, min_n: minN,
    mean_post_approval_effect: r4(av.mean), p_always_valid: av.p_always_valid,
    sigma: av.sigma, tau: av.tau,
    reason: status === 'holding'
      ? `post-approval mean effect ${r4(av.mean)} over ${n} fresh observations, always-valid p=${av.p_always_valid} — the approved edge still holds`
      : status === 'reversed'
        ? `post-approval mean effect ${r4(av.mean)} over ${n} fresh observations, always-valid p=${av.p_always_valid} — significantly WORSE than the pre-finding baseline, not merely flat`
        : `post-approval mean effect ${r4(av.mean)} over ${n} fresh observations is not distinguishable from zero (always-valid p=${av.p_always_valid}) — the approved edge has not reproduced out-of-sample`
  };
}

function persist(outcome) {
  run(`INSERT INTO decay_watch_runs
       (finding_key, label, checked_at, approved_at, status, flag, n, min_n,
        mean_post_approval_effect, p_always_valid, reason, detail_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  outcome.finding_key, outcome.label, new Date().toISOString(), outcome.approved_at ?? null,
  outcome.status, outcome.flag ? 1 : 0, outcome.n ?? null, outcome.min_n ?? null,
  outcome.mean_post_approval_effect ?? null, outcome.p_always_valid ?? null,
  outcome.reason ?? null, JSON.stringify(outcome));
}

/**
 * Runs the decay check for every registered finding and persists each
 * result. Intended to be called on a schedule (see scheduler.js's
 * `decay_watch` job) — never inline on a request path, since building fresh
 * examples/replay rows is real compute, the same reason refits run in the
 * background elsewhere in this file's neighbors.
 */
export async function runDecayWatch({ minN = 30, alpha = 0.05, findings = FINDINGS } = {}) {
  const results = [];
  for (const [key, finding] of Object.entries(findings)) {
    let outcome;
    try {
      const seq = await finding.computeSequence();
      outcome = assess(key, finding, seq, { minN, alpha });
    } catch (e) {
      outcome = { finding_key: key, label: finding.label, status: 'error', flag: false, reason: e.message };
    }
    persist(outcome);
    results.push(outcome);
  }
  return {
    checked_at: new Date().toISOString(),
    findings: results,
    flagged: results.filter(r => r.flag).map(r => r.finding_key),
    policy: 'This is a monitor, not a corrector. A flagged finding is a review item for a human — ' +
      'nothing here unpromotes a model, reweights a coordinator, or reverts a calibrator.'
  };
}

/** Every recorded check, most recent first — the raw history behind the status view. */
export function decayWatchHistory(limit = 50) {
  return rows(`SELECT * FROM decay_watch_runs ORDER BY id DESC LIMIT ?`, limit)
    .map(r => ({ ...r, flag: !!r.flag, detail: JSON.parse(r.detail_json ?? 'null'), detail_json: undefined }));
}

/**
 * The current read: each finding's MOST RECENT check only, plus whether
 * anything needs a human right now. This is what a governance UI/API
 * consumer should actually poll — `decayWatchHistory` is the audit trail
 * behind it.
 */
export function decayWatchStatus({ findings = FINDINGS } = {}) {
  const latestPerFinding = [];
  for (const key of Object.keys(findings)) {
    const last = rows(`SELECT * FROM decay_watch_runs WHERE finding_key=? ORDER BY id DESC LIMIT 1`, key)[0];
    latestPerFinding.push(last
      ? { ...last, flag: !!last.flag, detail: JSON.parse(last.detail_json ?? 'null'), detail_json: undefined }
      : { finding_key: key, label: findings[key].label, status: 'never_checked', flag: false });
  }
  return {
    findings: latestPerFinding,
    needs_review: latestPerFinding.some(f => f.flag),
    flagged: latestPerFinding.filter(f => f.flag).map(f => f.finding_key),
    total_runs: rows(`SELECT COUNT(*) n FROM decay_watch_runs`)[0].n
  };
}
