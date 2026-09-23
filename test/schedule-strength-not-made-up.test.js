// RL-8-3: every strength-of-schedule rank the app printed was fabricated.
// computeSOS ranked teams off an empty fc_value store (so the rank was "games vs
// Washington, then row order"), and syncSchedules stored ESPN's WSH so Washington
// was its own opponent. Schedule strength is not a validated signal, so the rank
// is removed from every served surface; computeSOS and its reader-less GET /sos
// are deleted so edge.js#scheduleEdge is the one producer of the number; the
// writer canonicalises team codes and backfills stored rows (incl. home flags).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-sos-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, row, run } = await import('../server/db/index.js');
const nfldata = await import('../server/routes/nfldata.js');
const players = await import('../server/routes/players.js');
const edge = await import('../server/routes/edge.js');
const { MATCHUP_SIGNAL_REASON } = await import('../server/services/matchups.js');
const express = (await import('express')).default;

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// ESPN team ids double as our nfl_teams ids here: WAS 28, DAL 6, PHI 21.
run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
     (28, 'WAS', 'Washington Commanders', 'NFC', 'East'),
     (6, 'DAL', 'Dallas Cowboys', 'NFC', 'East'),
     (21, 'PHI', 'Philadelphia Eagles', 'NFC', 'East')`);
let pid = 0;
function player(teamId, fc = null) {
  pid++;
  run(`INSERT INTO players (id, name, position, team_id, fantasy_relevant) VALUES (?, ?, 'WR', ?, 1)`, pid, `P${pid}`, teamId);
  run(`INSERT INTO player_metrics (player_id, source, value) VALUES (?, 'sleeper_rank', ?)`, pid, 10 + pid);
  if (fc != null) run(`INSERT INTO player_metrics (player_id, source, value) VALUES (?, 'fc_value', ?)`, pid, fc);
  return pid;
}
const SEASON = 2030;
function game(teamId, week, opp, home) {
  run(`INSERT INTO schedule_games (season, team_id, week, date, opponent_abbr, home) VALUES (?,?,?,?,?,?)`,
    SEASON, teamId, week, `2030-09-0${week}`, opp, home);
}
// The shape the broken writer produced: WAS names WSH (itself), rivals name WSH.
game(28, 1, 'WSH', 0); game(6, 1, 'WSH', 0);
game(28, 2, 'PHI', 0); game(21, 2, 'WSH', 1);
game(6, 2, 'PHI', 1); game(21, 1, 'DAL', 1);
const wasP = player(28); player(6); player(21);

test('one producer: computeSOS and GET /nfl/sos are gone (no reader, duplicate of scheduleEdge)', async () => {
  assert.equal(nfldata.computeSOS, undefined);
  const app = express();
  app.use('/nfl', nfldata.default);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const control = await realFetch(`http://127.0.0.1:${port}/nfl/offseason/WAS?season=${SEASON}`);
    assert.equal(control.status, 200, 'control: the same router serves a neighbouring route');
    const sos = await realFetch(`http://127.0.0.1:${port}/nfl/sos?season=${SEASON}`);
    assert.equal(sos.status, 404);
  } finally { server.close(); }
});

test('the one remaining producer (scheduleEdge): empty store is null and unranked', () => {
  // control: the same table has rows from its other writer
  assert.ok(row(`SELECT COUNT(*) AS n FROM player_metrics WHERE source = 'sleeper_rank'`).n > 0);
  assert.equal(row(`SELECT COUNT(*) AS n FROM player_metrics WHERE source = 'fc_value'`).n, 0);
  const out = edge.scheduleEdge(SEASON);
  assert.ok(out.length === 3);
  for (const t of out) {
    assert.equal(t.season_sos, null);
    assert.equal(t.playoff_rank, null);
    assert.match(t.unavailable_reason, /fc_value/);
  }
});

test('known-nonzero control: scheduleEdge folds WSH onto WAS, and an opponent with no fc_value is the average, not 0', () => {
  // DAL=3000, PHI=6000, WAS has no fc_value row (the partial-data case).
  run(`INSERT INTO player_metrics (player_id, source, value) VALUES (?, 'fc_value', 3000)`, wasP + 1);
  run(`INSERT INTO player_metrics (player_id, source, value) VALUES (?, 'fc_value', 6000)`, wasP + 2);
  try {
    const by = Object.fromEntries(edge.scheduleEdge(SEASON).map(t => [t.abbr, t.season_sos]));
    // avg over teams with data = 4500; WAS (no data) counts as 4500.
    // DAL plays WSH(=WAS, 4500) and PHI (6000): (4500+6000)/2/4500.
    assert.equal(by.DAL, +((4500 + 6000) / 2 / 4500).toFixed(3));
    // PHI plays WSH(=WAS, 4500) and DAL (3000).
    assert.equal(by.PHI, +((4500 + 3000) / 2 / 4500).toFixed(3));
    assert.ok(by.DAL > by.PHI, 'the order the stale computeSOS flipped');
  } finally {
    run(`DELETE FROM player_metrics WHERE source = 'fc_value'`); // test-db cleanup only
  }
});

