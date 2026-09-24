/**
 * trade-engine-correctness — the gates in
 * scratchpad/wa/trade-engine-correctness/GATE.md, written before this file.
 *
 * Everything here is deterministic and offline: a temp DB, the lightweight
 * seed, a hand-built six-team ESPN payload with a real round-robin schedule
 * (so the season simulator has fixtures to run), and a chat DB fixture so the
 * counterparty layer has something to read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-trade-correctness-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'chat.sqlite');
process.env.SCHEDULER_DISABLED = '1';
// The engine's "this week" comes from game_lines on a real DB; pinned here so
// the horizon split and the simulator's starting week are the same every run.
process.env.NFL_WEEK = '2';

const CHAT_PATH = process.env.GRIDIRON_CHAT_DB_PATH;

/**
 * The private chat corpus the counterparty layer reads: one manager who loves a
 * player and one who has soured on another, so perception is informed for some
 * deals and genuinely uninformed for others.
 */
function buildChatFixture(file) {
  const chat = new DatabaseSync(file);
  chat.exec(`CREATE TABLE manager_chat_profile (name TEXT PRIMARY KEY, messages INTEGER,
    trade_talk_rate REAL, open_to_trade_rate REAL, own_untouchable_rate REAL, first_seen TEXT, last_seen TEXT);
    CREATE TABLE manager_player_sentiment (name TEXT, player TEXT, sentiment REAL, mentions INTEGER, last_seen TEXT);
    CREATE TABLE jev_chat_signals (message_id TEXT, speaker TEXT, scope TEXT, entity TEXT, signal TEXT,
      confidence REAL, observed_at TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, ts TEXT, sender TEXT, text TEXT);
    CREATE TABLE negotiation_profiles (name TEXT PRIMARY KEY, profile_json TEXT, messages_read INTEGER,
      corpus_hash TEXT, model TEXT, built_at TEXT);`);
  const prof = chat.prepare(`INSERT INTO manager_chat_profile VALUES (?,?,?,?,?,?,?)`);
  prof.run('Alpha One', 400, 0.30, 0.30, 0.02, '2026-08-01', '2026-09-17');
  prof.run('Beta Two', 400, 0.10, 0.10, 0.20, '2026-08-01', '2026-09-17');
  chat.close();
}
buildChatFixture(CHAT_PATH);

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
// Side-effect imports: the same "~40 files create tables on import" wiring the
// rest of the suite relies on (see test/find-trades.test.js).
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const engine = await import('../server/services/trade-engine.js');
const { deriveFormat } = await import('../server/services/format.js');
const { horizonWeights, leagueSchedule } = await import('../server/services/trade-horizon.js');
const { simulateSeason } = await import('../server/services/season-sim.js');
const { withRandomSeed } = await import('../server/services/stats-util.js');
const { scoringFor } = await import('../server/services/scoring.js');

await runMigrations();
seedIfEmpty();

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------------------ fixture */

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];

