/**
 * EVAL-01 shared shapes: the three statuses, the result row every grader
 * returns, and the one guarded reader every grader loads its source through.
 *
 * A grader never throws on a missing source. "The table this check reads has
 * not been built yet" is a real, expected state for most of 2026 (the offer
 * log, campaign steps and weekly autopsy are later units), and it is reported
 * as not_enough_data WITH the source it is waiting on, never as an empty pass.
 */
import { round } from './stats.js';

export const STATUS = Object.freeze({
  PASSING: 'passing',
  NOT_ENOUGH_DATA: 'not_enough_data',
  FAILING: 'failing',
});

export const NEEDS_UNITS = Object.freeze(['offers', 'weeks', 'team_seasons', 'steps', 'decisions', 'league_seasons', 'runs', 'matchups']);

/** The row shape stored in brain_report and served by GET /api/brain-report. */
export function result({ check, name, status, metricName, metric = null, ci = null, n = 0,
  needsN = null, needsUnit = null, needsText = null, passBar, source = 'live', detail = {} }) {
  if (!Object.values(STATUS).includes(status)) throw new Error(`${check}: unknown status ${status}`);
  if (status === STATUS.NOT_ENOUGH_DATA && !(needsN > 0 && needsUnit)) {
    throw new Error(`${check}: not_enough_data must say how many more of what it needs`);
  }
  if (needsUnit && !NEEDS_UNITS.includes(needsUnit)) throw new Error(`${check}: unknown needs unit ${needsUnit}`);
  return {
    check,
    name,
    status,
    metric_name: metricName,
    metric: round(metric, 5),
    ci_low: ci ? round(ci[0], 5) : null,
    ci_high: ci ? round(ci[1], 5) : null,
    n,
    needs_n: status === STATUS.NOT_ENOUGH_DATA ? needsN : null,
    needs_unit: status === STATUS.NOT_ENOUGH_DATA ? needsUnit : null,
    needs_text: status === STATUS.NOT_ENOUGH_DATA
      ? (needsText ?? `needs ${needsN} more ${needsUnit.replace('_', '-')}`) : null,
    pass_bar: passBar,
    source,
    detail,
  };
}

/**
 * Rows from `table`, or why they could not be read. `columns` are the columns
 * the grader's contract requires; a table that exists without them is a
 * different table, and grading it would be grading the wrong thing.
 */
export function readSource(database, table, columns, sql = null) {
  const exists = database.prepare(`SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?`).get(table);
  if (!exists) return { ok: false, reason: `source table ${table} is not built yet` };
  let info;
  try {
    info = database.prepare(`SELECT name FROM pragma_table_info(?)`).all(table);
  } catch (e) {
    // A view resolves its tables when read (title_odds_snapshots over
    // served_numbers): a table it needs that is not built yet is a missing
    // source, reported like one. Any other fault is a real error and throws.
    const m = /no such table: (?:main\.)?(\S+)/.exec(e.message);
    if (!m) throw e;
    return { ok: false, reason: `source ${table} reads ${m[1]}, which is not built yet` };
  }
  const have = new Set(info.map(c => c.name));
  const missing = columns.filter(c => !have.has(c));
  if (missing.length) return { ok: false, reason: `source table ${table} lacks column(s) ${missing.join(', ')}` };
  return { ok: true, rows: database.prepare(sql ?? `SELECT ${columns.join(', ')} FROM ${table}`).all() };
}

/** The standard "not built / not enough yet" row for a grader with nothing to grade. */
export function waiting({ check, name, metricName, passBar, minN, n = 0, unit, reason, detail = {} }) {
  const needsN = Math.max(1, minN - n);
  return result({
    check, name, status: STATUS.NOT_ENOUGH_DATA, metricName, n, needsN, needsUnit: unit, passBar,
    needsText: `needs ${needsN} more ${unit.replace('_', '-')}${reason ? ` (${reason})` : ''}`,
    detail: { ...detail, ...(reason ? { reason } : {}) },
  });
}

export const ciExcludesZero = ci => !!ci && (ci[0] > 0 || ci[1] < 0);
export const ciWidth = ci => (ci ? ci[1] - ci[0] : Infinity);
