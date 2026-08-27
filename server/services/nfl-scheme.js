/**
 * Offensive scheme identity, scheme change, and what each archetype does to
 * player opportunity.
 *
 * `nfl_teams` carries head_coach / oc_name / off_scheme, but only as a single
 * current snapshot — there is no record of who coordinated which offense in
 * 2022, so a coaching-change history cannot be read from it. Rather than
 * scrape a coordinator table and hardcode names nobody can verify from this
 * database, this recovers the thing a coordinator change actually *is*, from
 * data that already exists for 2016-2025 across all 32 teams
 * (`nfl_team_week_features`):
 *
 *   a coordinator change is a discontinuity in play-calling identity.
 *
 * That is better than a name for the model's purposes anyway. "Ben Johnson
 * left" is only predictive through what it does to pass rate, tempo and
 * personnel usage — and a staff that changes name while keeping the same
 * system should NOT move a projection. Measuring the behaviour measures the
 * thing that matters and ignores the thing that does not.
 *
 * Identity is built from neutral-situation play-calling wherever possible.
 * Raw pass rate is badly confounded by game script: a bad team throws more
 * because it trails, not because it wants to. `off_neutral_pass_rate` and
 * `off_proe` (pass rate over expected, given situation) are already computed
 * upstream and are the honest measures of intent.
 *
 * Nothing here is applied to production automatically. As with every other
 * candidate in this codebase, it is measured, then validated out of sample,
 * and only then considered for authority.
 */
import { rows } from '../db/index.js';
import { pairedBootstrapDiff } from './backtest-significance.js';

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = a => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

/** The play-calling dimensions that define an offensive identity. */
export const SCHEME_DIMENSIONS = Object.freeze([
  'off_neutral_pass_rate',   // intent, stripped of game script
  'off_proe',                // pass rate over expected given down/distance/score
  'off_early_down_pass_rate',
  'off_shotgun_rate',
  'off_no_huddle_rate',
  'off_plays_per_drive'      // tempo / sustain
]);

const profileCache = new Map();

/** Season-long offensive identity per team, averaged over that season's weeks. */
function seasonProfiles(season) {
  if (profileCache.has(season)) return profileCache.get(season);
  const raw = rows(`SELECT team, features FROM nfl_team_week_features WHERE season = ?`, season);
  const acc = new Map();
  for (const r of raw) {
    let f;
    try { f = typeof r.features === "string" ? JSON.parse(r.features) : r.features; } catch { continue; }
    const cur = acc.get(r.team) ?? Object.fromEntries(SCHEME_DIMENSIONS.map(d => [d, []]));
    for (const d of SCHEME_DIMENSIONS) if (Number.isFinite(f[d])) cur[d].push(f[d]);
    acc.set(r.team, cur);
  }
  const out = new Map();
  for (const [team, lists] of acc) {
    out.set(team, Object.fromEntries(SCHEME_DIMENSIONS.map(d => [d, mean(lists[d])])));
  }
  profileCache.set(season, out);
  return out;
}

export function teamSchemeProfile(team, season) {
  return seasonProfiles(season).get(team) ?? null;
}

/**
 * Did this team's offensive identity change between seasons, and by how much?
 *
 * Scored in units of league-wide season-over-season drift: every team's
 * identity moves a little year to year (rule changes, personnel, league-wide
 * trends), and only a move that is large *relative to that normal churn*
 * indicates a system change. A raw delta would flag the whole league in a
 * season where everyone started throwing more.
 */
