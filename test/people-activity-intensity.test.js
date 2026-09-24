/**
 * ACTIVITY-01: per-manager self-exciting add intensity (people/activity-intensity.js)
 * and its one wiring point, the manager_signals build.
 *
 * Guarantees:
 *  - the formula is the r25 IDEA-084 PP model: a hand computation of one team's
 *    lambda matches to 1e-12 (the port matched the fitting script to 1e-15 on
 *    the 126,138 held-out 2023-24 rows; that check is local, the corpus is not
 *    in the repo);
 *  - recent adds above a manager's own base rate raise his rate, dead and empty
 *    starters last week lower it (the fitted signs);
 *  - under two completed weeks, or with an adds gap, every team is null with a
 *    reason, never a number;
 *  - a missing result or lineup input zeroes that term and is named;
 *  - flag off: the build writes no intensity rows (today's output); flag on:
 *    every manager gets tx_adds_intensity, tx_adds_intensity_vs_league and
 *    tx_p_add_next_week, served by signalRowsFor;
 *  - the P(responds) activity term (counterparty-pricing activityFactor) reads
 *    the intensity in place of the constant rate when every manager has one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-activity-intensity-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'no-chat.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const {
  ACTIVITY_INTENSITY_FIT: FIT, leagueActivityIntensity, leagueBaselineRate, poissonLogLik,
} = await import('../server/services/people/activity-intensity.js');

const T = (roster_id, adds, points, opp, dead = [0, 0, 0, 0, 0, 0], empty = [0, 0, 0, 0, 0, 0]) =>
  ({ roster_id, adds, points, opp_points: opp, dead, empty });

test('A1 one team by hand: lambda is the PP formula', () => {
  const teams = [
    T('1', [1, 3], [100, 80], [90, 120], [0, 1], [0, 0]),
    T('2', [0, 0], [90, 120], [100, 80], [0, 0], [0, 1]),
  ];
  const r = leagueActivityIntensity(teams, 3).get('1');
  const c = FIT.coef;
  const leagueRate = 4 / 4;
  const l0 = (4 + 2 * leagueRate) / (2 + 2);
  const exc = Math.log1p(3 + 0.7 * 1) - Math.log1p(l0 * 1.7);
  const Lt = (100 + 80 + 90 + 120) / 4;
  const eta = c.const + c.logl0 * Math.log(l0) + c.lost1 * 1 + c.streak2 * 0 + c.margin1 * (-40 / Lt)
    + c.dead1 * 1 + c.empty1 * 0 + c.wp * 0.5 + c.exc * exc; // week 3 is the reference week
  assert.ok(Math.abs(r.lambda0 - l0) < 1e-12);
  assert.ok(Math.abs(r.lambda - l0 * Math.exp(eta)) < 1e-12);
  assert.ok(Math.abs(r.p_any_add - (1 - Math.exp(-r.lambda))) < 1e-12);
  assert.deepEqual(r.missing, []);
  assert.equal(r.week, 3);
});

test('A2 week effect: week 7 uses w7, weeks past 14 use w14', () => {
  const six = [1, 1, 1, 1, 1, 1];
  const teams = [T('1', six, [100, 100, 100, 100, 100, 100], [90, 90, 90, 90, 90, 90])];
  const w7 = leagueActivityIntensity(teams, 7).get('1');
  assert.ok(Math.abs(w7.terms.base - (FIT.coef.const + FIT.week[7] + FIT.coef.logl0 * Math.log(w7.lambda0))) < 1e-12);
  const long = Array(15).fill(1);
  const t15 = [T('1', long, Array(15).fill(100), Array(15).fill(90), Array(15).fill(0), Array(15).fill(0))];
  const w16 = leagueActivityIntensity(t15, 16).get('1');
  assert.ok(Math.abs(w16.terms.base - (FIT.coef.const + FIT.week[14] + FIT.coef.logl0 * Math.log(w16.lambda0))) < 1e-12);
});

test('A3 self-excitation: same total adds, recent ones raise the rate', () => {
  const pts = [100, 100, 100, 100], opp = [90, 90, 90, 90];
  const teams = [T('early', [4, 0, 0, 0], pts, opp), T('late', [0, 0, 0, 4], pts, opp), T('x', [1, 1, 1, 1], pts, opp)];
  const r = leagueActivityIntensity(teams, 5);
  assert.equal(r.get('early').lambda0, r.get('late').lambda0);
  assert.ok(r.get('late').lambda > r.get('early').lambda);
  assert.ok(r.get('late').inputs.exc > 0 && r.get('early').inputs.exc < 0);
});

test('A4 dead and empty starters last week lower the rate', () => {
  const pts = [100, 100, 100], opp = [90, 90, 90];
  const teams = [T('ok', [1, 1, 1], pts, opp, [0, 0, 0], [0, 0, 0]), T('dead', [1, 1, 1], pts, opp, [0, 0, 2], [0, 0, 0]),
    T('empty', [1, 1, 1], pts, opp, [0, 0, 0], [0, 0, 5])];
  const r = leagueActivityIntensity(teams, 4);
  assert.ok(r.get('dead').lambda < r.get('ok').lambda);
  assert.ok(r.get('empty').lambda < r.get('ok').lambda);
  assert.equal(r.get('empty').inputs.empty1, FIT.cap_slots);
  const mean = [...r.values()].reduce((a, x) => a + x.vs_league, 0) / 3;
  assert.ok(Math.abs(mean - 1) < 1e-12);
});

test('A5 too little history or an adds gap: null with the reason', () => {
  const one = leagueActivityIntensity([T('1', [2], [100], [90])], 2).get('1');
  assert.equal(one.lambda, null);
  assert.match(one.reason, /2 completed weeks.*1 so far/);
  const gap = leagueActivityIntensity([T('1', [2, null], [100, 90], [90, 100])], 3).get('1');
  assert.equal(gap.lambda, null);
  assert.match(gap.reason, /adds are not known/);
});

test('A6 missing results and lineup inputs zero their terms and are named', () => {
  const r = leagueActivityIntensity([T('1', [1, 2], [null, null], [null, null], [null, null], [null, null])], 3).get('1');
  assert.ok(Number.isFinite(r.lambda));
  for (const k of ['lost1', 'streak2', 'margin1', 'dead1', 'empty1', 'wp']) assert.equal(Math.abs(r.terms[k]), 0);
  assert.deepEqual(r.missing.sort(),
    ['dead_starts_last_week', 'empty_starts_last_week', 'last_week_result', 'win_pct_weeks'].sort());
});

test('A7 baseline and log-likelihood helpers', () => {
  const b = leagueBaselineRate([T('1', [2, 2], [], []), T('2', [0, 0], [], [])], 3);
  assert.equal(b.get('1'), (4 + 2 * 1) / 4);
  assert.ok(Math.abs(poissonLogLik(3, 2) - (3 * Math.log(2) - 2 - Math.log(6))) < 1e-12);
});

// ------------------------------------------------------------- wiring: the build
const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);
const signals = await import('../server/services/manager-signals.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026;
const team = id => ({ id, name: `Team ${id}`, owners: [`{M${id}}`], roster: { entries: [] } });
const game = (w, h, hp, a, ap) => ({ matchupPeriodId: w, winner: hp > ap ? 'HOME' : 'AWAY',
  home: { teamId: h, totalPoints: hp }, away: { teamId: a, totalPoints: ap } });
run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, connection_status)
     VALUES (71, 'espn', 'espn-ai-71', ?, 'AI71', ?, 4, '1', 'connected')`, SEASON,
JSON.stringify({ seasonId: SEASON, scoringPeriodId: 4, teams: [1, 2, 3, 4].map(team),
  settings: { rosterSettings: { lineupSlotCounts: { 0: 1, 2: 1, 20: 5, 21: 1 } } },
  schedule: [game(1, 1, 110, 2, 90), game(1, 3, 100, 4, 95), game(2, 1, 80, 3, 120), game(2, 2, 100, 4, 99),
    game(3, 1, 105, 4, 100), game(3, 2, 90, 3, 91), game(4, 1, 0, 2, 0)] }));
let txn = 0;
const add = (teamId, period) => run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status,
  execution_type, team_id, scoring_period, items_json, first_seen_at, last_seen_at)
  VALUES (71, ?, ?, 'FREEAGENT', 'EXECUTED', 'PROCESS', ?, ?, ?, 'x', 'x')`, SEASON, `ai-${++txn}`, teamId, period,
JSON.stringify([{ type: 'ADD', fromTeamId: 0, toTeamId: teamId, playerId: 9000 + txn }]));
add(1, 1); add(1, 3); add(1, 3); add(2, 1); add(2, 1); add(2, 1); add(3, 2); add(4, 4);

const intensityRows = () => signals.signalRowsFor(71).filter(r => /intensity|p_add_next/.test(r.metric));

test('B1 flag off: no intensity rows (the build is unchanged)', () => {
  delete process.env.GRIDIRON_ACTIVITY_INTENSITY; delete process.env[PREVIEW_ENV];
  signals.buildManagerSignals(71, { chat: null });
  assert.equal(intensityRows().length, 0);
});

test('B2 flag on: every manager gets the three rows, from weeks 1..3 only', () => {
  process.env.GRIDIRON_ACTIVITY_INTENSITY = '1';
  try {
    signals.buildManagerSignals(71, { chat: null });
    const got = intensityRows();
    assert.equal(got.length, 12);
    const by = Object.groupBy(got, r => r.roster_id);
    for (const id of ['1', '2', '3', '4']) {
      const m = Object.fromEntries(by[id].map(r => [r.metric, r]));
      assert.ok(m.tx_adds_intensity.value > 0 && m.tx_p_add_next_week.value < 1);
      assert.equal(m.tx_adds_intensity.n, 3);
      assert.equal(m.tx_adds_intensity.priceable, true);
    }
    // Teams 1 and 2 both added 3 (the same season-to-date rate). Team 1's came last
    // week, team 2's in week 1, so team 1 is the more active now: the self-excitation.
    const lam = id => by[id].find(r => r.metric === 'tx_adds_intensity').value;
    assert.ok(lam('1') > lam('2'));
    // The served value is the module's, on weeks 1..3 only: the week-4 add is in
    // the week being predicted and is not an input.
    const teams = [
      { roster_id: '1', adds: [1, 0, 2], points: [110, 80, 105], opp_points: [90, 120, 100] },
      { roster_id: '2', adds: [3, 0, 0], points: [90, 100, 90], opp_points: [110, 99, 91] },
      { roster_id: '3', adds: [0, 1, 0], points: [100, 120, 91], opp_points: [95, 80, 90] },
      { roster_id: '4', adds: [0, 0, 0], points: [95, 99, 100], opp_points: [100, 100, 105] },
    ].map(t => ({ ...t, dead: [null, null, null], empty: [null, null, null] }));
    const direct = leagueActivityIntensity(teams, 4);
    for (const id of ['1', '2', '3', '4']) assert.equal(lam(id), +direct.get(id).lambda.toFixed(4));
    assert.equal(direct.get('4').lambda0, (0 + 2 * (7 / 12)) / 5);
  } finally { delete process.env.GRIDIRON_ACTIVITY_INTENSITY; }
});

test('B3 preview mode turns it on too', () => {
  process.env[PREVIEW_ENV] = '1';
  try {
    signals.buildManagerSignals(71, { chat: null });
    assert.equal(intensityRows().length, 12);
  } finally { delete process.env[PREVIEW_ENV]; }
  signals.buildManagerSignals(71, { chat: null });
  assert.equal(intensityRows().length, 0);
});

test('C1 the P(responds) activity term reads the intensity when the league has one', async () => {
  const { activityFactor, ACTIVITY_MIN_WEEKS } = await import('../server/services/counterparty-pricing.js');
  const samples = { tx_adds_per_week: ACTIVITY_MIN_WEEKS };
  const metrics = { tx_adds_per_week: 2, tx_adds_intensity: 3, tx_completed_trades: 0 };
  const flatMean = { adds: 1, traded: 0, intensity: null };
  const bothMean = { adds: 1, traded: 0, intensity: 2 };
  const flat = activityFactor({ ...metrics, tx_adds_intensity: undefined }, samples, flatMean);
  const withI = activityFactor(metrics, samples, bothMean);
  // Same centred distance (+1 add) either way, so the same effect: the intensity only swaps the input.
  assert.equal(withI.effect, flat.effect);
  assert.match(withI.why, /expected next week/);
  assert.doesNotMatch(flat.why, /expected next week/);
  // A league without intensity for every manager keeps the constant rate.
  const partial = activityFactor(metrics, samples, flatMean);
  assert.equal(partial.effect, flat.effect);
  assert.doesNotMatch(partial.why, /expected next week/);
  // Higher intensity at the same flat rate raises the term.
  const hot = activityFactor({ ...metrics, tx_adds_intensity: 4 }, samples, bothMean);
  assert.ok(hot.effect > withI.effect);
});
