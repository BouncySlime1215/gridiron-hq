/**
 * The evidence layer on a trade evaluation, tested on a temp database.
 *
 * Three claims: every player object the engine emits carries career /
 * preseason / offseason evidence when the sources have it; a source that
 * returns null or throws leaves its field absent (and the valuation numbers
 * untouched); and the per-side risk read is computed from the consistency
 * fields and the band the way the strip says it is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-trade-evidence-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
// Same side-effect imports as test/find-trades.test.js — tables created on import.
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const {
  findTrades, playerEvidence, playerRiskProfile, packageRisk, _setEvidenceSources
} = await import('../server/services/trade-engine.js');
const { deriveFormat } = await import('../server/services/format.js');

await runMigrations();
seedIfEmpty();

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------------- fixtures */

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DEF: 16 };
const entry = (player, fakeId) =>
  ({ playerPoolEntry: { player: { id: fakeId, fullName: player.name, defaultPositionId: POS_ID[player.position] } } });
const espnPlayers = (position, n) => rows(`SELECT id, name, position FROM players
  WHERE position = ? AND fantasy_relevant = 1 ORDER BY id LIMIT ?`, position, n);

function insertLeague(id, payload) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, 2026, 'EV League', ?, 6, '1', ?, 'x', 'y', 'connected')`,
    id, `espn-ev-${id}`, JSON.stringify(payload), JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']));
}

// findTrades prices a player from player_season_stats (projected -> vorBoard
// -> proj) and dynasty_values (-> value); the lightweight seed used by this
// test DB carries neither for arbitrary players, so every candidate would
// price at 0 and findTrades would correctly, but uselessly, find nothing.
// Same formatKey findTrades itself will derive for this six-team league.
const { formatKey } = deriveFormat({
  team_count: 6, ppr: null, league_type: null, best_ball: 0, payload: null,
  roster_positions: JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'])
});
function seedMarket(players) {
  const now = new Date().toISOString();
  players.forEach((p, i) => {
    const proj = 320 - i * 3; // spread by rank so vor/value actually differ player to player
    run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games, raw, fetched_at)
         VALUES (?, 2026, 'projected', ?, 17, '{}', ?)
         ON CONFLICT(player_id, season, kind) DO UPDATE SET fantasy_points = excluded.fantasy_points`,
      p.id, proj, now);
    run(`INSERT INTO dynasty_values (format_key, player_id, value, redraft_value, trend30, age, pos_rank, fetched_at)
         VALUES (?, ?, ?, ?, 0, 26, ?, ?)
         ON CONFLICT(format_key, player_id) DO UPDATE SET value = excluded.value, redraft_value = excluded.redraft_value`,
      formatKey, p.id, Math.round(proj * 3), Math.round(proj * 3), i + 1, now);
  });
}

function sixTeamLeague() {
  const qb = espnPlayers('QB', 6), rb = espnPlayers('RB', 18), wr = espnPlayers('WR', 18), te = espnPlayers('TE', 6);
  seedMarket([...qb, ...rb, ...wr, ...te]);
  let fakeId = 800000;
  const teams = [];
  // Snake-draft the tiers instead of handing team 0 every top-ranked player
  // at every position: a contiguous slice makes team 1 strictly best (or
  // worst) everywhere, so no trade ever improves anyone's lineup and
  // findTrades correctly returns nothing. Round-robin across the three RB/WR
  // tiers gives every team a real mix of strengths and needs to trade on.
  for (let i = 0; i < 6; i++) {
    const roster = [qb[i], rb[i], rb[i + 6], rb[i + 12], wr[i], wr[i + 6], wr[i + 12], te[i]].filter(Boolean);
    teams.push({ id: i + 1, name: `Team ${i + 1}`, roster: { entries: roster.map(p => entry(p, fakeId++)) } });
  }
  return { teams, settings: { name: 'EV League' } };
}

