/**
 * The qualitative half of Phase 3's "insane" rolling-leaderboard pattern
 * recognition (2026-09-09 learning-pipeline plan): injury and verified-news
 * signals fed into `segmentsFor` (nfl-replay.js) on the same week-by-week,
 * cutoff-safe footing as the 178 quantitative stats.
 *
 * Two properties matter most and are proven directly here, not just read
 * out of the code:
 *   1. Week-by-week cutoff safety — a bet in week N must only ever see
 *      injury/news data as of that week's own cutoff, never a later week's.
 *   2. A starter's return is recognized, not stuck on stale bad news — when
 *      a player goes from "out" to "returned to practice / available," the
 *      MORE RECENT status must win, because news usually validates a return
 *      before the official report catches up, and the whole point of this
 *      signal is to react to that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-qualitative-segments-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { analyzeErrors } = await import('../server/services/nfl-replay.js');
const { teamNewsSignals } = await import('../server/services/nfl-news-signal.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function seedGameLines(season, week, home, away, gameday) {
  db.prepare(`INSERT INTO game_lines (season, week, team, opponent, home, spread, team_score, opp_score, source, fetched_at, gameday, gametime)
    VALUES (?,?,?,?,1,-3,20,17,'test',datetime('now'),?,'13:00')`).run(season, week, home, away, gameday);
}

function seedNewsSignal({ news_id, player_key, team, signal_type, status, unavailable_probability, confidence, published_at }) {
  db.prepare(`INSERT INTO nfl_news_signals
    (news_id, player_key, player_id, player_name, team, signal_type, status, unavailable_probability, confidence, published_at, source, evidence_span, extractor_version, verification_state)
    VALUES (?,?,?,?,?,?,?,?,?,?,'test','test evidence','test-v1','verified')`)
    .run(news_id, player_key, player_key, player_key, team, signal_type, status, unavailable_probability, confidence, published_at);
}

test('a starter\'s return is recognized: a more recent "available" claim overrides an earlier "out" claim', () => {
  // Week 5: QB reported OUT (high unavailable_probability).
  seedNewsSignal({ news_id: 1, player_key: 'qb1', team: 'AAA', signal_type: 'availability',
    status: 'out', unavailable_probability: 0.94, confidence: 0.9, published_at: '2026-10-01T12:00:00Z' });
  // Week 6: same QB reported back at full practice, available (LOW unavailable_probability), published LATER.
  seedNewsSignal({ news_id: 2, player_key: 'qb1', team: 'AAA', signal_type: 'availability',
    status: 'available_positive', unavailable_probability: 0.06, confidence: 0.9, published_at: '2026-10-08T12:00:00Z' });

  const beforeReturn = teamNewsSignals('AAA', { before: '2026-10-03T00:00:00Z' }); // week 5 cutoff, before the return news
  const afterReturn = teamNewsSignals('AAA', { before: '2026-10-10T00:00:00Z' });  // week 6 cutoff, after the return news

  assert.equal(beforeReturn.claims.find(c => c.player_key === 'qb1')?.status, 'out');
  assert.ok(beforeReturn.unavailable_burden > 0.5, 'burden should be high while the only known status is "out"');

  assert.equal(afterReturn.claims.find(c => c.player_key === 'qb1')?.status, 'available_positive',
    'the MORE RECENT "available" status must win over the stale "out" one, not the other way around');
  assert.ok(afterReturn.unavailable_burden < beforeReturn.unavailable_burden,
    'burden must drop once the return is known — a starter coming back is real information the segment analysis should see');
});

test('week-by-week cutoff: a bet in an earlier week never sees a later week\'s injury/news data', () => {
  // Distinct team code from the earlier test in this file -- teamNewsSignals
  // queries by team across the whole shared test database, so reusing a team
  // code across tests would let an earlier test's leftover rows leak into
  // this one's cutoff window and produce a false result either way.
  seedGameLines(2026, 5, 'GGG', 'HHH', '2026-10-04');
  seedGameLines(2026, 6, 'GGG', 'III', '2026-10-11');
  // News that only exists AFTER week 5's games (published during week 6 build-up).
  seedNewsSignal({ news_id: 3, player_key: 'wr1', team: 'GGG', signal_type: 'availability',
    status: 'out', unavailable_probability: 0.9, confidence: 0.9, published_at: '2026-10-09T12:00:00Z' });

  const bets = [];
  for (let i = 0; i < 26; i++) {
    bets.push({
      season: 2026, week: 5, home: 'GGG', away: `X${i}`, market: 'spread',
      side: 'GGG -3', line: -3, model_margin: 3, market_margin: 3,
      edge: 5, edge_points: 5, disagreement: 2, actual_margin: 5, actual_total: 44,
      result: 'Won', won: true, pushed: false, units: 0.9, american_price: -110, opposite_price: -110
    });
  }
  const result = analyzeErrors(bets, { minBets: 25 });
  // Week 5 bets must NOT see the week-6-published news at all -- the
  // news_signal segment should never appear for these bets, since the
  // only claim that exists postdates week 5's own cutoff entirely.
  const newsSeg = result.segments.find(s => s.dimension === 'news_signal');
  assert.equal(newsSeg, undefined, 'week 5 bets must not see news published after week 5\'s own cutoff');
});

test('week-by-week: the SAME team\'s bet in a LATER week correctly sees news published in between', () => {
  seedGameLines(2027, 5, 'DDD', 'EEE', '2027-10-03');
  seedGameLines(2027, 6, 'DDD', 'FFF', '2027-10-10');
  seedNewsSignal({ news_id: 4, player_key: 'rb1', team: 'DDD', signal_type: 'availability',
    status: 'out', unavailable_probability: 0.9, confidence: 0.9, published_at: '2027-10-06T12:00:00Z' }); // between wk5 and wk6

  const week5Bets = Array.from({ length: 26 }, (_, i) => ({
    season: 2027, week: 5, home: 'DDD', away: `Y${i}`, market: 'spread',
    side: 'DDD -3', line: -3, model_margin: 3, market_margin: 3, edge: 5, edge_points: 5, disagreement: 2,
    actual_margin: 5, actual_total: 44, result: 'Won', won: true, pushed: false, units: 0.9, american_price: -110, opposite_price: -110
  }));
  const week6Bets = Array.from({ length: 26 }, (_, i) => ({
    season: 2027, week: 6, home: 'DDD', away: `Z${i}`, market: 'spread',
    side: 'DDD -3', line: -3, model_margin: 3, market_margin: 3, edge: 5, edge_points: 5, disagreement: 2,
    actual_margin: 5, actual_total: 44, result: 'Won', won: true, pushed: false, units: 0.9, american_price: -110, opposite_price: -110
  }));

  const week5Result = analyzeErrors(week5Bets, { minBets: 25 });
  const week6Result = analyzeErrors(week6Bets, { minBets: 25 });
  assert.equal(week5Result.segments.find(s => s.dimension === 'news_signal'), undefined,
    'week 5 must not see news published after its own kickoff');
  assert.ok(week6Result.segments.find(s => s.dimension === 'news_signal'),
    'week 6 SHOULD see the news published between week 5 and week 6 — this is exactly the new information a week-to-week cutoff should pick up');
});
