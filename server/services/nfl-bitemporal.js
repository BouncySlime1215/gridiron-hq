/**
 * What did we know, and when could anyone have known it?
 *
 * Package A asks for `value_as_known(entity, feature, decision_at)`, and the
 * reason it needs its own store is that the warehouse keeps latest values.
 * `nfl_injuries` says a player is questionable; it does not say that on
 * Wednesday he was full-participation and the designation arrived Friday at
 * 4:58pm. A model trained on the latest value has read Friday's report on
 * Wednesday, the backtest looks better, and nothing in the code is wrong.
 *
 * So every fact is stored as a revision, never an update, with three clocks
 * kept apart:
 *
 *   published_at  when the source made it public — the earliest anyone could act
 *   observed_at   when this machine actually received it — the earliest WE could
 *   valid_from    the moment in the world the fact describes
 *
 * A read at a decision time returns the newest revision that satisfies both
 * `published_at <= decision_at - delay` and `observed_at <= decision_at`. The
 * second condition is the one that hurts, and it is the one that is honest: a
 * row we backfilled last night was not available to a decision three seasons
 * ago no matter what its publication timestamp says.
 *
 * That is what `provenance` records. A `captured` revision was received by this
 * machine while it was current. A `reconstructed` revision was pulled from an
 * archive afterwards; its publication time is a third party's claim about the
 * past. Reconstructed rows are legitimate research inputs and illegitimate
 * proof of what was obtainable, so the dataset builder can demand `captured`
 * and the reader always says which it handed back.
 */
import crypto from 'node:crypto';
import { rows, run } from '../db/index.js';

export const BITEMPORAL_VERSION = 'nfl-bitemporal-v1';

/** Provenance is a fact about how we got a row, so it is closed, not free text. */
export const PROVENANCE = Object.freeze({
  captured: 'Received by this machine while the value was current.',
  reconstructed: 'Read from an archive after the fact; its publication time is a third-party claim.',
  derived: 'Computed here from other stored revisions; inherits their weakest provenance.'
});

// nfl_feature_revisions, its read index and its two append-only triggers come
// from server/migrations/000_legacy_schema.js.

// `new Date(null)` is the epoch, not an error, so a missing timestamp would
// otherwise be stored as 1970 and silently satisfy every cutoff.
const iso = value => {
  if (value == null || value === '') return null;
  const when = new Date(value);
  return Number.isFinite(when.getTime()) ? when.toISOString() : null;
};

/**
 * Record one revision. Recording the same revision twice is a no-op, not a
 * second observation: re-reading an unchanged feed must not look like the
 * source said it again.
 *
 * `entitySeason`/`entityWeek` are optional: most features are not week-
 * scoped, and this store treats `entity` as an opaque key for them. A caller
 * that IS recording something tied to one game week (the injury sync is the
 * first) should pass both, so a reader can filter on them directly instead
 * of a leading-wildcard LIKE against `entity` -- see migration 050 and
 * nfl-t60-packet.js's injury read, the query that scan cost.
 */
