/**
 * A player the market has no price for is not worth nothing.
 *
 * `assetUniverse` builds each asset from two joins: the projection row and the
 * market row. When the market row is missing it writes `value: m?.value ?? 0`
 * (trade-engine.js:419) — and one line below, from the SAME missing row, it
 * writes `pos_rank: m?.pos_rank ?? null`. So the file already knows the
 * difference between "absent" and "zero"; `value` is the one field that spends
 * it.
 *
 * The consequence is not cosmetic. `evaluate`'s `side()` sums
 * `Math.max(0, p.value)` into `value_out` and `value_in`, and `fairnessLabel`
 * divides the difference by the total. A package containing an unpriced player
 * therefore moves the total by exactly zero: he leaves your roster for free.
 *
 * MEASURED, not predicted: the RED run on the fixture below gives away team 1's
 * unpriced WR1 for a priced WR from team 2 and the engine returns
 * `fairness: 'lopsided my way'`. Not "even money" — which is what I expected
 * before running it — but the strictly worse reading: the deal is reported as a
 * robbery IN MY FAVOUR, because the only thing I gave up counted as nothing. A
 * manager acting on that sends the offer with confidence.
 *
 * Who is unpriced in practice: anyone FantasyCalc has no dynasty row for on this
 * league's format key — a late rookie, a practice-squad call-up who just got
 * carries, a kicker or defence in a format that prices neither. Exactly the
 * players a manager is most likely to be handed as a throw-in.
 *
 * These tests seed a league where one rostered player has a projection and no
 * market row, which is the real shape of the bug and not a synthetic one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-unpriced-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
// The same side-effect imports the other trade fixtures use: ~40 files create
// their tables on import.
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const {
  assetUniverse, loadRosters, lineupSlots, evaluate
} = await import('../server/services/trade-engine.js');
const { deriveFormat } = await import('../server/services/format.js');

await runMigrations();
seedIfEmpty();

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------------------ fixture */

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
const entry = (player, fakeId) =>
  ({ playerPoolEntry: { player: { id: fakeId, fullName: player.name, defaultPositionId: POS_ID[player.position] } } });
const pool = (position, n) => rows(`SELECT id, name, position FROM players
  WHERE position = ? AND fantasy_relevant = 1 ORDER BY id LIMIT ?`, position, n);

const { formatKey } = deriveFormat({
  team_count: 6, ppr: null, league_type: null, best_ball: 0, payload: null,
  roster_positions: JSON.stringify(SLOTS)
});

/**
 * Every player gets a projection. Everyone EXCEPT the ids in `unpriced` also
 * gets a market row — that omission is the whole fixture, and it is the real
 * shape of the defect rather than a synthetic null written into an asset.
 */
function seedMarket(players, unpriced = new Set()) {
  const now = new Date().toISOString();
  players.forEach((p, i) => {
    const proj = 320 - i * 3;
    run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games, raw, fetched_at)
         VALUES (?, 2026, 'projected', ?, 17, '{}', ?)
         ON CONFLICT(player_id, season, kind) DO UPDATE SET fantasy_points = excluded.fantasy_points`,
    p.id, proj, now);
    if (unpriced.has(p.id)) return;
    run(`INSERT INTO dynasty_values (format_key, player_id, value, redraft_value, trend30, age, pos_rank, fetched_at)
         VALUES (?, ?, ?, ?, 0, 26, ?, ?)
         ON CONFLICT(format_key, player_id) DO UPDATE SET value = excluded.value, redraft_value = excluded.redraft_value`,
    formatKey, p.id, Math.round(proj * 3), Math.round(proj * 3), i + 1, now);
  });
}

function sixTeamLeague(unpriced) {
  const qb = pool('QB', 6), rb = pool('RB', 18), wr = pool('WR', 18), te = pool('TE', 6);
  seedMarket([...qb, ...rb, ...wr, ...te], unpriced);
  let fakeId = 700000;
  const teams = [];
  for (let i = 0; i < 6; i++) {
    const roster = [qb[i], rb[i], rb[i + 6], rb[i + 12], wr[i], wr[i + 6], wr[i + 12], te[i]].filter(Boolean);
    teams.push({ id: i + 1, name: `Team ${i + 1}`, roster: { entries: roster.map(p => entry(p, fakeId++)) } });
  }
  return { teams, settings: { name: 'Unpriced League' } };
}

function buildLeague(id, unpriced) {
  const payload = sixTeamLeague(unpriced);
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, 2026, 'Unpriced League', ?, 6, '1', ?, 'x', 'y', 'connected')`,
  id, `espn-unpriced-${id}`, JSON.stringify(payload), JSON.stringify(SLOTS));
  return rows('SELECT * FROM leagues WHERE id = ?', id)[0];
}

