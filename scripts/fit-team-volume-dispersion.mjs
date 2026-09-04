#!/usr/bin/env node
/**
 * Props audit finding — team-level opportunity dispersion was hand-picked.
 *
 * `sampleTeamWeekEvents` (player-week-engine.js) draws a team's weekly pass
 * attempts and rush carries from a negative binomial, `randNegBinomial(mean,
 * dispersion)`, with `dispersion` hardcoded to 12 for both. That number
 * matches nothing measured — it looks like a copy of the *player*-level
 * dispersion fallback in projections.js (also 12, but that one IS a fallback
 * for a per-player method-of-moments fit; the team-level draw never fits
 * anything).
 *
 * This computes what the same method-of-moments estimator
 * (dispersion = mean^2 / (var - mean), the exact formula projections.js
 * already uses per player) gives for a TEAM's own week-to-week pass attempts
 * and rush carries, pooling real team-seasons from `player_week_usage`
 * (summed to team-week totals, the same rows `teamVolume()` aggregates).
 *
 * Usage: node scripts/fit-team-volume-dispersion.mjs
 */
import { rows } from '../server/db/index.js';

const byTeamWeek = new Map();
for (const u of rows(`SELECT season, week, team, attempts, carries FROM player_week_usage WHERE team IS NOT NULL`)) {
  const k = `${u.team}|${u.season}|${u.week}`;
  const t = byTeamWeek.get(k) ?? { season: u.season, team: u.team, week: u.week, att: 0, car: 0 };
  t.att += u.attempts ?? 0;
  t.car += u.carries ?? 0;
  byTeamWeek.set(k, t);
}

const byTeamSeason = new Map();
for (const t of byTeamWeek.values()) {
  const k = `${t.team}|${t.season}`;
  (byTeamSeason.get(k) ?? byTeamSeason.set(k, []).get(k)).push(t);
}

// Same shape as projections.js:453 — mean^2/(var-mean) per group, but the
// group here is "one team's own weeks in one season" instead of "one
// player's own weeks." Weeks below the floor are bye/injury-shortened
// weeks (a role change, not sampling noise around a stable mean) and are
// dropped exactly the way a near-zero-attempt week would be for a player.
function momDispersion(values, floor) {
  const v = values.filter(x => x >= floor);
  if (v.length < 6) return null;
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const variance = v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length;
  if (!(variance > mean) || mean <= 0) return null;
  return { n: v.length, mean, variance, dispersion: (mean ** 2) / (variance - mean) };
}

function summarize(label, field, floor) {
  const fits = [];
  for (const [, weeks] of byTeamSeason) fits.push(momDispersion(weeks.map(w => w[field]), floor));
  const valid = fits.filter(Boolean);
  const disps = valid.map(f => f.dispersion).sort((a, b) => a - b);
  const median = disps[Math.floor(disps.length / 2)];
  // Pooled: average the per-team-season mean/variance (weighted by weeks),
  // then apply the same formula once — this is the number actually used as
  // the fitted constant, since a single team-season is too thin to trust on
  // its own (the codebase's existing per-player fit faces the same problem
  // and is clamped for the same reason).
  const totalW = valid.reduce((s, f) => s + f.n, 0);
  const pooledMean = valid.reduce((s, f) => s + f.n * f.mean, 0) / totalW;
  const pooledVar = valid.reduce((s, f) => s + f.n * f.variance, 0) / totalW;
  const pooledDispersion = (pooledMean ** 2) / (pooledVar - pooledMean);
  console.log(`\n${label}`);
  console.log(`  team-seasons with a valid fit: ${valid.length}`);
  console.log(`  median per-team-season dispersion: ${median.toFixed(1)}`);
  console.log(`  pooled mean=${pooledMean.toFixed(1)} var=${pooledVar.toFixed(1)} -> pooled dispersion=${pooledDispersion.toFixed(1)}`);
  console.log(`  hardcoded value in sampleTeamWeekEvents today: 12`);
  console.log(`  implied variance at that mean under k=12 vs pooled fit: ` +
    `${(pooledMean + pooledMean ** 2 / 12).toFixed(1)} vs ${pooledVar.toFixed(1)} ` +
    `(${((pooledMean + pooledMean ** 2 / 12) / pooledVar).toFixed(2)}x real)`);
  return pooledDispersion;
}

const passDispersion = summarize('Team pass attempts', 'att', 15);
const rushDispersion = summarize('Team rush carries', 'car', 10);

console.log(`\nRecommended constants: TEAM_PASS_ATTEMPT_DISPERSION=${Math.round(passDispersion)}, ` +
  `TEAM_RUSH_CARRY_DISPERSION=${Math.round(rushDispersion)}`);
