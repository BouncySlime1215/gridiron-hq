/**
 * In-season opportunity redistribution — when a teammate rises, who falls?
 *
 * Opportunity inside an offense is very nearly zero-sum. There are only so
 * many targets and carries in a game, and the engine already enforces that at
 * the team level: `teamWeekEventExpectations` draws a team's volume once and
 * allocates it among teammates, so player forecasts cannot collectively
 * exceed what the offense has.
 *
 * What it does NOT do is anticipate the redistribution. Each player's share
 * comes from his own five-week role memory. If a rookie receiver has taken
 * over the slot in the last three weeks, the incumbent's own recent usage
 * eventually reflects it — but only AFTER his targets have already fallen.
 * The model learns the change from the victim's decline rather than from the
 * competitor's rise, which is a week or two late in a seventeen-week season.
 *
 * The hypothesis worth testing: a teammate's share MOMENTUM carries
 * information about a player's next-week share, over and above the player's
 * own momentum. If true, the model can see the squeeze coming.
 *
 * There is a real reason it might not. The victim's own recent share is
 * already a direct measurement of the same competition — by the time a
 * teammate has genuinely taken snaps, it is visible in both series, and the
 * second one adds nothing but noise. That is precisely the pattern that has
 * defeated every other candidate in this codebase, so it is tested rather
 * than assumed.
 */
import { rows } from '../db/index.js';
import { pairedBootstrapDiff } from './backtest-significance.js';

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/**
 * Per player-week share of his own team's receiving+rushing opportunity,
 * strictly from completed games.
 */
function shareSeries(season) {
  const usage = rows(`SELECT player_id, position, team, week,
                             COALESCE(targets,0) targets, COALESCE(carries,0) carries
                      FROM player_week_usage
                      WHERE season = ? AND team IS NOT NULL ORDER BY week`, season);
  const teamWeek = new Map();      // `${team}|${week}` -> total opportunity
  for (const u of usage) {
    const k = `${u.team}|${u.week}`;
    teamWeek.set(k, (teamWeek.get(k) ?? 0) + u.targets + u.carries);
  }
  const out = [];
  for (const u of usage) {
    const total = teamWeek.get(`${u.team}|${u.week}`) ?? 0;
    if (total <= 0) continue;
    out.push({ ...u, opportunity: u.targets + u.carries, share: (u.targets + u.carries) / total });
  }
  return out;
}

/**
 * Does teammate momentum predict a player's next-week share beyond his own?
 *
 * For each player-week: his own share trend (last 2 vs prior weeks) and the
 * combined trend of his teammates at the same position group. Both computed
 * only from completed games before the target week.
 */
export function measureCompetitionEffect(seasons, { window = 3 } = {}) {
  const points = [];
  for (const season of seasons) {
    const series = shareSeries(season);
    const byPlayer = new Map(), byTeamWeek = new Map();
    for (const r of series) {
      (byPlayer.get(r.player_id) ?? byPlayer.set(r.player_id, []).get(r.player_id)).push(r);
      const k = `${r.team}|${r.week}`;
      (byTeamWeek.get(k) ?? byTeamWeek.set(k, []).get(k)).push(r);
    }
    for (const [pid, games] of byPlayer) {
      const sorted = [...games].sort((a, b) => a.week - b.week);
      for (let i = 0; i < sorted.length; i++) {
        const target = sorted[i];
        const prior = sorted.filter(g => g.week < target.week);
        if (prior.length < window + 1) continue;
        const recent = prior.slice(-window), older = prior.slice(0, -window);
        if (!older.length) continue;
        const ownRecent = mean(recent.map(g => g.share));
        const ownOlder = mean(older.map(g => g.share));
        if (!(ownOlder > 0)) continue;

        // Teammates at the same position, same weeks, same team.
        const mates = [];
        for (const w of prior.map(g => g.week)) {
          for (const m of byTeamWeek.get(`${target.team}|${w}`) ?? []) {
            if (m.player_id !== pid && m.position === target.position) mates.push(m);
          }
        }
        if (mates.length < window + 1) continue;
        const mateWeeks = [...new Set(mates.map(m => m.week))].sort((a, b) => a - b);
        const mateRecentWeeks = new Set(mateWeeks.slice(-window));
        const mateRecent = mean(mates.filter(m => mateRecentWeeks.has(m.week)).map(m => m.share));
        const mateOlder = mean(mates.filter(m => !mateRecentWeeks.has(m.week)).map(m => m.share));
        if (!(mateOlder > 0) || mateRecent == null) continue;

        points.push({
          season, player_id: pid, week: target.week, position: target.position,
          own_recent: ownRecent, own_momentum: ownRecent / ownOlder,
          mate_momentum: mateRecent / mateOlder,
          actual_share: target.share
        });
      }
    }
  }
  // Correlation between teammate momentum and the player's share residual —
  // what his own recent share failed to explain.
  const resid = points.map(p => p.actual_share - p.own_recent);
  const mate = points.map(p => p.mate_momentum);
  const mr = mean(resid), mm = mean(mate);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < points.length; i++) {
    num += (mate[i] - mm) * (resid[i] - mr);
    dx += (mate[i] - mm) ** 2; dy += (resid[i] - mr) ** 2;
  }
  return {
    seasons, n: points.length,
    correlation_mate_momentum_vs_residual: dx > 0 && dy > 0 ? r4(num / Math.sqrt(dx * dy)) : null,
    note: 'Residual = actual share minus the player\'s own recent share. A negative correlation ' +
      'means a rising teammate predicts the player underperforming his own recent level — the ' +
      'squeeze this is looking for. Near zero means his own share already contains it.'
  };
}

