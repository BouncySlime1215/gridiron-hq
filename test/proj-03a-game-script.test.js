// PROJ-03-a (CE-01 part a): the seeded game-script sampler (study code, declined;
// scripts/proj03a/game-script-sampler.mjs, not a production module).
// Contract: one keyed score path per game, consistent with the line, shared by every
// player in that game. Evidence: docs/tdd/2026-09-23-proj-03a-game-script-sampler.tdd.md
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-proj03a-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const gs = await import('../scripts/proj03a/game-script-sampler.mjs');
const { keyedSeed, normalCdf } = await import('../server/services/stats-util.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

// Deterministic synthetic history: 2021-2022 full seasons (16 games a week, 17 weeks),
// scores = implied + noise whose sd grows with |spread|, so the bucket fit has signal.
const TEAMS = Array.from({ length: 32 }, (_, i) => `T${String(i).padStart(2, '0')}`);
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
function seedHistory() {
  const u = lcg(7);
  const gauss = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  const line = db.prepare(`INSERT INTO game_lines (season, week, team, opponent, home, spread, total,
      implied_points, source, team_score, opp_score) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const hasPlayers = db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name='players'`).get().n;
  const cols = hasPlayers ? db.prepare(`PRAGMA table_info(players)`).all().map(c => c.name) : [];
  const usage = db.prepare(`INSERT INTO player_week_usage (player_id, season, week, team, attempts, carries)
      VALUES (?,?,?,?,?,?)`);
  let pid = 1;
  const playerFor = new Map();
  for (const t of TEAMS) {
    playerFor.set(t, pid);
    if (cols.includes('name')) db.prepare(`INSERT OR IGNORE INTO players (id, name, position) VALUES (?, ?, 'QB')`).run(pid, `QB ${t}`);
    pid++;
  }
  for (const season of [2021, 2022]) {
    for (let week = 1; week <= 17; week++) {
      for (let g = 0; g < 16; g++) {
        const home = TEAMS[g], away = TEAMS[16 + ((g + week) % 16)];
        const spread = Math.round((u() * 24 - 12) * 2) / 2;        // home perspective
        const total = Math.round((38 + u() * 16) * 2) / 2;
        const ih = total / 2 - spread / 2, ia = total / 2 + spread / 2;
        const sd = Math.abs(spread) < 3 ? 8 : Math.abs(spread) <= 7 ? 9.5 : 11;
        const hs = Math.max(0, Math.round(ih + sd * gauss()));
        const as = Math.max(0, Math.round(ia + sd * gauss()));
        line.run(season, week, home, away, 1, spread, total, ih, 'nflverse', hs, as);
        line.run(season, week, away, home, 0, -spread, total, ia, 'nflverse', as, hs);
        // Pace signal: the leader runs more, the trailer throws more.
        const m = hs - as;
        usage.run(playerFor.get(home), season, week, home, 34 - 0.3 * m + u() * 4, 26 + 0.3 * m + u() * 4);
        usage.run(playerFor.get(away), season, week, away, 34 + 0.3 * m + u() * 4, 26 - 0.3 * m + u() * 4);
      }
    }
  }
  // One future game with a line and no score (a look-ahead line).
  line.run(2023, 1, 'T00', 'T01', 1, -3.5, 47.5, 25.5, 'espn', null, null);
  line.run(2023, 1, 'T01', 'T00', 0, 3.5, 47.5, 22, 'espn', null, null);
}
seedHistory();

const GAME = { season: 2023, week: 1, home: 'T00', away: 'T01', home_spread: -3.5, total: 47.5, neutral: false };

test('RED: the same key gives the same path; a different key gives a different one', () => {
  const a = gs.sampleGameScript(GAME, keyedSeed('world', 1, 'T00-T01'));
  const b = gs.sampleGameScript(GAME, keyedSeed('world', 1, 'T00-T01'));
  const c = gs.sampleGameScript(GAME, keyedSeed('world', 2, 'T00-T01'));
  assert.deepEqual(a, b);
  assert.notEqual(a.home.points, c.home.points);
});

test('RED: mean drawn total over 20k keys equals the line total within 0.1; each side its implied', () => {
  const params = gs.scoreModelAt(2023, 1);
  let tot = 0, h = 0, aw = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const p = gs.sampleGameScript(GAME, keyedSeed('mean-check', i), params);
    tot += p.total; h += p.home.points; aw += p.away.points;
  }
  assert.ok(Math.abs(tot / N - 47.5) <= 0.1, `mean total ${tot / N} vs 47.5`);
  // implied = total/2 -/+ spread/2 = 25.5 home, 22.0 away (the first RED draft had 25.75/21.75, a margin of 4, not 3.5).
  assert.ok(Math.abs(h / N - 25.5) <= 0.1, `mean home ${h / N} vs 25.5`);
  assert.ok(Math.abs(aw / N - 22) <= 0.1, `mean away ${aw / N} vs 22`);
});

