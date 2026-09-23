/**
 * A-03: the ESPN scoring report reaches a route, and D/ST points are computed
 * from pointsOverrides by a real consumer.
 *
 * Skeptics on PR #163 found the report (`espn.source/unscored/unmapped`) and
 * the `slot` resolution were read only by the unit tests: no route, job or
 * page ever saw them, so a stat id the app cannot apply still vanished in
 * silence. This suite pins the two readers:
 *
 *  1. GET /api/leagues/:id/scoring serves the report, and scores every
 *     rostered D/ST's actual week lines at slot 16 next to ESPN's own
 *     appliedTotal for the same line.
 *  2. syncEspnLeague returns the report's summary (and warns), so the manual
 *     sync response and the scheduled roster refresh both carry it.
 *
 * The fixture follows ESPN's shapes (scoringItems with pointsOverrides keyed
 * by slot; roster entries whose player.stats carry statSourceId 0 = actual,
 * statSplitTypeId 1 = one scoring period, raw `stats` by stat id and
 * `appliedTotal`). No real league data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-league-scoring-report-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { default: leaguesRouter, syncEspnLeague } = await import('../server/routes/leagues.js');
const { requireAuthenticated, hashSessionToken } = await import('../server/platform/auth.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api/leagues', requireAuthenticated, leaguesRouter);
app.use((err, req, res, next) => res.status(err.status ?? 500).json({ error: err.message }));
const server = app.listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}/api/leagues`;

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const item = (statId, points, overrides) => ({
  statId, points, isReverseItem: false, leagueRanking: 0, leagueTotal: 0,
  ...(overrides ? { pointsOverrides: overrides } : {})
});
const scoringItems = [
  item(3, 0.04), item(4, 4), item(20, -2), item(24, 0.1), item(25, 6),
  item(42, 0.1), item(43, 6), item(53, 1), item(72, -2),
  // D/ST: real values only in pointsOverrides['16'].
  item(99, 0, { 16: 1 }), item(95, 0, { 16: 2 }), item(121, 0, { 16: 0 }),
  item(123, 0, { 16: -3 }), item(131, 0, { 16: 0 }),
  item(96, 2),
  // A bonus the skill-player scorer has no column for, and an id outside the
  // public list.
  item(37, 3), item(209, 1)
];

const actual = (week, stats, appliedTotal) =>
  ({ statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: week, seasonId: 2026, stats, appliedTotal });
const projected = (week, stats, appliedTotal) =>
  ({ statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: week, seasonId: 2026, stats, appliedTotal });

const payload = {
  settings: { name: 'Scoring Report League', scoringSettings: { scoringItems }, rosterSettings: { lineupSlotCounts: { 0: 1, 16: 1 } } },
  status: { currentMatchupPeriod: 3 },
  teams: [
    { id: 1, roster: { entries: [
      { lineupSlotId: 16, playerPoolEntry: { player: { id: -16001, fullName: 'Alpha D/ST', defaultPositionId: 16, stats: [
        // 3 sacks + 1 INT + 1 FR, 20 PA (tier 121), 320 YA (tier 131): 3 + 2 + 2 + 0 + 0 = 7.
        actual(2, { 99: 3, 95: 1, 96: 1, 121: 1, 131: 1 }, 7),
        // A projection line: not an observed week, never checked.
        projected(3, { 99: 2.4 }, 2.4)
      ] } } },
      { lineupSlotId: 0, playerPoolEntry: { player: { id: 5001, fullName: 'Alpha Passer', defaultPositionId: 1, stats: [
        actual(2, { 3: 250, 4: 2 }, 18)
      ] } } }
    ] } },
    { id: 2, roster: { entries: [
      { lineupSlotId: 16, playerPoolEntry: { player: { id: -16002, fullName: 'Bravo D/ST', defaultPositionId: 16, stats: [
        // 1 sack, 28-34 PA (tier 123): 1 - 3 = -2, but ESPN applied -1: a mismatch to report.
        actual(2, { 99: 1, 123: 1 }, -1)
      ] } } }
    ] } }
  ]
};

run(`INSERT INTO leagues (platform, league_id, season, name, ppr, payload)
     VALUES ('espn','scoring-report-league',2026,'Scoring Report League',1,?)`, JSON.stringify(payload));
const lg = row(`SELECT * FROM leagues WHERE league_id = 'scoring-report-league'`);

const token = 'league-scoring-report-token';
run('INSERT INTO users (subject, display_name) VALUES (?,?)', 'scoring-report-tester', 'Scoring Report Tester');
const userId = row('SELECT last_insert_rowid() AS id').id;
run('INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,?)', lg.id, userId, 'commissioner');
run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now','+1 day'))`,
  userId, hashSessionToken(token));
const auth = { authorization: `Bearer ${token}` };

const getReport = async (id = lg.id) => {
  const res = await fetch(`${base}/${id}/scoring`, { headers: auth });
  return { status: res.status, body: await res.json() };
};

test('GET /:id/scoring serves where the weights came from and every id the scorer cannot apply', async () => {
  const { status, body } = await getReport();
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.source, 'league');
  assert.equal(body.reason, null);
  assert.equal(body.player_weights.rush_yd, 0.1);
  assert.equal(body.player_weights.rec, 1);
  assert.deepEqual(body.unmapped, [{ statId: 209, points: 1 }]);
  const unscored = Object.fromEntries(body.unscored.map(u => [u.statId, u.points]));
  assert.equal(unscored[37], 3, 'the rushing 100-yard bonus is paid and not applied to player lines');
  assert.equal(unscored[96], 2);
  // INT-163-1: the route says the payload carries slot-specific pricing, and for which slots.
  assert.equal(body.hasOverrides, true);
  assert.deepEqual(body.overrideSlots, [16]);
});

test('GET /:id/scoring scores each rostered D/ST week from pointsOverrides[16], beside ESPN\'s applied total', async () => {
  const { body } = await getReport();
  const { dst } = body;
  assert.equal(dst.slot, 16);
  assert.equal(dst.week_lines, 2, 'two observed D/ST weeks; the projection line is not one');
  assert.equal(dst.matched, 1);
  const alpha = dst.lines.find(l => l.team_id === 1);
  assert.equal(alpha.week, 2);
  assert.equal(alpha.points, 7, 'sacks 3 + INT 2 + FR 2 + tiers 0, read from the slot-16 overrides');
  assert.equal(alpha.espn_applied, 7);
  assert.equal(alpha.matches, true);
  const bravo = dst.lines.find(l => l.team_id === 2);
  assert.equal(bravo.points, -2);
  assert.equal(bravo.espn_applied, -1);
  assert.equal(bravo.matches, false, 'a disagreement with ESPN is shown, not smoothed over');
  assert.deepEqual(dst.mismatched, [{ team_id: 2, espn_player_id: -16002, week: 2, points: -2, espn_applied: -1 }]);
});

test('GET /:id/scoring on a league with no payload says it fell back, and why', async () => {
  run(`INSERT INTO leagues (platform, league_id, season, name, ppr) VALUES ('espn','unsynced-scoring',2026,'Unsynced',1)`);
  const bare = row(`SELECT id FROM leagues WHERE league_id = 'unsynced-scoring'`).id;
  run('INSERT INTO league_memberships (league_id, user_id, role) VALUES (?,?,?)', bare, userId, 'commissioner');
  const { status, body } = await getReport(bare);
  assert.equal(status, 200);
  assert.equal(body.source, 'fallback');
  assert.equal(body.reason, 'no-payload');
  assert.equal(body.dst.week_lines, 0);
});

test('GET /:id/scoring refuses a caller who is not in the league', async () => {
  const stranger = 'league-scoring-stranger-token';
  run('INSERT INTO users (subject, display_name) VALUES (?,?)', 'scoring-stranger', 'Stranger');
  const sid = row('SELECT last_insert_rowid() AS id').id;
  run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now','+1 day'))`,
    sid, hashSessionToken(stranger));
  const res = await fetch(`${base}/${lg.id}/scoring`, { headers: { authorization: `Bearer ${stranger}` } });
  assert.equal(res.status, 403);
});

test('syncEspnLeague returns the scoring summary and warns about ids it cannot apply', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => payload }));
  const warn = t.mock.method(console, 'warn', () => {});
  const result = await syncEspnLeague(lg);
  assert.equal(result.scoring.source, 'league');
  assert.equal(result.scoring.reason, null);
  assert.deepEqual(result.scoring.unmapped, [{ statId: 209, points: 1 }]);
  assert.ok(result.scoring.unscored.some(u => u.statId === 37));
  // INT-163-1: the summary every sync carries (manual response and scheduled
  // league_rosters sync_log detail) forwards the override report too.
  assert.equal(result.scoring.hasOverrides, true);
  assert.deepEqual(result.scoring.overrideSlots, [16]);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /209/);
});

test('the Leagues page prints the sync\'s scoring summary after both add-and-sync and re-sync', () => {
  // The page is TSX and has no test runner here, so this reads the source:
  // the summary the sync returns must reach the message a person sees.
  const src = fs.readFileSync(path.join(process.cwd(), 'client/src/pages/Leagues.tsx'), 'utf8');
  assert.equal((src.match(/\$\{scoringNote\(s\.scoring\)\}/g) ?? []).length, 2,
    'both sync messages (add and re-sync) must append scoringNote(s.scoring)');
  assert.match(src, /paid stat ids not applied to player projections/);
  assert.match(src, /unknown stat ids/);
});
