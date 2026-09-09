/**
 * Phase 3 of the 2026-09-09 learning-pipeline plan: turns nfl-replay.js's
 * (now Holm-corrected, effect-size-gated, leave-one-season-out-checked)
 * segment findings into a tracked, accumulating, eventually-actionable
 * record — the missing middle between "the diagnostic tool found something"
 * and "a human can safely act on it," mirroring model-governance.js's
 * model_registry/model_gate_audits pattern at segment-finding grain.
 *
 * Lifecycle: pending_confirmation -> discovered -> validating -> validated
 * -> flagged_for_review -> promoted/rejected.
 *
 *   - pending_confirmation -> discovered requires the SAME segment to be
 *     independently flagged by TWO separate single-season analyses before
 *     it is even registered as a real candidate — because this search now
 *     runs every season forever, and a search repeated over time is its own
 *     multiple-comparisons problem on top of the one Holm correction already
 *     solves within a single run.
 *   - discovered -> validating -> validated requires THREE further,
 *     non-overlapping seasons to each independently confirm the frozen rule
 *     via proposeAdjustment (nfl-replay.js), never a redefinition of it.
 *   - validated -> flagged_for_review is automatic and changes nothing live
 *     — it only makes the finding visible.
 *   - flagged_for_review -> promoted is the ONE transition a person makes
 *     explicitly, via `promoteFindingToShrink` below. Nothing in this file,
 *     the scheduler, or any route calls that function automatically.
 *
 * The single hard invariant this whole file exists to enforce: a season can
 * never change role for a given finding. `nfl_candidate_finding_seasons` has
 * a UNIQUE(finding_id, season) constraint that makes this a database fact,
 * not just application discipline — recordDiscoveryFlag/recordHoldoutTest
 * both check it proactively (for a clear error message) and rely on it (in
 * case a future edit forgets to check).
 */
import { rows, row, run } from '../db/index.js';
import { replaySeason, analyzeErrors, proposeAdjustment, segmentRuleHash, segmentsFor, gameContext } from './nfl-replay.js';

const REQUIRED_HOLDOUT_CONFIRMATIONS = 3;

const segmentKeyFor = s => `${s.dimension}|${s.segment}`;

function findingByKey(segmentKey) {
  return row(`SELECT * FROM nfl_candidate_findings WHERE segment_key=?`, segmentKey);
}

function seasonsForFinding(findingId, role = null) {
  return rows(`SELECT season, role, holdout_passed FROM nfl_candidate_finding_seasons
    WHERE finding_id=? ${role ? 'AND role=?' : ''} ORDER BY season`, ...(role ? [findingId, role] : [findingId]));
}

/** Throws with a clear message if `season` has already been used in the
 * OTHER role for this finding — the one hard rule this file exists for. */
function assertSeasonRoleAvailable(findingId, season, role) {
  const existing = row(`SELECT role FROM nfl_candidate_finding_seasons WHERE finding_id=? AND season=?`, findingId, season);
  if (existing && existing.role !== role) {
    throw new Error(`season ${season} was already used as '${existing.role}' for this finding — cannot also use it as '${role}'`);
  }
}

/**
 * Runs `analyzeErrors` on exactly one season's own bets (never a pooled
 * multi-season window) — the atomic unit of evidence this whole file
 * accumulates over time, one real season at a time, the same cadence this
 * would actually run at in production (once per completed season).
 */
function singleSeasonFindings(season, config = {}) {
  const replay = replaySeason(season, config);
  if (replay.error) return { error: replay.error, season };
  const analysis = analyzeErrors(replay.bets, { minBets: config.minBets ?? 25 });
  return { season, weakest: analysis.weakest, strongest: analysis.strongest, bets: replay.bets.length };
}

/**
 * Registers a finding a HUMAN noticed by looking at real results, rather
 * than one the automatic per-season search flagged. This is honest about
 * the risk that framing implies: looking at data and then proposing to test
 * exactly the pattern that looked bad is how spurious findings get
 * "confirmed" by data snooping. So this does not skip the rigor — it front-
 * loads it. Every season the human actually looked at is locked in as this
 * finding's `discovery_seasons` PERMANENTLY (Rule 1: a season can never
 * change role), which means those seasons can never later be used as
 * holdout for this exact segment_key. The finding starts directly in
 * `discovered` (skipping pending_confirmation, since the two-independent-
 * flags requirement doesn't apply to a single manual observation the same
 * way — the honesty here is in the season-locking, not in re-deriving a
 * discovery step that already happened) and still needs
 * REQUIRED_HOLDOUT_CONFIRMATIONS non-overlapping seasons that come AFTER
 * the seasons already looked at before it can ever reach flagged_for_review.
 */
