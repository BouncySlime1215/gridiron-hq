/**
 * Research control plane for signals that are deliberately NOT production
 * inputs yet. Its job is to tell us whether a future candidate is worth a
 * preregistered experiment, not to retrofit a profitable-looking filter.
 */
import { db, rows, run } from '../db/index.js';
import { nestedEvaluationRows } from './nfl-market.js';
import { latestTrainingAudit } from './nfl-replay.js';
import { allPickResults } from './nfl-auto-picks.js';
import { evidenceDaemonStatus } from './evidence-daemon.js';
import { shadowLedgerSummary } from './shadow-ledger.js';
import { nflMarketMovement, mlbMarketMovement } from './market-movement.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS research_hypotheses (
    id TEXT PRIMARY KEY, sport TEXT NOT NULL, title TEXT NOT NULL, hypothesis TEXT NOT NULL,
    source TEXT NOT NULL, status TEXT NOT NULL, holdout_rule TEXT NOT NULL, created_at TEXT NOT NULL
  );
`);

const r3 = n => n == null || !Number.isFinite(n) ? null : +n.toFixed(3);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const quantile = (values, p) => {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y); const i = (a.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo);
};

const HYPOTHESES = [
  ['nfl-late-season', 'NFL', 'Late-season availability / incentive project', 'Late-week degradation may reflect unmeasured roster availability, incentive and rest information rather than a stable side bias.', 'Weakest exact-policy segment: late weeks 14+', 'locked_design'],
  ['nfl-home-side', 'NFL', 'Home-side market-residual project', 'The negative home-side result may be a market-pricing or schedule-context interaction; test it only with a predeclared residual target.', 'Weakest exact-policy segment: backed home', 'locked_design'],
  ['nfl-line-move', 'NFL', 'Information-arrival project', 'Line movement and book dispersion may identify when public information is still arriving; they must be measured before kickoff, not inferred afterward.', 'Evidence daemon multi-horizon line snapshots', 'collecting'],
  ['mlb-lineup', 'MLB', 'Lineup-confirmation project', 'Confirmed lineup state can be tested as a pregame availability feature only after real-priced forward samples exist.', 'MLB pregame snapshots', 'collecting']
];
for (const [id, sport, title, hypothesis, source, status] of HYPOTHESES) run(`INSERT INTO research_hypotheses
  (id,sport,title,hypothesis,source,status,holdout_rule,created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))
  ON CONFLICT(id) DO NOTHING`, id, sport, title, hypothesis, source, status,
  'Freeze feature definition and split before evaluating an untouched future season.');

function uncertainty() {
  const nested = nestedEvaluationRows();
  if (nested.error) return nested;
  const rowsOut = nested.rows;
  const folds = [];
  for (const season of nested.evaluation_seasons) {
    const train = rowsOut.filter(x => x.g.season < season);
    const test = rowsOut.filter(x => x.g.season === season);
    const marginQ80 = quantile(train.map(x => Math.abs(x.actualMargin - x.predMargin)), .8);
    const marginQ95 = quantile(train.map(x => Math.abs(x.actualMargin - x.predMargin)), .95);
    const totalQ80 = quantile(train.map(x => Math.abs(x.actualTotal - x.predTotal)), .8);
    const totalQ95 = quantile(train.map(x => Math.abs(x.actualTotal - x.predTotal)), .95);
    if (!test.length || marginQ80 == null) continue;
    folds.push({ season, n: test.length,
      margin_80_coverage: r3(mean(test.map(x => Number(Math.abs(x.actualMargin - x.predMargin) <= marginQ80)))),
      margin_95_coverage: r3(mean(test.map(x => Number(Math.abs(x.actualMargin - x.predMargin) <= marginQ95)))),
      total_80_coverage: r3(mean(test.map(x => Number(Math.abs(x.actualTotal - x.predTotal) <= totalQ80)))),
      total_95_coverage: r3(mean(test.map(x => Number(Math.abs(x.actualTotal - x.predTotal) <= totalQ95)))),
      margin_interval_80: r3(marginQ80), margin_interval_95: r3(marginQ95),
      total_interval_80: r3(totalQ80), total_interval_95: r3(totalQ95) });
  }
  return {
    method: 'chronological conformal residual intervals; every interval uses only prior outer-fold seasons',
    folds,
    aggregate: { n: folds.reduce((s, x) => s + x.n, 0),
      margin_80_coverage: r3(mean(folds.map(x => x.margin_80_coverage))), margin_95_coverage: r3(mean(folds.map(x => x.margin_95_coverage))),
      total_80_coverage: r3(mean(folds.map(x => x.total_80_coverage))), total_95_coverage: r3(mean(folds.map(x => x.total_95_coverage))) },
    policy: 'Intervals are display/research uncertainty only. No production sizing or selection rule consumes them.'
  };
}

function regimes() {
  const nested = nestedEvaluationRows();
  if (nested.error) return nested;
  const allMargin = nested.rows.map(x => Math.abs(x.actualMargin - x.predMargin));
  const allTotal = nested.rows.map(x => Math.abs(x.actualTotal - x.predTotal));
  const baseline = { margin_mae: mean(allMargin), total_mae: mean(allTotal) };
  const seasons = nested.evaluation_seasons.map(season => {
    const r = nested.rows.filter(x => x.g.season === season);
    const margin = mean(r.map(x => Math.abs(x.actualMargin - x.predMargin)));
    const total = mean(r.map(x => Math.abs(x.actualTotal - x.predTotal)));
    const drift = Math.max(margin / baseline.margin_mae - 1, total / baseline.total_mae - 1);
    return { season, n: r.length, margin_mae: r3(margin), total_mae: r3(total), drift: r3(drift),
      regime: drift > .12 ? 'degraded' : drift < -.12 ? 'favorable' : 'stable' };
  });
  return { method: 'outer-fold error drift versus pooled baseline; not a selection feature', baseline: { margin_mae: r3(baseline.margin_mae), total_mae: r3(baseline.total_mae) }, seasons };
}

function bayesianPooling() {
  const nested = nestedEvaluationRows();
  if (nested.error) return nested;
  const errors = nested.rows.map(x => ({ season: x.g.season, error: x.actualMargin - x.predMargin }));
  const global = mean(errors.map(x => x.error));
  const priorStrength = 120;
  return { method: 'normal-normal partial pooling of season-level margin bias; diagnostic shrinkage, never a retroactive correction', prior_strength_games: priorStrength,
    global_bias: r3(global), seasons: nested.evaluation_seasons.map(season => {
      const a = errors.filter(x => x.season === season).map(x => x.error); const raw = mean(a);
      const weight = a.length / (a.length + priorStrength);
      return { season, n: a.length, raw_bias: r3(raw), pooled_bias: r3(weight * raw + (1 - weight) * global), shrinkage: r3(1 - weight) };
    }) };
}

function redTeam() {
  const a = nestedEvaluationRows(), b = nestedEvaluationRows();
  if (a.error) return a;
  const replay = latestTrainingAudit()?.result?.overall;
  const checks = [
    { id: 'deterministic_outer_folds', passed: JSON.stringify(a) === JSON.stringify(b), detail: 'Repeated canonical nested evaluation is byte-stable.' },
    { id: 'chronological_fold_order', passed: a.rows.every(x => a.evaluation_seasons.includes(x.g.season)), detail: 'Only declared outer holdout seasons appear in scored rows.' },
    { id: 'market_baseline_present', passed: a.rows.filter(x => x.g.home_spread != null).length >= 500, detail: 'Market comparison has enough scored games to remain meaningful.' },
    { id: 'profit_claim_quarantined', passed: !(replay?.roi > 0 && (replay?.uncertainty?.probability_roi_above_zero ?? 0) < .75), detail: 'Weak interval evidence cannot claim a production edge.' },
    { id: 'forward_only_execution', passed: allPickResults().every(x => !x.quote_at || x.selected_at >= x.quote_at), detail: 'Stored pick timestamps do not precede their quote timestamps.' }
  ];
  return { checks, passed: checks.filter(x => x.passed).length, total: checks.length,
    policy: 'A failed red-team check blocks experiments and forces a human investigation; it never silently relaxes a gate.' };
}

function shadowAndPortfolio() {
  const picks = allPickResults();
  const forward = picks.filter(p => p.selected_at && p.quote_at && new Date(p.selected_at) >= new Date(p.quote_at));
  const settled = forward.filter(p => ['Won', 'Lost', 'Push'].includes(p.status));
  const open = forward.filter(p => p.status === 'Pending');
  const exposure = open.reduce((s, p) => s + (p.units_staked ?? 0), 0);
  return {
    shadow_ledger: { ...shadowLedgerSummary('NFL'), forward_picks: forward.length, settled_picks: settled.length, open_picks: open.length, source: 'immutable NFL capture ledger' },
    portfolio: { execution_enabled: false, max_real_stake: 0, open_shadow_units: r3(exposure),
      constraints: ['No real betting execution', 'No correlated-parlay construction', 'No sizing from unproven probabilities', 'One market / event maximum in shadow ledger'],
      verdict: 'research_only' }
  };
}

export function nflIntelligence() {
  return {
    generated_at: new Date().toISOString(), status: 'research_only',
    evidence_daemon: evidenceDaemonStatus(), uncertainty: uncertainty(), regimes: regimes(),
    bayesian_pooling: bayesianPooling(), market_movement: nflMarketMovement(), red_team: redTeam(), shadow: shadowAndPortfolio(),
    hypotheses: rows('SELECT * FROM research_hypotheses WHERE sport IN (\'NFL\',\'MLB\') ORDER BY sport,id')
  };
}

export function mlbIntelligence() {
  const daemon = evidenceDaemonStatus();
  return {
    generated_at: new Date().toISOString(), status: 'research_only', evidence_daemon: daemon, market_movement: mlbMarketMovement(),
    shadow: { execution_enabled: false, max_real_stake: 0, policy: 'MLB remains paper-only until each market independently clears its price, calibration, forward-sample and CLV gates.' },
    hypotheses: rows("SELECT * FROM research_hypotheses WHERE sport='MLB' ORDER BY id")
  };
}
