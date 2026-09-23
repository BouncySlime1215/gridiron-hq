/**
 * QUICKFIX-01. Two independent things pinned here:
 *
 * 1. trade-engine.js's `attachTactics` wraps `selfRead(lg.id, ...)` in a
 *    try/catch. Before this fix the catch was bare (`catch { self = null; }`):
 *    a thrown error from selfRead vanished with no log and no trace in the
 *    served data. `self = null` then reads through trade-tactics.js
 *    (`self?.available === false ? self.reason : '...'`) exactly like a
 *    HEALTHY empty result (no captured league history) — a real lookup fault
 *    is indistinguishable from "nothing to report." This test proves the
 *    fault is now surfaced: logged, and carried as a typed absence
 *    (`available: false`, a reason naming the failure) that the tactic copy
 *    can tell apart from the genuine "nothing here" case.
 *
 * 2. trade-tactics.js's veto-proof docstring named a real leaguemate. The
 *    public-repo no-names rule (WORK-QUEUE.md §4 rule 12 class; PLAN-ITEMS
 *    hard rules) forbids a manager's name in a comment. Grepped directly
 *    against the source, with a known-nonzero control so a silently-broken
 *    grep cannot read as "name is gone."
 *
 * Fixture (roster/market/schedule) copied from the proven pattern in
 * test/trade-engine-correctness.test.js rather than reinvented, so deals
 * actually come out the other end for tactics to attach to.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --------------------------------------------------------------- grep test
// No DB / imports needed for this half — pure source-text check.
test('trade-tactics.js no longer names a real leaguemate in the veto-proof docstring', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server/services/trade-tactics.js'), 'utf8');

  // Known-nonzero control first (gridiron-contradiction-test-rule): confirm
  // the grep itself can find a name-shaped string before trusting a 0 count.
  assert.ok(/Etienne/.test(src), 'control: "Etienne" (a player name, expected to stay) must still be found');

  assert.ok(!/\bRami\b/.test(src), 'the leaguemate name "Rami" must not appear in trade-tactics.js');
});

// ----------------------------------------------------------- selfRead fault
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-quickfix-01-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '2';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const { deriveFormat } = await import('../server/services/format.js');

await runMigrations();
seedIfEmpty();

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// selfRead is mocked to throw; every other export of counterparty-pricing.js
// stays real, so the rest of the trade search (valuation, perception, etc.)
// runs unchanged and only the one code path under test is faulted.
const realPricing = await import('../server/services/counterparty-pricing.js');
mock.module('../server/services/counterparty-pricing.js', {
  namedExports: {
    ...realPricing,
    selfRead: () => { throw new Error('selfRead boom (QUICKFIX-01 fixture)'); },
  },
});

const { findTrades } = await import('../server/services/trade-engine.js');

/* ------------------------------------------------------------------ fixture
 * Copied from test/trade-engine-correctness.test.js's sixTeamLeague/seedMarket. */

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

let fakeId = 910000;
function sixTeamLeague() {
  const pick = (pos, n) => rows(`SELECT id, name, position FROM players WHERE position = ? AND fantasy_relevant = 1
                                 ORDER BY id LIMIT ?`, pos, n);
  const qb = pick('QB', 6), rb = pick('RB', 18), wr = pick('WR', 18), te = pick('TE', 6);
  seedMarket([...qb, ...rb, ...wr, ...te]);
  const teams = [];
  for (let i = 0; i < 6; i++) {
    const roster = [qb[i], rb[i], rb[11 - i], rb[12 + i], wr[5 - i], wr[6 + i], wr[17 - i], te[5 - i]].filter(Boolean);
    teams.push({ id: i + 1, name: `Team ${i + 1}`, owners: [`{M${i + 1}}`],
      roster: { entries: roster.map(p => ({
        playerPoolEntry: { player: { id: fakeId++, fullName: p.name, defaultPositionId: POS_ID[p.position] } } })) } });
  }
  const members = teams.map((t, i) => ({ id: t.owners[0], firstName: `First${t.id}`, lastName: `Last${t.id}` }));
  return { teams, members, schedule: schedule(14),
    settings: { name: 'QF01 League', scheduleSettings: { matchupPeriodCount: 14, matchupPeriodLength: 1,
      playoffTeamCount: 4, playoffMatchupPeriodLength: 1,
      playoffReseed: false, playoffSeedingRule: 'TOTAL_POINTS_SCORED', divisions: [{ id: 0, size: 6 }] } } };
}

function insertLeague(id, payload) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, 2026, 'QF01 League', ?, 6, '1', ?, 'x', 'y', 'connected')`,
    id, `espn-qf01-${id}`, JSON.stringify(payload), JSON.stringify(SLOTS));
  return rows('SELECT * FROM leagues WHERE id = ?', id)[0];
}

const lg = insertLeague(501, sixTeamLeague());

test('a selfRead fault is logged and surfaced as a typed absence, not swallowed by a bare catch', () => {
  const errCalls = [];
  const errMock = mock.method(console, 'error', (...args) => { errCalls.push(args); });
  let result;
  try {
    result = findTrades(lg, { myTeamId: '1', maxPerSide: 2, requireMutual: false, limit: 100 });
  } finally {
    errMock.mock.restore();
  }

  assert.ok(!result.error, result.error);
  assert.ok(result.deals.length > 0, 'fixture must produce at least one deal for tactics to run on');

  // The fault must be logged, not silently dropped.
  assert.ok(errCalls.some(args => String(args[0]).includes('selfRead')),
    'a thrown selfRead must be logged via console.error, not swallowed');

  // And the served tactic copy must name the fault, not read like a healthy
  // "nothing captured for this league" result (the pre-fix bare-catch
  // behaviour: self=null reads through the SAME generic sentence as no data).
  const withTactic = result.deals.find(d => (d.tactics ?? []).some(t => t.key === 'how_nick_looks'));
  assert.ok(withTactic, 'at least one deal must carry a how_nick_looks tactic entry');
  const tactic = withTactic.tactics.find(t => t.key === 'how_nick_looks');
  assert.match(tactic.why, /lookup failed/i,
    `expected the surfaced fault reason, got: ${JSON.stringify(tactic.why)}`);
  assert.doesNotMatch(tactic.why, /you have never made this manager an offer/,
    'a selfRead FAULT must not read identically to a genuine empty/no-history result');
});