export function registerManuallyObservedFinding(segment, observedSeasons, { note } = {}) {
  const key = segmentKeyFor(segment);
  const existing = findingByKey(key);
  if (existing) throw new Error(`a finding for '${key}' already exists (state: ${existing.state}) — cannot re-register`);
  const sortedSeasons = [...observedSeasons].sort((a, b) => a - b);
  const ruleHash = segmentRuleHash(segment);
  const insert = run(`INSERT INTO nfl_candidate_findings
    (segment_key, dimension, segment, direction, state, rule_definition_hash, discovery_seasons_json, confirmed_at, discovery_note)
    VALUES (?,?,?,?, 'discovered', ?, ?, datetime('now'), ?)`,
    key, segment.dimension, segment.segment, segment.win_rate < 0.5 ? 'weak' : 'strong', ruleHash, JSON.stringify(sortedSeasons),
    note ?? `Manually observed by looking at real results across seasons ${sortedSeasons.join(', ')} — these seasons are locked in as discovery and can never serve as holdout for this finding.`);
  const findingId = insert.lastInsertRowid;
  for (const season of sortedSeasons) {
    run(`INSERT INTO nfl_candidate_finding_seasons (finding_id, season, role) VALUES (?,?,'discovery')`, findingId, season);
  }
  return { finding_id: findingId, segment_key: key, state: 'discovered', discovery_seasons: sortedSeasons,
    note: 'Needs holdout confirmations from seasons NOT in this list before it can ever be validated.' };
}

/**
 * Feeds one season's flagged segments into the pending_confirmation ->
 * discovered step. Called once per segment found in that season's analysis.
 */
function recordDiscoveryFlag(segment, season) {
  const key = segmentKeyFor(segment);
  const existing = findingByKey(key);

  if (!existing) {
    const insert = run(`INSERT INTO nfl_candidate_findings (segment_key, dimension, segment, direction, state)
      VALUES (?,?,?,?, 'pending_confirmation')`, key, segment.dimension, segment.segment, segment.win_rate < 0.5 ? 'weak' : 'strong');
    const findingId = insert.lastInsertRowid;
    run(`INSERT INTO nfl_candidate_finding_seasons (finding_id, season, role) VALUES (?,?,'discovery')`, findingId, season);
    return { finding_id: findingId, segment_key: key, state: 'pending_confirmation', action: 'first_flag' };
  }

  if (existing.state !== 'pending_confirmation') {
    return { finding_id: existing.id, segment_key: key, state: existing.state, action: 'already_past_discovery' };
  }

  const discoverySeasonsSoFar = seasonsForFinding(existing.id, 'discovery').map(r => r.season);
  if (discoverySeasonsSoFar.includes(season)) {
    return { finding_id: existing.id, segment_key: key, state: existing.state, action: 'duplicate_flag_same_season' };
  }

  // A second, independent (necessarily different) season flags the same
  // segment: Rule 3 satisfied. Freeze the rule and promote to `discovered`.
  assertSeasonRoleAvailable(existing.id, season, 'discovery');
  run(`INSERT INTO nfl_candidate_finding_seasons (finding_id, season, role) VALUES (?,?,'discovery')`, existing.id, season);
  const allDiscoverySeasons = [...discoverySeasonsSoFar, season].sort((a, b) => a - b);
  const ruleHash = segmentRuleHash(segment);
  run(`UPDATE nfl_candidate_findings SET state='discovered', rule_definition_hash=?, discovery_seasons_json=?, confirmed_at=datetime('now') WHERE id=?`,
    ruleHash, JSON.stringify(allDiscoverySeasons), existing.id);
  return { finding_id: existing.id, segment_key: key, state: 'discovered', action: 'independently_reconfirmed', discovery_seasons: allDiscoverySeasons };
}

/**
 * Pure decision function, exported so this exact logic is unit-testable
 * without needing a full ensemble replay fixture: given the finding's
 * CURRENT state and every holdout row recorded so far (including the one
 * just added), what state should it be in now?
 *
 *   - Any failed holdout is disqualifying, automatically — a finding does
 *     not get to cherry-pick 3 good years while a bad one is ignored. This
 *     needs no human gate because it only ever records a fact (the rule
 *     failed to hold on real out-of-sample data).
 *   - REQUIRED_HOLDOUT_CONFIRMATIONS non-overlapping passes, with zero
 *     failures, reaches flagged_for_review directly (validated and
 *     flagged_for_review are the same moment in this orchestrator, since it
 *     only checks in once per season).
 *   - Otherwise stays in validating (still accumulating evidence).
 */
