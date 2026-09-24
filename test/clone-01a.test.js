/**
 * CLONE-01a: manager clones, population layer.
 *
 * Pre-registered in docs/evidence/2026-09-23/clone-01-preregistration.md.
 *
 *  C1 RL-13-3: a manager at the pooled accept rate (0.355) with n=15 decisions
 *     scores 0.5 ("middle of league"), receptiveness 1.0, not today's 0.913.
 *  C2 the shrink is monotone and pulls a thin sample toward the pool.
 *  C3 default off: without GRIDIRON_CLONE01A_ENABLED (or preview) nothing changes.
 *  C4 MOTIVE RED: 0-4 with title odds < 3% reads seller; >= 2 starters out and a
 *     bye crunch reads desperate_buyer; no sim gives state:null with a reason.
 *  C5 the profile carries motive, and it moves no number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-clone01a-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'no-chat.sqlite');
process.env.SCHEDULER_DISABLED = '1';
delete process.env.GRIDIRON_CLONE01A_ENABLED;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const { run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const pricing = await import('../server/services/counterparty-pricing.js');
await runMigrations();

const LEAGUE = 9101;
run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id)
     VALUES (?, 'espn', 'espn-clone01a', 2026, 'CLONE fixture', NULL, 6, '9')`, LEAGUE);
const put = (roster, metric, value, n, source = 'tx') =>
  run(`INSERT OR REPLACE INTO manager_signals (league_id, roster_id, metric, value, n, source, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`, LEAGUE, String(roster), metric, value, n, source);

// Pool = 71 / 200 = 0.355 exactly. Roster 1 sits at the pool rate with n = 15.
put(1, 'tx_accept_rate', 0.355, 15);
put(2, 'tx_accept_rate', 30 / 85, 85);
put(3, 'tx_accept_rate', 35.675 / 100, 100);
// Roster 4: 0-4, the RED seller. Roster 5: two dead starters. Roster 6: nothing.
put(4, 'standing_wins', 0, 4, 'standings');
put(4, 'standing_losses', 4, 4, 'standings');
put(4, 'standing_streak', -4, 4, 'standings');
put(5, 'standing_wins', 3, 4, 'standings');
put(5, 'standing_losses', 1, 4, 'standings');
put(5, 'lineup_dead_starters', 2, 9, 'roster');
put(6, 'standing_wins', 2, 4, 'standings');
put(6, 'standing_losses', 2, 4, 'standings');

const layer = (opts = {}) => pricing.counterpartyLayer(LEAGUE, { season: 2026, week: 5, rosterContext: new Map(), ...opts });
const withFlag = (value, fn) => {
  const before = process.env.GRIDIRON_CLONE01A_ENABLED;
  if (value == null) delete process.env.GRIDIRON_CLONE01A_ENABLED; else process.env.GRIDIRON_CLONE01A_ENABLED = value;
  try { return fn(); } finally {
    if (before == null) delete process.env.GRIDIRON_CLONE01A_ENABLED; else process.env.GRIDIRON_CLONE01A_ENABLED = before;
  }
};

test('C1 RL-13-3: a manager at the pool rate with n=15 scores ~0.5, not 0.913', () => {
  const pool = pricing.acceptPool([{ rate: 0.355, n: 15 }, { rate: 30 / 85, n: 85 }, { rate: 35.675 / 100, n: 100 }]);
  assert.ok(Math.abs(pool.p0 - 0.355) < 1e-9, `pool ${pool.p0}`);
  assert.ok(Math.abs(pricing.shrunkAcceptScore(0.355, 15, pool) - 0.5) < 0.01);
  const on = withFlag('1', () => layer()).get('1');
  assert.ok(Math.abs(on.receptiveness - 1.0) < 0.01, `receptiveness ${on.receptiveness}`);
  assert.ok(Math.abs(on.accept_score - 0.5) < 0.01);
  assert.equal(on.accept_pool.managers, 3);
});

test('C2 the shrink is monotone in accepts and pulls a thin sample toward the pool', () => {
  const pool = { p0: 0.355, m: 15, managers: 10 };
  let prev = -1;
  for (let k = 0; k <= 5; k++) {
    const s = pricing.shrunkAcceptScore(k / 5, 5, pool);
    assert.ok(s > prev, `k=${k} ${s} after ${prev}`);
    assert.ok(s > 0 && s < 1);
    prev = s;
  }
  // 5 of 5 on a thin sample is shrunk harder than 50 of 50.
  assert.ok(pricing.shrunkAcceptScore(1, 5, pool) < pricing.shrunkAcceptScore(1, 50, pool));
  // Moment estimate: identical managers mean no between-manager spread, so the prior is strongest.
  assert.equal(pricing.acceptPool([{ rate: 0.4, n: 10 }, { rate: 0.4, n: 10 }, { rate: 0.4, n: 10 }]).m, 50);
  // Too few managers: the declared default.
  assert.equal(pricing.acceptPool([{ rate: 0.4, n: 10 }]).m, 15);
  assert.equal(pricing.acceptPool([]), null);
});

test('C3 default off: the incumbent blend is untouched without the flag', () => {
  const off = withFlag(null, () => layer()).get('1');
  assert.equal(off.receptiveness, 0.913);
  assert.equal(off.accept_score, null);
  assert.equal(off.motive, null);
});

test('C3b preview mode turns it on and labels it', () => {
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try {
    const p = withFlag(null, () => layer()).get('1');
    assert.ok(Math.abs(p.receptiveness - 1.0) < 0.01);
    assert.equal(p.accept_preview, true);
    assert.equal(p.motive.preview, true);
  } finally { delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED; }
});

test('C4 MOTIVE RED: seller, desperate buyer, buyer, hold, and null with a reason', () => {
  assert.equal(pricing.motiveState({ titleOdds: 0.02, games: 4, startersOut: 0, byeCrunch: 0, numTeams: 12 }).state, 'seller');
  assert.equal(pricing.motiveState({ titleOdds: 0.10, games: 4, startersOut: 2, byeCrunch: 2, numTeams: 12 }).state, 'desperate_buyer');
  assert.equal(pricing.motiveState({ titleOdds: 0.20, games: 4, startersOut: 0, byeCrunch: 0, numTeams: 12 }).state, 'buyer');
  assert.equal(pricing.motiveState({ titleOdds: 0.08, games: 4, startersOut: 1, byeCrunch: 0, numTeams: 12 }).state, 'hold');
  const none = pricing.motiveState({ titleOdds: null, games: 4, startersOut: 2, byeCrunch: 2, numTeams: 12 });
  assert.equal(none.state, null);
  assert.match(none.reason, /simulation/);
  // Too early for a seller call: odds alone after two games do not make him a seller.
  assert.notEqual(pricing.motiveState({ titleOdds: 0.01, games: 2, startersOut: 0, byeCrunch: 0, numTeams: 12 }).state, 'seller');
});

test('C5 the layer reads motive from a supplied sim; no sim gives state:null with a reason', () => {
  const sim = { teams: [
    { roster_id: '4', title_odds: 0.012 }, { roster_id: '5', title_odds: 0.11 },
    { roster_id: '6', title_odds: 0.07 }, { roster_id: '1', title_odds: 0.3 },
    { roster_id: '2', title_odds: 0.25 }, { roster_id: '3', title_odds: 0.25 },
  ] };
  const byeCrunch = new Map([['5', 2]]);
  const on = withFlag('1', () => layer({ sim, byeCrunch }));
  assert.equal(on.get('4').motive.state, 'seller');
  assert.equal(on.get('4').motive.loss_streak, 4);
  assert.equal(on.get('5').motive.state, 'desperate_buyer');
  assert.equal(on.get('5').motive.starters_out, 2);
  assert.equal(on.get('1').motive.state, 'buyer');
  const noSim = withFlag('1', () => layer()).get('4').motive;
  assert.equal(noSim.state, null);
  assert.match(noSim.reason, /simulation/);
  // Display-only: motive moves no number.
  const without = withFlag('1', () => layer());
  for (const id of ['4', '5', '6']) assert.equal(on.get(id).receptiveness, without.get(id).receptiveness);
});
