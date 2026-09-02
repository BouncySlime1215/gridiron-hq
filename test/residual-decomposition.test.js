import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The postgame read separates what the pregame read could not foresee
// (returns, short fields, missed kicks, garbage time) from the model's share.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-variance-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { residualDecomposition } = await import('../server/services/nfl-postgame-truth.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

let seq = 0;
const play = (offense, defense, { period = 1, home, away, type = 'rush', turnover = 0, scoring = 0, text = '' }) =>
  ({ sequence: ++seq * 100, period, clock_seconds: 900, offense, defense, play_type: type, is_turnover: turnover, is_scoring: scoring, home_score: home, away_score: away, text });

test('returns, short fields, missed kicks and garbage time are variance; ordinary drives are the model share', () => {
  const H = 'KC', A = 'DEN';
  const plays = [
    // KC ordinary touchdown drive: model share.
    play(H, A, { home: 0, away: 0 }), play(H, A, { home: 7, away: 0, scoring: 1, text: 'P.Mahomes pass to T.Kelce for 12 yards, TOUCHDOWN.' }),
    // DEN throws a pick-six: non-offensive score for KC (+7 to home).
    play(A, H, { home: 7, away: 0 }), play(A, H, { home: 14, away: 0, type: 'interception', turnover: 1, scoring: 1, text: 'B.Nix pass INTERCEPTED by T.McDuffie, returned 40 yards, TOUCHDOWN.' }),
    // DEN fumbles; KC scores a field goal on the short field (+3 home, variance).
    play(A, H, { home: 14, away: 0 }), play(A, H, { home: 14, away: 0, type: 'fumble', turnover: 1, text: 'J.Williams FUMBLES, recovered by KC.' }),
    play(H, A, { home: 14, away: 0 }), play(H, A, { home: 17, away: 0, type: 'fg_make', scoring: 1, text: 'H.Butker 33 yard field goal is GOOD.' }),
    // DEN misses a field goal: 3 points of variance against DEN (+3 home-perspective).
    play(A, H, { home: 17, away: 0 }), play(A, H, { home: 17, away: 0, type: 'fg_miss', text: 'W.Lutz 48 yard field goal is No Good.' }),
    // DEN ordinary touchdown: model share (-7).
    play(A, H, { period: 2, home: 17, away: 0 }), play(A, H, { period: 2, home: 17, away: 7, scoring: 1, text: 'B.Nix pass to C.Sutton for 8 yards, TOUCHDOWN.' }),
    // KC ordinary field goal (+3 model share), then garbage time: DEN scores down 20 in the fourth.
    play(H, A, { period: 3, home: 17, away: 7 }), play(H, A, { period: 3, home: 27, away: 7, scoring: 1, text: 'P.Mahomes pass to X.Worthy, TOUCHDOWN.' }),
    play(A, H, { period: 4, home: 27, away: 7 }), play(A, H, { period: 4, home: 27, away: 14, scoring: 1, text: 'B.Nix pass to M.Mims for 30 yards, TOUCHDOWN.' })
  ];
  const d = residualDecomposition(plays, H, A, { marketMargin: 3 });
  assert.equal(d.actual_margin, 13);
  assert.equal(d.raw_residual, 10);
  // Variance: pick-six +7, short field +3, missed kick +3, garbage time -7 => +6 home-perspective.
  assert.equal(d.counts.non_offensive_score, 1);
  assert.equal(d.counts.short_field_after_turnover, 1);
  assert.equal(d.counts.missed_or_blocked_kick, 1);
  assert.equal(d.counts.garbage_time, 1);
  assert.equal(d.variance_points, 6);
  assert.equal(d.model_points, 7, 'the 13-point margin minus 6 points of variance');
  assert.equal(d.adjusted_residual, 4, 'raw residual 10 minus 6 points of variance');
});

test('a clean game has zero variance and identical residuals', () => {
  const plays = [play('KC', 'DEN', { home: 0, away: 0 }), play('KC', 'DEN', { home: 7, away: 0, scoring: 1, text: 'TOUCHDOWN.' }),
    play('DEN', 'KC', { home: 7, away: 0 }), play('DEN', 'KC', { home: 7, away: 3, type: 'fg_make', scoring: 1, text: 'field goal is GOOD.' })];
  const d = residualDecomposition(plays, 'KC', 'DEN', { marketMargin: -1 });
  assert.equal(d.variance_points, 0);
  assert.equal(d.raw_residual, d.adjusted_residual);
  assert.equal(d.adjusted_residual, 5);
});
