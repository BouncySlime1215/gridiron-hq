/** Immutable paper-trading ledger. It is intentionally incapable of execution. */
import { db, row, rows, run } from '../db/index.js';
import { autoPickDecisionBoard } from './nfl-auto-picks.js';

db.exec(`CREATE TABLE IF NOT EXISTS shadow_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sport TEXT NOT NULL, event_key TEXT NOT NULL,
  market TEXT NOT NULL, selection TEXT, model_version TEXT NOT NULL,
  probability REAL, market_probability REAL, uncertainty REAL,
  regime TEXT, decision TEXT NOT NULL, reason TEXT NOT NULL,
  captured_at TEXT NOT NULL, settled_at TEXT, outcome_json TEXT,
  UNIQUE(sport,event_key,market,model_version,captured_at)
)`);

// The first version stored just enough to render a counter. That made the rows
// impossible to grade: neither the frozen line nor the scheduled teams were
// retained. Additive columns preserve every existing row while making every
// new observation a complete, independently labelable training example.
const columns = new Set(db.prepare('PRAGMA table_info(shadow_decisions)').all().map(x => x.name));
for (const [name, type] of [
  ['season', 'INTEGER'], ['week', 'INTEGER'], ['home_team', 'TEXT'], ['away_team', 'TEXT'],
  ['line', 'REAL'], ['american_price', 'INTEGER'], ['quote_at', 'TEXT'],
  ['feature_snapshot_json', 'TEXT'], ['result', 'TEXT'], ['clv_points', 'REAL']
]) {
  if (!columns.has(name)) db.exec(`ALTER TABLE shadow_decisions ADD COLUMN ${name} ${type}`);
}

const parseEventKey = value => {
  const [season, week, home, away] = String(value ?? '').split(':');
  return { season: Number(season), week: Number(week), home, away };
};
const r3 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(3);

export function recordNflShadowBoard(season, week, capturedAt = new Date().toISOString()) {
  const board = autoPickDecisionBoard(season, week);
  let recorded = 0, alreadyFrozen = 0;
  for (const d of board.decisions) {
    const eventKey = `${season}:${week}:${d.home_team ?? ''}:${d.away_team ?? ''}`;
    const modelVersion = `nfl-ensemble-v1-shadow:${board.policy.id}@${board.policy.version}`;
    // Evidence horizons preserve changing context and prices elsewhere. The
    // learning ledger needs one independent prediction per game/market/model,
    // not six correlated copies that make the sample look six times larger.
    const exists = row(`SELECT id FROM shadow_decisions
      WHERE sport='NFL' AND event_key=? AND market=? AND model_version=? LIMIT 1`,
    eventKey, d.market, modelVersion);
    if (exists) { alreadyFrozen++; continue; }
    run(`INSERT INTO shadow_decisions
      (sport,event_key,market,selection,model_version,probability,market_probability,uncertainty,
       regime,decision,reason,captured_at,season,week,home_team,away_team,line,american_price,
       quote_at,feature_snapshot_json)
      VALUES ('NFL',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    eventKey, d.market, d.selection ?? null, modelVersion,
    d.model_probability ?? null, d.implied_probability ?? null, d.disagreement ?? null,
    'unclassified', d.eligible ? 'observe' : 'abstain',
    d.abstention_reason ?? 'eligible_shadow_observation', capturedAt,
    season, week, d.home_team ?? null, d.away_team ?? null, d.line ?? null,
    d.american_price ?? null, d.quote_at ?? null, JSON.stringify(d.feature_snapshot ?? {}));
    recorded++;
  }
  return { recorded, already_frozen: alreadyFrozen, considered: board.decisions.length,
    selected: board.selected.length, mode: 'paper_only' };
}

/**
 * Attach final outcomes to frozen NFL decisions without changing what the
 * model knew. Abstentions are settled too: their counterfactual results are
 * useful for diagnosing a filter, but remain excluded from profit evidence.
 */
export function settleNflShadowDecisions() {
  const open = rows(`SELECT * FROM shadow_decisions
    WHERE sport='NFL' AND settled_at IS NULL ORDER BY captured_at`);
  let settled = 0, labeled = 0, malformed = 0;
  for (const decision of open) {
    const parsed = parseEventKey(decision.event_key);
    const season = decision.season ?? parsed.season;
    const week = decision.week ?? parsed.week;
    const home = decision.home_team ?? parsed.home;
    const away = decision.away_team ?? parsed.away;
    if (!Number.isInteger(season) || !Number.isInteger(week) || !home || !away) {
      malformed++;
      continue;
    }
    const game = row(`SELECT spread,total,team_score,opp_score FROM game_lines
      WHERE season=? AND week=? AND team=? AND home=1`, season, week, home);
    if (!game || game.team_score == null || game.opp_score == null) continue;

    const actualMargin = game.team_score - game.opp_score;
    const actualTotal = game.team_score + game.opp_score;
    let result = null, closingLine = null, clv = null;
    if (decision.market === 'spread' && decision.selection && Number.isFinite(decision.line)) {
      const backedHome = decision.selection === home;
      const sideMargin = backedHome ? actualMargin : -actualMargin;
      const cover = sideMargin + decision.line;
      result = cover === 0 ? 'Push' : cover > 0 ? 'Won' : 'Lost';
      closingLine = game.spread == null ? null : backedHome ? game.spread : -game.spread;
      clv = closingLine == null ? null : decision.line - closingLine;
    } else if (decision.market === 'total' && /^(over|under)$/i.test(decision.selection ?? '')
      && Number.isFinite(decision.line)) {
      const over = /^over$/i.test(decision.selection);
      result = actualTotal === decision.line ? 'Push'
        : (actualTotal > decision.line) === over ? 'Won' : 'Lost';
      closingLine = game.total;
      clv = closingLine == null ? null
        : over ? closingLine - decision.line : decision.line - closingLine;
    }
    const outcome = {
      season, week, home, away, actual_margin: actualMargin, actual_total: actualTotal,
      line_at_prediction: decision.line, closing_line: closingLine,
      result, selected_for_observation: decision.decision === 'observe'
    };
    run(`UPDATE shadow_decisions SET settled_at=?,outcome_json=?,result=?,clv_points=? WHERE id=?`,
    new Date().toISOString(), JSON.stringify(outcome), result, r3(clv), decision.id);
    settled++;
    if (result) labeled++;
  }
  return { settled, labeled, unscored: settled - labeled, still_open: open.length - settled, malformed };
}

export function shadowLedgerSummary(sport = 'NFL') {
  const counts = rows(`SELECT decision,COUNT(*) count FROM shadow_decisions WHERE sport=? GROUP BY decision`, sport);
  const total = counts.reduce((s, x) => s + x.count, 0);
  const selected = rows(`SELECT COUNT(*) count,
      SUM(CASE WHEN result IN ('Won','Lost','Push') THEN 1 ELSE 0 END) settled
    FROM shadow_decisions WHERE sport=? AND decision='observe'`, sport)[0] ?? {};
  const distinct = rows(`SELECT COUNT(DISTINCT event_key||'|'||market||'|'||model_version) count
    FROM shadow_decisions WHERE sport=?`, sport)[0]?.count ?? 0;
  return {
    total, independent_examples: Number(distinct), decisions: counts,
    settled: rows(`SELECT COUNT(*) count FROM shadow_decisions
      WHERE sport=? AND result IN ('Won','Lost','Push')`, sport)[0]?.count ?? 0,
    selected: Number(selected.count ?? 0), selected_settled: Number(selected.settled ?? 0),
    mode: 'paper_only'
  };
}
