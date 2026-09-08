/**
 * Package D's frozen research artifact: the declared experiment, run, and
 * persisted — including negative results — following the same discipline as
 * `nfl-evidence-dataset.js` (Package A): a versioned manifest written once
 * under a content hash, never edited, with `latest.json` as the UI pointer.
 *
 * PER THE MASTER PLAN'S "AGENT OPERATING CONTRACT," THE DECLARATION BELOW WAS
 * WRITTEN BEFORE THIS MODULE'S EVALUATION FUNCTIONS WERE RUN AGAINST 2025 AND
 * IS NOT REVISED AFTER SEEING RESULTS.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rows } from '../db/index.js';
import { buildPlayerWeekEngine, teamWeekEventExpectations } from './player-week-engine.js';
import { pairedBootstrapDiff } from './backtest-significance.js';
import {
  ROLE_SCENARIO_ENGINE_VERSION, buildPlayerScenarios, conservedTeamVolume,
  evaluateChangepointDetectors, auditCascadeConservation
} from './role-scenario-engine.js';

export const ROLE_SCENARIO_LAB_VERSION = 'role-scenario-lab-v1.0.0';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT_DIR = path.join(root, 'server/data/role-scenario-lab');

/**
 * Declared BEFORE evaluation. Frozen text, not regenerated from results.
 */
export const EXPERIMENT_DECLARATION = Object.freeze({
  package: 'D — player roles as scenarios',
  hypothesis: 'For a "beneficiary" player Y (RB/WR/TE), knowing that a same-position ' +
    'teammate X is Questionable, Doubtful or Out THIS week — information the shared ' +
    'player-week-engine does not use at all when forming Y\'s own role, which is built ' +
    'purely from Y\'s own trailing history (see nfl-teammate-competition.js\'s finding that ' +
    'a victim\'s own recent share already reflects a squeeze a week or two late) — and ' +
    'conservatively reallocating X\'s probability-weighted expected opportunity to his ' +
    'teammates under a fixed team-volume pool (conservedTeamVolume) produces a more ' +
    'accurate forecast of Y\'s touches and yards than the existing shared engine\'s own ' +
    'output, specifically in the games where this information exists and differs from it.',
  scope: {
    positions: ['RB', 'WR', 'TE'],
    markets: ['touches (targets+carries)', 'combined rush+reception yards'],
    trigger: 'a same-position teammate X carries report_status in {Questionable, Doubtful, Out} in the target week',
    excluded: 'QB (attempts do not decompose into a shared target/carry pool the same way) and any player-week with no real recorded usage row (not gradeable)'
  },
  decision_horizon: 'Pregame, using that week\'s injury report and the shared player-week engine built with week-1 cutoff, exactly as buildPlayerWeekEngine/weeklyAvailability already restrict themselves to information available before kickoff.',
  baselines: [
    'existing shared engine: teamWeekEventExpectations(engine, team, {}) for player Y, unmodified',
    'market no-vig probability: DECLARED BUT NOT EVALUATED AT SCALE — nfl_prop_quote_snapshots only covers 2026-09-02 through 2026-09-07 (one week, forward-only), so no historical (2022-2025) market prop tape exists to grade against. Stated as a limitation, not silently skipped.'
  ],
  split_policy: 'Chronological. The changepoint-detector threshold is fit on 2022-2023 only (see evaluateChangepointDetectors), then frozen and applied unchanged to 2024 (discovery) and 2025 (holdout). The reallocation test has no free parameters to fit — conservedTeamVolume and the scenario probabilities are built entirely from already-elsewhere-validated pieces (weeklyAvailability, measureInjuryEffect) — so it is run directly on 2024 (discovery) and 2025 (final holdout) without any tuning step.',
  approximation_declared: 'For computational tractability, the reallocation test uses X\'s probability-weighted EXPECTED multiplier (sum of scenario probability x scenario multiplier) applied once per player-week, not a full per-scenario Monte Carlo blend. The full scenario-by-scenario mixture (including the zero-touch hurdle) is delivered separately for the scenario explorer (explorePlayerWeekScenarios / sampleScenarioMixture) but not separately evaluated at this sample size.',
  selection_rule: 'A single pre-declared metric per grading run: paired-bootstrap difference in mean absolute error (touches, then combined yards), block-resampled by team-week (pairedBootstrapDiff, 2000 iterations). "Improves" requires the 90% CI to exclude zero AND favor the scenario reallocation. No other metric is substituted after seeing results.',
  failure_criteria: 'If the 90% CI on either metric straddles zero, or favors the existing engine, on EITHER the discovery or the holdout season, this is reported as a failure for that metric/season — not reframed, not re-cut by a different scope chosen after the fact.',
  all_trials: 'Exactly one reallocation specification is tested (as declared above). The changepoint detector sweeps 8 threshold candidates on fit-only data (2022-2023) before freezing one, which is reported in full including the untried candidates\' scores.'
});

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sha = v => crypto.createHash('sha256').update(v).digest('hex').slice(0, 16);