function seedMarket(players) {
  const { formatKey } = deriveFormat({ team_count: 6, ppr: null, league_type: null, best_ball: 0, payload: null,
    roster_positions: JSON.stringify(SLOTS) });
  const now = new Date().toISOString();
  players.forEach((p, i) => {
    const proj = 320 - i * 3;
    run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games, raw, fetched_at)
         VALUES (?, 2026, 'projected', ?, 17, '{}', ?)
         ON CONFLICT(player_id, season, kind) DO UPDATE SET fantasy_points = excluded.fantasy_points`, p.id, proj, now);
    run(`INSERT INTO dynasty_values (format_key, player_id, value, redraft_value, trend30, age, pos_rank, fetched_at)
         VALUES (?, ?, ?, ?, 0, 26, ?, ?)
         ON CONFLICT(format_key, player_id) DO UPDATE SET value = excluded.value, redraft_value = excluded.redraft_value`,
    formatKey, p.id, Math.round(proj * 3), Math.round(proj * 3), i + 1, now);
  });
}

/** Round-robin fixtures for six teams over `weeks` matchup periods. */
function schedule(weeks) {
  const out = [];
  const ids = [1, 2, 3, 4, 5, 6];
  for (let w = 1; w <= weeks; w++) {
    const rot = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + w - 1) % 5)])];
    for (let i = 0; i < 3; i++) {
      const home = rot[i], away = rot[5 - i];
      const done = w === 1;
      out.push({ matchupPeriodId: w,
        home: { teamId: home, totalPoints: done ? 110 + home : undefined },
        away: { teamId: away, totalPoints: done ? 100 + away : undefined } });
    }
  }
  return out;
}

let fakeId = 900000;
function sixTeamLeague(ownerNames = null) {
  const pick = (pos, n) => rows(`SELECT id, name, position FROM players WHERE position = ? AND fantasy_relevant = 1
                                 ORDER BY id LIMIT ?`, pos, n);
  const qb = pick('QB', 6), rb = pick('RB', 18), wr = pick('WR', 18), te = pick('TE', 6);
  seedMarket([...qb, ...rb, ...wr, ...te]);
  const teams = [];
  for (let i = 0; i < 6; i++) {
    // Snaked so every team's index-sum is identical (i + (5-i) + (23+i) + (28-i) = 56):
    // a balanced league, which is what makes both playoff odds and mutual deals real.
    const roster = [qb[i], rb[i], rb[11 - i], rb[12 + i], wr[5 - i], wr[6 + i], wr[17 - i], te[5 - i]].filter(Boolean);
    teams.push({ id: i + 1, name: `Team ${i + 1}`, owners: [`{M${i + 1}}`],
      roster: { entries: roster.map(p => ({
        playerPoolEntry: { player: { id: fakeId++, fullName: p.name, defaultPositionId: POS_ID[p.position] } } })) } });
  }
  const members = teams.map((t, i) => ({ id: t.owners[0],
    firstName: ownerNames?.[i]?.split(' ')[0] ?? `First${t.id}`,
    lastName: ownerNames?.[i]?.split(' ')[1] ?? `Last${t.id}` }));
  return { teams, members, schedule: schedule(14),
    settings: { name: 'TC League', scheduleSettings: { matchupPeriodCount: 14, matchupPeriodLength: 1,
      playoffTeamCount: 4, playoffMatchupPeriodLength: 1,
      // CE-05: the simulator refuses a league whose rules are incomplete.
      playoffReseed: false, playoffSeedingRule: 'TOTAL_POINTS_SCORED', divisions: [{ id: 0, size: 6 }] } } };
}

function insertLeague(id, payload) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, 2026, 'TC League', ?, 6, '1', ?, 'x', 'y', 'connected')`,
  id, `espn-tc-${id}`, JSON.stringify(payload), JSON.stringify(SLOTS));
  return rows('SELECT * FROM leagues WHERE id = ?', id)[0];
}

/** A player on somebody else's roster, chosen without going through the finder. */
function targetOnAnotherRoster(lg, myTeamId) {
  const payload = JSON.parse(lg.payload);
  const them = payload.teams.find(t => String(t.id) !== String(myTeamId));
  const name = them.roster.entries[1].playerPoolEntry.player.fullName;
  const id = rows('SELECT id FROM players WHERE name = ? ORDER BY id LIMIT 1', name)[0]?.id;
  assert.ok(id, `no player row for ${name}`);
  return id;
}

/* ---------------------------------------------------- G1: real playoff odds */

