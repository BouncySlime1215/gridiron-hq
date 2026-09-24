/**
 * BROKEN-D (BROKEN-NUMBERS row D): three "current week"s.
 *
 * trade-engine.js#tradeWeekContext, league-week.js#leagueCurrentWeek and
 * season-sim.js#simStartWeek each answered "which week is it" on their own:
 * the trade engine re-ran the score query without currentNflWeek's stalled-sync
 * cross-check, and the league week read last season's payload for a league
 * that fell back pre-draft. week.js is now the one producer of `nfl.week` and
 * `league.week`; under GRIDIRON_PREVIEW_UNCONFIRMED=1 every caller reads them.
 * Flag off, every caller returns exactly what it returned before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-broken-d-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.NFL_SEASON = '2026';
delete process.env.NFL_WEEK;

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const { tradeWeekContext } = await import('../server/services/trade-engine.js');
const { leagueCurrentWeek } = await import('../server/services/league-week.js');
const { simStartWeek } = await import('../server/services/season-sim.js');
const { currentNflWeek } = await import('../server/services/weekly-learning.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// Weeks 1-2 scored. Week 3 kicked off three days ago and its scores never
// arrived (a stalled sync). Week 4 is next weekend.
function seedStalledSync() {
  run('DELETE FROM game_lines');
  const games = [
    [1, day(-17), 24, 17], [2, day(-10), 20, 13],
    [3, day(-3), null, null], [4, day(4), null, null]
  ];
  for (const [week, gameday, ts, os_] of games) {
    for (const [team, opp, home] of [['AAA', 'BBB', 1], ['BBB', 'AAA', 0]]) {
      run(`INSERT INTO game_lines (season, week, team, opponent, home, gameday, gametime, team_score, opp_score)
           VALUES (2026, ?, ?, ?, ?, ?, '13:00', ?, ?)`, week, team, opp, home, gameday, ts, os_);
    }
  }
}

function withPreview(on, fn) {
  const saved = process.env[PREVIEW_ENV];
  if (on) process.env[PREVIEW_ENV] = '1'; else delete process.env[PREVIEW_ENV];
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = saved;
  }
}

// A league synced this season whose ESPN matchup period is 4 — ESPN moved on
// from the stalled week too.
const synced = { id: 1, season: 2026, payload_season: 2026, current_week: 4, payload: '{}' };
// Pre-draft fallback: current_week not written, payload is last season's
// (payload_season 2025) and its status says matchup period 17.
const fellBack = {
  id: 2, season: 2026, payload_season: 2025, current_week: null,
  payload: JSON.stringify({ status: { currentMatchupPeriod: 17 } })
};

test('control: the fixture really is a stalled sync (score week 3, schedule week 4)', () => {
  seedStalledSync();
  const nfl = currentNflWeek(2026);
  assert.equal(nfl.score_derived_week, 3);
  assert.equal(nfl.schedule_derived_week, 4);
  assert.equal(nfl.score_signal_flagged, true);
  assert.equal(nfl.week, 4);
});

test('flag off: every caller keeps its old answer (the row-D disagreement, pinned)', () => {
  seedStalledSync();
  withPreview(false, () => {
    assert.equal(tradeWeekContext().week, 3, 'trade engine: raw score query, no cross-check');
    assert.equal(currentNflWeek(2026).week, 4);
    assert.equal(leagueCurrentWeek(synced), 4);
    assert.equal(leagueCurrentWeek(fellBack), 17, 'last season\'s payload period');
    assert.equal(simStartWeek(fellBack), 1);
  });
});

test('flag on: trade engine, NFL week and league week read one nfl.week / league.week', () => {
  seedStalledSync();
  withPreview(true, () => {
    const nfl = currentNflWeek(2026).week;
    assert.equal(nfl, 4);
    assert.deepEqual(tradeWeekContext(), { season: 2026, week: nfl });
    assert.equal(leagueCurrentWeek(synced), 4);
    assert.equal(simStartWeek(synced), 4);
    // Last season's payload is never this season's week: fall to nfl.week.
    assert.equal(leagueCurrentWeek(fellBack), nfl);
    // The sim still starts a fallen-back league at week 1: its scored weeks are
    // last season's games (INT-162-1), a statement about the data, not the week.
    assert.equal(simStartWeek(fellBack), 1);
  });
});

test('flag on: the NFL scoreboard and line-watch weeks are nfl.week', async () => {
  seedStalledSync();
  const week = await import('../server/services/week.js');
  withPreview(false, () => {
    assert.equal(week.scoreboardWeek(2026), 3);
    assert.equal(week.lineWatchWeek(2026), 3);
  });
  withPreview(true, () => {
    assert.equal(week.scoreboardWeek(2026), 4);
    assert.equal(week.lineWatchWeek(2026), 4);
    assert.equal(week.nflWeek(2026).week, 4);
    assert.equal(week.leagueWeek(synced), 4);
  });
});

test('NFL_WEEK still pins every NFL-week reader, flag on or off', () => {
  seedStalledSync();
  process.env.NFL_WEEK = '7';
  try {
    for (const on of [false, true]) {
      withPreview(on, () => {
        assert.equal(tradeWeekContext().week, 7);
        assert.equal(currentNflWeek(2026).week, 7);
      });
    }
  } finally { delete process.env.NFL_WEEK; }
});

/* ------------------------------------------------------------ ratchet */

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(full));
    else if (/\.(c|m)?js$|\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

// Comments may name a computation (the schema documents currentMatchupPeriod);
// only code counts. A `//` right after `:` is a URL, not a comment.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

const SOURCES = ['server', 'scripts', 'client/src']
  .filter(d => fs.existsSync(path.join(REPO, d)))
  .flatMap(d => jsFiles(path.join(REPO, d)))
  .filter(f => !f.includes(`${path.sep}migrations${path.sep}`))
  .map(f => ({ file: path.relative(REPO, f), src: stripComments(fs.readFileSync(f, 'utf8')) }));

const filesMatching = re => SOURCES.filter(s => re.test(s.src)).map(s => s.file).sort();

// Each way of computing "the current week" that this codebase has used.
const WEEK_COMPUTATIONS = {
  // The NFL_WEEK override.
  nfl_week_env: /process\.env\.NFL_WEEK\b/,
  // "first week with an unscored game" — MIN(week) or ORDER BY week LIMIT 1.
  unscored_week_query: /SELECT\s+(MIN\(week\)|week\b)[^`]*?FROM\s+game_lines[^`]*?team_score\s+IS\s+NULL/,
  // The schedule-derived week.
  schedule_week: /function\s+scheduleDerivedWeek\b/
};

for (const [name, re] of Object.entries(WEEK_COMPUTATIONS)) {
  test(`ratchet: only server/services/week.js computes the week (${name})`, () => {
    // Known-nonzero control: the producer itself must match, or the scan is scanning nothing.
    assert.deepEqual(filesMatching(re), ['server/services/week.js']);
  });
}

test('ratchet: ESPN currentMatchupPeriod is read only by week.js and the sync that stores it', () => {
  assert.deepEqual(filesMatching(/\.currentMatchupPeriod\b/),
    ['server/routes/leagues.js', 'server/services/week.js']);
});
