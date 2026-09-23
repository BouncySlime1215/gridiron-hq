/**
 * B-01 — a team's real record reaches its playoff odds (2026-09-22).
 *
 * Every page-facing season simulation called `simulateSeason` with the default
 * `fromWeek = 1`: GET /simulate and POST /trade-impact in server/routes/model.js
 * passed `|| 1`, and title-odds-trades.js and the trade sense-check in
 * routes/trades.js passed nothing. `initialRecords()` returns an empty record
 * for `fromWeek <= 1`, so in week 6 a 5-0 team was simulated as 0-0 and its
 * odds were those of a team that had not played.
 *
 * The fixture is a six-team ESPN league in week 6 (`leagues.current_week = 6`)
 * where team 1 has won all five completed weeks, four of six make the playoffs.
 * It has no weekly projection history, so every simulated week is a 0-0 tie
 * and the simulated standings are exactly the carried-in record: odds move
 * only if the real record reaches the sim. Team 1 is listed LAST so that at
 * 0-0 it loses every tie-break (odds 0) — the fixture's own control, measured
 * below with an explicit fromWeek = 1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-b01-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '6';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const { deriveFormat } = await import('../server/services/format.js');
const { simulateSeason, simStartWeek, tradeImpact } = await import('../server/services/season-sim.js');
const { withRandomSeed } = await import('../server/services/stats-util.js');
const { myPlayoffOdds } = await import('../server/services/trade-engine.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { default: modelRouter } = await import('../server/routes/model.js');
const express = (await import('express')).default;

await runMigrations();
seedIfEmpty();

// The two page routes, driven over HTTP by a league member.
run(`INSERT INTO users (subject, display_name) VALUES ('b01', 'b01')`);
const userId = rows('SELECT last_insert_rowid() AS id')[0].id;
run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now','+1 day'))`,
  userId, hashSessionToken('b01-token'));
const app = express();
app.use(express.json());
app.use('/api/model', modelRouter);
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/model`;
const auth = { Authorization: 'Bearer b01-token', 'Content-Type': 'application/json' };

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
const CURRENT_WEEK = 6;

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

/** Round-robin over 14 weeks; weeks before CURRENT_WEEK are scored, team 1 winning each. */
function schedule() {
  const out = [];
  const ids = [1, 2, 3, 4, 5, 6];
  for (let w = 1; w <= 14; w++) {
    const rot = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + w - 1) % 5)])];
    for (let i = 0; i < 3; i++) {
      const home = rot[i], away = rot[5 - i];
      const done = w < CURRENT_WEEK;
      const pts = id => (id === 1 ? 180 : 100 + id);
      out.push({ matchupPeriodId: w,
        home: { teamId: home, totalPoints: done ? pts(home) : undefined },
        away: { teamId: away, totalPoints: done ? pts(away) - 5 : undefined } });
    }
  }
  return out;
}

let fakeId = 950000;
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
  const members = teams.map((t, i) => ({ id: t.owners[0], firstName: `First${i + 1}`, lastName: `Last${i + 1}` }));
  teams.reverse();                              // team 1 last: it loses 0-0 tie-breaks
  return { teams, members, schedule: schedule(),
    settings: { name: 'B01 League', scheduleSettings: { matchupPeriodCount: 14, matchupPeriodLength: 1,
      playoffTeamCount: 4, playoffMatchupPeriodLength: 1,
      // CE-05: the simulator refuses a league whose rules are incomplete.
      playoffReseed: false, playoffSeedingRule: 'TOTAL_POINTS_SCORED', divisions: [{ id: 0, size: 6 }] } } };
}

function insertLeague(id, payload, { currentWeek = CURRENT_WEEK, payloadSeason = 2026 } = {}) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status, current_week, payload_season)
       VALUES (?, 'espn', ?, 2026, 'B01 League', ?, 6, '1', ?, 'x', 'y', 'connected', ?, ?)`,
  id, `espn-b01-${id}`, JSON.stringify(payload), JSON.stringify(SLOTS), currentWeek, payloadSeason);
  run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?, ?, 'commissioner')`, id, userId);
  return rows('SELECT * FROM leagues WHERE id = ?', id)[0];
}

const team1 = sim => sim.teams.find(t => String(t.roster_id) === '1');
const payload = sixTeamLeague();

