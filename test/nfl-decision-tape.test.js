/**
 * The decision tape's evidence contract.
 *
 * The first four tests are Codex audit finding E6's original acceptance
 * criteria, preserved because they still describe real obligations:
 *
 *   "Zero-selection run writes all abstentions. A quote or policy version
 *    change creates another event while first remains byte-identical. Same
 *    input retry does not duplicate. Every selected opportunity traces to one
 *    frozen selection; every offered/declined/expired result remains
 *    accountable."
 *
 * Everything after them is Codex corrections C01 and C02 (2026-09-10), whose
 * "close with" lists are quoted above each group. Those tests exist because
 * the version of the tape that passed the four tests above STILL could not
 * tell two different decisions apart: it hashed a field the board does not
 * emit, omitted the forecast entirely, conflated content identity with
 * observation identity, and wrote its rows outside any transaction.
 *
 * A note on what these tests prove. A counterexample that passes shows the
 * defect was reproduced. The tests below are written the other way round --
 * they assert the REPAIRED behaviour, so a regression to the old behaviour
 * fails them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-decision-tape-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const { recordDecisionRun, decisionRun, decisionRunsFor, decisionRunEvents, findDecisionEvent,
  contentHash, observationKey, invalidateDecisionRun, decisionRunInvalidations } =
  await import('../server/services/nfl-decision-tape.js');
const { spreadDecisionCodeIdentity } = await import('../server/platform/code-identity.js');

const CODE = spreadDecisionCodeIdentity();

/** A candidate as `nfl-auto-picks.js` actually emits one — note `edge_points`, not `edge`. */
const decision = (over = {}) => ({
  matchup: 'CHI at CAR', home_team: 'CAR', away_team: 'CHI', market: 'spread',
  selection: 'CAR', side: '-2.5', line: -2.5,
  american_price: -110, book: 'draftkings', quote_at: '2026-09-10T12:00:00Z',
  quote_source: 'draftkings', quote_id: 'q-1',
  edge_points: 3.2, disagreement: 2.1,
  model_probability: 0.56, implied_probability: 0.524, probability_difference: 0.036,
  expected_return: 0.0688,
  eligible: true, calibration_eligible: true, calibration_status: 'calibrated',
  abstention_reason: null, policy_rank: 1,
  feature_snapshot: {
    forecast_identity: { id: 'f'.repeat(64) },
    cover_calibration: 'cover-logit-v3:abc-2021-2024',
    active_model_ids: ['massey', 'colley'],
    raw_forecast: { projected_margin: 5, base_projected_margin: 5, market_margin: 2.5, signed_edge_points: 2.5 }
  },
  ...over
});

const board = (decisions, over = {}) => ({
  decisions, selected: decisions.filter(d => d.eligible),
  policy: { id: 'nfl-production-v1', version: '1.0.0' }, engine_mode: 'champion', ...over
});

let seq = 0;
/** A distinct declared observation each time, unless a test deliberately reuses one. */
const observation = (over = {}) => ({
  experimentId: 'test-experiment',
  horizon: 'T-60',
  cutoffAt: '2026-09-10T17:00:00Z',
  jobId: 'job-1',
  observationId: `obs-${++seq}`,
  attempt: 1,
  ...over
});

const record = (decisions, opts = {}) => recordDecisionRun(2026, 3, board(decisions), {
  observation: observation(), policyId: 'nfl-production-v1', policyVersion: '1.0.0', ...opts
});

/* ======================================================================
 * Finding E6's original four acceptance criteria
 * ====================================================================== */

test('a run that selects NOTHING still records every candidate and its abstention reason', () => {
  const abstained = [
    decision({ matchup: 'A at B', selection: 'B', eligible: false, abstention_reason: 'edge_below_threshold', policy_rank: null }),
    decision({ matchup: 'C at D', selection: 'D', eligible: false, abstention_reason: 'model_disagreement', policy_rank: null })
  ];
  const result = record(abstained);
  assert.equal(result.created, true);
  assert.equal(result.decision_count, 2);
  assert.equal(result.selected_count, 0);

  const stored = decisionRun(result.run_id);
  assert.equal(stored.events.length, 2);
  assert.deepEqual(stored.events.map(e => e.abstention_reason).sort(),
    ['edge_below_threshold', 'model_disagreement']);
  // A healthy all-abstention observation is `complete`, not `unavailable`:
  // the model looked at both games and declined both.
  assert.equal(stored.computation_status, 'complete');
  assert.equal(stored.complete, true);
});

