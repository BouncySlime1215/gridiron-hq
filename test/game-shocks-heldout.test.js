/**
 * U7 GAME-SHOCKS-CHECK: the held-out tail check that decides GRIDIRON_GAME_SHOCKS.
 *
 * Archetype correlations are fitted on train seasons only; on a held-out season the
 * empirical same-game conditional co-exceedance P(U_j > q | U_i > q) is compared with
 * what the Gaussian copula (off) and the grouped-t nu 6 copula (on) predict at each
 * pair's own marginal shares, with a game-cluster bootstrap interval on the improvement.
 * Pre-registration: docs/tdd/2026-09-25-u7-game-shocks-heldout.tdd.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-game-shocks-heldout-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const C = await import('../server/services/correlation.js');
const H = await import('../scripts/lib/game-shocks-heldout.mjs');
const { keyedNormal, keyedSeed } = await import('../server/services/stats-util.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* A made-up league: 32 teams, five skill players each, every team plays every week.
   Latent z = game factor + team factor + noise (same team rho 0.25, opponents 0.08);
   with `nu` every game's players share one chi2(nu)/nu shock, as the copula does. */
const TEAMS = Array.from({ length: 32 }, (_, i) => `T${String(i).padStart(2, '0')}`);
const SLOTS = [['QB', 'qb'], ['RB', 'rb'], ['WR', 'wr1'], ['WR', 'wr2'], ['TE', 'te']];
function syntheticLog({ seasons, nu = null, key = 1, weeks = 17 }) {
  const log = [];
  const A = 0.08, B = 0.17;
  for (const season of seasons) for (let week = 1; week <= weeks; week++) {
    // Circle-method round robin: opponents change week to week.
    const rest = TEAMS.slice(1);
    const arr = [TEAMS[0], ...rest.slice(week % 31), ...rest.slice(0, week % 31)];
    const games = Array.from({ length: 16 }, (_, i) => [arr[i], arr[31 - i]]);
    games.forEach(([t, o], g) => {
      const k = keyedSeed(key, season, week, g);
      let c = 0;
      const gf = keyedNormal(k, c++);
      let w = 1;
      if (nu != null) { let s = 0; for (let j = 0; j < nu; j++) s += keyedNormal(k, 100 + j) ** 2; w = s / nu; }
      for (const [team, opp] of [[t, o], [o, t]]) {
        const tf = keyedNormal(k, c++);
        for (const [position, slot] of SLOTS) {
          const z = (Math.sqrt(A) * gf + Math.sqrt(B) * tf + Math.sqrt(1 - A - B) * keyedNormal(k, c++)) / Math.sqrt(w);
          // Receiving yards carry the whole score: PPR 0.1 per yard, so pts = yards / 10.
          log.push({ player_id: `${team}-${slot}`, season, week, team, opponent: opp, position, receiving_yards: Math.round(1000 + 300 * z) });
        }
      }
    });
  }
  return log;
}

test('residualsFromLog: a train window never sees the held-out season', () => {
  const log = [
    ...[1, 2, 3, 4, 5, 6].map(week => ({ player_id: 'a', season: 2024, week, team: 'KC', opponent: 'BUF', position: 'QB', receiving_yards: 100 * week })),
    ...[1, 2].map(week => ({ player_id: 'a', season: 2025, week, team: 'KC', opponent: 'BUF', position: 'QB', receiving_yards: 5000 }))
  ];
  const train = C.residualsFromLog(log, { minGames: 6, until: 2024 });
  const rows = [...train.values()].flat();
  assert.equal(rows.length, 6);
  assert.ok(rows.every(r => r.season === 2024));
  // Mean over 2024 only (35 pts), so the residuals are symmetric around 0.
  assert.ok(Math.abs(rows.reduce((s, r) => s + r.z, 0)) < 1e-9);
  // minGames counts inside the window: 2 games in 2025 is too few.
  assert.equal(C.residualsFromLog(log, { minGames: 6, from: 2025 }).size, 0);
  // No window: the same grouping sameGameResiduals has always produced.
  assert.equal(C.residualsFromLog(log, { minGames: 6 }).get('2024|1|BUF-KC').length, 1);
});

