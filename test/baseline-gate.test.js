/**
 * The beat-the-dumb-baseline gate interface (plan item C12, unit C-01).
 *
 * One small instrument that C-01 (start/sit), C-02 (waivers) and C-03 (trades)
 * all grade with: a list of decisions where our policy and the dumb baseline
 * disagreed, each carrying the realised points of both picks, in; win rate,
 * points per decision, a player-clustered and a week-clustered 90% CI, n, the
 * minimum detectable effect and every failing week, out. Pre-registration:
 * docs/evidence/2026-09-22/start-sit-baseline-gate-prereg.md.
 *
 * Sign convention pinned here: points = our pick minus the dumb pick, so a
 * positive number favours our policy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const G = await import('../server/services/gates/baseline-gate.js').catch(error => ({ __importError: error }));
const { pairedBootstrapDiff } = await import('../server/services/backtest-significance.js');

const d = (season, week, policyId, baselineId, policyPoints, baselinePoints) => ({
  season, week, policy_id: policyId, baseline_id: baselineId,
  policy_points: policyPoints, baseline_points: baselinePoints
});

/** 40 decisions over 4 weeks, 40 distinct players on each side, mixed outcomes. */
function mixed() {
  const out = [];
  for (let i = 0; i < 40; i++) {
    const week = 5 + (i % 4);
    const pp = 10 + ((i * 7) % 11);
    const bp = 10 + ((i * 3) % 13);
    out.push(d(2025, week, `p${i}`, `b${i}`, pp, bp));
  }
  return out;
}

test('the gate module loads', () => {
  assert.ifError(G.__importError);
  assert.equal(typeof G.gradeDecisions, 'function');
  assert.equal(typeof G.baselineGateVerdict, 'function');
});

test('a disagreement our pick wins is 1 with positive points; a tie is half; a loss is 0', () => {
  assert.deepEqual(G.decisionOutcome(d(2025, 5, 'a', 'b', 12, 7)), { win: 1, points: 5 });
  assert.deepEqual(G.decisionOutcome(d(2025, 5, 'a', 'b', 9, 9)), { win: 0.5, points: 0 });
  assert.deepEqual(G.decisionOutcome(d(2025, 5, 'a', 'b', 3, 11)), { win: 0, points: -8 });
});

test('grading reports win rate, points per decision, n and the sign convention', () => {
  const ds = mixed();
  const g = G.gradeDecisions(ds, { iterations: 400, seed: 1 });
  const wins = ds.map(x => (x.policy_points > x.baseline_points ? 1 : x.policy_points === x.baseline_points ? 0.5 : 0));
  const pts = ds.map(x => x.policy_points - x.baseline_points);
  assert.equal(g.n, 40);
  assert.equal(g.players, 80);
  assert.equal(g.win_rate, +(wins.reduce((s, v) => s + v, 0) / 40).toFixed(4));
  assert.equal(g.points_per_decision, +(pts.reduce((s, v) => s + v, 0) / 40).toFixed(4));
  assert.match(G.SIGN_CONVENTION, /our pick minus the dumb pick/i);
  assert.match(G.SIGN_CONVENTION, /positive favours our/i);
});

test('the player-clustered interval resamples players, not decisions', () => {
  // All 30 wins ride on ONE player (A is our pick in every one); the 30 losses are
  // spread over 60 different players. Resampling decisions treats the 30 wins as 30
  // independent facts; resampling players knows they are one player's weeks.
  const ds = [];
  for (let i = 0; i < 30; i++) ds.push(d(2025, 5 + (i % 10), 'A', `b${i}`, 20, 10));
  for (let i = 0; i < 30; i++) ds.push(d(2025, 5 + (i % 10), `p${i}`, `c${i}`, 10, 20));
  const g = G.gradeDecisions(ds, { iterations: 2000, seed: 1 });
  const iid = pairedBootstrapDiff(ds.map(x => x.baseline_points), ds.map(x => x.policy_points),
    { iterations: 2000, seed: 1 });
  const width = ([lo, hi]) => hi - lo;
  assert.ok(width(g.ci90.player.points) > 1.5 * width(iid.ci90),
    `player-clustered ${JSON.stringify(g.ci90.player.points)} vs decision-level ${JSON.stringify(iid.ci90)}`);
});

