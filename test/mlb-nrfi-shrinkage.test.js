import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Phase 0 fix: nrfiFor()'s hand-picked shrinkage constants (k=12 for a team's
// first-inning rate, k=40 for a venue's YRFI rate) produced an INVERTED
// calibration slope against 751 real graded picks — the model's "more
// confident" bucket won less often than its "less confident" one, a
// winner's-curse symptom of under-corrected shrinkage. This file checks the
// two pieces of the fix in isolation:
//   1. shrinkRate (stats-util.js) does the blend in the arcsine-stabilized
//      domain instead of on the raw proportion, and beats naive `shrink` on
//      small, noisy samples spread across a realistic rate range.
//   2. The method-of-moments k-fit (fitK, reused from shrinkage-fit.js, via
//      mlb-shrinkage-fit.js's chunking) converges — lower bias, much lower
//      variance across independent replicates — as more history accumulates.

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-nrfi-shrink-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/mlb.js'); // creates mlb_games via its own db.exec

const { arcsine, arcsineInverse, shrink, shrinkRate } = await import('../server/services/stats-util.js');
const { fitK } = await import('../server/services/shrinkage-fit.js');
const { fitTeamFirstInningK, nrfiKs, _clearNrfiKCache } = await import('../server/services/mlb-shrinkage-fit.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Small deterministic PRNG, independent of the app's own random() state.
function makeRand(seedInit) {
  let seed = seedInit;
  return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
}

test('arcsine transform round-trips and shrinkRate guards degenerate inputs', () => {
  for (const p of [0, 0.02, 0.15, 0.27, 0.5, 0.73, 0.99, 1]) {
    assert.ok(Math.abs(arcsineInverse(arcsine(p)) - p) < 1e-9, `round trip failed for p=${p}`);
  }
  assert.equal(shrinkRate(0.9, 0.3, 0, 12), 0.3, 'zero sample size falls back to the prior');
  assert.equal(shrinkRate(0.9, 0.3, 10, Infinity), 0.3, 'k=Infinity (no detectable signal) trusts the prior completely');
});

test('shrinkRate beats naive linear shrink on small samples spread across a realistic rate range', () => {
  // Mirrors the actual bug: a thin sample (n=5, like early-season team
  // first-inning history) shrunk with the same hand-picked k=12 the bug used,
  // across true rates spanning the real first-inning-scoring range (roughly
  // 3%-50%) rather than sitting conveniently at 0.5.
  const truePs = [0.03, 0.06, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50];
  const n = 5, k = 12;
  const prior = truePs.reduce((s, x) => s + x, 0) / truePs.length;
  const rand = makeRand(7);
  let sseNaive = 0, sseArc = 0, trials = 0;
  for (const p of truePs) {
    for (let t = 0; t < 3000; t++) {
      let successes = 0;
      for (let i = 0; i < n; i++) if (rand() < p) successes++;
      const observed = successes / n;
      sseNaive += (shrink(observed, prior, n, k) - p) ** 2;
      sseArc += (shrinkRate(observed, prior, n, k) - p) ** 2;
      trials++;
    }
  }
  const mseNaive = sseNaive / trials, mseArc = sseArc / trials;
  assert.ok(mseArc < mseNaive, `arcsine-domain MSE ${mseArc} should beat naive linear MSE ${mseNaive}`);
});

test('method-of-moments k-fit converges (lower bias, much lower variance) as history accumulates', () => {
  // Same chunking fitTeamFirstInningK does (monthly rate per group, arcsine
  // transformed, weighted by games in the chunk) but built directly against
  // fitK so the test isolates the estimator's behavior from database wiring.
  const truePs = [0.10, 0.18, 0.26, 0.34, 0.42, 0.50, 0.58, 0.66];
  const arcVals = truePs.map(arcsine);
  const meanArc = arcVals.reduce((s, x) => s + x, 0) / arcVals.length;
  const trueBetween = arcVals.reduce((s, x) => s + (x - meanArc) ** 2, 0) / arcVals.length;

  const makeObservations = (chunksPerTeam, gamesPerChunk, rand) => {
    const obs = [];
    truePs.forEach((p, i) => {
      for (let c = 0; c < chunksPerTeam; c++) {
        let scored = 0;
        for (let g = 0; g < gamesPerChunk; g++) if (rand() < p) scored++;
        obs.push({ group: `T${i}`, weight: gamesPerChunk, value: arcsine(scored / gamesPerChunk) });
      }
    });
    return obs;
  };

  const replicateSigma2Between = (chunksPerTeam, gamesPerChunk, seed) => {
    const fit = fitK(makeObservations(chunksPerTeam, gamesPerChunk, makeRand(seed)));
    return fit ? fit.sigma2_between : null;
  };
  const summarize = (chunksPerTeam, gamesPerChunk) => {
    const ests = [];
    for (let s = 1; s <= 20; s++) {
      const v = replicateSigma2Between(chunksPerTeam, gamesPerChunk, s * 97 + 3);
      if (v != null) ests.push(v);
    }
    const m = ests.reduce((a, b) => a + b, 0) / ests.length;
    const sd = Math.sqrt(ests.reduce((a, b) => a + (b - m) ** 2, 0) / ests.length);
    return { mean: m, sd, n: ests.length };
  };

  // "small": a thin, single-season-like sample (3 monthly chunks, 2 games each).
  // "large": four-plus seasons of accumulated history (60 chunks, 12 games each).
  const small = summarize(3, 2);
  const large = summarize(60, 12);

  assert.equal(small.n, 20);
  assert.equal(large.n, 20);
  assert.ok(
    Math.abs(large.mean - trueBetween) < Math.abs(small.mean - trueBetween),
    `larger sample (${large.mean}) should land closer to the true between-team variance (${trueBetween}) than the small sample (${small.mean})`
  );
  assert.ok(
    large.sd < small.sd * 0.3,
    `larger sample's estimate should be far more stable across replicates: small sd=${small.sd}, large sd=${large.sd}`
  );
});

test('fitTeamFirstInningK / nrfiKs wire up against real mlb_games rows without throwing, and fall back sanely on thin data', () => {
  const teams = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  const truePs = [0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50];
  const rand = makeRand(11);
  const ins = db.prepare(`INSERT INTO mlb_games
    (game_pk, season, date, home_team, away_team, home_team_id, away_team_id, venue,
     first_inning_home_runs, first_inning_away_runs, yrfi)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  let gamePk = 500000;
  const monthDate = m => `${2020 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}-15`;
  const playMonth = m => {
    const date = monthDate(m);
    for (let i = 0; i < 8; i++) {
      const home = i, away = (i + 4) % 8;
      const h = rand() < truePs[home] ? 1 : 0;
      const a = rand() < truePs[away] ? 1 : 0;
      ins.run(gamePk++, 2020 + Math.floor(m / 12), date, teams[home], teams[away], home, away,
        `V${(home + away) % 3}`, h, a, (h || a) ? 1 : 0);
    }
  };

  // Thin: only one month of history exists yet.
  playMonth(0);
  const thin = fitTeamFirstInningK('2099-01-01');
  assert.ok(thin === null || Number.isFinite(thin.k) || thin.k === Infinity);

  const thinKs = nrfiKs('2099-01-01');
  assert.ok(Number.isFinite(thinKs.team_first_inning) || thinKs.team_first_inning === Infinity);
  assert.ok(Number.isFinite(thinKs.venue_yrfi) || thinKs.venue_yrfi === Infinity);

  // Cache hit: same key returns the same object without recomputation.
  assert.equal(nrfiKs('2099-01-01'), thinKs);
  _clearNrfiKCache();
  assert.notEqual(nrfiKs('2099-01-01'), thinKs, 'clearing the cache should force a recompute');

  // Accumulate real history and confirm the fit stays well-formed and finite.
  for (let m = 1; m < 48; m++) playMonth(m);
  _clearNrfiKCache();
  const rich = fitTeamFirstInningK('2099-01-01');
  assert.ok(rich, 'fit should succeed with 4 seasons of history across 8 teams');
  assert.ok(Number.isFinite(rich.k) && rich.k > 0, `k should be a finite positive number, got ${rich.k}`);
  assert.ok(rich.n_groups >= 5);
});