test('archetypeCorrelations: one pooled correlation per (positions, same team | opponents)', () => {
  const games = C.residualsFromLog(syntheticLog({ seasons: [2021, 2022], key: 3 }), { minGames: 6 });
  const r = C.archetypeCorrelations(games);
  const qbwr = r.get('QB|WR|team');
  assert.ok(qbwr.n > 1000);
  assert.ok(Math.abs(qbwr.r - 0.25) < 0.06, `QB|WR|team ${qbwr.r}`);
  assert.ok(Math.abs(r.get('QB|WR|opp').r - 0.08) < 0.06, `QB|WR|opp ${r.get('QB|WR|opp').r}`);
  assert.equal(C.pairArchetype({ position: 'WR', team: 'KC' }, { position: 'QB', team: 'KC' }), 'QB|WR|team');
});

test('nflverseWeekRow: regular-season skill players only, fumbles summed, ids kept', () => {
  const header = ['player_id', 'position', 'season', 'week', 'season_type', 'team', 'opponent_team', 'passing_yards', 'passing_tds',
    'passing_interceptions', 'sack_fumbles_lost', 'rushing_yards', 'rushing_tds', 'rushing_fumbles_lost', 'receptions',
    'receiving_yards', 'receiving_tds', 'receiving_fumbles_lost'];
  const rec = (o) => header.map(h => String(o[h] ?? ''));
  const row = H.nflverseWeekRow(header, rec({ player_id: '00-1', position: 'QB', season: 2025, week: 3, season_type: 'REG', team: 'KC', opponent_team: 'BUF',
    passing_yards: 250, passing_tds: 2, passing_interceptions: 1, sack_fumbles_lost: 1, rushing_fumbles_lost: 1, receiving_fumbles_lost: 0 }));
  assert.deepEqual({ id: row.player_id, s: row.season, w: row.week, t: row.team, o: row.opponent, fl: row.fumbles_lost, int: row.interceptions },
    { id: '00-1', s: 2025, w: 3, t: 'KC', o: 'BUF', fl: 2, int: 1 });
  assert.equal(H.nflverseWeekRow(header, rec({ player_id: 'k', position: 'K', season: 2025, week: 3, season_type: 'REG', team: 'KC', opponent_team: 'BUF' })), null);
  assert.equal(H.nflverseWeekRow(header, rec({ player_id: 'x', position: 'WR', season: 2025, week: 19, season_type: 'POST', team: 'KC', opponent_team: 'BUF' })), null);
});

test('heldOutVerdict: the interval must clear 0 and shocks-on may not overshoot by more than 25%', () => {
  const g = (lo, emp, on) => ({ pairs: 100, events: 50, ce_emp: emp, ce_off: 0.1, ce_on: on, diff: 0.01, ci: [lo, lo + 0.02] });
  assert.equal(H.heldOutVerdict({ qb_wr_team: g(0.001, 0.2, 0.2), same_game: g(0.002, 0.2, 0.21) }).pass, true);
  assert.equal(H.heldOutVerdict({ qb_wr_team: g(0, 0.2, 0.2), same_game: g(0.002, 0.2, 0.2) }).pass, false);
  const over = H.heldOutVerdict({ qb_wr_team: g(0.01, 0.2, 0.26), same_game: g(0.01, 0.2, 0.2) });
  assert.equal(over.pass, false);
  assert.match(over.groups.qb_wr_team.reason, /overshoot/);
});

test('heldOutTailCheck: passes on a shocked world, fails on a Gaussian one (fixed keys)', { timeout: 240_000 }, () => {
  const opts = { q: 0.9, reps: 60, B: 400, key: 5 };
  const run = nu => {
    // Twelve held-out seasons: one season of QB-WR pairs is too few tail events for the
    // interval to clear 0 even when the shock is real (see the TDD record's power note).
    const seasons = Array.from({ length: 16 }, (_, i) => 2021 + i);
    const log = syntheticLog({ seasons, nu, key: nu ?? 0 });
    const train = C.residualsFromLog(log, { minGames: 6, until: 2024 });
    const test = C.residualsFromLog(log, { minGames: 6, from: 2025 });
    return H.heldOutTailCheck(train, test, opts);
  };
  const t = run(6);
  for (const g of ['qb_wr_team', 'same_game']) {
    assert.ok(t.groups[g].pairs > 0);
    assert.ok(t.groups[g].ce_on > t.groups[g].ce_off, `${g}: on above off`);
    assert.ok(t.groups[g].ci[0] <= t.groups[g].diff && t.groups[g].diff <= t.groups[g].ci[1]);
  }
  assert.equal(t.verdict.pass, true, JSON.stringify(t.verdict));
  const gss = run(null);
  assert.equal(gss.verdict.pass, false, JSON.stringify(gss.verdict));
  // Keyed: the same inputs give the same interval.
  assert.deepEqual(run(6).groups.same_game.ci, t.groups.same_game.ci);
});
