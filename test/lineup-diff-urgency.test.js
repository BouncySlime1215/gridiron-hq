/**
 * The League Hub lineup card (trade-engine.js#lineupDiff): how sure each swap is, what
 * urgency that sets, and what it writes to the Decision Inbox.
 *
 * Commit 11ab55c replaced the old ">= 4 points is high" rule with a measured one —
 * P(right) = Phi(gap / 14.5), high >= 75%, medium >= 60% — plus a swap against a sure
 * zero priced at the newcomer's own chance to play, IR exclusion, activate_from_ir,
 * flagged_starters.espn_disagrees and retiring a stale inbox row. None of it had a
 * test: five mutations (urgency always high, sigma 3, versus-zero on the gap, retire
 * disabled, on_ir forced false) all passed the suite. These tests pin each rule with a
 * priced fixture. The universe is injected (lineupDiff's third argument), so every
 * week number is known exactly; slots, roster loading and pairing are the real ones.
 *
 * The last group pins the review-fixes change: a team_id that is not in the league is
 * a not-found error (it used to fall back to teams[0], a rival's roster), and only
 * Nick's own roster (leagues.my_team_id) publishes to or retires from his inbox.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lineup-diff-urgency-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.NFL_WEEK = '2';

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { lineupDiff } = await import('../server/services/trade-engine.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Phi (Abramowitz-Stegun 26.2.17, error < 1e-7), independent of the module under test.
function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const SLOT_ID = { QB: 0, RB: 2, WR: 4, TE: 6, BENCH: 20, IR: 21 };
let nextId = 1;
/** One priced player and his ESPN entry. `slot` is where ESPN has him set. */
function player(name, position, week, { slot = position, status = 'ACTIVE', available = true, ap = 0.95 } = {}) {
  const id = nextId++;
  return {
    asset: {
      id, name, position, team_abbr: 'MID', espn_id: 7000 + id, available,
      current_week_ppg: week, adj_ppg: week, ppg: week, ros_ppg: week,
      active_probability: ap, bye: 9, matchup: { opponent: 'OPP' }
    },
    entry: {
      lineupSlotId: SLOT_ID[slot],
      playerPoolEntry: { player: { id: 7000 + id, fullName: name, defaultPositionId: POS_ID[position], injuryStatus: status } }
    }
  };
}

