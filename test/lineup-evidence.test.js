/**
 * The evidence layer behind a start/sit call, tested on a temp database.
 *
 * Three claims: the weekly floor/ceiling is computed the way the page says it
 * is; every layer degrades to null (never a throw) when its source has nothing
 * or fails; and the deciding sentence cites the numbers rather than adjectives.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lineup-evidence-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const {
  weeklyShape, quantile, candidateEvidence, compactEvidence, deciderText, evidenceCache,
  statHeadline, DEFAULT_PROVIDERS, MIN_WEEKS
} = await import('../server/services/lineup-brain.js');

const { recordNote } = await import('../server/services/league-brain.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026;

run(`INSERT INTO players (id, name, position, gsis_id, fantasy_relevant) VALUES
     (1, 'Steady Back', 'RB', '00-0000001', 1),
     (2, 'Boom Bust Back', 'RB', '00-0000002', 1),
     (3, 'Rookie Back', 'RB', NULL, 1)`);

test('a missing gamelog table is a null layer, not an error', () => {
  assert.equal(weeklyShape(1, SEASON - 1), null);
});

// The table is created lazily by the edge routes, so it does not exist after
// migrations alone — exactly the state the test above covers. This has to run
// as its own test (rather than bare module-level code) because node:test only
// starts executing test bodies once the whole module has finished evaluating
// synchronously — bare code here would already have run before the "missing
// table" test above got a chance to observe the table's absence.
test('fixture: create the gamelog table the tests below rely on', () => {
  run(`CREATE TABLE IF NOT EXISTS player_gamelog (
    player_id INTEGER NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL,
    opponent TEXT, fantasy_points REAL, PRIMARY KEY (player_id, season, week))`);
  const log = db.prepare(`INSERT INTO player_gamelog (player_id, season, week, opponent, fantasy_points) VALUES (?, ?, ?, 'OPP', ?)`);
  // Steady: weeks 1..17 score 1..17 points, so the quantiles are known in closed form.
  for (let w = 1; w <= 17; w++) log.run(1, 2025, w, w);
  // Boom/bust: 16 games alternating 2 and 24.
  for (let w = 1; w <= 16; w++) log.run(2, 2025, w, w % 2 ? 24 : 2);
  // Rookie: three preseason-ish rows only, under the minimum.
  for (let w = 1; w <= MIN_WEEKS - 1; w++) log.run(3, 2025, w, 10);
  // A null week must be ignored rather than counted as zero.
  log.run(1, 2025, 18, null);
});

test('quantile interpolates linearly', () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([10, 20], 0.25), 12.5);
  assert.equal(quantile([7], 0.8), 7);
  assert.equal(quantile([], 0.2), null);
});

test('weekly floor and ceiling are the 20th and 80th percentile weeks, with the 15+ count', () => {
  const w = weeklyShape(1, 2025);
  assert.equal(w.games, 17);                 // the null week 18 is not a game
  assert.equal(w.ppg, 9);
  assert.equal(w.floor, 4.2);                // 1 + 0.2 * 16
  assert.equal(w.ceiling, 13.8);             // 1 + 0.8 * 16
  assert.equal(w.games_15plus, 3);           // 15, 16, 17
  assert.equal(w.worst, 1);
  assert.equal(w.best, 17);

  const b = weeklyShape(2, 2025);
  assert.equal(b.games, 16);
  assert.equal(b.floor, 2);
  assert.equal(b.ceiling, 24);
  assert.equal(b.games_15plus, 8);
  assert.equal(b.ppg, 13);
});

test('fewer recorded weeks than the minimum is no shape at all', () => {
  assert.equal(weeklyShape(3, 2025), null);
  assert.equal(weeklyShape(999, 2025), null);
  assert.equal(weeklyShape(null, 2025), null);
});

const stubProviders = {
  career: (id) => id === 1 ? {
    headline: '1,000+ rush yds in 3 straight seasons · RB top-12 finish 2 of 3 years',
    seasons: [
      { season: 2025, games: 17, ppr_points: 280.4, ppg: 16.5, pos_rank: 6, rush_att: 290, rush_yds: 1310, rush_td: 11, targets: 60, rec: 48, rec_yds: 380, rec_td: 2 },
      { season: 2024, games: 16, ppr_points: 240.1, ppg: 15.0, pos_rank: 10, rush_att: 260, rush_yds: 1150, rush_td: 8 },
      { season: 2023, games: 17, ppr_points: 210.9, ppg: 12.4, pos_rank: 18, rush_att: 250, rush_yds: 1020, rush_td: 6 },
      { season: 2022, games: 12, ppr_points: 120.0, ppg: 10.0, pos_rank: 30 }
    ],
    consistency: { seasons_counted: 4, seasons_top12: 2, seasons_top24: 3, cv_points: 0.29, min_games: 12, max_games: 17 },
    streaks: [{ stat: 'rush_yds', threshold: 1000, seasons: 3, streak: 3 }, { stat: 'rush_td', threshold: 10, seasons: 1, streak: 1 }],
    trend: { role_yoy: 'carries +12%', ppg_yoy_pct: 10 }
  } : { headline: null, seasons: [], consistency: { seasons_counted: 0 }, streaks: [], trend: {} },
  preseason: (id) => id === 1 ? { points: 262.3, ppg: 16.4, expected_games: 16, p20: 201.4, p80: 318.9, drivers: ['RB6 on the market board', 'usage 290 carries last year', 'implied total top-8', 'fourth driver'] } : null,
  offseason: (id) => id === 2
    ? { opportunity_multiplier: 0.82, confidence: 'medium', drivers: ['new RB1 signed above him', 'HC change'] }
    : { opportunity_multiplier: 1, confidence: 'low', drivers: [] },
  weekly: (id, season) => weeklyShape(id, season - 1)
};

test('evidence attaches every layer that answers, trimmed for the page', () => {
  const ev = candidateEvidence(1, SEASON, stubProviders);
  assert.equal(ev.headline, '1,000+ rush yds in 3 straight seasons · RB top-12 finish 2 of 3 years · RB6 on the market board');
  assert.equal(ev.career.seasons.length, 3);                       // capped at three
  assert.equal(ev.career.seasons[0].carries, 290);                 // aliased for the draft components
  assert.equal(ev.career.streaks.length, 1);                       // one-season streaks are noise
  assert.deepEqual(ev.last_season, { season: 2025, games: 17, points: 280.4, ppg: 16.5, pos_rank: 6 });
  assert.equal(ev.weekly.floor, 4.2);
  assert.equal(ev.preseason.p20, 201.4);
  assert.equal(ev.preseason.drivers.length, 3);
  assert.equal(ev.offseason, null);                                // a neutral read says nothing
});

test('the offseason layer is a flag and a multiplier for display, never folded into a number', () => {
  const ev = candidateEvidence(2, SEASON, stubProviders);
  assert.equal(ev.offseason.risk, true);
  assert.equal(ev.offseason.opportunity_multiplier, 0.82);
  assert.equal(ev.offseason.confidence, 'medium');
  assert.equal(ev.career, null);                                   // no seasons on record
  assert.equal(ev.last_season, null);
  assert.equal(ev.weekly.ceiling, 24);
  assert.equal(ev.headline, 'new RB1 signed above him');           // no career/preseason bit, but the offseason driver clears the >=8% bar on its own
});

test('offseason drivers reach the headline only when the multiplier moved enough', () => {
  const h = statHeadline({ career: null, preseason: null, offseason: { opportunity_multiplier: 0.82, drivers: ['new RB1 signed above him'] } });
  assert.equal(h, 'new RB1 signed above him');
  const quiet = statHeadline({ career: null, preseason: null, offseason: { opportunity_multiplier: 0.97, drivers: ['minor'] } });
  assert.equal(quiet, null);
});

test('every layer null means no evidence, not an object of dashes', () => {
  const nothing = { career: () => null, preseason: () => null, offseason: () => null, weekly: () => null };
  assert.equal(candidateEvidence(1, SEASON, nothing), null);
  assert.equal(candidateEvidence(null, SEASON, stubProviders), null);
});

test('a provider that throws costs its own layer and nothing else', () => {
  const broken = {
    career: () => { throw new Error('career cache exploded'); },
    preseason: () => { throw new Error('no model'); },
    offseason: undefined,
    weekly: (id, season) => weeklyShape(id, season - 1)
  };
  const ev = candidateEvidence(1, SEASON, broken);
  assert.equal(ev.career, null);
  assert.equal(ev.preseason, null);
  assert.equal(ev.offseason, null);
  assert.equal(ev.weekly.games, 17);
  assert.equal(ev.headline, null);
});

test('the live providers degrade on an empty database instead of throwing', () => {
  // No career rows, no market board, no offseason panel — every layer but the
  // gamelog has nothing, and the call still returns.
  const ev = candidateEvidence(1, SEASON, DEFAULT_PROVIDERS);
  assert.ok(ev === null || typeof ev === 'object');
  if (ev) {
    assert.equal(ev.weekly?.games, 17);
    assert.equal(ev.preseason, null);
  }
  assert.equal(candidateEvidence(3, SEASON, DEFAULT_PROVIDERS)?.weekly ?? null, null);
});

test('the compact form drops the season table but keeps the consistency counts', () => {
  const c = compactEvidence(candidateEvidence(1, SEASON, stubProviders));
  assert.equal(c.career, undefined);
  assert.deepEqual(c.consistency, { seasons_counted: 4, seasons_top24: 3, seasons_top12: 2 });
  assert.equal(c.headline.startsWith('1,000+ rush yds'), true);
  assert.equal(c.weekly.floor, 4.2);
  assert.equal(compactEvidence(null), null);
});

test('the deciding sentence cites startable weeks and floors when both have a gamelog', () => {
  const a = candidateEvidence(1, SEASON, stubProviders);
  const b = candidateEvidence(2, SEASON, stubProviders);
  assert.equal(deciderText(a, b, 'Steady Back', 'Boom Bust Back'),
    'Last year Steady Back hit 15+ in 3 of 17 games (floor 4.2) vs Boom Bust Back 8 of 16 (floor 2).');
});

test('the deciding sentence falls back through preseason band, then last-season ppg, then silence', () => {
  const band = ev => ({ ...ev, weekly: null });
  const a = band(candidateEvidence(1, SEASON, stubProviders));
  const b = { preseason: { p20: 100.2, p80: 160.7 }, weekly: null };
  assert.equal(deciderText(a, b, 'A', 'B'), 'Preseason range 201–319 pts for A vs 100–161 for B.');

  const c = { last_season: { ppg: 16.5, games: 17 } };
  const d = { last_season: { ppg: 9.1, games: 14 } };
  assert.equal(deciderText(c, d, 'A', 'B'), 'A 16.5 ppg over 17 games last year vs B 9.1 over 14.');

  assert.equal(deciderText({ headline: 'x' }, { headline: 'y' }, 'A', 'B'), null);
  assert.equal(deciderText(null, d, 'A', 'B'), null);
});

test('the league-brain note cites the incoming player\'s record, and stays silent without one', () => {
  const ev = compactEvidence(candidateEvidence(1, SEASON, stubProviders));
  const note = recordNote({ you_get: [{ name: 'Steady Back', evidence: ev }] });
  assert.equal(note,
    ' The record on Steady Back: 1,000+ rush yds in 3 straight seasons · RB top-12 finish 2 of 3 years · RB6 on the market board; ' +
    'last year 3 of 17 weeks at 15+, floor 4.2 / ceiling 13.8; preseason band 201–319 pts.');
  const risky = compactEvidence(candidateEvidence(2, SEASON, stubProviders));
  assert.match(recordNote({ you_get: [{ name: 'B', evidence: risky }] }), /offseason read is a risk \(new RB1 signed above him\)/);
  assert.equal(recordNote({ you_get: [{ name: 'Nobody', evidence: null }] }), '');
  assert.equal(recordNote(undefined), '');
});

test('the per-call cache looks each player up once', () => {
  let calls = 0;
  const counting = { ...stubProviders, career: id => { calls++; return stubProviders.career(id); } };
  const record = evidenceCache(SEASON, counting);
  record(1); record(1); record(2); record(1);
  assert.equal(calls, 2);
  assert.equal(record(null), null);
});
