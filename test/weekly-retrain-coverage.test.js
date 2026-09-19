/**
 * The weekly retrain's coverage check must not reject on noise.
 *
 * retrainWeeklyWeights() promotes a candidate only when it "preserves interval
 * coverage". The check was an absolute band, 80% coverage in [0.78, 0.82], on the
 * validation window (~100-480 rows). The served model's own 80% coverage sits on
 * the band's edge — 0.775-0.783 across seeds and draw counts with the model fixed
 * (docs/evidence/baselines/2025-weekly-distribution-draws.json, e8174cc) — and the
 * candidate's intervals are the champion's, shifted. So a candidate with the SAME
 * calibration as the champion failed about half the time, on noise alone, however
 * much better its MAE was (the "0.78 line", FANTASY-ENGINE-MASTER-PLAN.md Q1).
 *
 * The rule now (gate G4, written before the change): inside [0.78, 0.82] always
 * passes (the old pass region is kept); outside it, the candidate fails only when its
 * coverage is further from 0.80 than the champion's on the same rows AND the change
 * is significant under the same player-clustered paired bootstrap (90%, seed
 * 20260917) the MAE check uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-retrain-coverage-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const S = await import('../server/services/weekly-weight-store.js');
const L = await import('../server/services/weekly-learning.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const LIVE = [0.2, 0.4, 0.15000000000000002, 0.05, 0.2];
const HEADS = ['structural', 'season_to_date', 'last3', 'last1', 'median'];
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const perPosition = vector => Object.fromEntries(POSITIONS.map(p => [p, [...vector]]));
const LEDGER = { sample_size: 0, validation_size: 0, candidate_mae: null, champion_mae: null,
  candidate_spearman: null, champion_spearman: null, coverage_80: null };

function reset() {
  db.exec('DELETE FROM weekly_prediction_snapshots; DELETE FROM weekly_ensemble_fits;');
  S.saveWeeklyFit({ ...LEDGER, data_hash: `seed-${Math.random()}`, through_season: 2025, through_week: 18,
    promoted: true, weights: perPosition(LIVE) });
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/**
 * Settled rows where actual = last1. `interval(i, prediction, actual)` returns the
 * stored 80% interval for player i, so each test sets the champion's coverage.
 */
function insertSettled({ weeks, players, interval }) {
  const next = rng(4242);
  const insert = db.prepare(`INSERT INTO weekly_prediction_snapshots
    (season,week,player_id,position,as_of,cutoff,engine_version,structural,season_to_date,last3,last1,median,
     prediction,lower_80,upper_80,weights_json,weight_fit,actual,settled_at)
    VALUES (2026,?,?,?,'2026-09-01','2026-09-01','test',?,?,?,?,?,?,?,?,'[]','test',?,datetime('now'))`);
  db.exec('BEGIN');
  for (const week of weeks) {
    for (let i = 0; i < players; i++) {
      const h = Object.fromEntries(HEADS.map(k => [k, 4 + 16 * next()]));
      const actual = h.last1;
      const prediction = LIVE.reduce((s, w, k) => s + w * h[HEADS[k]], 0);
      const [lower, upper] = interval(i, prediction, actual);
      insert.run(week, `p${String(i).padStart(3, '0')}`, POSITIONS[i % 4],
        h.structural, h.season_to_date, h.last3, h.last1, h.median, prediction, lower, upper, actual);
    }
  }
  db.exec('COMMIT');
}

const WEEKS_5_14 = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

test('G4b: a much better candidate whose coverage equals the champion\'s 0.775 is promoted (the old band rejected it)', () => {
  reset();
  // 80 players x 10 weeks: validation = the last 2 whole weeks (160 rows). Players 0-17
  // (18 of 80) always miss, so champion and candidate both cover 62/80 = 0.775.
  insertSettled({ weeks: WEEKS_5_14, players: 80,
    interval: (i, pred) => (i < 18 ? [pred + 40, pred + 60] : [pred - 40, pred + 40]) });
  const out = L.retrainWeeklyWeights();
  assert.equal(out.trained, true, JSON.stringify(out));
  assert.equal(out.validation_size, 160);
  assert.equal(+out.coverage_80.toFixed(3), 0.775);
  assert.ok(out.candidate_mae < out.champion_mae, 'the candidate is the better point forecast');
  assert.equal(out.promoted, true, `same calibration as the champion must not fail on coverage: ${out.rejection_reason}`);
});

test('G4c: a candidate that moves coverage significantly away from 0.80 is still rejected', () => {
  reset();
  // The champion covers ~0.80: each stored interval holds the actual but stops just short
  // of the champion's own prediction, so shifting it onto the (perfect) candidate's
  // prediction moves it off the actual. Candidate coverage ~0.
  insertSettled({ weeks: WEEKS_5_14, players: 80,
    interval: (i, pred, actual) => {
      if (i % 5 === 0) return [actual + 40, actual + 60];
      return actual >= pred ? [pred + 0.01, actual + 0.5] : [actual - 0.5, pred - 0.01];
    } });
  const out = L.retrainWeeklyWeights();
  assert.equal(out.trained, true, JSON.stringify(out));
  assert.equal(out.promoted, false);
  assert.match(out.rejection_reason, /coverage/);
});