test('RL-16-1: the entry point passes this league\'s shape to the playoff-week weight (6/4 stays unmeasured)', () => {
  const lg = insertLeague(409, sixTeamLeague());
  const prev = process.env.GRIDIRON_RL16_1_ENABLED;
  process.env.GRIDIRON_RL16_1_ENABLED = '1';
  try {
    const out = engine.tradeIdeas(lg, { myTeamId: '1', limit: 10, requireMutual: false });
    assert.ok(!out.error, out.error);
    assert.ok(out.deals.length > 0, 'fixture must produce deals');
    for (const d of out.deals) {
      assert.equal(d.horizon.playoff_importance, 4);
      assert.equal(d.horizon.playoff_importance_measured, false);
      // "6-team/4-playoff", not "?-team/?-playoff": the shape came from this league.
      assert.match(d.horizon.playoff_importance_source, /6-team\/4-playoff/);
    }
  } finally {
    if (prev == null) delete process.env.GRIDIRON_RL16_1_ENABLED;
    else process.env.GRIDIRON_RL16_1_ENABLED = prev;
  }
});

test('G1a: the entry point prices the horizon on this team\'s real playoff odds, not the 0.5 prior', () => {
  const lg = insertLeague(401, sixTeamLeague());
  const out = engine.tradeIdeas(lg, { myTeamId: '1', limit: 10, requireMutual: false });
  assert.ok(!out.error, out.error);
  assert.equal(out.mode, 'league');
  const odds = out.context.playoff_odds;
  assert.ok(Number.isFinite(odds), `playoff_odds missing: ${JSON.stringify(out.context)}`);
  assert.notEqual(odds, 0.5, 'still the never-passed 0.5 default');
  assert.match(out.context.playoff_odds_source, /season simulation/i);
  // The horizon every deal was ranked on must be the one those odds produce.
  const expected = horizonWeights(2, { playoffOdds: odds, ...leagueSchedule(lg) });
  assert.ok(out.deals.length > 0, 'fixture must produce deals');
  for (const d of out.deals) {
    assert.equal(d.horizon.playoff_odds, expected.playoff_odds);
    assert.equal(d.horizon.playoff, expected.playoff);
  }
});

test('G1b: the odds that enter the ranking are seeded, so they never drift between calls', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 401')[0];
  const a = engine.myPlayoffOdds(lg, '1');
  const b = engine.myPlayoffOdds(lg, '1');
  assert.equal(a.value, b.value);
  assert.ok(a.value >= 0 && a.value <= 1, `implausible odds ${a.value}`);
  // It is the simulator's own answer for this roster, not a prior wearing a label.
  const direct = withRandomSeed(20260918, () => simulateSeason(lg, {
    runs: 1000, fromWeek: 2, scoring: scoringFor(lg) }));
  const mine = direct.teams.find(t => String(t.roster_id) === '1');
  assert.equal(a.value, +mine.playoff_odds.toFixed(2));
  assert.match(a.source, /1000 runs from week 2/);
});

test('G1c: a league the simulator cannot run falls back to the prior and says why', () => {
  const payload = sixTeamLeague();
  payload.schedule = [];                       // synced, but no fixtures to simulate
  const lg = insertLeague(402, payload);
  const odds = engine.myPlayoffOdds(lg, '1');
  assert.equal(odds.value, null);
  assert.match(odds.source, /prior/i);
  const out = engine.tradeIdeas(lg, { myTeamId: '1', limit: 5 });
  assert.equal(out.context.playoff_odds, 0.5, 'the documented uninformative prior');
  assert.match(out.context.playoff_odds_source, /prior/i);
});

/* ------------------------------------------ G2: the cache cannot serve stale */

test('G2a: a manager-table change the row count cannot see still busts the trade cache', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 401')[0];
  const before = engine.tradeIdeasFingerprint(lg, { myTeamId: '1' });
  run(`INSERT INTO manager_profiles (league_id, roster_id, tradeability, updated_at)
       VALUES (401, '2', 'fair', '2026-09-18T10:00:00Z')`);
  const added = engine.tradeIdeasFingerprint(lg, { myTeamId: '1' });
  assert.notEqual(added, before, 'a new manager profile did not change the fingerprint');
  // The defect the inventory named: changing a TIER in place adds no row.
  run(`UPDATE manager_profiles SET tradeability='hard', updated_at='2026-09-18T11:00:00Z'
       WHERE league_id=401 AND roster_id='2'`);
  const flipped = engine.tradeIdeasFingerprint(lg, { myTeamId: '1' });
  assert.notEqual(flipped, added, 'a tier flip in place did not change the fingerprint');
  run(`DELETE FROM manager_profiles WHERE league_id=401`);
});

