/**
 * GAME-SHOCKS: a shared per-game shock in the season sim's copula (grouped-t).
 *
 * The Gaussian copula (correlation.js) has no tail dependence: two players in one NFL
 * game are almost never extreme together beyond what their pairwise correlation gives.
 * With the shock, every game draws one chi2(nu)/nu mixing variable per run; its players'
 * normals are divided by its square root and read through the t(nu) CDF. Marginals are
 * unchanged; joint extremes inside one game rise; different games stay independent.
 * Pre-registration: docs/tdd/2026-09-25-game-shocks.tdd.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-game-shocks-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const C = await import('../server/services/correlation.js');
const S = await import('../server/services/season-sim.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const { normalCdf } = await import('../server/services/stats-util.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// Pools 0..99: a draw's value IS its percentile index, so uniformity is directly visible.
const POOL = Array.from({ length: 100 }, (_, i) => i);
// Two games: KC-BUF (QB and WR on KC, WR on BUF) and DAL-NYG (one RB each side).
const PLAYERS = [
  { id: 1, position: 'QB', team: 'KC', opponent: 'BUF' },
  { id: 2, position: 'WR', team: 'KC', opponent: 'BUF', target_share: 0.19 },
  { id: 3, position: 'WR', team: 'BUF', opponent: 'KC' },
  { id: 4, position: 'RB', team: 'DAL', opponent: 'NYG' },
  { id: 5, position: 'RB', team: 'NYG', opponent: 'DAL' }
];
const KEYS = PLAYERS.map(p => 1000 + p.id);
const DRAWS = 20000;

function drawAll(sampler) {
  const out = [];
  for (let r = 0; r < DRAWS; r++) out.push(sampler(r));
  return out;
}
/** Share of draws where both players land in their top `k` pool slots. */
const bothTop = (draws, i, j, k = 10) => draws.filter(d => d[i] >= 100 - k && d[j] >= 100 - k).length / draws.length;
const bothBottom = (draws, i, j, k = 10) => draws.filter(d => d[i] < k && d[j] < k).length / draws.length;

test('nu is the pre-registered 6 and only the flag turns the shock on', () => {
  assert.equal(C.GAME_SHOCK_NU, 6);
  withEnv({ [S.GAME_SHOCKS_ENV]: null, [PREVIEW_ENV]: null }, () => assert.deepEqual(S.gameShocksFlag(), { on: false, preview: false }));
  withEnv({ [S.GAME_SHOCKS_ENV]: '1', [PREVIEW_ENV]: null }, () => assert.deepEqual(S.gameShocksFlag(), { on: true, preview: false }));
  withEnv({ [S.GAME_SHOCKS_ENV]: '0', [PREVIEW_ENV]: '1' }, () => assert.deepEqual(S.gameShocksFlag(), { on: false, preview: false }));
  withEnv({ [S.GAME_SHOCKS_ENV]: null, [PREVIEW_ENV]: '1' }, () => assert.deepEqual(S.gameShocksFlag(), { on: true, preview: true }));
});

test('studentTCdf matches tabled t quantiles', () => {
  const close = (a, b, tol = 2e-4) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);
  close(C.studentTCdf(0, 6), 0.5);
  close(C.studentTCdf(1.943, 6), 0.95);
  close(C.studentTCdf(3.143, 6), 0.99);
  close(C.studentTCdf(-2.447, 6), 0.025);
  close(C.studentTCdf(12.706, 1), 0.975);
  close(C.studentTCdf(2.776, 4), 0.975);
  close(C.studentTCdf(2.571, 5), 0.975);
  close(C.studentTCdf(1.96, 1000), normalCdf(1.96), 1e-3);
});

test('off: the sampler with no shock option is byte-identical to today', () => {
  const a = drawAll(C.correlatedSampler(PLAYERS, PLAYERS.map(() => POOL), KEYS));
  const b = drawAll(C.correlatedSampler(PLAYERS, PLAYERS.map(() => POOL), KEYS, { gameShock: null }));
  assert.deepEqual(a.map(d => [...d]), b.map(d => [...d]));
});

test('on: every marginal stays uniform over its pool', () => {
  const s = C.correlatedSampler(PLAYERS, PLAYERS.map(() => POOL), KEYS, { gameShock: { nu: 6, key: 77 } });
  assert.equal(s.gameShock?.nu, 6);
  const draws = drawAll(s);
  for (let i = 0; i < PLAYERS.length; i++) {
    const deciles = new Array(10).fill(0);
    for (const d of draws) deciles[Math.floor(d[i] / 10)]++;
    for (const c of deciles) assert.ok(Math.abs(c / DRAWS - 0.1) < 0.012, `player ${i} decile share ${c / DRAWS}`);
  }
});