test('a moved quote creates a second run while the first stays byte-identical', () => {
  const before = record([decision()]);
  const beforeRow = decisionRun(before.run_id);

  const after = record([decision({ american_price: -125, quote_id: 'q-2' })]);
  assert.notEqual(after.run_id, before.run_id);
  assert.notEqual(after.content_hash, before.content_hash);

  assert.deepEqual(decisionRun(before.run_id).events, beforeRow.events);
  assert.equal(decisionRun(before.run_id).content_hash, beforeRow.content_hash);
});

test('u2-market-identity: is_market_identity persists on the event and round-trips as a real boolean', () => {
  const marketIdentity = record([decision({ matchup: 'GB at DET', selection: 'DET', is_market_identity: true })]);
  const realOpinion = record([decision({ matchup: 'NYJ at NE', selection: 'NE', is_market_identity: false })]);

  const [flagged] = decisionRunEvents(marketIdentity.run_id);
  const [opinion] = decisionRunEvents(realOpinion.run_id);
  assert.equal(flagged.is_market_identity, 1);
  assert.equal(opinion.is_market_identity, 0);

  // Flipping ONLY this field on otherwise-identical numbers is a genuinely
  // different decision, not a formatting change — it changes the content hash.
  assert.notEqual(marketIdentity.content_hash,
    record([decision({ matchup: 'GB at DET', selection: 'DET', is_market_identity: false })],
      { observation: observation() }).content_hash);
});

test('a policy version change is a different run even with identical numbers', () => {
  const a = record([decision()], { policyVersion: '1.0.0' });
  const b = record([decision()], { policyVersion: '1.1.0' });
  assert.notEqual(a.content_hash, b.content_hash);
});

test('every selected candidate traces to exactly one frozen decision event', () => {
  const r = record([decision()]);
  const found = findDecisionEvent(r.run_id, {
    matchup: 'CHI at CAR', market: 'spread', selection: 'CAR',
    line: -2.5, book: 'draftkings', americanPrice: -110
  });
  assert.ok(found);
  assert.equal(found.run_id, r.run_id);
});

/* ======================================================================
 * C01 — "real board-to-pipeline tests changing each material field
 * independently; repeated same-observation retry; identical forecasts at two
 * horizons; ambiguous same-side different-line quotes; correct recovered
 * feature packet and edge."
 * ====================================================================== */

test('C01: the persisted edge is the real signed edge, not NULL', () => {
  // The defect: the fingerprint read `d.edge`, the board emits `edge_points`,
  // so `edge` was undefined everywhere and every persisted row stored NULL.
  const r = record([decision()]);
  const [event] = decisionRunEvents(r.run_id);
  assert.equal(event.edge, 2.5, 'signed edge must be persisted, not NULL');
  assert.equal(event.edge_points, 3.2, 'ranking magnitude must be persisted too');
  assert.equal(event.projected_margin, 5);
  assert.equal(event.market_margin, 2.5);
});

test('C01: the recovered feature packet round-trips exactly', () => {
  const r = record([decision()]);
  const [event] = decisionRunEvents(r.run_id);
  const snap = JSON.parse(event.feature_snapshot_json);
  assert.deepEqual(snap.active_model_ids, ['massey', 'colley']);
  assert.equal(snap.raw_forecast.projected_margin, 5);
  assert.equal(event.forecast_identity, 'f'.repeat(64));
  assert.equal(event.cover_calibration, 'cover-logit-v3:abc-2021-2024');
  assert.equal(event.model_probability, 0.56);
});

