/**
 * RL-13-2: the waiver board says how claim priority works in THIS league.
 *
 * All five synced ESPN leagues reset the waiver order every week
 * (acquisitionSettings.waiverOrderReset: true, local copy 2026-09-23), so priority is not
 * a resource to hold: a claim costs only this week's place in line. The board surfaces the
 * league's rule (league-rules.js#leagueRules, the one producer of league rules) and my
 * team's current rank (teams[].waiverRank from ESPN mTeam) as `claim_priority`.
 * Evidence: docs/tdd/2026-09-23-waiver-claim-priority.tdd.md.
 *
 * The asset universe is mocked so every projection is known.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-rl132-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.NFL_WEEK = '3';

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const realTradeEngine = await import('../server/services/trade-engine.js');
let assets = new Map();
mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realTradeEngine,
    assetUniverse: () => assets,
    tradeWeekContext: () => ({ season: 2026, week: 3 })
  }
});
const { waiverBoard } = await import('../server/services/waiver-wire.js');
const { leagueRules } = await import('../server/services/league-rules.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SLOTS = ['QB', 'RB', 'WR'];
const SLOT_ID = { QB: 0, RB: 2, WR: 4, BENCH: 20 };
const POS_ID = { QB: 1, RB: 2, WR: 3 };
let nextId = 1;
function p(name, position, week, slot = SLOT_ID.BENCH) {
  const id = nextId++;
  return { id, name, position, team_abbr: 'NYJ', current_week_ppg: week, adj_ppg: week, ppg: week,
    ros_ppg: week, available: true, active_probability: 0.95, espn_id: 7000 + id, slot };
}
const entries = list => list.map(a => ({
  lineupSlotId: a.slot,
  playerPoolEntry: { player: { id: a.espn_id, fullName: a.name, defaultPositionId: POS_ID[a.position],
    injuryStatus: 'ACTIVE' } }
}));

const TRADITIONAL = { acquisitionType: 'WAIVERS_TRADITIONAL', isUsingAcquisitionBudget: false,
  waiverOrderReset: true, waiverProcessDays: ['WEDNESDAY'], waiverProcessHour: 11, waiverHours: 24 };

/**
 * Three teams. Team 1 is mine (rank 3 of 3 by default), team 2 rank 1, team 3 rank 2.
 * `ranks` overrides waiverRank per team id; a value of undefined drops the field.
 */
function league({ acq = TRADITIONAL, ranks = { 1: 3, 2: 1, 3: 2 }, extra = {} } = {}) {
  const mine = [p('Mine QB', 'QB', 20, SLOT_ID.QB), p('Mine RB', 'RB', 12, SLOT_ID.RB), p('Mine WR', 'WR', 10, SLOT_ID.WR)];
  const other = [p('Other QB', 'QB', 18, SLOT_ID.QB)];
  const free = [p('Free WR', 'WR', 14)];
  assets = new Map([...mine, ...other, ...free].map(a => [a.id, a]));
  const team = (id, roster) => {
    const t = { id, roster: { entries: entries(roster) } };
    if (ranks[id] !== undefined) t.waiverRank = ranks[id];
    return t;
  };
  const payload = {
    settings: acq ? { acquisitionSettings: acq } : {},
    teams: [team(1, mine), team(2, other), team(3, [])]
  };
  return { id: 1, platform: 'espn', season: 2026, payload_season: 2026, team_count: 3, ppr: 1,
    my_team_id: '1', fetched_at: '2026-09-23 17:15:31', roster_positions: JSON.stringify(SLOTS),
    payload: JSON.stringify(payload), ...extra };
}

test('weekly-reset league: claim_priority says the order resets and gives my current rank', () => {
  const out = waiverBoard(league(), {});
  assert.ok(out.claim_priority, 'board has no claim_priority block');
  const cp = out.claim_priority;
  assert.equal(cp.resets_weekly, true);
  assert.equal(cp.current_rank, 3);
  assert.equal(cp.teams, 3);
  assert.equal(cp.teams_ahead, 2);
  assert.equal(cp.known, true);
  assert.equal(cp.acquisition_type, 'WAIVERS_TRADITIONAL');
  assert.equal(cp.as_of, '2026-09-23 17:15:31');
  assert.match(cp.strategy, /resets/i);
  assert.doesNotMatch(cp.strategy, /\bsave\b|\bhold\b/i, 'weekly reset must not tell you to hold priority');
});

test('rank follows the team the board is built for (myTeamId), not the league default', () => {
  const cp = waiverBoard(league(), { myTeamId: 2 }).claim_priority;
  assert.equal(cp.current_rank, 1);
  assert.equal(cp.teams_ahead, 0);
});

test('rolling-order league: resets_weekly false and the strategy differs from the reset one', () => {
  const reset = waiverBoard(league(), {}).claim_priority;
  const rolling = waiverBoard(league({ acq: { ...TRADITIONAL, waiverOrderReset: false } }), {}).claim_priority;
  assert.equal(rolling.resets_weekly, false);
  assert.equal(rolling.current_rank, 3);
  assert.notEqual(rolling.strategy, reset.strategy);
  assert.match(rolling.strategy, /back of the order/i);
});

test('no reset field in the payload: unknown, never a default', () => {
  const { waiverOrderReset, ...noReset } = TRADITIONAL;
  const cp = waiverBoard(league({ acq: noReset }), {}).claim_priority;
  assert.equal(cp.known, false);
  assert.equal(cp.resets_weekly, null);
  assert.ok(cp.missing.includes('settings.acquisitionSettings.waiverOrderReset'), JSON.stringify(cp.missing));
  // The rank the platform does publish is still shown.
  assert.equal(cp.current_rank, 3);
});

test('my team carries no waiverRank: rank is null and named missing, never a default', () => {
  const cp = waiverBoard(league({ ranks: { 1: undefined, 2: 1, 3: 2 } }), {}).claim_priority;
  assert.equal(cp.known, false);
  assert.equal(cp.current_rank, null);
  assert.equal(cp.teams_ahead, null);
  assert.ok(cp.missing.includes('teams[].waiverRank'), JSON.stringify(cp.missing));
  assert.equal(cp.resets_weekly, true);
});

test('payload fell back to last season: the rank is flagged stale, not presented as current', () => {
  const cp = waiverBoard(league({ extra: { payload_season: 2025 } }), {}).claim_priority;
  assert.equal(cp.known, false);
  assert.equal(cp.stale_season, true);
  assert.match(cp.reason, /2025/);
});

test('bidding league: the order only breaks tied bids, said so', () => {
  const faab = { ...TRADITIONAL, acquisitionType: 'WAIVERS_BLIND_BIDDING', isUsingAcquisitionBudget: true };
  const cp = waiverBoard(league({ acq: faab }), {}).claim_priority;
  assert.equal(cp.uses_budget, true);
  assert.match(cp.strategy, /bid/i);
});

test('leagueRules is the producer of the reset rule (one number, one producer)', () => {
  const r = leagueRules(league());
  assert.equal(r.waivers.order_resets_weekly, true);
  assert.equal(r.waivers.acquisition_type, 'WAIVERS_TRADITIONAL');
  assert.equal(r.waivers.uses_budget, false);
  const { waiverOrderReset, ...noReset } = TRADITIONAL;
  const r2 = leagueRules(league({ acq: noReset }));
  assert.equal(r2.waivers.order_resets_weekly, null);
  assert.ok(r2.missing.includes('settings.acquisitionSettings.waiverOrderReset'));
});