test('on: same-game joint extremes rise in both tails; different games stay independent', () => {
  const off = drawAll(C.correlatedSampler(PLAYERS, PLAYERS.map(() => POOL), KEYS));
  const on = drawAll(C.correlatedSampler(PLAYERS, PLAYERS.map(() => POOL), KEYS, { gameShock: { nu: 6, key: 77 } }));
  // KC WR vs BUF WR (same game, near-zero correlation): joint top-decile well above off.
  assert.ok(bothTop(on, 1, 2) > bothTop(off, 1, 2) * 1.3, `top on ${bothTop(on, 1, 2)} off ${bothTop(off, 1, 2)}`);
  assert.ok(bothBottom(on, 1, 2) > bothBottom(off, 1, 2) * 1.3, `bottom on ${bothBottom(on, 1, 2)} off ${bothBottom(off, 1, 2)}`);
  // QB-WR stack: more joint booms too.
  assert.ok(bothTop(on, 0, 1) > bothTop(off, 0, 1), `stack on ${bothTop(on, 0, 1)} off ${bothTop(off, 0, 1)}`);
  // KC WR vs DAL RB: different games, no shared shock: stays at independence (0.01).
  assert.ok(Math.abs(bothTop(on, 1, 3) - 0.01) < 0.004, `cross-game ${bothTop(on, 1, 3)}`);
});

test('the shock is keyed by fixture and run, not by who else is in the list (paired arms)', () => {
  const full = C.correlatedSampler(PLAYERS, PLAYERS.map(() => POOL), KEYS, { gameShock: { nu: 6, key: 77 } });
  // An "after" roster: the DAL-NYG game dropped, KC-BUF players listed in another order.
  const order = [2, 0, 1];
  const part = C.correlatedSampler(order.map(i => PLAYERS[i]), order.map(() => POOL), order.map(i => KEYS[i]),
    { gameShock: { nu: 6, key: 77 } });
  // One mixing variable per (world key, fixture, run): repeatable, different per game and run.
  assert.equal(C.gameShockScale(77, 'BUF-KC', 5, 6), C.gameShockScale(77, 'BUF-KC', 5, 6));
  assert.notEqual(C.gameShockScale(77, 'BUF-KC', 5, 6), C.gameShockScale(77, 'DAL-NYG', 5, 6));
  assert.notEqual(C.gameShockScale(77, 'BUF-KC', 5, 6), C.gameShockScale(77, 'BUF-KC', 6, 6));
  // BUF WR alone in his game's shock has the same draw in both lists when the Cholesky
  // mix leaves him independent of the KC pair (row 0 of the reordered list).
  const soloFull = C.correlatedSampler([PLAYERS[2]], [POOL], [KEYS[2]], { gameShock: { nu: 6, key: 77 } });
  for (const r of [0, 1, 2, 3, 50]) assert.equal(part(r)[0], soloFull(r)[0]);
  assert.ok(full(0).length === 5);
});

test('season sim: the shock options come from the flag, keyed by world and week', () => {
  const { gameShockFor } = S.__test;
  assert.equal(gameShockFor(7, 5, { on: false, preview: false }), null);
  const a = gameShockFor(7, 5, { on: true, preview: false });
  assert.equal(a.nu, 6);
  assert.deepEqual(gameShockFor(7, 5, { on: true, preview: false }), a, 'repeatable');
  assert.notEqual(gameShockFor(7, 6, { on: true, preview: false }).key, a.key, 'per week');
  assert.notEqual(gameShockFor(8, 5, { on: true, preview: false }).key, a.key, 'per world');
  assert.equal(S.gameShockFields({ on: false, preview: false }), null);
  assert.deepEqual(S.gameShockFields({ on: true, preview: false }), { game_shocks: { nu: 6 } });
  const pv = S.gameShockFields({ on: true, preview: true });
  assert.equal(pv.game_shocks.nu, 6);
  assert.equal(pv.game_shocks.preview, true);
  assert.match(pv.game_shocks.preview_reason, /GAME-SHOCKS/);
});

test('measurement helper: shocks raise simulated joint upper-decile exceedance at a fixed rho', () => {
  const g = C.simulatedJointExceedance(0.3, { q: 0.9, nu: null, draws: 40000, key: 5 });
  const t = C.simulatedJointExceedance(0.3, { q: 0.9, nu: 6, draws: 40000, key: 5 });
  // Gaussian at rho 0.3, both above the 90th percentile: ~0.024.
  assert.ok(Math.abs(g - 0.024) < 0.004, `gaussian ${g}`);
  assert.ok(t > g * 1.1, `t ${t} vs gaussian ${g}`);
});