let leagueSeq = 900;
/** A synced ESPN league: my team 1 and a rival team 2, QB/RB/WR/TE starters. */
function league(mine, theirs = []) {
  const id = leagueSeq++;
  const payload = { teams: [
    { id: 1, name: 'Mine', roster: { entries: mine.map(p => p.entry) } },
    { id: 2, name: 'Rival', roster: { entries: theirs.map(p => p.entry) } }
  ] };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, 'espn', ?, 2026, 'Lineup diff', '1', 2, 1, ?, ?)`,
  id, `ld-${id}`, JSON.stringify(['QB', 'RB', 'WR', 'TE']), JSON.stringify(payload));
  const lg = db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
  const assets = new Map([...mine, ...theirs].map(p => [p.asset.id, p.asset]));
  return { lg, assets };
}

/** QB, WR and TE set correctly; the RB decision is the variable. */
function rbDecision(startedPts, benchedPts, extra = {}) {
  return [
    player('Quarterback', 'QB', 18),
    player('Started Back', 'RB', startedPts, extra.started ?? {}),
    player('Benched Back', 'RB', benchedPts, { slot: 'BENCH', ...(extra.benched ?? {}) }),
    player('Wideout', 'WR', 14),
    player('Tight End', 'TE', 8)
  ];
}
const inbox = lgId => rows(`SELECT * FROM decision_recommendations WHERE league_id = ? AND type = 'lineup'`, lgId);

test('a 3.0-point swap is right 58% of the time: urgency low, nothing published', () => {
  const { lg, assets } = league(rbDecision(10, 13));
  const d = lineupDiff(lg, '1', { assets });
  assert.equal(d.swaps.length, 1);
  const [s] = d.swaps;
  assert.equal(s.gap, 3);
  assert.equal(s.p_right, +phi(3 / 14.5).toFixed(3));
  assert.equal(s.p_right, 0.582);
  assert.equal(s.p_basis, 'projected_gap');
  assert.equal(s.urgency, 'low');
  assert.equal(inbox(lg.id).length, 0, 'a coin-flip swap is not a decision');
});

test('a 4.0-point swap is medium (0.609) and publishes one open row', () => {
  const { lg, assets } = league(rbDecision(10, 14));
  const d = lineupDiff(lg, '1', { assets });
  assert.equal(d.swaps[0].p_right, 0.609);
  assert.equal(d.swaps[0].urgency, 'medium');
  const open = inbox(lg.id).filter(r => r.status === 'open');
  assert.equal(open.length, 1);
  assert.equal(open[0].urgency, 'medium');
});

test('a 10.0-point swap is high (0.755)', () => {
  const { lg, assets } = league(rbDecision(6, 16));
  const d = lineupDiff(lg, '1', { assets });
  assert.equal(d.swaps[0].p_right, 0.755);
  assert.equal(d.swaps[0].urgency, 'high');
  assert.equal(d.urgency, 'high');
});

test('filling a slot left empty by an IR-slot starter is priced at the newcomer\'s chance to play', () => {
  const roster = [
    player('Quarterback', 'QB', 18),
    player('Injured Back', 'RB', 15, { slot: 'IR', status: 'INJURY_RESERVE' }),
    player('Healthy Back', 'RB', 9, { slot: 'BENCH', ap: 0.8 }),
    player('Wideout', 'WR', 14),
    player('Tight End', 'TE', 8)
  ];
  const { lg, assets } = league(roster);
  const d = lineupDiff(lg, '1', { assets });
  assert.equal(d.swaps.length, 1);
  assert.equal(d.swaps[0].in.name, 'Healthy Back');
  assert.equal(d.swaps[0].out, null, 'the slot was empty');
  assert.equal(d.swaps[0].p_basis, 'active_probability');
  assert.equal(d.swaps[0].p_right, 0.8);
  assert.equal(d.swaps[0].urgency, 'high');
});

test('an open lineup row is retired as superseded when only low swaps remain', () => {
  const { lg, assets } = league(rbDecision(6, 16));
  lineupDiff(lg, '1', { assets });
  assert.equal(inbox(lg.id).filter(r => r.status === 'open').length, 1);
  // The benched back's projection drops: the swap is now a 2-point coin flip.
  [...assets.values()].find(a => a.name === 'Benched Back').current_week_ppg = 8;
  const d = lineupDiff(lg, '1', { assets });
  assert.equal(d.swaps[0].urgency, 'low');
  const [row] = inbox(lg.id);
  assert.equal(row.status, 'expired');
  assert.match(row.outcome, /^superseded/);
});

test('an IR-slot player ESPN lists as active is offered for activation, never as a swap', () => {
  const roster = [
    player('Quarterback', 'QB', 18),
    player('Started Back', 'RB', 10),
    player('Returning Back', 'RB', 17, { slot: 'IR', status: 'ACTIVE' }),
    player('Wideout', 'WR', 14),
    player('Tight End', 'TE', 8)
  ];
  const { lg, assets } = league(roster);
  const d = lineupDiff(lg, '1', { assets });
  assert.deepEqual(d.swaps, [], 'he cannot be started from the IR slot');
  assert.deepEqual(d.activate_from_ir.map(p => p.name), ['Returning Back']);
});

test('a started player the news scan flags out while ESPN says ACTIVE is listed as a disagreement', () => {
  const { lg, assets } = league(rbDecision(12, 9, { started: { available: false, status: 'ACTIVE' } }));
  const d = lineupDiff(lg, '1', { assets });
  assert.equal(d.flagged_starters.length, 1);
  assert.equal(d.flagged_starters[0].name, 'Started Back');
  assert.equal(d.flagged_starters[0].espn_disagrees, true);
  // A swap against a sure zero is priced at the newcomer's own chance to play.
  assert.equal(d.swaps[0].p_basis, 'active_probability');
});

// ---------------------------------------------------------------- whose roster

test('a team_id that is not in the league is a not-found error and writes nothing', () => {
  const { lg, assets } = league(rbDecision(6, 16), rbDecision(6, 16));
  const d = lineupDiff(lg, 'not-a-team', { assets });
  assert.ok(d.error, 'no silent fallback to the first roster');
  assert.equal(d.not_found, true);
  assert.equal(inbox(lg.id).length, 0);
});

test('a rival roster is computed for display but never published to Nick\'s inbox', () => {
  const rival = rbDecision(6, 16);
  const { lg, assets } = league(rbDecision(12, 12.5), rival);
  const d = lineupDiff(lg, '2', { assets });
  assert.equal(d.swaps[0].urgency, 'high', 'the rival has a high-urgency swap');
  assert.equal(inbox(lg.id).length, 0, 'but it is not Nick\'s decision');
  // And a rival view never retires Nick's own open row.
  const mine = league(rbDecision(6, 16), rbDecision(12, 12.5));
  lineupDiff(mine.lg, '1', { assets: mine.assets });
  lineupDiff(mine.lg, '2', { assets: mine.assets });
  assert.equal(inbox(mine.lg.id).filter(r => r.status === 'open').length, 1);
});

test('with no team_id the card is Nick\'s own roster', () => {
  const { lg, assets } = league(rbDecision(6, 16), rbDecision(12, 12.5));
  const d = lineupDiff(lg, undefined, { assets });
  assert.equal(d.swaps[0].in.name, 'Benched Back');
  assert.equal(inbox(lg.id).filter(r => r.status === 'open').length, 1);
});