function expectedMultiplier(scenarioSet) {
  return scenarioSet.scenarios.reduce((s, x) => s + x.probability * x.multiplier, 0);
}

function atRiskTeammatePairs(season, week, engine) {
  const injuredGsis = new Set(rows(
    `SELECT gsis_id FROM nfl_injuries WHERE season=? AND week=? AND report_status IN ('Questionable','Doubtful','Out')`,
    season, week).map(r => r.gsis_id));
  if (!injuredGsis.size) return [];
  const byTeam = new Map();
  for (const p of engine.values()) {
    if (!p.team || !['RB', 'WR', 'TE'].includes(p.position)) continue;
    (byTeam.get(p.team) ?? byTeam.set(p.team, []).get(p.team)).push(p);
  }
  const pairs = [];
  for (const players of byTeam.values()) {
    const atRisk = players.filter(p => p.gsis_id && injuredGsis.has(p.gsis_id));
    for (const x of atRisk) {
      for (const y of players.filter(y => y.player_id !== x.player_id && y.position === x.position)) {
        pairs.push({ team: x.team, x, y });
      }
    }
  }
  return pairs;
}

/**
 * The declared reallocation test for one season, run strictly walk-forward
 * (each week's engine is built with that week's own cutoff).
 */
export function evaluateReallocation(season) {
  const actualByPlayerWeek = new Map();
  for (const r of rows(`SELECT player_id,week,targets,carries,receiving_yards,rushing_yards
                        FROM player_week_usage WHERE season=?`, season)) {
    actualByPlayerWeek.set(`${r.player_id}|${r.week}`, r);
  }
  const baseErr = [], scenErr = [], baseYardErr = [], scenYardErr = [], groups = [];
  for (let week = 3; week <= 18; week++) {
    let engine;
    try { engine = buildPlayerWeekEngine({ season, week }); } catch { continue; }
    if (!engine.size) continue;
    const baselineTeamCache = new Map();
    const scenarioCache = new Map();
    for (const { team, x, y } of atRiskTeammatePairs(season, week, engine)) {
      const actual = actualByPlayerWeek.get(`${y.player_id}|${week}`);
      if (!actual) continue;
      const actualTouches = (actual.targets ?? 0) + (actual.carries ?? 0);
      const actualYards = (actual.receiving_yards ?? 0) + (actual.rushing_yards ?? 0);

      const baselineTeam = baselineTeamCache.get(team) ?? teamWeekEventExpectations(engine, team, {});
      baselineTeamCache.set(team, baselineTeam);
      const baseline = baselineTeam.get(y.player_id);
      if (!baseline) continue;

      const scenarioSet = buildPlayerScenarios({ engine, season, week, playerId: x.player_id });
      if (!scenarioSet) continue;
      const expMult = expectedMultiplier(scenarioSet);
      const cacheKey = `${team}|${x.player_id}|${expMult.toFixed(4)}`;
      let conserved = scenarioCache.get(cacheKey);
      if (!conserved) {
        conserved = conservedTeamVolume(engine, team, new Map([[x.player_id, expMult]]));
        scenarioCache.set(cacheKey, conserved);
      }
      const scenarioState = conserved.scenario.get(y.player_id);
      if (!scenarioState) continue;

      baseErr.push(Math.abs((baseline.volume.targets + baseline.volume.carries) - actualTouches));
      scenErr.push(Math.abs((scenarioState.volume.targets + scenarioState.volume.carries) - actualTouches));
      baseYardErr.push(Math.abs((baseline.events.recYd + baseline.events.rushYd) - actualYards));
      scenYardErr.push(Math.abs((scenarioState.events.recYd + scenarioState.events.rushYd) - actualYards));
      groups.push(`${season}|${week}|${team}`);
    }
  }
  const maeOf = a => (a.length ? +mean(a).toFixed(3) : null);
  const touchTest = baseErr.length >= 10 ? pairedBootstrapDiff(baseErr, scenErr, { iterations: 2000, seed: 41, groups }) : { error: `too few paired observations (${baseErr.length})` };
  const yardTest = baseYardErr.length >= 10 ? pairedBootstrapDiff(baseYardErr, scenYardErr, { iterations: 2000, seed: 43, groups }) : { error: `too few paired observations (${baseYardErr.length})` };
  return {
    season, n: baseErr.length,
    touches: { baseline_mae: maeOf(baseErr), scenario_mae: maeOf(scenErr), bootstrap: touchTest,
      improves: touchTest.significant === true && touchTest.mean_diff < 0 },
    yards: { baseline_mae: maeOf(baseYardErr), scenario_mae: maeOf(scenYardErr), bootstrap: yardTest,
      improves: yardTest.significant === true && yardTest.mean_diff < 0 }
  };
}

