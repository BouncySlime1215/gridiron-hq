/**
 * Immutable provenance for "what am I looking at" page/section explanations —
 * same discipline as nfl-pick-explanation-audit.js, but for a whole page or
 * section (Board, Pick Watch, Engine → Gates, ...) rather than a single pick.
 * `authority` stays 'wording_only': this call can only translate a frozen,
 * hashed summary of what's already on screen into prose, never add a fact or
 * make a call.
 */
import { createHash } from 'node:crypto';
import { db, rows, run } from '../db/index.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_page_explain_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    route TEXT NOT NULL,
    section TEXT,
    subview TEXT,
    question TEXT,
    summary_hash TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    translation_json TEXT NOT NULL,
    model TEXT NOT NULL,
    authority TEXT NOT NULL DEFAULT 'wording_only'
  );
  CREATE INDEX IF NOT EXISTS idx_page_explain_lookup
    ON nfl_page_explain_audits(route,section,subview,created_at);
`);

// Column added after the table shipped, for the tool-use loop: which
// read-only backend tools (names + params, never full results) Claude called
// while answering. CREATE TABLE IF NOT EXISTS does nothing to an existing
// table, so an install with rows filed before this change needs the ALTER.
try { run(`ALTER TABLE nfl_page_explain_audits ADD COLUMN tool_calls_json TEXT`); } catch { /* already present */ }

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
