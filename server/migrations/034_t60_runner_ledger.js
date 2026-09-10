export const name = '034_t60_runner_ledger';

/**
 * Codex correction C12 and plan section 7: "Sequential capacity exists as a
 * helper, not a durable decision path."
 *
 * `cutoffBatches` and `sequentialCapacity` are pure functions with, at the
 * time of writing, no production caller at all -- only tests. A GET route that
 * returns a packet is not a scheduled collector, and a helper nothing invokes
 * is not an operation. Section 7.1 asks for a durable runner registered with
 * the existing job infrastructure, and a durable runner needs two things this
 * database does not have:
 *
 *   `nfl_t60_observations` -- one row per scheduled game per cutoff, created
 *       BEFORE the cutoff and updated through its lifecycle. Its existence is
 *       what makes a MISSED capture visible: a row that never left `scheduled`
 *       is a recorded missing observation, which is exactly what section 7.1
 *       demands ("if capture was missed, record a missing prospective
 *       observation; never reconstruct it with later receipts").
 *
 *   `nfl_capacity_events` -- timestamped reservations and releases, append
 *       only. The capacity helper used to take FINAL slot states with no times
 *       attached, so a slot released at 12:10 wrongly freed capacity for a
 *       batch at 12:05. Capacity is a question about a moment, and answering
 *       it needs event times, not end states.
 *
 * The observation row is deliberately NOT the decision tape. The tape records
 * what a computation decided; this records whether the computation happened at
 * all, which is a different fact and the one that goes missing silently.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfl_t60_observations (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      experiment_id TEXT NOT NULL,
      season INTEGER NOT NULL,
      week INTEGER NOT NULL,
      event_key TEXT NOT NULL,
      home TEXT NOT NULL,
      away TEXT NOT NULL,
      kickoff_at TEXT NOT NULL,
      schedule_version TEXT,
      cutoff_at TEXT NOT NULL,
      horizon TEXT NOT NULL,
      -- scheduled -> collected -> frozen -> decided -> settled, or missed.
      -- A row that never leaves 'scheduled' after its cutoff has passed is a
      -- MISSED prospective observation, and is counted in the denominator.
      state TEXT NOT NULL DEFAULT 'scheduled'
        CHECK(state IN ('scheduled','collected','frozen','decided','abstained','missed','failed')),
      decision_run_id TEXT,
      packet_hash TEXT,
      capture_started_at TEXT,
      capture_finished_at TEXT,
      last_error TEXT,
      note TEXT,
      UNIQUE (experiment_id, event_key, cutoff_at)
    );
    CREATE INDEX IF NOT EXISTS idx_t60_obs_cutoff ON nfl_t60_observations(cutoff_at, state);
    CREATE INDEX IF NOT EXISTS idx_t60_obs_week ON nfl_t60_observations(season, week);

    CREATE TABLE IF NOT EXISTS nfl_capacity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id TEXT NOT NULL,
      season INTEGER NOT NULL,
      week INTEGER NOT NULL,
      event_key TEXT NOT NULL,
      observation_id TEXT REFERENCES nfl_t60_observations(id),
      -- 'reserved' takes a slot; 'released' returns it; 'committed' keeps it.
      kind TEXT NOT NULL CHECK(kind IN ('reserved','committed','released')),
      -- The instant the thing actually happened, which is what capacity is a
      -- question about. Separate from recorded_at, the instant we wrote it
      -- down: a release known late is still a release at its own time.
      occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      reason TEXT,
      actor TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_capacity_week ON nfl_capacity_events(experiment_id, season, week, occurred_at);

    CREATE TRIGGER IF NOT EXISTS nfl_capacity_events_no_update
      BEFORE UPDATE ON nfl_capacity_events
      BEGIN SELECT RAISE(ABORT, 'capacity events are append-only — record a release instead of editing a reservation'); END;
    CREATE TRIGGER IF NOT EXISTS nfl_capacity_events_no_delete
      BEFORE DELETE ON nfl_capacity_events
      BEGIN SELECT RAISE(ABORT, 'capacity events are append-only — record a release instead of deleting a reservation'); END;
  `);
}

export function down(db) {
  const observations = db.prepare(`SELECT COUNT(*) n FROM nfl_t60_observations`).get()?.n ?? 0;
  const events = db.prepare(`SELECT COUNT(*) n FROM nfl_capacity_events`).get()?.n ?? 0;
  if (observations || events) {
    throw new Error(
      `034_t60_runner_ledger: refusing to downgrade — ${observations} prospective observation(s) and ` +
      `${events} capacity event(s) are recorded. Dropping them would erase both the record of which ` +
      'captures were attempted and the timeline that makes capacity decisions reproducible.');
  }
  db.exec(`
    DROP TRIGGER IF EXISTS nfl_capacity_events_no_update;
    DROP TRIGGER IF EXISTS nfl_capacity_events_no_delete;
    DROP TABLE IF EXISTS nfl_capacity_events;
    DROP TABLE IF EXISTS nfl_t60_observations;
  `);
}
