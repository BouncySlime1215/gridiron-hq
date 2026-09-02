import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The historical replay must record every specialist's input for every game
// each week, flag the cells it did not get, and look back on the week
// (graded, cumulative, chained) rather than only in the final aggregate.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lookback-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { NFL_EXPERTS } = await import('../server/services/nfl-expert-council.js');
const { __test } = await import('../server/services/nfl-blind-audit.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

function game(home, away, { drop = [], missing = [], ready = true, actual = 3 } = {}) {
  const experts = NFL_EXPERTS.filter(e => !drop.includes(e.id)).map(e => missing.includes(e.id)
    ? { id: e.id, observed: false, forecast_residual: null, uncertainty: null, missing_reason: `${e.id} evidence unavailable`, directional_correct: null, squared_error: null }
    : { id: e.id, observed: true, forecast_residual: 2, uncertainty: 4, missing_reason: null, directional_correct: actual > 0, squared_error: (2 - actual) ** 2 });
  const coordinator = ready
    ? { ready: true, forecast_residual: 1.5, uncertainty: 3, contributions: experts.filter(e => e.observed).map(e => ({ id: e.id, learned_weight: 0.1, normalized_weight: 0.125, value: 0.2 })) }
    : { ready: false, reason: 'coordinator warmup incomplete' };
  return { game: { season: 2023, week: 5, home, away, evidence_cutoff: '2023-10-08T17:00:00Z', market_margin: -3, actual_residual: actual },
    experts, coordinator,
    combined_decision: { state: ready ? 'candidate_forecast_only' : 'warmup_abstain', settlement: { directional_correct: ready ? actual > 0 : null } } };
}

test('weekly input records a game × specialist matrix with the production pick, and completeness flags absent cells', () => {
  const council = { season: 2023, week: 5, games: [
    game('KC', 'DEN', { missing: ['line_movement', 'news_reaction'] }),
    game('BUF', 'NYG', { drop: ['price_shopper'] })
  ], coordinator: { ready: true, training_games: 200, training_weeks: 12 } };
  const betting = { picks: [{ matchup: 'DEN at KC', market: 'spread', selection: 'KC', line: -3, units: 1, result: 'Won' }], metrics: { bets: 1, wins: 1, losses: 0, units: 0.909 } };
  const input = __test.weeklyInput(council, betting);
  assert.equal(input.games.length, 2);
  const kc = input.games[0];
  assert.equal(kc.specialists.length, NFL_EXPERTS.length, 'every registered specialist has a cell');
  assert.equal(kc.specialists.find(c => c.id === 'line_movement').status, 'missing');
  assert.equal(kc.specialists.find(c => c.id === 'line_movement').missing_reason, 'line_movement evidence unavailable');
  assert.equal(kc.specialists.find(c => c.id === 'rulebook').status, 'forecast');
  assert.deepEqual(kc.production_pick, { market: 'spread', selection: 'KC', line: -3, units: 1 });
  assert.equal(input.games[1].production_pick.selection, null);
  // A missing opinion WITH a reason is complete reporting; an absent row is not.
  assert.equal(input.completeness.complete, false);
  assert.deepEqual(input.completeness.missing_cells, [{ game: 'NYG at BUF', specialist: 'price_shopper' }]);
  assert.equal(input.completeness.expected_cells, 2 * (NFL_EXPERTS.length + 2));
  assert.equal(input.completeness.recorded_cells, input.completeness.expected_cells - 1);
});

test('the look-back grades the week and chains cumulative totals from the previous week', () => {
  const week1 = { expert_council: { season: 2023, week: 5, games: [game('KC', 'DEN'), game('BUF', 'NYG', { missing: ['news_reaction'], actual: -2 })],
    coordinator: { ready: true, training_games: 200, training_weeks: 12, reason: null } },
  betting: { metrics: { bets: 2, wins: 1, losses: 1, units: -0.091 } } };
  const first = __test.weekLookback(week1, null);
  const rulebook = first.specialists.find(s => s.id === 'rulebook');
  assert.equal(rulebook.week.games, 2);
  assert.equal(rulebook.week.directional_calls, 2);
  assert.equal(rulebook.week.directional_correct, 1, 'one game went the other way');
  assert.equal(rulebook.cumulative.games, 2);
  const news = first.specialists.find(s => s.id === 'news_reaction');
  assert.equal(news.week.missing, 1);
  assert.deepEqual(news.week.missing_reasons, { 'news_reaction evidence unavailable': 1 });
  assert.equal(first.coordinator.ready_games, 2);
  assert.equal(first.coordinator.week.directional_correct, 1);
  assert.equal(first.betting.cumulative.bets, 2);
  assert.ok(first.reads.some(r => r.includes('Missing opinions')), 'the missing opinion is stated in plain language');
  assert.ok(first.reads.some(r => r.includes('noise')), 'a single week refuses to be read as a hit rate');

  const week2 = { expert_council: { season: 2023, week: 6, games: [game('SF', 'DAL'), game('MIA', 'NE'), game('PHI', 'NYJ')],
    coordinator: { ready: true, training_games: 230, training_weeks: 13, reason: null } },
  betting: { metrics: { bets: 1, wins: 1, losses: 0, units: 0.909 } } };
  const second = __test.weekLookback(week2, first);
  const rulebook2 = second.specialists.find(s => s.id === 'rulebook');
  assert.equal(rulebook2.week.games, 3);
  assert.equal(rulebook2.cumulative.games, 5, 'chained from the previous look-back');
  assert.equal(rulebook2.cumulative.directional_correct, 4);
  assert.equal(rulebook2.cumulative.directional_rate, 0.8);
  assert.equal(second.coordinator.cumulative.ready_games, 5);
  assert.equal(second.betting.cumulative.bets, 3);
  assert.equal(second.betting.cumulative.wins, 2);
  assert.equal(second.week, 6);
});

test('a warm-up week records abstention as such rather than as a coordinator opinion', () => {
  const result = { expert_council: { season: 2022, week: 5, games: [game('KC', 'DEN', { ready: false })],
    coordinator: { ready: false, training_games: 0, training_weeks: 0, reason: 'coordinator warmup incomplete' } }, betting: { metrics: {} } };
  const look = __test.weekLookback(result, null);
  assert.equal(look.coordinator.ready_games, 0);
  assert.equal(look.coordinator.week.directional_calls, 0);
  assert.ok(look.reads.some(r => r.includes('abstained')));
  const compact = __test.dashboardWeekResult({ ...result, lookback: look, weekly_input: __test.weeklyInput(result.expert_council, null) });
  assert.equal(compact.reporting.complete, true);
  assert.equal(compact.lookback.games, 1);
});