test('the dumb pick is a cluster too: a shared baseline player widens the interval just the same', () => {
  // The mirror of the test above: 30 losses all share ONE dumb-rule pick (B), 30 wins are
  // spread over 60 different players. Clustering only our side would miss B entirely.
  const ds = [];
  for (let i = 0; i < 30; i++) ds.push(d(2025, 5 + (i % 10), `p${i}`, 'B', 10, 20));
  for (let i = 0; i < 30; i++) ds.push(d(2025, 5 + (i % 10), `q${i}`, `c${i}`, 20, 10));
  const g = G.gradeDecisions(ds, { iterations: 2000, seed: 1 });
  const iid = pairedBootstrapDiff(ds.map(x => x.baseline_points), ds.map(x => x.policy_points),
    { iterations: 2000, seed: 1 });
  const width = ([lo, hi]) => hi - lo;
  assert.ok(width(g.ci90.player.points) > 1.5 * width(iid.ci90),
    `player-clustered ${JSON.stringify(g.ci90.player.points)} vs decision-level ${JSON.stringify(iid.ci90)}`);
});

test('with no player recurring, the player interval is a 90% interval, conservative by about sqrt(3)', () => {
  // Every decision has two players seen nowhere else, so there is nothing to cluster. The
  // two-factor bootstrap then over-counts the cell noise (Owen 2007): about sqrt(3) = 1.73x
  // the ordinary 90% interval, never narrower than it.
  const ds = [];
  for (let i = 0; i < 400; i++) ds.push(d(2025, 5 + (i % 14), `p${i}`, `b${i}`, 10 + ((i * 7919) % 23), 10 + ((i * 104729) % 19)));
  const g = G.gradeDecisions(ds, { iterations: 2000, seed: 1 });
  const iid = pairedBootstrapDiff(ds.map(x => x.baseline_points), ds.map(x => x.policy_points),
    { iterations: 2000, seed: 1 });
  const ratio = (g.ci90.player.points[1] - g.ci90.player.points[0]) / (iid.ci90[1] - iid.ci90[0]);
  assert.ok(ratio >= 1.0 && ratio <= 2.2, `player/iid width ratio ${ratio.toFixed(3)}`);
});

test('the week-clustered interval is pairedBootstrapDiff itself, grouped by season-week', () => {
  const ds = mixed();
  const g = G.gradeDecisions(ds, { iterations: 500, seed: 3 });
  const groups = ds.map(x => `${x.season}-${x.week}`);
  const pts = pairedBootstrapDiff(ds.map(x => x.baseline_points), ds.map(x => x.policy_points),
    { iterations: 500, seed: 3, groups });
  const wins = ds.map(x => G.decisionOutcome(x).win);
  const wr = pairedBootstrapDiff(ds.map(() => 0.5), wins, { iterations: 500, seed: 3, groups });
  assert.deepEqual(g.ci90.week.points, pts.ci90);
  assert.deepEqual(g.ci90.week.win_rate, [+(0.5 + wr.ci90[0]).toFixed(4), +(0.5 + wr.ci90[1]).toFixed(4)]);
  assert.equal(g.ci90.week.clusters, 4);
});

test('below 2 week clusters the week-clustered interval is null, with a reason (Auditor ruling A7)', () => {
  // One week is one cluster: every resample draws that same week back, so the "interval"
  // came out [x, x], a point and not an interval (the ruling's -3.4207 to -3.4207).
  const oneWeek = mixed().map(x => ({ ...x, week: 5 }));
  const g = G.gradeDecisions(oneWeek, { iterations: 300, seed: 1 });
  assert.equal(g.ci90.week.clusters, 1);
  assert.equal(g.ci90.week.points, null, `one week cluster gave a week interval ${JSON.stringify(g.ci90.week.points)}`);
  assert.equal(g.ci90.week.win_rate, null, `one week cluster gave a week win-rate interval ${JSON.stringify(g.ci90.week.win_rate)}`);
  assert.match(g.ci90.week.note ?? '', /fewer than 2 week clusters/);
  // The player interval does not lean on weeks, so it is still reported.
  assert.ok(Array.isArray(g.ci90.player.points) && g.ci90.player.points[0] < g.ci90.player.points[1]);
  // Control, known-nonzero: the same decisions over two weeks give a real interval.
  const twoWeeks = mixed().map(x => ({ ...x, week: 5 + (x.week % 2) }));
  const g2 = G.gradeDecisions(twoWeeks, { iterations: 300, seed: 1 });
  assert.equal(g2.ci90.week.clusters, 2);
  assert.ok(Array.isArray(g2.ci90.week.points) && g2.ci90.week.points[0] < g2.ci90.week.points[1],
    `two clusters: ${JSON.stringify(g2.ci90.week.points)}`);
  assert.equal(g2.ci90.week.note, null);
});

test('the interval is reproducible from its seed', () => {
  const a = G.gradeDecisions(mixed(), { iterations: 300, seed: 9 });
  const b = G.gradeDecisions(mixed(), { iterations: 300, seed: 9 });
  assert.deepEqual(a, b);
});

