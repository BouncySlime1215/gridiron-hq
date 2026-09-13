/**
 * The append-only decision tape.
 *
 * `nfl_pick_decisions` used to be a MUTABLE latest view written independently
 * by its own caller: it UPSERTs over (season, week, policy_id, matchup,
 * market, selection) -- a key that omits policy_version -- so re-running the
 * board after a line moved overwrites what the model actually decided before
 * it moved. And the execution pipeline only wrote evidence for candidates it
 * SELECTED, so a run that selected nothing left no record that anything was
 * ever considered.
 *
 * This module is the evidence layer those two facts require: every candidate
 * is recorded, eligible or not, with its abstention reason, and the rows are
 * append-only at the schema level (migrations 027 and 031) rather than by
 * convention.
 *
 * ---------------------------------------------------------------------------
 * Codex corrections C01 and C02 (2026-09-10). The first version of this file
 * recorded a decision tape that could not tell two different decisions apart.
 * Four separate defects, all reproduced against fixtures before this rewrite:
 *
 *   1. **It hashed a field the board does not emit.** The fingerprint read
 *      `d.edge`; `nfl-auto-picks.js` emits `edge_points` (and the signed value
 *      under `feature_snapshot.raw_forecast.signed_edge_points`). So `edge`
 *      was `undefined` in every fingerprint and NULL in every persisted row.
 *      Changing the forecast from 5 to 12 and the edge from 2 to 9 produced
 *      the same hash and reused the same run.
 *
 *   2. **It omitted the forecast entirely.** No probability, no forecast
 *      identity, no calibration identity, no active model set, no engine mode.
 *      Switching model A for model B, or champion for candidate, collided.
 *
 *   3. **Content identity and observation identity were the same thing.** A
 *      board hash was UNIQUE, so a genuinely distinct declared observation --
 *      a second scheduled T-60 run for the same game -- could not be recorded
 *      at all if its numbers happened to be identical. The plan is explicit
 *      that these are different: "a retry of one observation is idempotent,
 *      but a distinct declared observation must survive even if all numbers
 *      are equal." They are now separate columns with separate rules.
 *
 *   4. **Nothing was atomic and nothing was validated.** The header and its
 *      children were inserted outside any transaction, so an invalid child
 *      left a header claiming N decisions with fewer than N events behind it,
 *      and the retry path then returned `created:false` for that broken run as
 *      though it were complete.
 *
 * `code_hash` and `data_hash` were also accepted as arbitrary caller-supplied
 * strings. They are now checked: the code identity is computed from the actual
 * module closure (server/platform/code-identity.js), and where a real frozen
 * input packet does not exist yet the run records `data_identity_status`
 * saying so instead of a hash that implies one does. That status is inside the
 * content hash, so a decision made from unfrozen live tables can never collide
 * with the same numbers made from a frozen packet once C11 lands.
 *
 * ---------------------------------------------------------------------------
 * Stage 2 engine unification (2026-09-13): ONE WRITER.
 *
 * Giant Plan 8.10 (G08) had already demoted `nfl_pick_decisions` to "read/cache
 * role only" in doc comments, but two independent code paths still wrote it
 * directly from a raw decision board: scheduler.js's refreshNflDecisionLedger
 * (which also, separately, called recordDecisionRun -- two writes from the
 * same board, not one derived from the other) and nfl-market.js's
 * `/sync-and-pick` route (which wrote it ALONE, with no tape write at all --
 * the exact bug this file's evidence layer exists to prevent).
 *
 * `persistPickDecisions` (nfl-auto-picks.js) is gone. `nfl_pick_decisions` is
 * now written from exactly one place: `refreshPickDecisionsCache` below,
 * called at the end of `recordDecisionRun` itself, reading the run's own
 * `nfl_decision_events` rows back rather than the caller's board. Every
 * caller that used to call `persistPickDecisions` now calls
 * `recordDecisionRun` and gets the cache for free; a caller that only ever
 * called `recordDecisionRun` (t60-runner.js, nfl-execution-pipeline.js) now
 * populates the cache too, which it never did before. There is no remaining
 * path to `nfl_pick_decisions` that does not go through the tape.
 */
