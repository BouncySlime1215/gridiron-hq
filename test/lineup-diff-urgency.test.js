/**
 * The League Hub lineup card (trade-engine.js#lineupDiff): how sure each swap is and
 * what urgency that sets.
 *
 * It used to also pin what each urgency WROTE to the Decision Inbox, interleaved into
 * the same assertions. The inbox is retired — its routes and mount are gone, nothing
 * ever read it, and both publishers are removed — so those halves are gone with it and
 * the urgency model they were tangled with is untouched. What replaces them is one
 * explicit test at the end: lineupDiff writes nothing, at any urgency. That is a
 * stronger statement than four scattered counts, and it is the one that would catch a
 * publisher being quietly reintroduced.
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
 * a not-found error, where it used to fall back to teams[0] — a rival's roster shown as
 * yours. That rule is live and unaffected. Its companion, "only Nick's own roster
 * publishes to his inbox", described a behaviour that no longer exists in either half,
 * and is not restated here as though it did.
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
});

test('a 4.0-point swap is medium (0.609)', () => {
  const { lg, assets } = league(rbDecision(10, 14));
  const d = lineupDiff(lg, '1', { assets });
  assert.equal(d.swaps[0].p_right, 0.609);
  assert.equal(d.swaps[0].urgency, 'medium');
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

test('a swap that was high drops to low when the projection behind it drops', () => {
  // This was "an open lineup row is retired as superseded when only low swaps
  // remain". The retirement was the inbox's; the half worth keeping is that the
  // card re-reads the projection and re-prices the same swap rather than holding
  // on to the verdict it gave a moment ago.
  const { lg, assets } = league(rbDecision(6, 16));
  assert.equal(lineupDiff(lg, '1', { assets }).swaps[0].urgency, 'high');
  // The benched back's projection drops: the swap is now a 2-point coin flip.
  [...assets.values()].find(a => a.name === 'Benched Back').current_week_ppg = 8;
  const d = lineupDiff(lg, '1', { assets });
  assert.equal(d.swaps[0].urgency, 'low');
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

test('a team_id that is not in the league is a not-found error', () => {
  const { lg, assets } = league(rbDecision(6, 16), rbDecision(6, 16));
  const d = lineupDiff(lg, 'not-a-team', { assets });
  assert.ok(d.error, 'no silent fallback to the first roster');
  assert.equal(d.not_found, true);
});

test('a rival roster is computed for display, on the rival\'s own numbers', () => {
  const { lg, assets } = league(rbDecision(12, 12.5), rbDecision(6, 16));
  const d = lineupDiff(lg, '2', { assets });
  assert.equal(d.swaps[0].urgency, 'high', 'the rival has a high-urgency swap');
  // And asking for the rival does not change what my own card says.
  assert.equal(lineupDiff(lg, '1', { assets }).swaps[0].urgency, 'low');
});

test('with no team_id the card is Nick\'s own roster', () => {
  const { lg, assets } = league(rbDecision(6, 16), rbDecision(12, 12.5));
  const d = lineupDiff(lg, undefined, { assets });
  assert.equal(d.swaps[0].in.name, 'Benched Back');
  assert.equal(d.swaps[0].urgency, 'high', "and it is priced on my roster, not the rival's");
});

/* ------------------------------------------------------- nothing is published */

test('lineupDiff writes nothing to the Decision Inbox, at any urgency', () => {
  // One statement in place of the four counts that used to sit inside the
  // urgency tests above. It sweeps every urgency the model can produce, including
  // the high one that was the only case that ever published, and the sequence
  // that used to retire a row — so a publisher reintroduced at any of those
  // points fails here rather than passing quietly because the case it was added
  // back into happened not to be asserted.
  const before = rows(`SELECT COUNT(*) AS n FROM decision_recommendations`)[0].n;
  for (const [started, benched] of [[10, 13], [10, 14], [6, 16], [12, 12.5]]) {
    const { lg, assets } = league(rbDecision(started, benched));
    lineupDiff(lg, '1', { assets });
    // And again after the projection moves, which is the path that used to expire
    // an open row with a hand-written UPDATE.
    [...assets.values()].find(a => a.name === 'Benched Back').current_week_ppg = 8;
    lineupDiff(lg, '1', { assets });
    assert.equal(inbox(lg.id).length, 0,
      `lineupDiff published for a ${started}/${benched} roster`);
  }
  assert.equal(rows(`SELECT COUNT(*) AS n FROM decision_recommendations`)[0].n, before,
    'no row of any type was written');
});
