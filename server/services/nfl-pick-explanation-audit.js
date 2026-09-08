/** Immutable provenance for post-pick AI translations. */
import { createHash } from 'node:crypto';
import { rows, run } from '../db/index.js';

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