/** A synthetic five-season career for any player id: 1,000+ rec yds every year, top-12 every year. */
const season = (yr, pts, rank) => ({ season: yr, games: 17, ppr_points: pts, ppg: +(pts / 17).toFixed(1), pos_rank: rank,
  targets: 150, rec: 100, rec_yds: 1200, rec_td: 8 });
const provenCareer = () => ({
  headline: '1,000+ rec yds in 5 straight seasons · top-12 WR every year',
  window: { from: 2021, to: 2025 },
  seasons: [season(2025, 280, 5), season(2024, 270, 6), season(2023, 290, 4), season(2022, 260, 8), season(2021, 275, 7)],
  consistency: { seasons_counted: 5, seasons_top12: 5, seasons_top24: 5, cv_points: 0.05, min_games: 17, max_games: 17 },
  streaks: [{ stat: 'rec_yds', threshold: 1000, seasons: 5, streak: 5, values: [1200, 1200, 1200, 1200, 1200] }],
  trend: { points_yoy_pct: 4, ppg_yoy_pct: 4, role_yoy: 'stable' }
});
const stubPreseason = () => ({ points: 250.4, ppg: 14.7, expected_games: 16.2, p20: 190, p80: 310,
  drivers: ['185 targets last year', 'WR1 on his own team', 'a third driver that must be trimmed'] });
const stubOffseason = () => ({ opportunity_multiplier: 0.88, ppg_multiplier: 0.9, confidence: 'medium',
  drivers: ['new OC', 'lost 40 targets to a signing'] });

/**
 * Force the next findTrades() to actually re-run.
 *
 * Its cache is fingerprinted on manager_profiles' row COUNT and MAX(updated_at)
 * (`tradeIdeasFingerprint`, trade-engine.js:1478 — a tier edited in place changes
 * no row count, so the column is stamped). An upsert that sets only
 * `tradeability` moves NEITHER, so the second search silently returns the first
 * one's deals. Every test below that compares two searches has to move the
 * stamp itself, and writes a strictly newer `updated_at` on the SAME row at the
 * 'fair' default tier: the cheapest real data change that leaves every
 * valuation input, and the engine's own filtering, exactly as they were.
 */
let cacheBust = 0;
const reSearch = () => run(
  `INSERT INTO manager_profiles (league_id, roster_id, tradeability, updated_at)
   VALUES (?, '6', 'fair', ?)
   ON CONFLICT(league_id, roster_id) DO UPDATE SET updated_at = excluded.updated_at`,
  301, `2099-01-01T00:00:${String(cacheBust++).padStart(2, '0')}Z`);

/* --------------------------------------------------------------- attach */

test('evidence attaches to every player on both sides of every deal, compacted', () => {
  _setEvidenceSources({
    careerLine: () => provenCareer(),
    preseasonProjection: () => stubPreseason(),
    offseasonAdjustment: () => stubOffseason()
  });
  insertLeague(301, sixTeamLeague());
  const lg = rows('SELECT * FROM leagues WHERE id = 301')[0];
  const found = findTrades(lg, { myTeamId: '1', maxPerSide: 2, requireMutual: false, limit: 50 });
  assert.ok(!found.error, found.error);
  assert.ok(found.deals.length > 0, 'the seeded six-team league must produce at least one deal');

  for (const d of found.deals) {
    for (const p of [...d.i_give, ...d.i_get, ...d.me.gives, ...d.me.gets, ...d.them.gives, ...d.them.gets]) {
      assert.equal(p.career.seasons.length, 3, 'career is compacted to the last three seasons');
      assert.equal(p.career.seasons_on_record, 5, 'but the full window count survives');
      assert.equal(p.career.headline, '1,000+ rec yds in 5 straight seasons · top-12 WR every year');
      assert.equal(p.career.consistency.seasons_top24, 5);
      assert.equal(p.career.streaks[0].streak, 5);
      assert.deepEqual([p.preseason.points, p.preseason.p20, p.preseason.p80], [250.4, 190, 310]);
      assert.equal(p.preseason.drivers.length, 2, 'top two drivers only');
      assert.equal(p.offseason.opportunity_multiplier, 0.88);
      assert.equal(p.offseason.direction, 'risk');
      assert.equal(p.offseason.applied_to_value, false, 'the offseason read is a flag, never a multiplier on value');
    }
    assert.ok(d.me.risk?.out && d.me.risk?.in, 'each side carries a risk read');
    assert.ok(d.them.risk?.out && d.them.risk?.in);
    assert.match(d.verdict_evidence, /^give: \d+\/\d+ top-24 seasons, ±5% swing, 17 g min, 2026 band \d+-\d+ · get: /);
  }
});