test('C01: EVERY material field independently changes the content hash', () => {
  const base = { season: 2026, week: 3, policyId: 'nfl-production-v1', policyVersion: '1.0.0',
    engineMode: 'champion', horizon: 'T-60', cutoffAt: '2026-09-10T17:00:00Z',
    scheduleVersion: 'sched-1', codeIdentityId: CODE.id,
    dataIdentityStatus: 'unfrozen_live_tables', dataHash: null,
    computationStatus: 'complete', decisions: [decision()] };
  const baseline = contentHash(base);

  // The exact scenario the audit reproduced: forecast 5 → 12, edge 2 → 9,
  // model A → B, a different quote id, and a different code/data identity all
  // reused the same run under the old fingerprint.
  const mutations = {
    forecast: { decisions: [decision({ feature_snapshot: { ...decision().feature_snapshot,
      raw_forecast: { projected_margin: 12, base_projected_margin: 12, market_margin: 2.5, signed_edge_points: 9.5 } } })] },
    edge_points: { decisions: [decision({ edge_points: 9 })] },
    model_identity: { decisions: [decision({ feature_snapshot: { ...decision().feature_snapshot,
      forecast_identity: { id: 'a'.repeat(64) } } })] },
    active_models: { decisions: [decision({ feature_snapshot: { ...decision().feature_snapshot,
      active_model_ids: ['massey'] } })] },
    calibration: { decisions: [decision({ feature_snapshot: { ...decision().feature_snapshot,
      cover_calibration: 'cover-logit-v4:xyz' } })] },
    quote_id: { decisions: [decision({ quote_id: 'q-999' })] },
    line: { decisions: [decision({ line: -3.5 })] },
    price: { decisions: [decision({ american_price: -105 })] },
    book: { decisions: [decision({ book: 'fanduel' })] },
    model_probability: { decisions: [decision({ model_probability: 0.61 })] },
    expected_return: { decisions: [decision({ expected_return: -0.02 })] },
    push_probability: { decisions: [decision({ push_probability: 0.08 })] },
    eligibility: { decisions: [decision({ eligible: false, abstention_reason: 'edge_below_threshold' })] },
    // u2-market-identity: whether this decision's base forecast was a real
    // model opinion or the market line served verbatim (see nfl-ensemble.js).
    // A run that flips this on the same numbers is a different decision.
    is_market_identity: { decisions: [decision({ is_market_identity: true })] },
    policy_version: { policyVersion: '2.0.0' },
    engine_mode: { engineMode: 'candidate' },
    horizon: { horizon: 'T-1440' },
    cutoff: { cutoffAt: '2026-09-10T18:00:00Z' },
    schedule_version: { scheduleVersion: 'sched-2' },
    code_identity: { codeIdentityId: 'b'.repeat(64) },
    data_identity: { dataIdentityStatus: 'frozen_packet', dataHash: 'c'.repeat(64) },
    computation_status: { computationStatus: 'partial' }
  };

  const seen = new Map([[baseline, 'baseline']]);
  for (const [field, patch] of Object.entries(mutations)) {
    const hash = contentHash({ ...base, ...patch });
    assert.notEqual(hash, baseline, `changing ${field} must change the content hash`);
    assert.ok(!seen.has(hash), `${field} collided with ${seen.get(hash)}`);
    seen.set(hash, field);
  }
});

test('C01: retrying the SAME observation is idempotent and writes nothing new', () => {
  const obs = observation();
  const first = recordDecisionRun(2026, 3, board([decision()]), {
    observation: obs, policyId: 'nfl-production-v1', policyVersion: '1.0.0' });
  const before = decisionRunEvents(first.run_id).length;

  // A retry is the same observation at a later attempt: same identity.
  const retry = recordDecisionRun(2026, 3, board([decision()]), {
    observation: { ...obs, attempt: 2 }, policyId: 'nfl-production-v1', policyVersion: '1.0.0' });

  assert.equal(retry.created, false);
  assert.equal(retry.run_id, first.run_id);
  assert.equal(decisionRunEvents(first.run_id).length, before, 'a retry must not append events');
});