test('G2b/G2c: with nothing changed the cache still hits', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 401')[0];
  const a = engine.tradeIdeas(lg, { myTeamId: '1', limit: 10 });
  const b = engine.tradeIdeas(lg, { myTeamId: '1', limit: 10 });
  assert.equal(a.deals, b.deals, 'the same computation was redone');
});

/* --------------------------------------------- G3: the hard tier, once only */

test('G3: a "hard" manager is discounted 0.55 once, and receptiveness never carries the tier', () => {
  const lg = insertLeague(403, sixTeamLeague());
  const keyOf = d => `${d.partner_id}:${d.i_give.map(p => p.id).sort()}>${d.i_get.map(p => p.id).sort()}`;
  const fair = engine.tradeIdeas(lg, { myTeamId: '1', requireMutual: false, limit: 200 });
  const partner = fair.deals[0]?.partner_id;
  assert.ok(partner, 'fixture must produce a deal');
  const fairDeal = fair.deals.find(d => d.partner_id === partner);
  run(`INSERT INTO manager_profiles (league_id, roster_id, tradeability, updated_at)
       VALUES (403, ?, 'hard', '2026-09-18T12:00:00Z')`, String(partner));
  const hard = engine.tradeIdeas(lg, { myTeamId: '1', requireMutual: false, limit: 200 });
  const hardDeal = hard.deals.find(d => keyOf(d) === keyOf(fairDeal));
  assert.ok(hardDeal, 'the same deal must still be found for a hard manager');
  const ratio = (hardDeal.score_signed + hardDeal.value_cost) / (fairDeal.score_signed + fairDeal.value_cost);
  assert.ok(Math.abs(ratio - 0.55) < 0.002, `expected 0.55, got ${ratio.toFixed(4)} (0.3025 = applied twice)`);
  assert.equal(hardDeal.counterparty.receptiveness, fairDeal.counterparty.receptiveness,
    'the tier leaked into the reported receptiveness');
  assert.equal(hardDeal.manager_tradeability, 'hard');
  run(`DELETE FROM manager_profiles WHERE league_id=403`);
});

/* ------------------------------ G4: perception cannot pay twice for our gap */

test('G4: the perception factor is driven by his view beyond our own value gap', () => {
  // A package he has no opinion on: his "perception" is our own value gap, which
  // the fairness term and the value cost already charge for.
  const uninformed = engine.perceptionFactorFor({ perception_delta: 25, perception_shift: null });
  assert.equal(uninformed, 1, 'an uninformed deal still moved the score');
  const loves = engine.perceptionFactorFor({ perception_delta: 25, perception_shift: 12 });
  assert.ok(loves > 1 && loves <= 1.10, `expected a capped lift, got ${loves}`);
  const sours = engine.perceptionFactorFor({ perception_delta: 25, perception_shift: -12 });
  assert.ok(sours < 1 && sours >= 0.90, `expected a capped discount, got ${sours}`);
  // Capped at +-10% whatever the read says.
  assert.equal(engine.perceptionFactorFor({ perception_shift: 400 }), 1.10);
  assert.equal(engine.perceptionFactorFor({ perception_shift: -400 }), 0.90);
});

/* ------------------------- G5: the best variant of an idea survives filtering */

