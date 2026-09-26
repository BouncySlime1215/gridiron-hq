/**
 * NUMBERS-PEOPLE: the only writer and reader of numbers_people_runs and
 * numbers_people_reads (migration 115). Rows hold ids, stances, bases, the
 * one-line whys and the cited fact keys / signal labels; never chat text, never
 * a league-mate's name.
 */
import { db as defaultDb } from '../../db/index.js';

const tableReady = database => !!database.prepare(
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'numbers_people_reads'").get();

export function storeReady(database = defaultDb) { return tableReady(database); }

/** Writes one run and its reads in one transaction; returns the run id. */
export function saveRun(database, { leagueId, week, planAt, inputsHash, trigger, status, reason = null, reads = [], costUsd = 0, latencyMs = null }) {
  const insertRun = database.prepare(`INSERT INTO numbers_people_runs
    (league_id, week, plan_at, inputs_hash, trigger, status, reason, items, cost_usd, latency_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertRead = database.prepare(`INSERT INTO numbers_people_reads
    (run_id, week, league_id, item_type, item_id, lane_a, lane_b, verdict) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  let runId;
  database.exec('BEGIN');
  try {
    runId = Number(insertRun.run(leagueId, week ?? null, planAt ?? null, inputsHash, trigger, status, reason,
      reads.length, costUsd, latencyMs).lastInsertRowid);
    for (const r of reads) {
      insertRead.run(runId, week ?? null, leagueId, r.item.item_type, r.item.item_id,
        JSON.stringify(r.lane_a), JSON.stringify(r.lane_b), r.verdict);
    }
    database.exec('COMMIT');
  } catch (e) {
    database.exec('ROLLBACK');
    throw e;
  }
  return runId;
}

/** The newest run for a league (any status), or null. */
export function lastRun(database, leagueId, { status = null } = {}) {
  return database.prepare(`SELECT * FROM numbers_people_runs WHERE league_id = ? ${status ? 'AND status = ?' : ''}
    ORDER BY id DESC LIMIT 1`).get(...(status ? [leagueId, status] : [leagueId])) ?? null;
}

const parse = r => ({ ...r, lane_a: JSON.parse(r.lane_a), lane_b: JSON.parse(r.lane_b) });

export function readsOfRun(database, runId) {
  return database.prepare('SELECT * FROM numbers_people_reads WHERE run_id = ? ORDER BY id').all(runId).map(parse);
}

/**
 * Per item, the last read of each week (history for "Going forward"), oldest
 * week first, for the items listed.
 */
export function weeklyHistory(database, leagueId, items) {
  const out = new Map();
  const q = database.prepare(`SELECT r.* FROM numbers_people_reads r
    JOIN numbers_people_runs u ON u.id = r.run_id AND u.status = 'ok'
    WHERE r.league_id = ? AND r.item_type = ? AND r.item_id = ? ORDER BY r.id`);
  for (const { item_type: type, item_id: id } of items) {
    const byWeek = new Map();
    for (const r of q.all(leagueId, type, id).map(parse)) byWeek.set(r.week ?? 0, r);
    out.set(`${type}:${id}`, [...byWeek.values()].sort((a, b) => (a.week ?? 0) - (b.week ?? 0)));
  }
  return out;
}

/** Every DIFFER read for a league (the scoreboard's candidates), oldest first. */
export function differReads(database, leagueId) {
  return database.prepare(`SELECT r.* FROM numbers_people_reads r
    JOIN numbers_people_runs u ON u.id = r.run_id AND u.status = 'ok'
    WHERE r.league_id = ? AND r.verdict = 'differ' ORDER BY r.id`).all(leagueId).map(parse);
}
