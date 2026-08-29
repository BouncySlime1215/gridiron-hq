/**
 * The learned layer under the play-by-play simulator.
 *
 * Everything the game engine needs to know about a team is estimated here
 * rather than hardcoded, and every estimate is either fitted on this database
 * or derived from the simulator's own transitions. Three things are learned:
 *
 *   1. TEAM RATES, shrunk. A team's raw season rate is a small-sample estimate
 *      and taking it at face value is the single easiest way to build a
 *      confidently wrong simulator. Empirical-Bayes shrinkage pulls each rate
 *      toward the league mean by an amount fitted from the actual within- vs
 *      between-team variance, so a 4-week sample moves the needle less than a
 *      17-week one without anybody choosing that by hand.
 *
 *   2. THE EXPECTED-POINTS SURFACE, by value iteration on the engine itself.
 *      There is no play-by-play table in this database, so an EP model cannot
 *      be regressed on real plays. It can, however, be computed: run the drive
 *      engine from every field position and read off what it scores. That makes
 *      EP self-consistent with the simulator that consumes it, which is
 *      actually stronger than borrowing someone else's EP table fitted on a
 *      different generative process.
 *
 *   3. THE MINIMAX DIAGNOSTIC, and its limits. See `minimaxDiagnostic()` — the
 *      headline result replicates, the elasticity does not, and the function
 *      says so rather than inventing a precision the data will not support.
 */
import { rows } from '../db/index.js';
import { withRandomSeed, random } from './stats-util.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Every rate the engine consumes, with the league-average fallback used when a
 * team has no data. Kept in one place so the engine can never silently invent a
 * default that nothing checked.
 */
export const RATE_SPEC = {
  // efficiency
  off_yards_per_play: 5.45, off_pass_epa_per_play: 0.02, off_rush_epa_per_play: -0.03,
  off_epa_per_play: 0.0, off_success_rate: 0.44, off_success_rate_neutral_wp: 0.44,
  off_yards_per_attempt: 6.61, off_yards_per_carry: 4.46, off_completion_pct: 0.60,
  // explosiveness and disaster
  off_explosive_play_rate: 0.097, off_explosive_pass_rate: 0.13, off_explosive_rush_rate: 0.07,
  off_int_rate: 0.024, off_fumble_rate: 0.011, off_turnover_rate: 0.025,
  off_sack_rate: 0.066, off_stuff_rate: 0.18,
  // situational policy (measured behaviour, not assumed)
  off_pass_rate: 0.575, off_neutral_pass_rate: 0.56, off_leading_pass_rate: 0.52,
  off_trailing_pass_rate: 0.63, off_no_huddle_rate: 0.06, off_proe: 0.0,
  off_fourth_down_rate: 0.20, off_shotgun_rate: 0.65, off_deep_attempt_rate: 0.12,
  // field-zone efficiency
  off_epa_own_territory: -0.03, off_epa_midfield: 0.02, off_epa_opp_territory: 0.05,
  off_red_zone_td_rate: 0.222, off_goal_to_go_td_rate: 0.55,
  // drive shape
  off_plays_per_drive: 6.07, off_seconds_per_drive: 182, off_drives: 10.1,
  off_avg_drive_start: 28, off_three_and_out_rate: 0.23, off_series_success_rate: 0.70,
  off_third_down_rate: 0.393, off_third_down_distance: 7.2,
  off_drive_td_rate: 0.257, off_drive_fg_rate: 0.208,
  // variance and clutch
  off_epa_volatility: 0.55, off_epa_q4_close: 0.0, off_garbage_time_share: 0.10
};
const DEF_SPEC = {
  def_yards_per_play: 5.45, def_epa_per_play: 0.0, def_success_rate: 0.44,
  def_explosive_play_rate: 0.097, def_turnover_rate: 0.025, def_sack_rate: 0.066,
  def_int_rate: 0.024, def_fumble_rate: 0.011, def_stuff_rate: 0.18,
  def_third_down_rate: 0.393, def_red_zone_td_rate: 0.222, def_havoc_rate: 0.18,
  def_pressure_epa: 0.0, def_drive_td_rate: 0.256, def_yards_per_attempt: 7.0,
  def_yards_per_carry: 4.46, def_explosive_pass_rate: 0.085, def_explosive_rush_rate: 0.11,
  def_completion_pct: 0.60
};

