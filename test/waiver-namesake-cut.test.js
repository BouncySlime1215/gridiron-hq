/**
 * RL-6-4: the waiver board must price and cut the player who is actually on the
 * roster, never a namesake.
 *
 * The board used to join the ESPN roster to the priced asset universe by normalised
 * name only (last row wins, "Jr." stripped). On the 2026-W3 sync that swapped the real
 * player for a retired or junk row priced 0.0 / 0.0 in all 5 leagues, and the zero
 * then let cut rule (a) pass a claim it should hold back. The join is now the shared
 * ESPN-id-first resolver (trade-engine.js#espnPlayerResolver, also behind
 * loadRosters): the ESPN id first; name + position only when no asset carries that id,
 * and only onto an asset with no ESPN id of its own. A player priced through that
 * name fallback is labelled and is never suggested as a cut.
 *
 * The asset universe is mocked so every number is known; the lineup solver, the slot
 * rules and the resolver are the real ones from trade-engine.js.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-waiver-namesake-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.NFL_WEEK = '3';

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const realTradeEngine = await import('../server/services/trade-engine.js');
const { loadRosters } = realTradeEngine;
let assets = new Map();
mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realTradeEngine,
    assetUniverse: () => assets,
    tradeWeekContext: () => ({ season: 2026, week: 3 })
  }
});
const { waiverBoard } = await import('../server/services/waiver-wire.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
let nextId = 1;
const p = (name, position, week, ros, extra = {}) => ({
  id: nextId++, name, position, team_abbr: 'NYJ', current_week_ppg: week, adj_ppg: week,
  ppg: week, ros_ppg: ros, available: true, active_probability: 0.95, espn_id: 7000 + nextId, ...extra
});

/** Starters worth more over the season than any claim below, so none of them is a safe cut. */
function starters() {
  return [
    p('Starting QB', 'QB', 20, 20), p('Back One', 'RB', 15, 15), p('Back Two', 'RB', 12, 12),
    p('Wideout One', 'WR', 15, 15), p('Wideout Two', 'WR', 11, 11), p('Tight End', 'TE', 8, 8),
    p('Back Three', 'RB', 9, 9)
  ];
}

/**
 * mine: rostered on my team (id 1). others: rostered on team 2. extra: in the asset
 * universe, on nobody's roster, inserted AFTER the rostered rows (the order that made
 * the old last-wins name map pick the namesake). payloadId overrides the ESPN id the
 * payload carries for a rostered player.
 */
function board(mine, extra = [], others = [], opts = {}) {
  const rostered = [...mine, ...others];
  assets = new Map([...rostered, ...extra].filter(a => !a.notAnAsset).map(a => [a.id, a]));
  const entry = a => ({
    lineupSlotId: a.slot ?? 20,
    playerPoolEntry: { player: {
      id: a.payloadId ?? a.espn_id, fullName: a.payloadName ?? a.name,
      defaultPositionId: POS_ID[a.position], injuryStatus: 'ACTIVE'
    } }
  });
  const payload = { teams: [
    { id: 1, roster: { entries: mine.map(entry) } },
    { id: 2, roster: { entries: others.map(entry) } }
  ] };
  const lg = { id: 1, platform: 'espn', team_count: 10, ppr: 1, my_team_id: '1',
    roster_positions: JSON.stringify(SLOTS), payload: JSON.stringify(payload) };
  return { lg, out: waiverBoard(lg, { limit: 50, ...opts }) };
}

test('RL-6-4 a retired namesake is not the suggested cut: the real Jr. is, at his real price', () => {
  const jr = p('Marvin Harrison Jr.', 'WR', 2.97, 6.91, { espn_id: 4432708 });
  const mine = [...starters(), p('Backup QB', 'QB', 14, 13), jr];
  // The retired Colt: same normalised name, no team, priced zero, a different ESPN id.
  const retired = p('Marvin Harrison', 'WR', 0, 0, { espn_id: 939, team_abbr: null });
  const { out } = board(mine, [retired, p('Hot Wideout', 'WR', 13, 9)]);
  const claim = out.immediate.find(r => r.player === 'Hot Wideout');
  assert.ok(claim, `Hot Wideout should be a claim; immediate=${out.immediate.map(r => r.player)}`);
  assert.equal(claim.drop_candidate.player, 'Marvin Harrison Jr.', 'the cut is the rostered player, not the namesake');
  assert.equal(claim.drop_candidate.ros_ppg, 6.91, 'priced at his own rest-of-season number, not the namesake zero');
  assert.equal(claim.drop_candidate.ppg, 2.97);
});