export function schemeChange(team, season) {
  const before = teamSchemeProfile(team, season - 1);
  const after = teamSchemeProfile(team, season);
  if (!before || !after) return null;

  // League-wide drift for each dimension, this offseason.
  const prior = seasonProfiles(season - 1), current = seasonProfiles(season);
  const drift = {};
  for (const d of SCHEME_DIMENSIONS) {
    const deltas = [];
    for (const [t, p] of prior) {
      const c = current.get(t);
      if (p[d] != null && c?.[d] != null) deltas.push(c[d] - p[d]);
    }
    drift[d] = { mean: mean(deltas), sd: sd(deltas) };
  }

  const perDimension = {};
  let sumSq = 0, counted = 0;
  for (const d of SCHEME_DIMENSIONS) {
    if (before[d] == null || after[d] == null || !drift[d].sd) continue;
    const z = ((after[d] - before[d]) - drift[d].mean) / drift[d].sd;
    perDimension[d] = { before: r3(before[d]), after: r3(after[d]), z: r3(z) };
    sumSq += z * z; counted++;
  }
  if (!counted) return null;
  const magnitude = Math.sqrt(sumSq / counted);
  return {
    team, season, magnitude: r3(magnitude),
    // 1.5 SDs of normal offseason churn, averaged across dimensions. Chosen as
    // a stated threshold rather than fit, and reported alongside the raw
    // magnitude so a consumer can pick its own line.
    changed: magnitude >= 1.5,
    dimensions: perDimension
  };
}

export function allSchemeChanges(season) {
  const out = new Map();
  for (const team of seasonProfiles(season).keys()) {
    const c = schemeChange(team, season);
    if (c) out.set(team, c);
  }
  return out;
}

/**
 * Scheme archetype from prior-season identity — pass/run lean crossed with
 * tempo. Cutoff-safe: it describes what a team WAS, which is all that is
 * knowable before the season starts.
 *
 * Thresholds are league-relative (terciles within the season) rather than
 * absolute, so archetypes stay meaningful as league-wide pass rates drift.
 */
export function schemeArchetypes(season) {
  const profiles = seasonProfiles(season);
  const passVals = [...profiles.values()].map(p => p.off_neutral_pass_rate).filter(Number.isFinite).sort((a, b) => a - b);
  const paceVals = [...profiles.values()].map(p => p.off_plays_per_drive).filter(Number.isFinite).sort((a, b) => a - b);
  const tercile = (arr, i) => arr[Math.floor(arr.length * i / 3)];
  const passLo = tercile(passVals, 1), passHi = tercile(passVals, 2);
  const paceLo = tercile(paceVals, 1), paceHi = tercile(paceVals, 2);
  const out = new Map();
  for (const [team, p] of profiles) {
    const lean = p.off_neutral_pass_rate == null ? 'unknown'
      : p.off_neutral_pass_rate >= passHi ? 'pass_heavy'
        : p.off_neutral_pass_rate <= passLo ? 'run_heavy' : 'balanced';
    const tempo = p.off_plays_per_drive == null ? 'unknown'
      : p.off_plays_per_drive >= paceHi ? 'sustaining'
        : p.off_plays_per_drive <= paceLo ? 'quick' : 'average';
    out.set(team, { team, season, lean, tempo, archetype: `${lean}/${tempo}`, profile: p });
  }
  return out;
}

/**
 * What does a scheme change do to the players already on the roster?
 *
 * The question a projection actually needs: if a team's identity moved, does
 * a returning player's opportunity move with it in a way that a naive
 * "same as last year" forecast would miss? Restricted to players who did NOT
 * change teams, so this measures the scheme effect and not the (already
 * separately measured) team-change effect.
 */
