/**
 * Codex correction C01, closed on the REAL path: "real board-to-pipeline tests
 * changing each material field independently."
 *
 * `test/nfl-decision-tape.test.js` exercises the tape directly. That is not
 * enough on its own, because the original defect was a mismatch BETWEEN two
 * components: the board emits `edge_points`, the tape hashed `d.edge`, and
 * each component was internally consistent. Only running the actual board
 * through the actual pipeline catches that class of error, so this file
 * exercises `runExecutionPipeline` end to end and inspects what the tape
 * actually stored.
 *
 * The expensive forecasting producer is frozen -- `autoPickDecisionBoard` is
 * replaced with a board that has the exact shape the real one emits, field for
 * field, including the nested `feature_snapshot.raw_forecast` the tape reads
 * the signed edge out of. Everything downstream of it is the real code:
 * the real pipeline, the real tape, the real lifecycle ledger.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-decision-identity-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026, WEEK = 3;
// Dates are derived from the clock rather than hard-coded, because the
// pipeline genuinely depends on both directions of "now": a contract at or
// past kickoff is refused as `not_pregame`, and a quote stamped later than the
// decision is not yet eligible to decide from. A fixture with fixed dates
// would pass today and silently stop exercising the path later.
const KICKOFF = new Date(Date.now() + 7 * 86400_000);
const DAY = KICKOFF.toISOString().slice(0, 10), KICKOFF_TIME = '17:00';
// Recent enough to be usable: the pipeline refuses a quote older than
// `DEFAULT_MAX_STALENESS_SECONDS` as `stale_decision_quote`, which is correct
// behaviour and not what this test is about.
const QUOTE_AT = new Date(Date.now() - 60_000).toISOString();

// `contractKey` resolves canonical teams through `team-codes.js`, which reads
// this table; without it every contract fails as `unresolved_team` and the
// pipeline opens nothing, so the test would pass vacuously.
db.exec(`INSERT INTO nfl_teams (id,abbr,name,conference,division) VALUES
  (1,'CAR','Carolina Panthers','NFC','South'),
  (2,'CHI','Chicago Bears','NFC','North'),
  (3,'SF','San Francisco 49ers','NFC','West'),
  (4,'SEA','Seattle Seahawks','NFC','West')`);

// Two real scheduled games, so a cross-game mistake has somewhere to go wrong.
for (const [team, opponent, home] of [
  ['CAR', 'CHI', 1], ['CHI', 'CAR', 0],
  ['SF', 'SEA', 1], ['SEA', 'SF', 0]
]) {
  run(`INSERT INTO game_lines (season, week, team, opponent, home, gameday, gametime, spread, spread_odds, source, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  SEASON, WEEK, team, opponent, home, DAY, KICKOFF_TIME, home ? -2.5 : 2.5, -110, 'draftkings',
  QUOTE_AT);
}

/** Exactly the shape `nfl-auto-picks.js` emits for one candidate. */
function candidate(over = {}) {
  const snapshot = {
    forecast_identity: { id: 'f'.repeat(64) },
    calibration_status: 'calibrated',
    cover_calibration: 'cover-logit-v3-graph-bound:abc-2021-2024',
    active_model_ids: ['massey', 'colley', 'pythagorean'],
    input_mode: 'live_weekly_unfrozen',
    coordinated_decision_head: { neural: { version: null, authority: 'unavailable', used: false } },
    raw_forecast: { base_projected_margin: 5, projected_margin: 5, market_margin: 2.5, signed_edge_points: 2.5 },
    ...(over.feature_snapshot ?? {})
  };
  const { feature_snapshot: _ignored, ...rest } = over;
  return {
    market: 'spread', home_team: 'CAR', away_team: 'CHI', matchup: 'CHI at CAR',
    selection: 'CAR', side: '-2.5', line: -2.5, american_price: -110,
    model_probability: 0.56, implied_probability: 0.524, probability_difference: 0.036,
    calibration_eligible: true, calibration_status: 'calibrated', promoted_finding_veto: null,
    detail: 'Ensemble edge +2.5 · disagreement 2.1',
    edge_points: 2.5, disagreement: 2.1,
    book: 'draftkings', quote_source: 'draftkings', quote_at: QUOTE_AT,
    expected_return: 0.0688, eligible: true, abstention_reason: null, policy_rank: 1,
    feature_snapshot: snapshot,
    ...rest
  };
}