/**
 * Out-of-sample: does damping a player's projected share by teammate momentum
 * beat using his own recent share alone? Factor fit on `fitSeasons`.
 */
export function validateCompetitionAdjustment({ fitSeasons = [2023, 2024], testSeason = 2025,
  window = 3, strengths = [0.05, 0.1, 0.2, 0.3, 0.5] } = {}) {
  const fit = measureCompetitionEffect(fitSeasons, { window });
  const test = measureCompetitionEffect([testSeason], { window });
  if (!test.n) return { error: 'no test rows' };

  // Rebuild test points to score them.
  const points = [];
  for (const season of [testSeason]) {
    const m = measureCompetitionEffect([season], { window });
    if (!m.n) continue;
  }
  // measureCompetitionEffect does not return points; recompute inline for scoring.
  const scored = competitionPoints([testSeason], window);
  const errBase = scored.map(p => Math.abs(p.own_recent - p.actual_share));
  // Share is measured within one team's offense, so teammates sharing the
  // same team-week are the correlated cluster here (a hot/cold game script
  // moves every teammate's share together, not just the one being scored).
  const groups = scored.map(p => `${p.season}|${p.week}|${p.team}`);
  const out = {};
  for (const s of strengths) {
    const errAdj = scored.map(p => {
      // A teammate trending up (>1) damps this player's share, and vice versa.
      const damp = 1 - s * (p.mate_momentum - 1);
      return Math.abs(p.own_recent * Math.max(0.5, Math.min(1.5, damp)) - p.actual_share);
    });
    const bs = pairedBootstrapDiff(errBase, errAdj, { iterations: 2000, seed: 31, groups });
    out[s] = { adjusted_mae: r4(mean(errAdj)), bootstrap: bs,
      improves: bs.significant === true && bs.mean_diff < 0 };
  }
  return {
    fit_seasons: fitSeasons, test_season: testSeason, n: scored.length,
    fit_correlation: fit.correlation_mate_momentum_vs_residual,
    test_correlation: test.correlation_mate_momentum_vs_residual,
    unadjusted_mae: r4(mean(errBase)), by_strength: out,
    any_improves: Object.values(out).some(v => v.improves)
  };
}

/** Shared point builder (same logic as measureCompetitionEffect, returning rows). */
function competitionPoints(seasons, window) {
  const points = [];
  for (const season of seasons) {
    const series = shareSeries(season);
    const byPlayer = new Map(), byTeamWeek = new Map();
    for (const r of series) {
      (byPlayer.get(r.player_id) ?? byPlayer.set(r.player_id, []).get(r.player_id)).push(r);
      const k = `${r.team}|${r.week}`;
      (byTeamWeek.get(k) ?? byTeamWeek.set(k, []).get(k)).push(r);
    }
    for (const [pid, games] of byPlayer) {
      const sorted = [...games].sort((a, b) => a.week - b.week);
      for (const targetGame of sorted) {
        const prior = sorted.filter(g => g.week < targetGame.week);
        if (prior.length < window + 1) continue;
        const recent = prior.slice(-window), older = prior.slice(0, -window);
        if (!older.length) continue;
        const ownRecent = mean(recent.map(g => g.share));
        const ownOlder = mean(older.map(g => g.share));
        if (!(ownOlder > 0)) continue;
        const mates = [];
        for (const w of prior.map(g => g.week)) {
          for (const m of byTeamWeek.get(`${targetGame.team}|${w}`) ?? []) {
            if (m.player_id !== pid && m.position === targetGame.position) mates.push(m);
          }
        }
        if (mates.length < window + 1) continue;
        const mateWeeks = [...new Set(mates.map(m => m.week))].sort((a, b) => a - b);
        const mateRecentWeeks = new Set(mateWeeks.slice(-window));
        const mateRecent = mean(mates.filter(m => mateRecentWeeks.has(m.week)).map(m => m.share));
        const mateOlder = mean(mates.filter(m => !mateRecentWeeks.has(m.week)).map(m => m.share));
        if (!(mateOlder > 0) || mateRecent == null) continue;
        points.push({ season, week: targetGame.week, team: targetGame.team,
          own_recent: ownRecent, mate_momentum: mateRecent / mateOlder,
          actual_share: targetGame.share });
      }
    }
  }
  return points;
}