export function measureSchemeChangeEffect(seasons) {
  const results = [];
  for (const season of seasons) {
    const changes = allSchemeChanges(season);
    if (!changes.size) continue;
    const usage = rows(`SELECT player_id, position, team, season,
                               SUM(COALESCE(targets,0)+COALESCE(carries,0)+COALESCE(attempts,0)) opp,
                               COUNT(*) games
                        FROM player_week_usage WHERE season IN (?,?) AND team IS NOT NULL
                        GROUP BY player_id, season, team`, season - 1, season);
    const before = new Map(), after = new Map();
    for (const u of usage) (u.season === season ? after : before).set(`${u.player_id}`, u);
    for (const [pid, b] of before) {
      const a = after.get(pid);
      if (!a || a.team !== b.team) continue;          // stayers only
      if (b.games < 4 || a.games < 4) continue;
      const change = changes.get(a.team);
      if (!change) continue;
      const beforeRate = b.opp / b.games, afterRate = a.opp / a.games;
      if (!(beforeRate > 0)) continue;
      results.push({ season, player_id: pid, position: b.position, team: a.team,
        scheme_changed: change.changed, magnitude: change.magnitude,
        ratio: afterRate / beforeRate });
    }
  }
  const summarize = list => ({ n: list.length,
    median_ratio: list.length ? [...list].map(x => x.ratio).sort((a, b) => a - b)[Math.floor(list.length / 2)] : null,
    mean_ratio: list.length ? r3(mean(list.map(x => x.ratio))) : null,
    // Dispersion matters more than the median here: a scheme change should make
    // outcomes less predictable even if the average is unmoved.
    sd_ratio: list.length > 1 ? r3(sd(list.map(x => x.ratio))) : null });
  const changed = results.filter(x => x.scheme_changed), stable = results.filter(x => !x.scheme_changed);
  return {
    seasons,
    scheme_changed: summarize(changed), scheme_stable: summarize(stable),
    by_position: Object.fromEntries([...new Set(results.map(x => x.position))]
      .filter(p => ['QB', 'RB', 'WR', 'TE'].includes(p))
      .map(p => [p, { changed: summarize(changed.filter(x => x.position === p)),
        stable: summarize(stable.filter(x => x.position === p)) }])),
    note: 'Returning players only (same team both seasons), so this isolates scheme change from ' +
      'the separately measured team-change effect. Opportunity per game, min 4 games each side.'
  };
}

/**
 * Does knowing the scheme changed improve a forecast? Fit on `fitSeasons`,
 * applied to `testSeason`, never both.
 */
export function validateSchemeAdjustment({ fitSeasons = [2022, 2023, 2024], testSeason = 2025 } = {}) {
  const fit = measureSchemeChangeEffect(fitSeasons);
  const factor = fit.scheme_changed.median_ratio && fit.scheme_stable.median_ratio
    ? fit.scheme_changed.median_ratio / fit.scheme_stable.median_ratio : 1;

  const changes = allSchemeChanges(testSeason);
  const usage = rows(`SELECT player_id, position, team, season,
                             SUM(COALESCE(targets,0)+COALESCE(carries,0)+COALESCE(attempts,0)) opp,
                             COUNT(*) games
                      FROM player_week_usage WHERE season IN (?,?) AND team IS NOT NULL
                      GROUP BY player_id, season, team`, testSeason - 1, testSeason);
  const before = new Map(), after = new Map();
  for (const u of usage) (u.season === testSeason ? after : before).set(`${u.player_id}`, u);

  const errU = [], errA = [];
  for (const [pid, b] of before) {
    const a = after.get(pid);
    if (!a || a.team !== b.team || b.games < 4 || a.games < 4) continue;
    const change = changes.get(a.team);
    if (!change) continue;
    const naive = b.opp / b.games, actual = a.opp / a.games;
    if (!(naive > 0)) continue;
    const adjusted = naive * (change.changed ? factor : 1);
    errU.push(Math.abs(naive - actual));
    errA.push(Math.abs(adjusted - actual));
  }
  if (errU.length < 30) return { error: `too few rows (${errU.length})`, factor };
  const test = pairedBootstrapDiff(errU, errA, { iterations: 2000, seed: 13 });
  const mae = a => r3(a.reduce((s, x) => s + x, 0) / a.length);
  return {
    fit_seasons: fitSeasons, test_season: testSeason, factor: r3(factor), n: errU.length,
    unadjusted_mae: mae(errU), adjusted_mae: mae(errA), bootstrap: test,
    improves: test.significant === true && test.mean_diff < 0,
    note: 'Returning players only. Factor fit on ' + fitSeasons.join('+') + ' and applied to ' +
      testSeason + ', so the adjustment never sees the games it is graded on.'
  };
}
