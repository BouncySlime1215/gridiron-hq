export const name = '048_research_trials_detail';

/**
 * Giant Plan Step 2b (purged-evaluation stage): `research_trials` (038) is
 * deliberately narrow -- kind/identity_hash/declared_at/scored_at/metric/
 * value/status, nothing else -- because migration 038 had no concrete caller
 * yet and did not want to guess at a shape.
 *
 * Backfilling the REAL trial history (21 historical spread-ensemble
 * component models, 5 family-ablation configs, the candidate model variants
 * in nfl_candidate_input_audits/nfl_candidate_robustness_audits, and the
 * segment-search findings in nfl_candidate_findings) needs two more things
 * per row that the narrow shape has nowhere to put:
 *
 *   detail_json  -- the human-readable identity of the trial (model id/name/
 *                   family, candidate_id, segment_key, audit name, ...) plus
 *                   whatever numeric detail survives (win rate, ROI, MAE
 *                   delta, sample size). `audit_registry.detail_json` and
 *                   `nfl_feature_ablation_audits.results_json` already use
 *                   exactly this pattern for the same reason: a trial's
 *                   identity is not one scalar.
 *   source_ref   -- WHERE the row was reconstructed from: a git commit hash,
 *                   a docs/evidence/ path, or a source table + row id. A
 *                   backfilled trial without a source is a claim with no way
 *                   to check it, which is the exact failure mode this whole
 *                   stage exists to avoid.
 *
 * Both are nullable additions to an existing table (no rebuild needed --
 * SQLite's ADD COLUMN is safe here because research_trials has no FOREIGN
 * KEY or table-level CHECK/UNIQUE this would interact with beyond the
 * existing column CHECK, which ADD COLUMN does not touch).
 */
export function up(db) {
  const cols = db.prepare(`PRAGMA table_info(research_trials)`).all().map(c => c.name);
  if (!cols.includes('detail_json')) {
    db.exec(`ALTER TABLE research_trials ADD COLUMN detail_json TEXT`);
  }
  if (!cols.includes('source_ref')) {
    db.exec(`ALTER TABLE research_trials ADD COLUMN source_ref TEXT`);
  }
}

export function down(db) {
  // SQLite can DROP COLUMN directly (3.35+) as long as the column carries no
  // constraint beyond nullability, which is the case for both of these.
  const cols = db.prepare(`PRAGMA table_info(research_trials)`).all().map(c => c.name);
  if (cols.includes('source_ref')) db.exec(`ALTER TABLE research_trials DROP COLUMN source_ref`);
  if (cols.includes('detail_json')) db.exec(`ALTER TABLE research_trials DROP COLUMN detail_json`);
}
