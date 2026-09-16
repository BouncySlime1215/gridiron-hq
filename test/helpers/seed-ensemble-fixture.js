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

/**
 * A drive-level football scoring process, for `scoring: 'football'`.
 *
 * The default `gaussian` scoreboard draws a margin and a total from normals and
 * splits them. That is fine for testing a MARGIN model, and it is what stages 1
 * and 2 needed. It is actively misleading for testing a SCORE model, because
 * measured on the default fixture it has no key-number structure (|margin| = 3
 * on 5.96% of games against roughly 15% in the real NFL), and the arithmetic of
 * splitting one total between two teams makes the two scoreboards NEGATIVELY
 * correlated (-0.33) where real football is mildly positive.
 *
 * So this generator produces points the way football does: a shared number of
 * possessions, each ending in a touchdown, a field goal or nothing according to
 * the same latent strengths the rest of the fixture uses.
 *
 * WHAT THIS IS AND IS NOT EVIDENCE FOR. It is football-SHAPED, not football. It
 * shares a family with the compound-Poisson model in nfl-joint-score.js — both
 * put points on the {3, 7} lattice — so a win for that model here is a control
 * showing the machinery works, NOT evidence it would beat anything on real
 * games. It is deliberately not the model's own likelihood: the count of
 * scoring drives here is binomial over a fixed number of possessions rather
 * than Poisson, and the dependence comes from both teams literally sharing a
 * possession count rather than from an additive Poisson shock. The model is
 * therefore mis-specified for this generator too, just far less badly than for
 * the Gaussian one.
 *
 * Driven by its OWN pseudo-random stream, so that turning it on does not
 * perturb a single feature, weather field or market draw.
 */