test('the minimum detectable effect at 80% power is (1.6449 + 0.8416) standard errors', () => {
  assert.ok(Math.abs(G.MDE_Z - 2.4865) < 1e-9);
  const g = G.gradeDecisions(mixed(), { iterations: 400, seed: 1 });
  assert.ok(g.se.points > 0 && g.se.win_rate > 0);
  assert.ok(Math.abs(g.mde80.points - G.MDE_Z * g.se.points) < 1e-3, JSON.stringify({ mde: g.mde80, se: g.se }));
  assert.ok(Math.abs(g.mde80.win_rate - G.MDE_Z * g.se.win_rate) < 1e-3);
});

test('every failing week is listed, none truncated', () => {
  const ds = [];
  for (let w = 1; w <= 15; w++) {
    const lose = w <= 12;                                  // 12 failing weeks, 3 winning
    for (let k = 0; k < 3; k++) ds.push(d(2024, w, `p${w}-${k}`, `b${w}-${k}`, lose ? 5 : 15, 10));
  }
  for (let k = 0; k < 3; k++) ds.push(d(2024, 16, `p16-${k}`, `b16-${k}`, 10, 10));   // break-even: not failing
  const g = G.gradeDecisions(ds, { iterations: 200, seed: 1 });
  assert.equal(g.per_week.length, 16);
  assert.equal(g.per_week.find(w => w.week === 16).failing, false);
  assert.equal(g.failing_weeks.length, 12);
  assert.deepEqual(g.failing_weeks.map(w => w.week), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  for (const w of g.failing_weeks) {
    assert.equal(w.season, 2024);
    assert.equal(w.n, 3);
    assert.equal(w.points_per_decision, -5);
    assert.equal(w.win_rate, 0);
  }
  assert.ok(g.per_week.filter(w => !w.failing).every(w => w.points_per_decision >= 0));
});

test('no disagreements is its own verdict, never a pass', () => {
  const g = G.gradeDecisions([], { iterations: 200, seed: 1 });
  assert.equal(g.n, 0);
  assert.equal(g.win_rate, null);
  assert.equal(g.points_per_decision, null);
  assert.equal(G.baselineGateVerdict({ past: g, forward: null }).verdict, 'no_disagreements');
});

/** A grade summary with the fields the verdict reads, and nothing else. */
const summary = ({ n = 500, player = [0.4, 1.2], week = [0.3, 1.3], wr = [0.52, 0.58] } = {}) =>
  ({ n, ci90: { player: { points: player, win_rate: wr }, week: { points: week } } });
const fwd = (points, n = 40) => ({ n, points_per_decision: points });

test('verdict: all four gates pass is beats_dumb', () => {
  const v = G.baselineGateVerdict({ past: summary(), forward: fwd(0.6) });
  assert.equal(v.verdict, 'beats_dumb');
  assert.deepEqual(v.gates.map(x => [x.id, x.passed]), [['G1', true], ['G2', true], ['G3', true], ['G4', true]]);
  for (const gate of v.gates) assert.ok('value' in gate && typeof gate.label === 'string');
});

test('verdict: a past pass that the forward weeks do not confirm is unconfirmed forward', () => {
  assert.equal(G.baselineGateVerdict({ past: summary(), forward: fwd(-0.2) }).verdict, 'beats_dumb_unconfirmed_forward');
  assert.equal(G.baselineGateVerdict({ past: summary(), forward: fwd(0) }).verdict, 'beats_dumb_unconfirmed_forward');
  assert.equal(G.baselineGateVerdict({ past: summary(), forward: fwd(0.5, 0) }).verdict, 'beats_dumb_unconfirmed_forward');
  assert.equal(G.baselineGateVerdict({ past: summary(), forward: null }).verdict, 'beats_dumb_unconfirmed_forward');
});

test('verdict: each past gate fails on its own boundary, strictly', () => {
  const at = o => G.baselineGateVerdict({ past: summary(o), forward: fwd(1) });
  assert.equal(at({ player: [0, 1] }).verdict, 'not_distinguishable');          // G1 lower bound exactly 0
  assert.equal(at({ week: [0, 1] }).verdict, 'not_distinguishable');            // G2 lower bound exactly 0
  assert.equal(at({ week: null }).verdict, 'not_distinguishable');              // G2 not computable
  assert.equal(at({ wr: [0.5, 0.6] }).verdict, 'not_distinguishable');          // G3 lower bound exactly 0.5
  assert.equal(at({ player: [-0.3, 0.9] }).verdict, 'not_distinguishable');
});

test('verdict: an interval entirely below zero is loses_to_dumb', () => {
  const v = G.baselineGateVerdict({ past: summary({ player: [-1.4, -0.1], week: [-1.5, 0.2], wr: [0.41, 0.49] }), forward: fwd(-1) });
  assert.equal(v.verdict, 'loses_to_dumb');
  assert.equal(G.baselineGateVerdict({ past: summary({ player: [-1.4, 0] }), forward: fwd(-1) }).verdict,
    'not_distinguishable');                                                       // upper bound exactly 0 is not below
});
