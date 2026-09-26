/**
 * PROJ-01-a (ESPN Mistake Map) study helpers: the pieces the pre-registered verdict rests
 * on (docs/evidence/2026-09-23/proj-01-preregistration.md). No database, no ESPN archive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SPOTS, PREREG, refuseHoldout, parseEspnArchive, benjaminiHochberg, ksUniform, clusteredMean,
  empiricalPit, ladFit, spotTest, spotVerdicts, normCdf, normInv, rng, teamTotalMoves, moveDirection,
  CONFIRM_2025_SPOTS, CONFIRM_2025_ENV, confirm2025Verdict
} from '../scripts/rnd/espn-mistake-map.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts/rnd/espn-mistake-map.mjs');
const runCli = (args, env = {}) => {
  const base = { ...process.env };
  delete base[CONFIRM_2025_ENV];
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8', env: { ...base, ...env } });
};

test('the spot table in the script matches the committed pre-registration (ids and predicted signs)', () => {
  const md = fs.readFileSync(new URL(`../${PREREG}`, import.meta.url), 'utf8');
  for (const s of SPOTS) {
    const line = md.split('\n').find(l => l.startsWith(`| ${s.id} |`));
    assert.ok(line, `${s.id} is in the pre-registration table`);
    const signCell = line.split('|').at(-2).trim();
    assert.equal(signCell.startsWith(s.sign > 0 ? '+' : '-'), true, `${s.id} predicted sign`);
  }
});

test('2025 and later are refused', () => {
  assert.equal(refuseHoldout(2024), 2024);
  assert.throws(() => refuseHoldout(2025), /never opens 2025/);
  assert.throws(() => refuseHoldout(2026));
});

test('parseEspnArchive keeps projection, actual and played; skips K/DST and other seasons', () => {
  const json = { players: [
    { player: { id: 7, defaultPositionId: 2, stats: [
      { seasonId: 2023, statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 3, appliedTotal: 12.5 },
      { seasonId: 2023, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 3, appliedTotal: 9, stats: { 24: 50 } },
      { seasonId: 2023, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 4, appliedTotal: 0, stats: {} },
      { seasonId: 2023, statSourceId: 1, statSplitTypeId: 0, scoringPeriodId: 0, appliedTotal: 200 },
      { seasonId: 2022, statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 3, appliedTotal: 99 }
    ] } },
    { player: { id: 8, defaultPositionId: 5, stats: [{ seasonId: 2023, statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 3, appliedTotal: 8 }] } }
  ] };
  const a = parseEspnArchive(json, 2023);
  assert.equal(a.players, 1);
  assert.deepEqual(a.byEspnWeek.get('7|3'), { proj: 12.5, actual: 9, played: true });
  assert.deepEqual(a.byEspnWeek.get('7|4'), { proj: null, actual: 0, played: false });
  assert.equal(a.byEspnWeek.has('8|3'), false);
  assert.equal(a.position.get(7), 'RB');
});

test('Benjamini-Hochberg matches the textbook step-up values', () => {
  const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.2, null]);
  // sorted .01 .03 .04 .2 (m=4): .04, .0533, .0533, .2
  assert.ok(Math.abs(q[0] - 0.04) < 1e-12);
  assert.ok(Math.abs(q[2] - 0.16 / 3) < 1e-12);
  assert.ok(Math.abs(q[1] - 0.16 / 3) < 1e-12);
  assert.ok(Math.abs(q[3] - 0.2) < 1e-12);
  assert.equal(q[4], null);
});

test('normal helpers are accurate', () => {
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normInv(0.975) - 1.959964) < 1e-5);
});

test('KS: uniform draws pass, a shifted sample fails', () => {
  const r = rng(3);
  const u = Array.from({ length: 3000 }, () => r());
  assert.ok(ksUniform(u).p > 0.05);
  assert.ok(ksUniform(u.map(x => x * 0.8)).p < 1e-6);
});

test('randomized empirical PIT is uniform when test and training share a distribution', () => {
  const r = rng(9);
  const train = Array.from({ length: 4000 }, () => Math.round(r() * 20)).sort((a, b) => a - b); // heavy ties
  const pits = Array.from({ length: 3000 }, () => empiricalPit(train, Math.round(r() * 20), r()));
  assert.ok(ksUniform(pits).p > 0.05);
});

test('clusteredMean widens the interval when a player repeats', () => {
  const vals = [1, 1.2, 0.8, 1.1, -1, -1.2, -0.9, -1.1];
  const iid = clusteredMean(vals, vals.map((_, i) => i));
  const clustered = clusteredMean(vals, [1, 1, 1, 1, 2, 2, 2, 2]);
  assert.ok(clustered.se > iid.se);
});

test('ladFit recovers a median line through outliers', () => {
  const X = [], y = [];
  for (let i = 0; i < 200; i++) { X.push([1, i / 10]); y.push(2 + 0.5 * (i / 10) + (i % 10 === 0 ? 100 : 0)); }
  const [a, b] = ladFit(X, y);
  assert.ok(Math.abs(a - 2) < 0.05 && Math.abs(b - 0.5) < 0.01);
});

test('spotTest scores the excess over the same season/position complement, and the verdict needs every season', () => {
  const rows = [];
  let id = 0;
  for (const season of [2021, 2022, 2023, 2024]) {
    for (let i = 0; i < 60; i++) {
      const inSpot = i < 20;
      rows.push({ season, position: 'RB', player: id++, error: (inSpot ? -1 : 0) - 0.5 + ((i % 5) - 2) * 0.1, spots: { x: inSpot } });
    }
  }
  const t = spotTest(rows, { id: 'x', sign: -1, positions: ['RB'] });
  assert.ok(Math.abs(t.pooled_excess.mean + 1) < 0.05, 'population bias -0.5 removed');
  const [v] = spotVerdicts([t]);
  assert.equal(v.proven, true);
  const flipped = rows.map(r => (r.season === 2024 && r.spots.x ? { ...r, error: r.error + 2 } : r));
  const [v2] = spotVerdicts([spotTest(flipped, { id: 'x', sign: -1, positions: ['RB'] })]);
  assert.equal(v2.same_sign_all_seasons, false);
  assert.equal(v2.proven, false);
});

test('teamTotalMoves: implied team total = total/2 - spread/2, averaged over books with all four lines', () => {
  const line = (book, market, side, phase, v) => ({ eid: 1, week: 5, home: 'ARI', away: 'PHI', book, market, side, phase, line: v });
  const rows = [
    line('a', 'totals', 'over', 'open', 48), line('a', 'totals', 'over', 'close', 52), line('a', 'totals', 'under', 'close', 52),
    line('a', 'spreads', 'home', 'open', 4), line('a', 'spreads', 'home', 'close', 6), line('a', 'spreads', 'away', 'close', -6),
    line('b', 'totals', 'over', 'open', 50), line('b', 'totals', 'over', 'close', 50), line('b', 'spreads', 'home', 'open', 4), // b has no spread close: skipped
    { ...line('a', 'totals', 'over', 'open', 40), eid: 2, week: null } // preseason
  ];
  const m = teamTotalMoves(rows);
  assert.equal(m.size, 2);
  const home = m.get('ARI|5'), away = m.get('PHI|5');
  assert.equal(home.books, 1);
  assert.equal(home.open, 22); assert.equal(home.close, 23); assert.equal(home.move, 1);
  assert.equal(away.open, 26); assert.equal(away.close, 29); assert.equal(away.move, 3);
  assert.equal(moveDirection(away), 1);
  assert.equal(moveDirection(home), 0);
  assert.equal(moveDirection({ move: -2.5 }), -1);
  assert.equal(moveDirection(undefined), 0);
});

test('a signed spot tests direction x excess error', () => {
  const rows = [];
  let id = 0;
  for (const season of [2021, 2022, 2023, 2024]) {
    for (let i = 0; i < 90; i++) {
      const d = i < 20 ? 1 : i < 40 ? -1 : 0; // ESPN lags: error follows the move's direction
      rows.push({ season, position: 'WR', player: id++, error: d * 1.5 - 0.4 + ((i % 5) - 2) * 0.1, spots: { m: d } });
    }
  }
  const t = spotTest(rows, { id: 'm', sign: +1, positions: ['WR'], signed: true });
  assert.ok(Math.abs(t.pooled_excess.mean - 1.5) < 0.05);
  assert.equal(t.per_season[2022].n, 40);
  assert.equal(spotVerdicts([t])[0].proven, true);
});

// ---------------------------------------------------------------- PROJ-01-a-2025 (--confirm-2025)

test('CONFIRM_2025_SPOTS is exactly the two spots PR #222 proved (frozen), and stays in SPOTS with its original sign', () => {
  assert.deepEqual([...CONFIRM_2025_SPOTS], ['qb_change', 'blowout_underdog_rb']);
  for (const id of CONFIRM_2025_SPOTS) {
    const spot = SPOTS.find(s => s.id === id);
    assert.ok(spot, `${id} is still in SPOTS`);
    assert.equal(spot.sign, -1, `${id} keeps its frozen predicted sign`);
  }
});

test('confirm2025Verdict: same sign as predicted is confirmed, flipped sign is not', () => {
  const rows = [];
  let id = 0;
  // qb_change: spot rows well below the complement -> negative excess, matches predicted sign -1
  for (let i = 0; i < 20; i++) {
    rows.push({ season: 2025, position: 'RB', player: id++, error: -3, spots: { qb_change: true, blowout_underdog_rb: false } });
    rows.push({ season: 2025, position: 'RB', player: id++, error: 0, spots: { qb_change: false, blowout_underdog_rb: false } });
  }
  // blowout_underdog_rb: spot rows above the complement -> positive excess, flips the predicted sign -1
  for (let i = 0; i < 20; i++) {
    rows.push({ season: 2025, position: 'RB', player: id++, error: 3, spots: { qb_change: false, blowout_underdog_rb: true } });
    rows.push({ season: 2025, position: 'RB', player: id++, error: 0, spots: { qb_change: false, blowout_underdog_rb: false } });
  }
  const v = confirm2025Verdict(rows);
  assert.equal(v.qb_change.predicted_sign, -1);
  assert.equal(v.qb_change.sign, -1);
  assert.equal(v.qb_change.same_sign, true);
  assert.equal(v.blowout_underdog_rb.predicted_sign, -1);
  assert.equal(v.blowout_underdog_rb.sign, 1);
  assert.equal(v.blowout_underdog_rb.same_sign, false);
});

test('--confirm-2025 refuses without the default-off flag', () => {
  const r = runCli(['--confirm-2025', 'L163', '--db', '.local-db/data.sqlite']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(`${CONFIRM_2025_ENV}=1`));
});

test('--confirm-2025 refuses a ledger row id that does not exist in HOLDOUT-LEDGER.md', () => {
  const r = runCli(['--confirm-2025', 'L999999', '--db', '.local-db/data.sqlite'], { [CONFIRM_2025_ENV]: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no such row in docs\/evidence\/HOLDOUT-LEDGER\.md/);
});

test('--confirm-2025 requires a ledger row id argument', () => {
  const r = runCli(['--confirm-2025', '--db', '.local-db/data.sqlite'], { [CONFIRM_2025_ENV]: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /requires a docs\/evidence\/HOLDOUT-LEDGER\.md row id/);
});

test('the --grade/--baseline path is unaffected by --confirm-2025 (refuseHoldout still default for every other path)', () => {
  assert.throws(() => refuseHoldout(2025), /never opens 2025/);
});