import crypto from 'node:crypto';
import { db, rows, row, run } from '../db/index.js';
import { spreadDecisionCodeIdentity } from '../platform/code-identity.js';

export const DECISION_TAPE_VERSION = 'nfl-decision-tape-v2-c01-c02';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * How completely the computation that this observation represents actually
 * ran. The distinction the plan asks for in C02: "distinguish a healthy
 * all-abstention observation from no computation."
 *
 *   complete    — the board was computed for every game it was asked about.
 *                 Zero eligible candidates is a perfectly healthy `complete`
 *                 run; it means the model looked and declined.
 *   partial     — the board was computed for some games and something
 *                 prevented the rest. The denominator is short and says so.
 *   unavailable — no forecast was produced at all. This is the row that keeps
 *                 a missed T-60 capture in the denominator rather than
 *                 letting it silently disappear from coverage.
 */
export const COMPUTATION_STATUSES = new Set(['complete', 'partial', 'unavailable']);

/**
 * Where the numbers this decision consumed actually came from.
 *
 * `frozen_packet` is the target state (C11): an immutable, content-addressed
 * input packet whose hash goes in `data_hash`. Until that exists, the honest
 * answer is `unfrozen_live_tables` -- the board read mutable tables at compute
 * time and no artifact can reproduce exactly what it saw. Recording that as a
 * status rather than as a null hash means the evidence never has to be
 * re-interpreted later: a run that says `unfrozen_live_tables` is permanently
 * marked as the weaker kind of evidence it is.
 */
export const DATA_IDENTITY_STATUSES = new Set(['frozen_packet', 'unfrozen_live_tables', 'unavailable']);

/**
 * Everything about ONE candidate that, if it changed, means a genuinely
 * different decision was made about that candidate.
 *
 * Deliberately EXCLUDES wall-clock timestamps of the computation itself, which
 * live on the run header where they belong. Deliberately INCLUDES the whole
 * forecast, not just the contract: two boards that offered the same price on
 * the same side for different modelled reasons are different decisions, and
 * the first version of this file could not tell them apart.
 */