test('C01: identical forecasts at two horizons are two runs, not one', () => {
  // The old UNIQUE board hash made this impossible: a second declared
  // observation whose numbers happened to match could not be recorded at all.
  const numbers = [decision()];
  const early = recordDecisionRun(2026, 3, board(numbers), {
    observation: observation({ horizon: 'T-1440', observationId: 'game-1-early' }),
    policyId: 'nfl-production-v1', policyVersion: '1.0.0' });
  const late = recordDecisionRun(2026, 3, board(numbers), {
    observation: observation({ horizon: 'T-60', observationId: 'game-1-late' }),
    policyId: 'nfl-production-v1', policyVersion: '1.0.0' });

  assert.equal(early.created, true);
  assert.equal(late.created, true);
  assert.notEqual(early.run_id, late.run_id);
  assert.notEqual(early.observation_key, late.observation_key);
});

test('C01: two distinct observations with byte-identical numbers both survive', () => {
  const numbers = [decision({ matchup: 'SEA at SF', home_team: 'SF', away_team: 'SEA', selection: 'SF' })];
  const common = { policyId: 'nfl-production-v1', policyVersion: '1.0.0' };
  const a = recordDecisionRun(2026, 9, board(numbers), {
    observation: observation({ observationId: 'capture-a' }), ...common });
  const b = recordDecisionRun(2026, 9, board(numbers), {
    observation: observation({ observationId: 'capture-b' }), ...common });

  assert.equal(a.content_hash, b.content_hash, 'identical numbers really do share a content address');
  assert.notEqual(a.run_id, b.run_id, 'but they remain two separate observations');
  assert.ok(decisionRunsFor(2026, 9).length >= 2);
});

test('C01: one observation cannot record two different answers', () => {
  const obs = observation({ observationId: 'single-answer' });
  const common = { observation: obs, policyId: 'nfl-production-v1', policyVersion: '1.0.0' };
  recordDecisionRun(2026, 4, board([decision()]), common);
  assert.throws(
    () => recordDecisionRun(2026, 4, board([decision({ edge_points: 9 })]), common),
    /already recorded different content/);
});

test('C01: ambiguous same-side different-line quotes resolve to the right decision', () => {
  const twoLines = [
    decision({ line: -2.5, american_price: 100, book: 'draftkings', quote_id: 'q-a', policy_rank: 1 }),
    decision({ line: -3.5, american_price: -150, book: 'draftkings', quote_id: 'q-b', policy_rank: 2 })
  ];
  const r = record(twoLines);

  const at25 = findDecisionEvent(r.run_id, { matchup: 'CHI at CAR', market: 'spread',
    selection: 'CAR', line: -2.5, book: 'draftkings', americanPrice: 100 });
  const at35 = findDecisionEvent(r.run_id, { matchup: 'CHI at CAR', market: 'spread',
    selection: 'CAR', line: -3.5, book: 'draftkings', americanPrice: -150 });

  assert.equal(at25.quote_id, 'q-a');
  assert.equal(at35.quote_id, 'q-b');
  assert.notEqual(at25.id, at35.id, 'the old lookup returned the same first row for both');
});

test('C01: a duplicate exact contract in one board is refused, not silently collapsed', () => {
  assert.throws(
    () => record([decision({ quote_id: 'q-a' }), decision({ quote_id: 'q-b' })]),
    /duplicate exact contract/);
});

test('C01: an arbitrary or absent code identity is refused', () => {
  assert.throws(() => record([decision()], { codeIdentity: { id: 'not-a-hash' } }),
    /real computed code identity/);
  assert.throws(() => record([decision()], { codeIdentity: null }),
    /real computed code identity/);
});

test('C01: a frozen-packet claim requires a real packet hash, and only it may carry one', () => {
  assert.throws(() => record([decision()], { dataIdentityStatus: 'frozen_packet' }),
    /must supply its packet hash/);
  assert.throws(() => record([decision()], { dataIdentityStatus: 'unfrozen_live_tables', dataHash: 'd'.repeat(64) }),
    /only a frozen_packet run may carry a data hash/);
});

test('C01: an observation missing any declared field is refused', () => {
  for (const field of ['experimentId', 'horizon', 'cutoffAt', 'jobId', 'observationId']) {
    const obs = observation();
    delete obs[field];
    assert.throws(
      () => recordDecisionRun(2026, 3, board([decision()]), {
        observation: obs, policyId: 'nfl-production-v1', policyVersion: '1.0.0' }),
      new RegExp(field), `${field} must be required`);
  }
});

