/** Immutable paper-trading ledger. It is intentionally incapable of execution. */
import { db, rows, run } from '../db/index.js';
import { autoPickDecisionBoard } from './nfl-auto-picks.js';

db.exec(`CREATE TABLE IF NOT EXISTS shadow_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sport TEXT NOT NULL, event_key TEXT NOT NULL,
  market TEXT NOT NULL, selection TEXT, model_version TEXT NOT NULL,
  probability REAL, market_probability REAL, uncertainty REAL,
  regime TEXT, decision TEXT NOT NULL, reason TEXT NOT NULL,
  captured_at TEXT NOT NULL, settled_at TEXT, outcome_json TEXT,
  UNIQUE(sport,event_key,market,model_version,captured_at)
)`);

export function recordNflShadowBoard(season, week, capturedAt = new Date().toISOString()) {
  const board = autoPickDecisionBoard(season, week);
  for (const d of board.decisions) {
    run(`INSERT INTO shadow_decisions
      (sport,event_key,market,selection,model_version,probability,market_probability,uncertainty,regime,decision,reason,captured_at)
      VALUES ('NFL',?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      `${season}:${week}:${d.home_team ?? ''}:${d.away_team ?? ''}`, d.market, d.selection ?? null,
      'nfl-ensemble-v1-shadow', d.model_probability ?? null, d.implied_probability ?? null, d.disagreement ?? null,
      'unclassified', d.eligible ? 'observe' : 'abstain', d.abstention_reason ?? 'eligible_shadow_observation', capturedAt);
  }
  return { recorded: board.decisions.length, selected: board.selected.length, mode: 'paper_only' };
}

export function shadowLedgerSummary(sport = 'NFL') {
  const counts = rows(`SELECT decision,COUNT(*) count FROM shadow_decisions WHERE sport=? GROUP BY decision`, sport);
  const total = counts.reduce((s, x) => s + x.count, 0);
  return { total, decisions: counts, settled: rows(`SELECT COUNT(*) count FROM shadow_decisions WHERE sport=? AND settled_at IS NOT NULL`, sport)[0]?.count ?? 0,
    mode: 'paper_only' };
}