test('RL-6-4 a junk row with ESPN id 0 and the same name does not change the board', () => {
  const real = p('Mike Washington Jr.', 'RB', 2.62, 3.15, { espn_id: 4686658 });
  const mine = [...starters(), p('Backup QB', 'QB', 14, 13), real];
  const junk = p('Mike Washington', 'RB', 0, 0, { espn_id: 0, team_abbr: null });
  const { out } = board(mine, [junk, p('Hot Back', 'RB', 13, 9)]);
  const claim = out.immediate.find(r => r.player === 'Hot Back');
  assert.ok(claim, 'Hot Back is a claim');
  assert.equal(claim.drop_candidate.player, 'Mike Washington Jr.');
  assert.equal(claim.drop_candidate.ros_ppg, 3.15);
});

test('RL-6-4 rule (a) holds back the Jack Strand claim once the rostered player is priced correctly', () => {
  // Antonio Williams WR is worth 7.29 a week over the season; the claim only 6.65. A
  // teamless RB namesake priced 0 / 0 used to stand in for him and pass rule (a).
  const williams = p('Antonio Williams', 'WR', 1, 7.29, { espn_id: 5081432 });
  const mine = [...starters(), p('Jaylen Waddle', 'WR', 2, 10), p('Backup QB', 'QB', 14, 13), williams];
  const namesake = p('Antonio Williams', 'RB', 0, 0, { espn_id: 3100000, team_abbr: null });
  const { out } = board(mine, [namesake, p('Jack Strand', 'WR', 13, 6.65)]);
  assert.equal(out.immediate.find(r => r.player === 'Jack Strand'), undefined,
    'no safe cut exists, so Jack Strand is not an immediate claim');
  const held = out.held_back.find(r => r.player === 'Jack Strand');
  assert.ok(held, 'Jack Strand is held back');
  assert.equal(held.would_cut.player, 'Antonio Williams');
  assert.equal(held.would_cut.ros_ppg, 7.29);
  assert.equal(out.held_back_count, 1);
});

test('RL-6-4 a free agent sharing a name with a player rostered elsewhere is still on the wire', () => {
  const mine = [...starters(), p('Backup QB', 'QB', 14, 13), p('Bench Back', 'RB', 1, 1)];
  const theirs = p('Mike Williams', 'WR', 5, 5, { espn_id: 15880 });
  const faNamesake = p('Mike Williams', 'RB', 13, 12, { espn_id: 4800001 });
  const { out } = board(mine, [faNamesake], [theirs]);
  const claim = out.immediate.find(r => r.player === 'Mike Williams');
  assert.ok(claim, `the free-agent RB Mike Williams is offered; immediate=${out.immediate.map(r => r.player)}`);
  assert.equal(claim.position, 'RB');
});

test('RL-6-4 a player priced through the name fallback is labelled and never the suggested cut', () => {
  // His payload ESPN id matches no asset; the only name + position match has no ESPN id.
  const fallback = p('Fallback Guy', 'WR', 0.5, 0.5, { espn_id: null, payloadId: 9990001 });
  const mine = [...starters(), p('Backup QB', 'QB', 14, 13), p('Bench Back', 'RB', 1, 1), fallback];
  const { out } = board(mine, [p('Hot Wideout', 'WR', 13, 9)]);
  assert.deepEqual(out.roster_coverage.name_fallback, ['Fallback Guy'], 'the fallback match is labelled');
  const claim = out.immediate.find(r => r.player === 'Hot Wideout');
  assert.ok(claim, 'Hot Wideout is a claim');
  assert.equal(claim.drop_candidate.player, 'Bench Back', 'the unconfirmed player is not offered as the cut');
  for (const r of [...out.immediate, ...out.stashes]) {
    assert.notEqual(r.drop_candidate?.player, 'Fallback Guy');
    assert.notEqual(r.ros_drop_candidate?.player, 'Fallback Guy');
  }
});

test('RL-6-4 the name fallback never lands on an asset that carries a different ESPN id', () => {
  // The payload says ESPN 9990002; the only same-name WR asset is ESPN 5555555, a
  // different person. He must be unpriced, not priced as that person.
  const ghost = p('Ghost Receiver', 'WR', 9, 9, { espn_id: 5555555, payloadId: 9990002 });
  const mine = [...starters(), p('Backup QB', 'QB', 14, 13), p('Bench Back', 'RB', 1, 1), ghost];
  const { lg, out } = board(mine, [p('Hot Wideout', 'WR', 13, 9)]);
  assert.deepEqual(out.roster_coverage.unpriced, ['Ghost Receiver']);
  assert.equal(out.roster_coverage.priced, mine.length - 1);
  // loadRosters shares the resolver, so the trade side agrees on who is rostered.
  const me = loadRosters(lg, assets).find(t => t.roster_id === '1');
  assert.equal(me.players.some(a => a.id === ghost.id), false, 'loadRosters does not price him as the other person');
  assert.equal(me.players.length, mine.length - 1);
});
