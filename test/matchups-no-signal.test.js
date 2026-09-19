/**
 * The matchup "no signal" state (matchups.js), pinned with real defense data.
 *
 * Defense-vs-position and the home/away factor failed the weekly walk-forward test,
 * so commit 11ab55c switched both off: dvpFor returns mult 1 with signal false,
 * scheduleOutlook returns sos 1 / playoff_sos 1 with no best/worst games, and the DvP
 * table is display-only. The test DB had no game logs, so turning DvP back on — or
 * deleting the no-signal return — passed every test. Here one defense (BBB) allows
 * twice what its opponents usually score, so the descriptive history is real and the
 * only thing keeping it out of projections is the switch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { ServerResponse } from 'node:http';
import { Readable, PassThrough } from 'node:stream';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-matchups-no-signal-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const M = await import('../server/services/matchups.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Four teams; six receivers who score ~10 against everyone except BBB (~20).
const TEAMS = ['AAA', 'BBB', 'CCC', 'DDD'];
TEAMS.forEach((abbr, i) => run(`INSERT OR IGNORE INTO nfl_teams (id, abbr, name, conference, division) VALUES (?, ?, ?, 'AFC', 'East')`,
  900 + i, abbr, `Team ${abbr}`));
for (let p = 0; p < 6; p++) {
  run(`INSERT INTO players (id, name, position) VALUES (?, ?, 'WR')`, 8800 + p, `Receiver ${p}`);
  for (let w = 1; w <= 12; w++) {
    const opp = TEAMS[(w + p) % 4];
    const pts = opp === 'BBB' ? 20 + (p % 3) : 10 + ((w + p) % 3);
    run(`INSERT INTO player_gamelog (player_id, season, week, opponent, fantasy_points) VALUES (?, 2025, ?, ?, ?)`, 8800 + p, w, opp, pts);
  }
}
// AAA's 2026 slate, including a row the feed wrote with AAA as its own opponent in
// week 3 (the WSH/WAS shape); CCC's row that week points back at AAA.
for (let w = 1; w <= 17; w++) {
  if (w === 9) continue; // bye
  const opp = w === 3 ? 'AAA' : TEAMS[1 + (w % 3)];
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 900, ?, ?, ?)`, w, opp, w % 2);
}
run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 902, 3, 'AAA', 1)`);
M.clearMatchupCache();

test('dvpFor: the history is real, the multiplier is 1', () => {
  const d = M.dvpFor('BBB', 'WR');
  assert.equal(d.mult, 1);
  assert.equal(d.signal, false);
  assert.equal(d.reason, M.MATCHUP_SIGNAL_REASON);
  assert.equal(d.has_data, true);
  assert.ok(d.descriptive.raw_mult > 1.3, `BBB allows far more than average: ${JSON.stringify(d.descriptive)}`);
  assert.notEqual(d.descriptive.observed_mult, 1);
});

test('scheduleOutlook: sos and playoff_sos are 1, nothing is ranked', () => {
  const o = M.scheduleOutlook('AAA', 'WR');
  assert.equal(o.sos, 1);
  assert.equal(o.playoff_sos, 1);
  assert.equal(o.signal, false);
  assert.equal(o.reason, M.MATCHUP_SIGNAL_REASON);
  assert.deepEqual(o.best, []);
  assert.deepEqual(o.worst, []);
  assert.ok(o.games.length >= 15, 'the slate itself is still there');
  assert.ok(o.games.every(g => g.mult === 1), 'every game multiplier is 1');
  assert.equal(o.bye, 9, 'bye detection still works');
});

test('dvpTable: display only, applied multiplier 1', () => {
  const table = M.dvpTable('WR');
  assert.ok(table.length >= 4);
  assert.ok(table.every(r => r.display_only === true && r.applied_mult === 1));
  assert.ok(table.some(r => r.mult !== 1), 'the descriptive column still carries the history');
});

test('GET /trades/dvp says there is no signal, and why', async () => {
  const app = express();
  app.use('/api/trades', tradesRouter);
  const req = new Readable({ read() { this.push(null); } });
  req.url = '/api/trades/dvp?position=WR'; req.method = 'GET'; req.headers = {};
  req.socket = new PassThrough(); req.connection = req.socket;
  const body = await new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = c => { chunks.push(Buffer.from(c)); return true; };
    res.end = c => { if (c) chunks.push(Buffer.from(c)); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); };
    app.handle(req, res, reject);
  });
  assert.equal(body.signal, false);
  assert.equal(body.reason, M.MATCHUP_SIGNAL_REASON);
  assert.ok(body.table.every(r => r.applied_mult === 1));
});

test('a schedule row naming its own team as the opponent is repaired from the other side', () => {
  assert.equal(M.matchupModel().schedule_repairs.self_opponent_repaired, 1);
  assert.equal(M.scheduleOutlook('AAA', 'WR').games.find(g => g.week === 3).opponent, 'CCC');
});