/* ======================================================================
 * C02 — "failure injected on the second child rolls back all rows;
 * successful retry/restart; duplicate race; empty and nonempty delete
 * rejection; count reconciliation; missed game retained in the denominator."
 * ====================================================================== */

test('C02: a failure on the SECOND child rolls back the header and the first child', () => {
  const runsBefore = db.prepare(`SELECT COUNT(*) n FROM nfl_decision_runs`).get().n;
  const eventsBefore = db.prepare(`SELECT COUNT(*) n FROM nfl_decision_events`).get().n;

  // Inject a database-level failure that only the second insert trips, which
  // is the shape of the original defect: validation passed, the header was
  // written, and then a child failed with no transaction around any of it.
  db.exec(`CREATE TRIGGER test_reject_second BEFORE INSERT ON nfl_decision_events
           WHEN NEW.matchup = 'POISON at PILL'
           BEGIN SELECT RAISE(ABORT, 'injected child failure'); END;`);
  try {
    assert.throws(() => record([
      decision({ matchup: 'GOOD at ROW', home_team: 'ROW', away_team: 'GOOD', selection: 'ROW' }),
      decision({ matchup: 'POISON at PILL', home_team: 'PILL', away_team: 'POISON', selection: 'PILL' })
    ]), /injected child failure/);
  } finally {
    db.exec(`DROP TRIGGER test_reject_second`);
  }

  assert.equal(db.prepare(`SELECT COUNT(*) n FROM nfl_decision_runs`).get().n, runsBefore,
    'no header may survive a failed child');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM nfl_decision_events`).get().n, eventsBefore,
    'no partial children may survive');
});

test('C02: after a rolled-back failure the same observation records cleanly on restart', () => {
  const obs = observation({ observationId: 'restart-after-failure' });
  const common = { observation: obs, policyId: 'nfl-production-v1', policyVersion: '1.0.0' };
  const decisions = [
    decision({ matchup: 'GOOD at ROW', home_team: 'ROW', away_team: 'GOOD', selection: 'ROW' }),
    decision({ matchup: 'POISON at PILL', home_team: 'PILL', away_team: 'POISON', selection: 'PILL' })
  ];

  db.exec(`CREATE TRIGGER test_reject_restart BEFORE INSERT ON nfl_decision_events
           WHEN NEW.matchup = 'POISON at PILL'
           BEGIN SELECT RAISE(ABORT, 'injected child failure'); END;`);
  try {
    assert.throws(() => recordDecisionRun(2026, 5, board(decisions), common));
  } finally {
    db.exec(`DROP TRIGGER test_reject_restart`);
  }

  const recovered = recordDecisionRun(2026, 5, board(decisions), common);
  assert.equal(recovered.created, true, 'the failed attempt must not block the retry');
  assert.equal(decisionRun(recovered.run_id).events.length, 2);
  assert.equal(decisionRun(recovered.run_id).complete, true);
});

test('C02: a duplicate observation cannot produce two rows even at the schema level', () => {
  const r = record([decision()]);
  const stored = decisionRun(r.run_id);
  assert.throws(() => db.prepare(
    `INSERT INTO nfl_decision_runs (id, season, week, policy_id, policy_version, board_hash,
       content_hash, observation_key, decided_at, decision_count, selected_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('duplicate-attempt', 2026, 3, 'nfl-production-v1', '1.0.0',
      'different-run-identity', stored.content_hash, stored.observation_key,
      stored.decided_at, 1, 1),
  /UNIQUE/i);
});

test('C02: an EMPTY run header cannot be deleted', () => {
  // The original hole: a populated run was protected only by accident, through
  // its children's delete trigger. An empty run -- which is exactly what a
  // fully-abstaining or unavailable observation is -- had no protection at all.
  const r = recordDecisionRun(2026, 6, board([]), {
    observation: observation({ observationId: 'nothing-computed' }),
    policyId: 'nfl-production-v1', policyVersion: '1.0.0',
    computationStatus: 'unavailable' });
  assert.equal(decisionRunEvents(r.run_id).length, 0);
  assert.throws(() => db.prepare(`DELETE FROM nfl_decision_runs WHERE id=?`).run(r.run_id),
    /immutable/);
  assert.ok(decisionRun(r.run_id), 'the empty run is still there');
});

