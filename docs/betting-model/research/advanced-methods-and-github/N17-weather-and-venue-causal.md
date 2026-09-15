# N17 — Weather/Venue Causal Effect Estimation for NFL Totals

Bucket: NEW (assigned). Topic: replace Gridiron's flat additive weather/venue
adjustment with a properly-controlled causal estimate (indoor/outdoor,
altitude, wind), using tables Gridiron already has but barely uses.

## What Gridiron does today (verified by reading the code, not the README)

`server/services/nfl-ensemble.js:581-595`, component id `weather_total`:

```js
let adj = 0;
if (c.roof === 'dome' || c.roof === 'closed') adj += 1.2;
if (c.wind != null && c.wind >= 15) adj -= 2.4;
if (c.temp != null && c.temp < 32) adj -= 1.6;
return { margin: null, total: base + adj };
```

Three hand-picked constants, no standard errors, no interaction with team
style, no altitude term at all, applied identically to every team and every
season. This is exactly the "naive stratified-means" approach the
nflanalytic.com piece below admits doesn't separate cause from selection.

Tables/services that already exist and are under-used:

- `nfl_game_weather` (temp_c, wind_kmh, gust_kmh, precip_mm; `server/db/schema/nfl-n-to-z.js:598`) —
  archived kickoff-hour weather from Open-Meteo, populated by
  `server/services/nfl-weather.js`. **No humidity or pressure column exists.**
- `nfl_game_weather_forecast_history` (`server/db/schema/nfl-n-to-z.js:589`,
  populated by `server/services/nfl-weather-history.js`) — 5 forecast leads
  (0/1/2/3/5 days out) per game, i.e. an actual quasi-experiment: what the
  market saw when it set the total vs. what really happened. Consumed
  *only* by `server/services/line-move-study.js:206-210` to study how the
  line itself moved — never turned into a forecast-surprise signal that
  feeds a total.
- `nfl_stadiums` (`server/db/schema/mlb-model-misc.js:244-248`) has a real
  `altitude` column, populated from the `greerreNFL/Stadiums` CSVs by
  `server/services/nfelo.js:195-220`. **Never joined into `nfl-features.js`
  or `nfl-ensemble.js`. Altitude is not used anywhere in scoring/total
  prediction.** Denver sits at 1609m — right at the threshold where
  exercise-physiology literature (below) says VO2max performance decrements
  begin.
- `server/services/nfl-features.js:194-211,350-388` already computes
  `dome_epa_delta` and `wind_epa_delta` **per team** (EPA/play indoors minus
  outdoors, and windy minus calm) — i.e. Gridiron already has the raw
  ingredient for a *heterogeneous* per-team weather sensitivity, and then
  throws it away: `weather_total` applies the same -2.4 to every team
  regardless of its own measured `wind_epa_delta`.

So the honest gap is not "Gridiron has no weather data" — it has real,
game-level, and even lead-time-forecast weather data. The gap is that
*none of it is used causally*: no controls for team/roster selection into
climate, no altitude term despite the data existing, no use of the
forecast-vs-actual lead structure that's sitting right there.

## Sources (4 read in relevant depth, 2 read in full)

### 1. Houghton-Berry, Park & Pierce, "Weather and the NFL" (Stanford STATS50 class project) — READ IN FULL
https://web.stanford.edu/class/stats50/projects16/Houghton-BerryParkPierce-paper.pdf
- Sample: NFLweather.com data, 2009-2015 seasons (7 seasons, ~1,800 games),
  train on 2009-2014, test on 2015.
- Method: regularized lasso regression on score differential and home-win
  probability, using **team pass/rush offense and defense strength
  (yards/attempt) interacted with weather variables** (temp, wind, rain,
  snow, indoor, turf) rather than team identity or a flat constant — the
  key methodological idea this topic should borrow.