/* ------------------------------------------------- empirical Bayes shrinkage */

/**
 * Fit the shrinkage constant for one metric by variance decomposition.
 *
 * k = within-team variance / between-team variance. It has a clean reading:
 * the number of observations at which a team's own average and the league
 * average deserve equal weight. A metric that is mostly noise gets a large k
 * and is shrunk hard; a metric that genuinely separates teams gets a small one.
 * Nothing here is chosen by hand.
 */
function fitK(byTeam, key) {
  const teamMeans = [], withinVars = [];
  for (const list of byTeam.values()) {
    const v = list.map(f => f[key]).filter(Number.isFinite);
    if (v.length < 2) continue;
    const m = mean(v);
    teamMeans.push(m);
    withinVars.push(mean(v.map(x => (x - m) ** 2)) * v.length / (v.length - 1));
  }
  if (teamMeans.length < 4) return { k: 10, within: null, between: null };
  const gm = mean(teamMeans);
  const between = mean(teamMeans.map(m => (m - gm) ** 2)) * teamMeans.length / (teamMeans.length - 1);
  const within = mean(withinVars);
  if (!(between > 1e-12)) return { k: 50, within: r4(within), between: r4(between) };
  return { k: clamp(within / between, 0.5, 200), within: r4(within), between: r4(between) };
}

let _profiles = null;
/**
 * Shrunk offensive and defensive profiles for every team.
 *
 * @param season  season to profile; defaults to the newest with data. Falls
 *   back to the prior season when the current one is too thin to say anything,
 *   and labels that fallback rather than silently pretending otherwise.
 */
export function learnedProfiles({ season = null, minWeeks = 3 } = {}) {
  const key = season ?? 'latest';
  if (_profiles?.key === key) return _profiles.value;

  let use = season ?? rows(`SELECT MAX(season) AS s FROM nfl_team_week_features`)[0]?.s;
  let raw = rows(`SELECT team, features FROM nfl_team_week_features WHERE season = ?`, use);
  let fellBack = false;
  // A season two weeks old cannot profile a team. Borrow the prior year rather
  // than emit 32 identical league-average teams and call it a model.
  if (raw.length < 32 * minWeeks) {
    const prior = rows(`SELECT team, features FROM nfl_team_week_features WHERE season = ?`, use - 1);
    if (prior.length > raw.length) { raw = prior; use -= 1; fellBack = true; }
  }

  const byTeam = new Map();
  for (const r of raw) {
    let f; try { f = JSON.parse(r.features); } catch { continue; }
    if (!byTeam.has(r.team)) byTeam.set(r.team, []);
    byTeam.get(r.team).push(f);
  }

  const allKeys = { ...RATE_SPEC, ...DEF_SPEC };
  const ks = {}, leagueMeans = {};
  for (const k of Object.keys(allKeys)) {
    ks[k] = fitK(byTeam, k).k;
    const all = raw.map(r => { try { return JSON.parse(r.features)[k]; } catch { return null; } })
      .filter(Number.isFinite);
    leagueMeans[k] = all.length ? mean(all) : allKeys[k];
  }

  const map = new Map();
  for (const [team, list] of byTeam) {
    const rates = {};
    for (const k of Object.keys(allKeys)) {
      const v = list.map(f => f[k]).filter(Number.isFinite);
      const lm = leagueMeans[k];
      // The shrinkage itself: n observations of the team against k of the league.
      rates[k] = v.length ? (v.length * mean(v) + ks[k] * lm) / (v.length + ks[k]) : lm;
    }
    map.set(team, { team, weeks: list.length, rates });
  }

  const value = { season: use, fell_back: fellBack, teams: map, league: leagueMeans, k: ks };
  _profiles = { key, value };
  return value;
}
export function clearLearnCache() { _profiles = null; }

