/**
 * A deterministic league whose feature space has a KNOWN number of latent
 * factors.
 *
 * This exists for one narrow purpose: to give `nfl-ensemble-rank.js` an
 * end-to-end run whose right answer is known by construction. Every team-week
 * feature here is a fixed linear combination of `latentFactors` hidden
 * variables plus independent per-feature noise, so the dimensionality of the
 * information the components can possibly carry is a number this file chose.
 * If the diagnostic reports an effective rank far from that number on this
 * data, the diagnostic is wrong.
 *
 * It is NOT a measurement of the real ensemble. The correlation structure of
 * real NFL efficiency features is an empirical fact about football; the
 * correlation structure here is an empirical fact about the loading matrix
 * fifty lines below. Any effective-rank number produced on this fixture
 * describes the fixture. See test/helpers/requires-real-history.js for why
 * this repository keeps that distinction loud.
 */

/** Deterministic PRNG — a fixture that differs between runs is not a fixture. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Approximately normal from twelve uniforms. Deterministic given `rand`. */
function normal(rand, mu = 0, sd = 1) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += rand();
  return mu + (sum - 6) * sd;
}

export const FIXTURE_TEAMS = Object.freeze([
  'KC', 'BAL', 'BUF', 'CIN', 'SF', 'SEA', 'DAL', 'PHI',
  'GB', 'DET', 'MIA', 'NYJ', 'LAR', 'ARI', 'TB', 'NO'
]);

/**
 * The feature fields `featureAggregates()` in nfl-ensemble.js reads, with the
 * centre and scale each one is generated around. Only the fields the component
 * models actually consume are produced; anything else would be dead weight in
 * the fixture and could not affect a single forecast.
 */
const FEATURE_SPEC = [
  ['net_epa_per_play', 0, 0.06], ['off_epa_per_play', 0.02, 0.06], ['def_epa_per_play', 0.02, 0.06],
  ['off_epa_neutral_wp', 0.01, 0.06], ['def_epa_neutral_wp', 0.01, 0.06],
  ['off_early_down_epa', 0.01, 0.07], ['def_early_down_epa', 0.01, 0.07],
  ['off_pass_epa_per_play', 0.08, 0.10], ['def_pass_epa_per_play', 0.08, 0.10],
  ['off_rush_epa_per_play', -0.05, 0.06], ['def_rush_epa_per_play', -0.05, 0.06],
  ['off_explosive_pass_rate', 0.11, 0.03], ['def_explosive_pass_rate', 0.11, 0.03],
  ['off_pressure_epa', -0.35, 0.12], ['def_pressure_epa', -0.35, 0.12],
  ['off_series_success_rate', 0.70, 0.05], ['def_series_success_rate', 0.70, 0.05],
  ['off_avg_drive_start', 28, 3], ['def_avg_drive_start', 28, 3],
  ['off_second_half_epa', 0, 0.08], ['def_second_half_epa', 0, 0.08],
  ['off_success_rate', 0.45, 0.03], ['def_success_rate', 0.45, 0.03],
  ['off_explosive_play_rate', 0.10, 0.02], ['def_explosive_play_rate', 0.10, 0.02],
  ['off_drive_scoring_rate', 0.38, 0.06], ['def_drive_scoring_rate', 0.38, 0.06],
  ['off_third_down_rate', 0.39, 0.05], ['def_third_down_rate', 0.39, 0.05],
  ['off_red_zone_td_rate', 0.56, 0.08], ['def_red_zone_td_rate', 0.56, 0.08],
  ['off_sack_rate', 0.065, 0.02], ['def_sack_rate', 0.065, 0.02], ['def_havoc_rate', 0.17, 0.03],
  ['off_turnover_rate', 0.022, 0.006], ['def_turnover_rate', 0.022, 0.006],
  ['off_plays', 63, 4], ['off_seconds_per_drive', 165, 18],
  ['off_drives', 11.2, 0.9], ['off_yards_per_drive', 30, 5], ['off_proe', 0, 0.04]
];

/**
 * Seed a fixture league into an already-migrated database.
 *
 * @param {object}   io                 `{ run }` from server/db/index.js.
 * @param {object}   options
 * @param {number}   options.latentFactors  How many hidden variables every
 *   feature is built from. This is the answer the rank diagnostic should
 *   recover (up to the noise floor) when run on this fixture.
 * @param {number}   options.noise      Per-feature independent noise, as a
 *   multiple of that feature's scale. Higher noise inflates measured rank,
 *   because pure noise is, correctly, independent information.
 * @param {number}   options.marketNoise  How far the fixture's market quote sits
 *   from the true edge, in points. The default 1.6 makes the market a
 *   near-oracle — deliberately, because that is the situation the real ensemble
 *   is in. But it also means no combination CAN beat the market here, which
 *   makes "nothing beat the market" uninformative about whether a combiner
 *   works at all. Raising it produces the control case: a league where the
 *   components genuinely do know something the market does not, and in which a
 *   correct combiner must be seen to win. Changing this value alters ONLY the
 *   market quote — the PRNG draw count is identical either way, so scores,
 *   features and weather are bit-identical across settings and the comparison
 *   is properly controlled.
 */
