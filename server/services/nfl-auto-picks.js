/**
 * NFL weekly auto-picks: the 5 most confident spread edges each week, each one
 * its own straight bet at 1 unit — no parlays, no moneyline/total mixed in.
 * Picks are locked in once made (idempotent per season/week) so they don't
 * silently change if the model or lines move later; grading reads the real
 * final score straight out of game_lines once ESPN reports the game final.
 */
import { db, rows, run } from '../db/index.js';

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
         model_probability, implied_probability, probability_difference, detail, units_staked, selected_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
      ON CONFLICT(season, week, rank) DO NOTHING`,
      season, week, i + 1, b.home_team, b.away_team, b.matchup, b.selection, b.side, b.line, b.american_price,
      b.model_probability, b.implied_probability, b.probability_difference, b.detail, now);
  });
  return rows('SELECT * FROM nfl_auto_picks WHERE season = ? AND week = ? ORDER BY rank', season, week);
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
