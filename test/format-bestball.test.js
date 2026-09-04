import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveFormat, isBestBallFromPayload } from '../server/services/format.js';

/* -------------------------------------------------- isBestBallFromPayload */

test('sleeper: settings.best_ball === 1 is recognized', () => {
  assert.equal(isBestBallFromPayload('sleeper', { league: { settings: { best_ball: 1 } } }), true);
});

test('sleeper: best_ball === 0 (or missing) is not best-ball', () => {
  assert.equal(isBestBallFromPayload('sleeper', { league: { settings: { best_ball: 0 } } }), false);
  assert.equal(isBestBallFromPayload('sleeper', { league: { settings: {} } }), false);
  assert.equal(isBestBallFromPayload('sleeper', { league: {} }), false);
});

test('espn: settings.rosterSettings.isBestBallLeague is recognized', () => {
  assert.equal(isBestBallFromPayload('espn', { settings: { rosterSettings: { isBestBallLeague: true } } }), true);
});

test('espn: absent/false flag is not best-ball', () => {
  assert.equal(isBestBallFromPayload('espn', { settings: { rosterSettings: {} } }), false);
  assert.equal(isBestBallFromPayload('espn', {}), false);
});

test('a null/undefined payload never throws and defaults to false', () => {
  assert.equal(isBestBallFromPayload('espn', null), false);
  assert.equal(isBestBallFromPayload('sleeper', undefined), false);
});

/* -------------------------------------------------------------- deriveFormat */

test('deriveFormat surfaces isBestBall for a Sleeper best-ball league via payload', () => {
  const lg = {
    platform: 'sleeper', team_count: 12, ppr: 1, superflex: 0,
    payload: JSON.stringify({ league: { settings: { best_ball: 1 } } })
  };
  const format = deriveFormat(lg);
  assert.equal(format.isBestBall, true);
  // Best-ball must not change the underlying value-set key — it's an additive
  // signal for draft-assist, not a new FantasyCalc format bucket.
  assert.equal(format.formatKey, 'rd_sf1_t12_ppr1');
});

test('deriveFormat defaults isBestBall to false for a redraft league with no payload', () => {
  const format = deriveFormat({ platform: 'espn', team_count: 12, ppr: 1 });
  assert.equal(format.isBestBall, false);
});

test('deriveFormat respects an explicit lg.best_ball column ahead of a stale/missing payload', () => {
  const format = deriveFormat({ platform: 'sleeper', team_count: 10, ppr: 1, best_ball: 1 });
  assert.equal(format.isBestBall, true);
});

test('a malformed payload JSON string does not throw, and isBestBall falls back to false', () => {
  const format = deriveFormat({ platform: 'espn', team_count: 12, ppr: 1, payload: '{not json' });
  assert.equal(format.isBestBall, false);
});