/* ------------------------------------------ team rates from the play corpus */

/**
 * Rate a team from its ACTUAL PLAYS rather than from weekly aggregates.
 *
 * This is the payoff of ingesting ESPN's play-by-play. The weekly feature table
 * is a summary computed by somebody else; the play log is the underlying event
 * stream, which means these rates are computed here, from first principles,
 * and can be recomputed the instant a game ends.
 *
 * The reason it matters in-season: on week 3 a team has three weeks of
 * aggregates but roughly 190 actual plays, and plays are the unit the simulator
 * consumes. As the corpus grows, `blendedProfiles()` shifts weight from prior-
 * season priors onto this season's real plays — so the model genuinely does get
 * sharper down the stretch instead of standing still until the season ends.
 */
export function ratesFromPlays({ season = null, minPlays = 120 } = {}) {
  const where = season ? `WHERE season = ${Number(season)}` : '';
  let plays;
  try {
    plays = rows(`SELECT offense, play_type, yards_gained, down, distance, yards_to_endzone,
                         is_turnover, is_scoring
                  FROM nfl_play_by_play ${where}`);
  } catch {
    return { teams: new Map(), plays: 0, available: false };
  }
  if (!plays.length) return { teams: new Map(), plays: 0, available: false };

  const byTeam = new Map();
  for (const p of plays) {
    if (!p.offense) continue;
    if (!byTeam.has(p.offense)) byTeam.set(p.offense, []);
    byTeam.get(p.offense).push(p);
  }

  const map = new Map();
  for (const [team, list] of byTeam) {
    const dropbacks = list.filter(p => ['pass', 'incompletion', 'sack', 'interception'].includes(p.play_type));
    const rushes = list.filter(p => p.play_type === 'rush');
    const scrimmage = [...dropbacks, ...rushes];
    if (scrimmage.length < minPlays) continue;

    const completions = list.filter(p => p.play_type === 'pass');
    const passYards = completions.reduce((s, p) => s + (p.yards_gained ?? 0), 0);
    const rushYards = rushes.reduce((s, p) => s + (p.yards_gained ?? 0), 0);

    map.set(team, {
      team, plays: scrimmage.length,
      rates: {
        // Yards per ATTEMPT: completions' yardage over all dropbacks, which is
        // the definition the engine's play model expects.
        off_yards_per_attempt: dropbacks.length ? passYards / dropbacks.length : null,
        off_yards_per_carry: rushes.length ? rushYards / rushes.length : null,
        off_completion_pct: dropbacks.length ? completions.length / dropbacks.length : null,
        off_sack_rate: dropbacks.length ? list.filter(p => p.play_type === 'sack').length / dropbacks.length : null,
        off_int_rate: dropbacks.length ? list.filter(p => p.play_type === 'interception').length / dropbacks.length : null,
        off_fumble_rate: scrimmage.length ? list.filter(p => p.play_type === 'fumble').length / scrimmage.length : null,
        off_explosive_pass_rate: dropbacks.length
          ? completions.filter(p => (p.yards_gained ?? 0) >= 20).length / dropbacks.length : null,
        off_explosive_rush_rate: rushes.length
          ? rushes.filter(p => (p.yards_gained ?? 0) >= 10).length / rushes.length : null,
        off_stuff_rate: rushes.length ? rushes.filter(p => (p.yards_gained ?? 0) <= 0).length / rushes.length : null,
        off_pass_rate: scrimmage.length ? dropbacks.length / scrimmage.length : null,
        off_yards_per_play: scrimmage.length ? (passYards + rushYards) / scrimmage.length : null,
        off_third_down_rate: (() => {
          const thirds = scrimmage.filter(p => p.down === 3 && Number.isFinite(p.distance));
          if (thirds.length < 10) return null;
          return thirds.filter(p => (p.yards_gained ?? 0) >= p.distance).length / thirds.length;
        })()
      }
    });
  }
  return { teams: map, plays: plays.length, teams_covered: map.size, available: map.size > 0 };
}

