/**
 * C8 (NORTH-STAR-RND) / M10 (PEOPLE-WIRING): the share of reasoning claims
 * that came true. One brain-report row in EVAL-01's shape (#235
 * server/services/eval/common.js#result), so it joins GRADERS as one line
 * once both land; until then scripts/reasoning/grade-claims.mjs prints it.
 *
 * Pass bar (pre-registered): the Wilson 95% interval of the share of settled
 * claims (true / (true + false)) sits wholly above one half. Failing: wholly
 * below. Anything else, or fewer than MIN_N settled, is not_enough_data with
 * how many more it needs. Void claims (the test never happened) and open
 * claims are reported in detail and never enter the share. The per-manager
 * split in detail.by_team is M10's number for his side of the table.
 */
import { previewUnconfirmed, PREVIEW_ENV } from '../preview-mode.js';

export const CHECK = 'C8';
export const NAME = 'Reasoning claims come true';
export const MIN_N = 20;
const METRIC = 'share_of_settled_claims_true';
const PASS_BAR = 'Wilson 95% CI of the share of settled reasoning claims that came true is above one half';
const UNIT = 'decisions';
const Z = 1.96;

/** REASON-02 is unconfirmed forward, so it runs only under preview mode. */
export const reasoningGradingEnabled = () => previewUnconfirmed();
export const PREVIEW_REASON = 'REASON-02 claim grading is unconfirmed forward: no live week has settled a claim yet';

const r5 = v => (v == null ? null : Math.round(v * 1e5) / 1e5);

export function wilson(k, n) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (Z * Z) / n;
  const mid = (p + (Z * Z) / (2 * n)) / d;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / d;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

function row({ status, metric = null, ci = null, n = 0, needsN = null, needsText = null, detail = {} }) {
  const waiting = status === 'not_enough_data';
  return {
    check: CHECK, name: NAME, status, metric_name: METRIC, metric: r5(metric),
    ci_low: ci ? r5(ci[0]) : null, ci_high: ci ? r5(ci[1]) : null, n,
    needs_n: waiting ? needsN : null, needs_unit: waiting ? UNIT : null,
    needs_text: waiting ? (needsText ?? `needs ${needsN} more settled reasoning claims`) : null,
    pass_bar: PASS_BAR, source: 'live', detail
  };
}

function waiting(reason, n = 0) {
  const needsN = Math.max(1, MIN_N - n);
  return row({ status: 'not_enough_data', n, needsN, needsText: `needs ${needsN} more settled reasoning claims (${reason})`, detail: { reason } });
}

function tally(rows, key) {
  const out = {};
  for (const r of rows) {
    const k = r[key] ?? 'none';
    const t = (out[k] ??= { n: 0, true: 0, false: 0, void: 0, open: 0 });
    if (r.status in t) t[r.status] += 1;
    if (r.status === 'true' || r.status === 'false') t.n += 1;
  }
  for (const t of Object.values(out)) t.share = t.n ? r5(t.true / t.n) : null;
  return out;
}

/** Grade stored claim rows ({kind, status, subject_team}). */
export function grade(rows) {
  const settled = rows.filter(r => r.status === 'true' || r.status === 'false');
  const n = settled.length;
  const k = settled.filter(r => r.status === 'true').length;
  const checkable = rows.filter(r => r.kind !== 'uncheckable').length;
  const detail = {
    true: k, false: n - k,
    void: rows.filter(r => r.status === 'void').length,
    open: rows.filter(r => r.status === 'open').length,
    coverage: { checkable, all: rows.length, share: rows.length ? r5(checkable / rows.length) : null },
    by_kind: tally(rows.filter(r => r.kind !== 'uncheckable'), 'kind'),
    by_team: tally(settled, 'subject_team')
  };
  if (n < MIN_N) return row({ status: 'not_enough_data', metric: n ? k / n : null, n, needsN: MIN_N - n, detail });
  const p = k / n;
  const ci = wilson(k, n);
  if (ci[0] > 0.5) return row({ status: 'passing', metric: p, ci, n, detail });
  if (ci[1] < 0.5) return row({ status: 'failing', metric: p, ci, n, detail });
  const halfWanted = Math.max(Math.abs(p - 0.5), 0.05);
  const needsN = Math.max(1, Math.ceil((Z * Z * p * (1 - p)) / (halfWanted * halfWanted)) - n);
  return row({ status: 'not_enough_data', metric: p, ci, n, needsN, detail });
}

/** The brain-report row for C8, read from reasoning_claims (league-scoped when asked). */
export function run(database, { leagueId = null } = {}) {
  if (!reasoningGradingEnabled()) return waiting(`REASON-02 is off; ${PREVIEW_ENV}=1 turns it on`);
  const built = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reasoning_claims'").get();
  if (!built) return waiting('source table reasoning_claims is not built yet; migration 089 builds it');
  const rows = database.prepare(`SELECT kind, status, subject_team FROM reasoning_claims
    WHERE (? IS NULL OR league_id = ?)`).all(leagueId, leagueId);
  return grade(rows);
}