test('C02: a POPULATED run header cannot be deleted either', () => {
  const r = record([decision()]);
  assert.throws(() => db.prepare(`DELETE FROM nfl_decision_runs WHERE id=?`).run(r.run_id),
    /immutable|append-only/);
  assert.ok(decisionRun(r.run_id));
});

test('C02: counts reconcile, and a header that claims more than it holds is not "already recorded"', () => {
  const obs = observation({ observationId: 'count-mismatch' });
  const common = { observation: obs, policyId: 'nfl-production-v1', policyVersion: '1.0.0' };
  const r = recordDecisionRun(2026, 7, board([decision()]), common);

  // Simulate a legacy half-written run by overstating the header's claim.
  // The trigger blocks UPDATE, so this is done the only way a v1-era record
  // could have arrived: a header whose children never landed.
  db.exec(`DROP TRIGGER nfl_decision_runs_no_update`);
  db.prepare(`UPDATE nfl_decision_runs SET decision_count = 5 WHERE id=?`).run(r.run_id);
  db.exec(`CREATE TRIGGER nfl_decision_runs_no_update BEFORE UPDATE ON nfl_decision_runs
           BEGIN SELECT RAISE(ABORT, 'decision runs are immutable — a changed board is a new run'); END;`);

  assert.equal(decisionRun(r.run_id).complete, false, 'completeness is computed, not trusted');
  assert.throws(() => recordDecisionRun(2026, 7, board([decision()]), common),
    /incomplete/, 'a retry must not report a broken run as already recorded');
});

test('C02: an incomplete run is invalidated by APPENDING, never by rewriting it', () => {
  const r = record([decision()]);
  const before = decisionRun(r.run_id);

  invalidateDecisionRun(r.run_id, { reason: 'superseded by a corrected observation', actor: 'test' });

  const after = decisionRun(r.run_id);
  assert.equal(after.invalidated, true);
  assert.equal(decisionRunInvalidations(r.run_id).length, 1);
  // The run itself is untouched.
  assert.equal(after.content_hash, before.content_hash);
  assert.deepEqual(after.events, before.events);
  assert.throws(() => db.prepare(`DELETE FROM nfl_decision_run_invalidations WHERE run_id=?`).run(r.run_id),
    /append-only/);
});

test('C02: a missed observation is recorded as unavailable and stays in the denominator', () => {
  const r = recordDecisionRun(2026, 8, board([]), {
    observation: observation({ observationId: 'missed-capture', horizon: 'T-60' }),
    policyId: 'nfl-production-v1', policyVersion: '1.0.0',
    computationStatus: 'unavailable',
    note: 'collector did not run before cutoff' });

  const stored = decisionRun(r.run_id);
  assert.equal(stored.computation_status, 'unavailable');
  assert.equal(stored.decision_count, 0);
  assert.ok(decisionRunsFor(2026, 8).some(x => x.id === r.run_id),
    'a missed capture must remain visible as coverage, not vanish');
});

test('C02: an unavailable computation cannot smuggle decisions in, and a silent empty board is refused', () => {
  assert.throws(() => record([decision()], { computationStatus: 'unavailable' }),
    /unavailable computation cannot carry decisions/);
  assert.throws(() => record([], { computationStatus: 'complete' }),
    /ambiguous/);
});

