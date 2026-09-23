// PROJ-03-a (CE-01 part a): the seeded game-script sampler in gamescript.js.
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
const gs = await import('../server/services/gamescript.js');
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
    assert.ok(Number.isFinite(p[side].pace.pass_att) && Number.isFinite(p[side].pace.rush_att));
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
  gs.clearGameScriptCache();
  db.prepare(`INSERT INTO game_lines (season, week, team, opponent, home, spread, total, implied_points, source, team_score, opp_score)
    VALUES (2023, 2, 'T05', 'T06', 1, -1, 40, 20.5, 'nflverse', 99, 0)`).run();
  const after = JSON.stringify(gs.scoreModelAt(2023, 2).buckets);
  assert.equal(after, before);
});

test('gameFor reads the line both ways; fallback to power rating; null when nothing', () => {
  const g = gs.gameFor(2023, 1, 'T01');
  assert.equal(g.home, 'T00');
  assert.equal(g.away, 'T01');
  assert.equal(g.home_spread, -3.5);
  assert.equal(g.total, 47.5);
  assert.equal(g.source, 'line');
  // No line but both teams rated: spread from the rating gap plus home field.
  db.prepare(`INSERT INTO nfl_external_ratings (source, season, week, team, rating, fetched_at) VALUES
    ('espn_fpi', 2023, 3, 'T10', 5, '2023-09-20'), ('espn_fpi', 2023, 3, 'T11', -1, '2023-09-20')`).run();
  const f = gs.gameFor(2023, 3, 'T10', { opponent: 'T11', home: true });
  assert.equal(f.source, 'power_rating');
  assert.ok(f.home_spread < -6, `rating gap 6 plus home field should favour T10 by >6, got ${f.home_spread}`);
  assert.ok(f.total > 30 && f.total < 60);
  assert.equal(gs.gameFor(2023, 3, 'T20', { opponent: 'T21', home: true }), null);
});