const auto = await import('../server/services/nfl-auto-picks.js');
let board = null;
mock.module('../server/services/nfl-auto-picks.js', { namedExports: {
  ...auto, autoPickDecisionBoard: () => board
} });

const { runExecutionPipeline } = await import('../server/services/nfl-execution-pipeline.js');
const { decisionRun, decisionRunsFor } = await import('../server/services/nfl-decision-tape.js');
const { NFL_PRODUCTION_POLICY } = await import('../server/services/nfl-policy.js');

let obsSeq = 0;
function pipeline(decisions, { policy = NFL_PRODUCTION_POLICY, observationId = null } = {}) {
  board = { decisions, selected: decisions.filter(d => d.eligible),
    policy: { id: policy.id, version: policy.version }, engine_mode: 'champion' };
  lastResult = runExecutionPipeline(SEASON, WEEK, policy, {
    observation: { experimentId: 'c01-pipeline-fixture', horizon: 'T-60',
      cutoffAt: new Date(KICKOFF.getTime() - 3600_000).toISOString(), jobId: 'fixture-job',
      observationId: observationId ?? `pipeline-obs-${++obsSeq}`, attempt: 1 }
  });
  return lastResult;
}

/**
 * The run this invocation recorded. Read from the pipeline's own return value
 * rather than by querying for the newest row: `created_at` has second
 * resolution and run ids are random UUIDs, so "newest" is not well defined
 * within one second and a test that guessed would be testing the guess.
 */
let lastResult = null;
function latestRun() {
  return decisionRun(lastResult.decision_run.run_id);
}

test('C01 on the real path: the board\'s own edge and forecast reach the tape intact', () => {
  pipeline([candidate()]);
  const recorded = latestRun();
  const [event] = recorded.events;

  // The exact defect: `edge` was NULL on every row because the tape read a
  // field the board does not emit.
  assert.equal(event.edge, 2.5, 'the signed edge the board computed must be persisted');
  assert.equal(event.edge_points, 2.5);
  assert.equal(event.projected_margin, 5);
  assert.equal(event.market_margin, 2.5);
  assert.equal(event.model_probability, 0.56);
  assert.equal(event.forecast_identity, 'f'.repeat(64));
  assert.equal(event.cover_calibration, 'cover-logit-v3-graph-bound:abc-2021-2024');

  // The code identity is real and re-derivable, not a caller-supplied string.
  assert.match(recorded.code_hash, /^[0-9a-f]{64}$/);
  const manifest = JSON.parse(recorded.code_manifest_json);
  assert.equal(manifest.schema_version, 'code-identity-v1');
  assert.ok(manifest.files.length > 50, 'the manifest names the actual module closure');

  // The data provenance is recorded honestly: this board read mutable tables.
  assert.equal(recorded.data_identity_status, 'unfrozen_live_tables');
  assert.equal(recorded.data_hash, null);
});