function decisionContentFingerprint(d) {
  const snap = d.feature_snapshot ?? {};
  const forecast = snap.raw_forecast ?? {};
  return {
    // Contract: what was being considered.
    matchup: d.matchup ?? null,
    home_team: d.home_team ?? null,
    away_team: d.away_team ?? null,
    market: d.market ?? null,
    selection: d.selection ?? null,
    side: d.side ?? null,
    line: d.line ?? null,

    // Quote: the exact offer, and which observation of it.
    american_price: d.american_price ?? null,
    book: d.book ?? null,
    quote_at: d.quote_at ?? null,
    quote_source: d.quote_source ?? null,
    quote_id: d.quote_id ?? null,

    // Forecast: what the model actually said, and which model said it. This
    // whole group was missing before, which is defect (2) above.
    model_probability: d.model_probability ?? null,
    implied_probability: d.implied_probability ?? null,
    probability_difference: d.probability_difference ?? null,
    // Both edges: the unsigned magnitude the board ranks on, and the signed
    // value that says WHICH side the model actually preferred. Persisting only
    // one of these was defect (1).
    edge_points: d.edge_points ?? null,
    signed_edge_points: forecast.signed_edge_points ?? null,
    projected_margin: forecast.projected_margin ?? null,
    base_projected_margin: forecast.base_projected_margin ?? null,
    market_margin: forecast.market_margin ?? null,
    disagreement: d.disagreement ?? null,

    // Forecast dependency identity: algorithm, configuration, information
    // regime, the calibration bound to them, and the exact set of components
    // that carried weight. A board that silently lost a model is a different
    // board even when its output number is unchanged.
    forecast_identity: snap.forecast_identity?.id ?? null,
    cover_calibration: snap.cover_calibration ?? null,
    active_model_ids: [...(snap.active_model_ids ?? [])].sort(),
    input_mode: snap.input_mode ?? null,
    // SWEEP STEP 0 ITEM 3: whether this decision's base forecast was a real
    // model opinion or the market line served verbatim because zero
    // components passed the residual promotion gate. Part of the content
    // hash on purpose -- a run that flips from a real opinion to market
    // identity (or back) on the same numbers is a different decision, not a
    // formatting change.
    is_market_identity: d.is_market_identity === true,
    neural_authority: snap.coordinated_decision_head?.neural?.authority ?? null,
    neural_version: snap.coordinated_decision_head?.neural?.version ?? null,
    neural_used: snap.coordinated_decision_head?.neural?.used ?? null,

    // Economics at the offered price. `expected_return` is what the policy's
    // profitability gate actually acted on, and `push_probability` is the
    // semantics that gate needs to be interpretable at all (C15) -- a run
    // decided with an unknown push treated as zero must never content-address
    // the same as one decided with a real push estimate.
    expected_return: d.expected_return ?? null,
    push_probability: d.push_probability ?? null,

    // Policy outcome and every stated reason for it.
    eligible: d.eligible ? 1 : 0,
    calibration_eligible: d.calibration_eligible ? 1 : 0,
    calibration_status: d.calibration_status ?? null,
    abstention_reason: d.abstention_reason ?? null,
    promoted_finding_veto: d.promoted_finding_veto
      ? { segment_key: d.promoted_finding_veto.segment_key ?? null,
        reason: d.promoted_finding_veto.reason ?? null }
      : null,
    policy_rank: d.policy_rank ?? null
  };
}

/**
 * The content address of one whole board: every candidate's material content,
 * plus the policy, horizon, schedule version and software identity it was
 * decided under.
 *
 * Sorted by the full contract rather than by matchup/market/selection alone,
 * so two candidates on the same side of the same game at different lines
 * cannot swap places between runs and change the hash without any decision
 * having changed.
 */
export function contentHash({
  season, week, policyId, policyVersion, engineMode,
  horizon, cutoffAt, scheduleVersion,
  codeIdentityId, dataIdentityStatus, dataHash, computationStatus, decisions
}) {
  const fingerprints = (decisions ?? []).map(decisionContentFingerprint)
    .map(f => ({ sortKey: `${f.matchup}|${f.market}|${f.selection}|${f.line}|${f.book}|${f.american_price}`, f }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map(x => x.f);
  return sha256(JSON.stringify({
    schema_version: 'nfl-decision-content-v2',
    season, week,
    policy_id: policyId, policy_version: policyVersion, engine_mode: engineMode,
    horizon, cutoff_at: cutoffAt, schedule_version: scheduleVersion,
    code_identity: codeIdentityId,
    data_identity_status: dataIdentityStatus, data_hash: dataHash ?? null,
    computation_status: computationStatus,
    decisions: fingerprints
  }));
}

/**
 * The identity of the OBSERVATION, which is a different question from the
 * identity of its content.
 *
 * `attempt` is deliberately absent: attempt 2 of one observation is the same
 * observation being retried, and must resolve to the same recorded run rather
 * than a second copy. Everything else is present, so the 4pm scheduled run and
 * the 5pm scheduled run for the same game remain two separate observations
 * even if the model said exactly the same thing both times -- which is the
 * case the old UNIQUE board hash made impossible to record.
 */
export function observationKey({ experimentId, horizon, cutoffAt, jobId, observationId }) {
  return sha256(JSON.stringify({
    schema_version: 'nfl-decision-observation-v1',
    experiment_id: experimentId, horizon, cutoff_at: cutoffAt,
    job_id: jobId, observation_id: observationId
  }));
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`decision tape: ${field} is required and must be a non-empty string`);
  }
  return value;
}

