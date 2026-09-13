/**
 * A league-average team-rate fixture for the drive simulator.
 *
 * WHAT THIS IS AND IS NOT. The engine reads every team rate from
 * `nfl_team_week_features`, so on a clean checkout it cannot run at all — it
 * returns "no profile for KC" rather than a game. This builds the minimum
 * input the engine needs from `RATE_SPEC`/`DEF_SPEC`, which are the measured
 * NFL league averages already committed in `nfl-sim-learn.js`, plus a
 * deterministic per-team spread so the empirical-Bayes shrinkage step has
 * between-team variance to fit instead of dividing by zero.
 *
 * It is therefore a fixture of the ENGINE's inputs, not of football. It is the
 * honest substrate for exactly one class of question — does the engine's own
 * MECHANICS produce a distribution with the right SHAPE — because the shape
 * faults this repo has actually shipped (a discrete +7 spike from a one-shot
 * home-field coin flip, turnovers that did not flip field position, a half
 * clock read as a game clock) are properties of the engine and are present at
 * league-average inputs just as strongly as at real ones.
 *
 * It is NOT a substitute for real history when the question is "is this team
 * better than that one", and `nfl-sim-shape-calibration.js` refuses to report
 * an absolute calibration verdict against a corpus it can tell is synthetic.
 * See test/helpers/requires-real-history.js for the same argument at length.
 */
import { RATE_SPEC } from '../../server/services/nfl-sim-learn.js';

export const FIXTURE_TEAMS = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB',
  'HOU', 'IND', 'JAX', 'KC', 'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG',
  'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS'
];

/**
 * Every rate the engine can read, with its league-average default. The
 * defensive half is not exported from nfl-sim-learn.js, so it is restated
 * here at the same values; a mismatch would only make a team look like the
 * league mean, which is the fallback the engine already applies.
 */
const DEF_DEFAULTS = {
  def_yards_per_play: 5.45, def_epa_per_play: 0.0, def_success_rate: 0.44,
  def_explosive_play_rate: 0.097, def_turnover_rate: 0.025, def_sack_rate: 0.066,
  def_int_rate: 0.024, def_fumble_rate: 0.011, def_stuff_rate: 0.18,
  def_third_down_rate: 0.393, def_red_zone_td_rate: 0.222, def_havoc_rate: 0.18,
  def_pressure_epa: 0.0, def_drive_td_rate: 0.256, def_yards_per_attempt: 7.0,
  def_yards_per_carry: 4.46, def_explosive_pass_rate: 0.085, def_explosive_rush_rate: 0.11,
  def_completion_pct: 0.60
};

/** Deterministic uniform in [0,1) — no dependence on the engine's own stream. */
function hashUnit(...parts) {
  let h = 2166136261;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Insert `weeks` weeks of features for all 32 teams in `season`.
 *
 * `dispersion` is the fraction of each rate's own magnitude used as the
 * half-width of the between-team spread (0.12 puts team offences roughly one
 * standard deviation apart on yards per play, which is about what the real
 * league does) and `noise` is the smaller within-team week-to-week wobble
 * that gives fitK a within-team variance to divide by.
 */
export function seedLeagueFixture(run, { season = 2024, weeks = 17, dispersion = 0.12, noise = 0.06 } = {}) {
  const spec = { ...RATE_SPEC, ...DEF_DEFAULTS };
  const keys = Object.keys(spec);
  let inserted = 0;
  for (const team of FIXTURE_TEAMS) {
    for (let week = 1; week <= weeks; week++) {
      const features = {};
      for (const key of keys) {
        const base = spec[key];
        const teamTilt = (hashUnit(team, key) - 0.5) * 2 * dispersion;
        const weekTilt = (hashUnit(team, key, week) - 0.5) * 2 * noise;
        const scale = Math.abs(base) > 1e-9 ? Math.abs(base) : 0.05;
        features[key] = base + scale * (teamTilt + weekTilt);
      }
      run(`INSERT OR REPLACE INTO nfl_team_week_features (season, week, team, opponent, home, features)
           VALUES (?, ?, ?, NULL, NULL, ?)`, season, week, team, JSON.stringify(features));
      inserted++;
    }
  }
  return { season, weeks, teams: FIXTURE_TEAMS.length, rows: inserted };
}
