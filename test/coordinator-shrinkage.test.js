import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Coordinator v4: each role enters at the scale its past forecasts earned,
// a role with no walk-forward gain enters at zero, and correlated roles are
// one family with one coefficient.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coord-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { NFL_EXPERTS } = await import('../server/services/nfl-expert-council.js');
const { __test } = await import('../server/services/nfl-expert-coordinator.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

let seed = 3;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
const gauss = () => (rand() + rand() + rand() + rand()) * 1.5;

// 600 games over 30 weeks. Truth: residual = signal + noise. rulebook is the
// signal at scale 0.3 (it says 3 when the truth is ~1); game_replay,
// specialist_team and player_builder are copies of rulebook plus noise;
// similar_games is pure noise; everything else is missing.
function makeGames() {
  const games = [];
  for (let week = 1; week <= 30; week++) for (let g = 0; g < 20; g++) {
    const signal = gauss() * 2;
    const target = signal + gauss() * 6;
    const experts = new Map(NFL_EXPERTS.map(e => [e.id, null]));
    experts.set('rulebook', signal / 0.3 + gauss() * 1.5);
    experts.set('game_replay', signal / 0.3 + gauss() * 2);
    experts.set('specialist_team', signal / 0.3 + gauss() * 2);
    experts.set('player_builder', signal / 0.3 + gauss() * 3);
    experts.set('similar_games', gauss() * 3);
    games.push({ key: `2023|${week}|T${g}`, season: 2023, week, home: `T${g}`, away: 'X', target, experts });
  }
  return games;
}

test('shrinkage recovers a small scale for the signal and zero for noise; families pool the copies', () => {
  const games = makeGames();
  const shrink = __test.shrinkageScales(games);
  assert.ok(shrink.rulebook.k > 0.15 && shrink.rulebook.k < 0.45, `rulebook k ${shrink.rulebook.k} should be near 0.3`);
  assert.ok(shrink.rulebook.gain > 0);
  assert.equal(shrink.similar_games.k, 0, 'noise earns nothing');
  assert.match(shrink.similar_games.reason, /no walk-forward gain/);
  assert.equal(shrink.line_movement.k, 0);
  assert.match(shrink.line_movement.reason, /fewer than/);
  const { families } = __test.familiesOf(games);
  assert.equal(families.length, 1);
  assert.deepEqual([...families[0].members].sort(), ['game_replay', 'player_builder', 'rulebook', 'specialist_team']);
});

test('the fitted coordinator beats the raw average of the copies and explains itself per role', () => {
  const games = makeGames();
  const train = games.filter(g => g.week <= 24), test_ = games.filter(g => g.week > 24);
  const fit = { ...__test.fitRows(train), games: train.length, weeks: 24 };
  assert.equal(fit.families.length, 1);
  assert.ok(fit.columns.length < NFL_EXPERTS.length, 'the family collapsed four columns into one');
  let coordSq = 0, rawSq = 0, zeroSq = 0;
  for (const g of test_) {
    const experts = NFL_EXPERTS.map(e => ({ id: e.id, observed: Number.isFinite(g.experts.get(e.id)), forecast_residual: g.experts.get(e.id) }));
    const out = __test.coordinateWith(fit, experts);
    const rawMean = ['rulebook', 'game_replay', 'specialist_team', 'player_builder'].reduce((s, id) => s + g.experts.get(id), 0) / 4;
    coordSq += (g.target - out.forecast_residual) ** 2; rawSq += (g.target - rawMean) ** 2; zeroSq += g.target ** 2;
    const rulebook = out.contributions.find(c => c.id === 'rulebook');
    assert.equal(rulebook.family, 'family_1');
    assert.ok(rulebook.shrink > 0);
    assert.equal(out.contributions.find(c => c.id === 'similar_games').shrink, 0);
  }
  const rmse = v => Math.sqrt(v / test_.length);
  assert.ok(rmse(coordSq) < rmse(rawSq), `coordinator ${rmse(coordSq)} vs raw mean ${rmse(rawSq)}`);
  assert.ok(rmse(coordSq) < rmse(zeroSq), `coordinator ${rmse(coordSq)} vs market ${rmse(zeroSq)}`);
});