export function nextHoldoutState(currentState, holdoutRows) {
  const passedCount = holdoutRows.filter(r => r.holdout_passed === 1).length;
  const failedCount = holdoutRows.filter(r => r.holdout_passed === 0).length;
  if (failedCount > 0) return 'rejected';
  if (passedCount >= REQUIRED_HOLDOUT_CONFIRMATIONS) return 'flagged_for_review';
  return currentState === 'discovered' || currentState === 'validating' ? 'validating' : currentState;
}

/**
 * Tests a `discovered`/`validating` finding's frozen rule against one new
 * holdout season, via `proposeAdjustment` (nfl-replay.js) — which itself
 * throws if the season sets overlap, so this never needs to re-implement
 * that check, only surface it clearly.
 */
function recordHoldoutTest(finding, season, config = {}) {
  assertSeasonRoleAvailable(finding.id, season, 'holdout');
  const discoverySeasons = JSON.parse(finding.discovery_seasons_json);
  const segment = { dimension: finding.dimension, segment: finding.segment, win_rate: finding.direction === 'weak' ? 0.4 : 0.6 };
  let result;
  try {
    result = proposeAdjustment(segment, { discoverySeasons, holdoutSeasons: [season], config });
  } catch (e) {
    return { finding_id: finding.id, segment_key: finding.segment_key, error: e.message };
  }
  const passed = result.helped_holdout === true;
  run(`INSERT INTO nfl_candidate_finding_seasons (finding_id, season, role, holdout_passed, holdout_result_json)
    VALUES (?,?,'holdout',?,?)`, finding.id, season, passed ? 1 : 0, JSON.stringify(result));

  const holdoutRows = seasonsForFinding(finding.id, 'holdout');
  const passedCount = holdoutRows.filter(r => r.holdout_passed === 1).length;
  const newState = nextHoldoutState(finding.state, holdoutRows);
  if (newState === 'rejected') {
    run(`UPDATE nfl_candidate_findings SET state=?, resolved_at=datetime('now'), resolved_by='system', resolution_note=? WHERE id=?`,
      newState, `Failed holdout test in season ${season} — a segment finding must hold on every tested season, not just a favorable majority.`, finding.id);
  } else if (newState === 'flagged_for_review') {
    run(`UPDATE nfl_candidate_findings SET state=?, validated_at=datetime('now'), flagged_at=datetime('now') WHERE id=?`, newState, finding.id);
  } else {
    run(`UPDATE nfl_candidate_findings SET state=? WHERE id=?`, newState, finding.id);
  }
  return { finding_id: finding.id, segment_key: finding.segment_key, season, passed, holdout_confirmations: passedCount,
    required: REQUIRED_HOLDOUT_CONFIRMATIONS, state: newState };
}

/**
 * The season-end orchestrator — call this once per real completed season
 * (from nfl-model-growth.js's season-end branch, alongside Phase 1's
 * offseason refresh). Guards against running while a blind-audit run is in
 * progress, since a live job touching shared model-fit state mid-audit is
 * exactly the class of bug this project hit tonight (a fresh replay here
 * would touch the same ensemble/fit caches assertFrozen() watches).
 */
export function runCandidateFindingsForSeasonEnd(season, config = {}) {
  const activeAudit = row(`SELECT id FROM nfl_blind_audit_runs WHERE status='running' LIMIT 1`);
  if (activeAudit) {
    return { skipped: true, reason: `a blind audit run (#${activeAudit.id}) is currently in progress — deferring to avoid touching shared model-fit state mid-audit` };
  }

  const single = singleSeasonFindings(season, config);
  if (single.error) return { season, error: single.error };

  const discoveryActions = [];
  for (const segment of [...single.weakest, ...single.strongest]) {
    discoveryActions.push(recordDiscoveryFlag(segment, season));
  }

  // Every OTHER already-discovered-or-later finding not touched by this
  // season's OWN discovery flags gets this season offered as a holdout test
  // — this is how a season a finding never flagged in accumulates evidence
  // against it too, not just seasons that happened to re-flag it.
  const flaggedKeysThisSeason = new Set(discoveryActions.map(a => a.segment_key));
  const eligibleForHoldout = rows(`SELECT * FROM nfl_candidate_findings WHERE state IN ('discovered','validating')`);
  const holdoutActions = [];
  for (const finding of eligibleForHoldout) {
    if (flaggedKeysThisSeason.has(finding.segment_key)) continue; // this season already played discovery's role for it this cycle
    const alreadyUsed = row(`SELECT 1 ok FROM nfl_candidate_finding_seasons WHERE finding_id=? AND season=?`, finding.id, season);
    if (alreadyUsed) continue;
    holdoutActions.push(recordHoldoutTest(finding, season, config));
  }

  return { season, bets_analyzed: single.bets, segments_flagged_this_season: discoveryActions.length,
    discovery_actions: discoveryActions, holdout_actions: holdoutActions };
}