/**
 * The declared observation this run belongs to. Every field is required: an
 * observation that cannot say which experiment it serves, what horizon it
 * claims, or which cutoff it froze at is not evidence of a prospective
 * decision, and accepting one would let a run recorded after the fact look
 * indistinguishable from one recorded before kickoff.
 */
export function validateObservation(observation) {
  if (!observation || typeof observation !== 'object') {
    throw new TypeError('decision tape: an explicit observation identity is required');
  }
  const experimentId = requireString(observation.experimentId, 'observation.experimentId');
  const horizon = requireString(observation.horizon, 'observation.horizon');
  const cutoffAt = requireString(observation.cutoffAt, 'observation.cutoffAt');
  const jobId = requireString(observation.jobId, 'observation.jobId');
  const observationId = requireString(observation.observationId, 'observation.observationId');
  if (Number.isNaN(Date.parse(cutoffAt))) {
    throw new TypeError('decision tape: observation.cutoffAt must be a parseable timestamp');
  }
  const attempt = observation.attempt ?? 1;
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError('decision tape: observation.attempt must be a positive integer');
  }
  return { experimentId, horizon, cutoffAt, jobId, observationId, attempt };
}

/**
 * One explicit board schema, validated before anything is written.
 *
 * The old code wrote whatever it was handed. A candidate missing a market, or
 * carrying a probability of 4, or claiming eligibility with no price, went
 * onto the permanent evidence record unchallenged. Validation happens up front
 * so that a bad board is refused in full rather than discovered halfway
 * through writing its children.
 */
export function validateDecisionBoard(decisionBoard, { computationStatus }) {
  if (!decisionBoard || typeof decisionBoard !== 'object') {
    throw new TypeError('decision tape: a decision board is required');
  }
  const decisions = decisionBoard.decisions;
  if (!Array.isArray(decisions)) {
    throw new TypeError('decision tape: decisionBoard.decisions must be an array');
  }
  if (computationStatus === 'unavailable' && decisions.length) {
    throw new TypeError('decision tape: an unavailable computation cannot carry decisions');
  }
  if (computationStatus !== 'unavailable' && !decisions.length) {
    throw new TypeError(
      'decision tape: a complete or partial computation with zero candidates is ambiguous — ' +
      'record computationStatus "unavailable" if nothing was computed');
  }

  const seen = new Set();
  decisions.forEach((d, i) => {
    const at = `decision[${i}]`;
    if (!d || typeof d !== 'object') throw new TypeError(`decision tape: ${at} must be an object`);
    requireString(d.matchup, `${at}.matchup`);
    requireString(d.market, `${at}.market`);

    for (const [field, value] of Object.entries({
      line: d.line, american_price: d.american_price, edge_points: d.edge_points,
      model_probability: d.model_probability, implied_probability: d.implied_probability,
      probability_difference: d.probability_difference, disagreement: d.disagreement,
      policy_rank: d.policy_rank
    })) {
      if (value != null && !Number.isFinite(value)) {
        throw new TypeError(`decision tape: ${at}.${field} must be finite or absent, got ${value}`);
      }
    }
    for (const field of ['model_probability', 'implied_probability']) {
      const p = d[field];
      if (p != null && (p < 0 || p > 1)) {
        throw new TypeError(`decision tape: ${at}.${field} must be a probability in [0,1], got ${p}`);
      }
    }
    // An eligible candidate is one the policy is prepared to act on. Acting
    // requires an actual obtainable contract, so the absence of a line or a
    // price is a contradiction rather than a missing optional field.
    if (d.eligible) {
      if (d.line == null) throw new TypeError(`decision tape: ${at} is eligible but has no line`);
      if (d.american_price == null) throw new TypeError(`decision tape: ${at} is eligible but has no price`);
      requireString(d.selection, `${at}.selection`);
    }
    if (!d.eligible && !d.abstention_reason) {
      throw new TypeError(`decision tape: ${at} is not eligible and states no abstention reason`);
    }

    // C01: "Exact-contract links must be unique or fail." Two candidates in
    // one board describing the same exact contract make the link from an
    // execution opportunity back to its originating decision ambiguous, and
    // the old lookup resolved that ambiguity by silently taking the first row.
    const contract = exactContractKey(d);
    if (seen.has(contract)) {
      throw new TypeError(`decision tape: duplicate exact contract in one board — ${contract}`);
    }
    seen.add(contract);
  });
  return decisions;
}

