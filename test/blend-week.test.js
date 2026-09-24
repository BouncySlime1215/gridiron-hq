/**
 * BROKEN-G: three "this week" numbers become one (`blend.week`).
 *
 * Before (origin/main 21c9da4), for one player in one week:
 *   - the trade card's horizon adj_ppg = 0.25 x current_week_ppg + 0.75 x ros_ppg
 *     (trade-engine.js:432), and lineupSpan's this-week leg (:1482), read the
 *     UNLIFTED current_week_ppg (:507);
 *   - Start/Sit (lineup-brain.js:357-365) and the League Hub lineup card
 *     (trade-engine.js#lineupDiffWeekPoints) re-derive current_week_ppg x the full
 *     betting-line lift on their own calls.
 * With GRIDIRON_BLEND_WEEK=1 all three read the asset's `blend_week`.
 *
 * S-03 (#166) switched the betting-line lift off inside waiver-brain.js#vegasLift, and
 * blend.week reads that switch (FIX-166-3), so in this fixture the line exists (the
 * game-script model reads pass 1.2) but no page adds it: the lift-on assertions #291
 * was written with now pin the switch instead.
 *
 * player-week-engine.js is mocked for a fixed projection (as in
 * asset-universe-bye-week-range.test.js); gamescript.js#gameScriptFor is mocked so
 * team BBB has a real lift (pass 1.2) without fitting a game-script model.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-blend-week-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '6';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_BLEND_WEEK;

const wrParams = targets => ({
  position: 'WR', attempts: 0, carries: 0, targets, dispersion: 10,
  ypa: 7, pass_td_rate: 0.045, int_rate: 0.025, ypc: 4.2, rush_td_rate: 0.03,
  catch_rate: 0.68, ypt: 8, rec_td_rate: 0.05
});
const realWeekEngine = await import('../server/services/player-week-engine.js');
mock.module('../server/services/player-week-engine.js', {
  namedExports: {
    ...realWeekEngine,
    buildPlayerWeekEngine: () => new Map([
      [901, { ppg: 20, params: wrParams(8), ensemble_shift: 0, volume: { target_share: 0.2 } }],
      [902, { ppg: 20, params: wrParams(8), ensemble_shift: 0, volume: { target_share: 0.2 } }]
    ]),
    playerWeekDistribution: () => ({ p10: 8, p90: 32, mean: 20, boom_rate: 0.2, bust_rate: 0.1 })
  }
});
const PASS_MULT = 1.2;
const passMult = PASS_MULT;
const realGameScript = await import('../server/services/gamescript.js');
mock.module('../server/services/gamescript.js', {
  namedExports: {
    ...realGameScript,
    gameScriptFor: team => (team === 'BBB'
      ? { pass_mult: passMult, rush_mult: 1.1, line: { spread: -7, total: 51 } }
      : { pass_mult: 1, rush_mult: 1, line: null })
  }
});

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { assetUniverse, lineupSpan, lineupDiffWeekPoints } = await import('../server/services/trade-engine.js');
const { startSitWeekPoints } = await import('../server/services/lineup-brain.js');
const { horizonAnnotate, horizonValue, gameScriptLift, BETTING_LINE_LIFT } = await import('../server/services/waiver-brain.js');
const { deriveFormat } = await import('../server/services/format.js');
const { blendWeek, blendWeekFlag, BLEND_WEEK_ENV } = await import('../server/services/blend-week.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
     (1, 'AAA', 'Alpha', 'AFC', 'East'), (2, 'BBB', 'Beta', 'NFC', 'West')`);
for (let w = 1; w <= 14; w++) {
  if (w !== 6) run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 1, ?, 'BBB', 1)`, w);
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 2, ?, 'AAA', 0)`, w);
}
run(`INSERT INTO players (id, name, position, team_id) VALUES (901, 'Bye Guy', 'WR', 1)`);
run(`INSERT INTO players (id, name, position, team_id) VALUES (902, 'Lifted Guy', 'WR', 2)`);

const lg = { id: 1, team_count: 10, ppr: 1, best_ball: 0, league_type: null, payload: null };
const universe = () => assetUniverse(lg, deriveFormat(lg).formatKey);
const r2 = n => Math.round(n * 100) / 100;

function withFlag(value, fn) {
  const saved = process.env[BLEND_WEEK_ENV];
  if (value == null) delete process.env[BLEND_WEEK_ENV]; else process.env[BLEND_WEEK_ENV] = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[BLEND_WEEK_ENV]; else process.env[BLEND_WEEK_ENV] = saved;
  }
}

/** The three this-week numbers the three pages use for one asset. */
function threeNumbers(a) {
  return {
    start_sit: startSitWeekPoints(a, 2026, 6).week_points,
    lineup_card: lineupDiffWeekPoints(a, 2026, 6),
    // lineupSpan with one week left is exactly the card's this-week leg (it rounds to 0.1).
    trade_card_week: lineupSpan([], [a], ['WR'], 1),
    trade_card_horizon_week: r2((a.adj_ppg - 0.75 * a.ros_ppg) / 0.25)
  };
}

test('flag: 1 on, 0 off, unset follows preview mode', () => {
  const savedPreview = process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  try {
    delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
    withFlag(null, () => assert.deepEqual(blendWeekFlag(), { on: false, preview: false }));
    withFlag('1', () => assert.deepEqual(blendWeekFlag(), { on: true, preview: false }));
    process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
    withFlag(null, () => assert.deepEqual(blendWeekFlag(), { on: true, preview: true }));
    withFlag('0', () => assert.deepEqual(blendWeekFlag(), { on: false, preview: false }), 'explicit 0 vetoes preview');
  } finally {
    if (savedPreview === undefined) delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
    else process.env.GRIDIRON_PREVIEW_UNCONFIRMED = savedPreview;
  }
});