test('G5: one idea per headline pair is taken AFTER the mutual filter, not before', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 401')[0];
  const strict = engine.tradeIdeas(lg, { myTeamId: '1', requireMutual: true, limit: 300 });
  const relaxed = engine.tradeIdeas(lg, { myTeamId: '1', requireMutual: false, limit: 300 });
  const headline = list => list.slice().sort((x, y) => y.value - x.value)[0]?.id;
  for (const set of [strict, relaxed]) {
    const seen = new Set();
    for (const d of set.deals) {
      const k = `${d.partner_id}:${headline(d.i_give)}>${headline(d.i_get)}`;
      assert.ok(!seen.has(k), `idea ${k} listed twice`);
      seen.add(k);
    }
    for (const d of set.deals) {
      assert.equal(d.red_flags.length, 0);
      assert.ok(d.plausible);
    }
  }
  for (const d of strict.deals) assert.ok(d.mutual, 'requireMutual returned a one-sided deal');
  // Every idea that survives the strict filter must be reachable there: the
  // dedupe must not have spent the idea's slot on a variant the filter rejects.
  const strictKeys = new Set(strict.deals.map(d => `${d.partner_id}:${headline(d.i_give)}>${headline(d.i_get)}`));
  const mutualRelaxed = relaxed.deals.filter(d => d.mutual);
  for (const d of mutualRelaxed) {
    const k = `${d.partner_id}:${headline(d.i_give)}>${headline(d.i_get)}`;
    assert.ok(strictKeys.has(k), `mutual idea ${k} is hidden from the mutual list`);
  }
});

/* --------------------- G6: the ladders read the same table as the league list */

test('G6a/G6c: an offer ladder carries the same horizon the league ideas were ranked on', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 401')[0];
  const league = engine.tradeIdeas(lg, { myTeamId: '1', limit: 10 });
  const wanted = targetOnAnotherRoster(lg, '1');
  const ladder = engine.tradeIdeas(lg, { myTeamId: '1', targets: [wanted], shape: 'single' });
  assert.equal(ladder.mode, 'target');
  assert.equal(ladder.context.playoff_odds, league.context.playoff_odds);
  assert.ok(ladder.offers?.length, `no offers: ${ladder.error ?? ''} ${ladder.reason ?? ''}`);
  for (const o of ladder.offers) {
    assert.ok(Number.isFinite(o.horizon?.value), 'ladder rung has no horizon-weighted gain');
    assert.equal(o.horizon.playoff_odds, league.context.playoff_odds);
  }
  // The "fair" rung is chosen on horizon-weighted gain per unit of value sent.
  for (const o of [...ladder.offers, ...(ladder.alternatives ?? [])]) {
    assert.ok(ladder.fair.efficiency >= o.efficiency,
      `a rung is more efficient than the "fair" one: ${o.efficiency} > ${ladder.fair.efficiency}`);
  }
  assert.ok(ladder.fair.horizon.value > 0);
});

test('G6b: every ladder says what counterparty data it had', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 401')[0];
  const wanted = targetOnAnotherRoster(lg, '1');
  const one = engine.tradeIdeas(lg, { myTeamId: '1', targets: [wanted], shape: 'single' });
  assert.ok(one.counterparty, 'no counterparty block on the ladder');
  assert.equal(typeof one.counterparty.counterparty_data, 'boolean');
  const many = engine.tradeIdeas(lg, { myTeamId: '1', targets: [wanted] });
  assert.equal(many.mode, 'targets');
  for (const l of many.ladders) assert.ok(l.counterparty, 'no counterparty block on a ladder');
});

/* -------------------------------------------- G8: one entry point, no cycles */

test('G8b/G8c: the header names the entry point and the module cycle is safe both ways', async () => {
  const src = fs.readFileSync(new URL('../server/services/trade-engine.js', import.meta.url), 'utf8');
  const header = src.slice(0, src.indexOf('*/'));
  assert.match(header, /tradeIdeas/, 'the entry point is not documented in the header');
  // season-sim imports trade-engine and trade-engine now imports season-sim.
  // Both import orders must evaluate without a temporal-dead-zone throw.
  const sim = await import('../server/services/season-sim.js');
  assert.equal(typeof sim.simulateSeason, 'function');
  assert.equal(typeof engine.tradeIdeas, 'function');
});

