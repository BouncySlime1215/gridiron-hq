/**
 * A thin service over `research_trials` (migration 038, detail columns added
 * in 046) -- the general-purpose declare-then-score ledger the Giant Plan
 * built for exactly one purpose: any one-shot statistical trial that isn't
 * a model-materiality audit (`audit-registry.js`) or a segment-bias finding
 * (`nfl-candidate-findings.js`), without inventing a third bespoke table.
 *
 * This file is that ledger's first real caller: backfilling the historical
 * record of every model variant, family ablation, and candidate configuration
 * this project ever tried on the way to "zero edge against the closing
 * line" (`purged-walk-forward.js`'s docstring and
 * `docs/evidence/historical/path-to-profit-measurements.md` for the
 * headline finding), so `trial-statistics.js` has a real trial sequence to
 * correct for rather than a bare, uncorrected count of 21.
 *
 * Two disciplines, deliberately narrower than `audit-registry.js`'s:
 *
 *   IDENTITY IS STABLE. `identityHash(kind, key)` is a pure function of the
 *   trial's own declared identity (its kind and a caller-supplied key -- a
 *   model id, a candidate_id, a segment_key, an audit_registry row id).
 *   Calling `declareTrial` twice with the same (kind, key) is a no-op that
 *   returns the existing row rather than creating a duplicate, because a
 *   backfill script that is re-run (this one will be, while it is being
 *   developed and reviewed) must not inflate the trial count it exists to
 *   measure honestly.
 *
 *   BACKFILLED TRIALS ARE HONEST ABOUT WHEN THEY HAPPENED. Unlike
 *   `audit-registry.js`'s live preregister/run flow (which always uses
 *   "now"), a backfilled trial's `declared_at`/`scored_at` are the REAL
 *   historical timestamps this trial actually happened at (a git commit
 *   date, a table row's own `created_at`) -- required, not defaulted --
 *   because the entire point of reconstructing this ledger is to feed a
 *   real chronological sequence to the Geyer autocorrelation-time
 *   correction in `trial-statistics.js`. A row that defaulted to "now" would
 *   corrupt that ordering silently.
 */
import { rows, row, run } from '../db/index.js';
import { createHash } from 'node:crypto';

const VALID_STATUS = new Set(['declared', 'scored', 'void', 'error']);

export function identityHash(kind, key) {
  return createHash('sha256').update(`${kind}::${key}`).digest('hex').slice(0, 16);
}

/**
 * Insert (or, if the same kind+key already exists, return) one trial row.
 * `declaredAt`/`scoredAt` are ISO strings and both required when the trial
 * is being backfilled as already-resolved history; `scoredAt` may be null
 * for a trial whose real-world outcome is still pending (e.g. a candidate
 * finding still waiting on holdout seasons).
 */
export function declareTrial({ kind, key, declaredAt, metric, value = null, status = 'declared',
  detail = null, sourceRef = null } = {}) {
  if (!kind || !key) throw new Error('declareTrial requires kind and key');
  if (!declaredAt) throw new Error('declareTrial requires a real declaredAt (historical backfill must not default to "now")');
  if (!VALID_STATUS.has(status)) throw new Error(`status must be one of ${[...VALID_STATUS].join(', ')}`);

  const hash = identityHash(kind, key);
  const existing = row(`SELECT * FROM research_trials WHERE identity_hash=?`, hash);
  if (existing) return { ...existing, already_existed: true };

  const res = row(
    `INSERT INTO research_trials (kind, identity_hash, declared_at, metric, value, status, detail_json, source_ref)
     VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
    kind, hash, declaredAt, metric ?? null, value, status,
    detail == null ? null : JSON.stringify(detail), sourceRef);
  return { id: res.id, kind, key, identity_hash: hash, declared_at: declaredAt, metric: metric ?? null,
    value, status, detail, source_ref: sourceRef, already_existed: false };
}

/** Attach a real historical outcome to a previously-declared trial. */
export function scoreTrial(kind, key, { scoredAt, metric, value, status = 'scored', detail = null } = {}) {
  const hash = identityHash(kind, key);
  const existing = row(`SELECT * FROM research_trials WHERE identity_hash=?`, hash);
  if (!existing) throw new Error(`no declared trial for kind='${kind}' key='${key}'`);
  if (!scoredAt) throw new Error('scoreTrial requires a real scoredAt');
  if (scoredAt < existing.declared_at) {
    throw new Error(`scoredAt (${scoredAt}) precedes declared_at (${existing.declared_at}) -- ` +
      'a trial cannot be scored before it was declared (enforced again at the DB level by migration 038\'s trigger)');
  }
  const mergedDetail = detail == null ? existing.detail_json
    : JSON.stringify({ ...(existing.detail_json ? JSON.parse(existing.detail_json) : {}), ...detail });
  run(`UPDATE research_trials SET scored_at=?, metric=COALESCE(?,metric), value=?, status=?, detail_json=? WHERE id=?`,
    scoredAt, metric ?? null, value, status, mergedDetail, existing.id);
  return { ...existing, scored_at: scoredAt, value, status };
}

export function listTrials({ kind = null } = {}) {
  const all = kind
    ? rows(`SELECT * FROM research_trials WHERE kind=? ORDER BY declared_at ASC, id ASC`, kind)
    : rows(`SELECT * FROM research_trials ORDER BY declared_at ASC, id ASC`);
  return all.map(t => ({ ...t, detail: t.detail_json ? JSON.parse(t.detail_json) : null, detail_json: undefined }));
}

/**
 * The real chronological trial sequence `trial-statistics.js` needs: every
 * SCORED trial (declared-but-not-yet-scored trials carry no outcome to feed
 * an autocorrelation/effective-N calculation), ordered by when it was
 * actually run (`scored_at`), each reduced to one comparable numeric value
 * via `normalize` (kind-specific, since a win rate, an ROI, and an MAE delta
 * are not the same unit).
 */
export function scoredTrialSequence({ kind = null, normalize } = {}) {
  const scored = kind
    ? rows(`SELECT * FROM research_trials WHERE status='scored' AND value IS NOT NULL AND kind=?
        ORDER BY scored_at ASC, id ASC`, kind)
    : rows(`SELECT * FROM research_trials WHERE status='scored' AND value IS NOT NULL
        ORDER BY scored_at ASC, id ASC`);
  return scored.map(t => {
    const detail = t.detail_json ? JSON.parse(t.detail_json) : null;
    const z = normalize ? normalize({ ...t, detail }) : t.value;
    return { id: t.id, kind: t.kind, scored_at: t.scored_at, value: t.value, z, detail };
  }).filter(t => Number.isFinite(t.z));
}

export const __test = { VALID_STATUS };
