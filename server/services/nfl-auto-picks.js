/**
 * NFL weekly auto-picks: the 5 most confident spread edges each week, each one
 * its own straight bet at 1 unit — no parlays, no moneyline/total mixed in.
 * Picks are locked in once made (idempotent per season/week) so they don't
 * silently change if the model or lines move later; grading reads the real
 * final score straight out of game_lines once ESPN reports the game final.
 */
import { db, rows, run } from '../db/index.js';
import { ensembleWeek } from './nfl-ensemble.js';
import { normalCdf } from './stats-util.js';
import { NFL_PRODUCTION_POLICY, applyNflPolicy } from './nfl-policy.js';

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
  ['quote_source', 'TEXT'], ['feature_snapshot_json', 'TEXT']
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
  candidates.forEach((b, i) => {
    run(`INSERT INTO nfl_auto_picks
        (season, week, rank, home_team, away_team, matchup, selection, side, line, american_price,
         model_probability, implied_probability, probability_difference, detail, units_staked, selected_at,
         policy_id, policy_version, book, quote_at, quote_source, feature_snapshot_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)
      ON CONFLICT(season, week, rank) DO NOTHING`,
      season, week, i + 1, b.home_team, b.away_team, b.matchup, b.selection, b.side, b.line, b.american_price,
      b.model_probability, b.implied_probability, b.probability_difference, b.detail, now,
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
export function autoPickDecisionBoard(season, week, policy = NFL_PRODUCTION_POLICY) {
  const prices = new Map(rows(`SELECT team, opponent, spread, spread_odds, source, fetched_at
                               FROM game_lines WHERE season=? AND week=?`, season, week)
    .map(x => [x.team, x]));
  const out = [];
  for (const game of ensembleWeek(season, week)) {
    const e = game.ensemble;
    const edge = e.spread_edge;
    const home = (edge ?? 0) > 0;
    const selection = home ? game.home : game.away;
    const quote = prices.get(selection);
    const opposite = prices.get(home ? game.away : game.home);
    const implied = noVigProbability(quote?.spread_odds, opposite?.spread_odds);
    // This remains an edge proxy until a dedicated cover calibration layer is
    // trained. Anchor it to the actual no-vig price so a -120 side is never
    // presented as a 50% market proposition.
    const incremental = edge == null ? null : normalCdf(Math.abs(edge) / 13.5) - 0.5;
    const modelProbability = implied == null || incremental == null ? null : Math.max(0.01, Math.min(0.99, implied + incremental));
    const activeModels = game.models.filter(m => m.margin != null && m.margin_weight > 0);
    out.push({
      market: 'spread', home_team: game.home, away_team: game.away,
      matchup: `${game.away} at ${game.home}`, selection,
      side: quote?.spread == null ? null : `${quote.spread > 0 ? '+' : ''}${quote.spread}`, line: quote?.spread ?? null,
      american_price: quote?.spread_odds ?? null,
      // Probability is calibrated conservatively from the incremental edge,
      // not the full predicted margin; the market remains the prior.
      model_probability: modelProbability,
      implied_probability: implied,
      probability_difference: incremental,
      detail: `Ensemble edge ${edge > 0 ? '+' : ''}${edge} · disagreement ${e.model_disagreement_margin}`,
      edge_points: edge == null ? null : Math.abs(edge), disagreement: e.model_disagreement_margin,
      book: quote?.source ?? null, quote_source: quote?.source ?? null, quote_at: quote?.fetched_at ?? null,
      feature_snapshot: {
        margin_models_active: activeModels.length,
        margin_models_available: game.models.length,
        active_model_ids: activeModels.map(m => m.id),
        unavailable_model_ids: game.models.filter(m => m.margin == null || !(m.margin_weight > 0)).map(m => m.id)
      }
    });
  }
  return applyNflPolicy(out, policy);
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

const americanToProbability = odds => odds == null ? null
  : (odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100));

function noVigProbability(odds, oppositeOdds) {
  const a = americanToProbability(odds), b = americanToProbability(oppositeOdds);
  return a != null && b != null && a + b > 0 ? a / (a + b) : null;
}

const americanToDecimal = odds => (odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds));

/**
 * Grades one pick against the real final score, already sitting in game_lines
 * once ESPN marks the game final. A pick's `selection` names which team the
 * spread `line` belongs to (the model may have preferred either side).
 */
function gradePick(p) {
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
  const graded = allPickResults();
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