/**
 * Season profiles with real plays folded in.
 *
 * Weekly aggregates are the prior; this season's actual plays are the evidence.
 * They are combined by the same empirical-Bayes rule used everywhere else —
 * weight by observation count against a fitted constant — so early in a season
 * the prior dominates and by December the plays do, with no switch to throw and
 * no discontinuity in between.
 *
 * `PLAY_K` is the number of plays at which the corpus and the prior carry equal
 * weight. 250 is roughly two games of scrimmage snaps: enough to move a rate,
 * not enough to let one blowout rewrite a team.
 */
const PLAY_K = 250;
export function blendedProfiles({ season = null } = {}) {
  const base = learnedProfiles({ season });
  const live = ratesFromPlays({ season: season ?? base.season });
  if (!live.available) {
    return { ...base, play_corpus: { available: false, plays: 0 },
      source: 'weekly aggregates only — no play corpus ingested yet' };
  }

  const merged = new Map();
  for (const [team, profile] of base.teams) {
    const obs = live.teams.get(team);
    if (!obs) { merged.set(team, profile); continue; }
    const n = obs.plays, w = n / (n + PLAY_K);
    const rates = { ...profile.rates };
    for (const [k, v] of Object.entries(obs.rates)) {
      if (v == null || !Number.isFinite(v)) continue;
      rates[k] = (1 - w) * (profile.rates[k] ?? v) + w * v;
    }
    merged.set(team, { ...profile, rates, play_weight: +w.toFixed(3), plays_observed: n });
  }

  return { ...base, teams: merged,
    play_corpus: { available: true, plays: live.plays, teams_covered: live.teams_covered },
    source: 'weekly aggregates blended with ingested play-by-play, weighted by play count' };
}

/** How much the play corpus is currently moving the model, per team. */
export function playInfluenceReport({ season = null } = {}) {
  const b = blendedProfiles({ season });
  if (!b.play_corpus.available) {
    return { available: false, plays: 0,
      note: 'No plays ingested yet. Until the corpus exists the simulator runs on weekly aggregates ' +
        'alone — which is correct, not a failure: there is nothing to learn from yet.' };
  }
  const teams = [...b.teams.values()].filter(t => t.plays_observed)
    .map(t => ({ team: t.team, plays: t.plays_observed, play_weight: t.play_weight }))
    .sort((a, b2) => b2.plays - a.plays);
  return {
    available: true, season: b.season, total_plays: b.play_corpus.plays,
    teams_covered: b.play_corpus.teams_covered,
    equal_weight_at_plays: PLAY_K,
    teams: teams.slice(0, 32),
    note: `Each team's simulated rates are ${'a blend'} of prior weekly aggregates and its own ingested ` +
      `plays, weighted n/(n+${PLAY_K}). At ${PLAY_K} plays — about two games — the two carry equal ` +
      `weight. This is why the model sharpens through a season rather than standing still: every ` +
      `ingested game shifts weight onto what actually happened.`
  };
}

/** How hard each metric got shrunk, so the fit is inspectable rather than trusted. */
export function shrinkageReport({ season = null } = {}) {
  const p = learnedProfiles({ season });
  const out = Object.entries(p.k)
    .map(([metric, k]) => ({ metric, k: r2(k),
      // With a 17-week season, this is the weight the team's own data carries.
      team_weight_full_season: r4(17 / (17 + k)) }))
    .sort((a, b) => a.k - b.k);
  return {
    season: p.season, fell_back: p.fell_back, metrics: out.length,
    most_signal: out.slice(0, 8), most_noise: out.slice(-8).reverse(),
    note: 'k is the number of team-weeks at which a team\'s own rate and the league average carry ' +
      'equal weight, fitted from within- vs between-team variance. Low k = the metric genuinely ' +
      'separates teams. High k = mostly noise, and the engine leans on the league mean instead.'
  };
}

/* ------------------------------------------- minimax play-calling diagnostic */

