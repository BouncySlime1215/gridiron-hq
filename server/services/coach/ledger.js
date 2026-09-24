/**
 * Every row Coach looked at, and every number it worked out from those rows,
 * with a name for each cell.
 *
 * verify.js checks an answer against this. Nothing else in Coach is allowed to
 * produce a number.
 *
 * That last sentence is the design. Nick asked Coach to "run calculations
 * quickly to sense check things", and a language model doing arithmetic in
 * prose is the cleanest way to ship a wrong number that looks right: the
 * inputs are real, the output is invented, and nothing downstream can tell the
 * difference. So Coach does not do arithmetic. It either asks SQL for the
 * aggregate, or it calls one of the eight operations below, which records the
 * result as a cell of its own with its inputs and its formula. A computed
 * number is then exactly as traceable as a retrieved one, and the chain behind
 * it can be printed.
 *
 * Cite grammar, the one string that ties an answer to its evidence:
 *   r1#0.target_share   query 1, row 0, column target_share
 *   d2                  the second derived value
 * A cite that does not resolve returns null. It never resolves to something
 * nearby, because a cite that quietly slides one row over is worse than no
 * cite at all.
 */

export class LedgerError extends Error {
  constructor(message) { super(message); this.name = 'LedgerError'; }
}

/**
 * The arithmetic Coach may do, and nothing else. Anything absent from this
 * list is a question for SQL, which can express it exactly and has the whole
 * table to do it over.
 */
export const LEDGER_OPS = Object.freeze([
  'sum', 'difference', 'product', 'quotient', 'mean', 'min', 'max', 'percent_of'
]);

const OPS = Object.freeze({
  sum: values => values.reduce((a, b) => a + b, 0),
  difference: values => values.slice(1).reduce((a, b) => a - b, values[0]),
  product: values => values.reduce((a, b) => a * b, 1),
  quotient: values => values.slice(1).reduce((a, b) => a / b, values[0]),
  mean: values => values.reduce((a, b) => a + b, 0) / values.length,
  min: values => Math.min(...values),
  max: values => Math.max(...values),
  // a*100/b rather than a/b*100: one rounding step instead of two.
  percent_of: values => (values[0] * 100) / values[1]
});

/** Operations whose later arguments are divisors, so a zero has to be caught. */
const DIVIDES = Object.freeze(['quotient', 'percent_of']);

const CITE = /^(r\d+)#(\d+)\.([A-Za-z_][A-Za-z0-9_]*)$/;
const DERIVED_CITE = /^d\d+$/;

const formulaFor = (op, inputs) => `${op}(${inputs.join(', ')})`;

/**
 * A fresh ledger for one Coach turn. Ids are handed out in order within the
 * turn and mean nothing outside it.
 */
export function newLedger() {
  const queries = [];
  const derived = [];
  const derivedById = new Map();

  /** Resolve a cite to `{ id, value, kind }`, or null. Never throws. */
  function cell(cite) {
    if (typeof cite !== 'string') return null;
    if (DERIVED_CITE.test(cite)) {
      const entry = derivedById.get(cite);
      return entry ? { id: cite, value: entry.value, kind: 'derived' } : null;
    }
    const match = CITE.exec(cite);
    if (!match) return null;
    const [, queryId, rowIndex, column] = match;
    const query = queries.find(q => q.id === queryId);
    if (!query) return null;
    const row = query.rows[Number(rowIndex)];
    if (!row || !Object.hasOwn(row, column)) return null;
    return { id: cite, value: row[column], kind: 'row', table: query.tables[0] ?? null, query: queryId,
      tables: query.tables, health: query.health };
  }

  /** Record what a query returned. Takes a safeSelect result or a tool result of the same shape. */
  function record(result) {
    if (!result || !Array.isArray(result.rows)) {
      throw new LedgerError('A ledger entry needs a result with rows.');
    }
    const entry = {
      id: `r${queries.length + 1}`,
      sql: result.sql ?? null,
      params: result.params ?? [],
      tool: result.tool ?? null,
      tables: result.tables ?? [],
      columns: result.columns ?? [],
      rows: result.rows,
      row_count: result.row_count ?? result.rows.length,
      truncated: result.truncated ?? false,
      provenance: result.provenance ?? {},
      // An engine read's served status (HEALTH-01c): null for anything that is not one.
      health: result.health ?? null
    };
    queries.push(entry);
    return entry;
  }

  /** Work out one number from cells already in the ledger, and record how. */
  function derive({ op, inputs, label }) {
    if (!LEDGER_OPS.includes(op)) {
      throw new LedgerError(
        `Coach does not compute "${op}". It may only ${LEDGER_OPS.join(', ')}; anything else is a question for SQL.`);
    }
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new LedgerError(`${op} needs at least one input cite.`);
    }
    const values = inputs.map(cite => {
      const resolved = cell(cite);
      if (!resolved) throw new LedgerError(`${op} cites ${cite}, which is not in the ledger.`);
      const value = typeof resolved.value === 'string' ? Number(resolved.value) : resolved.value;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new LedgerError(`${cite} is not a number (${JSON.stringify(resolved.value)}), so ${op} cannot use it.`);
      }
      return value;
    });
    if (DIVIDES.includes(op) && values.slice(1).some(v => v === 0)) {
      throw new LedgerError(`${op} would divide by zero; say the ratio is undefined rather than returning one.`);
    }
    const value = OPS[op](values);
    if (!Number.isFinite(value)) {
      throw new LedgerError(`${op} did not produce a finite number.`);
    }
    const entry = { id: `d${derived.length + 1}`, op, inputs: [...inputs], label: label ?? op, value,
      formula: formulaFor(op, inputs) };
    derived.push(entry);
    derivedById.set(entry.id, entry);
    return entry;
  }

  /**
   * The chain behind a cite: the cell itself, then every cell it was computed
   * from, depth first. A derived value that stands on a derived value keeps
   * unrolling, so a reader can see all the way down to rows.
   */
  function trace(cite, seen = []) {
    const resolved = cell(cite);
    if (!resolved) return seen;
    seen.push(resolved);
    if (resolved.kind === 'derived') {
      for (const input of derivedById.get(cite).inputs) trace(input, seen);
    }
    return seen;
  }

  /**
   * Which of the cited tables are collected by hand rather than refreshed by a
   * job. An answer standing on one of these has to say how old it is —
   * tonight's Finding 7 is a whole layer of the app that did not.
   */
  function handCollected(cites) {
    const tables = new Set();
    for (const cite of cites ?? []) {
      for (const source of trace(cite)) {
        const query = queries.find(q => q.id === (source.query ?? source.id));
        if (!query) continue;
        for (const [table, meta] of Object.entries(query.provenance ?? {})) {
          if (meta?.collection === 'by_hand') tables.add(table);
        }
      }
    }
    return [...tables].sort();
  }

  function toJson() {
    return {
      queries: queries.map(q => ({ ...q, rows: q.rows.map(row => ({ ...row })) })),
      derived: derived.map(d => ({ ...d }))
    };
  }

  return { record, derive, cell, trace, handCollected, toJson,
    get queries() { return queries; }, get derived() { return derived; } };
}