function driveScoring(rand, hf, af) {
  // Possessions are shared: football alternates them, so one slow, clock-eating
  // game suppresses both scoreboards and one fast game inflates both. This is
  // the mechanism behind real same-game score correlation.
  const drives = Math.max(7, Math.min(17, Math.round(11.8 + normal(rand, 0, 1.7) + (hf[1] + af[1]) * 0.3)));
  const logistic = x => 1 / (1 + Math.exp(-x));

  const side = (own, opp, edge) => {
    const strength = (own[0] - opp[0]) * 0.09 + edge;
    const pScore = logistic(-0.78 + strength);
    const pTd = logistic(0.36 + strength * 0.5);
    let points = 0, scores = 0;
    for (let d = 0; d < drives; d++) {
      if (rand() >= pScore) continue;
      scores++;
      if (rand() < pTd) {
        const u = rand();
        points += u < 0.94 ? 7 : (u < 0.97 ? 6 : 8);
      } else {
        points += 3;
      }
    }
    if (rand() < 0.018) points += 2;  // safety
    return { points, scores, expected: drives * pScore * (pTd * 7 + (1 - pTd) * 3) };
  };

  // 0.155 on the log-odds scale is worth roughly the 2.2-point home edge the
  // Gaussian mode hard-codes, so the two modes describe the same home advantage.
  const h = side(hf, af, 0.155);
  const a = side(af, hf, 0);
  return {
    homeScore: h.points, awayScore: a.points,
    expectedMargin: h.expected - a.expected,
    expectedTotal: h.expected + a.expected
  };
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
 * @param {'gaussian'|'football'} options.scoring  How points are produced.
 *
 *   `gaussian` (default, and byte-identical to this fixture before the option
 *   existed) draws a margin and a total from normals and splits them between
 *   the two teams. Fine for a margin model; wrong in three measurable ways for
 *   a SCORE model. Measured on the default fixture: the two scoreboards are
 *   correlated -0.33, |margin| = 3 occurs on 5.96% of games and |margin| = 7 on
 *   4.93%, and five team-scores are exactly 1 — a value football cannot
 *   produce.
 *
 *   `football` scores through a drive simulation instead. Measured: team score
 *   mean 22.4 and sd 10.4 (real NFL roughly 22.5 and 10.2), home/away score
 *   correlation +0.097 (real is mildly positive), margin mean 2.68 and sd 13.71
 *   (real roughly 2.2 and 13.5), and no impossible scores.
 *
 *   The one moment it still misses is the one that matters most to a
 *   lattice-aware model: |margin| = 3 occurs on 8.38% of games against 15.08%
 *   in the real 6,991-game sample `margin-distribution.js` measures, and
 *   |margin| = 7 on 7.57% against 9.03%. Real football concentrates on key
 *   numbers roughly twice as hard as this generator does, because real teams
 *   play the scoreboard late and this one does not. That mismatch is
 *   CONSERVATIVE for any model whose advantage is knowing where the lattice is:
 *   the fixture under-rewards it. It is not conservative in the other
 *   direction, and no result here should be read as a measurement of football.
 *
 *   Switching modes changes the scoreboard and nothing else. The drive
 *   simulation runs on its own PRNG stream and the Gaussian draws are taken in
 *   both modes and discarded in one, so features, weather and the market's
 *   noise term are bit-identical across the pair.
 */
export function seedEnsembleFixture({ run, rows = null }, {
  seasons = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024],
  weeksPerSeason = 17, latentFactors = 3, noise = 0.35, seed = 20260912,
  marketNoise = 1.6,
  scoring = 'gaussian',
  teams = FIXTURE_TEAMS,
  allowNonEmpty = false
} = {}) {
  // Refuse to write a synthetic league on top of real history.
  //
  // Every caller's documentation already says "ONLY valid against an empty
  // scratch database", but nothing enforced it: the report scripts check that
  // GRIDIRON_DB_PATH is SET, never that it points somewhere disposable. So
  // `GRIDIRON_DB_PATH=server/data.sqlite node scripts/ensemble-rank-report.mjs
  // --fixture` would have migrated and then seeded a synthetic league straight
  // into the real database, and no synthetic row here is distinguishable from a
  // real one afterwards. The guard lives in the seeder rather than in each
  // script so that every caller inherits it, including ones not written yet.
  if (!allowNonEmpty && typeof rows === 'function') {
    const existing = rows('SELECT COUNT(*) n FROM game_lines')[0]?.n ?? 0;
    if (existing > 0) {
      throw new Error(`refusing to seed the synthetic fixture: game_lines already holds ${existing} ` +
        'row(s). This writes a fabricated league that cannot be told apart from real history ' +
        'afterwards. Point GRIDIRON_DB_PATH at a fresh scratch path, or pass allowNonEmpty to ' +
        'say the existing rows are themselves disposable.');
    }
  }
  const rand = mulberry32(seed);
  // A dedicated stream for the drive simulation. Separate so that switching
  // `scoring` changes the scoreboard and nothing else whatsoever.
  const scoreRand = mulberry32(seed ^ 0x5f3759df);

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

      // Real, week-spaced calendar dates (not drawn from `rand`, so this does
      // not affect the PRNG stream or the gaussian/football determinism pair
      // above). Every consumer used to receive the same `${season}-09-01`
      // string for all 17 weeks of a season, which is fine for diagnostics
      // that only key off (season, week) — but it collapses every game in a
      // season onto one instant for any consumer that filters by real
      // elapsed time (e.g. a decision-publication-lag cutoff), making whole
      // seasons either wholly eligible or wholly excluded together instead
      // of week by week.
      const weekGameday = new Date(Date.UTC(season, 8, 1) + (week - 1) * 7 * 86400000)
        .toISOString().slice(0, 10);

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
        // These two draws are taken in BOTH scoring modes and become the
        // scoreboard only in `gaussian` mode. Taking them unconditionally is
        // what keeps the two modes a controlled pair: `rand` advances
        // identically, so every feature, every weather field and the market's
        // own noise term are bit-identical between them, and the ONLY
        // difference is how points are produced. See the `scoring` option.
        const gaussianMargin = Math.round(trueEdge + normal(rand, 0, 10.5));
        const gaussianTotal = Math.round(44 + (hf[1] + af[1]) * 2 + normal(rand, 0, 9));

        let homeScore, awayScore, marginAnchor, totalAnchor;
        if (scoring === 'football') {
          const drives = driveScoring(scoreRand, hf, af);
          homeScore = drives.homeScore;
          awayScore = drives.awayScore;
          marginAnchor = drives.expectedMargin;
          totalAnchor = drives.expectedTotal;
        } else {
          homeScore = Math.max(0, Math.round((gaussianTotal + gaussianMargin) / 2));
          awayScore = Math.max(0, gaussianTotal - homeScore);
          marginAnchor = trueEdge;
          totalAnchor = 44 + (hf[1] + af[1]) * 2;
        }

        // A market quote that is the generator's own expected margin plus small
        // noise — close to, but not identical to, what the components are trying
        // to beat. The anchor follows whichever scoring process is in force, so
        // the market is equally well informed in both modes and the two runs
        // stay comparable.
        const marketMargin = Math.round((marginAnchor + normal(rand, 0, marketNoise)) * 2) / 2;
        const homeSpread = -marketMargin;
        const marketTotal = Math.round((totalAnchor + normal(rand, 0, 2)) * 2) / 2;
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
        openSpread, openTotal, temp, wind, roof, homeRest, div, weekGameday);
        run(`INSERT OR REPLACE INTO game_lines
             (season,week,team,opponent,home,spread,total,team_score,opp_score,
              open_spread,open_total,temp,wind,roof,rest_days,div_game,neutral_site,gameday)
             VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
        season, week, away, home, -homeSpread, marketTotal, awayScore, homeScore,
        -openSpread, openTotal, temp, wind, roof, awayRest, div, weekGameday);
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
    scoring,
    feature_fields: FEATURE_SPEC.length,
    note: 'synthetic: feature correlation structure is a property of this generator, not of football'
  };
}
