/** Market-separated MLB readiness and evidence diagnostics. */
import { rows } from '../db/index.js';
import { modelAudit, allPicks, standing } from './mlb-auto-picks.js';
import { mlbPregameCoverage } from './mlb-pregame.js';
import { listMlbExperiments } from './mlb-experiments.js';
import { usage as oddsUsage } from './odds-api.js';
import { appDate } from './date-util.js';
import { mlbCalibrations } from './mlb-calibration.js';
import { featureContracts, registry, recordGateAudit, gateAudits, evidenceManifests, updateRegistry } from './model-governance.js';

const MARKETS = ['nrfi', 'pitcher_strikeouts', 'batter_total_bases'];
const VERSION = {
  nrfi: 'mlb-nrfi-v2-cutoff',
  pitcher_strikeouts: 'mlb-k-v2-cutoff',
  batter_total_bases: 'mlb-tb-v2-cutoff'
};

function tableCoverage() {
  const one = (table, dateCol = 'date') => {
    try { return rows(`SELECT COUNT(*) rows,MIN(${dateCol}) first,MAX(${dateCol}) latest FROM ${table}`)[0]; }
    catch { return { rows: 0, first: null, latest: null }; }
  };
  return {
    games: one('mlb_games'), batter_games: one('mlb_batter_games'), pitcher_games: one('mlb_pitcher_games'),
    probable_starters: one('mlb_probable_starters'), pregame_snapshots: one('mlb_pregame_snapshots', 'slate_date'),
    market_quotes: one('mlb_market_quotes', 'captured_at')
  };
}

export function mlbOperations({ throughDate = appDate(), persist = false } = {}) {
  const season = Number(throughDate.slice(0, 4));
  const audit = modelAudit(season, throughDate, { lookbackDays: 180, cadenceDays: 7 });
  const picks = allPicks();
  const ledger = standing(throughDate);
  const pregame = mlbPregameCoverage();
  const odds = oddsUsage();
  const byMarket = {};
  for (const market of MARKETS) {
    const metric = audit.by_market[market];
    const forward = picks.filter(x => x.market === market && x.tracking_mode === 'forward' && x.evidence_eligible);
    const settled = forward.filter(x => x.status === 'Won' || x.status === 'Lost');
    const priced = settled.filter(x => x.american_price != null);
    const quoteMarket = { nrfi: 'totals_1st_1_innings', pitcher_strikeouts: 'pitcher_strikeouts', batter_total_bases: 'batter_total_bases' }[market];
    const quoteCoverage = pregame.quotes.find(x => x.market === quoteMarket) ?? null;
    const gates = [
      { id: 'historical_sample', label: 'Cutoff-valid historical sample', passed: metric.n >= 500, actual: metric.n, target: '≥ 500' },
      { id: 'calibration', label: 'Probability calibration', passed: metric.calibration_slope >= 0.85 && metric.calibration_slope <= 1.15 && metric.expected_calibration_error <= 0.03,
        actual: { slope: metric.calibration_slope, ece: metric.expected_calibration_error }, target: 'slope 0.85–1.15; ECE ≤ 0.03' },
      { id: 'market_benchmark', label: 'Beats no-vig market probability', passed: metric.market_brier != null && metric.brier < metric.market_brier,
        actual: { model_brier: metric.brier, market_brier: metric.market_brier }, target: 'model Brier < market Brier' },
      { id: 'forward_sample', label: 'Forward settled evidence', passed: settled.length >= 150, actual: settled.length, target: '≥ 150' },
      { id: 'real_prices', label: 'Real priced forward evidence', passed: priced.length >= 150, actual: priced.length, target: '≥ 150' },
      { id: 'clv', label: 'Positive closing-line value', passed: false,
        actual: quoteCoverage ? `${quoteCoverage.quotes} quotes; closing linkage pending` : 'no quote history', target: '> 0 average CLV' }
    ];
    const evidence = { metric, forward: forward.length, settled: settled.length, priced: priced.length, quote_coverage: quoteCoverage };
    const persistedAudit = persist ? recordGateAudit({ sport: 'MLB', market, modelVersion: VERSION[market], gates, evidence }) : null;
    if (persist) updateRegistry({ sport: 'MLB', market, role: 'challenger', modelVersion: VERSION[market],
      state: gates.every(x => x.passed) ? 'promotion_eligible' : 'blocked',
      reason: `${gates.filter(x => !x.passed).length}/${gates.length} promotion gates remain blocked at audit #${persistedAudit.id}.`, metrics: evidence });
    byMarket[market] = { model_version: VERSION[market], verdict: gates.every(x => x.passed) ? 'promotion_eligible' : 'blocked',
      gates, evidence, persisted_audit: persistedAudit };
  }
  return {
    sport: 'MLB', generated_at: new Date().toISOString(), through_date: throughDate,
    verdict: Object.values(byMarket).every(x => x.verdict === 'promotion_eligible') ? 'promotion_eligible' : 'blocked',
    markets: byMarket, audit, ledger, data_coverage: tableCoverage(), pregame, odds,
    registry: registry('MLB'), contracts: featureContracts('MLB'), experiments: listMlbExperiments(), calibrations: mlbCalibrations(throughDate),
    abstentions: rows(`SELECT COALESCE(abstention_reason,'eligible') reason,COUNT(*) decisions
      FROM mlb_pick_decisions GROUP BY COALESCE(abstention_reason,'eligible') ORDER BY decisions DESC`),
    gate_history: gateAudits('MLB', 20), manifests: evidenceManifests('MLB', 10)
  };
}
