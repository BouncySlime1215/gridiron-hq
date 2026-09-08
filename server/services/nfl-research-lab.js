import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rows } from '../db/index.js';
import { latestEvidenceDataset } from './nfl-evidence-dataset.js';
import { latestRoleScenarioExperiment } from './role-scenario-lab.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const exists = table => rows("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).length > 0;
const optional = (table, sql) => exists(table) ? rows(sql) : [];

export const RESEARCH_PACKAGES = [
  { id: 'A', title: 'A trustworthy price tape', state: 'next', risk: 'Foundation', purpose: 'Know exactly what was available when. Separate current quotes from stale copies and preserve revisions.' },
  { id: 'B', title: 'Learn which books move first', state: 'starter_built', risk: 'High upside', purpose: 'Predict the next price change and whether a slower book will still offer its price when we arrive.' },
  { id: 'C', title: 'Trees and TPOT laboratory', state: 'extended', risk: 'Experimental', purpose: 'Search for useful interactions and compare them to simple baselines on later games. Now covers three targets (movement, cover/over, quantile) across six model families, a ranker branch and a market-anchored logit branch.' },
  { id: 'D', title: 'Model changing player roles', state: 'planned', risk: 'High upside', purpose: 'Price full, limited and inactive scenarios instead of pretending every player has one certain role.' },
  { id: 'E', title: 'News that arrives before the price moves', state: 'planned', risk: 'Experimental', purpose: 'Extract sourced changes in role or availability, then learn which changes move specific markets.' },
  { id: 'F', title: 'Learn when to trust each specialist', state: 'built_result_negative', risk: 'Experimental', purpose: 'Let different experts contribute in different situations, while testing whether they add independent information. Built and run: a non-negative sum-to-1 ridge selector, with a market-only expert and abstain as first-class options, did NOT beat taking the market alone on any tested configuration. Reported as a completed negative result, not a pending success.' },
  { id: 'G', title: 'Find inconsistent prices across markets', state: 'planned', risk: 'Speculative', purpose: 'Test whether connected player and team markets contradict one another after actual ticket rules and costs.' },
  { id: 'H', title: 'Replay what we could actually obtain', state: 'next', risk: 'Foundation', purpose: 'Include delays, disappearing prices, limits and correlated losses before treating a forecast as an opportunity.' },
  { id: 'I', title: 'One research workspace', state: 'starter_built', risk: 'Foundation', purpose: 'Show completed evidence, failed attempts and the next build step together. Keep heavy training outside the app server.' }
];