test('path shape: quarters sum to finals, margin/total consistent, pregame win prob = Phi(mu/sigma)', () => {
  const params = gs.scoreModelAt(2023, 1);
  const p = gs.sampleGameScript(GAME, keyedSeed('shape', 1), params);
  for (const side of ['home', 'away']) {
    assert.equal(p[side].quarters.length, 4);
    const s = p[side].quarters.reduce((x, y) => x + y, 0);
    assert.ok(Math.abs(s - p[side].points) < 1e-6, `${side} quarters ${s} vs ${p[side].points}`);
    assert.ok(p[side].quarters.every(q => q >= 0));
  }
  assert.ok(Math.abs(p.total - (p.home.points + p.away.points)) < 1e-9);
  assert.ok(Math.abs(p.margin - (p.home.points - p.away.points)) < 1e-9);
  assert.equal(p.bucket, '3to7');
  assert.equal(p.win_prob_home.length, 5);
  const b = params.buckets['3to7'];
  assert.ok(Math.abs(p.win_prob_home[0] - normalCdf(3.5 / b.margin_sd)) < 1e-9);
  const last = p.win_prob_home[4];
  assert.equal(last, p.margin > 0 ? 1 : p.margin < 0 ? 0 : 0.5);
});

test('bucket sd comes from the |spread| bucket and widens with the synthetic truth', () => {
  const params = gs.scoreModelAt(2023, 1);
  assert.equal(gs.spreadBucket(-2.5), 'lt3');
  assert.equal(gs.spreadBucket(3), '3to7');
  assert.equal(gs.spreadBucket(7), '3to7');
  assert.equal(gs.spreadBucket(-7.5), 'gt7');
  const { lt3, gt7 } = params.buckets;
  assert.ok(lt3.n > 100 && gt7.n > 100);
  assert.ok(gt7.sd > lt3.sd, `gt7 ${gt7.sd} should exceed lt3 ${lt3.sd}`);
  assert.ok(Number.isFinite(params.pooled_sd));
  assert.deepEqual(params.fitted_through, { season: 2023, week: 1 });
});

test('cutoff-safe: rows at or after the cutoff never change the fitted params', () => {
  const before = JSON.stringify(gs.scoreModelAt(2023, 2).buckets);
  gs.clearScoreModelCache();
  db.prepare(`INSERT INTO game_lines (season, week, team, opponent, home, spread, total, implied_points, source, team_score, opp_score)
    VALUES (2023, 2, 'T05', 'T06', 1, -1, 40, 20.5, 'nflverse', 99, 0)`).run();
  const after = JSON.stringify(gs.scoreModelAt(2023, 2).buckets);
  assert.equal(after, before);
});

test('gameFor reads the line both ways; null without a line', () => {
  const g = gs.gameFor(2023, 1, 'T01');
  assert.equal(g.home, 'T00');
  assert.equal(g.away, 'T01');
  assert.equal(g.home_spread, -3.5);
  assert.equal(g.total, 47.5);
  assert.equal(g.source, 'line');
  // A rated game with no line stays null: the power-rating fallback was dropped.
  db.prepare(`INSERT INTO nfl_external_ratings (source, season, week, team, rating, fetched_at) VALUES
    ('espn_fpi', 2023, 3, 'T10', 5, '2023-09-20'), ('espn_fpi', 2023, 3, 'T11', -1, '2023-09-20')`).run();
  assert.equal(gs.gameFor(2023, 3, 'T10'), null);
});

