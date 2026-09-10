/**
 * The append-only decision tape (Codex audit finding E6, 2026-09-10).
 *
 * `persistPickDecisions` (nfl-auto-picks.js) writes a MUTABLE latest view:
 * it UPSERTs over (season, week, policy_id, matchup, market, selection) --
 * a key that omits policy_version -- so re-running the board after a line
 * moved overwrites what the model actually decided before it moved. And the
 * execution pipeline only wrote evidence for candidates it SELECTED, so a
 * run that selected nothing left no record that anything was ever
 * considered.
 *
 * This module is the evidence layer those two facts require:
 *
 *   - EVERY candidate is recorded, eligible or not, with its abstention
 *     reason. A zero-selection run still writes a full denominator.
 *   - A run is CONTENT-ADDRESSED by `board_hash`. Re-running an identical
 *     board finds the existing run and writes nothing new (idempotent
 *     retry); any changed input -- a moved quote, a new policy version, a
 *     different model number -- hashes differently and becomes a separate,
 *     immutable run alongside the first, which stays byte-identical.
 *   - Database triggers (migration 027) make the tables append-only, so
 *     "immutable" is a schema fact rather than a convention this file
 *     promises to honor.
 *
 * `nfl_pick_decisions` is deliberately still written by its existing caller.
 * It remains a convenient latest-view projection for the UI; it is simply no
 * longer the evidence anything is evaluated from.
 */
import crypto from 'node:crypto';
import { rows, row, run } from '../db/index.js';

/**
 * Everything about a decision that, if it changed, means a genuinely
 * different decision was made. Deliberately EXCLUDES wall-clock timestamps
 * (`recorded_at`, `decided_at`) so that re-running the same board a minute
 * later is recognized as the same decision rather than a new one, and
 * deliberately INCLUDES the quote (price/line/time) and the policy version,
 * which is exactly what the old UPSERT key left out.
 */
function decisionFingerprint(d) {
  return {
    matchup: d.matchup ?? null, market: d.market ?? null, selection: d.selection ?? null,
    line: d.line ?? null, american_price: d.american_price ?? null, book: d.book ?? null,
    quote_at: d.quote_at ?? null, quote_source: d.quote_source ?? null,
    edge: d.edge ?? null, disagreement: d.disagreement ?? null,
    eligible: d.eligible ? 1 : 0, abstention_reason: d.abstention_reason ?? null,
    policy_rank: d.policy_rank ?? null
  };
}

export function boardHash({ season, week, policyId, policyVersion, decisions }) {
  const payload = JSON.stringify({
    season, week, policy_id: policyId, policy_version: policyVersion,
    decisions: (decisions ?? []).map(decisionFingerprint)
      .sort((a, b) => `${a.matchup}|${a.market}|${a.selection}`.localeCompare(`${b.matchup}|${b.market}|${b.selection}`))
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Record one decision board as an immutable run. Returns
 * `{ run_id, created: false, board_hash }` when this exact board was already
 * recorded -- an idempotent retry, not a second copy.
 *
 * `decisionBoard` is `autoPickDecisionBoard()`'s return value: `.decisions`
 * carries every candidate (eligible and abstained alike), which is precisely
 * why it -- and not `.selected` -- is what gets written here.
 */
export function recordDecisionRun(season, week, decisionBoard, {
  policyId = decisionBoard?.policy?.id ?? null,
  policyVersion = decisionBoard?.policy?.version ?? null,
  codeHash = null, dataHash = null, decidedAt = new Date().toISOString(), note = null
} = {}) {
  const decisions = decisionBoard?.decisions ?? [];
  const hash = boardHash({ season, week, policyId, policyVersion, decisions });
  const existing = row(`SELECT id FROM nfl_decision_runs WHERE board_hash=?`, hash);
  if (existing) {
    return { run_id: existing.id, created: false, board_hash: hash, decision_count: decisions.length,
      note: 'identical board already recorded — idempotent retry, no duplicate run written' };
  }

  const id = crypto.randomUUID();
  const selectedCount = decisions.filter(d => d.eligible).length;
  run(`INSERT INTO nfl_decision_runs
       (id, season, week, policy_id, policy_version, board_hash, code_hash, data_hash,
        decided_at, decision_count, selected_count, engine_mode, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  id, season, week, policyId, policyVersion, hash, codeHash, dataHash,
  decidedAt, decisions.length, selectedCount, decisionBoard?.engine_mode ?? null, note);

  for (const d of decisions) {
    run(`INSERT INTO nfl_decision_events
         (run_id, matchup, market, selection, line, american_price, book, quote_at, quote_source,
          quote_id, edge, disagreement, eligible, abstention_reason, policy_rank, feature_snapshot_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, d.matchup ?? null, d.market ?? null, d.selection ?? null, d.line ?? null,
    d.american_price ?? null, d.book ?? null, d.quote_at ?? null, d.quote_source ?? null,
    d.quote_id ?? null, d.edge ?? null, d.disagreement ?? null, d.eligible ? 1 : 0,
    d.abstention_reason ?? null, d.policy_rank ?? null,
    d.feature_snapshot ? JSON.stringify(d.feature_snapshot) : null);
  }

  return { run_id: id, created: true, board_hash: hash,
    decision_count: decisions.length, selected_count: selectedCount };
}

/** Every event on one run, in the order it was written. */
export function decisionRunEvents(runId) {
  return rows(`SELECT * FROM nfl_decision_events WHERE run_id=? ORDER BY id`, runId);
}

/** One recorded run's header plus its events. */
export function decisionRun(runId) {
  const header = row(`SELECT * FROM nfl_decision_runs WHERE id=?`, runId);
  if (!header) return null;
  return { ...header, events: decisionRunEvents(runId) };
}

/**
 * The runs recorded for a week, newest first. More than one is normal and
 * meaningful: it means the board genuinely changed between runs (a quote
 * moved, a policy version changed), and each version remains readable.
 */
export function decisionRunsFor(season, week) {
  return rows(`SELECT * FROM nfl_decision_runs WHERE season=? AND week=? ORDER BY created_at DESC, id DESC`,
    season, week);
}

/**
 * Find the specific decision event a given selection came from, so an
 * execution opportunity can cite the exact frozen decision that produced it
 * (`nfl_execution_opportunities.decision_event_id`). Matches on the run's
 * own identity plus the contract-defining fields -- never on time.
 */
export function findDecisionEvent(runId, { matchup, market, selection }) {
  return row(`SELECT * FROM nfl_decision_events
    WHERE run_id=? AND matchup=? AND market=? AND (selection IS ? OR selection=?)
    ORDER BY id LIMIT 1`, runId, matchup, market, selection ?? null, selection ?? null);
}