export function recordRevision({ entity, feature, value, publishedAt, observedAt = new Date().toISOString(),
  validFrom = null, provenance, sourceId, entitySeason = null, entityWeek = null }) {
  if (!entity || !feature) throw new Error('entity and feature are required');
  if (!PROVENANCE[provenance]) throw new Error(`unknown provenance: ${provenance}`);
  if (!sourceId) throw new Error('sourceId is required; an unattributed fact is not evidence');
  const published = iso(publishedAt), observed = iso(observedAt);
  if (!published || !observed) throw new Error('publishedAt and observedAt must be timestamps');
  // Observing something before it was published is a clock or parsing bug, and
  // it is exactly the shape of a leak, so it is refused rather than stored.
  if (observed < published) throw new Error(`observed_at ${observed} precedes published_at ${published}`);
  const valueJson = JSON.stringify(value ?? null);
  const rawHash = crypto.createHash('sha256')
    .update([entity, feature, published, valueJson, sourceId].join('|')).digest('hex');
  const revisionId = crypto.createHash('sha256')
    .update([rawHash, observed, provenance].join('|')).digest('hex').slice(0, 32);
  run(`INSERT OR IGNORE INTO nfl_feature_revisions
    (revision_id,entity,feature,valid_from,published_at,observed_at,provenance,source_id,
     value_json,raw_hash,version,created_at,entity_season,entity_week)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  revisionId, entity, feature, iso(validFrom), published, observed, provenance, sourceId,
  valueJson, rawHash, BITEMPORAL_VERSION, new Date().toISOString(), entitySeason, entityWeek);
  return { revision_id: revisionId, entity, feature, published_at: published, observed_at: observed, provenance };
}

/**
 * The value a decision at `decisionAt` was entitled to use.
 *
 * `availabilityDelayMs` is the gap between a source publishing and this system
 * being able to act on it. It defaults to fifteen minutes because zero is a
 * claim — that we read every feed the instant it changed — that nothing in
 * this project has ever measured.
 *
 * Returns `{ known: false, reason }` rather than a null value, because "no
 * revision existed yet" and "the revision said null" are different facts and a
 * model that cannot tell them apart will impute the wrong one.
 */
export function valueAsKnown(entity, feature, decisionAt, {
  availabilityDelayMs = 15 * 60 * 1000, requireProvenance = null } = {}) {
  const decision = iso(decisionAt);
  if (!decision) return { known: false, reason: 'invalid_decision_time' };
  const publishCutoff = new Date(new Date(decision).getTime() - availabilityDelayMs).toISOString();
  const params = [entity, feature, publishCutoff, decision];
  let where = 'entity=? AND feature=? AND published_at<=? AND observed_at<=?';
  if (requireProvenance) { where += ' AND provenance=?'; params.push(requireProvenance); }
  const candidates = rows(`SELECT * FROM nfl_feature_revisions WHERE ${where}
    ORDER BY published_at DESC, observed_at DESC LIMIT 1`, ...params);
  const chosen = candidates[0];
  if (!chosen) {
    const everything = rows(`SELECT COUNT(*) n FROM nfl_feature_revisions WHERE entity=? AND feature=?`,
      entity, feature)[0]?.n ?? 0;
    return { known: false, reason: everything ? 'no_revision_available_yet' : 'feature_never_recorded',
      revisions_total: everything };
  }
  // How many times this fact was later corrected is the single most useful
  // number for judging whether a backtest that used the final value was
  // reading the future.
  const later = rows(`SELECT COUNT(*) n FROM nfl_feature_revisions
    WHERE entity=? AND feature=? AND published_at>?`, entity, feature, chosen.published_at)[0]?.n ?? 0;
  return { known: true, value: JSON.parse(chosen.value_json),
    revision_id: chosen.revision_id, published_at: chosen.published_at, observed_at: chosen.observed_at,
    valid_from: chosen.valid_from, provenance: chosen.provenance, source_id: chosen.source_id,
    availability_delay_ms: availabilityDelayMs,
    age_ms: new Date(decision) - new Date(chosen.published_at),
    revised_after_decision: later };
}

/** Every revision of one fact, oldest first — the audit trail behind a read. */
export function revisionHistory(entity, feature, { limit = 200 } = {}) {
  return rows(`SELECT revision_id,published_at,observed_at,provenance,source_id,value_json
    FROM nfl_feature_revisions WHERE entity=? AND feature=?
    ORDER BY published_at, observed_at LIMIT ?`, entity, feature, limit)
    .map(r => ({ ...r, value: JSON.parse(r.value_json), value_json: undefined }));
}

/**
 * How revisable is this store, and how much of it is a reconstruction?
 *
 * A feature that is revised often cannot be trusted at its final value, and a
 * store that is mostly `reconstructed` cannot support a claim about what was
 * obtainable. Both belong on the research page rather than in a footnote.
 */
export function revisionCoverage() {
  const totals = rows(`SELECT COUNT(*) revisions,COUNT(DISTINCT entity) entities,
    COUNT(DISTINCT feature) features,MIN(published_at) first_published,MAX(published_at) last_published
    FROM nfl_feature_revisions`)[0] ?? {};
  const byProvenance = rows(`SELECT provenance,COUNT(*) revisions FROM nfl_feature_revisions
    GROUP BY provenance ORDER BY revisions DESC`);
  const revised = rows(`SELECT feature,COUNT(*) revisions,COUNT(DISTINCT entity) entities,
      ROUND(1.0*COUNT(*)/COUNT(DISTINCT entity),3) revisions_per_entity
    FROM nfl_feature_revisions GROUP BY feature
    HAVING COUNT(*) > COUNT(DISTINCT entity) ORDER BY revisions_per_entity DESC LIMIT 20`);
  return { version: BITEMPORAL_VERSION, ...totals, by_provenance: byProvenance,
    most_revised_features: revised,
    caveat: 'A feature with one revision per entity has never been observed changing here. '
      + 'That is usually a sign it was loaded once from an archive, not that the world held still.' };
}

/**
 * 2026-09-12 sweep, item 15: does this store actually protect the walk-forward
 * from reading a week-keyed roster table's CURRENT value where it needed the
 * value as it was knowable at some earlier decision time?
 *
 * CHECKED, not assumed, against real server/data.sqlite (2026-09-13):
 *
 *   - `nfl_feature_revisions` holds 0 rows in production. `recordRevision` was
 *     wired into the injury sync (59c1e35, "bitemporal injury wiring", earlier
 *     today) but that sync has not run again since, so there is no revision
 *     history yet for anything, including injuries.
 *   - `valueAsKnown` (the only reader this store has) has ZERO call sites
 *     anywhere in this codebase. Even once revisions accumulate, nothing --
 *     including `availabilityDeficit()`, which `nfl-ensemble.js` actually
 *     reads for its Roster availability component -- consults them. The
 *     walk-forward reads the plain, in-place-mutated `nfl_injuries` table
 *     directly.
 *   - `nfl_injuries` (`modified_at`) and `nfl_depth` (`captured`) are the only
 *     two of the four named tables that carry ANY per-row timestamp at all.
 *     `nfl_snaps` and `player_week_usage` have no such column in the schema,
 *     so their mutation history can never be reconstructed, only assumed.
 *   - Real spread of those timestamps: 2021-2024 `nfl_injuries` rows show
 *     thousands of distinct `modified_at` values across a season (2022 week 5
 *     alone: 347 rows, 248 distinct stamps) -- real in-season revision
 *     activity, consistent with the Wed/Thu/Fri practice-report cadence. But
 *     2025 and EVERY 2026 row has `modified_at IS NULL` -- exactly the two
 *     seasons a live evaluation most needs, and exactly where this function
 *     can say the least about what the current value actually represents.
 *
 * This is therefore the plan's "coverage does not extend to these tables"
 * branch: read-as-of-time wiring is not attempted here (there is no revision
 * data yet for anything to read, and building that pipeline is a real project
 * of its own). What this function gives stage 2 instead is a per-season,
 * per-table, code-checkable verdict so a walk-forward can decide what to
 * trust rather than silently trusting all of it:
 *
 *   'no_data'                 nothing stored for this season.
 *   'no_timestamp_evidence'   every row's timestamp is NULL -- 2025 and 2026
 *                             today -- cannot rule out a post-hoc mutation.
 *   'single_capture_low_risk' exactly one distinct timestamp all season --
 *                             consistent with one historical bulk load, so
 *                             there is no in-season revision trail to leak
 *                             from in the first place.
 *   'revision_evidence_present' a real, spread-out capture cadence -- the
 *                             stored value is very likely each week's own
 *                             final pre-kickoff report, which is legitimate
 *                             information for grading THAT week, but this is
 *                             still not a code-level guarantee.
 *
 * `nfl_snaps` and `player_week_usage` always report 'no_timestamp_column':
 * they describe completed-play outcomes for weeks already final, which are
 * structurally far less likely to be revised with hindsight than a pregame
 * report -- but the schema cannot prove that either way.
 *
 * STATED ASSUMPTION for stage 2, following from the above: exclude 2025 and
 * 2026 from any walk-forward comparison that leans on the Roster availability
 * family (`availability`, `roster_strength`) or treat those two seasons'
 * results on that family as unverified, until either real revision data
 * exists to check against or the tables gain a capture timestamp of their
 * own. 2015-2024 are not proven safe by any code path, but carry the better
 * evidence available today.
 */
export function weekKeyedTableMutationRisk() {
  const verdictFor = s => {
    if (!s || !s.rows) return 'no_data';
    if (s.distinct_stamps === 0) return 'no_timestamp_evidence';
    if (s.distinct_stamps === 1) return 'single_capture_low_risk';
    return 'revision_evidence_present';
  };
  // `available_stamped` (BITEMPORAL, migration 100): rows carrying this machine's
  // availability clock. Reported beside the verdict, not folded into it: the verdict
  // is about the SOURCE's event clock, and our capture time is not evidence of that.
  const injuries = rows(`SELECT season, COUNT(*) rows, COUNT(DISTINCT modified_at) distinct_stamps,
      COUNT(available_at) available_stamped
    FROM nfl_injuries GROUP BY season ORDER BY season`).map(s => ({ ...s, verdict: verdictFor(s) }));
  const depth = rows(`SELECT season, COUNT(*) rows, COUNT(DISTINCT captured) distinct_stamps
    FROM nfl_depth GROUP BY season ORDER BY season`).map(s => ({ ...s, verdict: verdictFor(s) }));
  const revisionRows = rows(`SELECT COUNT(*) n FROM nfl_feature_revisions`)[0]?.n ?? 0;
  return {
    revision_store_rows: revisionRows,
    revision_store_reader_wired: false,
    tables: {
      nfl_injuries: injuries,
      nfl_depth: depth,
      nfl_snaps: { verdict: 'no_timestamp_column' },
      player_week_usage: { verdict: 'no_timestamp_column' }
    },
    unproven_seasons: [...new Set([...injuries, ...depth]
      .filter(s => s.verdict === 'no_timestamp_evidence' || s.verdict === 'no_data')
      .map(s => s.season))].sort((a, b) => a - b),
    guidance: 'A season in unproven_seasons (or either table always, for nfl_snaps/player_week_usage) ' +
      'has no evidence ruling out a "week < target" read returning a value mutated with hindsight. ' +
      'Exclude those seasons from a walk-forward comparison on the Roster availability family, or bound ' +
      'the claim explicitly, until the revision store above actually has readers.'
  };
}
