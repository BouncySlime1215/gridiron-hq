/**
 * Every answer Coach has given, verified or not.
 *
 * The rejected ones are the point. A grounding check whose failures are not
 * written down is a claim about quality rather than a measurement of it: this
 * table is what turns "Coach does not hallucinate" into a rate anyone can
 * read. `nfl_page_explain_audits` does the same job for the betting
 * explainer; this is its fantasy counterpart and deliberately separate,
 * because the columns that matter here (what failed, how many numbers were
 * checked, whether a retry saved it) do not exist there.
 */
import { db, rows, row, run } from '../../db/index.js';

db.exec(`CREATE TABLE IF NOT EXISTS coach_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asked_at TEXT NOT NULL DEFAULT (datetime('now')),
  question TEXT NOT NULL,
  route TEXT,
  league_id INTEGER,
  model TEXT,
  answer_json TEXT NOT NULL,
  ledger_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  verified INTEGER NOT NULL,
  retried INTEGER NOT NULL,
  numbers_checked INTEGER NOT NULL,
  violations_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  cost_usd REAL)`);

export function recordCoachAnswer({ question, route = null, leagueId = null, model = null,
  answer, ledger, plan, verification, costUsd = null }) {
  run(`INSERT INTO coach_answers
       (question, route, league_id, model, answer_json, ledger_json, plan_json,
        verified, retried, numbers_checked, violations_json, warnings_json, cost_usd)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    question, route, leagueId, model,
    JSON.stringify(answer), JSON.stringify(ledger), JSON.stringify(plan),
    verification.ok ? 1 : 0, verification.retried ? 1 : 0, verification.numbers_checked ?? 0,
    JSON.stringify(verification.violations ?? []), JSON.stringify(verification.warnings ?? []),
    costUsd);
  return row(`SELECT last_insert_rowid() AS id`).id;
}

/** Recent answers, newest first, for the Dev Hub and for reading the failure rate. */
export function recentCoachAnswers({ limit = 50 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return rows(`SELECT id, asked_at, question, route, model, verified, retried,
                      numbers_checked, violations_json, cost_usd
               FROM coach_answers ORDER BY id DESC LIMIT ?`, cap)
    .map(r => ({ ...r, violations: JSON.parse(r.violations_json), violations_json: undefined }));
}

/** How often the grounding check has stopped something, over the last n answers. */
export function coachGroundingRate({ limit = 200 } = {}) {
  const recent = rows(`SELECT verified, retried FROM coach_answers ORDER BY id DESC LIMIT ?`,
    Math.min(Math.max(Number(limit) || 200, 1), 1000));
  const answered = recent.length;
  return {
    answered,
    verified: recent.filter(r => r.verified).length,
    saved_by_retry: recent.filter(r => r.verified && r.retried).length,
    refused_after_retry: recent.filter(r => !r.verified).length
  };
}
