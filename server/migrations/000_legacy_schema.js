/**
 * The schema that predates the migration system, in one place.
 *
 * Until this migration existed, ~225 tables, ~95 indexes and ~142 triggers
 * were created at import time by db.exec() calls scattered across 122 service
 * and route files. That worked — every statement was an idempotent
 * IF NOT EXISTS — but it meant the schema had no single home, its creation
 * order was whatever the import graph happened to be, and a table's definition
 * could only be found by grepping. 001_baseline_marker records the moment
 * versioned migrations began; this migration is the body that marker pointed
 * at, lifted verbatim into server/db/schema/ fragments.
 *
 * It is applied by server/db/index.js the moment the database opens — before
 * any service is imported — so nothing downstream can observe a difference
 * between "the service created its table at import" and "the table was
 * already there." The proof that nothing did change is scripts/schema-snapshot.mjs.
 *
 * Numbered 000 rather than 019 on purpose: several later migrations ALTER
 * tables that were born here, so on a fresh database this must run first.
 * On a database that already applied 001–018, running it is a no-op that
 * only records the marker.
 *
 * FROZEN. Do not add to the fragments; write a new numbered migration. A
 * fragment edited after the fact does nothing on any database that has
 * already recorded this migration — which is every database that matters.
 */
import * as core from '../db/schema/core-and-fantasy.js';
import * as mlb from '../db/schema/mlb-model-misc.js';
import * as nflAM from '../db/schema/nfl-a-to-m.js';
import * as nflNZ from '../db/schema/nfl-n-to-z.js';

export const name = '000_legacy_schema';

/** Fragments in the order their statements first ran under the legacy import graph. */
export const fragments = [core, mlb, nflAM, nflNZ];

/**
 * All tables first, then column additions, then indexes and triggers, then
 * default rows. A trigger in one fragment may reference a table from another,
 * and an index may depend on a column an ALTER added, so phases run across
 * every fragment before the next phase starts.
 */
export function up(db) {
  for (const phase of ['tables', 'alters', 'indexesAndTriggers', 'seeds']) {
    for (const fragment of fragments) {
      if (typeof fragment[phase] !== 'function') throw new Error(`schema fragment is missing ${phase}()`);
      fragment[phase](db);
    }
  }
}

/** The baseline holds every table with user data in it; there is nothing safe to undo. */
export function down() {
  throw new Error('000_legacy_schema is the frozen baseline and cannot be rolled back');
}