test('blendWeek: no week number is null, a bye is 0 with no line read', () => {
  let calls = 0;
  const lift = () => { calls++; return { multiplier: 2, applied: true }; };
  assert.equal(blendWeek({ current_week_ppg: null }, 2026, 6, { lift }), null);
  assert.equal(blendWeek({ current_week_ppg: 0 }, 2026, 6, { lift }).value, 0);
  assert.equal(calls, 0);
  assert.equal(blendWeek({ current_week_ppg: 10.11 }, 2026, 6, { lift }).value, 20.22);
});

test('control (flag off): the fixture has a real line, and with S-03\'s switch off no page lifts it', () => {
  withFlag('0', () => {
    const a = universe().get(902);
    assert.equal(a.blend_week, undefined, 'flag off: no blend_week on the asset');
    assert.equal(gameScriptLift(a, 2026, 6).multiplier, PASS_MULT, 'the game-script model still reads the line');
    assert.equal(BETTING_LINE_LIFT.on, false, 'S-03: the lift is switched off in vegasLift');
    const n = threeNumbers(a);
    assert.ok(a.current_week_ppg > 0);
    assert.equal(n.start_sit, a.current_week_ppg, 'Start/Sit applies no lift');
    assert.equal(n.lineup_card, n.start_sit);
    assert.equal(n.trade_card_week, +a.current_week_ppg.toFixed(1));
    assert.ok(Math.abs(n.trade_card_horizon_week - a.current_week_ppg) < 0.05);
  });
});

test('flag on: Start/Sit, the lineup card and the trade card read one blend.week, which reads the switch (FIX-166-3)', () => {
  withFlag('1', () => {
    const assets = universe();
    const a = assets.get(902);
    assert.ok(Number.isFinite(a.blend_week), `asset must carry blend_week, got ${a.blend_week}`);
    assert.equal(a.blend_week, a.current_week_ppg, 'the lift switch is off: blend.week does not re-apply the line');
    assert.equal(a.blend_week_vegas.applied, false);
    const n = threeNumbers(a);
    assert.equal(n.start_sit, a.blend_week);
    assert.equal(n.lineup_card, a.blend_week);
    assert.equal(n.trade_card_week, +a.blend_week.toFixed(1));
    assert.ok(Math.abs(n.trade_card_horizon_week - a.blend_week) < 0.05,
      `adj_ppg must be derived from blend_week (${a.blend_week}), implied week ${n.trade_card_horizon_week}`);
    // One week_basis shape: the produced basis on context, with #291's keys beside S-03's label.
    assert.equal(a.week_basis, undefined, 'no per-asset week_basis object');
    assert.equal(assets.context.week_basis.field, 'blend.week');
    assert.equal(assets.context.week_basis.producer, 'blend-week.js#blendWeek');
    assert.equal(assets.context.week_basis.preview, false);
    assert.match(assets.context.week_basis.label, /No betting-line boost/);
  });
  withFlag('0', () => {
    const basis = universe().context.week_basis;
    assert.equal(basis.field, 'current_week_ppg', 'flag off: the basis names the field the pages read');
    assert.equal(basis.producer, 'trade-engine.js#buildAssetUniverse');
  });
});

test('flag on: a bye is 0 on every page and a flag flip rebuilds the cached universe', () => {
  withFlag('1', () => {
    const bye = universe().get(901);
    assert.equal(bye.blend_week, 0);
    const n = threeNumbers(bye);
    assert.deepEqual([n.start_sit, n.lineup_card, n.trade_card_week], [0, 0, 0]);
  });
  withFlag('0', () => assert.equal(universe().get(902).blend_week, undefined, 'flag off after on: rebuilt, not the cached flag-on build'));
});

test('flag on: the pages read the served blend_week, they do not re-derive it on their own call', () => {
  withFlag('1', () => {
    const a = universe().get(902);
    // A served value that differs from any re-derivation: the pages must print it as is.
    const served = { ...a, blend_week: +(a.blend_week + 1.5).toFixed(2) };
    assert.equal(startSitWeekPoints(served, 2026, 6).week_points, served.blend_week, 'Start/Sit re-derived');
    assert.equal(lineupDiffWeekPoints(served, 2026, 6), served.blend_week, 'lineup card re-derived');
    // control: an asset without blend_week (flag off shape) is priced from current_week_ppg
    const { blend_week: _bw, ...offShape } = a;
    assert.equal(startSitWeekPoints(offShape, 2026, 6).week_points, a.current_week_ppg);
  });
});

test('flag on: the waiver upgrade horizon is the plain horizon, with no lift on top of blend.week', () => {
  withFlag('1', () => {
    const a = universe().get(902);
    const ann = horizonAnnotate(a, 2026, 6);
    assert.equal(ann.horizon_ppg, horizonValue(a, 6));
    assert.equal(ann.vegas, null, 'the switch is off: no lift is reported as applied');
  });
  withFlag('0', () => {
    const a = universe().get(902);
    assert.equal(horizonAnnotate(a, 2026, 6).horizon_ppg, horizonValue(a, 6), 'flag off: the switch keeps the lift out too');
  });
});