- Result: MSE 12.5 points on score differential; 67.3% (normal/lasso) and
  68.6% (binomial/lasso) win-prediction accuracy on the 2015 holdout.
  Significant findings: wind hurts passing offenses more than rushing;
  turf and indoor stadiums add points; at 72°F a 5 ypc rushing team beats
  its opponent by ~12 more points than at 24°F (rushing YPA × temp
  interaction).
- Honest stated limitation (their own words): *"We were also unable to
  account for home field advantage, which means that we may have
  overestimated the true effects of the weather variables and
  misattributed home field advantage to some of these weather variables'
  effects."* Also flags multicollinearity among weather variables and
  missing-data imputation by home-field mean. This is a class project, not
  peer-reviewed — treat the coefficients as illustrative, not gospel — but
  the interaction-with-team-style design is real and reusable.

### 2. Rodney J. Paul, "The Impact of Atmospheric Conditions on Actual and Expected Scoring in the NFL," *International Journal of Sport Finance* 12(1), 2017 — abstract/results only (paywalled, 403 on SAGE and ResearchGate; not read in full)
https://journals.sagepub.com/doi/full/10.1177/155862351701200102
- Key result (from abstract/indexed summary): **humidity** has a
  statistically significant relationship to the *gap between actual NFL
  scoring and the betting-market total* — high humidity is associated with
  more rushing-driven scoring than the market total implies. Simple
  wagering strategies built on humidity, wind speed, and the two combined
  are shown to reject market efficiency (i.e., there was real, tradeable
  edge at least historically).
- Why this matters for Gridiron specifically: **Gridiron's weather pipeline
  does not fetch or store humidity at all.** `hourAt()` /
  `forecastHourAt()` in `nfl-weather.js` request only
  `temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation` from
  Open-Meteo. `relative_humidity_2m` and `surface_pressure` are available
  on the same free archive/forecast endpoints and are simply not asked
  for. This is the single cheapest, most directly-evidenced gap here.
- Limitation to carry forward honestly: I could not verify the exact
  sample size, regression form, or reported ROI/CLV numbers from the full
  text — only the abstract-level claim. Treat "humidity matters" as a
  research hypothesis worth testing on Gridiron's own 2022-2025 sample,
  not an already-proven edge to bet on blind.

### 3. nflanalytic.com, "Weather & NFL Scoring: It's the Wind" — practitioner analysis, not read in full (WebFetch summary only)
https://nflanalytic.com/explainer-weather-and-scoring.html
- Sample: 7,276 NFL games, 1999-2025. Descriptive only — buckets games by
  wind-speed band and compares mean totals (44.7 pts at 0-5 mph → 40.5 pts
  at 16+ mph).
- Why it's useful despite being non-academic: it is the clearest public
  statement of the exact confound Gridiron's flat adjustment is exposed
  to, in the source's own words: *"Cold-and-windy outdoor sites (Buffalo,
  Chicago, Cleveland) tend to build run-leaning rosters precisely because
  of their weather, so some of the 'wind lowers scoring' effect is teams
  adapting to wind, not just wind acting on a neutral offense... cause and
  roster construction are tangled here, and game totals can't fully
  separate them."* The author admits they don't resolve it. Gridiron's
  `weather_total` component has exactly this problem and doesn't even
  admit it.

### 4. Mujika et al. et al. (narrative review), "Preparation for Endurance Competitions at Altitude," *Frontiers in Physiology*, 2018 — READ IN FULL (open access, PMC)
https://pmc.ncbi.nlm.nih.gov/articles/PMC6218926/
- Not NFL-specific — exercise-physiology literature — used here as the
  causal *mechanism* justification for an altitude term, not as a sports-
  betting result.
- Quantified: performance decrements from altitude begin as low as
  ~700-1600m depending on event duration (shorter/anaerobic events are
  more altitude-tolerant than longer aerobic ones); VO2max-linked
  decrements are the driver. Denver's Mile High is 1,609m — right at that
  threshold.