test('B-01: with no fromWeek, a 5-0 team in week 6 is simulated as 5-0', () => {
  const lg = insertLeague(601, payload);
  const sim = withRandomSeed(601, () => simulateSeason(lg, { runs: 400 }));
  assert.ok(!sim.error, sim.error);
  assert.equal(sim.from_week, CURRENT_WEEK, 'the default start is the league\'s current week');
  assert.equal(sim.standings_carried_in, true);
  const odds = team1(sim).playoff_odds;
  assert.ok(odds >= 0.9, `a 5-0 team with 4 of 6 making the playoffs got playoff odds ${odds}`);

  // The same league from week 1 is the 0-0 answer the pages used to show.
  const fresh = withRandomSeed(601, () => simulateSeason(lg, { runs: 400, fromWeek: 1 }));
  assert.equal(fresh.from_week, 1, 'an explicit fromWeek = 1 still means a fresh season');
  assert.ok(team1(fresh).playoff_odds <= 0.1,
    `control: at 0-0 team 1 must not already be a lock (got ${team1(fresh).playoff_odds})`);
});

test('B-01: simStartWeek is the one producer — explicit week wins, else the league week', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 601')[0];
  assert.equal(simStartWeek(lg), CURRENT_WEEK);
  assert.equal(simStartWeek(lg, null), CURRENT_WEEK);
  assert.equal(simStartWeek(lg, 0), CURRENT_WEEK, 'a missing ?from_week parses to 0 and is not a week');
  assert.equal(simStartWeek(lg, 3), 3);
});

test('B-01: a payload that is last season\'s (pre-draft fallback) starts at week 1', () => {
  // Its scored weeks are last year's results; carrying them in would hand
  // this season's standings last season's record.
  const lg = insertLeague(602, payload, { payloadSeason: 2025 });
  assert.equal(simStartWeek(lg), 1);
});

test('B-01: the page routes no longer pin from_week to 1', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/routes/model.js'), 'utf8');
  assert.ok(/simulateSeason\(lg,/.test(src), 'control: the route still calls simulateSeason');
  assert.doesNotMatch(src, /from_week\)\s*\|\|\s*1/, 'a route still defaults from_week to 1');
});

/* ---- review round 1: every page-facing caller, not just simulateSeason ---- */

test('B-01: tradeImpact with no fromWeek starts at the league week with the real record', () => {
  // Its callers (title-odds-trades.js, the routes/trades.js sense-check) pass no week.
  const lg = rows('SELECT * FROM leagues WHERE id = 601')[0];
  const impact = tradeImpact(lg, { myTeamId: 1, theirTeamId: 2, runs: 300, seed: 7 });
  assert.ok(!impact.error, impact.error);
  assert.equal(impact.from_week, CURRENT_WEEK);
  assert.ok(impact.me.playoff_before >= 0.9, `5-0 team priced at ${impact.me.playoff_before} before the trade`);
});

test('B-01: GET /simulate starts at the league week and its memo follows the week', async () => {
  insertLeague(603, payload);
  const sim = await (await fetch(`${base}/603/simulate?runs=300&seed=3`, { headers: auth })).json();
  assert.equal(sim.from_week, CURRENT_WEEK, JSON.stringify(sim).slice(0, 200));
  assert.ok(team1(sim).playoff_odds >= 0.9, `route priced the 5-0 team at ${team1(sim).playoff_odds}`);
  run('UPDATE leagues SET current_week = 7 WHERE id = 603');
  const next = await (await fetch(`${base}/603/simulate?runs=300&seed=3`, { headers: auth })).json();
  assert.equal(next.from_week, 7, 'the /simulate memo stayed on the old start week after the league moved on');
});

test('B-01: POST /trade-impact starts at the league week', async () => {
  const res = await fetch(`${base}/601/trade-impact`, { method: 'POST', headers: auth,
    body: JSON.stringify({ my_team_id: '1', their_team_id: '2', runs: 300, seed: 5 }) });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.from_week, CURRENT_WEEK);
  assert.ok(body.me.playoff_before >= 0.9, `route priced the 5-0 team at ${body.me.playoff_before}`);
});