// ---------------------------------------------------------------- the rule itself
const covered = (n, k) => Array.from({ length: n }, (_, i) => (i < k ? 1 : 0));

test('G4c: inside [0.78, 0.82] the candidate never fails on coverage', () => {
  const groups = Array.from({ length: 400 }, (_, i) => `p${i % 100}`);
  for (const [champ, cand] of [[320, 312], [320, 328], [300, 316]]) {
    const r = L.coverageCheck({ championCovered: covered(400, champ), candidateCovered: covered(400, cand), groups });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
});

test('G4c: outside the band, failing needs BOTH further from 0.80 AND a significant change', () => {
  const groups = Array.from({ length: 400 }, (_, i) => `p${i}`);
  // Same coverage as the champion (0.775): not further -> ok.
  assert.equal(L.coverageCheck({ championCovered: covered(400, 310), candidateCovered: covered(400, 310), groups }).ok, true);
  // Slightly further (0.7725 vs 0.775) but a 1-row change: not significant -> ok.
  assert.equal(L.coverageCheck({ championCovered: covered(400, 310), candidateCovered: covered(400, 309), groups }).ok, true);
  // Much further below (0.70 vs 0.80): fail.
  const below = L.coverageCheck({ championCovered: covered(400, 320), candidateCovered: covered(400, 280), groups });
  assert.equal(below.ok, false);
  assert.match(below.reason, /further from 0\.80/);
  // Overshoot above (0.95 vs champion 0.77): further (0.15 > 0.03) and significant: fail.
  assert.equal(L.coverageCheck({ championCovered: covered(400, 308), candidateCovered: covered(400, 380), groups }).ok, false);
  // Closer to 0.80 than the champion, even if outside the band: ok.
  assert.equal(L.coverageCheck({ championCovered: covered(400, 280), candidateCovered: covered(400, 300), groups }).ok, true);
});

test('G4c: no intervals at all is a failure (nothing to check against)', () => {
  const r = L.coverageCheck({ championCovered: [], candidateCovered: [], groups: [] });
  assert.equal(r.ok, false);
  assert.equal(r.coverage, null);
});

// ---------------------------------------------------------------- G4d simulation
/**
 * Production's measured coverage (0.778), 480 validation rows = 160 players x 3 weeks,
 * player-level variation in coverage (so the player clustering matters), 200 seeds.
 *  null:    the candidate's shift re-draws 5% of rows at the same calibration;
 *  harmful: the candidate's shift uncovers 10% of covered rows (0.778 -> ~0.70).
 */
function simulate(seed, kind) {
  const next = rng(seed * 7919 + 17);
  const normal = () => Math.sqrt(-2 * Math.log(next() || 1e-12)) * Math.cos(2 * Math.PI * next());
  const players = Array.from({ length: 160 }, () => Math.min(0.99, Math.max(0.3, 0.778 + 0.08 * normal())));
  const championCovered = [], candidateCovered = [], groups = [];
  for (let p = 0; p < 160; p++) {
    for (let w = 0; w < 3; w++) {
      const c = next() < players[p] ? 1 : 0;
      let d = c;
      if (kind === 'null' && next() < 0.05) d = next() < players[p] ? 1 : 0;
      if (kind === 'harmful' && c === 1 && next() < 0.10) d = 0;
      championCovered.push(c); candidateCovered.push(d); groups.push(`p${p}`);
    }
  }
  return { championCovered, candidateCovered, groups };
}

test('G4d: at production\'s coverage the old band rejects a null candidate often; the new rule rarely; a harmful one is caught', () => {
  let oldRejects = 0, newRejects = 0, harmfulCaught = 0;
  const seeds = 200;
  for (let s = 0; s < seeds; s++) {
    const nul = simulate(s, 'null');
    const cov = nul.candidateCovered.reduce((a, b) => a + b, 0) / nul.candidateCovered.length;
    if (cov < 0.78 || cov > 0.82) oldRejects++;
    if (!L.coverageCheck(nul).ok) newRejects++;
    if (!L.coverageCheck(simulate(s, 'harmful')).ok) harmfulCaught++;
  }
  const rate = x => x / seeds;
  console.log(`G4d: old band rejects null ${rate(oldRejects)}, new rule rejects null ${rate(newRejects)}, harmful caught ${rate(harmfulCaught)}`);
  assert.ok(rate(oldRejects) >= 0.40, `old band null rejection ${rate(oldRejects)}`);
  assert.ok(rate(newRejects) <= 0.10, `new rule null rejection ${rate(newRejects)}`);
  assert.ok(rate(harmfulCaught) >= 0.90, `harmful caught ${rate(harmfulCaught)}`);
});
