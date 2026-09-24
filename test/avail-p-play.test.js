/**
 * BROKEN-E: one avail.p_play with a typed "unknown" (server/services/avail-p-play.js).
 *
 * BROKEN-NUMBERS row E: chance to play is read per caller and a missing number
 * is filled with `?? 0.92` at trade-engine.js:387, trade-engine.js:3198 and
 * season-sim.js:359 (now :385 on main). A player the engine knows nothing about
 * (no games on file, no injury-report line, no fitted role cell) is served 0.92
 * as if it were a reading.
 *
 * Pinned here:
 *   1. the typed reasons (no_row, no_number, no_games_no_report) and that a
 *      measured or reported player stays `ok`;
 *   2. an unknown player's p_play is null, and the number a simulation uses is
 *      a labelled prior: the fitted role table, else a fitted population mean,
 *      else the constant labelled fitted: false;
 *   3. one entry point: availPPlayWeek reads the same rows every caller would;
 *   4. default off (own flag, or preview mode with preview: true);
 *   5. trade-engine's asset, flag on: status 'unknown', priced at the fitted
 *      prior instead of 0.92, and byte-identical with the flag off;
 *   6. at the three row-E sites the `?? 0.92` is reachable only with the flag off.
 *
 * player-week-engine.js is mocked as in test/asset-universe-bye-week-range.test.js:
 * the projection is not what is under test, the chance to play applied to it is.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-avail-p-play-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '2';
delete process.env.GRIDIRON_AVAIL_P_PLAY;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const wrParams = targets => ({
  position: 'WR', attempts: 0, carries: 0, targets, dispersion: 10,
  ypa: 7, pass_td_rate: 0.045, int_rate: 0.025, ypc: 4.2, rush_td_rate: 0.03,
  catch_rate: 0.68, ypt: 8, rec_td_rate: 0.05
});
const WEEK_PROJECTION = { ppg: 20, params: wrParams(8), ensemble_shift: 0, volume: { target_share: 0.2 } };
const realWeekEngine = await import('../server/services/player-week-engine.js');
mock.module('../server/services/player-week-engine.js', {
  namedExports: {
    ...realWeekEngine,
    buildPlayerWeekEngine: () => new Map([[902, { ...WEEK_PROJECTION }]]),
    playerWeekDistribution: () => ({ p10: 8, p90: 32, mean: 20, boom_rate: 0.2, bust_rate: 0.1 })
  }
});

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { weeklyAvailability, buildAvailabilityLookup, AVAILABILITY_ROLE_RATES_DDL } =
  await import('../server/services/contingency.js');
const { DEFAULT_ACTIVE_PROBABILITY } = await import('../server/services/availability-basis.js');
const pp = await import('../server/services/avail-p-play.js');
const { assetUniverse } = await import('../server/services/trade-engine.js');
const { deriveFormat } = await import('../server/services/format.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

/* ------------------------------------------------------------------ fixture */

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
     (1, 'AAA', 'Alpha', 'AFC', 'East'), (2, 'BBB', 'Beta', 'NFC', 'West')`);
for (let w = 1; w <= 14; w++) {
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 1, ?, 'BBB', 1)`, w);
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 2, ?, 'AAA', 0)`, w);
}
const player = (id, name, position, gsis, team = 2) =>
  run('INSERT INTO players (id, name, position, gsis_id, team_id) VALUES (?,?,?,?,?)', id, name, position, gsis, team);
const usage = (id, season, week) =>
  run(`INSERT INTO player_week_usage (player_id, season, week, team, position, targets, carries, attempts)
       VALUES (?,?,?,'BBB','WR',5,0,0)`, id, season, week);

// 101: measured veteran. 102: never seen, no report (the row-E case).
// 103: never seen but on this week's report. 104: a kicker, outside the fit.
// 902: the trade-engine asset under test, also never seen.
player(101, 'Measured Veteran', 'WR', 'meas-vet');
player(102, 'Unseen Rookie', 'WR', 'unseen-rk');
player(103, 'Listed Rookie', 'WR', 'listed-rk');
player(104, 'Kicker', 'K', 'kick-1');
player(902, 'Asset Rookie', 'WR', 'asset-rk');
for (const season of [2023, 2024, 2025]) for (let week = 1; week <= 16; week++) usage(101, season, week);
run(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status, practice_status, injury)
     VALUES (2026, 2, 'listed-rk', 'BBB', 'Listed Rookie', 'WR', 'Questionable', 'Limited', 'Ankle')`);

