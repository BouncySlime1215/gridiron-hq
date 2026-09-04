import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// draft-assist.js pulls in several modules that create/alter tables at import
// time (aggregates.js, stats.js, espn-draft.js, ...) — isolate against a throwaway
// DB rather than the real data.sqlite, same convention as the rest of the suite,
// even though this file only exercises rankTargets() as a pure function.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-draft-assist-bestball-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { rankTargets } = await import('../server/services/draft-assist.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

/**
 * rankTargets() is a pure function of the boardState() shape, so these build a
 * minimal fake state directly rather than standing up a real draft/DB — the
 * only thing under test is the best-ball-conditional scoring branch (Zero-RB/
 * Anchor-RB fade + QB/pass-catcher stack bonus), not boardState() itself.
 */
function player(overrides) {
  return {
    player_id: 1, name: 'Player', position: 'WR', team_abbr: 'BUF',
    market_rank: 10, board_rank: 10, adp: 10, injury_flag: null,
    projected_points: 100, projected_pos_rank: 10, last_season_points: 90,
    gone_by_next: null,
    ...overrides
  };
}

function baseState({ isBestBall, round = 1, myPicks = [], available }) {
  const positions = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'DEF', 'K']) {
    positions[pos] = { available: 5, starters_needed: 0, depth_needed: 1, cost_of_waiting: null, tier_cliff: null };
  }
  return {
    draft: { rounds: 16, is_best_ball: isBestBall },
    on_the_clock: { round },
    my_team: { picks: myPicks, counts: {} },
    positions,
    runs: [],
    available
  };
}

test('redraft: an early RB gets no Zero-RB penalty', () => {
  const rb = player({ player_id: 1, name: 'RB One', position: 'RB', board_rank: 1 });
  const state = baseState({ isBestBall: false, round: 1, available: [rb] });
  const [ranked] = rankTargets(state, 1);
  assert.ok(!ranked.reasons.some(r => r.includes('Zero-RB')));
});

test('best-ball: a round-1 RB is scored lower than the same player would be in redraft', () => {
  const rb = player({ player_id: 1, name: 'RB One', position: 'RB', board_rank: 1 });
  const redraft = rankTargets(baseState({ isBestBall: false, round: 1, available: [rb] }), 1)[0];
  const bestball = rankTargets(baseState({ isBestBall: true, round: 1, available: [rb] }), 1)[0];
  assert.ok(bestball.score < redraft.score, 'best-ball score should be lower for an early RB');
  assert.ok(bestball.reasons.some(r => r.includes('Zero-RB/Anchor-RB')));
});

test('best-ball: the Zero-RB fade tapers to nothing by round 5', () => {
  const rb = player({ player_id: 1, name: 'RB One', position: 'RB', board_rank: 1 });
  const round5 = rankTargets(baseState({ isBestBall: true, round: 5, available: [rb] }), 1)[0];
  assert.ok(!round5.reasons.some(r => r.includes('Zero-RB')), 'no fade should apply once roundsLeft/round hits the taper floor');
});

test('best-ball: a non-RB position is untouched by the Zero-RB fade', () => {
  const wr = player({ player_id: 1, name: 'WR One', position: 'WR', board_rank: 1 });
  const state = baseState({ isBestBall: true, round: 1, available: [wr] });
  const [ranked] = rankTargets(state, 1);
  assert.ok(!ranked.reasons.some(r => r.includes('Zero-RB')));
});

test('best-ball: a QB gets a stack bonus when his own pass-catcher is already rostered', () => {
  const qb = player({ player_id: 2, name: 'QB One', position: 'QB', team_abbr: 'BUF', board_rank: 5 });
  const myPicks = [{ position: 'WR', team_abbr: 'BUF' }];
  const withStack = rankTargets(baseState({ isBestBall: true, round: 3, myPicks, available: [qb] }), 1)[0];
  const withoutStack = rankTargets(baseState({ isBestBall: true, round: 3, myPicks: [], available: [qb] }), 1)[0];
  assert.ok(withStack.score > withoutStack.score);
  assert.ok(withStack.reasons.some(r => r.includes('stack bonus') && r.includes('already on your roster')));
});

test('best-ball: a QB gets a stack bonus when his own pass-catcher is still available on the board', () => {
  const qb = player({ player_id: 2, name: 'QB One', position: 'QB', team_abbr: 'BUF', board_rank: 5 });
  const teammateWr = player({ player_id: 3, name: 'WR Teammate', position: 'WR', team_abbr: 'BUF', board_rank: 6 });
  const state = baseState({ isBestBall: true, round: 3, available: [qb, teammateWr] });
  const ranked = rankTargets(state, 2);
  const qbRanked = ranked.find(p => p.player_id === 2);
  assert.ok(qbRanked.reasons.some(r => r.includes('stack bonus') && r.includes('still on the board')));
});

test('best-ball: a QB with no pass-catcher rostered or available gets no stack bonus', () => {
  const qb = player({ player_id: 2, name: 'QB One', position: 'QB', team_abbr: 'BUF', board_rank: 5 });
  const otherWr = player({ player_id: 3, name: 'WR Other', position: 'WR', team_abbr: 'MIA', board_rank: 6 });
  const state = baseState({ isBestBall: true, round: 3, available: [qb, otherWr] });
  const ranked = rankTargets(state, 2);
  const qbRanked = ranked.find(p => p.player_id === 2);
  assert.ok(!qbRanked.reasons.some(r => r.includes('stack bonus')));
});

test('redraft: no stack bonus applies to a QB even with a rostered pass-catcher', () => {
  const qb = player({ player_id: 2, name: 'QB One', position: 'QB', team_abbr: 'BUF', board_rank: 5 });
  const myPicks = [{ position: 'WR', team_abbr: 'BUF' }];
  const state = baseState({ isBestBall: false, round: 3, myPicks, available: [qb] });
  const [ranked] = rankTargets(state, 1);
  assert.ok(!ranked.reasons.some(r => r.includes('stack bonus')));
});