/**
 * Runs the full declared experiment and returns a report ready to freeze.
 * Never mutates data.sqlite; every read here is a SELECT.
 */
export function runRoleScenarioExperiment({ discoverySeason = 2024, holdoutSeason = 2025, fitSeasons = [2022, 2023] } = {}) {
  const startedAt = new Date().toISOString();
  const changepoints = evaluateChangepointDetectors({ fitSeasons, discoverySeason, holdoutSeason });
  const cascadeAudit = auditCascadeConservation({});
  const reallocationDiscovery = evaluateReallocation(discoverySeason);
  const reallocationHoldout = evaluateReallocation(holdoutSeason);

  const overallVerdict = (() => {
    const touchesImprove = reallocationDiscovery.touches.improves && reallocationHoldout.touches.improves;
    const yardsImprove = reallocationDiscovery.yards.improves && reallocationHoldout.yards.improves;
    if (touchesImprove || yardsImprove) {
      return `Real, holdout-confirmed improvement on ${[touchesImprove && 'touches', yardsImprove && 'yards'].filter(Boolean).join(' and ')}.`;
    }
    return 'FAILURE CRITERION MET: no metric shows a significant improvement over the existing shared player-week engine on both the discovery and holdout seasons. Reported as a complete, honest negative result per the declared failure criteria — not promoted, not reframed.';
  })();

  return {
    schema: 'role-scenario-lab-v1', engine_version: ROLE_SCENARIO_ENGINE_VERSION, lab_version: ROLE_SCENARIO_LAB_VERSION,
    started_at: startedAt, finished_at: new Date().toISOString(),
    declaration: EXPERIMENT_DECLARATION,
    dataset: {
      fit_seasons: fitSeasons, discovery_season: discoverySeason, holdout_season: holdoutSeason,
      note: 'Read directly from player_week_usage and nfl_injuries via read-only SELECT; no rows written to data.sqlite by this module.'
    },
    results: {
      changepoint_detection: changepoints,
      cascade_conservation_audit: cascadeAudit,
      reallocation: { discovery: reallocationDiscovery, holdout: reallocationHoldout }
    },
    verdict: overallVerdict,
    authority: 'research_only',
    production_changed: false,
    limitations: [
      'No historical market prop tape exists for 2022-2025 (nfl_prop_quote_snapshots starts 2026-09-02), so the market-only baseline in the declaration could not be evaluated at scale — stated, not silently dropped.',
      'The reallocation test uses a single expected-multiplier point forecast per player-week for tractability, not a full per-scenario Monte Carlo grade (see EXPERIMENT_DECLARATION.approximation_declared).',
      'Injury report coverage begins in 2021 and practice-status coverage is not uniform across all seasons; see nfl-player-context.js\'s own caveats on the same table.'
    ]
  };
}

/** Freeze one run to disk under its own content hash. Never edits an existing one. */
export function freezeRoleScenarioExperiment(report, { outputDir = OUTPUT_DIR } = {}) {
  const body = JSON.stringify(report);
  const hash = sha(body);
  const dir = path.join(outputDir, hash);
  if (fs.existsSync(path.join(dir, 'manifest.json'))) return { existing: true, hash, dir };
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { ...report, hash, frozen_at: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outputDir, 'latest.json'), JSON.stringify(manifest, null, 2));
  return { existing: false, hash, dir };
}

/** The frozen manifest the research page reads. Never recomputes; a missing one is a missing one. */
export function latestRoleScenarioExperiment({ outputDir = OUTPUT_DIR } = {}) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'latest.json'), 'utf8'));
    return manifest?.schema === 'role-scenario-lab-v1' ? manifest : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