// 25 more measured, unlisted WRs, so the population prior has something to fit.
for (let i = 0; i < 25; i++) {
  player(200 + i, `Measured ${i}`, 'WR', `meas-${i}`);
  for (const season of [2024, 2025]) for (let week = 1; week <= 10 + (i % 7); week++) usage(200 + i, season, week);
}

const WEEK = () => weeklyAvailability(2026, 2, { through: 2025, espn: false });

/* ------------------------------------------------------------ 1. typed reasons */

test('typed reasons: no_row, no_number, no_games_no_report; measured and reported rows stay ok', () => {
  const rows = WEEK();
  assert.equal(pp.unknownReason(rows.get(101)), null, 'three seasons on file: measured');
  assert.equal(pp.unknownReason(rows.get(102)), 'no_games_no_report');
  assert.equal(pp.unknownReason(rows.get(103)), null, 'a report line is information: priced by the curve, not unknown');
  assert.equal(rows.get(104), undefined, 'control: a kicker has no availability row');
  assert.equal(pp.unknownReason(rows.get(104)), 'no_row');
  assert.equal(pp.unknownReason({ ...rows.get(101), active_probability: undefined }), 'no_number');
  assert.equal(pp.unknownReason({ ...rows.get(101), active_probability: NaN }), 'no_number');
});

test('control: the row-E default is what the old path serves the unseen rookie', () => {
  assert.equal(WEEK().get(102).active_probability, DEFAULT_ACTIVE_PROBABILITY);
});

/* ------------------------------------------------------ 2. labelled, fitted prior */

test('an unknown player has p_play null and is priced at a labelled, fitted prior', () => {
  const rows = WEEK();
  const prior = pp.fittedUnknownPrior({ position: 'WR', rows, fitted: null });
  assert.equal(prior.fitted, true);
  assert.ok(prior.n >= pp.MIN_PRIOR_N, `fitted on ${prior.n} measured WRs`);
  assert.match(prior.source, /mean of \d+ measured unlisted WR/);
  const measured = [...rows.values()].filter(r => r.durability_prior_measured && r.report_status == null && r.position === 'WR');
  const mean = measured.reduce((s, r) => s + r.active_probability, 0) / measured.length;
  assert.equal(prior.value, +mean.toFixed(3));
  assert.notEqual(prior.value, DEFAULT_ACTIVE_PROBABILITY, 'the fixture is built so the fit differs from 0.92');

  const out = pp.pPlay(rows.get(102), prior);
  assert.deepEqual({ status: out.status, p_play: out.p_play, reason: out.reason, basis: out.basis },
    { status: 'unknown', p_play: null, reason: 'no_games_no_report', basis: 'default_durability' });
  assert.equal(out.value, prior.value);
  assert.equal(out.prior, prior);

  const ok = pp.pPlay(rows.get(101), prior);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.p_play, rows.get(101).active_probability);
  assert.equal(ok.value, ok.p_play);
});

test('the fitted role table wins over the population mean when it is loaded', () => {
  const fitted = buildAvailabilityLookup({ roleRates: [
    { report_status: 'noreport', practice_status: '*', position: '*', tier: '*', gap: '*', p_active: 0.81, n: 5000, config: '{}' }
  ] });
  const prior = pp.fittedUnknownPrior({ position: 'WR', rows: WEEK(), fitted });
  assert.deepEqual({ value: prior.value, fitted: prior.fitted, n: prior.n }, { value: 0.81, fitted: true, n: 5000 });
  assert.match(prior.source, /role fit, no report/);
});

test('with nothing to fit, the prior is the constant and says so (fitted: false), never silent', () => {
  const rows = new Map([[102, WEEK().get(102)]]);
  const prior = pp.fittedUnknownPrior({ position: 'WR', rows, fitted: null });
  assert.deepEqual({ value: prior.value, fitted: prior.fitted, n: prior.n }, { value: DEFAULT_ACTIVE_PROBABILITY, fitted: false, n: 0 });
  assert.match(prior.source, /standing constant/);
});

test('consumer arms: no row is unfitted_position; a row with no number is unvouched or unrecognised', () => {
  const prior = { value: 0.8, fitted: true, n: 30, source: 'x' };
  assert.equal(pp.pPlay(undefined, prior).basis, 'unfitted_position');
  assert.equal(pp.pPlay({ availability_basis: 'pooled' }, prior).basis, 'unvouched');
  assert.equal(pp.pPlay({}, prior).basis, 'unrecognised');
});

