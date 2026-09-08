/**
 * Immutable provenance for "what am I looking at" page/section explanations —
 * same discipline as nfl-pick-explanation-audit.js, but for a whole page or
 * section (Board, Pick Watch, Engine → Gates, ...) rather than a single pick.
 * `authority` stays 'wording_only': this call can only translate a frozen,
 * hashed summary of what's already on screen into prose, never add a fact or
 * make a call.
 */
import { createHash } from 'node:crypto';
import { rows, run } from '../db/index.js';

export const pageExplainHash = summary => createHash('sha256')
  .update(JSON.stringify(summary ?? {})).digest('hex');

export function recordPageExplanation({ route, section, subview, question, visibleSummary,
  translation, toolCalls = [], model = 'claude-haiku-4-5-20251001' }) {
  const summaryHash = pageExplainHash(visibleSummary);
  const result = run(`INSERT INTO nfl_page_explain_audits
    (route,section,subview,question,summary_hash,summary_json,translation_json,model,authority,tool_calls_json)
    VALUES (?,?,?,?,?,?,?,?,'wording_only',?)`, route, section ?? null, subview ?? null, question ?? null,
  summaryHash, JSON.stringify(visibleSummary ?? {}), JSON.stringify(translation), model, JSON.stringify(toolCalls ?? []));
  return {
    id: Number(result.lastInsertRowid), reasoning_hash: summaryHash,
    model, authority: 'wording_only', tool_calls: toolCalls ?? [],
    sequence: ['page state summarized by the client', 'summary frozen and hashed',
      ...(toolCalls?.length ? ['AI called read-only backend tools for real, current detail'] : []),
      'AI translated the summary into prose']
  };
}

export function recentPageExplanations({ limit = 50 } = {}) {
  return rows(`SELECT id,created_at,route,section,subview,question,summary_hash,model,authority,tool_calls_json
    FROM nfl_page_explain_audits ORDER BY id DESC LIMIT ?`, Math.min(200, Number(limit) || 50))
    .map(r => ({ ...r, tool_calls: JSON.parse(r.tool_calls_json ?? '[]'), tool_calls_json: undefined }));
}