test('copula: the bucket rho reaches the draws; quarters depend on the key', () => {
  const base = gs.scoreModelAt(2023, 1);
  const params = { ...base, buckets: { ...base.buckets, '3to7': { ...base.buckets['3to7'], rho: 0.8 } } };
  const hs = [], as = [];
  for (let i = 0; i < 4000; i++) {
    const p = gs.sampleGameScript(GAME, keyedSeed('rho-check', i), params);
    hs.push(p.home.points); as.push(p.away.points);
  }
  const m = a => a.reduce((x, y) => x + y, 0) / a.length;
  const mh = m(hs), ma = m(as);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < hs.length; i++) { sxy += (hs[i] - mh) * (as[i] - ma); sxx += (hs[i] - mh) ** 2; syy += (as[i] - ma) ** 2; }
  assert.ok(sxy / Math.sqrt(sxx * syy) > 0.6, `drawn correlation ${sxy / Math.sqrt(sxx * syy)} should track rho 0.8`);
  const a = gs.sampleGameScript(GAME, keyedSeed('q', 1), params), b = gs.sampleGameScript(GAME, keyedSeed('q', 2), params);
  const frac = p => p.home.quarters.map(q => +(q / p.home.points).toFixed(6));
  assert.notDeepEqual(frac(a), frac(b));
});

test('draw spread: 20k home and away draws have the bucket sd and the Gamma 10%/90% quantiles', () => {
  const params = gs.scoreModelAt(2023, 1);
  const b = params.buckets['3to7'];
  const N = 20000, h = [], a = [];
  for (let i = 0; i < N; i++) {
    const p = gs.sampleGameScript(GAME, keyedSeed('sd-check', i), params);
    h.push(p.home.points); a.push(p.away.points);
  }
  const sd = x => { const m = x.reduce((s, y) => s + y, 0) / x.length; return Math.sqrt(x.reduce((s, y) => s + (y - m) ** 2, 0) / (x.length - 1)); };
  assert.ok(Math.abs(sd(h) - b.sd) < 0.2, `home draw sd ${sd(h)} vs bucket ${b.sd}`);
  assert.ok(Math.abs(sd(a) - b.sd) < 0.2, `away draw sd ${sd(a)} vs bucket ${b.sd}`);
  const q = (x, u) => [...x].sort((m, n) => m - n)[Math.floor(u * x.length)];
  const dh = gs.teamPointsDistribution(25.5, -3.5, params);
  for (const u of [0.1, 0.9]) assert.ok(Math.abs(q(h, u) - dh.quantile(u)) < 0.4, `home q${u} ${q(h, u)} vs ${dh.quantile(u)}`);
});

test('win probability after quarters 1-3 follows the Brownian margin model on the drawn quarters', () => {
  const params = gs.scoreModelAt(2023, 1);
  const sigma = params.buckets['3to7'].margin_sd, mu = 3.5;
  for (const k of [1, 2, 3]) {
    const p = gs.sampleGameScript(GAME, keyedSeed('wp', k), params);
    let mh = 0;
    for (let q = 0; q < 3; q++) {
      mh += p.home.quarters[q] - p.away.quarters[q];
      const rest = 1 - (q + 1) / 4;
      const want = normalCdf((mh + mu * rest) / (sigma * Math.sqrt(rest)));
      assert.ok(Math.abs(p.win_prob_home[q + 1] - want) < 1e-9, `key ${k} q${q + 1}: ${p.win_prob_home[q + 1]} vs ${want}`);
    }
  }
});

test('home and away quarter splits use separate keyed streams', () => {
  const params = gs.scoreModelAt(2023, 1);
  const frac = s => s.quarters.map(v => v / s.points);
  const hf = [], af = [];
  for (let i = 0; i < 2000; i++) {
    const p = gs.sampleGameScript(GAME, keyedSeed('qstream', i), params);
    if (i < 5) assert.notDeepEqual(frac(p.home).map(v => +v.toFixed(6)), frac(p.away).map(v => +v.toFixed(6)));
    hf.push(frac(p.home)[0]); af.push(frac(p.away)[0]);
  }
  const m = x => x.reduce((s, y) => s + y, 0) / x.length;
  const mh = m(hf), ma = m(af);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < hf.length; i++) { sxy += (hf[i] - mh) * (af[i] - ma); sxx += (hf[i] - mh) ** 2; syy += (af[i] - ma) ** 2; }
  assert.ok(Math.abs(sxy / Math.sqrt(sxx * syy)) < 0.15, `Q1 share correlation ${sxy / Math.sqrt(sxx * syy)} should be near 0`);
});

test('study code stays out of production: nothing in server/ or client/ imports the sampler', async () => {
  const { execFileSync } = await import('node:child_process');
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-l', 'game-script-sampler', '--', 'server', 'client'], { encoding: 'utf8' });
  } catch (e) {
    if (e.status !== 1) throw e;            // git grep exits 1 on no match
  }
  assert.equal(out.trim(), '');
});
