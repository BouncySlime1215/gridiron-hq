/**
 * NFL weekly auto-picks: the 5 most confident spread edges each week, each one
 * its own straight bet at 1 unit — no parlays, no moneyline/total mixed in.
 * Picks are locked in once made (idempotent per season/week) so they don't
 * silently change if the model or lines move later; grading reads the real
 * final score straight out of game_lines once ESPN reports the game final.
 */
import { db, rows, run } from '../db/index.js';
import { ensembleWeek } from './nfl-ensemble.js';
import { NFL_PRODUCTION_POLICY, applyNflPolicy } from './nfl-policy.js';
import { calibratedCoverProbability } from './nfl-cover-calibration.js';
import { pregameSnapshotFor } from './nfl-pregame.js';
import { onlineNeuralPrediction } from './nfl-online-neural.js';
import { shinNoVig } from './nfl-devig.js';

const COORDINATED_DECISION_VERSION = 'coordinated-market-residual-v1';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_auto_picks (
    season INTEGER NOT NULL, week INTEGER NOT NULL, rank INTEGER NOT NULL,
    home_team TEXT, away_team TEXT, matchup TEXT,
    selection TEXT, side TEXT, line REAL, american_price INTEGER,
    model_probability REAL, implied_probability REAL, probability_difference REAL,
    detail TEXT, units_staked REAL DEFAULT 1, selected_at TEXT NOT NULL,
    PRIMARY KEY (season, week, rank)
  );
`);

for (const [name, type] of [
  ['policy_id', 'TEXT'], ['policy_version', 'TEXT'], ['book', 'TEXT'], ['quote_at', 'TEXT'],
  ['quote_source', 'TEXT'], ['feature_snapshot_json', 'TEXT'],
  // A locked pick is a ledger entry and must never silently vanish, but a pick
  // locked under a policy that no longer exists is not a live position either.
  // Voiding keeps the row and its history while removing it from the standing.
  ['voided_at', 'TEXT'], ['void_reason', 'TEXT']
]) {
  const cols = db.prepare('PRAGMA table_info(nfl_auto_picks)').all().map(c => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE nfl_auto_picks ADD COLUMN ${name} ${type}`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_pick_decisions (
    season INTEGER NOT NULL, week INTEGER NOT NULL, policy_id TEXT NOT NULL,
    policy_version TEXT NOT NULL, matchup TEXT NOT NULL, selection TEXT,
    market TEXT NOT NULL, line REAL, american_price INTEGER, book TEXT,
    quote_at TEXT, quote_source TEXT, edge REAL, disagreement REAL,
    eligible INTEGER NOT NULL, abstention_reason TEXT, policy_rank INTEGER,
    feature_snapshot_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
    PRIMARY KEY (season, week, policy_id, matchup, market, selection)
  );