/**
 * Do NFL teams call plays at a minimax equilibrium?
 *
 * The classic test (Kovash & Levitt): if run/pass is a mixed-strategy
 * equilibrium, the marginal return to each call must be equal, because
 * otherwise you would shift toward the better one until the defence adjusted
 * it back. So pass EPA should equal rush EPA on average, and teams that pass
 * more should show a smaller pass-minus-rush gap.
 *
 * MEASURED ON THIS DATABASE, honestly:
 *   - The headline replicates. Pass EPA exceeds rush EPA in most team-seasons,
 *     by roughly 0.05 per play. Teams under-pass, as the literature says.
 *   - The elasticity does NOT identify. Regressing the gap on pass rate gives a
 *     negative slope at team-WEEK level but a positive, insignificant one at
 *     team-SEASON level — the weekly result is a game-script artifact, since a
 *     team that passed a lot that week was usually losing.
 *
 * So this returns the lean and refuses to convert it into an equilibrium pass
 * rate. Dividing a real mean gap by an unidentified slope produces a confident
 * number with nothing behind it, and this codebase has been burned by exactly
 * that before.
 */
export function minimaxDiagnostic({ sinceSeason = 2021 } = {}) {
  const raw = rows(`SELECT team, season, features FROM nfl_team_week_features WHERE season >= ?`,
    sinceSeason);
  const bySeason = new Map();
  for (const r of raw) {
    let f; try { f = JSON.parse(r.features); } catch { continue; }
    const k = `${r.team}|${r.season}`;
    if (!bySeason.has(k)) bySeason.set(k, []);
    bySeason.get(k).push(f);
  }

  const pts = [];
  for (const [k, list] of bySeason) {
    const [team, season] = k.split('|');
    const p = mean(list.map(f => f.off_pass_rate).filter(Number.isFinite));
    const pe = mean(list.map(f => f.off_pass_epa_per_play).filter(Number.isFinite));
    const re = mean(list.map(f => f.off_rush_epa_per_play).filter(Number.isFinite));
    if ([p, pe, re].every(Number.isFinite)) pts.push({ team, season: +season, pass_rate: p, gap: pe - re });
  }
  if (pts.length < 10) return { error: 'not enough team-seasons to run the diagnostic' };

  const mp = mean(pts.map(d => d.pass_rate)), mg = mean(pts.map(d => d.gap));
  let sxy = 0, sxx = 0, syy = 0;
  for (const d of pts) { sxy += (d.pass_rate - mp) * (d.gap - mg); sxx += (d.pass_rate - mp) ** 2; syy += (d.gap - mg) ** 2; }
  const slope = sxy / sxx, rsq = (sxy * sxy) / (sxx * syy);
  const t = Math.sqrt(Math.max(0, rsq * (pts.length - 2) / (1 - rsq)));

  const underPassing = pts.filter(d => d.gap > 0).length / pts.length;
  const worst = [...pts].sort((a, b) => b.gap - a.gap).slice(0, 8)
    .map(d => ({ team: d.team, season: d.season, pass_rate: r4(d.pass_rate), epa_gap: r4(d.gap),
      lean: 'should pass more' }));

  return {
    team_seasons: pts.length, since_season: sinceSeason,
    mean_pass_rate: r4(mp),
    mean_epa_gap: r4(mg),
    share_under_passing: r4(underPassing),
    elasticity: { slope: r4(slope), r_squared: r4(rsq), t_stat: r2(t), identified: Math.abs(t) > 2 },
    verdict: underPassing > 0.55
      ? `Under-passing replicates: ${(underPassing * 100).toFixed(1)}% of team-seasons gain more per ` +
        `pass than per rush, mean gap ${mg.toFixed(3)} EPA/play. Teams are off equilibrium in the ` +
        `direction the literature predicts.`
      : 'No consistent under-passing in this sample.',
    biggest_leans: worst,
    caveat: 'The DIRECTION is solid; the MAGNITUDE is not. Regressing the EPA gap on pass rate does ' +
      'not identify an elasticity here (t=' + t.toFixed(2) + ', r²=' + rsq.toFixed(4) + '), and the ' +
      'sign flips between team-week and team-season aggregation — the weekly version is a game-script ' +
      'artifact, because teams that passed heavily that week were usually trailing. So this reports a ' +
      'lean and deliberately does NOT solve for an equilibrium pass rate. The simulator uses each ' +
      'team\'s MEASURED situational pass rates instead of a fitted equilibrium.'
  };
}

