/**
 * Evidence provenance for the forward ledger (NEXT_SESSION_PLAN §5).
 *
 * Every frozen expert row carries an `evidence_cutoff` (the game's kickoff)
 * and a payload with the timestamps of what it read: news `published_at`,
 * quote `captured_at`, archive `available_at`, book `book_updated_at`. This
 * walks each payload and flags any timestamp later than the cutoff, per
 * role and per game, so a late, undated or reconstructed input cannot sit
 * inside a "pregame" card unnoticed. It is a read-only check; a flagged row
 * stays in the ledger with its flag.
 */
import { rows } from '../db/index.js';

const STAMP_KEY = /(^|_)(published_at|captured_at|available_at|book_updated_at|quote_at|occurred_at|modified_at|at)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Every (key path, ISO timestamp) inside a payload. Pure. */
export function collectTimestamps(value, path = '', out = []) {
  if (Array.isArray(value)) { value.slice(0, 200).forEach((item, index) => collectTimestamps(item, `${path}[${index}]`, out)); return out; }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const next = path ? `${path}.${key}` : key;
      if (typeof child === 'string' && STAMP_KEY.test(key) && ISO.test(child)) out.push({ path: next, at: child });
      else if (child && typeof child === 'object') collectTimestamps(child, next, out);
    }
  }
  return out;
}

/** Check one frozen row: late stamps (after the cutoff) and whether it carried any stamp at all. */
export function checkRow(row) {
  let payload = null;
  try { payload = JSON.parse(row.payload_json || '{}'); } catch { payload = null; }
  const stamps = payload ? collectTimestamps(payload) : [];
  const cutoff = row.evidence_cutoff;
  const late = stamps.filter(s => cutoff && s.at > cutoff);
  return { expert_id: row.expert_id, horizon: row.horizon, observed: Boolean(row.observed), stamps: stamps.length, late,
    state: late.length ? 'late_evidence' : stamps.length ? 'stamped' : row.observed ? 'undated' : 'abstained' };
}

export function verifyForwardEvidence({ season = null, week = null, limit = 5000 } = {}) {
  const where = [], params = [];
  if (season != null) { where.push('season=?'); params.push(season); }
  if (week != null) { where.push('week=?'); params.push(week); }
  const list = rows(`SELECT id, season, week, home, away, expert_id, horizon, observed, evidence_cutoff, captured_at, payload_json
    FROM nfl_expert_forward_predictions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY season, week, home, expert_id LIMIT ?`, ...params, limit);
  const byExpert = {};
  const flagged = [];
  let capturedAfterCutoff = 0;
  for (const row of list) {
    const c = checkRow(row);
    const e = byExpert[row.expert_id] ?? (byExpert[row.expert_id] = { rows: 0, stamped: 0, undated: 0, abstained: 0, late_evidence: 0 });
    e.rows++; e[c.state]++;
    if (row.captured_at && row.evidence_cutoff && row.captured_at > row.evidence_cutoff) capturedAfterCutoff++;
    if (c.late.length) flagged.push({ id: row.id, game: `${row.season} W${row.week} ${row.away} at ${row.home}`, expert_id: row.expert_id, horizon: row.horizon,
      cutoff: row.evidence_cutoff, late: c.late.slice(0, 5) });
  }
  return { rows: list.length, games: new Set(list.map(r => `${r.season}|${r.week}|${r.home}`)).size,
    by_expert: byExpert, flagged_rows: flagged.length, captured_after_cutoff: capturedAfterCutoff, flagged: flagged.slice(0, 100),
    verdict: flagged.length || capturedAfterCutoff ? 'late evidence found; see flagged' : 'every stamped input predates its kickoff',
    rule: 'Every timestamp inside a frozen payload must precede the row\'s evidence_cutoff. Undated observed rows are listed, not assumed clean.' };
}
