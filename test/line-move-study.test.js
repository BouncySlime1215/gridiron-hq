import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Beat the close, Phase 1: the study must find a feature that moves the line,
// hold out correctly, refuse thin slices, and never use anything after the close.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-line-move-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');
await import('../server/services/odds-archive.js');
const study = await import('../server/services/line-move-study.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const TEAMS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'];
let seed = 11;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
const SOFT = ['bovada', 'betonlineag', 'lowvig'];
let eid = 1000;

function seedSeason(season) {
  for (let week = 1; week <= 18; week++) {
    const gameday = new Date(Date.UTC(season, 8, 7) + (week - 1) * 7 * 86400000).toISOString().slice(0, 10);
    for (let i = 0; i < TEAMS.length; i += 2) {
      const home = TEAMS[(i + week) % TEAMS.length], away = TEAMS[(i + week + 1) % TEAMS.length];
      const open = Math.round(rand() * 14) / 2;
      // The soft books open half a point off Pinnacle in a random direction and
      // the market keeps going that way: the close is a full point past
      // Pinnacle's opener, so half the move is still ahead when the soft
      // opener is bettable. That is the one real signal; everything else is noise.
      const gap = rand() > 0 ? 1 : -1;
      const close = open + gap * 1.0 + Math.round(rand() * 2) / 2;
      const margin = Math.round(-close + rand() * 20);
      run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,team_score,opp_score,gameday,gametime,div_game,rest_days)
           VALUES (?,?,?,?,1,?,44,22,'test',datetime('now'),?,?,?,'13:00',0,7)`, season, week, home, away, close, 24 + margin, 24, gameday);
      run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,team_score,opp_score,gameday,gametime,div_game,rest_days)
           VALUES (?,?,?,?,0,?,44,22,'test',datetime('now'),?,?,?,'13:00',0,7)`, season, week, away, home, -close, 24, 24 + margin, gameday);
      const commence = `${gameday}T17:00:01.000Z`;
      const openAt = `${gameday}T00:00:00.000Z`, closeAt = `${gameday}T16:50:00.000Z`;
      eid++;
      const ins = (book, phase, side, line, at) => run(`INSERT INTO nfl_odds_archive
        (eid,season,week,home,away,commence_time,book,market,side,phase,line,price,book_updated_at,source,fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,-110,?,'test',datetime('now'))`, eid, season, week, home, away, commence, book, side === 'Over' ? 'totals' : 'spreads', side, phase, line, at);
      ins('pinnacle', 'open', home, open, openAt); ins('pinnacle', 'close', home, close, closeAt);
      const softAt = `${gameday}T06:00:00.000Z`;
      for (const book of SOFT) { ins(book, 'open', home, open + gap * 0.5, softAt); ins(book, 'close', home, close, closeAt); }
      // Totals with no signal at all.
      const tOpen = 44 + Math.round(rand() * 6), tClose = tOpen + Math.round(rand() * 2) / 2;
      ins('pinnacle', 'open', 'Over', tOpen, openAt); ins('pinnacle', 'close', 'Over', tClose, closeAt);
      for (const book of SOFT) { ins(book, 'open', 'Over', tOpen + Math.round(rand() * 2) / 2, openAt); ins(book, 'close', 'Over', tClose, closeAt); }
    }
  }
}
// A game with only one soft book must be dropped.
function seedThinGame(season) {
  eid++;
  run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,implied_points,source,fetched_at,team_score,opp_score,gameday,gametime)
       VALUES (?,19,'AAA','HHH',1,-3,44,22,'test',datetime('now'),20,17,'2025-01-12','13:00')`, season);
  const ins = (book, phase, line) => run(`INSERT INTO nfl_odds_archive (eid,season,week,home,away,commence_time,book,market,side,phase,line,price,book_updated_at,source,fetched_at)
    VALUES (?,?,19,'AAA','HHH','2025-01-12T18:00:01Z',?,'spreads','AAA',?,?,-110,'2025-01-12T00:00:00Z','test',datetime('now'))`, eid, season, book, phase, line);
  ins('pinnacle', 'open', -3); ins('pinnacle', 'close', -3.5); ins('bovada', 'open', -3); ins('bovada', 'close', -3.5);
}

for (const season of [2021, 2022, 2023, 2024, 2025]) seedSeason(season);
seedThinGame(2025);

test('the dataset is one row per game and market, stamped by decision time, with drops counted', () => {
  const built = study.buildLineMoveDataset({ seasons: [2021, 2022, 2023, 2024, 2025], includeModels: false });
  assert.equal(built.dropped.thin_books, 1);
  assert.equal(built.rows.filter(r => r.market === 'spreads').length, 5 * 18 * 4);
  assert.equal(built.rows.filter(r => r.market === 'totals').length, 5 * 18 * 4);
  const row = built.rows[0];
  assert.ok(row.decision_times.T0 <= row.decision_times.S && row.decision_times.S <= row.decision_times.T1 && row.decision_times.T1 <= row.decision_times.T2);
  assert.equal(row.decision_times.S, `${row.opener_at.slice(0, 10)}T06:00:00.000Z`, 'S is when the third soft book opened');
  assert.ok(row.decision_times.T2 <= row.close_at, 'no decision time after the close');
  assert.ok(!('sharp_soft_gap' in row.features.T0), 'the gap is not knowable at the opener');
  assert.ok('sharp_soft_gap' in row.features.S);
  assert.equal(row.y, row.open - row.close, 'spread target is the move toward the home side');
});

test('the study finds the one real signal on the held-out seasons and nothing else after Holm', () => {
  const report = study.lineMoveStudy({ seasons: [2021, 2022, 2023, 2024, 2025], includeModels: false });
  assert.equal(report.available, true);
  const spreadT0 = report.headline.find(h => h.market === 'spreads' && h.decision_time === 'T0');
  assert.ok(spreadT0.holdout.n >= 140);
  assert.ok(Math.abs(spreadT0.holdout.mean_clv) < 0.3, `T0 has no signal in the fixture: ${spreadT0.holdout.mean_clv}`);
  const spreadS = report.headline.find(h => h.market === 'spreads' && h.decision_time === 'S');
  assert.match(spreadS.clv_basis, /soft-book opener/);
  assert.ok(spreadS.holdout.direction_accuracy > 0.6, `direction ${spreadS.holdout.direction_accuracy}`);
  const best = report.features.filter(f => f.market === 'spreads')[0];
  assert.equal(best.name, 'S:sharp_soft_gap');
  assert.ok(best.p_holm < 0.05);
  const noise = report.features.filter(f => f.market === 'spreads' && f.name !== 'S:sharp_soft_gap' && f.p_holm < 0.05);
  assert.deepEqual(noise.map(f => f.name), [], 'no noise feature survives Holm');
  const totalsT0 = report.headline.find(h => h.market === 'totals' && h.decision_time === 'T0');
  assert.ok(totalsT0.holdout.clv_interval[0] <= 0.15, 'totals carry no signal and the interval says so');
  assert.ok(report.slices.spreads.some(s => s.readable === false || s.n >= study.MIN_SLICE));
  assert.ok(report.gate.rule.includes('CLV'));
});
