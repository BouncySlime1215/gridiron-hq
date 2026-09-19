#!/usr/bin/env node
/**
 * Giant Plan Step 2b: backfills `research_trials` (migration 038, detail
 * columns added in 046) with the REAL historical record of every spread-
 * model variant, family ablation, and candidate configuration this project
 * tried on the way to "zero edge against the closing line"
 * (docs/evidence/historical/path-to-profit-measurements.md).
 *
 * Every row below cites where it came from. Three real sources feed this:
 *
 *   1. GIT HISTORY -- the 21 component models actually in the spread
 *      ensemble at commit 73f930f (2026-08-27, "Find the spread edge in
 *      execution, not prediction"), the commit that first reports "21
 *      models against 15,096 closing lines, 0 clear the gate". Verified by
 *      checking out server/services/nfl-ensemble.js at that commit and
 *      counting MODELS entries: exactly 21. Their own git-blame introduction
 *      dates are real declared_at values.
 *
 *   2. server/data.sqlite, READ-ONLY -- audit_registry (15 real preregistered
 *      hypotheses), nfl_candidate_input_audits / nfl_candidate_robustness_audits
 *      (11 real scoring events across the unified-all-inputs-v1/v2-roster/
 *      v3-isolated-roster development sequence, including per-season splits),
 *      nfl_residual_audits (the market-residual ridge variant), and
 *      nfl_candidate_findings (the one live segment-search finding). This
 *      script only ever opens that file with `{ readOnly: true }` and never
 *      writes to it -- see readReal() below.
 *
 *   3. docs/evidence/2026-09-10/family-contribution-2021-2025.json -- the
 *      one real, already-computed run of the 5-family leave-one-out ablation
 *      (nfl-family-contribution.js), backed by nfl_feature_ablation_audits
 *      row 1 in the same real database.
 *
 * THE HONEST GAP: this project's own materiality-gate script that produced
 * "0 of 21 models beat the closing line" was never committed (or was deleted
 * during one of this project's documented handoff-doc consolidations -- see
 * WORK_LOG.md's repeated "Consolidate the per-conversation handoff documents"
 * entries), so the INDIVIDUAL per-component observed statistic behind that
 * aggregate finding does not survive anywhere in the repo, its git history,
 * or server/data.sqlite. Rather than fabricate 21 individual numbers, each
 * of the 21 rows below is scored with a REAL, but approximate, proxy: the
 * REAL family-level margin-MAE delta from the one ablation that WAS actually
 * run and persisted (source 3 above), on the reasoning that components
 * within a family draw on overlapping underlying data (EPA-based metrics,
 * the same rating-system inputs) and are genuinely correlated by
 * construction -- which is also exactly the kind of correlation the Geyer
 * autocorrelation-time correction in trial-statistics.js is built to detect
 * and discount. This is flagged in every one of those 21 rows' detail_json
 * as `individual_value_reconstructable: false`.
 *
 * Similarly: nfl-replay.js's `segmentsFor()` defines a real, large search
 * space (market/side/role/spread-size/edge-size/venue/weather/~178 rolling
 * team-stat leaderboard keys/injury/news dimensions) gated by a real
 * `minBets` threshold (25, or 30 from the season-end orchestrator) -- but
 * `analyzeErrors()` only ever returns segments that CLEAR every gate
 * (n>=minBets, Holm-corrected significance, minimum effect size); segments
 * that fail minBets are silently discarded and never logged anywhere. The
 * specific segment/bucket combinations dropped in any historical run are
 * therefore NOT reconstructable -- this script registers the search SPACE
 * and threshold rule (real, from source code) as one declared trial-cluster
 * with that gap stated explicitly, rather than inventing individual segment
 * rows with fabricated bet counts.
 *
 * SAFETY: refuses to run against anything that is not obviously a scratch
 * path under a temp directory. Never point GRIDIRON_DB_PATH at
 * server/data.sqlite when running this file.
 */
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REAL_DB_PATH = process.env.GRIDIRON_REAL_DB_PATH
  || new URL('../server/data.sqlite', import.meta.url).pathname;

const targetPath = process.env.GRIDIRON_DB_PATH
  || path.join(os.tmpdir(), `gridiron-trial-registry-${Date.now()}.sqlite`);
const resolved = path.resolve(targetPath);
const isScratch = resolved.startsWith(path.resolve(os.tmpdir())) || resolved.startsWith('/tmp') || resolved.startsWith('/private/tmp');
if (!isScratch) {
  console.error(`Refusing to run: ${resolved} is not under a temp directory.\n` +
    'This script backfills a scratch copy of the trial registry; it must never target server/data.sqlite.');
  process.exit(1);
}
process.env.GRIDIRON_DB_PATH = resolved;

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { declareTrial, scoreTrial } = await import('../server/services/research-trials.js');