test('the offseason multiplier is never applied: the valuation is identical with and without evidence', () => {
  _setEvidenceSources({
    careerLine: () => provenCareer(),
    preseasonProjection: () => stubPreseason(),
    offseasonAdjustment: () => ({ opportunity_multiplier: 1.6, confidence: 'high', drivers: ['starter now'] })
  });
  const lg = rows('SELECT * FROM leagues WHERE id = 301')[0];
  const withEv = findTrades(lg, { myTeamId: '1', maxPerSide: 1, requireMutual: false, limit: 20 });
  _setEvidenceSources({ careerLine: () => null, preseasonProjection: () => null, offseasonAdjustment: () => null });
  reSearch();
  const without = findTrades(lg, { myTeamId: '1', maxPerSide: 1, requireMutual: false, limit: 20 });
  assert.notEqual(withEv, without, 'the second search returned the cached first one');
  const key = d => `${d.partner_id}:${d.i_give.map(p => p.id)}>${d.i_get.map(p => p.id)}`;
  const strip = d => ({ key: key(d), ppg: d.me.ppg_delta, value: d.me.value_delta, score: d.score, verdict: d.me.verdict });
  assert.deepEqual(withEv.deals.map(strip), without.deals.map(strip), 'ppg, value, score and verdict never move with evidence');
  for (const p of without.deals.flatMap(d => [...d.i_give, ...d.i_get])) {
    assert.equal('career' in p, false); assert.equal('preseason' in p, false); assert.equal('offseason' in p, false);
  }
});

/**
 * The same guarantee as the test above, but with a layer that THREW rather
 * than one that returned null — the case recording the fault could plausibly
 * have weakened, and the one the old degrade test never exercised.
 *
 * Split deliberately: the decision half (ppg, value, score, verdict) must be
 * byte-identical, and the text half is allowed to differ, because saying "this
 * record could not be read" is the entire point of recording the fault.
 */
test('a THROWN evidence layer moves no ppg, value, score or verdict, and adds no data field', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 301')[0];
  const strip = d => ({
    key: `${d.partner_id}:${d.i_give.map(p => p.id)}>${d.i_get.map(p => p.id)}`,
    ppg: d.me.ppg_delta, value: d.me.value_delta, score: d.score, verdict: d.me.verdict
  });

  _setEvidenceSources({ careerLine: () => null, preseasonProjection: () => null, offseasonAdjustment: () => null });
  reSearch();
  const silent = findTrades(lg, { myTeamId: '1', maxPerSide: 1, requireMutual: false, limit: 20 });

  _setEvidenceSources({
    careerLine: () => { throw new Error('career query failed'); },
    preseasonProjection: () => null,
    offseasonAdjustment: () => null
  });
  reSearch();
  const thrown = findTrades(lg, { myTeamId: '1', maxPerSide: 1, requireMutual: false, limit: 20 });

  assert.ok(thrown.deals.length, 'the fixture must produce deals for this comparison to mean anything');
  // Liveness, asserted on REFERENCE identity rather than on any field: a cache
  // hit hands back the very object the first search returned, so a comparison
  // of two stale halves would pass every assertion below while testing nothing.
  // Reference identity is the one check that cannot be satisfied by the fix
  // itself, which is why it and not the text is what pins the cache here.
  assert.notEqual(thrown, silent, 'the second search returned the cached first one');

  assert.deepEqual(thrown.deals.map(strip), silent.deals.map(strip),
    'ppg, value, score and verdict never move because an evidence layer threw');
  for (const p of thrown.deals.flatMap(d => [...d.i_give, ...d.i_get])) {
    assert.equal('career' in p, false, 'a failed layer adds no data field');
    assert.equal('preseason' in p, false);
    assert.equal('offseason' in p, false);
    assert.deepEqual(p.evidence_unreadable, ['career'], 'which layer failed is recorded');
  }
});