test('G8a: the legacy names are thin wrappers over the one entry point', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 401')[0];
  const viaEntry = engine.tradeIdeas(lg, { myTeamId: '1', limit: 10 });
  const viaLegacy = engine.findTrades(lg, { myTeamId: '1', limit: 10 });
  assert.deepEqual(viaLegacy.deals.map(d => d.score_signed), viaEntry.deals.map(d => d.score_signed));
  assert.equal(viaLegacy.context.playoff_odds, viaEntry.context.playoff_odds);
});

/* ------------------------- G9: the ladder's entry gate is the ladder's own number */

/**
 * The bug (verify:trade-engine-correctness, finding 1): `offerFor`/`offerForMany`
 * decided "he would not crack your starting lineup" on a free-add ceiling solved
 * for THIS WEEK, while every rung underneath had already been moved to the
 * horizon-weighted gain. A player who does nothing this Sunday but real work in
 * the playoff weeks — the live case was Ja'Marr Chase, 0.00 now, +0.17
 * horizon-weighted — was refused outright and his ladder never ran.
 *
 * The shape is built here directly rather than fished out of the six-team
 * fixture, whose projections are flat across the season and so can never make
 * the two numbers disagree: the target is on bye this week (`adj_ppg` 0) and
 * carries a full weekly rate for the playoff weeks.
 */
const ladderSlots = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];

function ladderPlayer(id, position, adj, ros, value = 100) {
  return { id, name: `P${id}`, position, value,
    adj_ppg: adj, ros_ppg: ros, playoff_ppg: ros,
    playoff_weeks_left: 3, playoff_bye_week: null };
}

/** A starting nine that is identical this week and in the playoff weeks. */
function ladderRoster(roster_id, owner, scale = 1) {
  return { roster_id, owner, players: [
    ladderPlayer(`${roster_id}-qb`, 'QB', 18 * scale, 18 * scale),
    ladderPlayer(`${roster_id}-rb1`, 'RB', 14 * scale, 14 * scale),
    ladderPlayer(`${roster_id}-rb2`, 'RB', 12 * scale, 12 * scale),
    ladderPlayer(`${roster_id}-wr1`, 'WR', 15 * scale, 15 * scale),
    ladderPlayer(`${roster_id}-wr2`, 'WR', 11 * scale, 11 * scale),
    ladderPlayer(`${roster_id}-te`, 'TE', 9 * scale, 9 * scale),
    ladderPlayer(`${roster_id}-flex`, 'WR', 10 * scale, 10 * scale),
  ] };
}

test('G9a: a target who is worthless this week but real in the playoff weeks clears the entry gate', () => {
  const me = ladderRoster('1', 'Nick');
  const them = ladderRoster('2', 'Alpha One');
  // On bye this Sunday, and the best receiver in the league for the playoff run.
  const onByeNow = ladderPlayer('chase', 'WR', 0, 24, 400);
  them.players.push(onByeNow);
  const horizon = horizonWeights(2, { playoffOdds: 0.6, regularWeeks: 14, playoffWeeks: [15, 16, 17] });

  const ceiling = engine.freeAddCeiling(me, them, [onByeNow], ladderSlots, horizon);

  // The two numbers the two gates read, side by side. `weekly` is what the old
  // gate tested, and 0 <= 0.05 is exactly why this player came back as a flat
  // refusal; `horizon_weighted` is what the gate tests now, and the ladder runs.
  assert.equal(ceiling.weekly, 0, 'he genuinely does nothing for this week — that part was never wrong');
  assert.ok(ceiling.weekly <= 0.05, 'the old weekly-only gate would have refused him here');
  assert.ok(ceiling.playoff_leg > 0, `playoff leg should be positive, got ${ceiling.playoff_leg}`);
  assert.ok(ceiling.horizon_weighted > 0.05,
    `the horizon-weighted ceiling is what the gate reads; got ${ceiling.horizon_weighted}`);
});