const iso = gitDateWithOffset => new Date(gitDateWithOffset).toISOString();

/** Reads server/data.sqlite READ-ONLY. Never opened for write by this script. */
function readReal(fn) {
  const db = new DatabaseSync(REAL_DB_PATH, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

let declared = 0, scored = 0, alreadyExisted = 0;
function put(kind, key, { declaredAt, scoredAt, metric, value, status, detail, sourceRef }) {
  // A trial with a real scoredAt is always DECLARED first (value null) and
  // then SCORED as a separate step, mirroring audit-registry.js's own
  // preregister-then-run split even though both happen "now" for a
  // retrospective backfill. A trial with no scoredAt (still pending, or
  // void) is declared once, in its final status, and never scored.
  const initialStatus = scoredAt ? 'declared' : (status ?? 'declared');
  const d = declareTrial({ kind, key, declaredAt, metric, value: null, status: initialStatus, detail, sourceRef });
  if (d.already_existed) alreadyExisted++; else declared++;
  if (scoredAt) {
    scoreTrial(kind, key, { scoredAt, metric, value, status: status ?? 'scored', detail });
    scored++;
  }
}

/* ------------------------------------------------------------- Group A --
 * The 21 real spread-ensemble component models present at commit 73f930f
 * (2026-08-27), the commit documenting "21 models against 15,096 closing
 * lines, 0 clear the gate". declared_at = each model's real git-blame
 * introduction date; scored_at = the date that aggregate finding was
 * recorded. Value = the real family-level margin-MAE ablation delta
 * (source 3), used as an explicitly-flagged approximate proxy -- see the
 * file header for why an individual per-component number does not survive.
 */
const COMPONENT_INTRO_BULK = iso('2026-08-03T19:08:37-10:00'); // commit 605d6b2
const COMPONENT_INTRO_DYNAMIC_STATE = iso('2026-08-07T05:14:46-10:00'); // commit 00bc744
const MATERIALITY_GATE_DATE = iso('2026-08-27T12:23:23-04:00'); // commit 73f930f

// Real family-level margin_mae deltas, docs/evidence/2026-09-10/family-contribution-2021-2025.json,
// backed by nfl_feature_ablation_audits row 1 (created_at 2026-09-10 14:58:03).
const FAMILY_MARGIN_MAE_DELTA = {
  'Rating systems': -0.054,
  'Efficiency': -0.079,
  'Context': 0,
  'Market': 0.153,
};

const TWENTY_ONE_COMPONENTS = [
  ['massey', 'Massey least squares', 'Rating systems'],
  ['colley', 'Colley (wins only)', 'Rating systems'],
  ['pythagorean', 'Pythagenport expectation', 'Rating systems'],
  ['point_diff', 'Raw point differential', 'Rating systems'],
  ['melo', 'Margin-dependent Elo', 'Rating systems'],
  ['dynamic_state', 'Dynamic offense / defense state', 'Rating systems'],
  ['epa_net', 'Net EPA per play', 'Efficiency'],
  ['epa_neutral', 'EPA, garbage time removed', 'Efficiency'],
  ['success_rate', 'Success rate differential', 'Efficiency'],
  ['explosive', 'Explosive play differential', 'Efficiency'],
  ['drive_eff', 'Drive scoring differential', 'Efficiency'],
  ['situational', 'Third down and red zone', 'Efficiency'],
  ['trenches', 'Line of scrimmage', 'Efficiency'],
  ['turnover_regressed', 'Turnover-regressed margin', 'Efficiency'],
  ['opp_adjusted', 'Opponent-adjusted EPA', 'Efficiency'],
  ['recent_form', 'Recent form (last 3)', 'Context'],
  ['rest_travel', 'Rest and situation', 'Context'],
  ['pace_total', 'Pace and possessions', 'Context'],
  ['weather_total', 'Weather-adjusted total', 'Context'],
  ['market_anchor', 'Market anchor', 'Market'],
  ['market_regression', 'Market regression', 'Market'],
];

for (const [id, name, family] of TWENTY_ONE_COMPONENTS) {
  put('component_model_1of21', id, {
    declaredAt: id === 'dynamic_state' ? COMPONENT_INTRO_DYNAMIC_STATE : COMPONENT_INTRO_BULK,
    scoredAt: MATERIALITY_GATE_DATE,
    metric: 'margin_mae_delta_family_proxy',
    value: FAMILY_MARGIN_MAE_DELTA[family],
    detail: {
      model_id: id, name, family,
      real_aggregate_result: '0 of 21 spread component models cleared the materiality gate against ' +
        '15,096 real closing lines (commit 73f930f, 2026-08-27)',
      individual_value_reconstructable: false,
      proxy_used: `family-level margin_mae delta for '${family}' from the 2026-09-10 leave-one-family-out ablation`,
    },
    sourceRef: 'git:73f930fc91088a84ab5bab4176b1ebefdcc2971c;docs/evidence/2026-09-10/family-contribution-2021-2025.json',
  });
}

/* ------------------------------------------------------------- Group B --
 * The 5 real family-ablation configurations from the one run that actually
 * happened: docs/evidence/2026-09-10/family-contribution-2021-2025.json,
 * backed by nfl_feature_ablation_audits row 1.
 */
const FAMILY_ABLATION_RUN = iso('2026-09-10T14:58:03Z'); // nfl_feature_ablation_audits.created_at (UTC)
const FAMILY_ABLATIONS = [
  { family: 'Context', model_count: 4, margin_mae_delta: 0, cover_brier_delta: 0.001, roi_delta: 0.007, verdict: 'keep' },
  { family: 'Efficiency', model_count: 17, margin_mae_delta: -0.079, cover_brier_delta: -0.001, roi_delta: 0.123, verdict: 'simplify' },
  { family: 'Market', model_count: 2, margin_mae_delta: 0.153, cover_brier_delta: 0.003, roi_delta: 0.027, verdict: 'keep' },
  { family: 'Rating systems', model_count: 6, margin_mae_delta: -0.054, cover_brier_delta: -0.002, roi_delta: 0.013, verdict: 'simplify' },
  { family: 'Roster availability', model_count: 2, margin_mae_delta: 0.003, cover_brier_delta: 0, roi_delta: -0.01, verdict: 'keep' },
];
for (const f of FAMILY_ABLATIONS) {
  put('family_ablation', f.family, {
    declaredAt: FAMILY_ABLATION_RUN, scoredAt: FAMILY_ABLATION_RUN,
    metric: 'margin_mae_delta', value: f.margin_mae_delta,
    detail: { ...f, seasons: [2021, 2022, 2023, 2024, 2025], common_games: 1424,
      note: 'retrospective one-shot reconstruction from a real, already-run evidence artifact; not preregistered in advance' },
    sourceRef: 'docs/evidence/2026-09-10/family-contribution-2021-2025.json',
  });
}

/* ------------------------------------------------------------- Group C --
 * The real candidate-model-variant development sequence: unified-all-
 * inputs-v1 -> v2-roster -> v3-isolated-roster, each real scoring event from
 * nfl_candidate_input_audits / nfl_candidate_robustness_audits, read-only.
 */
readReal(db => {
  for (const r of db.prepare(`SELECT id, candidate_id, created_at, seasons_json, result_json FROM nfl_candidate_input_audits ORDER BY id`).all()) {
    const rj = JSON.parse(r.result_json);
    const ts = iso(r.created_at.endsWith('Z') ? r.created_at : `${r.created_at}Z`);
    put('candidate_input_audit', `${r.candidate_id}@input#${r.id}`, {
      declaredAt: ts, scoredAt: ts,
      metric: 'roi_delta_vs_champion_inputs', value: rj.delta?.roi ?? null,
      detail: { candidate_id: r.candidate_id, seasons: JSON.parse(r.seasons_json),
        champion_inputs_overall: rj.baseline?.overall, combined_all_inputs_overall: rj.combined?.overall,
        promotion_gate_passed: rj.promotion_gate_passed, verdict: rj.verdict,
        note: 'retrospective one-shot reconstruction; not preregistered in advance' },
      sourceRef: `server/data.sqlite:nfl_candidate_input_audits#${r.id}`,
    });
  }
  for (const r of db.prepare(`SELECT id, candidate_id, created_at, seasons_json, result_json FROM nfl_candidate_robustness_audits ORDER BY id`).all()) {
    const rj = JSON.parse(r.result_json);
    const ts = iso(r.created_at.endsWith('Z') ? r.created_at : `${r.created_at}Z`);
    put('candidate_robustness_audit', `${r.candidate_id}@robustness#${r.id}`, {
      declaredAt: ts, scoredAt: ts,
      metric: 'roi', value: rj.overall?.candidate?.roi ?? null,
      detail: { candidate_id: r.candidate_id, seasons: JSON.parse(r.seasons_json),
        champion: rj.overall?.champion, candidate: rj.overall?.candidate,
        note: 'retrospective one-shot reconstruction; not preregistered in advance -- this candidate_id ' +
          'was re-scored multiple times as more data arrived, which this row preserves as a distinct, ' +
          'separately timestamped trial rather than silently overwriting the earlier look' },
      sourceRef: `server/data.sqlite:nfl_candidate_robustness_audits#${r.id}`,
    });
  }
});

/* ------------------------------------------------------------- Group D --
 * The 15 real, already-preregistered/sealed audit_registry hypotheses --
 * read-only, exact declared_at/scored_at/observed/p_value from the live
 * ledger `audit-registry.js` already maintains.
 */
readReal(db => {
  for (const r of db.prepare(`SELECT * FROM audit_registry ORDER BY id`).all()) {
    put('audit_registry_hypothesis', `audit_registry#${r.id}`, {
      declaredAt: r.preregistered_at, scoredAt: r.ran_at,
      metric: r.metric, value: r.observed,
      status: r.status === 'sealed' ? 'scored' : r.status,
      detail: { name: r.name, hypothesis: r.hypothesis, direction: r.direction, threshold: r.threshold,
        passed: r.passed == null ? null : !!r.passed, p_value: r.p_value, sample_size: r.sample_size,
        significant: r.significant == null ? null : !!r.significant },
      sourceRef: `server/data.sqlite:audit_registry#${r.id}`,
    });
  }
});

/* ------------------------------------------------------------- Group E --
 * The real market-residual ridge model variant (nfl_residual_audits row 1).
 */
readReal(db => {
  const r = db.prepare(`SELECT * FROM nfl_residual_audits ORDER BY id LIMIT 1`).get();
  if (!r) return;
  const rj = JSON.parse(r.result_json);
  const ts = iso(`${r.created_at}Z`);
  const delta = rj.summary.residual_margin_mae - rj.summary.market_margin_mae;
  put('residual_model_variant', 'market-residual-ridge-v1', {
    declaredAt: ts, scoredAt: ts,
    metric: 'margin_mae_delta_vs_market', value: delta,
    detail: { method: rj.method, ridge_lambda: rj.ridge_lambda, evaluation_seasons: rj.evaluation_seasons,
      summary: rj.summary, note: 'retrospective one-shot reconstruction; not preregistered in advance' },
    sourceRef: 'server/data.sqlite:nfl_residual_audits#1',
  });
});

/* ------------------------------------------------------------- Group F --
 * The one live segment-search finding (nfl_candidate_findings), still
 * pending holdout confirmation -- declared, deliberately NOT scored (it
 * has not resolved in reality either).
 */
readReal(db => {
  const r = db.prepare(`SELECT * FROM nfl_candidate_findings ORDER BY id LIMIT 1`).get();
  if (!r) return;
  put('segment_definition_finding', r.segment_key, {
    declaredAt: iso(`${r.confirmed_at ?? r.first_flagged_at}Z`), scoredAt: null,
    metric: 'holdout_status', value: null, status: 'declared',
    detail: { dimension: r.dimension, segment: r.segment, direction: r.direction, state: r.state,
      discovery_seasons: JSON.parse(r.discovery_seasons_json ?? '[]'),
      note: 'still pending REQUIRED_HOLDOUT_CONFIRMATIONS (3) non-overlapping seasons as of this backfill; ' +
        'correctly left unscored rather than assigned a placeholder outcome' },
    sourceRef: 'server/data.sqlite:nfl_candidate_findings#1',
  });
});

/* ------------------------------------------------------------- Group G --
 * The segment SEARCH SPACE itself (real, from nfl-replay.js's segmentsFor())
 * and its real minBets threshold -- registered as ONE declared trial-cluster
 * documenting the honest gap: specific below-threshold segments from any
 * particular historical run are not persisted anywhere and cannot be
 * reconstructed (see file header).
 */
put('segment_search_space', 'nfl-replay.js segmentsFor()', {
  declaredAt: iso('2026-08-27T12:23:23-04:00'), scoredAt: null, metric: null, value: null, status: 'declared',
  detail: {
    dimensions: ['market', 'side', 'role', 'spread size', 'spread_x_timing', 'edge size', 'model agreement',
      'part of season', 'venue', 'wind', 'temperature', 'rest', 'divisional', 'stat:<~178 rolling leaderboard keys>',
      'injury_edge', 'news_signal', 'role_change_signal', 'event_archive_signal'],
    min_bets_threshold: 25, min_bets_threshold_season_end_orchestrator: 30,
    holm_alpha: 0.05, min_effect_roi: 0.05,
    gap: 'analyzeErrors() only ever returns segments clearing every gate; segments dropped for n < minBets ' +
      'are silently discarded in every historical run and never logged, so which specific segment/bucket ' +
      'combinations fell below threshold in any given run cannot be reconstructed. The search SPACE and the ' +
      'threshold RULE above are real (from source); the individual dropped attempts are not recoverable.',
  },
  sourceRef: 'server/services/nfl-replay.js#segmentsFor,analyzeErrors',
});

console.log(JSON.stringify({ db: resolved, declared, scored, already_existed: alreadyExisted }, null, 2));