- Acclimatization time course: partial acclimatization in 5-7 days, "almost
  completed" by 2 weeks; NFL road teams typically arrive 1-2 days before
  kickoff, i.e. essentially zero acclimatization on every trip.
  Team-sport-specific note in the review: recovery windows adequate for
  individual endurance athletes "may not be sufficient for team sports
  regarding sprint ability at high altitude." This is the physiological
  basis for treating Denver as a fatigue/4th-quarter effect, not a
  first-quarter effect, and for treating it as much more team- and
  game-phase-specific than a flat total adjustment.
- Honest limitation: this is a review of endurance/individual-sport
  altitude camps at 1,780-4,300m, a very different exposure profile (days
  of continuous exertion vs. one afternoon of intermittent sprints at
  1,609m). The mechanism transfers; the specific numbers do not.

## Candidates

All five below are internally consistent with the "new capability" framing
Nick specified for this agent — Gridiron currently has zero causal-
identification machinery anywhere in the weather/venue pipeline, just
constants. `fixes_finding` is therefore "none — new capability" throughout;
none of tonight's twelve verified defects names weather/venue handling
specifically, so none of these are filed as `fix`.

1. **Two-way fixed-effects panel model for the weather→total effect**
   (replace `weather_total`'s three constants).
   - Mechanism: regress realized game total on wind/temp/precip ×
     roof-type dummies, with team-offense FE, team-defense FE, and season
     FE, using `nfl_game_weather` joined to `game_lines`. Identification
     comes from within-team variation in weather across a team's own away
     games (the same team, different weather), which directly answers the
     nflanalytic confound: it no longer compares Buffalo-in-wind to
     Miami-in-calm, it compares Buffalo-in-15mph-wind to
     Buffalo-in-5mph-wind.
   - Evidence: moderate — this specific design isn't in any single paper
     above, but it's the standard fix for exactly the confound both the
     Stanford project and nflanalytic.com name explicitly, and it's how
     labor/climate economics has handled this class of problem for 20
     years (temperature-productivity fixed-effects literature).
   - Cost: days (it's OLS with dummy variables — can be written in plain
     JS with a small linear-algebra routine, no new dependency required).
   - Exit test: out-of-sample RMSE and calibration (are 90% CIs actually
     90% coverage) on 2024-2025 held-out weeks vs. the current three-
     constant `weather_total`, and vs. simply not having the component at
     all (does it beat "component abstains").

2. **Fetch and store humidity + surface pressure; test as a totals signal.**
   - Mechanism: add `relative_humidity_2m,surface_pressure` to the
     Open-Meteo query in `hourAt()`/`forecastHourAt()`
     (`server/services/nfl-weather.js`), add two columns to
     `nfl_game_weather`, backfill 2022-2025 (same archive API, same
     historical coverage as wind/temp already have), then test humidity's
     marginal effect on realized totals net of wind/temp/dome, directly
     probing the Paul (2017) claim on Gridiron's own data instead of
     trusting the abstract.
   - Evidence: weak-to-moderate — one paywalled paper's abstract-level
     claim, not independently replicated here. That's exactly why this is
     an exit-tested experiment, not a signal to ship on day one.
   - Cost: hours to add the fields and backfill; a day or two to run the
     regression test properly (with the FE structure from candidate 1, not
     a raw correlation).
   - Exit test: does adding humidity to the candidate-1 regression reduce
     out-of-sample total RMSE by a real margin (not just move an in-sample
     R²)? If not, log the null result and drop it — don't ship a feature
     that doesn't survive its own test.

3. **Altitude/air-density term for Denver, via matched/synthetic control
   rather than a flat bonus.**
   - Mechanism: join the already-ingested `nfl_stadiums.altitude` into
     `nfl-features.js`'s venue-context builder. Because there is exactly
     one high-altitude team (Denver — 1,609m; the next-highest, KC, KC is
     ~280m and everyone else is near sea level), a flat-team fixed-effects
     regression can't identify an altitude coefficient — Denver's team FE
     and its "altitude treatment" are perfectly collinear. This is the
     textbook single-treated-unit problem, and the textbook tool is
     synthetic control: build a synthetic "Denver" from a weighted blend
     of similarly-styled sea-level teams' own home-field performance, and
     compare real Denver's home scoring/4th-quarter-differential against
     that synthetic counterfactual. Weight the comparison toward
     road-team second-half fatigue specifically, per the acclimatization
     mechanism in source 4, rather than a first-half or full-game effect.
   - Evidence: the sports-venue synthetic-control literature (MLB stadium-
     relocation studies) validates the method for exactly this "N=1
     treated unit" sports-venue setting; the physiological mechanism is a
     peer-reviewed review, not a guess.
   - Repo: `sdfordham/pysyncon` (MIT, 84 stars, Python, actively
     maintained — last push today) implements the synthetic-control
     estimator and diagnostics cleanly enough to be worth reading for the
     weight-optimization step even though Gridiron's backend is Node —
     adopt as **reference-only**: reimplement the (small) quadratic
     weight-fitting routine directly in JS rather than adding a Python
     runtime dependency to a Node service.
   - Cost: days (mostly data assembly across seasons + the synthetic
     control fit itself, which is a small QP).
   - Exit test: does the estimated Denver effect (a) have a placebo test
     that passes (running the same synthetic-control procedure on a
     random sea-level "fake-treated" team should show ~0 effect), and (b)
     hold up split by half of season (i.e., is it a real recurring
     within-season effect, not one hot 2019 game)?

4. **Wind-surprise (forecast-vs-realized) signal, reusing data Gridiron
   already collects and already throws away for this purpose.**
   - Mechanism: `nfl_game_weather_forecast_history` already stores what
     the wind forecast said 5, 3, 2, 1, and 0 days before kickoff
     (`server/services/nfl-weather-history.js`), and
     `forecastHistoryFeatures()` already exposes it — but it is wired only
     into `line-move-study.js`'s study of *market* line movement, never
     into a *total* prediction. The market sets its total mostly off the
     day-open forecast (lead ~3-5); if the realized (lead-0/archive) wind
     is much worse than that, the market's total is stale in a way that
     is close to exogenous (weather surprise a few days out isn't caused
     by team quality). That gap — `wind_kmh_lead0 − wind_kmh_lead3or5` —
     is a much cleaner causal quantity than raw realized wind, because raw
     realized wind is confounded with the roster-selection effect (source
     3) while the *surprise* component is not (the market already priced
     in the roster-adapted expectation of wind at that venue in that
     week; only the surprise wasn't priced).
   - Evidence: this is a natural-experiment argument I'm making from the
     data structure Gridiron already has, not a paper result — flag it
     honestly as a design proposal, not a validated finding.
   - Cost: hours — the columns and function already exist; this is a new
     consumer of them plus a backtest.
   - Exit test: does the wind-surprise gap have any relationship at all
     to closing-total-vs-actual-total error in the historical sample,
     and if so is it economically meaningful net of vig (not just
     statistically nonzero on 2,000+ games)?

5. **Per-team heterogeneous weather sensitivity from data Gridiron already
   computes and discards.**
   - Mechanism: `nfl-features.js` already computes `dome_epa_delta` and
     `wind_epa_delta` per team (EPA/play indoors minus outdoors, windy
     minus calm) at lines 209-211 / 386-388 — real, per-team, causal-
     flavored deltas already sitting in the feature table — but
     `weather_total` in `nfl-ensemble.js` ignores them and applies the
     same -2.4 to every team. Replace the flat constant with
     `(home.wind_epa_delta + away.wind_epa_delta)`-scaled adjustment
     (regularized/shrunk toward the population mean for teams with few
     windy games, exactly the kind of partial-pooling a proper
     hierarchical/causal-forest CATE estimate would produce, but doable
     immediately with a simple empirical-Bayes shrinkage before anyone
     builds the full causal-forest version).
   - Evidence: directly motivated by the Stanford project's finding that
     wind hurts passing-heavy offenses more than rushing-heavy ones — i.e.
     heterogeneity is real and already measured, just unused.
   - Repo (for the fuller version later): `py-why/EconML` (4,785 stars,
     Microsoft's "Other"/MSR-derived license, pushed today) implements
     doubly-robust causal forests for exactly this CATE-estimation
     problem — adopt as **reference-only**/**borrow-idea** given the
     Python/Node mismatch; the empirical-Bayes shrinkage version above is
     the Node-native stepping stone, full causal forest is a later,
     optional upgrade if the simple version shows signal.
   - Cost: hours for the shrinkage version; weeks if/when upgraded to a
     real causal forest via an offline Python batch job feeding
     precomputed CATEs back into the JS ensemble as a static table.
   - Exit test: does per-team wind sensitivity beat the flat -2.4 on
     out-of-sample total RMSE, split specifically on high-pass-rate vs.
     high-rush-rate teams (where the Stanford result predicts the flat
     constant should be most wrong)?

## Repos consulted (metadata only, not cloned — Node/Python mismatch makes
porting-and-building not worth it before the JS-native versions above are
tried and shown to need more)

- `sdfordham/pysyncon` — MIT, 84 stars, Python, pushed 2026-09-12 (today).
  Synthetic control estimator + diagnostics. Reference-only for candidate 3.
- `py-why/EconML` (Microsoft) — "Other" license (MSR-derived, permissive
  for research use, check terms before any commercial redistribution),
  4,785 stars, Python, pushed 2026-09-07. Orthogonal/double-ML causal
  forests. Reference-only / borrow-idea for candidate 5's eventual
  full-CATE version.
- `OscarEngelbrektson/SyntheticControlMethods` — Apache-2.0, 195 stars,
  Python — alternative synthetic-control implementation, same
  reference-only status as pysyncon; not chosen over pysyncon because
  pysyncon is more actively maintained (pushed today vs. 2026-07-11) and
  more narrowly scoped.

## Do not do

- Do not add another flat constant (e.g. "+0.5 for altitude") next to the
  existing three — that repeats the exact defect this research is about
  and adds a fourth unvalidated guess instead of removing three.
- Do not treat nflanalytic.com's raw wind-bucket average-total comparison
  (or any raw stratified mean) as a causal estimate and wire it into the
  ensemble — it is precisely the roster-selection-confounded comparison
  the source itself says it can't resolve.
- Do not run a causal forest / CATE model on the altitude question — there
  is exactly one treated unit (Denver), so per-observation heterogeneous-
  effects machinery is the wrong tool (classic small-N causal-inference
  trap); use synthetic control instead, which is built for N=1 treated
  units.
- Do not treat forecast leads or in-week weather readings as independent
  observations when computing standard errors — games in the same week
  share synoptic weather systems (a cold front hits multiple stadiums the
  same weekend); cluster errors by week at minimum, or the false-precision
  problem the CLV/backtest-significance findings already flag elsewhere in
  Gridiron just reappears here.
- Do not ship the humidity signal (candidate 2) or the wind-surprise signal
  (candidate 4) based on the literature alone — both are explicitly
  flagged above as untested-on-Gridiron's-own-data hypotheses; require the
  stated exit test to pass on Gridiron's 2022-2025 sample before any of
  this reaches a live betting or fantasy signal.
- Do not touch the live `fantasy-football-dashboard` database, run its
  migrations, or execute any of its code — this research was done by
  reading files only, per the hard rule, and any implementation of the
  above must be done by Nick or a follow-up session with write access, not
  inferred permission from this note.
