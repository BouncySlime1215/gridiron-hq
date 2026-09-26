export const name = '115_numbers_people_reads';
/**
 * NUMBERS-PEOPLE: both Coach lanes' reads of the plan's key items, side by side,
 * kept by week so the Trades tab can show "now" and "going forward".
 *
 *   numbers_people_runs    one producer run for one league: when, which week,
 *                          the plan's key-item hash it read, what triggered it,
 *                          how many items, what it cost and how long it took, and
 *                          whether it finished (ok), hit the daily AI budget
 *                          (budget) or failed (failed, with the reason).
 *   numbers_people_reads   one item's two reads in one run: lane A (numbers) and
 *                          lane B (numbers + stored people signals), each a stance
 *                          (go / wait / avoid), a one-line why, a basis and the
 *                          cited numbers or signal labels; and the verdict (agree,
 *                          differ, same_but, no_people_read).
 *
 * Every row is kept: history is the point. Ids and labels only; no chat text and
 * no league-mate names (written only by services/numbers-people/store.js).
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS numbers_people_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id     INTEGER NOT NULL,
      week          INTEGER,
      plan_at       TEXT,
      inputs_hash   TEXT NOT NULL,
      trigger       TEXT NOT NULL CHECK (trigger IN ('schedule', 'plan_change', 'refresh', 'view')),
      status        TEXT NOT NULL CHECK (status IN ('ok', 'budget', 'failed')),
      reason        TEXT,
      items         INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL NOT NULL DEFAULT 0,
      latency_ms    INTEGER,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_np_runs_league ON numbers_people_runs(league_id, id);
    CREATE TABLE IF NOT EXISTS numbers_people_reads (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        INTEGER NOT NULL REFERENCES numbers_people_runs(id) ON DELETE CASCADE,
      week          INTEGER,
      league_id     INTEGER NOT NULL,
      item_type     TEXT NOT NULL CHECK (item_type IN ('move', 'target', 'partner')),
      item_id       TEXT NOT NULL,
      lane_a        TEXT NOT NULL,
      lane_b        TEXT NOT NULL,
      verdict       TEXT NOT NULL CHECK (verdict IN ('agree', 'differ', 'same_but', 'no_people_read')),
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_np_reads_run ON numbers_people_reads(run_id);
    CREATE INDEX IF NOT EXISTS idx_np_reads_item ON numbers_people_reads(league_id, item_type, item_id, week);
  `);
}

export function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_np_reads_item;
           DROP INDEX IF EXISTS idx_np_reads_run;
           DROP TABLE IF EXISTS numbers_people_reads;
           DROP INDEX IF EXISTS idx_np_runs_league;
           DROP TABLE IF EXISTS numbers_people_runs;`);
}