/** The WR on team 1 whose market row was deliberately never written. */
function setup(leagueId) {
  const wr = pool('WR', 18);
  const victim = wr[0];                       // team 1's WR1 — a real starter, not a scrub
  const lg = buildLeague(leagueId, new Set([victim.id]));
  const { formatKey: fk } = deriveFormat(lg);
  const assets = assetUniverse(lg, fk);
  const teams = loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  const mine = teams.find(t => String(t.roster_id) === '1');
  const theirs = teams.find(t => String(t.roster_id) === '2');
  const unpricedAsset = mine.players.find(p => p.id === victim.id);
  return { lg, assets, teams, slots, mine, theirs, unpricedAsset, victim };
}

/* -------------------------------------------------------------------- tests */

test('the asset says whether the market priced this player, not just what it said', () => {
  const { unpricedAsset, mine } = setup(601);
  assert.ok(unpricedAsset, 'the fixture must put the unpriced player on team 1');
  // The claim: absence is representable. Today `value` is 0 and nothing else on
  // the asset distinguishes him from a player the market priced AT zero.
  assert.equal(unpricedAsset.value_priced, false,
    'an asset built from a missing market row must say the price is absent');
  const priced = mine.players.find(p => p.id !== unpricedAsset.id && p.value > 0);
  assert.equal(priced.value_priced, true, 'a player with a market row must say so');
});

test('a package containing an unpriced player does not report a confident fairness', () => {
  const { slots, mine, theirs, unpricedAsset } = setup(602);
  const theirPiece = theirs.players.find(p => p.position === 'WR' && p.value > 0);
  assert.ok(theirPiece, 'the fixture must give team 2 a priced WR to send back');

  const ev = evaluate(
    { team: mine, gives: [unpricedAsset] },
    { team: theirs, gives: [theirPiece] },
    slots
  );

  // The defect: my side gives away a player the market cannot price, my
  // `value_out` does not move, and the label is computed as though nothing left.
  // On this fixture that reads 'lopsided my way' — the engine recommending a
  // deal precisely because it could not see what it cost.
  assert.notEqual(ev.fairness, 'lopsided my way',
    'a deal whose give side is unpriced cannot be scored as a win for me');
  assert.match(String(ev.fairness), /unpriced|not priced/i,
    `fairness must name the gap rather than guess past it (got: ${ev.fairness})`);
});

test('the count of unpriced players travels with the numbers they break', () => {
  const { slots, mine, theirs, unpricedAsset } = setup(603);
  const theirPiece = theirs.players.find(p => p.position === 'WR' && p.value > 0);
  const ev = evaluate(
    { team: mine, gives: [unpricedAsset] },
    { team: theirs, gives: [theirPiece] },
    slots
  );
  // Not a boolean on the deal, and not one number per side either: the first
  // draft of this test asked for `value_unpriced` per side and the code answered
  // 1 on BOTH, correctly — in a two-party deal each side sees the same union of
  // players, so a per-side count of gives+gets is the same number twice. What
  // actually distinguishes anything is which LEG the unpriced player is on, so
  // each total carries the count of the leg that feeds it.
  assert.equal(ev.me.value_out_unpriced, 1, 'I gave away one player the market cannot price');
  assert.equal(ev.me.value_in_unpriced, 0, 'nothing unpriced came back to me');
  // The same player, seen from the other chair: he is arriving, so it is THEIR
  // value_in that is understated, not their value_out.
  assert.equal(ev.them.value_out_unpriced, 0, 'they gave away nothing unpriced');
  assert.equal(ev.them.value_in_unpriced, 1, 'they received the unpriced player');
});

test('a fully priced deal is unchanged — the label and the totals still read as before', () => {
  const { slots, mine, theirs, unpricedAsset } = setup(604);
  const myPriced = mine.players.find(p => p.id !== unpricedAsset.id && p.value > 0);
  const theirPiece = theirs.players.find(p => p.value > 0);
  const ev = evaluate(
    { team: mine, gives: [myPriced] },
    { team: theirs, gives: [theirPiece] },
    slots
  );
  assert.equal(ev.me.value_out_unpriced, 0);
  assert.equal(ev.me.value_in_unpriced, 0);
  assert.equal(ev.them.value_out_unpriced, 0);
  assert.equal(ev.them.value_in_unpriced, 0);
  // The regression half: nothing about a normal deal may change. The label must
  // still be one of the five it always was.
  assert.match(String(ev.fairness),
    /^(lopsided my way|slightly my way|even money|slightly their way|lopsided their way|unpriced)$/,
    `a fully priced deal must keep its ordinary label (got: ${ev.fairness})`);
  assert.equal(ev.me.value_out, Math.max(0, myPriced.value));
  assert.equal(ev.me.value_in, Math.max(0, theirPiece.value));
});