test('B-01: myPlayoffOdds (Trades page) uses simStartWeek, not the NFL game_lines week', () => {
  // NFL_WEEK = 6 in this file; the league is on week 4 — the Monday-night /
  // next-sync gap. One producer means the Trades page starts where /simulate does.
  const lagging = insertLeague(604, payload, { currentWeek: 4 });
  assert.equal(simStartWeek(lagging), 4, 'control: the league week differs from NFL_WEEK');
  const odds = myPlayoffOdds(lagging, '1');
  assert.match(odds.source, /from week 4$/, odds.source);
  const direct = withRandomSeed(20260918, () => simulateSeason(lagging, { runs: 1000 }));
  assert.equal(odds.value, +team1(direct).playoff_odds.toFixed(2), 'Trades page and /simulate disagree on the same league');

  // Pre-draft fallback: last season's payload must not be carried in by the engine either.
  const stale = insertLeague(605, payload, { payloadSeason: 2025 });
  assert.match(myPlayoffOdds(stale, '1').source, /from week 1$/, 'the engine carried last season\'s results in');
});

// --- INT-162-1 (B-01 hardening, 2026-09-23) -------------------------------
//
// Two gaps left after B-01 landed:
//
// (1) simStartWeek() checks `requested` before it checks the payload/season
//     mismatch (season-sim.js ~176-177), so a client-supplied ?from_week (or
//     POST body.from_week) on a league whose payload is last season's still
//     wins and reintroduces the exact bug B-01 fixed, just via an explicit
//     week instead of the `|| 1` default.
// (2) `simulateSeason`/`tradeImpact` already resolve their own start week by
//     calling `simStartWeek(lg, requestedWeek)` internally (season-sim.js:280,
//     :457) — simStartWeek is meant to be their one producer. A caller that
//     also computes and passes `fromWeek` is a second, redundant producer of
//     the same number and can drift from it; the source guard below fails
//     while any caller under server/ still does that.

test('B-01 hardening: simStartWeek ignores a client from_week on a stale (last season\'s) payload', () => {
  // Same fixture as the pre-draft-fallback case above, but now the request
  // carries an explicit from_week — the client can't know the payload is
  // stale, so it must not be able to override week 1.
  const stale = insertLeague(606, payload, { payloadSeason: 2025 });
  assert.equal(simStartWeek(stale, 5), 1,
    'a client from_week=5 must not resurrect last season\'s payload as week 5');
  assert.equal(simStartWeek(stale, '5'), 1,
    'same guard for a raw ?from_week query string, not just a parsed number');

  // Control: the same explicit week on a current-season payload still wins —
  // this proves the assertions above test the stale-payload guard, not a
  // general "explicit week is ignored" regression.
  const current = rows('SELECT * FROM leagues WHERE id = 601')[0];
  assert.equal(simStartWeek(current, 5), 5, 'control: explicit week wins on a current-season payload');
});

test('B-01 hardening: source guard — no tradeImpact/simulateSeason caller under server/ passes fromWeek', () => {
  // simStartWeek is the one producer of a sim's start week; simulateSeason and
  // tradeImpact already call it themselves (season-sim.js:280, :457). A caller
  // that also passes `fromWeek` is a second producer of the same number.
  const serverDir = path.join(process.cwd(), 'server');
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js')) files.push(p);
    }
  })(serverDir);
  assert.ok(files.length > 50, `control: expected many files under server/, found ${files.length}`);

  const offenders = [];
  for (const file of files) {
    if (file.endsWith(path.join('server', 'services', 'season-sim.js'))) continue; // the producer itself
    const src = fs.readFileSync(file, 'utf8');
    // A call to simulateSeason(...) or tradeImpact(...) whose argument object
    // (up to the matching close) contains a `fromWeek` key.
    const callRe = /\b(?:simulateSeason|tradeImpact)\(\s*[^,]+,\s*\{([\s\S]*?)\}\s*\)/g;
    let m;
    while ((m = callRe.exec(src))) {
      if (/\bfromWeek\b/.test(m[1])) { // matches `fromWeek:` and the `{ fromWeek }` shorthand alike
        offenders.push(`${path.relative(process.cwd(), file)}: ${m[0].split('\n')[0]}…`);
      }
    }
  }
  assert.deepEqual(offenders, [], `caller(s) pass fromWeek directly instead of leaving it to simStartWeek:\n${offenders.join('\n')}`);
});