/**
 * The full contract a decision event is addressed by. Matchup, market and
 * selection alone are NOT enough: the same side of the same game at +2.5 and
 * at +3.5, or at two books, are different contracts with different economics,
 * and an opportunity opened against one must never cite the other's decision.
 */
function exactContractKey(d) {
  return JSON.stringify([d.matchup ?? null, d.market ?? null, d.selection ?? null,
    d.line ?? null, d.book ?? null, d.american_price ?? null]);
}

/**
 * Record one decision board as an immutable run, atomically.
 *
 * Returns `{ run_id, created }`. `created:false` means this exact observation
 * with this exact content was already recorded and verified complete -- an
 * idempotent retry, not a second copy.
 *
 * Throws when the same declared observation has already recorded DIFFERENT
 * content. That is not a retry and it is not a new observation; it is one
 * observation claiming two different answers, and silently writing both would
 * destroy the meaning of the observation identity.
 */
export function recordDecisionRun(season, week, decisionBoard, {
  observation,
  policyId = decisionBoard?.policy?.id ?? null,
  policyVersion = decisionBoard?.policy?.version ?? null,
  computationStatus = 'complete',
  dataIdentityStatus = 'unfrozen_live_tables',
  dataHash = null,
  scheduleVersion = null,
  codeIdentity = spreadDecisionCodeIdentity(),
  decidedAt = new Date().toISOString(),
  computationStartedAt = null,
  computationEndedAt = null,
  note = null
} = {}) {
  if (!COMPUTATION_STATUSES.has(computationStatus)) {
    throw new TypeError(`decision tape: unknown computationStatus ${computationStatus}`);
  }
  if (!DATA_IDENTITY_STATUSES.has(dataIdentityStatus)) {
    throw new TypeError(`decision tape: unknown dataIdentityStatus ${dataIdentityStatus}`);
  }
  if (dataIdentityStatus === 'frozen_packet' && !HEX64.test(dataHash ?? '')) {
    throw new TypeError('decision tape: a frozen_packet run must supply its packet hash');
  }
  if (dataIdentityStatus !== 'frozen_packet' && dataHash != null) {
    throw new TypeError('decision tape: only a frozen_packet run may carry a data hash');
  }
  if (!HEX64.test(codeIdentity?.id ?? '')) {
    throw new TypeError('decision tape: a real computed code identity is required');
  }
  requireString(policyId, 'policyId');
  requireString(policyVersion, 'policyVersion');

  const obs = validateObservation(observation);
  const decisions = validateDecisionBoard(decisionBoard, { computationStatus });
  const engineMode = decisionBoard?.engine_mode ?? null;

  const obsKey = observationKey(obs);
  const content = contentHash({
    season, week, policyId, policyVersion, engineMode,
    horizon: obs.horizon, cutoffAt: obs.cutoffAt, scheduleVersion,
    codeIdentityId: codeIdentity.id, dataIdentityStatus, dataHash,
    computationStatus, decisions
  });

  const existing = row(`SELECT id, content_hash, decision_count FROM nfl_decision_runs
    WHERE observation_key=?`, obsKey);
  if (existing) {
    if (existing.content_hash !== content) {
      throw new Error(
        `decision tape: observation ${obs.observationId} already recorded different content ` +
        `(${existing.content_hash.slice(0, 12)}… vs ${content.slice(0, 12)}…). ` +
        'A changed answer is a new observation, not a retry of this one.');
    }
    // C02: verify completeness before calling a retry satisfied. The old code
    // returned created:false on the strength of the header alone, so a run
    // whose children had failed halfway through was reported as already
    // recorded and never repaired.
    const actual = row(`SELECT COUNT(*) n FROM nfl_decision_events WHERE run_id=?`, existing.id)?.n ?? 0;
    if (actual !== existing.decision_count) {
      throw new Error(
        `decision tape: run ${existing.id} is incomplete — header claims ${existing.decision_count} ` +
        `decisions, ${actual} events present. Append an invalidation and record a new observation; ` +
        'this record must not be rewritten.');
    }
    refreshPickDecisionsCache(existing.id);
    return { run_id: existing.id, created: false, observation_key: obsKey, content_hash: content,
      decision_count: existing.decision_count,
      note: 'identical observation and content already recorded — idempotent retry, nothing written' };
  }

  const id = crypto.randomUUID();
  const selectedCount = decisions.filter(d => d.eligible).length;

  // Header and children in ONE transaction. The old code inserted the header,
  // then looped over the children outside any transaction, so a child that
  // violated a constraint left a header behind claiming decisions that were
  // never written.
  db.exec('BEGIN IMMEDIATE');
  try {
    run(`INSERT INTO nfl_decision_runs
         (id, season, week, policy_id, policy_version, board_hash, content_hash, observation_key,
          experiment_id, horizon, cutoff_at, job_id, observation_id, attempt,
          computation_status, data_identity_status, code_hash, data_hash, schedule_version,
          code_manifest_json, decided_at, computation_started_at, computation_ended_at,
          decision_count, selected_count, engine_mode, tape_version, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, season, week, policyId, policyVersion,
    // `board_hash` predates this rewrite and is UNIQUE at the schema level. It
    // now holds the RUN identity -- observation and content together -- which
    // is exactly the value that must be unique: the same observation retried
    // collides (correctly, and is caught above), while two distinct
    // observations with identical numbers do not.
    sha256(`${obsKey}:${content}`), content, obsKey,
    obs.experimentId, obs.horizon, obs.cutoffAt, obs.jobId, obs.observationId, obs.attempt,
    computationStatus, dataIdentityStatus, codeIdentity.id, dataHash, scheduleVersion,
    JSON.stringify(codeIdentity.manifest), decidedAt, computationStartedAt, computationEndedAt,
    decisions.length, selectedCount, engineMode, DECISION_TAPE_VERSION, note);

    for (const d of decisions) {
      const snap = d.feature_snapshot ?? {};
      const forecast = snap.raw_forecast ?? {};
      run(`INSERT INTO nfl_decision_events
           (run_id, matchup, home_team, away_team, market, selection, side, line, american_price,
            book, quote_at, quote_source, quote_id,
            edge, edge_points, projected_margin, market_margin,
            model_probability, implied_probability, probability_difference,
            forecast_identity, cover_calibration, is_market_identity,
            disagreement, eligible, calibration_eligible, calibration_status,
            abstention_reason, promoted_finding_veto_json, policy_rank, feature_snapshot_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, d.matchup, d.home_team ?? null, d.away_team ?? null, d.market,
      d.selection ?? null, d.side ?? null, d.line ?? null, d.american_price ?? null,
      d.book ?? null, d.quote_at ?? null, d.quote_source ?? null, d.quote_id ?? null,
      // The signed edge is the one that says which side the model preferred;
      // `edge_points` is the unsigned magnitude the policy ranks on. Writing
      // the signed value into `edge` is what makes the persisted column stop
      // being NULL on every row.
      forecast.signed_edge_points ?? null, d.edge_points ?? null,
      forecast.projected_margin ?? null, forecast.market_margin ?? null,
      d.model_probability ?? null, d.implied_probability ?? null, d.probability_difference ?? null,
      snap.forecast_identity?.id ?? null, snap.cover_calibration ?? null, d.is_market_identity ? 1 : 0,
      d.disagreement ?? null, d.eligible ? 1 : 0, d.calibration_eligible ? 1 : 0,
      d.calibration_status ?? null, d.abstention_reason ?? null,
      d.promoted_finding_veto ? JSON.stringify(d.promoted_finding_veto) : null,
      d.policy_rank ?? null,
      d.feature_snapshot ? JSON.stringify(d.feature_snapshot) : null);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  refreshPickDecisionsCache(id);
  return { run_id: id, created: true, observation_key: obsKey, content_hash: content,
    decision_count: decisions.length, selected_count: selectedCount,
    computation_status: computationStatus, data_identity_status: dataIdentityStatus };
}

/**
 * Rebuilds the `nfl_pick_decisions` latest-view cache for one recorded run,
 * FROM its own `nfl_decision_events` rows -- never from a caller-supplied
 * board. This is the only code in the project that writes
 * `nfl_pick_decisions`; every writer of the tape gets the cache as a side
 * effect of `recordDecisionRun` instead of maintaining it separately (see the
 * "ONE WRITER" note at the top of this file).
 *
 * Same UPSERT key as before the unification -- (season, week, policy_id,
 * matchup, market, selection) -- so a later run for the same week still
 * overwrites the earlier one's row here: that is the whole point of a
 * "latest view", and the append-only tape underneath is unaffected either way.
 */
export function refreshPickDecisionsCache(runId) {
  const header = row(`SELECT season, week, policy_id, policy_version, decided_at
                       FROM nfl_decision_runs WHERE id=?`, runId);
  if (!header) throw new Error(`decision tape: cannot refresh cache for unknown run ${runId}`);
  const events = rows(`SELECT * FROM nfl_decision_events WHERE run_id=?`, runId);
  for (const e of events) {
    run(`INSERT INTO nfl_pick_decisions
      (season,week,policy_id,policy_version,matchup,selection,market,line,american_price,book,
       quote_at,quote_source,edge,disagreement,eligible,abstention_reason,policy_rank,
       is_market_identity,feature_snapshot_json,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(season,week,policy_id,matchup,market,selection) DO UPDATE SET
       policy_version=excluded.policy_version,
       line=excluded.line,american_price=excluded.american_price,book=excluded.book,
       quote_at=excluded.quote_at,quote_source=excluded.quote_source,edge=excluded.edge,
       disagreement=excluded.disagreement,eligible=excluded.eligible,
       abstention_reason=excluded.abstention_reason,policy_rank=excluded.policy_rank,
       is_market_identity=excluded.is_market_identity,
       feature_snapshot_json=excluded.feature_snapshot_json,recorded_at=excluded.recorded_at`,
      header.season, header.week, header.policy_id, header.policy_version, e.matchup, e.selection,
      e.market, e.line, e.american_price, e.book, e.quote_at, e.quote_source,
      // `edge_points` is the unsigned magnitude the old board-driven UPSERT wrote
      // into this column -- kept identical so the UI cache means the same thing
      // it always did.
      e.edge_points, e.disagreement, e.eligible, e.abstention_reason, e.policy_rank,
      // Integration fix (2026-09-12 unify): the stage-2 "ONE WRITER" rewrite
      // that introduced this rebuild predates u2-market-identity's column on
      // this table (migration 045) and dropped it from the cache by omission
      // -- `nfl_decision_events.is_market_identity` (persisted a few lines
      // above, in recordDecisionRun) was never carried through to this UPSERT.
      // Restored so nfl_pick_decisions, the table the UI and u2's own real-data
      // validation actually read, keeps reporting the flag going forward.
      e.is_market_identity, e.feature_snapshot_json ?? '{}', header.decided_at);
  }
  return { run_id: runId, cached: events.length };
}

/**
 * Record that an existing run should no longer be relied on, WITHOUT touching
 * it. C02's requirement: "Append invalidation/replacement events for
 * incomplete legacy records rather than quietly rewriting them."
 *
 * The invalidated run stays exactly as it was written. Anything reading the
 * tape can see both what was recorded and the later judgement about it, which
 * is strictly more information than a corrected row would carry.
 */
export function invalidateDecisionRun(runId, { reason, actor = null, replacedByRunId = null,
  occurredAt = new Date().toISOString() } = {}) {
  requireString(reason, 'reason');
  if (!row(`SELECT 1 FROM nfl_decision_runs WHERE id=?`, runId)) {
    throw new Error(`decision tape: cannot invalidate unknown run ${runId}`);
  }
  if (replacedByRunId && !row(`SELECT 1 FROM nfl_decision_runs WHERE id=?`, replacedByRunId)) {
    throw new Error(`decision tape: replacement run ${replacedByRunId} does not exist`);
  }
  run(`INSERT INTO nfl_decision_run_invalidations (run_id, reason, actor, replaced_by_run_id, occurred_at)
       VALUES (?,?,?,?,?)`, runId, reason, actor, replacedByRunId, occurredAt);
  return { run_id: runId, invalidated: true, replaced_by_run_id: replacedByRunId };
}

/** Every invalidation recorded against a run, oldest first. */
export function decisionRunInvalidations(runId) {
  return rows(`SELECT * FROM nfl_decision_run_invalidations WHERE run_id=? ORDER BY id`, runId);
}

/** Every event on one run, in the order it was written. */
export function decisionRunEvents(runId) {
  return rows(`SELECT * FROM nfl_decision_events WHERE run_id=? ORDER BY id`, runId);
}

/**
 * One recorded run's header, its events, and any later judgement about it.
 * `complete` is computed rather than trusted: a header's own `decision_count`
 * is a claim, and the events present are the fact.
 */
export function decisionRun(runId) {
  const header = row(`SELECT * FROM nfl_decision_runs WHERE id=?`, runId);
  if (!header) return null;
  const events = decisionRunEvents(runId);
  const invalidations = decisionRunInvalidations(runId);
  return { ...header, events, invalidations,
    complete: events.length === header.decision_count,
    invalidated: invalidations.length > 0 };
}

/**
 * The runs recorded for a week, newest first. More than one is normal and
 * meaningful: it means either the board genuinely changed, or a separate
 * declared observation was taken.
 */
export function decisionRunsFor(season, week) {
  return rows(`SELECT * FROM nfl_decision_runs WHERE season=? AND week=? ORDER BY created_at DESC, id DESC`,
    season, week);
}

/**
 * Find the decision event a given selection came from, so an execution
 * opportunity can cite the exact frozen decision that produced it.
 *
 * Requires the FULL contract, and refuses rather than guesses when more than
 * one event matches. The old version matched on matchup, market and selection
 * only and resolved ties with `ORDER BY id LIMIT 1`, so an opportunity opened
 * at +3.5 could silently cite the decision made about +2.5 -- C01's "can
 * select the first ambiguous event."
 */
export function findDecisionEvent(runId, { matchup, market, selection, line, book, americanPrice }) {
  const matched = rows(`SELECT * FROM nfl_decision_events
    WHERE run_id=? AND matchup=? AND market=?
      AND selection IS ? AND line IS ? AND book IS ? AND american_price IS ?
    ORDER BY id`,
  runId, matchup, market, selection ?? null, line ?? null, book ?? null, americanPrice ?? null);

  if (!matched.length) return null;
  if (matched.length > 1) {
    throw new Error(
      `decision tape: ${matched.length} decision events match the same exact contract on run ${runId} ` +
      `(${matchup} ${market} ${selection} ${line} @ ${book} ${americanPrice}). ` +
      'An exact-contract link must be unique.');
  }
  return matched[0];
}
