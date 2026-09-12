#!/usr/bin/env node
/**
 * Flag placeholder nfl_qbr_weekly rows for season=2026.
 *
 * FINDING (Giant Plan section 3, item 6): every season=2026 row in
 * nfl_qbr_weekly is byte-for-byte identical, per (team, player_id, week), to
 * that same player's 2025 row for the same week — same qbr_total, pts_added,
 * qb_plays, epa_total, qbr_raw and sack. Real 2026 ESPN QBR does not exist yet
 * for weeks that have not been played (or has not been synced for weeks that
 * have), and something upstream copied 2025 forward as a placeholder rather
 * than leaving the gap empty. Left unmarked, `teamQbrProfile` and
 * `qbrTrailingForPlayer` (server/services/nfl-qbr.js) would silently treat a
 * copied 2025 number as real 2026 evidence a decision could have known.
 *
 * THIS SCRIPT ONLY FLAGS. It never deletes a row. `is_placeholder` is added
 * as a new column (guarded ALTER, safe to run more than once) and set to 1 on
 * every 2026 row that matches its 2025 counterpart exactly; every other row
 * — including real 2026 rows once ESPN actually publishes them — is left at
 * 0. Purging season=2026 outright was the plan's other option; flagging was
 * chosen here because it is reversible and because a later week's real sync
 * (`syncQbr`) already does `INSERT OR REPLACE`, so a genuine 2026 row landing
 * on top of a flagged placeholder correctly clears the flag on its own (see
 * the companion migration this script does NOT touch: reset happens because
 * a fresh syncQbr row simply won't match the stored is_placeholder value
 * unless it re-derives it — this script is the one-time backfill, not an
 * ongoing guard; nfl-qbr.js's syncQbr does not set is_placeholder at all, so
 * every freshly-synced row defaults to 0, which is correct).
 *
 * SAFETY: this repo's standing rule is that a script which writes to a real
 * (non-fixture) database is never executed by an agent — this one is left
 * ready for Nick to run by hand:
 *
 *   node scripts/flag-qbr-2026-placeholders.mjs            # dry run, reports only
 *   node scripts/flag-qbr-2026-placeholders.mjs --apply    # adds the column and flags rows
 *
 * Verified against the test suite's own fixture-DB bootstrap
 * (test/flag-qbr-2026-placeholders.test.js), never against data.sqlite.
 */
import { db, rows, run } from '../server/db/index.js';

export const PLACEHOLDER_SEASON = 2026;
export const SOURCE_SEASON = 2025;

/** Adds is_placeholder if this database predates it. Safe to call every run. */
export function ensureColumn(database = db) {
  const cols = database.prepare('PRAGMA table_info(nfl_qbr_weekly)').all().map(c => c.name);
  if (!cols.includes('is_placeholder')) {
    database.exec('ALTER TABLE nfl_qbr_weekly ADD COLUMN is_placeholder INTEGER NOT NULL DEFAULT 0');
  }
}

/**
 * Rows for PLACEHOLDER_SEASON whose stat line is an exact copy of the same
 * player's SOURCE_SEASON row at the same week. Comparing every measured
 * column (not just qbr_total) so a genuine 2026 row that happens to share one
 * number with 2025 by chance is not mistaken for a copy.
 */
export function findPlaceholders(readRows = rows) {
  return readRows(`
    SELECT y.season, y.week, y.team, y.player_id
    FROM nfl_qbr_weekly y
    JOIN nfl_qbr_weekly p
      ON p.season = ? AND p.week = y.week AND p.team = y.team AND p.player_id = y.player_id
    WHERE y.season = ?
      AND y.qbr_total IS p.qbr_total AND y.pts_added IS p.pts_added
      AND y.qb_plays IS p.qb_plays AND y.epa_total IS p.epa_total
      AND y.qbr_raw IS p.qbr_raw AND y.sack IS p.sack
  `, SOURCE_SEASON, PLACEHOLDER_SEASON);
}

export function flagPlaceholders({ apply = false, database = db, readRows = rows, writeRun = run } = {}) {
  ensureColumn(database);
  const matches = findPlaceholders(readRows);
  if (!apply) return { dry_run: true, would_flag: matches.length, rows: matches };
  let flagged = 0;
  database.exec('BEGIN');
  try {
    for (const m of matches) {
      const r = writeRun(`UPDATE nfl_qbr_weekly SET is_placeholder=1
        WHERE season=? AND week=? AND team=? AND player_id=?`, m.season, m.week, m.team, m.player_id);
      flagged += Number(r.changes ?? 0);
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return { dry_run: false, flagged };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const apply = process.argv.includes('--apply');
  const result = flagPlaceholders({ apply });
  console.log(JSON.stringify(result.rows ? { ...result, rows: `${result.rows.length} row(s), omitted` } : result, null, 2));
  if (!apply) console.log('\nDry run only — re-run with --apply to write is_placeholder=1.');
}