test('C02: an invalid candidate is refused BEFORE anything is written', () => {
  const runsBefore = db.prepare(`SELECT COUNT(*) n FROM nfl_decision_runs`).get().n;
  assert.throws(() => record([decision({ model_probability: 4 })]), /probability in \[0,1\]/);
  assert.throws(() => record([decision({ eligible: true, line: null })]), /eligible but has no line/);
  assert.throws(() => record([decision({ eligible: false, abstention_reason: null })]),
    /states no abstention reason/);
  assert.throws(() => record([decision({ edge_points: Number.NaN })]), /must be finite/);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM nfl_decision_runs`).get().n, runsBefore,
    'a refused board writes nothing at all');
});

/* ======================================================================
 * The observation key's own contract
 * ====================================================================== */

test('the observation key ignores the retry attempt and nothing else', () => {
  const base = { experimentId: 'e', horizon: 'T-60', cutoffAt: '2026-09-10T17:00:00Z',
    jobId: 'j', observationId: 'o' };
  assert.equal(observationKey({ ...base, attempt: 1 }), observationKey({ ...base, attempt: 7 }));
  for (const field of ['experimentId', 'horizon', 'cutoffAt', 'jobId', 'observationId']) {
    assert.notEqual(observationKey(base), observationKey({ ...base, [field]: 'changed' }),
      `${field} must be part of the observation identity`);
  }
});

/* ======================================================================
 * Stage 2 engine unification: `nfl_pick_decisions` is a read-side cache
 * regenerated FROM the tape, never written independently. See this file's
 * companion "ONE WRITER" note in nfl-decision-tape.js.
 * ====================================================================== */

test('recordDecisionRun regenerates the nfl_pick_decisions cache from its own tape rows', () => {
  const abstained = decision({
    matchup: 'DAL at PHI', home_team: 'PHI', away_team: 'DAL', selection: null, side: null,
    line: null, american_price: null, book: null, eligible: false, calibration_eligible: false,
    abstention_reason: 'below minimum edge', policy_rank: null
  });
  const r = recordDecisionRun(2026, 10, board([decision(), abstained]), {
    observation: observation({ observationId: 'cache-regen-1' }),
    policyId: 'nfl-production-v1', policyVersion: '1.0.0'
  });

  const cached = db.prepare(`SELECT * FROM nfl_pick_decisions WHERE season=2026 AND week=10 ORDER BY matchup`).all();
  assert.equal(cached.length, 2, 'both the selected pick and the abstention are cached');

  const selectedRow = cached.find(c => c.matchup === 'CHI at CAR');
  assert.equal(selectedRow.policy_id, 'nfl-production-v1');
  assert.equal(selectedRow.selection, 'CAR');
  assert.equal(selectedRow.market, 'spread');
  assert.equal(selectedRow.line, -2.5);
  assert.equal(selectedRow.edge, 3.2, 'edge in the cache is edge_points, same column meaning as before the merge');
  assert.equal(selectedRow.eligible, 1);
  assert.equal(selectedRow.abstention_reason, null);

  const abstainedRow = cached.find(c => c.matchup === 'DAL at PHI');
  assert.equal(abstainedRow.eligible, 0);
  assert.equal(abstainedRow.abstention_reason, 'below minimum edge');

  // The cache is addressed by run, but its row key is (season, week, policy,
  // matchup, market, selection) -- decisionRunEvents still shows both events
  // recorded on the immutable tape underneath it.
  assert.equal(decisionRunEvents(r.run_id).length, 2);
});

test('a later run for the same week overwrites the cache row — latest view, not accumulation', () => {
  const obsA = observation({ observationId: 'latest-view-a' });
  const obsB = observation({ observationId: 'latest-view-b' });
  const common = { policyId: 'nfl-production-v1', policyVersion: '1.0.0' };

  recordDecisionRun(2026, 11, board([decision({ line: -2.5, american_price: -110 })]),
    { observation: obsA, ...common });
  recordDecisionRun(2026, 11, board([decision({ line: -3, american_price: -120 })]),
    { observation: obsB, ...common });

  const rowsFor11 = db.prepare(`SELECT * FROM nfl_pick_decisions WHERE season=2026 AND week=11`).all();
  assert.equal(rowsFor11.length, 1, 'the UPSERT key means one live row per (season,week,policy,matchup,market,selection)');
  assert.equal(rowsFor11[0].line, -3, 'the cache reflects the LATEST recorded run, not the first one');

  // Both observations still exist, unabridged, on the append-only tape.
  assert.equal(decisionRunsFor(2026, 11).length, 2);
});

test('nfl-auto-picks.js no longer exports an independent nfl_pick_decisions writer', async () => {
  const autoPicks = await import('../server/services/nfl-auto-picks.js');
  assert.equal(autoPicks.persistPickDecisions, undefined,
    'persistPickDecisions was removed — recordDecisionRun is the only writer of nfl_pick_decisions');
});
