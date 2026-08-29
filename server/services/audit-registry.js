/**
 * An audit system that cannot be talked into a better answer.
 *
 * The problem this solves is not measurement, it is memory. Every component in
 * this project can already be graded; what nothing prevented was running a
 * grader repeatedly, tweaking between runs, and keeping the version that
 * happened to look good. That is p-hacking, it is easy to do without noticing,
 * and it is how twenty-one models with no edge survived here for so long.
 *
 * Three properties, deliberately:
 *
 *   NO MEMORY. An audit executes a pure function against the data as it stands.
 *   It never reads a prior audit's result, so nothing it computes can be
 *   influenced by what a previous run reported. There is no state to adapt to.
 *
 *   SEALED ON FIRST RUN. Each preregistration executes exactly once and the
 *   result is immutable. You cannot re-run an audit until it agrees with you.
 *   Wanting a second look means filing a NEW preregistration, which is visible.
 *
 *   COUNTED. The registry knows how many hypotheses have been tested, and
 *   reports a multiple-comparisons corrected threshold alongside every raw
 *   p-value. Running twenty audits and reporting the best one is exactly how a
 *   coin flip becomes a discovery, and the correction makes that arithmetic
 *   impossible to skip.
 *
 * The pass criterion is declared BEFORE the number is known, which is the part
 * that makes the whole thing work. An audit whose threshold is chosen after
 * seeing the result is not an audit, it is a description.
 */
import { rows, row, run } from '../db/index.js';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

run(`CREATE TABLE IF NOT EXISTS audit_registry (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  hypothesis     TEXT NOT NULL,
  metric         TEXT NOT NULL,
  direction      TEXT NOT NULL,
  threshold      REAL NOT NULL,
  preregistered_at TEXT NOT NULL,
  code_hash      TEXT NOT NULL,
  data_signature TEXT NOT NULL,
  status         TEXT NOT NULL,
  ran_at         TEXT,
  observed       REAL,
  passed         INTEGER,
  p_value        REAL,
  sample_size    INTEGER,
  detail_json    TEXT,
  void_reason    TEXT
)`);

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/**
 * A hash of the code that will produce the answer.
 *
 * Recorded at preregistration and checked at run time. If the services changed
 * in between, the audit is void rather than merely stale — an audit run against
 * different code than the one it was registered for is measuring something
 * nobody committed to.
 */
