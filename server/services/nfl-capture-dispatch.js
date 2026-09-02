/**
 * Spend metered odds credits only after free evidence says the market moved.
 * Triggers are durable: a closed laptop or exhausted quota defers work instead
 * of silently losing the news/movement event that made a capture valuable.
 */
import { db, rows, run } from '../db/index.js';
import { hasKey, usage } from './odds-api.js';

function ensureCaptureTriggerTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_capture_triggers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,source TEXT NOT NULL,
    source_ref TEXT NOT NULL,event_id TEXT NOT NULL,team TEXT,reason TEXT NOT NULL,
    priority REAL NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending',attempted_at TEXT,
    snapshot_at TEXT,outcome_json TEXT,UNIQUE(source,source_ref,event_id));
    CREATE INDEX IF NOT EXISTS idx_capture_triggers_state
      ON nfl_capture_triggers(state,priority DESC,created_at);`);
}

const RESERVE = 50;
const COOLDOWN_MINUTES = 15;
const now = () => new Date().toISOString();

export function enqueueEspnMoveTriggers(detected = [], observedAt = now()) {
  ensureCaptureTriggerTable();
  let queued = 0;
  for (const move of detected) {
    const priority = Math.max(Math.abs(Number(move.move_value) || 0), Math.abs(Number(move.spread_delta) || 0) / 100);
    if (priority < 0.01 && Math.abs(Number(move.spread_delta) || 0) < 1) continue;
    const result = run(`INSERT INTO nfl_capture_triggers
      (created_at,source,source_ref,event_id,reason,priority,state)
      VALUES (?,'espn_move',?,?,?,?, 'pending') ON CONFLICT DO NOTHING`,
    observedAt, `${move.event_id}|${observedAt}`, move.event_id,
    `Free ESPN reference moved ${move.spread_delta ?? 0} points`, priority);
    queued += result.changes ?? 0;
  }
  return { queued };
}

/** Queue newly typed, material claims against the latest ESPN-tracked event. */
export function enqueueRecentNewsTriggers({ minutes = 120 } = {}) {
  ensureCaptureTriggerTable();
  const signals = rows(`SELECT news_id,team,signal_type,status,confidence,published_at
    FROM nfl_news_signals
    WHERE verification_state='verified' AND created_at>=datetime('now',?) AND team IS NOT NULL
      AND (unavailable_probability>=0.5 OR ABS(COALESCE(role_delta,0))>=0.15)`, `-${minutes} minutes`);
  const hasMoveLog = rows(`SELECT name FROM sqlite_master WHERE type='table' AND name='espn_line_moves'`).length > 0;
  const events = hasMoveLog ? rows(`SELECT event_id,home_team,away_team
    FROM espn_line_moves WHERE id IN (SELECT MAX(id) FROM espn_line_moves GROUP BY event_id)`) : [];
  let queued = 0;
  for (const signal of signals) {
    for (const event of events.filter(game => game.home_team === signal.team || game.away_team === signal.team)) {
      const sourceRef = `${signal.news_id}|${signal.signal_type}|${signal.status}`;
      const result = run(`INSERT INTO nfl_capture_triggers
        (created_at,source,source_ref,event_id,team,reason,priority,state)
        VALUES (?,'news_signal',?,?,?,?,?,'pending') ON CONFLICT DO NOTHING`,
      now(), sourceRef, event.event_id, signal.team,
      `${signal.team} ${signal.signal_type}: ${signal.status}`, Number(signal.confidence) || 0);
      queued += result.changes ?? 0;
    }
  }
  return { reviewed: signals.length, queued };
}

export async function dispatchTriggeredCapture() {
  ensureCaptureTriggerTable();
  const pending = rows(`SELECT * FROM nfl_capture_triggers
    WHERE state IN ('pending','deferred') ORDER BY priority DESC,created_at LIMIT 100`);
  if (!pending.length) return { pending: 0, captured: 0, reason: 'no movement or news trigger is waiting' };
  // Scope every state change to the exact rows just selected. The `LIMIT 100`
  // above can leave real pending/deferred rows outside this batch, and a bare
  // `WHERE state IN (...)` update marked ALL of them captured — including
  // events this dispatch never considered — so a later genuine move for one
  // of those excess events found it already (falsely) marked captured.
  const ids = pending.map(p => p.id);
  const placeholders = ids.map(() => '?').join(',');
  const defer = reason => {
    run(`UPDATE nfl_capture_triggers SET state='deferred',attempted_at=?,outcome_json=?
      WHERE id IN (${placeholders})`, now(), JSON.stringify({ reason }), ...ids);
    return { pending: pending.length, captured: 0, deferred: pending.length, reason };
  };
  if (!hasKey()) return defer('no ODDS_API_KEY configured');
  const credits = usage().requests_remaining;
  if (credits != null && credits <= RESERVE) return defer(`holding the final ${credits} credits; reserve is ${RESERVE}`);
  const latest = rows(`SELECT MAX(snapshot_at) at FROM nfl_capture_triggers WHERE state='captured'`)[0]?.at;
  if (latest && Date.now() - new Date(latest).getTime() < COOLDOWN_MINUTES * 60000) {
    return defer(`last triggered capture was under ${COOLDOWN_MINUTES} minutes ago`);
  }

  const attemptedAt = now();
  try {
    const { snapshotLines } = await import('./line-shopping.js');
    const outcome = await snapshotLines({ markets: 'spreads,totals' });
    if (outcome?.error) return defer(outcome.error);
    run(`UPDATE nfl_capture_triggers SET state='captured',attempted_at=?,snapshot_at=?,outcome_json=?
      WHERE id IN (${placeholders})`, attemptedAt, outcome.captured_at, JSON.stringify(outcome), ...ids);
    return { pending: pending.length, captured: pending.length, snapshot: outcome };
  } catch (error) {
    run(`UPDATE nfl_capture_triggers SET state='failed',attempted_at=?,outcome_json=?
      WHERE id IN (${placeholders})`, attemptedAt, JSON.stringify({ error: error.message }), ...ids);
    return { pending: pending.length, captured: 0, failed: pending.length, error: error.message };
  }
}

export function captureTriggerStatus() {
  ensureCaptureTriggerTable();
  const byState = rows(`SELECT state,COUNT(*) n FROM nfl_capture_triggers GROUP BY state`);
  return { by_state: Object.fromEntries(byState.map(item => [item.state, item.n])),
    recent: rows(`SELECT id,created_at,source,event_id,team,reason,priority,state,snapshot_at
      FROM nfl_capture_triggers ORDER BY id DESC LIMIT 20`), reserve: RESERVE,
    note: 'Free ESPN movement and typed news enqueue captures. Paid multi-book pricing runs only above the reserve and collapses simultaneous triggers into one slate request.' };
}
