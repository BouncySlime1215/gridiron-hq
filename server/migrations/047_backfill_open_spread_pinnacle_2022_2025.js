export const name = '047_backfill_open_spread_pinnacle_2022_2025';

/**
 * 2026-09-12 sweep, item 13: `game_lines.open_spread` is silently wrong (not
 * missing) for essentially every 2022-2025 game, and the existing repair
 * cannot touch it.
 *
 * ROOT CAUSE. `odds-archive.js#storeArchiveQuotes` backfilled
 * `game_lines.open_spread` for 2021-2025 from a median-across-books opener,
 * writing the SAME home-perspective number to both the home row and the away
 * row instead of negating it for the away side (this database's convention,
 * matching `spread`, is "from this row's own team's perspective; negative =
 * favoured"). `a3e1841` ("Data integrity: real receipt clocks, fixed opener
 * sign...") fixed the writer going forward, but its own fix is a per-row
 * `UPDATE ... SET open_spread = COALESCE(open_spread, ?) WHERE open_spread IS
 * NULL` — which cannot repair a row that already holds a value. Wrong-but-
 * present is invisible to a NULL-only guard.
 *
 * VERIFIED READ-ONLY AGAINST REAL server/data.sqlite (2026-09-13, before
 * writing this migration):
 *
 *   - 2015-2021: of paired home/away completed games, the tiny number of
 *     "same value on both sides" rows are all genuine 0-point (pick'em)
 *     openers, where a value and its negation are numerically identical.
 *     No real sign corruption in this range.
 *   - 2022: 267 of 284 completed games (94%) have IDENTICAL open_spread on
 *     both the home and away row (the corruption signature); only 5 are
 *     correctly negated in a nonzero case, 17 are still NULL (schedule ties).
 *   - 2023, 2024, 2025: 285/285, 285/285, 285/285 -- effectively 100% of
 *     every game that season -- show the same identical-both-sides pattern.
 *   - Total: 1122 of 1139 real 2022-2025 completed games (98.5%) carry a
 *     corrupted (or unverifiable) open_spread relationship between their two
 *     rows, against ZERO such corruption in the `spread` (closing line)
 *     column over the same games -- the writer bug is specific to openers.
 *
 * THE FIX SOURCE. `nfl_odds_archive` already holds real, per-side, correctly
 * signed Pinnacle opening spreads for this exact window (verified: 534/570/
 * 570/570 rows for 2022/2023/2024/2025) captured independently of the buggy
 * writer above. Checked against every one of the 1122 corrupted-or-
 * unverifiable games: ALL 1122 have a matching Pinnacle opener for BOTH
 * sides, and every Pinnacle pair negates correctly (0 internal
 * inconsistencies). There is no unresolved case in the real data this
 * migration will run against -- the "else label the source era" branch below
 * is real defensive code for a gap that happens not to exist today, not
 * something invented to avoid it.
 *
 * `open_total` rides along for the same seasons: it carries no sign
 * convention (nothing to corrupt), but the existing value is a many-book
 * median rather than Pinnacle, and differs from the Pinnacle total on 760 of
 * 1122 games (up to 4.5 points) -- checked directly. Re-sourcing it here
 * keeps `open_spread` and `open_total` drawn from the same book rather than
 * mixing a corrected single-book spread with an uncorrected multi-book total
 * on the same row.
 *
 * WHAT THIS MIGRATION DOES, per 2022-2025 completed row (home AND away):
 *   1. If a Pinnacle open spread exists for THIS row's own team (so the sign
 *      is whatever that side's own quote says, never a shared/negated
 *      value): overwrite `open_spread` with it and mark
 *      `open_spread_source = 'pinnacle_archive_reopen_2022_2025'`.
 *   2. Same for `open_total` from Pinnacle's 'Over' total line, independently
 *      (a row can have one without the other; COALESCE preserves the
 *      existing number if no Pinnacle total is found).
 *   3. If no Pinnacle spread match exists at all, the existing (possibly
 *      still-wrong) `open_spread` value is left untouched -- it is NOT
 *      nulled out, because a labeled uncertain number is more useful than a
 *      silently vanished one -- but `open_spread_source` is set to
 *      'unresolved_legacy_median_2022_2025' so a pooled statistic can filter
 *      it out by name instead of trusting it by default.
 *
 * Rows outside 2022-2025 are untouched: 2015-2021 was not corrupted (above),
 * and later seasons write correctly since a3e1841.
 *
 * NOT applied by this change. A fresh migration file only; running it
 * against a real database is a separate, explicit step (see repo SAFETY
 * rules). See docs/evidence/2026-09-12/ (this sweep) for the read-only
 * verification script and its full output.
 */

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function addColumn(db, table, column, type) {
  if (!columns(db, table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

const PINNACLE_SPREAD_MATCH = `
  SELECT oa.line FROM nfl_odds_archive oa
  WHERE oa.book = 'pinnacle' AND oa.market = 'spreads' AND oa.phase = 'open'
    AND oa.season = game_lines.season AND oa.week = game_lines.week
    AND ((oa.home = game_lines.team AND oa.away = game_lines.opponent)
      OR (oa.home = game_lines.opponent AND oa.away = game_lines.team))
    AND oa.side = game_lines.team
  LIMIT 1
`;

const PINNACLE_TOTAL_MATCH = `
  SELECT oa.line FROM nfl_odds_archive oa
  WHERE oa.book = 'pinnacle' AND oa.market = 'totals' AND oa.phase = 'open'
    AND oa.season = game_lines.season AND oa.week = game_lines.week
    AND ((oa.home = game_lines.team AND oa.away = game_lines.opponent)
      OR (oa.home = game_lines.opponent AND oa.away = game_lines.team))
    AND oa.side = 'Over'
  LIMIT 1
`;

export function up(db) {
  addColumn(db, 'game_lines', 'open_spread_source', 'TEXT');

  db.exec(`
    UPDATE game_lines SET
      open_spread = COALESCE((${PINNACLE_SPREAD_MATCH}), open_spread),
      open_total  = COALESCE((${PINNACLE_TOTAL_MATCH}), open_total),
      open_spread_source = CASE WHEN EXISTS (${PINNACLE_SPREAD_MATCH})
        THEN 'pinnacle_archive_reopen_2022_2025'
        ELSE 'unresolved_legacy_median_2022_2025' END
    WHERE season BETWEEN 2022 AND 2025 AND team_score IS NOT NULL;
  `);
}

export function down(db) {
  // The corrected numbers are strictly more accurate than the corrupted ones
  // they replace (verified above against an independent, correctly-signed
  // source); there is no "original" value worth restoring, and doing so would
  // reintroduce a known, already-diagnosed data bug. Only the provenance
  // column -- purely additive, read by nothing before this migration -- is
  // reversible, matching this repo's existing convention (031_decision_
  // identity.js) of leaving corrected/backfilled data in place on downgrade.
  db.exec(`ALTER TABLE game_lines DROP COLUMN open_spread_source`);
}