function codeHash() {
  const dir = new URL('.', import.meta.url).pathname;
  const files = readdirSync(dir).filter(f => f.endsWith('.js')).sort();
  const h = createHash('sha256');
  for (const f of files) {
    try { h.update(f).update(readFileSync(join(dir, f))); } catch { /* unreadable is fine */ }
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * A signature of the data the audit will read.
 *
 * Row counts across the tables that matter. Not a full checksum — the point is
 * to notice that the evidence base moved, not to prove it did not.
 */
function dataSignature() {
  const tables = ['game_lines', 'nfl_team_week_features', 'nfl_play_by_play',
    'nfl_injuries', 'nfl_line_snapshots', 'espn_line_moves'];
  const parts = [];
  for (const t of tables) {
    try { parts.push(`${t}:${row(`SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0}`); }
    catch { parts.push(`${t}:absent`); }
  }
  return parts.join('|');
}

/**
 * Declare what is being tested and what would count as passing — before the
 * number exists.
 *
 * @param direction  'above' or 'below'; which side of `threshold` passes
 */
export function preregister({ name, hypothesis, metric, direction = 'above', threshold } = {}) {
  if (!name || !hypothesis || !metric) {
    return { error: 'name, hypothesis and metric are all required — an audit without a stated ' +
      'hypothesis is just a number' };
  }
  if (!Number.isFinite(threshold)) {
    return { error: 'a numeric threshold is required, and it must be chosen now rather than after ' +
      'the result is known' };
  }
  if (!['above', 'below'].includes(direction)) {
    return { error: "direction must be 'above' or 'below'" };
  }

  const res = row(
    `INSERT INTO audit_registry
     (name, hypothesis, metric, direction, threshold, preregistered_at, code_hash,
      data_signature, status)
     VALUES (?,?,?,?,?,?,?,?,'preregistered') RETURNING id`,
    name, hypothesis, metric, direction, threshold,
    new Date().toISOString(), codeHash(), dataSignature());

  return { audit_id: res?.id, name, hypothesis, metric, direction, threshold,
    status: 'preregistered',
    note: 'The pass criterion is now locked. Running this audit will seal its result permanently; ' +
      'it cannot be re-run, and a second look requires a new preregistration that the registry will ' +
      'count against the multiple-comparisons correction.' };
}

/**
 * Execute a preregistered audit exactly once.
 *
 * `producer` is an async function returning `{ observed, sample_size, p_value?, detail? }`.
 * It is handed nothing about previous audits, because it must not be able to
 * condition on them.
 */
export async function runAudit(auditId, producer) {
  const a = row(`SELECT * FROM audit_registry WHERE id = ?`, auditId);
  if (!a) return { error: `no preregistered audit with id ${auditId}` };
  if (a.status !== 'preregistered') {
    return { error: `audit ${auditId} is already ${a.status} and cannot be run again`,
      ran_at: a.ran_at, observed: a.observed, passed: !!a.passed,
      note: 'Sealed on first run by design. File a new preregistration to test this again — the ' +
        'registry will count it, which is the honest cost of a second look.' };
  }

  // Void rather than run if the ground moved underneath the registration.
  const nowCode = codeHash(), nowData = dataSignature();
  if (nowCode !== a.code_hash) {
    run(`UPDATE audit_registry SET status='void', void_reason=? WHERE id=?`,
      'code changed between preregistration and run', auditId);
    return { error: 'void: the service code changed after this audit was preregistered',
      registered_hash: a.code_hash, current_hash: nowCode,
      note: 'An audit run against different code than it was registered for is not the audit that ' +
        'was committed to. Preregister again against the current code.' };
  }

  let result;
  try { result = await producer(); }
  catch (e) {
    run(`UPDATE audit_registry SET status='error', void_reason=? WHERE id=?`, e.message, auditId);
    return { error: `audit producer threw: ${e.message}` };
  }

  const observed = Number(result?.observed);
  if (!Number.isFinite(observed)) {
    run(`UPDATE audit_registry SET status='error', void_reason=? WHERE id=?`,
      'producer returned no finite observed value', auditId);
    return { error: 'the audit produced no finite observed value' };
  }

  const passed = a.direction === 'above' ? observed > a.threshold : observed < a.threshold;
  const dataMoved = nowData !== a.data_signature;

  run(`UPDATE audit_registry SET status='sealed', ran_at=?, observed=?, passed=?, p_value=?,
       sample_size=?, detail_json=?, void_reason=? WHERE id=?`,
  new Date().toISOString(), observed, passed ? 1 : 0,
  Number.isFinite(result?.p_value) ? result.p_value : null,
  Number.isFinite(result?.sample_size) ? result.sample_size : null,
  JSON.stringify(result?.detail ?? null),
  dataMoved ? 'data signature changed since preregistration (result kept, flagged)' : null,
  auditId);

  return {
    audit_id: auditId, name: a.name, hypothesis: a.hypothesis,
    metric: a.metric, direction: a.direction, threshold: a.threshold,
    observed: r4(observed), passed, sample_size: result?.sample_size ?? null,
    p_value: r4(result?.p_value),
    data_changed_since_registration: dataMoved,
    status: 'sealed',
    note: 'Sealed. This result is now immutable and counts toward the multiple-comparisons ' +
      'correction reported by auditHistory().'
  };
}

/**
 * Every audit ever filed, with the correction that makes them readable together.
 *
 * The raw threshold for significance is only valid for a single prespecified
 * test. Once N hypotheses have been tested, the chance that at least one clears
 * 0.05 by luck is roughly 1 - 0.95^N — over half by the fourteenth test. The
 * Šidák-corrected threshold below is what a p-value actually has to beat here.
 */
export function auditHistory({ alpha = 0.05 } = {}) {
  const all = rows(`SELECT * FROM audit_registry ORDER BY id DESC`);
  const sealed = all.filter(a => a.status === 'sealed');
  const n = Math.max(1, sealed.length);
  const corrected = 1 - Math.pow(1 - alpha, 1 / n);
  const withP = sealed.filter(a => Number.isFinite(a.p_value));

  return {
    total_filed: all.length,
    sealed: sealed.length,
    preregistered_not_yet_run: all.filter(a => a.status === 'preregistered').length,
    void_or_error: all.filter(a => ['void', 'error'].includes(a.status)).length,
    passed: sealed.filter(a => a.passed).length,
    failed: sealed.filter(a => !a.passed).length,

    multiple_comparisons: {
      tests_run: sealed.length,
      nominal_alpha: alpha,
      sidak_corrected_alpha: r4(corrected),
      chance_of_one_false_positive_uncorrected: r4(1 - Math.pow(1 - alpha, sealed.length)),
      survive_correction: withP.filter(a => a.p_value < corrected).map(a => a.name),
      significant_uncorrected_only: withP
        .filter(a => a.p_value < alpha && a.p_value >= corrected).map(a => a.name)
    },

    audits: all.map(a => ({
      id: a.id, name: a.name, status: a.status,
      metric: a.metric, direction: a.direction, threshold: a.threshold,
      observed: r4(a.observed),
      passed: a.status === 'sealed' ? !!a.passed : null,
      p_value: r4(a.p_value), sample_size: a.sample_size,
      preregistered_at: a.preregistered_at, ran_at: a.ran_at,
      flag: a.void_reason
    })),

    note: 'Every audit is sealed on its first run and never re-run, so no result here has been ' +
      'retried until it looked better. The corrected alpha is what a p-value must beat given how ' +
      'many hypotheses have been tested in total — running more audits makes each one harder to ' +
      'pass, which is the correct incentive.'
  };
}

/** One audit's sealed record. */
export function auditDetail(auditId) {
  const a = row(`SELECT * FROM audit_registry WHERE id = ?`, auditId);
  if (!a) return { error: `no audit ${auditId}` };
  let detail = null;
  try { detail = JSON.parse(a.detail_json ?? 'null'); } catch { /* keep null */ }
  return { ...a, detail, detail_json: undefined };
}
