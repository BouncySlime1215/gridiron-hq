export const name = '045_market_identity_flag';

/**
 * Step 0 item 3 of the 2026-09-12 sweep -- the headline finding.
 *
 * Checked read-only against real production history: across every
 * `nfl_ensemble_fit_artifacts` row ever persisted (848 artifacts, 26,288
 * component-cutoff rows), `residual_gate_passed` (and its predecessor
 * `residual_diagnostic_passed`) has been true exactly zero times. Zero.
 *
 * `nfl-ensemble.js#ensembleLine` computes `market_residual` as:
 *
 *     residualMargin = marketMargin + (weighted sum of component residual
 *                        slopes) / residualWeight   -- when residualWeight > 0
 *                    = marketMargin                 -- otherwise (fallback)
 *
 * With residualWeight always 0 in every fit this repository has ever
 * produced, `market_residual` -- the blend mode `nfl-auto-picks.js`'s
 * production board actually runs -- has returned the market line by
 * arithmetic, at every cutoff, always. `spread_edge` has been identically 0.
 * The historical -7.7%/-2.28 CLV figures elsewhere in this repo graded the
 * `raw` blend; production has been running `market_residual`. Those are two
 * different things that prior reporting conflated as one result.
 *
 * Confirmed directly against the real decision record too: all 16 rows ever
 * written to `nfl_pick_decisions` (the only populated decision-board table at
 * the time of this migration; `nfl_decision_events` is still empty in
 * production) carry `coordinated_decision_head.base_blend: "market_residual"`
 * with zero components at nonzero residual weight in their `model_trace` --
 * 16 of 16, 100%. Every decision this system has ever actually recorded was
 * the market line with no independent model opinion behind it.
 *
 * This migration adds the column the code now populates honestly: whether a
 * given decision's forecast was a real model opinion (`0`) or the market line
 * served verbatim because nothing passed the gate (`1`). It changes no
 * existing row's meaning -- `nfl_decision_events` has zero rows to backfill --
 * and nothing reads this column until code populates it going forward.
 *
 * NOT applied by this change. A fresh migration file only; running it against
 * a real database is a separate, explicit step (see repo SAFETY rules).
 */

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function addColumn(db, table, column, type) {
  if (!columns(db, table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function up(db) {
  // 0/1/NULL: NULL means "written before this column existed" -- distinct
  // from 0 ("checked, and it was a real model opinion"). Every row this
  // migration can see is empty (see header), so this is purely additive.
  addColumn(db, 'nfl_decision_events', 'is_market_identity', 'INTEGER');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_events_market_identity
           ON nfl_decision_events(is_market_identity);`);

  // `nfl_pick_decisions` is the mutable latest-view the UI reads today (see
  // nfl-auto-picks.js's header comment) and is where the 16/16 figure above
  // was actually measured, off feature_snapshot_json. Adding the column here
  // too means a future UPSERT can surface it without re-parsing JSON, even
  // though the decision tape (nfl_decision_events) remains the evidentiary
  // source of truth.
  addColumn(db, 'nfl_pick_decisions', 'is_market_identity', 'INTEGER');
}

export function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_decision_events_market_identity;`);
  // SQLite's DROP COLUMN support is version-dependent and destructive; leaving
  // an unused nullable column costs nothing, so downgrades stop at the index.
}