/* ---------------------------------------------------------- 3. one entry point */

test('availPPlayWeek reads the same rows weeklyAvailability serves every caller', () => {
  const week = pp.availPPlayWeek(2026, 2);
  assert.deepEqual(week.rows, weeklyAvailability(2026, 2, { through: 2025 }));
  assert.equal(week.of(102, 'WR').status, 'unknown');
  assert.equal(week.of(101, 'WR').status, 'ok');
  assert.equal(week.of(104, 'K').reason, 'no_row');
});

/* --------------------------------------------------------------------- 4. flag */

test('default off; own flag on without preview; preview mode on with preview: true', () => {
  withEnv({ GRIDIRON_AVAIL_P_PLAY: null, GRIDIRON_PREVIEW_UNCONFIRMED: null }, () =>
    assert.deepEqual(pp.availPPlayMode(), { on: false, preview: false }));
  withEnv({ GRIDIRON_AVAIL_P_PLAY: '1', GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () =>
    assert.deepEqual(pp.availPPlayMode(), { on: true, preview: false }));
  withEnv({ GRIDIRON_AVAIL_P_PLAY: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => {
    assert.deepEqual(pp.availPPlayMode(), { on: true, preview: true });
    const out = pp.availPPlayWeek(2026, 2, { preview: true }).of(102, 'WR');
    assert.equal(out.preview, true);
    assert.equal(out.preview_reason, pp.AVAIL_P_PLAY_OFF_REASON);
  });
});

/* ----------------------------------------------------- 5. trade-engine's asset */

const lg = () => ({ id: 1, team_count: 10, ppr: 1, best_ball: 0, league_type: null, payload: null });
const asset = () => assetUniverse(lg(), deriveFormat(lg()).formatKey).get(902);

test('trade-engine asset, flag off: unchanged, 0.92 and no p_play field', () => {
  const a = withEnv({ GRIDIRON_AVAIL_P_PLAY: null, GRIDIRON_PREVIEW_UNCONFIRMED: null }, asset);
  assert.equal(a.active_probability, DEFAULT_ACTIVE_PROBABILITY);
  assert.equal('p_play' in a, false);
  assert.equal(a.current_week_ppg, +(20 * DEFAULT_ACTIVE_PROBABILITY).toFixed(2));
});

test('trade-engine asset, flag on: typed unknown, priced at the fitted prior, not 0.92', () => {
  const a = withEnv({ GRIDIRON_AVAIL_P_PLAY: '1' }, asset);
  const prior = pp.fittedUnknownPrior({ position: 'WR', rows: WEEK(), fitted: null });
  assert.equal(a.p_play.status, 'unknown');
  assert.equal(a.p_play.p_play, null);
  assert.equal(a.p_play.reason, 'no_games_no_report');
  assert.equal(a.p_play.prior.fitted, true);
  assert.equal(a.active_probability, prior.value);
  assert.equal(a.current_week_ppg, +(20 * prior.value).toFixed(2));
  assert.equal('value' in a.p_play, false, 'the served JSON carries the prior, not an unlabelled number');
});

/* ------------------------------------ 6. the row-E sites reach 0.92 only with the flag off */

// FIX-285-1: the default itself now lives only in contingency.js#legacyActiveProbability
// (test/avail-p-play-sites.test.js ratchets that); each site reaches it only flag-off.
test('at every row-E site the old default sits behind the avail.p_play branch', () => {
  const sites = [
    ['server/services/trade-engine.js', /legacyActiveProbability\(availability\)/, /pPlayed \?/],
    ['server/services/trade-engine.js', /legacyActiveProbability\(x\.in\)/, /x\.in\.p_play \?/],
    ['server/services/season-sim.js', /legacyActiveProbability\(activeChance\.get\(p\.id\)\)/, /pPlayed \?/]
  ];
  for (const [file, re, guard] of sites) {
    const lines = fs.readFileSync(path.join(REPO, file), 'utf8').split('\n').filter(l => re.test(l));
    assert.equal(lines.length, 1, `${file}: expected exactly one ${re} site, found ${lines.length}`);
    assert.match(lines[0], guard, `${file}: the default must be the flag-off arm only: ${lines[0].trim()}`);
  }
});
