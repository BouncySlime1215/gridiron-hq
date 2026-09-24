/**
 * Run `fn` with one table dropped, or replaced by a different shape, and put it
 * back exactly as it was afterwards.
 *
 * WHY THIS EXISTS. A database constraint, and every read that depends on a
 * table's shape, exists for the writer that has not been written yet. A test
 * routed through today's writer cannot reach a table whose shape has drifted —
 * a renamed column, a half-applied migration — so the state with no writer is
 * the state with no test, which is how `counterpartyDataKey` and `selfRead`
 * both shipped answering "there is nothing here" when the truth was "I could
 * not look".
 *
 * WHY THE DDL IS NOT RETYPED. It comes out of `sqlite_master`, with the table's
 * indexes, so the restore cannot drift from the migration that owns the table.
 * A retyped copy pins a shape the app does not have, and the test then passes
 * against a table nobody ships.
 *
 * The accessors are passed in rather than imported: every suite here sets
 * `GRIDIRON_DB_PATH` before it imports the db module, and a helper that
 * imported it at load time would open the developer's own database instead.
 *
 * Callers should assert, after the body, that whatever they measured before is
 * what they measure again — a restore that rebuilt the table wrong would
 * otherwise surface as a failure somewhere else entirely, in a later test that
 * never touched this.
 */
export function withTableReplaced({ rows, run }, name, newDdl, fn) {
  const ddl = rows(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, name)[0]?.sql;
  if (!ddl) throw new Error(`withTableReplaced: no table named ${name} to replace`);
  const idx = rows(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?
                    AND sql IS NOT NULL`, name).map(r => r.sql);
  const saved = rows(`SELECT * FROM ${name}`);
  run(`DROP TABLE ${name}`);
  try {
    if (newDdl) run(newDdl);
    return fn();
  } finally {
    run(`DROP TABLE IF EXISTS ${name}`);
    run(ddl);
    for (const sql of idx) run(sql);
    for (const r of saved) {
      const cols = Object.keys(r);
      run(`INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        ...cols.map(c => r[c]));
    }
  }
}
