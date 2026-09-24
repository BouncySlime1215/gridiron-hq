/**
 * AVAIL-HORIZON: chance to play past the live week comes from the fitted
 * return-to-play curve (availability-return.js), not the frozen one-week rate.
 *
 * TITLE-ZERO (BROKEN-NUMBERS row S): weeklyAvailability's role state only sees games
 * already played, so a starter who missed last week was priced 0.40 for every remaining
 * week. With GRIDIRON_AVAIL_HORIZON (or preview mode) on, a week h >= 1 past the live
 * anchor reads the curve; the live week and every replay (h = 0) are untouched, and with
 * the flag off nothing changes at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-avail-horizon-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const C = await import('../server/services/contingency.js');
const R = await import('../server/services/availability-return.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** Run fn with env vars set (null = unset), restoring them after. */
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    C.resetAvailabilityCache();
  }
}
const OFF = { [R.AVAIL_HORIZON_ENV]: null, [PREVIEW_ENV]: null };
const ON = { [R.AVAIL_HORIZON_ENV]: '1', [PREVIEW_ENV]: null };
const PREVIEW = { [R.AVAIL_HORIZON_ENV]: null, [PREVIEW_ENV]: '1' };

/* ------------------------------------------------------------------ pure parts */

test('horizon buckets', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 16].map(R.horizonBucket),
    [null, 'h1', 'h2', 'h3', 'h4', 'h5-6', 'h5-6', 'h7-9', 'h7-9', 'h10+', 'h10+']);
  assert.equal(R.horizonBucket(1.5), null);
});

test('fitReturnCurve shrinks h -> h|gap -> h|gap|tier and the lookup falls back to the deepest cell', () => {
  const obs = [
    ...Array.from({ length: 10 }, (_, i) => ({ h: 2, gap: 'g1', tier: 'starter', active: i < 6 ? 1 : 0 })),
    ...Array.from({ length: 10 }, (_, i) => ({ h: 2, gap: 'g0', tier: 'depth', active: i < 8 ? 1 : 0 })),
    { h: 0, gap: 'g0', tier: 'starter', active: 1 } // h 0 is the one-week model's job: ignored
  ];
  const fit = R.fitReturnCurve(obs, { k: 10 });
  const cell = (h, gap, tier) => fit.find(r => r.h === h && r.gap === gap && r.tier === tier);
  assert.equal(cell('h2', '*', '*').p_active, 0.7);
  assert.equal(cell('h2', 'g1', '*').p_active, +((6 + 10 * 0.7) / 20).toFixed(4));
  const g1 = (6 + 10 * 0.7) / 20;
  assert.equal(cell('h2', 'g1', 'starter').p_active, +((6 + 10 * g1) / 20).toFixed(4));
  assert.equal(fit.reduce((s, r) => s + (r.gap === '*' ? r.n : 0), 0), 20, 'h 0 row not counted');
  const lk = R.buildReturnLookup(fit);
  assert.equal(lk.lookup({ h: 2, gap: 'g1', tier: 'starter' }).basis, 'h2/g1/starter');
  assert.equal(lk.lookup({ h: 2, gap: 'g1', tier: 'fringe' }).basis, 'h2/g1', 'unfitted tier -> gap cell');
  assert.equal(lk.lookup({ h: 2, gap: 'g2', tier: 'starter' }).basis, 'h2', 'unfitted gap -> horizon root');
  assert.equal(lk.lookup({ h: 3, gap: 'g1', tier: 'starter' }), null, 'unfitted horizon -> null');
  assert.equal(lk.lookup({ h: 0, gap: 'g1', tier: 'starter' }), null);
});

test('the served curve covers every horizon for g0/g1/g2 and a missed-one starter heals with distance', () => {
  const lk = R.servedReturnCurve();
  for (const h of [1, 2, 3, 4, 5, 7, 10]) for (const gap of ['g0', 'g1', 'g2']) {
    assert.ok(lk.lookup({ h, gap, tier: 'starter' })?.basis.endsWith('starter'), `h${h} ${gap} starter fitted`);
  }
  const g1 = h => lk.lookup({ h, gap: 'g1', tier: 'starter' }).p;
  assert.ok(g1(5) > g1(1), 'further out, a starter who missed one game is more likely back');
  assert.deepEqual(R.RETURN_CURVE_FIT.fitSeasons, [2021, 2022, 2023, 2024], 'never fit on the 2025 holdout');
});

