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
 *  C6 FIX-229-1, the real call site: tradeIdeas hands counterpartyLayer the cached
 *     HORIZON_SIM run and the payload bye crunch, so a 0-4 team with no title
 *     path reads seller on the deals against it; off, nothing is built.
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
// C6's fixture league sits in week 5: four games played.
process.env.NFL_WEEK = '5';
delete process.env.GRIDIRON_CLONE01A_ENABLED;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const { run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const pricing = await import('../server/services/counterparty-pricing.js');
const { rows } = await import('../server/db/index.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
// Side-effect imports the trade engine relies on (see test/trade-engine-correctness.test.js).
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const engine = await import('../server/services/trade-engine.js');
const { deriveFormat } = await import('../server/services/format.js');
await runMigrations();
seedIfEmpty();

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

/* ---------------- C6: MOTIVE through the real call site (trade-engine.js) */

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
// ESPN lineupSlotId per roster position; the 8th player sits on the bench.
const SLOT_IDS = [0, 2, 2, 4, 4, 6, 23, 20];

/** Six ESPN teams in week 5: 1-5 balanced; 6 is 0-4 on a roster of backups. */
function motiveLeague(id) {
  const pick = (pos, n) => rows(`SELECT id, name, position FROM players WHERE position = ? AND fantasy_relevant = 1
                                 ORDER BY id LIMIT ?`, pos, n);
  const qb = pick('QB', 6), rb = pick('RB', 19), wr = pick('WR', 18), te = pick('TE', 6);
  const star = rb.pop();
  const ranked = [star, ...qb, ...rb, ...wr, ...te];
  const { formatKey } = deriveFormat({ team_count: 6, ppr: null, league_type: null, best_ball: 0, payload: null,
    roster_positions: JSON.stringify(SLOTS) });
  const now = new Date().toISOString();
  // Starters on teams 1-5 project ~300; team 6's roster ~60, plus one star (the ladder's target).
  const weak = new Set([qb[5], rb[15], rb[16], rb[17], wr[15], wr[16], wr[17], te[5]].map(p => p.id));
  ranked.forEach((p, i) => {
    const proj = p.id === star.id ? 400 : weak.has(p.id) ? 60 : 320 - i * 2;
    run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games, raw, fetched_at)
         VALUES (?, 2026, 'projected', ?, 17, '{}', ?)
         ON CONFLICT(player_id, season, kind) DO UPDATE SET fantasy_points = excluded.fantasy_points`, p.id, proj, now);
    run(`INSERT INTO dynasty_values (format_key, player_id, value, redraft_value, trend30, age, pos_rank, fetched_at)
         VALUES (?, ?, ?, ?, 0, 26, ?, ?)
         ON CONFLICT(format_key, player_id) DO UPDATE SET value = excluded.value, redraft_value = excluded.redraft_value`,
    formatKey, p.id, Math.round(proj * 3), Math.round(proj * 3), i + 1, now);
  });
  const rosters = [0, 1, 2, 3, 4].map(i => [qb[i], rb[i], rb[9 - i], wr[i], wr[9 - i], te[i], rb[10 + i], wr[10 + i]]);
  rosters.push([qb[5], rb[15], rb[16], wr[15], wr[16], te[5], rb[17], star]);
  // Team 5 has two starters on bye in week 5: the bye crunch the payload must show.
  for (const p of [rosters[4][1], rosters[4][3]]) run('UPDATE players SET bye_week = 5 WHERE id = ?', p.id);
  let fake = 950000 + id * 100;
  const teams = rosters.map((roster, i) => ({ id: i + 1, name: `Team ${i + 1}`, owners: [`{M${i + 1}}`],
    roster: { entries: roster.map((p, k) => ({ lineupSlotId: SLOT_IDS[k],
      playerPoolEntry: { player: { id: fake++, fullName: p.name, defaultPositionId: POS_ID[p.position] } } })) } }));
  const schedule = [];
  const ids = [1, 2, 3, 4, 5, 6];
  for (let w = 1; w <= 14; w++) {
    const rot = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + w - 1) % 5)])];
    for (let i = 0; i < 3; i++) {
      const home = rot[i], away = rot[5 - i];
      const done = w <= 4;
      const pts = t => (t === 6 ? 60 : 120 + t);
      schedule.push({ matchupPeriodId: w,
        home: { teamId: home, totalPoints: done ? pts(home) : undefined },
        away: { teamId: away, totalPoints: done ? pts(away) : undefined } });
    }
  }
  const payload = { teams, schedule,
    members: teams.map(t => ({ id: t.owners[0], firstName: `First${t.id}`, lastName: `Last${t.id}` })),
    settings: { name: 'Motive League', scheduleSettings: { matchupPeriodCount: 14, matchupPeriodLength: 1,
      playoffTeamCount: 4, playoffMatchupPeriodLength: 1,
      playoffReseed: false, playoffSeedingRule: 'TOTAL_POINTS_SCORED', divisions: [{ id: 0, size: 6 }] } } };
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, 2026, 'Motive League', ?, 6, '1', ?, 'x', 'y', 'connected')`,
  id, `espn-motive-${id}`, JSON.stringify(payload), JSON.stringify(SLOTS));
  // The standings and dead-starter signals the refresh writes; roster 5 has two out.
  const sig = (roster, metric, value, n, source) =>
    run(`INSERT OR REPLACE INTO manager_signals (league_id, roster_id, metric, value, n, source, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`, id, String(roster), metric, value, n, source);
  for (let t = 1; t <= 6; t++) {
    const wins = t === 6 ? 0 : [4, 3, 3, 2, 2][t - 1];
    sig(t, 'standing_wins', wins, 4, 'standings');
    sig(t, 'standing_losses', 4 - wins, 4, 'standings');
    if (t === 6) sig(t, 'standing_streak', -4, 4, 'standings');
  }
  sig(5, 'lineup_dead_starters', 2, 7, 'roster');
  return rows('SELECT * FROM leagues WHERE id = ?', id)[0];
}

test('C6 FIX-229-1: tradeIdeas wires the cached sim and bye crunch, and a 0-4 team reads seller', () => {
  const lg = motiveLeague(9102);
  // The simulator's own answer: team 6 has no title path.
  const sim = engine.horizonSim(lg);
  assert.ok(!sim.error, sim.error);
  const six = sim.teams.find(t => String(t.roster_id) === '6');
  assert.ok(six.title_odds < pricing.MOTIVE_RULES.seller_odds, `team 6 title odds ${six.title_odds}`);
  // The same cached object is what the call site hands in.
  assert.equal(engine.horizonSim(lg), sim);
  // Bye crunch from the payload lineup and players.bye_week.
  const crunch = engine.byeCrunchByRoster(lg, engine.assetUniverse(lg, deriveFormat(lg).formatKey), 5);
  assert.equal(crunch.get('5'), 2);
  assert.equal(crunch.get('6'), 0);

  // Call site 1, findTrades: every deal's counterparty block carries a live motive.
  const out = withFlag('1', () => engine.tradeIdeas(lg, { myTeamId: '1', requireMutual: false, limit: 500 }));
  assert.ok(!out.error, out.error);
  assert.ok(out.deals.length > 0);
  for (const d of out.deals) {
    assert.ok(d.counterparty.motive, `deal with ${d.partner_id} has no motive`);
    assert.ok(Number.isFinite(d.counterparty.motive.title_odds), JSON.stringify(d.counterparty.motive));
  }
  const m5 = out.deals.find(d => d.partner_id === '5')?.counterparty.motive;
  if (m5) {
    assert.equal(m5.bye_crunch, 2);
    assert.equal(m5.starters_out, 2);
  }
  // Call site 2, the offer ladder: team 6 (0-4, no title path) reads seller.
  const target = rows('SELECT id FROM players WHERE name = ? ORDER BY id LIMIT 1',
    JSON.parse(lg.payload).teams[5].roster.entries[7].playerPoolEntry.player.fullName)[0].id;
  const offer = withFlag('1', () => engine.offerFor(lg, { myTeamId: '1', targetId: target }));
  assert.ok(!offer.error, offer.error);
  assert.equal(offer.owner_id, '6');
  const m6 = offer.counterparty.motive;
  assert.equal(m6.state, 'seller', JSON.stringify(m6));
  assert.equal(m6.n, 4);
  assert.equal(m6.loss_streak, 4);
  assert.equal(m6.bye_crunch, 0);
  assert.equal(m6.priced, false);
});

test('C6b FIX-229-1: flag off, the call site builds nothing and deals carry motive null', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 9102')[0];
  const out = withFlag(null, () => engine.tradeIdeas(lg, { myTeamId: '1', requireMutual: false, limit: 500 }));
  assert.ok(!out.error, out.error);
  assert.ok(out.deals.length > 0);
  for (const d of out.deals) assert.equal(d.counterparty.motive ?? null, null);
  const target = rows('SELECT id FROM players WHERE name = ? ORDER BY id LIMIT 1',
    JSON.parse(lg.payload).teams[5].roster.entries[7].playerPoolEntry.player.fullName)[0].id;
  assert.equal(withFlag(null, () => engine.offerFor(lg, { myTeamId: '1', targetId: target })).counterparty.motive, null);
});
