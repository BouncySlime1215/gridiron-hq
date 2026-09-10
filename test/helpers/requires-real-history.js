/**
 * The explicit disposition Codex correction C06 asks for.
 *
 * The correction's instruction is precise, and it forbids the two easy
 * options: "Preserve meaningful economic assertions; do not simply skip them
 * or delete the tests" and "failures/skips have explicit disposition."
 *
 * Some checks in this suite genuinely cannot run on a clean checkout. They
 * validate that a model FITTED ON REAL DATA behaves sensibly — that goal-line
 * carries convert better than open-field ones, that a simulator's play model
 * produces an auditable tape, that every season prices all 32 teams. A
 * synthetic fixture can be built to satisfy any of those, and doing so would
 * prove only that the fixture was tuned to pass; the assertion would stop
 * being about football and start being about the generator.
 *
 * So those checks stay in the suite and stay meaningful. What changes is that
 * they now say, in one sentence, exactly what data they need and why a fixture
 * cannot stand in for it — instead of failing with a bare assertion on a clean
 * checkout, which is what made the suite green on one machine only.
 *
 * This is deliberately NOT a general escape hatch. A check that is about LOGIC
 * belongs on a deterministic fixture (see seed-league-history.js); reaching for
 * this instead is how a suite quietly stops testing anything.
 */

/** Does the database hold rows in every table this check reads? */
export function hasRows(rows, tables, { min = 1 } = {}) {
  return tables.every(table => {
    try {
      return (rows(`SELECT COUNT(*) n FROM ${table}`)[0]?.n ?? 0) >= min;
    } catch {
      return false; // table absent entirely
    }
  });
}

/**
 * A node:test `skip` value: `false` when the data is present, or a sentence
 * naming what is missing and why when it is not.
 */
export function realHistoryDisposition(rows, tables, requirement, { min = 1 } = {}) {
  if (hasRows(rows, tables, { min })) return false;
  return `requires real history in ${tables.join(', ')} (at least ${min} row(s) each). ${requirement} ` +
    'A synthetic fixture could be tuned to satisfy this assertion, which would prove only that the ' +
    'fixture was tuned. Run against the populated database to check it.';
}
