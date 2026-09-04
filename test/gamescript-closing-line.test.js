import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Isolated DB per the pattern used by every other test file in this suite.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-gamescript-closing-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { syncCurrentLines } = await import('../server/services/gamescript.js');
const { recordForwardPick, settleForwardPicks, forwardLedger } =
  await import('../server/services/forward-ledger.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const originalFetch = global.fetch;
test.after(() => { global.fetch = originalFetch; });

/** Builds a fake ESPN scoreboard response for one BUF/NYJ game. */
function espnScoreboard({ commenceIso, homeSpread, total, completed = false, homeScore = null, awayScore = null }) {
  return {
    events: [{
      id: 'evt1',
      date: commenceIso,
      competitions: [{
        status: { type: { completed } },
        neutralSite: false,
        venue: { indoor: false },
        competitors: [
          { homeAway: 'home', team: { abbreviation: 'BUF' }, score: homeScore },
          { homeAway: 'away', team: { abbreviation: 'NYJ' }, score: awayScore }
        ],
        odds: [{ spread: homeSpread, overUnder: total }]
      }]
    }]
  };
}

function mockFetchOnce(payload) {
  global.fetch = async () => ({ ok: true, json: async () => payload });
}

test('syncCurrentLines freezes the true close and never lets a post-kickoff number touch it', async () => {
  const season = 2026, week = 1;
  const KICKOFF = Date.parse('2026-09-13T17:00:00.000Z');

  mock.timers.enable({ apis: ['Date'], now: KICKOFF - 3 * 3600_000 }); // T-3h: pregame
  try {
    // Pregame poll, well before kickoff: -3 / 47 is the real, honest line.
    mockFetchOnce(espnScoreboard({
      commenceIso: '2026-09-13T17:00:00.000Z', homeSpread: -3, total: 47
    }));
    await syncCurrentLines(season, 1);

    let buf = db.prepare(`SELECT spread, total, closing_spread, closing_total FROM game_lines
      WHERE season=? AND week=? AND team='BUF'`).get(season, week);
    assert.equal(buf.spread, -3);
    assert.equal(buf.total, 47);
    assert.equal(buf.closing_spread, -3, 'the only pre-kickoff observation becomes the frozen close');
    assert.equal(buf.closing_total, 47);

    // A second, later pre-kickoff poll: the line moved to -2.5 / 48 before
    // kickoff. This IS real closing-line movement, so the frozen close should
    // track it right up until kickoff.
    mock.timers.tick(2 * 3600_000); // T-1h
    mockFetchOnce(espnScoreboard({
      commenceIso: '2026-09-13T17:00:00.000Z', homeSpread: -2.5, total: 48
    }));
    await syncCurrentLines(season, 1);
    buf = db.prepare(`SELECT closing_spread, closing_total FROM game_lines
      WHERE season=? AND week=? AND team='BUF'`).get(season, week);
    assert.equal(buf.closing_spread, -2.5);
    assert.equal(buf.closing_total, 48);

    // Now advance past kickoff and simulate ESPN observing this game AFTER it
    // has started, with `odds` still present and carrying a live, mid-game-
    // shaped number wildly different from the true close (e.g. a blowout
    // swinging the in-game spread to -14, total cut to 39 by a slow pace) —
    // this is exactly the corruption the bug allowed.
    mock.timers.tick(2 * 3600_000); // kickoff + 1h: game is live
    mockFetchOnce(espnScoreboard({
      commenceIso: '2026-09-13T17:00:00.000Z', homeSpread: -14, total: 39
    }));
    await syncCurrentLines(season, 1);

    buf = db.prepare(`SELECT spread, total, closing_spread, closing_total FROM game_lines
      WHERE season=? AND week=? AND team='BUF'`).get(season, week);
    // The live/current columns are free to move — that's their job elsewhere
    // (line-shopping, movement detection).
    assert.equal(buf.spread, -14, 'the live column is allowed to reflect the corrupted mid-game number');
    assert.equal(buf.total, 39);
    // But the frozen close must be untouched by the post-kickoff observation.
    assert.equal(buf.closing_spread, -2.5, 'closing_spread must stay at the last pre-kickoff value');
    assert.equal(buf.closing_total, 48, 'closing_total must stay at the last pre-kickoff value');

    const nyj = db.prepare(`SELECT closing_spread, closing_total FROM game_lines
      WHERE season=? AND week=? AND team='NYJ'`).get(season, week);
    assert.equal(nyj.closing_spread, 2.5, "the away side's frozen close is the mirrored spread");
    assert.equal(nyj.closing_total, 48);
  } finally {
    mock.timers.reset();
  }
});

test('forward-ledger settlement grades CLV against the frozen close, not the live corrupted spread', async () => {
  const season = 2026, week = 2;
  const KICKOFF = Date.parse('2026-09-20T17:00:00.000Z');

  mock.timers.enable({ apis: ['Date'], now: KICKOFF - 3600_000 }); // T-1h: pregame
  try {
    // Pregame: real line is BUF -3.
    mockFetchOnce(espnScoreboard({
      commenceIso: '2026-09-20T17:00:00.000Z', homeSpread: -3, total: 44
    }));
    await syncCurrentLines(season, 18);

    const pick = recordForwardPick({
      season, week, home: 'BUF', away: 'NYJ', side: 'BUF', line: -4,
      recordedAt: new Date().toISOString()
    });
    assert.equal(pick.ok, true);

    // Post-kickoff: ESPN serves a corrupted mid-game number before the game is
    // marked final, then the final score lands.
    mock.timers.tick(2 * 3600_000); // kickoff + 1h
    mockFetchOnce(espnScoreboard({
      commenceIso: '2026-09-20T17:00:00.000Z', homeSpread: -20, total: 30
    }));
    await syncCurrentLines(season, 18);

    mock.timers.tick(3 * 3600_000); // final
    mockFetchOnce(espnScoreboard({
      commenceIso: '2026-09-20T17:00:00.000Z', homeSpread: -20, total: 30,
      completed: true, homeScore: 27, awayScore: 20
    }));
    await syncCurrentLines(season, 18);

    const live = db.prepare(`SELECT spread, total, closing_spread, closing_total, team_score, opp_score
      FROM game_lines WHERE season=? AND week=? AND team='BUF'`).get(season, week);
    assert.equal(live.spread, -20, 'sanity: the live column really did get clobbered by the mid-game number');
    assert.equal(live.closing_spread, -3, 'the frozen close survived the post-kickoff corruption');
    assert.equal(live.team_score, 27);
    assert.equal(live.opp_score, 20);

    const settled = settleForwardPicks();
    assert.equal(settled.settled, 1);

    const graded = forwardLedger({ season }).recent.find(p => p.matchup === 'NYJ at BUF');
    assert.equal(graded.result, 'Won', 'BUF -4 with BUF winning by 7 should win outright regardless of the close');
    // BUF -4 vs a true close of BUF -3 is one point worse for the bettor (-4
    // gives up more than -3 would have). If settlement had instead read the
    // corrupted live spread (-20) this would come out wildly wrong.
    assert.equal(graded.closing_line, -3, 'settlement must report the frozen close, not the corrupted live spread');
    assert.equal(graded.clv_points, -1, 'BUF -4 is one point worse than a true close of BUF -3');
  } finally {
    mock.timers.reset();
  }
});
