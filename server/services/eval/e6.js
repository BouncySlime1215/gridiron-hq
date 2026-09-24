/**
 * E6 follow vs ignore: when Nick followed the brain, did it go better than
 * when he ignored it?
 *
 * Source: the recommendation ledger `rec_ledger` (GR-01, #174 — not on main
 * yet) once graded rows say whether the call was followed. Contract on top of
 * #174's table: outcome_json.followed (true/false, written by the SELF-01a
 * follow log) and predicted_json.near_tie (true when the brain's top call and
 * the runner-up were within the near-tie margin). Only 'shown' rows count;
 * `score` is the ledger's own graded gain vs the baseline call.
 *
 * CAUSAL ONLY. Followed and ignored calls differ in more than the choice (Nick
 * ignores the calls he doubts), so a naive difference is selection, not
 * effect. Only NEAR-TIE decisions — where following or not was close to a coin
 * flip — decide the status. The naive difference is reported in the detail,
 * labelled, and never moves the status. (A doubly robust estimate needs a
 * stored propensity per call; SELF-01a does not log one yet.)
 *
 * Pass bar: near-tie followed-minus-ignored score CI > 0, with >= 20 per arm
 * over >= 8 distinct weeks. Failing: that CI wholly below 0.
 */
import { STATUS, result, readSource, waiting } from './common.js';
import { bootstrapCI, mean, moreNeeded } from './stats.js';

export const CHECK = 'E6';
export const NAME = 'Follow vs ignore';
export const MIN_PER_ARM = 20;
export const MIN_WEEKS = 8;
const PASS_BAR = 'near-tie followed-minus-ignored score CI > 0 (>= 20 per arm, >= 8 weeks)';

const parse = s => { if (s == null) return {}; try { return JSON.parse(s); } catch { return { unreadable: true }; } };

function diffWithCI(rows, seed) {
  const diffOf = idx => {
    const f = idx.filter(i => rows[i].followed).map(i => rows[i].score);
    const g = idx.filter(i => !rows[i].followed).map(i => rows[i].score);
    return f.length && g.length ? mean(f) - mean(g) : null;
  };
  const all = rows.map((_, i) => i);
  return { diff: diffOf(all), ci: bootstrapCI(rows.length, diffOf, { clusters: rows.map(r => r.week_key), seed }) };
}

export function grade(rawRows, { reason = null } = {}) {
  const parsed = rawRows.map(r => ({ r, out: parse(r.outcome_json), pred: parse(r.predicted_json) }));
  const unreadable = parsed.filter(({ out, pred }) => out.unreadable || pred.unreadable).length;
  const rows = parsed
    .filter(({ r, out }) => r.graded_at != null && r.score != null && typeof out.followed === 'boolean'
      && (r.disposition ?? 'shown') === 'shown')
    .map(({ r, out, pred }) => ({ followed: out.followed, near_tie: pred.near_tie === true, score: Number(r.score), week_key: `${r.season}:${r.week}` }));
  const common = { check: CHECK, name: NAME, metricName: 'near_tie_followed_minus_ignored_score', passBar: PASS_BAR };
  const nt = rows.filter(r => r.near_tie);
  const fN = nt.filter(r => r.followed).length;
  const iN = nt.length - fN;
  const weeks = new Set(nt.map(r => r.week_key)).size;
  const naive = rows.length >= 2 ? diffWithCI(rows, 312) : null;
  const detail = {
    near_tie: { followed: fN, ignored: iN, weeks },
    unreadable_rows: unreadable,
    naive_difference_not_causal: naive ? { diff: naive.diff, ci: naive.ci, n: rows.length } : null,
  };
  if (fN < MIN_PER_ARM || iN < MIN_PER_ARM || weeks < MIN_WEEKS) {
    const short = Math.max(MIN_PER_ARM - fN, MIN_PER_ARM - iN, 0);
    if (short > 0) {
      return waiting({ ...common, minN: nt.length + Math.max(short, 1), n: nt.length, unit: 'decisions', reason, detail });
    }
    return waiting({ ...common, minN: MIN_WEEKS, n: weeks, unit: 'weeks', reason, detail });
  }
  const { diff, ci } = diffWithCI(nt, 313);
  if (ci && ci[1] < 0) return result({ ...common, status: STATUS.FAILING, metric: diff, ci, n: nt.length, detail });
  if (ci && ci[0] > 0) return result({ ...common, status: STATUS.PASSING, metric: diff, ci, n: nt.length, detail });
  const needs = ci ? moreNeeded(nt.length, ci[1] - ci[0], Math.max(Math.abs(diff ?? 0), 0.1) * 2) : MIN_PER_ARM;
  return result({ ...common, status: STATUS.NOT_ENOUGH_DATA, metric: diff, ci, n: nt.length, needsN: needs, needsUnit: 'decisions', detail });
}

const COLS = ['season', 'week', 'disposition', 'predicted_json', 'outcome_json', 'score', 'graded_at'];

export function load(database) {
  const s = readSource(database, 'rec_ledger', COLS);
  return s.ok ? { rows: s.rows } : { rows: [], reason: `${s.reason}; GR-01 (#174) + SELF-01a follow log build it` };
}

export function run(database) {
  const { rows, reason } = load(database);
  return grade(rows, { reason });
}