const here = path.dirname(fileURLToPath(import.meta.url));
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(p);
    return /\.(js|jsx|ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

test('no served string prints a schedule rank', () => {
  const hits = [...sourceFiles(path.join(here, '../server')), ...sourceFiles(path.join(here, '../client/src'))]
    .filter(f => /Remaining schedule ranks|Strength of schedule ranks|sos\.rank|sos\?\.rank/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(path.join(here, '..'), f));
  assert.deepEqual(hits, []);
});

test('the Buy/Sell evidence packet carries no schedule fact', () => {
  assert.equal(typeof players.playerEvidenceFacts, 'function');
  const facts = players.playerEvidenceFacts({
    player: { name: 'P1', position: 'WR', team_abbr: 'WAS', team_name: 'Washington Commanders' },
    metrics: { sleeper_rank: 12 }, news: [], depth: []
  });
  assert.deepEqual(facts.map(f => f.id), ['market.sleeper_rank'], 'control fact present, schedule fact absent');
});

test('the team page route serves no schedule rank and says why', async () => {
  const app = express();
  app.use('/nfl', nfldata.default);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const body = await (await realFetch(`http://127.0.0.1:${port}/nfl/offseason/WAS?season=${SEASON}`)).json();
    assert.ok(Array.isArray(body.schedule) && body.schedule.length > 0, 'control: the schedule itself is served');
    assert.equal(body.sos, undefined);
    assert.ok(!JSON.stringify(body).includes('"rank"'));
    assert.deepEqual(body.schedule_signal, { signal: false, reason: MATCHUP_SIGNAL_REASON });
  } finally { server.close(); }
});

test('syncSchedules maps an ESPN WSH row to WAS and backfills stored rows by update, not delete', async () => {
  const S2 = 2031;
  // stale rows from the broken writer for a week this sync will not return
  run(`INSERT INTO schedule_games (season, team_id, week, date, opponent_abbr, home) VALUES
       (?, 28, 3, '2031-09-20', 'WSH', 0), (?, 6, 3, '2031-09-20', 'WSH', 1),
       (?, 28, 4, '2031-09-27', 'WSH', 0), (?, 21, 4, '2031-09-27', 'WSH', 0)`, S2, S2, S2, S2);
  // week 4 is a Washington HOME game stored with home=0 on both rows: the WAS row
  // must take the flag from PHI's row (PHI matched itself, so its home=0 is right).
  const ev = (week, home, away) => ({ week: { number: week }, date: `2031-09-0${week}T17:00Z`, competitions: [{ competitors: [
    { homeAway: 'home', team: { abbreviation: home } }, { homeAway: 'away', team: { abbreviation: away } }] }] });
  const feeds = {
    28: [ev(1, 'WSH', 'DAL'), ev(2, 'PHI', 'WSH')],
    6: [ev(1, 'WSH', 'DAL')],
    21: [ev(2, 'PHI', 'WSH')]
  };
  globalThis.fetch = async url => {
    const m = String(url).match(/\/teams\/(\d+)\/schedule/);
    if (m && feeds[m[1]]) return { ok: true, json: async () => ({ events: feeds[m[1]] }) };
    return { ok: false, status: 404 };
  };
  let result;
  try { result = await nfldata.syncSchedules(S2); } finally { globalThis.fetch = realFetch; }
  const got = Object.fromEntries(rows(`SELECT t.abbr, g.week, g.opponent_abbr, g.home FROM schedule_games g
    JOIN nfl_teams t ON t.id = g.team_id WHERE g.season = ?`, S2).map(g => [`${g.abbr}${g.week}`, `${g.opponent_abbr}/${g.home}`]));
  assert.deepEqual(got, {
    WAS1: 'DAL/1', DAL1: 'WAS/0',
    WAS2: 'PHI/0', PHI2: 'WAS/1',
    WAS3: 'DAL/0', DAL3: 'WAS/1',  // backfilled stale rows
    WAS4: 'PHI/1', PHI4: 'WAS/0'   // backfilled stale rows incl. the WAS home flag
  });
  assert.equal(row(`SELECT COUNT(*) AS n FROM schedule_games WHERE season = ? AND opponent_abbr = 'WSH'`, S2).n, 0);
  assert.equal(result.repaired.opponents_canonicalised, 4);
  assert.equal(result.repaired.self_opponent_repaired, 2);
  assert.equal(result.repaired.home_flag_repaired, 1);
  assert.equal(result.repaired.rows_updated, 4);
});
