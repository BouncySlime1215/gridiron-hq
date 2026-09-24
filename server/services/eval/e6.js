/**
 * E6 follow vs ignore: when Nick followed the brain, did it go better than
 * when he ignored it?
 *
 * Source: `follow_ledger` (SELF-01a, #245) joined to `rec_ledger` (GR-01,
 * #174) on rec_ledger.inputs_hash = follow_ledger.rec_ledger_hash, same
 * league. From the follow ledger: outcome ('follow' = followed, 'ignore' =
 * ignored; 'no_action' and unresolved NULL are neither and are excluded) and
 * near_tie (its pre-registered |margin| < epsilon flag). From the rec ledger:
 * `score`, the call's own graded gain vs the baseline call, on 'shown' rows
 * only. rec_ledger grades a call at several horizons; the shortest graded one
 * is used, so each decision counts once.
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
  const rows = rawRows
    .filter(r => (r.outcome === 'follow' || r.outcome === 'ignore') && r.score != null && Number.isFinite(Number(r.score)))
    .map(r => ({ followed: r.outcome === 'follow', near_tie: Number(r.near_tie) === 1, score: Number(r.score), week_key: `${r.season}:${r.week}` }));
  const common = { check: CHECK, name: NAME, metricName: 'near_tie_followed_minus_ignored_score', passBar: PASS_BAR };
  const nt = rows.filter(r => r.near_tie);
  const fN = nt.filter(r => r.followed).length;
  const iN = nt.length - fN;
  const weeks = new Set(nt.map(r => r.week_key)).size;
  const naive = rows.length >= 2 ? diffWithCI(rows, 312) : null;
  const detail = {
    near_tie: { followed: fN, ignored: iN, weeks },
    excluded_rows: rawRows.length - rows.length,
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

const FOLLOW_COLS = ['league_id', 'season', 'week', 'rec_ledger_hash', 'near_tie', 'outcome'];
const REC_COLS = ['league_id', 'inputs_hash', 'disposition', 'horizon', 'score', 'graded_at'];

export function load(database) {
  const f = readSource(database, 'follow_ledger', FOLLOW_COLS, 'SELECT 1 LIMIT 0');
  const r = readSource(database, 'rec_ledger', REC_COLS, 'SELECT 1 LIMIT 0');
  const missing = [!f.ok && `${f.reason} (SELF-01a, #245)`, !r.ok && `${r.reason} (GR-01, #174)`].filter(Boolean);
  if (missing.length) return { rows: [], reason: missing.join('; ') };
  const rows = database.prepare(`
    SELECT f.league_id, f.season, f.week, f.outcome, f.near_tie, r.score, r.horizon
      FROM follow_ledger f
      JOIN rec_ledger r
        ON r.league_id = f.league_id AND r.inputs_hash = f.rec_ledger_hash
       AND r.disposition = 'shown' AND r.graded_at IS NOT NULL AND r.score IS NOT NULL
     WHERE f.outcome IN ('follow', 'ignore')
       AND r.horizon = (SELECT MIN(r2.horizon) FROM rec_ledger r2
                         WHERE r2.league_id = r.league_id AND r2.inputs_hash = r.inputs_hash
                           AND r2.disposition = 'shown' AND r2.graded_at IS NOT NULL AND r2.score IS NOT NULL)
     ORDER BY f.id`).all();
  return { rows };
}

export function run(database) {
  const { rows, reason } = load(database);
  return grade(rows, { reason });
}