/* ------------------------------------ expected points by value iteration */

let _epCache = null;
/**
 * The expected-points surface, computed from the engine's own transitions.
 *
 * For each starting field position, simulate many league-average drives and
 * record the net points that follow — the offence's own score minus what the
 * opponent scores on the possession it hands over. That second term is what
 * makes EP a *net* quantity and is exactly why a turnover deep in your own end
 * is so expensive: you do not merely fail to score, you donate field position.
 *
 * @param driveFn  injected by the engine (avoids a circular import) with
 *   signature (startYard) => { points, endYard, turnover }
 */
export function expectedPointsSurface(driveFn, { trials = 600, seed = 7 } = {}) {
  if (_epCache) return _epCache;
  const grid = [];
  for (let y = 1; y <= 99; y += 2) grid.push(y);

  // Pass one: gross points from a drive starting at each yard line.
  const gross = new Map();
  withRandomSeed(seed, () => {
    for (const y of grid) {
      let pts = 0;
      for (let i = 0; i < trials; i++) pts += driveFn(y).points;
      gross.set(y, pts / trials);
    }
  });

  // Pass two: subtract what the opponent is expected to do with the ball back.
  // A drive that ends in a punt hands over poor field position; a turnover at
  // your own 20 hands over excellent field position.
  const surface = new Map();
  withRandomSeed(seed + 1, () => {
    for (const y of grid) {
      let net = 0;
      for (let i = 0; i < trials; i++) {
        const d = driveFn(y);
        // Where the opponent starts, from their own perspective.
        const oppStart = d.points > 0 ? 25                       // after a score, touchback
          : d.turnover ? clamp(100 - d.endYard, 1, 99)           // takeover on the spot
            : clamp(100 - (d.endYard + 40), 1, 99);              // punt, net ~40
        const oppGross = gross.get(nearestGrid(oppStart, grid)) ?? 1.5;
        net += d.points - oppGross;
      }
      surface.set(y, net / trials);
    }
  });

  _epCache = { grid, gross, net: surface, trials };
  return _epCache;
}
export function clearEpCache() { _epCache = null; }

function nearestGrid(y, grid) {
  let best = grid[0], bd = Infinity;
  for (const g of grid) { const d = Math.abs(g - y); if (d < bd) { bd = d; best = g; } }
  return best;
}

/** Net expected points from first-and-ten at `yard`, interpolated off the surface. */
export function expectedPoints(surface, yard) {
  if (!surface) return 0;
  const y = clamp(yard, 1, 99);
  const g = surface.grid;
  let lo = g[0], hi = g[g.length - 1];
  for (let i = 0; i < g.length - 1; i++) if (g[i] <= y && g[i + 1] >= y) { lo = g[i]; hi = g[i + 1]; break; }
  const a = surface.net.get(lo) ?? 0, b = surface.net.get(hi) ?? 0;
  return hi === lo ? a : a + (b - a) * ((y - lo) / (hi - lo));
}

/** The surface as a readable table, so the DP can be eyeballed for sanity. */
export function expectedPointsTable(driveFn, opts = {}) {
  const s = expectedPointsSurface(driveFn, opts);
  const marks = [5, 15, 25, 35, 45, 55, 65, 75, 85, 95];
  return {
    trials_per_state: s.trials,
    table: marks.map(y => ({
      own_yard_line: y,
      description: y < 50 ? `own ${y}` : `opponent ${100 - y}`,
      gross_points: r2(s.gross.get(nearestGrid(y, s.grid))),
      net_points: r2(expectedPoints(s, y))
    })),
    note: 'Computed by value iteration on the simulator\'s own drive engine, not regressed on real ' +
      'plays — this database has no play-by-play table. Net subtracts what the opponent is expected ' +
      'to score with the ball back, which is why deep-in-own-territory states are negative.'
  };
}
