/**
 * A veto-climate or timing read that throws must not vanish into a silent
 * `null`.
 *
 * server/services/trade-engine.js's attachTactics wraps `vetoClimate` and
 * `timingRead` (both from trade-tactics.js) in a bare `try { … } catch { … }`
 * that discards ANY exception the same way, with no bound error and no log.
 * `vetoClimate`'s own legitimate "nobody has voted here" case is a RETURN,
 * not a throw (see trade-tactics.js:389's early return), so anything that
 * reaches this catch is a real fault — a renamed column, a bad payload — and
 * a bare catch makes it read exactly like the empty-league case downstream.
 * This is the pattern CLAUDE.md names by name: "No bare catch {} that
 * swallows a fault... If a layer goes inert, the surface must say so."
 *
 * Fixed the same way ros-projection-failure-wiring.test.js already proved
 * for the rest-of-season model: name the fault, log it, and carry it onto
 * the surface (here, `tactics_absent`, the array trade-tactics.js's own
 * `note()` helper already uses for this exact `{ key, reason }` shape) —
 * rather than letting the whole computation die, and rather than pretending
 * nothing happened.
 *
 * Roster fixture follows test/trade-tactics.test.js's BARE-league recipe
 * (lopsided rosters + priced players): six identical, evenly-valued teams
 * produce no trade at all, so the shape and the dynasty_values/
 * player_season_stats rows below are both load-bearing, not decoration.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-veto-catch-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const realTradeTactics = await import('../server/services/trade-tactics.js');
mock.module('../server/services/trade-tactics.js', {
  namedExports: {
    ...realTradeTactics,
    vetoClimate: () => { throw new Error('espn_veto_history has no column named skew_pct'); },
    timingRead: () => { throw new Error('espn_trade_timing has no column named responded_at'); },
  }
});

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
// Side-effect imports: same "~40 files create tables on import" wiring the
// rest of the suite relies on (test/find-trades.test.js).
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const { findTrades } = await import('../server/services/trade-engine.js');
const { deriveFormat } = await import('../server/services/format.js');

await runMigrations();
const { seedIfEmpty } = await import('../server/db/seed/index.js');
seedIfEmpty();

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026;
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const pool = pos => rows(`SELECT id, name, position FROM players
                          WHERE position = ? AND fantasy_relevant = 1 ORDER BY id LIMIT 30`, pos);
const QB = pool('QB'), RB = pool('RB'), WR = pool('WR'), TE = pool('TE');
assert.ok(QB.length >= 6 && RB.length >= 18 && WR.length >= 18 && TE.length >= 6,
  'the seed must carry enough players to build six real rosters');

let fakeEspnId = 810000;
const entryFor = p => ({ lineupSlotId: 0, acquisitionType: 'DRAFT',
  playerPoolEntry: { player: { id: fakeEspnId++, fullName: p.name,
    injuryStatus: 'ACTIVE', defaultPositionId: POS_ID[p.position] } } });

// Deliberately lopsided: team 1 is WR-rich/RB-poor, team 2 is the mirror
// image, so at least one real trade exists between them.
const SHAPE = [
  { qb: 3, rb: [9, 10, 11], wr: [0, 1, 2], te: 4 },
  { qb: 0, rb: [0, 1, 2], wr: [9, 10, 11], te: 0 },
  { qb: 1, rb: [3, 4, 5], wr: [3, 4, 5], te: 1 },
  { qb: 2, rb: [6, 7, 8], wr: [6, 7, 8], te: 2 },
  { qb: 4, rb: [12, 13, 14], wr: [12, 13, 14], te: 3 },
  { qb: 5, rb: [15, 16, 17], wr: [15, 16, 17], te: 5 },
];
const ROSTERS = SHAPE.map(s => [QB[s.qb], ...s.rb.map(i => RB[i]), ...s.wr.map(i => WR[i]), TE[s.te]]);

function roundRobin(weeks) {
  const out = [];
  const ids = [1, 2, 3, 4, 5, 6];
  for (let w = 1; w <= weeks; w++) {
    const rot = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + w - 1) % 5)])];
    for (let i = 0; i < 3; i++) {
      out.push({ matchupPeriodId: w, home: { teamId: rot[i] }, away: { teamId: rot[5 - i] } });
    }
  }
  return out;
}

function leaguePayload() {
  return {
    members: [1, 2, 3, 4, 5, 6].map(i => ({ id: `{VC-${i}}`, firstName: `First${i}`, lastName: `Last${i}`,
      displayName: `First${i}Last${i}` })),
    teams: ROSTERS.map((roster, i) => ({
      id: i + 1, name: `Team ${i + 1}`, owners: [`{VC-${i + 1}}`],
      currentProjectedRank: i + 1, draftDayProjectedRank: i + 1,
      record: { overall: { wins: 1, losses: 1, ties: 0, pointsFor: 400, pointsAgainst: 400,
        streakType: 'WIN', streakLength: 1 } },
      roster: { entries: roster.map(entryFor) },
    })),
    schedule: roundRobin(14),
    settings: { name: 'Veto Catch League', tradeSettings: { vetoVotesRequired: 3, revisionHours: 24 },
      scheduleSettings: { matchupPeriodCount: 14, matchupPeriodLength: 1, playoffTeamCount: 4,
        playoffMatchupPeriodLength: 1 } },
  };
}

function insertLeague(id, payload) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, ?, ?, ?, ?, ?, ?, 'x', 'y', 'connected')`,
    id, `espn-vc-${id}`, SEASON, `VC${id}`, JSON.stringify(payload), payload.teams.length, '1',
    JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']));
}
insertLeague(301, leaguePayload());
const lg0 = rows('SELECT * FROM leagues WHERE id = 301')[0];

// Market values and season projections. The seed carries neither, and a
// valuation map where every player is worth 0 and projects 0 would prove
// nothing — the engine's first gate is a 0.4 ppg lineup gain.
const FORMAT_KEY = deriveFormat(lg0).formatKey;
const PRICE = { QB: 4200, RB: 6800, WR: 6400, TE: 3200 };
const PROJ = { QB: [340, 9], RB: [300, 8], WR: [290, 7], TE: [200, 6] };
for (const [pos, list] of [['QB', QB], ['RB', RB], ['WR', WR], ['TE', TE]]) {
  list.forEach((p, i) => {
    const value = Math.round(PRICE[pos] * (1 - i * 0.028));
    const points = PROJ[pos][0] - i * PROJ[pos][1];
    run(`INSERT INTO dynasty_values (format_key, player_id, value, redraft_value, trend30, age, pos_rank,
         fetched_at) VALUES (?,?,?,?,0,25,?,datetime('now'))`, FORMAT_KEY, p.id, value, value, i + 1);
    run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games, raw, fetched_at)
         VALUES (?,?,'projected',?,17,'{}',datetime('now'))`, p.id, SEASON, points);
  });
}

test('a veto-climate and timing read that throw are named and logged, not silently dropped', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 301')[0];
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let result;
  try { result = findTrades(lg, { myTeamId: '1', maxPerSide: 2, requireMutual: false, limit: 100 }); }
  finally { console.error = original; }

  assert.ok(!result.error, result.error);
  assert.ok(result.deals.length > 0, 'fixture must produce at least one deal to exercise attachTactics');
  assert.ok(errors.some(e => /veto climate/i.test(e) && /skew_pct/.test(e)),
    `expected a logged veto-climate failure naming the real error; got: ${JSON.stringify(errors)}`);
  assert.ok(errors.some(e => /veto timing/i.test(e) && /responded_at/.test(e)),
    `expected a logged veto-timing failure naming the real error; got: ${JSON.stringify(errors)}`);
});

test('the fault reaches every shown deal on tactics_absent, not just the log', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 301')[0];
  const result = findTrades(lg, { myTeamId: '1', maxPerSide: 2, requireMutual: false, limit: 100 });
  assert.ok(result.deals.length > 0, 'fixture must produce at least one deal');
  for (const d of result.deals) {
    assert.ok(Array.isArray(d.tactics_absent), `deal ${d.partner_id} must carry a tactics_absent array`);
    assert.ok(d.tactics_absent.some(a => a.key === 'veto_climate' && /skew_pct/.test(a.reason)),
      `deal ${d.partner_id} tactics_absent must name the veto-climate fault: ${JSON.stringify(d.tactics_absent)}`);
    assert.ok(d.tactics_absent.some(a => a.key === 'veto_timing' && /responded_at/.test(a.reason)),
      `deal ${d.partner_id} tactics_absent must name the veto-timing fault: ${JSON.stringify(d.tactics_absent)}`);
  }
});