`);

/** Locks in this week's top-5 spread picks, if they don't already exist. */
export function ensurePicksFor(season, week, board, count = 5) {
  const existing = rows('SELECT * FROM nfl_auto_picks WHERE season = ? AND week = ? ORDER BY rank', season, week);
  if (existing.length) return existing;

  const candidates = board.filter(b => b.market === 'spread').slice(0, count);
  if (!candidates.length) return [];

  const now = new Date().toISOString();
  // Model-derived stake is zero until a market clears the forward gates
  // (PROFITABILITY_PLAN §8). The row is still a frozen, gradeable decision; it
  // simply carries no units, so the standing it feeds cannot pretend to be P&L.
  const units = Number(process.env.NFL_MODEL_STAKE_UNITS) || 0;
  candidates.forEach((b, i) => {
    run(`INSERT INTO nfl_auto_picks
        (season, week, rank, home_team, away_team, matchup, selection, side, line, american_price,
         model_probability, implied_probability, probability_difference, detail, units_staked, selected_at,
         policy_id, policy_version, book, quote_at, quote_source, feature_snapshot_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(season, week, rank) DO NOTHING`,
      season, week, i + 1, b.home_team, b.away_team, b.matchup, b.selection, b.side, b.line, b.american_price,
      b.model_probability, b.implied_probability, b.probability_difference, b.detail, units, now,
      NFL_PRODUCTION_POLICY.id, NFL_PRODUCTION_POLICY.version, b.book ?? null, b.quote_at ?? null,
      b.quote_source ?? null, JSON.stringify(b.feature_snapshot ?? {}));
  });
  return rows('SELECT * FROM nfl_auto_picks WHERE season = ? AND week = ? ORDER BY rank', season, week);
}

/**
 * The production auto-pick slate uses the same frozen policy as the blind
 * replay. This closes the old gap where the Training page graded the ensemble
 * but the Auto Picks button silently used a separate single-ratings board.
 */
/**
 * The decision board is deterministic given the week's lines and the fitted
 * models, but computing it walks the whole ensemble per game and takes 15-30
 * seconds. Node is single-threaded, so that is not merely a slow page — it
 * blocks the event loop and every other request on the server queues behind it.
 * Opening the hub while it ran froze the entire app, including endpoints that
 * answer in milliseconds on their own.
 *
 * Keyed on a fingerprint of the underlying rows rather than a TTL, so it is
 * correct by construction: any line sync changes `fetched_at`, the key misses,
 * and the board recomputes. A TTL would have had to choose between serving a
 * stale board and recomputing needlessly.
 */
const _boardCache = new Map();
export function clearAutoPickBoardCache() { _boardCache.clear(); }

function boardFingerprint(season, week) {
  const g = rows(`SELECT COUNT(*) n, COALESCE(MAX(fetched_at),'') fetched, COALESCE(SUM(spread),0) s
                  FROM game_lines WHERE season = ? AND week = ?`, season, week)[0];
  return `${g.n}:${g.fetched}:${g.s}`;
}

export function autoPickDecisionBoard(season, week, policy = NFL_PRODUCTION_POLICY, modelOptions = {}) {
  modelOptions = { blendMode: 'market_residual', ...modelOptions };
  const engineMode = modelOptions.includeChallengers ? 'candidate' : 'champion';
  const modelKey = JSON.stringify(Object.fromEntries(Object.entries(modelOptions).sort(([a], [b]) => a.localeCompare(b))));
  const key = `${season}:${week}:${policy.id}:${policy.version}:${engineMode}:${modelKey}:${boardFingerprint(season, week)}`;
  if (_boardCache.has(key)) return _boardCache.get(key);
  const computed = computeDecisionBoard(season, week, policy, modelOptions);
  // One week at a time is all that is ever asked for; keeping the map small
  // matters more than keeping history nobody reads.
  if (_boardCache.size > 8) _boardCache.clear();
  _boardCache.set(key, computed);
  return computed;
}

function computeDecisionBoard(season, week, policy = NFL_PRODUCTION_POLICY, modelOptions = {}) {
  const prices = new Map(rows(`SELECT team, opponent, spread, spread_odds, source, fetched_at
                               FROM game_lines WHERE season=? AND week=?`, season, week)
    .map(x => [x.team, x]));
  const out = [];
  for (const game of ensembleWeek(season, week, modelOptions)) {
    const e = game.ensemble;
    const neural = onlineNeuralPrediction(game);
    const neuralUsed = modelOptions.includeChallengers || neural.production_eligible === true;
    const marketMargin = e.market_spread == null ? null : -e.market_spread;
    const projectedMargin = neuralUsed && neural.predicted_margin != null
      ? neural.predicted_margin : e.projected_margin;
    const edge = projectedMargin == null || marketMargin == null ? null : projectedMargin - marketMargin;
    const home = (edge ?? 0) > 0;
    const selection = home ? game.home : game.away;
    const quote = prices.get(selection);
    const opposite = prices.get(home ? game.away : game.home);
    const implied = noVigProbability(quote?.spread_odds, opposite?.spread_odds);
    // Look the calibration up under the version the calibrator actually writes.
    // Asking for the coordinated-head version string matched no row ever, so the
    // stored walk-forward audit was never consulted and every abstention read
    // "calibration_not_proven" for the wrong reason. The decision-head version is
    // still recorded in the frozen snapshot below.
    const calibrated = calibratedCoverProbability({ season, marketProbability: implied,
      edgePoints: edge == null ? null : Math.abs(edge) });
    const modelProbability = calibrated.probability;
    const incremental = modelProbability == null || implied == null ? null : modelProbability - implied;
    // Do not let an uncalibrated forecast masquerade as a betting signal. A
    // null probability is intentional: the walk-forward calibration audit has
    // not proven that the ensemble improves on the market, so this game is an
    // auditable abstention rather than a lower-confidence recommendation.
    const calibrationEligible = modelProbability != null && incremental != null && incremental > 0;
    const activeModels = game.models.filter(m => m.margin != null && m.margin_weight > 0);
    const pregame = pregameSnapshotFor(season, week, selection);
    out.push({
      market: 'spread', home_team: game.home, away_team: game.away,
      matchup: `${game.away} at ${game.home}`, selection,
      side: quote?.spread == null ? null : `${quote.spread > 0 ? '+' : ''}${quote.spread}`, line: quote?.spread ?? null,
      american_price: quote?.spread_odds ?? null,
      // The no-vig market probability is the prior. Historical cover outcomes
      // calibrate how much incremental probability a model edge has earned.
      model_probability: modelProbability,
      implied_probability: implied,
      probability_difference: incremental,
      calibration_eligible: calibrationEligible,
      detail: `Ensemble edge ${edge > 0 ? '+' : ''}${edge} · disagreement ${e.model_disagreement_margin}`,
      edge_points: edge == null ? null : Math.abs(edge), disagreement: e.model_disagreement_margin,
      book: quote?.source ?? null, quote_source: quote?.source ?? null, quote_at: quote?.fetched_at ?? null,
      feature_snapshot: {
        margin_models_active: activeModels.length,
        margin_models_available: game.models.length,
        active_model_ids: activeModels.map(m => m.id),
        unavailable_model_ids: game.models.filter(m => m.margin == null || !(m.margin_weight > 0)).map(m => m.id),
        cover_calibration: calibrated.calibration
          ? `${calibrated.calibration.model_version}:${calibrated.calibration.trained_from}-${calibrated.calibration.trained_through}` : null,
        predictive_distribution: e.distribution ?? null,
        coordinated_decision_head: {
          version: COORDINATED_DECISION_VERSION,
          target: 'actual margin minus pregame market margin', base_blend: e.blend_mode,
          neural: { version: neural.version ?? null, residual: neural.residual ?? null,
            authority: neural.authority ?? 'unavailable', used: Boolean(neuralUsed) },
          production_rule: 'market-residual base; neural output only after its forward gate passes'
        },
        input_mode: game.input_mode,
        reliability_controller: game.reliability_controller,
        model_trace: game.models.map(model => ({ id: model.id, family: model.family,
          challenger_only: model.challenger_only, margin: model.margin, total: model.total,
          base_margin_weight: model.base_margin_weight,
          reliability_multiplier: model.reliability_multiplier,
          margin_weight: model.margin_weight, total_weight: model.total_weight })),
        player_availability_shadow: e.player_availability ?? null,
        pregame_snapshot_at: pregame?.captured_at ?? null,
        pregame_context: pregame?.feature_coverage ?? null
      }
    });
  }
  return { ...applyNflPolicy(out, policy),
    engine_mode: modelOptions.includeChallengers ? 'candidate' : 'champion' };
}

export function autoPickCandidates(season, week, policy = NFL_PRODUCTION_POLICY) {
  return autoPickDecisionBoard(season, week, policy).selected;
}

export function persistPickDecisions(season, week, decisionBoard) {
  const at = new Date().toISOString();
  for (const d of decisionBoard.decisions) {
    run(`INSERT INTO nfl_pick_decisions
      (season,week,policy_id,policy_version,matchup,selection,market,line,american_price,book,
       quote_at,quote_source,edge,disagreement,eligible,abstention_reason,policy_rank,feature_snapshot_json,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(season,week,policy_id,matchup,market,selection) DO UPDATE SET
       line=excluded.line,american_price=excluded.american_price,book=excluded.book,
       quote_at=excluded.quote_at,quote_source=excluded.quote_source,edge=excluded.edge,
       disagreement=excluded.disagreement,eligible=excluded.eligible,
       abstention_reason=excluded.abstention_reason,policy_rank=excluded.policy_rank,
       feature_snapshot_json=excluded.feature_snapshot_json,recorded_at=excluded.recorded_at`,
      season, week, decisionBoard.policy.id, decisionBoard.policy.version, d.matchup, d.selection,
      d.market, d.line, d.american_price, d.book, d.quote_at, d.quote_source, d.edge_points,
      d.disagreement, d.eligible ? 1 : 0, d.abstention_reason, d.policy_rank ?? null,
      JSON.stringify(d.feature_snapshot ?? {}), at);
  }
  return { recorded_at: at, decisions: decisionBoard.decisions.length };
}

/** No-vig fair probability, via Shin's method (see nfl-devig.js). */
function noVigProbability(odds, oppositeOdds) {
  return shinNoVig(odds, oppositeOdds);
}

const americanToDecimal = odds => (odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds));

/**
 * Grades one pick against the real final score, already sitting in game_lines
 * once ESPN marks the game final. A pick's `selection` names which team the
 * spread `line` belongs to (the model may have preferred either side).
 */
function gradePick(p) {
  // Checked before the score lookup: a voided pick stays voided even once the
  // game finishes, otherwise it would quietly rejoin the record on Sunday.
  if (p.voided_at) return { status: 'Void', units: 0 };
  const result = rows(
    `SELECT team, team_score, opp_score FROM game_lines
     WHERE season = ? AND week = ? AND team = ?`,
    p.season, p.week, p.selection
  )[0];
  if (!result || result.team_score == null) return { status: 'Pending', units: 0 };

  const margin = result.team_score - result.opp_score; // positive = `selection` won by this much
  const covered = margin > -p.line;
  const pushed = margin === -p.line;
  if (pushed) return { status: 'Push', units: 0 };
  if (!covered) return { status: 'Lost', units: -p.units_staked };
  return { status: 'Won', units: p.units_staked * (americanToDecimal(p.american_price) - 1) };
}

/** Every pick for one week, graded. */
export function pickResultsFor(season, week) {
  const picks = rows('SELECT * FROM nfl_auto_picks WHERE season = ? AND week = ? ORDER BY rank', season, week);
  return picks.map(p => ({ ...p, ...gradePick(p) }));
}

/** Full history across every week tracked so far, graded. */
export function allPickResults() {
  const picks = rows('SELECT * FROM nfl_auto_picks ORDER BY season DESC, week DESC, rank ASC');
  return picks.map(p => ({ ...p, ...gradePick(p) }));
}

/** Record / units across everything settled so far — "where we stand". */
export function standing() {
  // Voided picks are excluded from the record entirely — not counted as losses,
  // not counted as pending. They are history, not positions.
  const graded = allPickResults().filter(g => g.status !== 'Void');
  const settled = graded.filter(g => g.status === 'Won' || g.status === 'Lost');
  const wins = settled.filter(g => g.status === 'Won').length;
  const losses = settled.filter(g => g.status === 'Lost').length;
  const pushes = graded.filter(g => g.status === 'Push').length;
  const units = graded.reduce((s, g) => s + g.units, 0);
  return {
    wins, losses, pushes,
    win_rate: settled.length ? +(wins / settled.length).toFixed(4) : null,
    units: +units.toFixed(2),
    weeks_tracked: new Set(graded.map(g => `${g.season}-${g.week}`)).size
  };
}