/**
 * The text half of the split above: the evidence line under the verdict is
 * where packageNumbers() surfaces, and it must not report a package whose
 * record it could not read as one with no record.
 */
test('the verdict evidence line states an unreadable record instead of "0 seasons on record"', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 301')[0];

  _setEvidenceSources({
    careerLine: () => { throw new Error('career query failed'); },
    preseasonProjection: () => null,
    offseasonAdjustment: () => null
  });
  reSearch();
  const thrown = findTrades(lg, { myTeamId: '1', maxPerSide: 1, requireMutual: false, limit: 20 });

  assert.ok(thrown.deals.length, 'fixture produces deals to read the line off');
  for (const d of thrown.deals) {
    assert.match(d.verdict_evidence, /could not be read/);
    assert.doesNotMatch(d.verdict_evidence, /0 seasons on record/);
  }
});

/**
 * The third surface, and the one that reads worst when it is wrong:
 * packageRisk sums seasons over `withRecord` (`seasons > 0`), which drops an
 * unknown player, so a two-man package with one unreadable record used to
 * report the readable man's five seasons as though they were the package's.
 * Here half the league's careers throw, so both sides of every deal are mixed,
 * and the line has to say what share of the package it actually read.
 */
test('a partly unreadable package reports the shortfall, not the readable half as the whole', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 301')[0];

  _setEvidenceSources({
    careerLine: id => { if (id % 2) throw new Error('career query failed'); return provenCareer(); },
    preseasonProjection: () => null,
    offseasonAdjustment: () => null
  });
  reSearch();
  const mixed = findTrades(lg, { myTeamId: '1', maxPerSide: 2, requireMutual: false, limit: 50 });

  // The shortfall is a property of ONE package, so the mix has to be inside a
  // single side — a readable give against an unreadable get says nothing here.
  const isMixed = side => side.some(p => p.evidence_unreadable) && side.some(p => p.career);
  const partial = mixed.deals.filter(d => isMixed(d.i_give) || isMixed(d.i_get));
  assert.ok(partial.length, 'the fixture must produce a package mixing a readable and an unreadable record');
  for (const d of partial) {
    // "3/15 top-24 seasons for 1 of 2, 1 record could not be read" — the count
    // the sum was taken over, next to the package size it is being read as.
    assert.match(d.verdict_evidence, /top-24 seasons for \d+ of \d+, \d+ records? could not be read/);
  }
});

/* -------------------------------------------------------------- degrade */

test('a null source leaves its field absent; a throwing source is recorded; a neutral offseason read is dropped', () => {
  _setEvidenceSources({
    careerLine: () => null,
    preseasonProjection: () => { throw new Error('model not fitted'); },
    offseasonAdjustment: () => ({ opportunity_multiplier: 1.0, drivers: [] })
  });
  // A throw used to be swallowed outright. It still leaves its field absent —
  // the degradation this test exists to protect — but WHICH layer failed is now
  // recorded, because "the model is not fitted" and "this player has no
  // projection" are different facts and the surface states one of them.
  // See playerEvidence() and test/trade-engine-evidence-fault.test.js.
  assert.deepEqual(playerEvidence(1), { evidence_unreadable: ['preseason'] });
  assert.equal('preseason' in playerEvidence(1), false);
  assert.deepEqual(playerEvidence(null), {});

  _setEvidenceSources({ careerLine: () => null, preseasonProjection: () => stubPreseason(), offseasonAdjustment: () => null });
  const ev = playerEvidence(2);
  assert.deepEqual(Object.keys(ev), ['preseason']);
  assert.equal(ev.preseason.expected_games, 16.2);
});

