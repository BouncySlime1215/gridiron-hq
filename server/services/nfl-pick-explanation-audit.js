/** Immutable provenance for post-pick AI translations. */
import { createHash } from 'node:crypto';
import { db, rows, run } from '../db/index.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_pick_explanation_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    matchup TEXT,
    market TEXT NOT NULL,
    selection TEXT,
    reasoning_hash TEXT NOT NULL,
    reasoning_json TEXT NOT NULL,
    translation_json TEXT NOT NULL,
    model TEXT NOT NULL,
    authority TEXT NOT NULL DEFAULT 'wording_only'
  );
  CREATE INDEX IF NOT EXISTS idx_pick_explanation_lookup
    ON nfl_pick_explanation_audits(season,week,matchup,market,selection,created_at);
`);

export const explanationReasoningHash = reasoning => createHash('sha256')
  .update(JSON.stringify(reasoning)).digest('hex');

export function recordPickExplanation({ season, week, matchup, market, selection,
  reasoning, translation, model = 'claude-haiku-4-5-20251001' }) {
  const reasoningHash = explanationReasoningHash(reasoning);
  const result = run(`INSERT INTO nfl_pick_explanation_audits
    (season,week,matchup,market,selection,reasoning_hash,reasoning_json,translation_json,model,authority)
    VALUES (?,?,?,?,?,?,?,?,?,'wording_only')`, season, week, matchup ?? null, market,
  selection ?? null, reasoningHash, JSON.stringify(reasoning), JSON.stringify(translation), model);
  return {
    id: Number(result.lastInsertRowid), reasoning_hash: reasoningHash,
    model, authority: 'wording_only',
    sequence: ['deterministic pick selected', 'factor packet frozen and hashed', 'AI translated packet into prose']
  };
}

export function recentPickExplanations({ limit = 50 } = {}) {
  return rows(`SELECT id,created_at,season,week,matchup,market,selection,reasoning_hash,model,authority
    FROM nfl_pick_explanation_audits ORDER BY id DESC LIMIT ?`, Math.min(200, Number(limit) || 50));
}