test('C01 on the real path: changing each material field creates a NEW run', () => {
  // The audit's exact scenario: forecast 5 → 12, edge 2 → 9, model A → B, a
  // different quote id and different code/data identities all reused one run.
  const variants = {
    baseline: candidate(),
    forecast_12: candidate({ feature_snapshot: {
      raw_forecast: { base_projected_margin: 12, projected_margin: 12, market_margin: 2.5, signed_edge_points: 9.5 } } }),
    edge_9: candidate({ edge_points: 9 }),
    model_b: candidate({ feature_snapshot: { forecast_identity: { id: 'b'.repeat(64) } } }),
    quote_id: candidate({ quote_id: 'a-different-quote' }),
    line_moved: candidate({ line: -3.5, side: '-3.5' }),
    price_moved: candidate({ american_price: -135 }),
    probability: candidate({ model_probability: 0.61 }),
    abstained: candidate({ eligible: false, abstention_reason: 'edge_below_threshold', policy_rank: null })
  };

  const hashes = new Map();
  for (const [label, c] of Object.entries(variants)) {
    pipeline([c]);
    const recorded = latestRun();
    assert.ok(!hashes.has(recorded.content_hash),
      `${label} reused the run recorded for ${hashes.get(recorded.content_hash)}`);
    hashes.set(recorded.content_hash, label);
  }
  assert.equal(hashes.size, Object.keys(variants).length);
});

test('C01 on the real path: an opportunity cites the decision for its OWN line, not another', () => {
  // Two candidates, same side of the same game, different lines and prices --
  // the ambiguity the old `ORDER BY id LIMIT 1` lookup resolved by guessing.
  // Lines no earlier test used. A contract key includes its line, and the
  // pipeline correctly refuses to open a second opportunity against a contract
  // that is already open -- so reusing -2.5 here would skip both candidates
  // and the test would prove nothing.
  const twoLines = [
    candidate({ line: -4.5, side: '-4.5', american_price: 100, policy_rank: 1 }),
    candidate({ matchup: 'SEA at SF', home_team: 'SF', away_team: 'SEA', selection: 'SF',
      line: -5.5, side: '-5.5', american_price: -150, policy_rank: 2 })
  ];
  pipeline(twoLines);
  const recorded = latestRun();

  const opportunities = db.prepare(
    `SELECT o.id, o.matchup, o.decision_event_id, e.line, e.american_price
       FROM nfl_execution_opportunities o
       JOIN nfl_decision_events e ON e.id = o.decision_event_id
      WHERE e.run_id = ?`).all(recorded.id);

  assert.deepEqual(lastResult.results.filter(r => r.error || r.skipped), [],
    'no candidate may be skipped or errored in this fixture — that would make the check vacuous');
  assert.equal(opportunities.length, 2, 'both contracts opened and both cite a decision event');
  for (const o of opportunities) {
    const source = recorded.events.find(e => e.id === o.decision_event_id);
    assert.ok(source, 'every opportunity cites a decision event on this run');
    assert.equal(source.matchup, o.matchup,
      'an opportunity must cite the decision made about its own game');
    assert.equal(source.line, o.line,
      'an opportunity must cite the decision made about its own line');
  }
});

test('C01 on the real path: re-running the identical observation writes nothing new', () => {
  const before = decisionRunsFor(SEASON, WEEK).length;
  pipeline([candidate()], { observationId: 'stable-observation' });
  const after = decisionRunsFor(SEASON, WEEK).length;

  const again = pipeline([candidate()], { observationId: 'stable-observation' });
  assert.equal(decisionRunsFor(SEASON, WEEK).length, after,
    'an idempotent retry must not add a run');
  assert.ok(after > before);
  assert.ok(again);
});

test('C01 on the real path: a caller that declares no observation cannot claim a T-60 horizon', () => {
  // A manual invocation is real evidence of something, but it is not a
  // scheduled prospective capture, and the tape must not let it look like one.
  board = { decisions: [candidate()], selected: [candidate()],
    policy: { id: NFL_PRODUCTION_POLICY.id, version: NFL_PRODUCTION_POLICY.version },
    engine_mode: 'champion' };
  lastResult = runExecutionPipeline(SEASON, WEEK, NFL_PRODUCTION_POLICY);
  const recorded = latestRun();
  assert.equal(recorded.horizon, 'unspecified_on_demand');
  assert.equal(recorded.experiment_id, 'unscheduled-manual-invocation');
  assert.notEqual(recorded.horizon, 'T-60');
});
