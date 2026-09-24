/**
 * RL-16-1: the playoff-week weight in horizonWeights().
 *
 * PLAYOFF_IMPORTANCE = 4 was borrowed from a best-ball figure and never measured
 * for a managed H2H league. R&D round 16 (validator r16, 579 Sleeper leagues)
 * measured it per team: rank 4-6 contenders in 10-team / 6-playoff leagues 5.13
 * [4.28, 6.34]. Behind GRIDIRON_RL16_1_ENABLED (or preview mode); 12/6 and 8/4
 * keep the old 4, labelled unmeasured.
 *
 * Week 7, odds 0.6, default calendar (14 regular weeks, playoffs 15-17):
 * 8 regular weeks left, 3 playoff weeks. At 4 the playoff share is
 * 7.2 / 15.2 = 0.474; at 5.13 it is 9.234 / 17.234 = 0.536.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { horizonWeights, playoffImportance, leagueShape, PLAYOFF_IMPORTANCE } =
  await import('../server/services/trade-horizon.js');

const FLAG = 'GRIDIRON_RL16_1_ENABLED';
const PREVIEW = 'GRIDIRON_PREVIEW_UNCONFIRMED';

/** Run fn with the two switches set as given, restoring whatever was there. */
function withEnv(env, fn) {
  const saved = { [FLAG]: process.env[FLAG], [PREVIEW]: process.env[PREVIEW] };
  try {
    for (const k of [FLAG, PREVIEW]) {
      if (env[k] == null) delete process.env[k];
      else process.env[k] = env[k];
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const TEN_SIX = { teams: 10, playoffTeams: 6 };

test('RL-16-1 RED: 10/6 league, week 7, odds 0.6 -> playoff share about 0.536 with the flag on', () => {
  const h = withEnv({ [FLAG]: '1' }, () => horizonWeights(7, { playoffOdds: 0.6, ...TEN_SIX }));
  assert.ok(Math.abs(h.playoff - 0.536) <= 0.02, `playoff share ${h.playoff}, want 0.536 +- 0.02`);
  assert.equal(h.playoff_importance, 5.13);
  assert.equal(h.playoff_importance_measured, true);
  assert.equal(h.preview, undefined, 'on by its own flag, not by preview');
});

test('RL-16-1: preview mode turns it on too, and says so', () => {
  const h = withEnv({ [PREVIEW]: '1' }, () => horizonWeights(7, { playoffOdds: 0.6, ...TEN_SIX }));
  assert.ok(Math.abs(h.playoff - 0.536) <= 0.02, `playoff share ${h.playoff}`);
  assert.equal(h.preview, true);
  assert.match(h.preview_reason, /RL-16-1/);
});

test('RL-16-1 regression pin: flag off, today\'s 0.474 and today\'s output shape, whatever the league', () => {
  for (const shape of [{}, TEN_SIX, { teams: 12, playoffTeams: 6 }, { teams: 8, playoffTeams: 4 }]) {
    const h = withEnv({}, () => horizonWeights(7, { playoffOdds: 0.6, ...shape }));
    assert.equal(h.playoff, 0.474);
    assert.equal(h.now, 0.526);
    assert.deepEqual(Object.keys(h).sort(), ['now', 'playoff', 'playoff_odds', 'playoff_weeks_label',
      'playoff_weeks_left', 'regular_weeks_left'], 'flag off adds no fields to the served horizon');
  }
  assert.equal(PLAYOFF_IMPORTANCE, 4);
});

test('RL-16-1: 12/6, 8/4 and an unknown shape stay on 4, flagged unmeasured, even with the flag on', () => {
  for (const shape of [{ teams: 12, playoffTeams: 6 }, { teams: 8, playoffTeams: 4 }, {}]) {
    const imp = withEnv({ [FLAG]: '1' }, () => playoffImportance(shape));
    assert.equal(imp.value, 4, JSON.stringify(shape));
    assert.equal(imp.measured, false);
    assert.match(imp.source, /unmeasured/i);
    const h = withEnv({ [FLAG]: '1' }, () => horizonWeights(7, { playoffOdds: 0.6, ...shape }));
    assert.equal(h.playoff, 0.474);
    assert.equal(h.playoff_importance_measured, false);
  }
});

test('RL-16-1: leagueShape reads team and playoff-team counts from the synced ESPN settings', () => {
  const payload = {
    settings: { scheduleSettings: { matchupPeriodCount: 14, matchupPeriodLength: 1, playoffTeamCount: 6,
      playoffMatchupPeriodLength: 1, playoffReseed: false, variablePlayoffMatchupPeriodLength: false } },
    teams: Array.from({ length: 10 }, (_, i) => ({ id: i + 1 })),
  };
  assert.deepEqual(leagueShape({ platform: 'espn', payload: JSON.stringify(payload) }), TEN_SIX);
  assert.deepEqual(leagueShape(null), { teams: null, playoffTeams: null });
  assert.deepEqual(leagueShape({ platform: 'espn', payload: '{not json' }), { teams: null, playoffTeams: null });
});
