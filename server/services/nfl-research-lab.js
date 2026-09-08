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
  { id: 'B', title: 'Learn which books move first', state: 'planned', risk: 'High upside', purpose: 'Predict the next price change and whether a slower book will still offer its price when we arrive.' },
  { id: 'C', title: 'Trees and TPOT laboratory', state: 'extended', risk: 'Experimental', purpose: 'Search for useful interactions and compare them to simple baselines on later games. Now covers three targets (movement, cover/over, quantile) across six model families, a ranker branch and a market-anchored logit branch.' },
  { id: 'D', title: 'Model changing player roles', state: 'planned', risk: 'High upside', purpose: 'Price full, limited and inactive scenarios instead of pretending every player has one certain role.' },
  { id: 'E', title: 'News that arrives before the price moves', state: 'planned', risk: 'Experimental', purpose: 'Extract sourced changes in role or availability, then learn which changes move specific markets.' },
  { id: 'F', title: 'Learn when to trust each specialist', state: 'planned', risk: 'Experimental', purpose: 'Let different experts contribute in different situations, while testing whether they add independent information.' },
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