export function seedEnsembleFixture({ run }, {
  seasons = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024],
  weeksPerSeason = 17, latentFactors = 3, noise = 0.35, seed = 20260912,
  marketNoise = 1.6,
  teams = FIXTURE_TEAMS
} = {}) {
  const rand = mulberry32(seed);

  // A fixed loading matrix: feature j reads factor k with weight L[j][k].
  // Drawn once, so every feature is a different mixture of the SAME small set
  // of hidden variables — which is exactly the situation the ensemble is
  // suspected of being in.
  const loadings = FEATURE_SPEC.map(() =>
    Array.from({ length: latentFactors }, () => normal(rand, 0, 1)));

  const factorState = new Map();
  for (const team of teams) {
    factorState.set(team, Array.from({ length: latentFactors }, () => normal(rand, 0, 1)));
  }

  let inserted = 0;
  for (const season of seasons) {
    // Between seasons the factors regress toward the mean and are re-shocked,
    // so ratings models have something to track rather than a constant.
    for (const team of teams) {
      const f = factorState.get(team);
      for (let k = 0; k < latentFactors; k++) f[k] = f[k] * 0.7 + normal(rand, 0, 0.7);
    }
    for (let week = 1; week <= weeksPerSeason; week++) {
      // Slow weekly drift keeps the dynamic-state and recent-form components
      // from being constants.
      for (const team of teams) {
        const f = factorState.get(team);
        for (let k = 0; k < latentFactors; k++) f[k] = f[k] * 0.985 + normal(rand, 0, 0.12);
      }

      const order = teams.map((_, i) => (i + week * 3) % teams.length);
      for (let pair = 0; pair < teams.length / 2; pair++) {
        const home = teams[order[pair]];
        const away = teams[order[teams.length - 1 - pair]];
        if (home === away) continue;
        const hf = factorState.get(home), af = factorState.get(away);
        // Only factor 0 drives the scoreboard directly; the rest move features
        // without moving results, which is the honest shape of a feature set
        // that contains more dimensions than it has predictive content.
        const trueEdge = (hf[0] - af[0]) * 6 + 2.2;
        const margin = Math.round(trueEdge + normal(rand, 0, 10.5));
        const totalPoints = Math.round(44 + (hf[1] + af[1]) * 2 + normal(rand, 0, 9));
        const homeScore = Math.max(0, Math.round((totalPoints + margin) / 2));
        const awayScore = Math.max(0, totalPoints - homeScore);
        // A market quote that is the true edge plus small noise — close to,
        // but not identical to, what the components are trying to beat.
        const marketMargin = Math.round((trueEdge + normal(rand, 0, marketNoise)) * 2) / 2;
        const homeSpread = -marketMargin;
        const marketTotal = Math.round((44 + (hf[1] + af[1]) * 2 + normal(rand, 0, 2)) * 2) / 2;
        const openSpread = homeSpread + Math.round(normal(rand, 0, 0.8) * 2) / 2;
        const openTotal = marketTotal + Math.round(normal(rand, 0, 1.0) * 2) / 2;
        const homeRest = 7 + (rand() < 0.12 ? -3 : 0);
        const awayRest = 7 + (rand() < 0.12 ? -3 : 0);
        const div = (order[pair] % 4) === (order[teams.length - 1 - pair] % 4) ? 1 : 0;
        const roof = rand() < 0.25 ? 'dome' : 'outdoors';
        const temp = roof === 'dome' ? 68 : Math.round(normal(rand, 52, 16));
        const wind = roof === 'dome' ? 0 : Math.max(0, Math.round(normal(rand, 8, 5)));

        run(`INSERT OR REPLACE INTO game_lines
             (season,week,team,opponent,home,spread,total,team_score,opp_score,
              open_spread,open_total,temp,wind,roof,rest_days,div_game,neutral_site,gameday)
             VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
        season, week, home, away, homeSpread, marketTotal, homeScore, awayScore,
        openSpread, openTotal, temp, wind, roof, homeRest, div, `${season}-09-01`);
        run(`INSERT OR REPLACE INTO game_lines
             (season,week,team,opponent,home,spread,total,team_score,opp_score,
              open_spread,open_total,temp,wind,roof,rest_days,div_game,neutral_site,gameday)
             VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
        season, week, away, home, -homeSpread, marketTotal, awayScore, homeScore,
        -openSpread, openTotal, temp, wind, roof, awayRest, div, `${season}-09-01`);
        inserted++;
      }

      // Team-week features. Every field is the same latent factors seen
      // through a different (fixed) linear lens, plus its own noise.
      for (const team of teams) {
        const f = factorState.get(team);
        const features = {};
        FEATURE_SPEC.forEach(([key, centre, scale], j) => {
          let signal = 0;
          for (let k = 0; k < latentFactors; k++) signal += loadings[j][k] * f[k];
          signal /= Math.sqrt(latentFactors);
          features[key] = centre + scale * (signal + normal(rand, 0, noise));
        });
        run(`INSERT OR REPLACE INTO nfl_team_week_features (season,week,team,opponent,home,features)
             VALUES (?,?,?,?,1,?)`, season, week, team, team, JSON.stringify(features));
      }
    }
  }

  return {
    games: inserted, teams: teams.length, seasons: seasons.length,
    latent_factors: latentFactors, noise, market_noise: marketNoise,
    feature_fields: FEATURE_SPEC.length,
    note: 'synthetic: feature correlation structure is a property of this generator, not of football'
  };
}