/**
 * Reads every `promoted` finding and checks whether a live candidate bet
 * falls in one of their frozen segments — the actual downstream consumer
 * `promoteFindingToShrink` writes a record for but does nothing with on its
 * own. Built 2026-09-09, wired into `nfl-auto-picks.js`'s live decision
 * board ONLY (never `replaySeason`/the blind audit — a future promotion
 * must never leak into grading seasons that already happened).
 *
 * Reuses the exact same `segmentsFor` (nfl-replay.js) that discovered and
 * validated the finding in the first place, so there is zero drift between
 * "what was proven" and "what gets checked live" — two separate
 * re-implementations of the same predicate is exactly how this kind of
 * system quietly breaks.
 *
 * Shrink-only, matching this project's standing convention
 * (nfl-signal-reliability.js): the only action is a full veto (abstain on
 * this bet) — the same mechanical "stop betting this segment" correction
 * `proposeAdjustment` already validated during holdout testing. It never
 * boosts a bet, and with zero promoted findings (true as of tonight) this
 * is a guaranteed no-op — verified by its own test.
 */
export function promotedFindingVeto(bet) {
  const promoted = rows(`SELECT * FROM nfl_candidate_findings WHERE state='promoted'`);
  if (!promoted.length) return { vetoed: false };
  const ctx = gameContext();
  const betSegments = new Set(segmentsFor(bet, ctx).map(([dim, val]) => `${dim}|${val}`));
  for (const finding of promoted) {
    if (betSegments.has(finding.segment_key)) {
      return { vetoed: true, finding_id: finding.id, segment_key: finding.segment_key,
        reason: `Matches promoted finding '${finding.segment_key}' — proven unreliable across ${JSON.parse(finding.discovery_seasons_json ?? '[]').length}+ seasons of validation.` };
    }
  }
  return { vetoed: false };
}

/**
 * The ONLY code path that lets a finding touch anything live — explicitly
 * invoked by a person, mirroring model-governance.js's promoteEligibleAudit.
 * From this moment, `promotedFindingVeto` above (wired into the live
 * decision board) will abstain on any bet matching this segment.
 */
export function promoteFindingToShrink(findingId, { actor, reason } = {}) {
  const finding = row(`SELECT * FROM nfl_candidate_findings WHERE id=?`, Number(findingId));
  if (!finding) throw new Error('candidate finding not found');
  if (finding.state !== 'flagged_for_review') {
    throw new Error(`a finding can only be promoted from 'flagged_for_review' (current state: '${finding.state}')`);
  }
  if (!actor) throw new Error('promoteFindingToShrink requires an explicit actor — this is never called automatically');
  run(`UPDATE nfl_candidate_findings SET state='promoted', resolved_at=datetime('now'), resolved_by=?, resolution_note=? WHERE id=?`,
    actor, reason ?? null, finding.id);
  return row(`SELECT * FROM nfl_candidate_findings WHERE id=?`, finding.id);
}

export function rejectFinding(findingId, { actor, reason } = {}) {
  const finding = row(`SELECT * FROM nfl_candidate_findings WHERE id=?`, Number(findingId));
  if (!finding) throw new Error('candidate finding not found');
  if (!actor) throw new Error('rejectFinding requires an explicit actor');
  run(`UPDATE nfl_candidate_findings SET state='rejected', resolved_at=datetime('now'), resolved_by=?, resolution_note=? WHERE id=?`,
    actor, reason ?? null, finding.id);
  return row(`SELECT * FROM nfl_candidate_findings WHERE id=?`, finding.id);
}

export function candidateFindingsStatus() {
  const findings = rows(`SELECT * FROM nfl_candidate_findings ORDER BY id`);
  return findings.map(f => ({ ...f, discovery_seasons: f.discovery_seasons_json ? JSON.parse(f.discovery_seasons_json) : null,
    seasons: seasonsForFinding(f.id), discovery_seasons_json: undefined }));
}

export const __test = { singleSeasonFindings, recordDiscoveryFlag, recordHoldoutTest, assertSeasonRoleAvailable };
