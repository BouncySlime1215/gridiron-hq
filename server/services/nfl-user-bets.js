/**
 * User-tracked bets: a game from the full slate (not just the curated
 * top-5 auto-picks) that the user chose to bet themselves. Same grading
 * rules as the auto-pick engine, kept in a separate table so a user's own
 * action never contaminates the model's own graded track record.
 */
import { db, rows, run } from '../db/index.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_user_bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL, week INTEGER NOT NULL,
    matchup TEXT NOT NULL, market TEXT NOT NULL,
    selection TEXT NOT NULL, side TEXT, line REAL, american_price INTEGER,
    model_probability REAL, implied_probability REAL, edge REAL,
    units_staked REAL DEFAULT 1, note TEXT, placed_at TEXT NOT NULL
  );
`);

export function addUserBet(season, week, bet) {
  if (bet.market !== 'spread') throw new Error('Only spread grading is supported today.');
  if (!bet.matchup || !bet.selection || bet.line == null || bet.american_price == null) {
    throw new Error('matchup, selection, line and american_price are required.');
  }
  const units = Number(bet.units_staked) > 0 ? Number(bet.units_staked) : 1;
  const { lastInsertRowid } = run(`INSERT INTO nfl_user_bets
      (season, week, matchup, market, selection, side, line, american_price,
       model_probability, implied_probability, edge, units_staked, note, placed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    season, week, bet.matchup, bet.market, bet.selection, bet.side ?? null, bet.line, bet.american_price,
    bet.model_probability ?? null, bet.implied_probability ?? null, bet.edge ?? null, units,
    bet.note ?? null, new Date().toISOString());
  return { id: Number(lastInsertRowid) };
}

export function removeUserBet(id) {
  const info = run('DELETE FROM nfl_user_bets WHERE id = ?', id);
  return { removed: info.changes > 0 };
}

const americanToDecimal = odds => (odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds));

function gradeBet(b) {
  const result = rows(
    `SELECT team_score, opp_score FROM game_lines WHERE season = ? AND week = ? AND team = ?`,
    b.season, b.week, b.selection
  )[0];
  if (!result || result.team_score == null) return { status: 'Pending', units: 0 };
  const margin = result.team_score - result.opp_score;
  const pushed = margin === -b.line;
  if (pushed) return { status: 'Push', units: 0 };
  const covered = margin > -b.line;
  if (!covered) return { status: 'Lost', units: -b.units_staked };
  return { status: 'Won', units: b.units_staked * (americanToDecimal(b.american_price) - 1) };
}

export function userBetsFor(season, week) {
  const bets = rows('SELECT * FROM nfl_user_bets WHERE season = ? AND week = ? ORDER BY placed_at', season, week);
  return bets.map(b => ({ ...b, ...gradeBet(b) }));
}

export function allUserBets() {
  const bets = rows('SELECT * FROM nfl_user_bets ORDER BY season DESC, week DESC, placed_at DESC');
  return bets.map(b => ({ ...b, ...gradeBet(b) }));
}

export function userBetsStanding() {
  const graded = allUserBets();
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
