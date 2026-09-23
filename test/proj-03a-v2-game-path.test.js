// PROJ-03-a-v2: shared game-path sampler (study code, scripts/proj03a/game-path-v2.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitGamePath, gamePathKey, impliedPoints, pearson, sampleGamePath } from '../scripts/proj03a/game-path-v2.mjs';
import { mean, stdev } from '../server/services/stats-util.js';

const params = { sd: 9.1, rho: 0.3 };
const game = { season: 2023, week: 5, home: 'KC', away: 'MIN', spread: -4, total: 52.5 };

function draws(n, rho) {
  const out = [];
  for (let m = 0; m < n; m++) out.push(sampleGamePath(game, gamePathKey(2023, 5, 'KC', 'MIN', m), params, rho));
  return out;
}

test('the same key gives the same path, from either side of the fixture', () => {
  assert.equal(gamePathKey(2023, 5, 'KC', 'MIN', 7), gamePathKey(2023, 5, 'MIN', 'KC', 7));
  const a = sampleGamePath(game, gamePathKey(2023, 5, 'KC', 'MIN', 7), params);
  const b = sampleGamePath(game, gamePathKey(2023, 5, 'MIN', 'KC', 7), params);
  assert.deepEqual(a, b);
  assert.notEqual(gamePathKey(2023, 5, 'KC', 'MIN', 7), gamePathKey(2023, 5, 'KC', 'MIN', 8));
});

test('each team marginal is Normal(implied total, pooled sd)', () => {
  const d = draws(20000);
  assert.equal(impliedPoints(-4, 52.5), 28.25);
  const h = d.map(x => x.points.home), a = d.map(x => x.points.away);
  assert.ok(Math.abs(mean(h) - 28.25) < 0.2, `home mean ${mean(h)}`);
  assert.ok(Math.abs(mean(a) - 24.25) < 0.2, `away mean ${mean(a)}`);
  assert.ok(Math.abs(stdev(h) - 9.1) < 0.2 && Math.abs(stdev(a) - 9.1) < 0.2);
});

test('the shared path carries rho; rho = 0 with the same keys gives the independent pair', () => {
  const d = draws(20000), i = draws(20000, 0);
  const corr = x => pearson(x.map(p => p.points.home), x.map(p => p.points.away));
  assert.ok(Math.abs(corr(d) - 0.3) < 0.03, `path rho ${corr(d)}`);
  assert.ok(Math.abs(corr(i)) < 0.03, `independent rho ${corr(i)}`);
  // common random numbers: the home side is identical, only the away side changes
  assert.equal(d[3].points.home, i[3].points.home);
});

test('fitGamePath refuses fewer than 100 games and fits one pooled sd and rho', () => {
  assert.equal(fitGamePath([]), null);
  const games = Array.from({ length: 200 }, (_, k) => ({ spread: 0, total: 40, home_pts: 20 + (k % 7) - 3, away_pts: 20 + (k % 7) - 3 }));
  const p = fitGamePath(games);
  assert.equal(p.games, 200);
  assert.equal(p.rho, 0.9); // perfectly correlated residuals, clamped
  assert.ok(p.sd > 0);
});
