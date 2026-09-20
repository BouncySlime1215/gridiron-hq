/**
 * The graded rows behind `scripts/grade-cascade-multipliers.mjs`.
 *
 * `contingency.js:cascades()` publishes a claim about every starter: when he
 * sits, each listed teammate's opportunity goes from `base_opportunity` to
 * `opportunity_without`. This module turns that claim into rows that can be
 * scored against a season the split was never fitted on.
 *
 * It lives here rather than in the script for the same reason
 * `opportunity-model.js` does: the construction is the part that can be wrong,
 * and a script cannot be unit tested. `contingency.js` is not touched.
 */

import { rows } from '../db/index.js';

export const CASCADE_GRADE_VERSION = 'cascade-grade-v1.0.0';

/** Opportunity is the same three columns `cascades()` counts, so the two agree by construction. */
export const opportunity = u => (u.targets ?? 0) + (u.carries ?? 0) + (u.attempts ?? 0);

/**
 * One graded season's team-weeks, roster spans and per-player week maps.
 *
 * Absence has to be read from the roster, never from the box score. A player
 * who is ruled out has no row that week, so searching for him among the week's
 * rows finds nobody and the slice comes back empty — the defect that made four
 * earlier attempts at this question in this repository measure an effect of
 * exactly zero. Bounding each span to the player's first and last appearance is
 * the other half: without it every week before he was signed, and every week
 * after he was traded, scores as a game he missed.
 */
export function seasonIndex(season) {
  const log = rows(`SELECT u.player_id, u.week, u.team, u.targets, u.carries, u.attempts,
                           p.name, p.position
                    FROM player_week_usage u JOIN players p ON p.id = u.player_id
                    WHERE u.season = ? AND u.team IS NOT NULL
                      AND p.position IN ('QB','RB','WR','TE')`, season);

  const teamAllWeeks = new Map();   // team -> Set(week)
  const playerWeeks = new Map();    // `${player}|${team}` -> Map(week -> row)
  for (const u of log) {
    (teamAllWeeks.get(u.team) ?? teamAllWeeks.set(u.team, new Set()).get(u.team)).add(u.week);
    const pk = `${u.player_id}|${u.team}`;
    (playerWeeks.get(pk) ?? playerWeeks.set(pk, new Map()).get(pk)).set(u.week, u);
  }
  return { teamAllWeeks, playerWeeks };
}

/**
 * Exponentially weighted mean of the player's opportunity in EARLIER weeks of
 * the graded season. Strictly prior: the graded week's own box score must never
 * reach the number that predicts it.
 */
export function priorUsage(weeksMap, week, { halfLife = 3, minPriorGames = 2 } = {}) {
  let num = 0, den = 0, n = 0;
  for (const [w, u] of weeksMap) {
    if (w >= week) continue;
    const weight = Math.pow(0.5, (week - w) / halfLife);
    num += weight * opportunity(u); den += weight; n++;
  }
  return n >= minPriorGames ? { value: num / den, games: n } : null;
}

/**
 * Score every absence week in `season` against the cascade claims in `cascadeMap`.
 *
 * @param cascadeMap the Map returned by `cascades({ through: season - 1 })`.
 *   Passing a cascade built through `season` or later is leakage and the caller
 *   is responsible for not doing it.
 */
export function buildGradedRows({ season, cascadeMap, halfLife = 3, minPriorGames = 2 }) {
  const { teamAllWeeks, playerWeeks } = seasonIndex(season);
  const graded = [];
  let starters = 0, absences = 0, skippedNoHistory = 0;

  for (const c of cascadeMap.values()) {
    // The starter needs a roster spot in the graded season for an absence to exist.
    let found = null;
    for (const team of teamAllWeeks.keys()) {
      const wk = playerWeeks.get(`${c.player_id}|${team}`);
      if (wk?.size) { found = { team, weeks: wk }; break; }
    }
    if (!found) continue;
    starters++;

    const appearances = [...found.weeks.keys()];
    const first = Math.min(...appearances), last = Math.max(...appearances);

    for (const week of teamAllWeeks.get(found.team) ?? []) {
      if (week < first || week > last) continue;   // not on this roster yet, or already gone
      if (found.weeks.has(week)) continue;         // he played; not an absence
      absences++;

      for (const b of c.beneficiaries) {
        const mateWeeks = playerWeeks.get(`${b.player_id}|${found.team}`);
        const actualRow = mateWeeks?.get(week);
        if (!actualRow) continue;                  // the beneficiary sat too; nothing to grade
        const prior = priorUsage(mateWeeks, week, { halfLife, minPriorGames });
        if (!prior) { skippedNoHistory++; continue; }

        graded.push({
          starter_id: c.player_id, starter: c.name, starter_position: c.position,
          player_id: b.player_id, player: b.name, position: b.position,
          season, week,
          actual: opportunity(actualRow),
          own_recent: prior.value, own_recent_games: prior.games,
          multiplier: b.multiplier,
          published_with: b.base_opportunity,
          published_without: b.opportunity_without
        });
      }
    }
  }
  return { season, starters, absences, skippedNoHistory, graded };
}

export const mae = (xs, pick) => xs.reduce((s, r) => s + Math.abs(pick(r) - r.actual), 0) / xs.length;
export const bias = (xs, pick) => xs.reduce((s, r) => s + (pick(r) - r.actual), 0) / xs.length;

/**
 * Paired bootstrap, resampled by whole beneficiary player.
 *
 * Rows are not independent: one player appears in every week his starter sat,
 * and those errors move together. Resampling rows would shrink the interval to
 * whatever width the row count buys and say nothing true about it.
 */
export function pairedInterval(xs, a, b, { draws = 2000, random = Math.random } = {}) {
  const byPlayer = new Map();
  for (const r of xs) (byPlayer.get(r.player_id) ?? byPlayer.set(r.player_id, []).get(r.player_id)).push(r);
  const clusters = [...byPlayer.values()];
  if (clusters.length < 2) return null;

  const diffs = [];
  for (let d = 0; d < draws; d++) {
    let sumA = 0, sumB = 0, n = 0;
    for (let i = 0; i < clusters.length; i++) {
      for (const r of clusters[(random() * clusters.length) | 0]) {
        sumA += Math.abs(a(r) - r.actual); sumB += Math.abs(b(r) - r.actual); n++;
      }
    }
    if (n) diffs.push(sumA / n - sumB / n);
  }
  diffs.sort((x, y) => x - y);
  return { lo: diffs[Math.floor(0.05 * diffs.length)], hi: diffs[Math.floor(0.95 * diffs.length)] };
}