test('G9b: a target who cannot help on either leg is still refused', () => {
  const me = ladderRoster('1', 'Nick');
  const them = ladderRoster('2', 'Alpha One');
  // Worse than everyone already starting, now and later.
  const bench = ladderPlayer('filler', 'WR', 2, 2, 20);
  them.players.push(bench);
  const horizon = horizonWeights(2, { playoffOdds: 0.6, regularWeeks: 14, playoffWeeks: [15, 16, 17] });

  const ceiling = engine.freeAddCeiling(me, them, [bench], ladderSlots, horizon);

  assert.equal(ceiling.weekly, 0);
  assert.ok(ceiling.horizon_weighted <= 0.05,
    `a genuine non-upgrade must still be refused; got ${ceiling.horizon_weighted}`);
});

test('G9c: the refusal every ladder can return is decided on the horizon number it reports', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 401')[0];
  const payload = JSON.parse(lg.payload);
  let checked = 0;
  for (const t of payload.teams) {
    if (String(t.id) === '1') continue;
    for (const e of t.roster.entries) {
      const name = e.playerPoolEntry.player.fullName;
      const id = rows('SELECT id FROM players WHERE name = ? ORDER BY id LIMIT 1', name)[0]?.id;
      if (!id) continue;
      const out = engine.offerFor(lg, { myTeamId: '1', targetId: id });
      if (out.upside_ppg_horizon == null) continue;
      checked++;
      // Both legs are always reported, so a UI never has to guess which number
      // the refusal was made on.
      assert.equal(typeof out.upside_ppg, 'number', `${name}: weekly leg missing`);
      assert.equal(typeof out.upside_ppg_horizon, 'number', `${name}: horizon leg missing`);
      const refused = out.error === 'He would not crack your starting lineup.';
      assert.equal(refused, out.upside_ppg_horizon <= 0.05,
        `${name}: refused=${refused} but horizon ceiling is ${out.upside_ppg_horizon}`);
    }
  }
  assert.ok(checked > 10, `fixture must exercise real ladders, only checked ${checked}`);
});

/* --------------------------- PRICE-BAND-01: the ladder serves the flagged band */

test('PRICE-BAND-01: flag off serves the legacy window; GRIDIRON_PRICE_BAND_V2=1 serves the fitted band', async () => {
  const { V2_BAND, LEGACY_BAND, PRICE_BAND_V2_ENV } = await import('../server/services/price-band.js');
  const lg = rows('SELECT * FROM leagues WHERE id = 401')[0];
  const payload = JSON.parse(lg.payload);
  const ids = payload.teams.filter(t => String(t.id) !== '1')
    .flatMap(t => t.roster.entries.map(e => e.playerPoolEntry.player.fullName))
    .map(n => rows('SELECT id FROM players WHERE name = ? ORDER BY id LIMIT 1', n)[0]?.id).filter(Boolean);
  const saved = process.env[PRICE_BAND_V2_ENV];
  const ladder = v => {
    if (v === undefined) delete process.env[PRICE_BAND_V2_ENV]; else process.env[PRICE_BAND_V2_ENV] = v;
    return ids.map(id => engine.offerFor(lg, { myTeamId: '1', targetId: id }));
  };
  try {
    const legacy = ladder('0'), v2 = ladder('1');
    for (const [runs, band, served] of [[legacy, LEGACY_BAND, false], [v2, V2_BAND, true]]) {
      let offers = 0;
      for (const out of runs) {
        if (served && out.mode === 'target') assert.deepEqual(out.accept_band, V2_BAND);
        if (!served) assert.equal(out.accept_band, undefined, 'flag off adds no field');
        for (const o of out.offers ?? []) {
          offers++;
          assert.ok(o.ratio >= +band.window_lo.toFixed(2) && o.ratio <= +band.window_hi.toFixed(2),
            `${band.version}: ratio ${o.ratio} outside [${band.window_lo}, ${band.window_hi}]`);
        }
      }
      assert.ok(offers > 0, `${band.version}: fixture must produce priced offers`);
    }
  } finally {
    if (saved === undefined) delete process.env[PRICE_BAND_V2_ENV]; else process.env[PRICE_BAND_V2_ENV] = saved;
  }
});