test('playerEvidence is memoised per player and the test hook clears it', () => {
  let calls = 0;
  _setEvidenceSources({ careerLine: () => { calls++; return provenCareer(); }, preseasonProjection: () => null, offseasonAdjustment: () => null });
  playerEvidence(7); playerEvidence(7);
  assert.equal(calls, 1);
  _setEvidenceSources({ careerLine: () => { calls++; return null; } });
  assert.deepEqual(playerEvidence(7), {});
  assert.equal(calls, 2);
});

/* ----------------------------------------------------------------- risk */

const withCareer = (over = {}, pre = null) => {
  const c = provenCareer();
  return { id: 1, name: 'X', value: 100, career: { ...c, seasons_on_record: c.seasons.length, consistency: { ...c.consistency, ...over } }, preseason: pre };
};

test('risk profile: proven floor / steady / spike / volatile / unproven from consistency and the band', () => {
  const proven = playerRiskProfile(withCareer({}, stubPreseason()));
  assert.equal(proven.profile, 'proven floor');
  assert.deepEqual([proven.seasons, proven.top24, proven.top12, proven.min_games, proven.swing_pct], [5, 5, 5, 17, 5]);
  assert.equal(proven.band_pct, Math.round((310 - 190) / 250.4 * 100));

  assert.equal(playerRiskProfile(withCareer({ seasons_top24: 2, seasons_top12: 1, cv_points: 0.3 })).profile, 'steady');
  assert.equal(playerRiskProfile(withCareer({ seasons_counted: 1, seasons_top24: 1, seasons_top12: 0 })).profile, 'spike');
  assert.equal(playerRiskProfile(withCareer({ seasons_counted: 1, seasons_top24: 0, seasons_top12: 0 })).profile, 'volatile');
  assert.equal(playerRiskProfile(withCareer({ seasons_top24: 3, cv_points: 0.5 })).profile, 'volatile');
  const rookie = playerRiskProfile({ id: 9, name: 'Rookie', value: 50 });
  assert.equal(rookie.profile, 'unproven');
  assert.equal(rookie.band_pct, null);
});

test('packageRisk sums seasons, averages swing/band, takes the worst min_games and reads off the priciest player', () => {
  const a = withCareer({}, stubPreseason());
  const b = { ...withCareer({ seasons_counted: 3, seasons_top24: 1, seasons_top12: 0, cv_points: 0.45, min_games: 9 }, { points: 100, p20: 60, p80: 140 }), id: 2, value: 30 };
  b.career.seasons_on_record = 3;
  const r = packageRisk([a, b]);
  assert.equal(r.seasons, 8);
  assert.equal(r.top24_seasons, 6);
  assert.equal(r.top12_seasons, 5);
  assert.equal(r.min_games, 9);
  assert.equal(r.swing_pct, Math.round((5 + 45) / 2));
  assert.deepEqual([r.points, r.p20, r.p80], [350.4, 250, 450]);
  assert.equal(r.headline_profile, 'proven floor');
  assert.equal(r.headline_read, 'a 5-year top-12 floor');

  const empty = packageRisk([]);
  assert.deepEqual([empty.seasons, empty.swing_pct, empty.p80, empty.headline_read], [0, null, null, null]);
  const rookies = packageRisk([{ id: 9, name: 'R', value: 1 }]);
  assert.equal(rookies.headline_read, 'a player with no NFL record');
});

test.after(() => _setEvidenceSources());
