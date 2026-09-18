/**
 * Trade floor/ceiling as the 10th/90th percentile of the lineup TOTAL
 * (trade-engine.js#lineupSpread), and the lazy floor_delta/ceiling_delta on evaluate().
 *
 * It replaced a sum of per-player floors — nine starters' 1-in-10 weeks all at once,
 * a "floor" of 5.2 against a true lineup p10 of 73.6 — and nothing tested it: putting
 * the sum back, or moving the normal quantile from 1.2816 to 3, passed every test.
 * These numbers go into every trade verdict and the Claude trade prompts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lineup-spread-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { lineupSpread, bestLineup, evaluate, WEEK_MARGINAL } = await import('../server/services/trade-engine.js');
const { PPR } = await import('../server/services/scoring.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const Z90 = 1.2815516;
const lineupOf = players => ({ slots: players.map(player => ({ slot: player.position, player })) });
/** A starter with no weekly model: priced from the floor/ceiling he carries. */
const approx = (id, position, avg, floor, ceiling, extra = {}) => ({
  id, name: `P${id}`, position, team_abbr: 'AAA', avg, floor, ceiling, adj_ppg: avg, ppg: avg, value: 100, ...extra
});
const sdOf = p => (p.ceiling - p.floor) / (2 * Z90);

test('(a) the floor is the lineup total\'s 10th percentile, not the sum of floors', () => {
  const a = approx(1, 'RB', 14, 5, 23), b = approx(2, 'WR', 12, 4, 20);
  const s = lineupSpread(lineupOf([a, b]));
  const mean = 14 + 12, sd = Math.sqrt(sdOf(a) ** 2 + sdOf(b) ** 2);
  assert.equal(s.floor, +(mean - Z90 * sd).toFixed(1));
  assert.equal(s.ceiling, +(mean + Z90 * sd).toFixed(1));
  assert.equal(s.mean, 26);
  assert.notEqual(s.floor, a.floor + b.floor, 'a sum of quantiles is not the quantile of a sum');
  assert.ok(s.floor > a.floor + b.floor, 'two starters do not have their bad week together');
  assert.ok(s.ceiling < a.ceiling + b.ceiling);
});

test('(b) a lineup with no spread information has no floor or ceiling', () => {
  const s = lineupSpread(lineupOf([
    { id: 3, position: 'QB', adj_ppg: 18, floor: null, ceiling: null },
    { id: 4, position: 'TE', adj_ppg: 7 }
  ]));
  assert.deepEqual(s, { floor: null, ceiling: null, coverage: 0 });
});

test('(c) the floor is never below 0', () => {
  const s = lineupSpread(lineupOf([approx(5, 'WR', 3, 0, 30), approx(6, 'TE', 2, 0, 25)]));
  assert.equal(s.floor, 0);
  assert.ok(s.ceiling > 0);
});

// A weekly model, the way buildAssetUniverse attaches one (a Symbol-keyed marginal).
const params = (position, overrides) => ({
  position, attempts: 0, carries: 0, targets: 0, dispersion: 10,
  ypa: 7, pass_td_rate: 0.045, int_rate: 0.025, ypc: 4.2, rush_td_rate: 0.03,
  catch_rate: 0.68, ypt: 8, rec_td_rate: 0.05, ...overrides
});
function modeled(id, position, team, overrides, { targetShare = 0.25, onRead } = {}) {
  const m = {
    shift: 0, activeProbability: 1, mult: 1, scoring: PPR, seed: `test:${id}:${team}`,
    meta: { id, position, team, opponent: 'OPP', target_share: targetShare }
  };
  const p = params(position, overrides);
  Object.defineProperty(m, 'params', { enumerable: true, get() { onRead?.(); return p; } });
  return { id, name: `M${id}`, position, team_abbr: team, adj_ppg: 15, value: 100, [WEEK_MARGINAL]: m };
}

test('(d) a same-team QB and WR add a correlation term; different teams do not', () => {
  const qb = () => modeled(10, 'QB', 'KC', { attempts: 34, carries: 4 });
  const stacked = lineupSpread(lineupOf([qb(), modeled(11, 'WR', 'KC', { targets: 9 })]));
  const apart = lineupSpread(lineupOf([qb(), modeled(12, 'WR', 'BUF', { targets: 9 })]));
  assert.equal(stacked.correlated_pairs, 1);
  assert.equal(apart.correlated_pairs, 0);
  assert.equal(stacked.coverage, 1);
  assert.ok(stacked.sd > apart.sd, `a stack is wider: sd ${stacked.sd} vs ${apart.sd}`);
  assert.ok(Math.abs(stacked.mean - apart.mean) < 0.5, 'correlation moves the spread, not the mean');
  // With a weekly model the quantile is the standard normal's 90th percentile of the
  // model's own sd (mean and sd are reported rounded to 0.1, hence the tolerance).
  for (const s of [stacked, apart]) {
    assert.ok(Math.abs(s.floor - (s.mean - Z90 * s.sd)) <= 0.15, `floor ${s.floor} vs ${s.mean} - 1.2816 x ${s.sd}`);
    assert.ok(Math.abs(s.ceiling - (s.mean + Z90 * s.sd)) <= 0.15, `ceiling ${s.ceiling} vs ${s.mean} + 1.2816 x ${s.sd}`);
  }
});

test('(e) evaluate() floor_delta is lineupSpread(after) - lineupSpread(before), computed only when read', () => {
  let reads = 0;
  const onRead = () => { reads++; };
  const SLOTS = ['QB', 'RB', 'WR'];
  const mine = [modeled(20, 'QB', 'KC', { attempts: 34, carries: 4 }, { onRead }),
    approx(21, 'RB', 13, 4, 22), approx(22, 'WR', 11, 3, 20)];
  const theirs = [approx(30, 'QB', 16, 8, 25), approx(31, 'RB', 15, 5, 26), approx(32, 'WR', 14, 5, 24)];
  const ev = evaluate(
    { team: { roster_id: 'A', owner: 'Me', players: mine }, gives: [mine[2]] },
    { team: { roster_id: 'B', owner: 'Them', players: theirs }, gives: [theirs[2]] },
    SLOTS
  );
  assert.equal(reads, 0, 'building the verdict does not draw anyone\'s weekly distribution');
  const before = lineupSpread(bestLineup(mine, SLOTS));
  const after = lineupSpread(bestLineup([mine[0], mine[1], theirs[2]], SLOTS));
  reads = 0;
  assert.equal(ev.me.floor_delta, +(after.floor - before.floor).toFixed(1));
  assert.equal(ev.me.ceiling_delta, +(after.ceiling - before.ceiling).toFixed(1));
  assert.ok(ev.me.floor_delta > 0, 'a 14-point WR for an 11-point WR raises the floor');
  // Read once, then fixed on the object: a second read costs nothing.
  const readsAfterFirst = reads;
  void ev.me.floor_delta;
  assert.equal(reads, readsAfterFirst);
});