export async function researchLabStatus() {
  const auditRows = optional('nfl_blind_audit_runs', 'SELECT id,status,next_ordinal,created_at,spec_json,final_json FROM nfl_blind_audit_runs ORDER BY id DESC');
  const describe = r => r ? { id: r.id, status: r.status, opened_weeks: r.next_ordinal,
    total_weeks: parse(r.spec_json)?.schedule?.length ?? null,
    betting: parse(r.final_json)?.betting ?? null,
    error: parse(r.final_json)?.error ?? null } : null;
  let experiment = null, reportError = null;
  try {
    experiment = parse(await fs.readFile(path.join(root, 'server/data/market-lab/latest.json'), 'utf8'));
    if (experiment?.schema !== 'market-lab-v1') { experiment = null; reportError = 'Unrecognized or invalid research report'; }
  } catch (error) { if (error.code !== 'ENOENT') reportError = 'Research report could not be read'; }
  // The Package C extension (research/tree_lab.py) writes a SEPARATE report
  // under its own schema (tree-lab-v1) rather than reshaping market-lab-v1:
  // three targets and six-plus families per market/season do not fit the
  // pilot's {market, folds, candidates} shape without breaking the reader
  // above. Both reports are surfaced side by side rather than one replacing
  // the other.
  let treeExperiment = null, treeReportError = null;
  try {
    treeExperiment = parse(await fs.readFile(path.join(root, 'server/data/tree-lab/latest.json'), 'utf8'));
    if (treeExperiment?.schema !== 'tree-lab-v1') { treeExperiment = null; treeReportError = 'Unrecognized or invalid extended research report'; }
  } catch (error) { if (error.code !== 'ENOENT') treeReportError = 'Extended research report could not be read'; }
  let bookLagLab = null, bookLagLabError = null;
  try {
    bookLagLab = parse(await fs.readFile(path.join(root, 'server/data/book-lag-lab/latest.json'), 'utf8'));
    if (bookLagLab?.schema !== 'book-lag-lab-v1') { bookLagLab = null; bookLagLabError = 'Unrecognized or invalid book-lag report'; }
  } catch (error) { if (error.code !== 'ENOENT') bookLagLabError = 'Book-lag report could not be read'; }
  // Package F (research/expert_selector_lab.py). Its own schema again, for the
  // same reason tree-lab-v1 is not market-lab-v1: a per-substrate,
  // per-trial, per-fold shape with two baselines and two metrics does not fit
  // either existing reader.
  let expertSelectorLab = null, expertSelectorLabError = null;
  try {
    expertSelectorLab = parse(await fs.readFile(path.join(root, 'server/data/expert-selector-lab/latest.json'), 'utf8'));
    if (expertSelectorLab?.schema !== 'expert-selector-lab-v1') { expertSelectorLab = null; expertSelectorLabError = 'Unrecognized or invalid expert-selector report'; }
  } catch (error) { if (error.code !== 'ENOENT') expertSelectorLabError = 'Expert-selector report could not be read'; }
  return {
    as_of: new Date().toISOString(), authority: 'research_only', production_changed: false,
    latest_attempt: describe(auditRows[0]), latest_completed: describe(auditRows.find(r => r.status === 'complete')),
    warehouse: {
      team_features: optional('nfl_team_week_features', 'SELECT MIN(season) first_season,MAX(season) last_season,COUNT(*) rows FROM nfl_team_week_features')[0] ?? null,
      archive: optional('nfl_odds_archive', 'SELECT COUNT(*) rows,COUNT(DISTINCT eid) games FROM nfl_odds_archive')[0] ?? null,
      forward: optional('forward_picks', 'SELECT COUNT(*) decisions,SUM(settled_at IS NOT NULL) settled FROM forward_picks')[0] ?? null,
      expert_forward: optional('nfl_expert_forward_predictions', 'SELECT COUNT(*) predictions,COUNT(DISTINCT season||\'|\'||week||\'|\'||home||\'|\'||away) games FROM nfl_expert_forward_predictions')[0] ?? null
    },
    evidence_dataset: (() => {
      const manifest = latestEvidenceDataset();
      if (!manifest) return null;
      return { dataset_hash: manifest.dataset_hash, built_at: manifest.built_at, decision_at: manifest.decision_at,
        accepted: manifest.accepted, dropped: manifest.dropped, events: manifest.events,
        quarantine: manifest.quarantine, coverage_bias: manifest.coverage_bias,
        duplicate_event_count: manifest.duplicate_event_count, provenance: manifest.provenance };
    })(),
    role_scenario_lab: (() => {
      const manifest = latestRoleScenarioExperiment();
      if (!manifest) return null;
      return { hash: manifest.hash, started_at: manifest.started_at, finished_at: manifest.finished_at,
        declaration: manifest.declaration, results: manifest.results, verdict: manifest.verdict,
        limitations: manifest.limitations, authority: manifest.authority };
    })(),
    experiment, report_error: reportError,
    tree_experiment: treeExperiment, tree_report_error: treeReportError,
    book_lag_lab: (() => {
      if (!bookLagLab) return null;
      return {
        authority: 'research_only', run_id: bookLagLab.run_id, dataset_hash: bookLagLab.dataset_hash,
        events: bookLagLab.panel_summary?.events, books: bookLagLab.panel_summary?.books?.length ?? null,
        native_step_seconds: bookLagLab.panel_summary?.native_step_seconds,
        hawkes_attempted: bookLagLab.hawkes_feasibility?.attempted ?? false,
        hawkes_verdict: bookLagLab.hawkes_feasibility?.verdict ?? null,
        lead_lag_by_book: bookLagLab.lead_lag_matrix?.by_book ?? null,
        next_move: bookLagLab.next_move, time_to_follow: bookLagLab.time_to_follow,
        delay_survival: bookLagLab.delay_survival, opportunity_routing: bookLagLab.opportunity_routing,
        verdict: bookLagLab.verdict, limitations: bookLagLab.limitations,
        split_policy_limitation: bookLagLab.protocol?.split_policy?.declared_limitation ?? null
      };
    })(),
    book_lag_lab_error: bookLagLabError,
    expert_selector_lab: (() => {
      if (!expertSelectorLab) return null;
      return {
        authority: 'research_only', run_id: expertSelectorLab.run_id,
        created_at: expertSelectorLab.created_at,
        declaration_written_at: expertSelectorLab.declaration_written_at,
        wall_clock_seconds: expertSelectorLab.wall_clock_seconds,
        meta_learner: expertSelectorLab.declaration?.level_1_meta_learner ?? null,
        economic_hypothesis: expertSelectorLab.declaration?.economic_hypothesis ?? null,
        selection_rule: expertSelectorLab.declaration?.selection_rule ?? null,
        baselines: expertSelectorLab.declaration?.baselines_that_must_be_beaten ?? [],
        known_limitations: expertSelectorLab.declaration?.known_limitations ?? [],
        substrates: expertSelectorLab.substrates ?? null,
        errors: expertSelectorLab.errors ?? [],
        // One compact row per substrate. The negative verdict is carried
        // verbatim rather than reduced to a pass/fail badge -- a selector that
        // cannot beat the market is the result, not a missing result.
        results: (expertSelectorLab.results ?? []).map(r => ({
          substrate: r.substrate, rows: r.rows, expert_count: r.expert_count,
          seasons: r.seasons, guarantee: r.guarantee,
          families: r.families, family_note: r.family_note,
          top_correlations: (r.top_correlations ?? []).slice(0, 8),
          verdict: r.verdict,
          folds: (r.trials ?? []).flatMap(t => (t.folds ?? []).map(f => ({
            trial: t.label, test_season: f.test_season, test_rows: f.test_rows,
            train_rows: f.train_rows, alpha: f.alpha,
            selector_mae: f.selector_mae, selector_mse: f.selector_mse,
            market_only_mae: f.baselines?.market_only?.mae ?? null,
            gain_vs_market: f.baselines?.market_only?.mean_gain ?? null,
            gain_vs_market_interval: f.baselines?.market_only?.gain_interval_week_clustered ?? null,
            static_equal_weight_mae: f.baselines?.static_equal_weight?.mae ?? null,
            gain_vs_equal_weight: f.baselines?.static_equal_weight?.mean_gain ?? null,
            gain_vs_equal_weight_interval: f.baselines?.static_equal_weight?.gain_interval_week_clustered ?? null,
            existing_coordinator_mae: f.baselines?.existing_coordinator?.mae ?? null
          }))),
          expert_contribution: (r.contribution?.experts ?? []).map(e => ({
            expert: e.expert, mean_weight: e.mean_weight ?? null,
            never_selected: e.never_selected ?? null,
            mae_increase_when_removed_by_fold: e.mae_increase_when_removed_by_fold ?? null,
            note: e.leave_one_out ?? null
          })),
          effective_weights_by_fold: (r.contribution?.base?.folds ?? []).map(f => ({
            test_season: f.test_season, effective_weights: f.effective_weights ?? null
          }))
        }))
      };
    })(),
    expert_selector_lab_error: expertSelectorLabError,
    packages: RESEARCH_PACKAGES,
    plan_url: '/api/nfl-market/research-lab/plan',
    principles: [
      'A failed model is evidence about that model, not proof that every future approach must fail.',
      'A better price is not automatically a profitable bet.',
      'Simulation checks assumptions; real future observations test whether those assumptions were right.',
      'Research can be aggressive without giving unproven ideas authority over money.'
    ]
  };
}

export async function researchMasterPlan() {
  return fs.readFile(path.join(root, 'docs/NFL_RESEARCH_MASTER_PLAN_2026_09_08.md'), 'utf8');
}
