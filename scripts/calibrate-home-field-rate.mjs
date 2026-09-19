/**
 * Solve for `HFA_RATE_PER_POINT` in `server/services/nfl-drive-sim.js`.
 *
 * Home-field advantage moved (2026-09-16, FINAL ORDER #2's structural item)
 * from points added to the scoreboard to an efficiency edge applied to the
 * home team's per-play rates. That change is only honest if the knob keeps
 * its units: `homeFieldPoints = 1.6` must still MEAN 1.6 points of expected
 * margin, or every caller that sets it (and every calibration artifact built
 * when it meant points) is silently rescaled.
 *
 * So the constant is measured, not chosen. This runs the simulator twice over
 * the same matchups — once with the home edge off, once on — and reports the
 * mean margin shift each candidate rate produces. The right constant is the
 * one whose shift equals `homeFieldPoints`.
 *
 * Usage:
 *   GRIDIRON_DB_PATH=/tmp/gridiron-extract/real.sqlite SCHEDULER_DISABLED=1 \
 *     node scripts/calibrate-home-field-rate.mjs [--season 2024] [--trials 400] [--games 32]
 *
 * Reads the DB only through the normal simulator entry points; writes nothing.
 */
import { simulateMatchup } from '../server/services/nfl-drive-sim.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const season = Number(arg('--season', '2024'));
const trials = Number(arg('--trials', '400'));
const games = Number(arg('--games', '32'));

// A fixed, arbitrary set of matchups: the point is the DIFFERENCE between
// home-edge-on and home-edge-off over identical pairings, not any one game.
const TEAMS = ['KC', 'BUF', 'PHI', 'SF', 'DAL', 'BAL', 'DET', 'MIA',
  'CIN', 'GB', 'MIN', 'LAC', 'NYJ', 'SEA', 'TB', 'HOU'];

function meanMarginAt(homeFieldPoints) {
  const margins = [];
  let pairs = 0;
  for (let i = 0; i < TEAMS.length && pairs < games; i += 2) {
    const home = TEAMS[i], away = TEAMS[i + 1];
    if (!away) break;
    for (const [h, a] of [[home, away], [away, home]]) {
      if (pairs >= games) break;
      const out = simulateMatchup({ home: h, away: a, season, trials,
        homeFieldPoints, seed: 20260916 });
      if (out?.error) continue;
      const m = out.projection?.margin;
      if (Number.isFinite(m)) { margins.push(m); pairs++; }
    }
  }
  if (!margins.length) return null;
  return margins.reduce((s, v) => s + v, 0) / margins.length;
}

const base = meanMarginAt(0);
if (base == null) {
  console.error(JSON.stringify({ ok: false, reason: 'no simulable matchups — check --season and GRIDIRON_DB_PATH' }));
  process.exit(1);
}

console.log(`baseline mean margin with NO home edge (season ${season}, ${trials} trials): ${base.toFixed(3)}`);
console.log('target: a +1.6 knob should move mean margin by +1.6 points\n');
console.log('homeFieldPoints  meanMargin  shift   implied points per knob-unit');
for (const points of [1.0, 1.6, 2.5]) {
  const m = meanMarginAt(points);
  if (m == null) continue;
  const shift = m - base;
  console.log(`${String(points).padEnd(16)} ${m.toFixed(3).padStart(10)} ${shift.toFixed(3).padStart(7)}   ${(shift / points).toFixed(3)}`);
}
console.log('\nIf "implied points per knob-unit" is not ~1.0, scale HFA_RATE_PER_POINT'
  + ' in nfl-drive-sim.js by (1.0 / implied) and re-run.');
