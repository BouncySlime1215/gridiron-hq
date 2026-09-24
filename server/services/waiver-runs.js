/**
 * RL-16-2: when this league's waivers have actually run.
 *
 * ESPN stamps every processed claim with `processDate` (epoch ms). A waiver run
 * processes all of the round's claims within seconds, so executed WAIVER claims
 * close together are one run. Two stores feed the list:
 *
 *   - league_waiver_runs (migration 081), written here on every ESPN sync from the
 *     sync response: EXECUTED WAIVER transactions (view mTransactions2) and
 *     status.waiverLastExecutionDate. Append-only, so a run survives the next sync
 *     overwriting leagues.payload.
 *   - league_transactions_raw.processed_at, when scripts/collect-league-transactions.mjs
 *     has filled it (no migration creates that table, so it is checked for first).
 *
 * Only EXECUTED WAIVER rows count: a failed or cancelled claim is stamped too, but
 * nothing says it was stamped by the run rather than by the manager; a FREEAGENT add
 * happens whenever the manager makes it.
 */
import { rows, run } from '../db/index.js';

/** Claims further apart than this are separate runs. */
export const RUN_GAP_MS = 30 * 60 * 1000;

const isoOf = v => {
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null;
};

/** ISO instants (any order, duplicates allowed) -> the first instant of each run, ascending. */
export function clusterRuns(instants) {
  const ts = [...new Set((instants ?? []).map(isoOf).filter(Boolean))].map(Date.parse).sort((a, b) => a - b);
  const out = [];
  for (const t of ts) {
    if (!out.length || t - out[out.length - 1] > RUN_GAP_MS) out.push(t);
  }
  return out.map(t => new Date(t).toISOString());
}

/** The run instants an ESPN league response carries, each with its source. */
export function runsInEspnResponse(data) {
  const found = [];
  for (const t of Array.isArray(data?.transactions) ? data.transactions : []) {
    if (t?.type !== 'WAIVER' || t.status !== 'EXECUTED') continue;
    const at = isoOf(t.processDate);
    if (at) found.push({ run_at: at, source: 'espn_transaction' });
  }
  const last = isoOf(Number(data?.status?.waiverLastExecutionDate));
  if (last) found.push({ run_at: last, source: 'espn_status_last_execution' });
  return found;
}

/** Store the runs a sync response shows. Returns how many rows were new. */
export function recordWaiverRuns(leagueId, season, data) {
  let added = 0;
  for (const r of runsInEspnResponse(data)) {
    added += Number(run(`INSERT INTO league_waiver_runs (league_id, season, run_at, source) VALUES (?, ?, ?, ?)
                         ON CONFLICT (league_id, season, run_at) DO NOTHING`,
      leagueId, season, r.run_at, r.source)?.changes ?? 0);
  }
  return added;
}

const tableExists = name =>
  rows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name).length > 0;

/** Every observed run for the league-season, clustered, ascending. [] when none are stored. */
export function observedWaiverRuns(leagueId, season) {
  // No league-season to key on (an unsaved league object): nothing can have been
  // observed, and nextWaiverRun then says its time is the unconfirmed guess.
  if (leagueId == null || season == null) return [];
  const instants = rows(`SELECT run_at FROM league_waiver_runs WHERE league_id = ? AND season = ?`, leagueId, season)
    .map(r => r.run_at);
  if (tableExists('league_transactions_raw')) {
    instants.push(...rows(`SELECT processed_at FROM league_transactions_raw
                           WHERE league_id = ? AND season = ? AND type = 'WAIVER' AND status = 'EXECUTED'
                             AND processed_at IS NOT NULL AND processed_at <> ''`, leagueId, season)
      .map(r => r.processed_at));
  }
  return clusterRuns(instants);
}