test('flag: unset off, 1 on, preview on (labelled), 0 vetoes preview', () => {
  withEnv(OFF, () => assert.deepEqual(R.availHorizonFlag(), { on: false, preview: false }));
  withEnv(ON, () => assert.deepEqual(R.availHorizonFlag(), { on: true, preview: false }));
  withEnv(PREVIEW, () => assert.deepEqual(R.availHorizonFlag(), { on: true, preview: true }));
  withEnv({ [R.AVAIL_HORIZON_ENV]: '0', [PREVIEW_ENV]: '1' }, () =>
    assert.deepEqual(R.availHorizonFlag(), { on: false, preview: false }));
});

/* ------------------------------------------------ fixture: 2026 weeks 1-2 on file */

const appear = (id, season, week, team, pct) => {
  run(`INSERT INTO player_week_usage (player_id, season, week, team, position, targets, carries, attempts)
       VALUES (?,?,?,?,'WR',5,0,0)`, id, season, week, team);
  run('INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (?,?,?,?,?)',
    id, season, week, Math.round(pct * 65), pct);
};
for (const [id, name] of [[931, 'Horizon Healthy'], [932, 'Horizon MissedOne']]) {
  run('INSERT INTO players (id, name, position, gsis_id) VALUES (?,?,?,?)', id, name, 'WR', `hz-${id}`);
}
appear(931, 2026, 1, 'AAA', 0.9); appear(931, 2026, 2, 'AAA', 0.9);
appear(932, 2026, 1, 'AAA', 0.9); // missed week 2: gap 1

db.exec(C.AVAILABILITY_RATES_DDL);
db.exec(C.AVAILABILITY_ROLE_RATES_DDL);
const config = JSON.stringify({ k: 5, byPosition: false, durabilityCap: false });
for (const [tier, gap, p] of [['*', '*', 0.70], ['starter', '*', 0.90], ['starter', 'g0', 0.953], ['starter', 'g1', 0.403]]) {
  run(`INSERT INTO nfl_availability_role_rates
       (report_status,practice_status,position,tier,gap,p_active,n,raw_rate,config,fitted_at)
       VALUES ('noreport','none','*',?,?,?,100,?,?,'2026-09-24T00:00:00Z')`, tier, gap, p, p, config);
}
C.resetAvailabilityCache();

test('weeksAhead: 0 on the live week and on any replayed week, else weeks past the anchor', () => {
  assert.equal(C.weeksAhead(2026, 3), 0, 'live week: games through 2 on file');
  assert.equal(C.weeksAhead(2026, 4), 1);
  assert.equal(C.weeksAhead(2026, 12), 9);
  assert.equal(C.weeksAhead(2026, 2), 0, 'replay: week 1 on file before week 2');
  assert.equal(C.weeksAhead(2027, 1), 0, 'preseason: anchor is week 1');
  assert.equal(C.weeksAhead(2027, 5), 4);
});

test('flag off: every future week keeps the frozen one-week rate (the incumbent, pinned)', () => withEnv(OFF, () => {
  for (const wk of [3, 4, 8, 16]) {
    const a = C.weeklyAvailability(2026, wk);
    assert.equal(a.get(932).active_probability, 0.403, `week ${wk}`);
    assert.equal(a.get(931).active_probability, 0.953, `week ${wk}`);
    assert.equal(a.get(932).horizon, undefined);
  }
}));

test('flag on: the live week is unchanged, later weeks read the curve with its label', () => withEnv(ON, () => {
  const live = C.weeklyAvailability(2026, 3);
  assert.equal(live.get(932).active_probability, 0.403, 'h 0: the one-week fit still prices the live week');
  assert.equal(live.get(932).horizon, undefined);
  const lk = R.servedReturnCurve();
  for (const wk of [4, 8, 16]) {
    const row = C.weeklyAvailability(2026, wk).get(932);
    const want = lk.lookup({ h: wk - 3, gap: 'g1', tier: 'starter' });
    assert.equal(row.active_probability, +want.p.toFixed(3), `week ${wk}`);
    assert.deepEqual(row.horizon, { weeks_ahead: wk - 3, basis: want.basis });
    assert.equal(row.availability_basis, 'role');
    assert.match(row.source, /return-to-play curve/);
    assert.equal(row.preview, undefined, 'explicitly on: not a preview');
  }
  assert.ok(C.weeklyAvailability(2026, 8).get(932).active_probability > 0.403, 'the missed-one starter heals');
}));

test('preview mode turns it on and labels the row', () => withEnv(PREVIEW, () => {
  const row = C.weeklyAvailability(2026, 8).get(932);
  assert.equal(row.preview, true);
  assert.equal(row.preview_reason, R.AVAIL_HORIZON_PREVIEW_REASON);
}));

test('a replayed week is never re-priced, flag on or off', () => {
  const off = withEnv(OFF, () => C.weeklyAvailability(2026, 2).get(932).active_probability);
  const on = withEnv(ON, () => C.weeklyAvailability(2026, 2).get(932).active_probability);
  assert.equal(on, off);
});
