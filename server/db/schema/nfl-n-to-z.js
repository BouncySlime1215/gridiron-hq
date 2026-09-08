/**
 * Legacy schema fragment: NFL services, nfl-n* through nfl-w*.
 *
 * Lifted verbatim from the import-time db.exec()/run() blocks of the 34 source
 * files listed in `sources` (see nfl-n-to-z.manifest.json for the exact line
 * ranges, conflicts and what was deliberately left in place). FROZEN — see
 * server/db/schema/README.md.
 */

export const sources = [
  'server/services/nfl-neural-replay.js',
  'server/services/nfl-news-signal.js',
  'server/services/nfl-officials.js',
  'server/services/nfl-online-neural.js',
  'server/services/nfl-orthogonal-specialists.js',
  'server/services/nfl-page-explain-audit.js',
  'server/services/nfl-pbp.js',
  'server/services/nfl-pick-explanation-audit.js',
  'server/services/nfl-pick-watch.js',
  'server/services/nfl-player-state.js',
  'server/services/nfl-postgame-truth.js',
  'server/services/nfl-pregame.js',
  'server/services/nfl-profitability.js',
  'server/services/nfl-prop-calibration.js',
  'server/services/nfl-prop-clv.js',
  'server/services/nfl-prop-correlation.js',
  'server/services/nfl-prop-head-validation.js',
  'server/services/nfl-props.js',
  'server/services/nfl-qbr.js',
  'server/services/nfl-quote-tape.js',
  'server/services/nfl-replay.js',
  'server/services/nfl-research.js',
  'server/services/nfl-risk-lab.js',
  'server/services/nfl-rookies.js',
  'server/services/nfl-roster-strength.js',
  'server/services/nfl-signal-reliability.js',
  'server/services/nfl-sim-calibration.js',
  'server/services/nfl-team-card.js',
  'server/services/nfl-total-calibration.js',
  'server/services/nfl-tweet-line-correlation.js',
  'server/services/nfl-user-bets.js',
  'server/services/nfl-weather-history.js',
  'server/services/nfl-weather.js',
  'server/services/nfl-weekly-feature-store.js'
];

/** ONLY `CREATE TABLE IF NOT EXISTS ...` statements, verbatim. */
export function tables(db) {
  // server/services/nfl-neural-replay.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_neural_replay_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL,
  created_at TEXT NOT NULL, result_json TEXT NOT NULL
)`);

  // server/services/nfl-news-signal.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_news_signals (
    news_id INTEGER NOT NULL,
    player_key TEXT NOT NULL,
    player_id TEXT,
    player_name TEXT,
    team TEXT,
    signal_type TEXT NOT NULL,
    status TEXT,
    body_part TEXT,
    unavailable_probability REAL,
    role_delta REAL,
    confidence REAL NOT NULL,
    published_at TEXT NOT NULL,
    source TEXT,
    source_url TEXT,
    evidence_span TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    verification_state TEXT NOT NULL DEFAULT 'quarantined',
    verification_reason TEXT NOT NULL DEFAULT 'source not evaluated',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (news_id,player_key,signal_type)
  );
  CREATE TABLE IF NOT EXISTS nfl_news_extraction_attempts (
    news_id INTEGER NOT NULL,extractor_version TEXT NOT NULL,attempted_at TEXT NOT NULL,
    accepted_claims INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(news_id,extractor_version)
  );
`);

  // server/services/nfl-officials.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_officials (
  game_id     TEXT NOT NULL,
  official_id TEXT,
  name        TEXT NOT NULL,
  position    TEXT,
  season      INTEGER,
  week        INTEGER,
  season_type TEXT,
  PRIMARY KEY (game_id, name, position)
)`);

  // server/services/nfl-online-neural.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_online_neural_examples (
    season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL, away TEXT NOT NULL,
    head TEXT NOT NULL, horizon TEXT NOT NULL, captured_at TEXT NOT NULL, kickoff_at TEXT,
    schema_version TEXT NOT NULL, model_version TEXT NOT NULL, feature_hash TEXT NOT NULL,
    engine_version TEXT, epoch_id INTEGER NOT NULL DEFAULT 1,
    features_json TEXT NOT NULL, market_margin REAL NOT NULL, market_total REAL,
    prediction_residual REAL NOT NULL, predicted_margin REAL NOT NULL,
    actual_margin REAL, target_residual REAL, settled_at TEXT, trained_at TEXT,
    selected_for_training INTEGER,
    PRIMARY KEY (season,week,home,head,horizon)
  );
  CREATE TABLE IF NOT EXISTS nfl_online_neural_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, head TEXT NOT NULL, version TEXT NOT NULL UNIQUE,
    parent_version TEXT, schema_version TEXT NOT NULL, created_at TEXT NOT NULL,
    epoch_id INTEGER NOT NULL DEFAULT 1,
    trained_through_season INTEGER, trained_through_week INTEGER,
    state_json TEXT NOT NULL, state_hash TEXT NOT NULL, metrics_json TEXT,
    UNIQUE(head,trained_through_season,trained_through_week)
  );
`);

  // server/services/nfl-orthogonal-specialists.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_orthogonal_specialist_artifacts (
    artifact_id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    through_season INTEGER NOT NULL,
    through_week INTEGER NOT NULL,
    data_hash TEXT NOT NULL,
    training_games INTEGER NOT NULL,
    validation_games INTEGER NOT NULL,
    artifact_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

  // server/services/nfl-page-explain-audit.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_page_explain_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    route TEXT NOT NULL,
    section TEXT,
    subview TEXT,
    question TEXT,
    summary_hash TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    translation_json TEXT NOT NULL,
    model TEXT NOT NULL,
    authority TEXT NOT NULL DEFAULT 'wording_only'
  );
`);

  // server/services/nfl-pbp.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_team_week_features (
    season INTEGER NOT NULL, week INTEGER NOT NULL, team TEXT NOT NULL,
    opponent TEXT, home INTEGER, features TEXT NOT NULL,
    PRIMARY KEY (season, week, team)
  );

  CREATE TABLE IF NOT EXISTS nfl_player_week_features (
    season INTEGER NOT NULL, week INTEGER NOT NULL, player_id TEXT NOT NULL,
    player_name TEXT, team TEXT, opponent TEXT, position TEXT, features TEXT NOT NULL,
    PRIMARY KEY (season, week, player_id)
  );
`);

  // server/services/nfl-pick-explanation-audit.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_pick_explanation_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    matchup TEXT,
    market TEXT NOT NULL,
    selection TEXT,
    reasoning_hash TEXT NOT NULL,
    reasoning_json TEXT NOT NULL,
    translation_json TEXT NOT NULL,
    model TEXT NOT NULL,
    authority TEXT NOT NULL DEFAULT 'wording_only'
  );
`);

  // server/services/nfl-pick-watch.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_pick_watch_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    checked_at     TEXT NOT NULL,
    pick_source    TEXT NOT NULL,   -- 'spread' | 'total'
    season         INTEGER NOT NULL, week INTEGER NOT NULL, rank INTEGER NOT NULL,
    matchup        TEXT, market TEXT, selection TEXT, side TEXT,
    line_at_generation  REAL, price_at_generation INTEGER, book_at_generation TEXT,
    best_book      TEXT, best_line REAL, best_price INTEGER, books_compared INTEGER,
    break_even_at_generation REAL, break_even_now REAL, direction TEXT,
    model_probability REAL, model_edge_at_generation REAL,
    gate_open      INTEGER NOT NULL, recommended_stake_units REAL NOT NULL,
    status         TEXT NOT NULL, note TEXT
  );
`);

  // server/services/nfl-player-state.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_roster_snapshots (
    captured_at TEXT NOT NULL,
    player_id INTEGER,
    espn_id INTEGER,
    gsis_id TEXT,
    player_name TEXT NOT NULL,
    position TEXT,
    team TEXT NOT NULL,
    status TEXT,
    depth_slot TEXT,
    depth_order INTEGER,
    source TEXT NOT NULL,
    PRIMARY KEY (captured_at,team,player_name)
  );
  CREATE TABLE IF NOT EXISTS nfl_player_roster_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER,
    espn_id INTEGER,
    gsis_id TEXT,
    player_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    from_team TEXT,
    to_team TEXT,
    roster_status TEXT NOT NULL,
    effective_at TEXT NOT NULL,
    captured_at TEXT NOT NULL DEFAULT (datetime('now')),
    news_id INTEGER,
    source TEXT NOT NULL,
    source_url TEXT,
    confidence REAL NOT NULL,
    verification_state TEXT NOT NULL,
    evidence TEXT NOT NULL,
    event_key TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS nfl_player_state_quarantine (
    news_id INTEGER PRIMARY KEY,
    reason TEXT NOT NULL,
    evidence TEXT NOT NULL,
    captured_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

  // server/services/nfl-postgame-truth.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_postgame_truth_packets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL, away TEXT NOT NULL,
    version TEXT NOT NULL, source_hash TEXT NOT NULL, created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    UNIQUE(season,week,home,version,source_hash)
  );
`);
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_game_variance (
  season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL,
  variance_points REAL, adjusted_residual REAL, raw_residual REAL, items_json TEXT, version TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (season, week, home)
)`);

  // server/services/nfl-pregame.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_pregame_snapshot_history (
  season INTEGER NOT NULL, week INTEGER NOT NULL, team TEXT NOT NULL,
  captured_at TEXT NOT NULL, data_cutoff TEXT NOT NULL,
  quarterback_json TEXT NOT NULL, roster_json TEXT NOT NULL,
  injuries_json TEXT NOT NULL, coaching_json TEXT NOT NULL,
  feature_coverage_json TEXT NOT NULL,
  PRIMARY KEY (season, week, team, captured_at)
)`);

  // server/services/nfl-profitability.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_teaser_price_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    book TEXT NOT NULL,
    teaser_points REAL NOT NULL,
    legs INTEGER NOT NULL,
    american_price INTEGER NOT NULL,
    different_games_required INTEGER NOT NULL DEFAULT 1,
    push_rule TEXT,
    reachable INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    UNIQUE(captured_at,book,teaser_points,legs)
  );
`);

  // server/services/nfl-prop-calibration.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_prop_calibration_fits (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, market TEXT NOT NULL,
  spec_hash TEXT NOT NULL, candidate_id TEXT NOT NULL, train_through INTEGER NOT NULL,
  params_json TEXT NOT NULL, audit_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0
)`);

  // server/services/nfl-prop-clv.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_prop_clv (
    captured_at TEXT NOT NULL, event_id TEXT NOT NULL, book TEXT NOT NULL,
    market TEXT NOT NULL, player TEXT NOT NULL, side TEXT NOT NULL,
    line REAL, american_price INTEGER NOT NULL,
    model_probability REAL, implied_probability REAL, edge REAL,
    season INTEGER, week INTEGER,
    closing_line REAL, closing_price INTEGER, clv_cents REAL,
    settled INTEGER NOT NULL DEFAULT 0, actual_value REAL, won INTEGER,
    PRIMARY KEY (captured_at, event_id, book, market, player, side)
  );
`);
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_prop_policy_archive (
  version TEXT PRIMARY KEY,policy_hash TEXT NOT NULL,policy_json TEXT NOT NULL,
  frozen_at TEXT NOT NULL
)`);

  // server/services/nfl-prop-correlation.js
  // (nfl_sgp_quotes is NOT lifted from ensureSgpQuoteTable(): migration
  // 014_profit_execution_triggers CREATEs it unconditionally — see manifest.)
  db.exec(`
  CREATE TABLE IF NOT EXISTS prop_correlation_estimates (
    key TEXT PRIMARY KEY,          -- 'passing_yards|QB|receiving_yards|WR|team'
    stat_a TEXT, position_a TEXT, stat_b TEXT, position_b TEXT, relation TEXT,
    correlation REAL, pairs INTEGER, fitted_at TEXT
  );
`);

  // server/services/nfl-prop-head-validation.js
  db.exec(`CREATE TABLE IF NOT EXISTS prop_head_audits (
  spec_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, registry_version TEXT NOT NULL, metric TEXT NOT NULL,
  development_season INTEGER NOT NULL, discovery_season INTEGER NOT NULL,
  validation_season INTEGER, validation_opened INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL
)`);

  // server/services/nfl-props.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_total_picks (
    season INTEGER NOT NULL, week INTEGER NOT NULL, rank INTEGER NOT NULL,
    home_team TEXT, away_team TEXT, matchup TEXT,
    side TEXT, line REAL, american_price INTEGER,
    model_probability REAL, implied_probability REAL, probability_difference REAL,
    model_total REAL, detail TEXT, units_staked REAL DEFAULT 1, selected_at TEXT NOT NULL,
    PRIMARY KEY (season, week, rank)
  );
  CREATE TABLE IF NOT EXISTS nfl_prop_quote_snapshots (
    captured_at TEXT NOT NULL, event_id TEXT NOT NULL, commence_time TEXT,
    home_team TEXT, away_team TEXT, book TEXT NOT NULL, market TEXT NOT NULL,
    player TEXT NOT NULL, side TEXT NOT NULL, line REAL, line_key TEXT NOT NULL,
    american_price INTEGER NOT NULL,
    PRIMARY KEY (captured_at,event_id,book,market,player,side,line_key)
  );
`);

  // server/services/nfl-qbr.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_qbr_weekly (
  season INTEGER NOT NULL, week INTEGER NOT NULL, team TEXT NOT NULL,
  player_id TEXT NOT NULL, name TEXT, opponent TEXT,
  qbr_total REAL, pts_added REAL, qb_plays INTEGER, epa_total REAL, qbr_raw REAL, sack REAL, qualified INTEGER,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, week, team, player_id)
)`);

  // server/services/nfl-quote-tape.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_quote_batches (
    batch_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    snapshot_at TEXT NOT NULL,
    previous_snapshot_at TEXT,
    next_snapshot_at TEXT,
    mode TEXT NOT NULL,
    markets TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    events INTEGER NOT NULL,
    quotes INTEGER NOT NULL,
    raw_hash TEXT NOT NULL,
    tape_version TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nfl_quote_tape (
    quote_id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    commence_time TEXT NOT NULL,
    snapshot_at TEXT NOT NULL,
    book_updated_at TEXT,
    bookmaker_key TEXT NOT NULL,
    bookmaker_title TEXT,
    market TEXT NOT NULL,
    period TEXT NOT NULL,
    side_key TEXT NOT NULL,
    side_name TEXT NOT NULL,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    line REAL,
    american_price INTEGER NOT NULL,
    implied_probability REAL NOT NULL,
    raw_json TEXT NOT NULL,
    tape_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(batch_id) REFERENCES nfl_quote_batches(batch_id) ON DELETE RESTRICT
  );
`);

  // server/services/nfl-replay.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_replay_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL, label TEXT, created_at TEXT NOT NULL,
    bets INTEGER, wins INTEGER, losses INTEGER, pushes INTEGER,
    units REAL, roi REAL, config TEXT
  );
  CREATE TABLE IF NOT EXISTS nfl_replay_bets (
    run_id INTEGER NOT NULL, season INTEGER, week INTEGER,
    home TEXT, away TEXT, market TEXT, side TEXT, line REAL,
    model_margin REAL, market_margin REAL, edge REAL, disagreement REAL,
    actual_margin REAL, actual_total REAL,
    result TEXT, units REAL,
    PRIMARY KEY (run_id, season, week, home, market)
  );
  CREATE TABLE IF NOT EXISTS nfl_policy_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    policy_id TEXT NOT NULL, policy_version TEXT NOT NULL,
    seasons_json TEXT NOT NULL, created_at TEXT NOT NULL,
    result_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nfl_candidate_input_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL, seasons_json TEXT NOT NULL,
    created_at TEXT NOT NULL, result_json TEXT NOT NULL
  );
`);

  // server/services/nfl-research.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_feature_ablation_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
  seasons_json TEXT NOT NULL, policy_json TEXT NOT NULL, results_json TEXT NOT NULL
)`);
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_residual_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
  data_fingerprint TEXT NOT NULL, result_json TEXT NOT NULL
)`);

  // server/services/nfl-risk-lab.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_risk_lab_predictions (
  season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL, away TEXT NOT NULL,
  horizon TEXT NOT NULL, model_id TEXT NOT NULL, epoch_id INTEGER NOT NULL,
  captured_at TEXT NOT NULL, engine_version TEXT, feature_hash TEXT NOT NULL,
  features_json TEXT NOT NULL, market_margin REAL NOT NULL,
  predicted_residual REAL NOT NULL, predicted_uncertainty REAL,
  market_total REAL, predicted_total_residual REAL, predicted_total_uncertainty REAL,
  actual_margin REAL, target_residual REAL, settled_at TEXT, trained_at TEXT,
  actual_total REAL, target_total_residual REAL,
  selected_for_training INTEGER,
  PRIMARY KEY(season,week,home,horizon,model_id,epoch_id)
);
CREATE TABLE IF NOT EXISTS nfl_risk_lab_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, model_id TEXT NOT NULL, epoch_id INTEGER NOT NULL,
  version TEXT NOT NULL UNIQUE, parent_version TEXT, schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL, trained_through_season INTEGER, trained_through_week INTEGER,
  state_json TEXT NOT NULL, state_hash TEXT NOT NULL, metrics_json TEXT,
  UNIQUE(model_id,epoch_id,trained_through_season,trained_through_week)
);
`);

  // server/services/nfl-rookies.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_rookie_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL,
    player_id INTEGER,
    player_name TEXT NOT NULL,
    position TEXT NOT NULL,
    college TEXT,
    evidence_type TEXT NOT NULL,
    values_json TEXT NOT NULL,
    available_at TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    source TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    verification_state TEXT NOT NULL,
    UNIQUE(season,player_name,evidence_type,source_ref)
  );
`);

  // server/services/nfl-roster-strength.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_external_player_grades (
    provider TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL,
    team TEXT NOT NULL, player_id TEXT NOT NULL, player_name TEXT,
    position TEXT, overall_grade REAL, facets_json TEXT,
    captured_at TEXT NOT NULL, source_ref TEXT,
    PRIMARY KEY (provider,season,week,team,player_id)
  );
  CREATE TABLE IF NOT EXISTS player_team_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL,
    player_name TEXT NOT NULL, from_team TEXT, to_team TEXT, detected_at TEXT NOT NULL
  );
`);

  // server/services/nfl-signal-reliability.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_signal_reliability_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL UNIQUE,
  target_season INTEGER NOT NULL,
  target_week INTEGER NOT NULL,
  trained_through_season INTEGER NOT NULL,
  trained_through_week INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  examples_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  UNIQUE(target_season,target_week)
)`);

  // server/services/nfl-sim-calibration.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_sim_calibration_artifacts (
    artifact_id TEXT PRIMARY KEY,version TEXT NOT NULL,season INTEGER NOT NULL,week INTEGER NOT NULL,
    evidence_hash TEXT NOT NULL,plays INTEGER NOT NULL,games INTEGER NOT NULL,
    calibration_json TEXT NOT NULL,created_at TEXT NOT NULL
  );
`);

  // server/services/nfl-team-card.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_team_cards (
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    team TEXT NOT NULL,
    opponent TEXT NOT NULL,
    horizon TEXT NOT NULL,
    version TEXT NOT NULL,
    cutoff TEXT NOT NULL,
    evidence_hash TEXT NOT NULL,
    card_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (season,week,team,horizon,version)
  );
`);

  // server/services/nfl-total-calibration.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_total_calibrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_version TEXT NOT NULL, trained_from INTEGER NOT NULL, trained_through INTEGER NOT NULL,
  created_at TEXT NOT NULL, sample_size INTEGER NOT NULL,
  intercept REAL NOT NULL, edge_slope REAL NOT NULL,
  metrics_json TEXT NOT NULL, reliability_json TEXT NOT NULL,
  UNIQUE(model_version, trained_from, trained_through)
)`);

  // server/services/nfl-tweet-line-correlation.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_tweet_line_watch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id INTEGER NOT NULL, team TEXT NOT NULL, event_id TEXT NOT NULL,
  market TEXT NOT NULL, side TEXT NOT NULL,
  baseline_line REAL, baseline_captured_at TEXT NOT NULL,
  tweet_text TEXT, tweet_published_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_line REAL, resolved_captured_at TEXT,
  moved_points REAL, ai_explanation TEXT, ai_confidence REAL,
  created_at TEXT NOT NULL,
  UNIQUE(news_id, event_id, market, side)
)`);

  // server/services/nfl-user-bets.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_user_bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL, week INTEGER NOT NULL,
    matchup TEXT NOT NULL, market TEXT NOT NULL,
    selection TEXT NOT NULL, side TEXT, line REAL, american_price INTEGER,
    model_probability REAL, implied_probability REAL, edge REAL,
    units_staked REAL DEFAULT 1, note TEXT, placed_at TEXT NOT NULL
  );
`);

  // server/services/nfl-weather-history.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_game_weather_forecast_history (
  season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL,
  kickoff TEXT NOT NULL, lead_days INTEGER NOT NULL,
  wind_kmh REAL, gust_kmh REAL, precip_mm REAL, temp_c REAL,
  source TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, week, home, lead_days)
)`);

  // server/services/nfl-weather.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_game_weather (
  season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL,
  kickoff TEXT NOT NULL, temp_c REAL, wind_kmh REAL, gust_kmh REAL, precip_mm REAL,
  source TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, week, home)
)`);

  // server/services/nfl-weekly-feature-store.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_feature_dictionary (
    feature_id TEXT PRIMARY KEY,entity_type TEXT NOT NULL,source_family TEXT NOT NULL,
    source_metric TEXT NOT NULL,transform TEXT NOT NULL,version TEXT NOT NULL,
    description TEXT NOT NULL,created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nfl_team_feature_vectors (
    season INTEGER NOT NULL,week INTEGER NOT NULL,team TEXT NOT NULL,version TEXT NOT NULL,
    cutoff TEXT NOT NULL,evidence_hash TEXT NOT NULL,feature_count INTEGER NOT NULL,
    coverage REAL NOT NULL,vector_json TEXT NOT NULL,missing_json TEXT NOT NULL,created_at TEXT NOT NULL,
    PRIMARY KEY(season,week,team,version)
  );
  CREATE TABLE IF NOT EXISTS nfl_player_feature_vectors (
    season INTEGER NOT NULL,week INTEGER NOT NULL,player_id TEXT NOT NULL,player_name TEXT,
    position TEXT,team TEXT,version TEXT NOT NULL,cutoff TEXT NOT NULL,evidence_hash TEXT NOT NULL,
    feature_count INTEGER NOT NULL,coverage REAL NOT NULL,vector_json TEXT NOT NULL,
    missing_json TEXT NOT NULL,created_at TEXT NOT NULL,
    PRIMARY KEY(season,week,player_id,version)
  );
`);
}

/** Guarded column additions, verbatim guards translated to plain JS. */
export function alters(db) {
  // server/services/nfl-news-signal.js (lines 45-51). Both columns are already
  // in the CREATE above, so these only fire on a database born before them.
  const signalColumns = new Set(db.prepare('PRAGMA table_info(nfl_news_signals)').all().map(item => item.name));
  if (!signalColumns.has('verification_state')) {
    db.exec(`ALTER TABLE nfl_news_signals ADD COLUMN verification_state TEXT NOT NULL DEFAULT 'quarantined'`);
  }
  if (!signalColumns.has('verification_reason')) {
    db.exec(`ALTER TABLE nfl_news_signals ADD COLUMN verification_reason TEXT NOT NULL DEFAULT 'source not evaluated'`);
  }

  // server/services/nfl-officials.js (lines 46-49): dynamic helper loop,
  // reproduced as the concrete columns it is called with, in the same order.
  // Neither is in the CREATE, so both fire on a fresh database.
  for (const [col, type] of [['home_team', 'TEXT'], ['away_team', 'TEXT']]) {
    const cols = db.prepare(`PRAGMA table_info(nfl_officials)`).all().map(c => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE nfl_officials ADD COLUMN ${col} ${type}`);
  }

  // server/services/nfl-online-neural.js (lines 66-76). All three columns are
  // already in the CREATEs above; no-ops on a fresh database.
  const neuralExampleColumns = new Set(db.prepare('PRAGMA table_info(nfl_online_neural_examples)').all().map(item => item.name));
  if (!neuralExampleColumns.has('engine_version')) {
    db.exec('ALTER TABLE nfl_online_neural_examples ADD COLUMN engine_version TEXT');
  }
  if (!neuralExampleColumns.has('epoch_id')) {
    db.exec('ALTER TABLE nfl_online_neural_examples ADD COLUMN epoch_id INTEGER NOT NULL DEFAULT 1');
  }
  const neuralArtifactColumns = new Set(db.prepare('PRAGMA table_info(nfl_online_neural_artifacts)').all().map(item => item.name));
  if (!neuralArtifactColumns.has('epoch_id')) {
    db.exec('ALTER TABLE nfl_online_neural_artifacts ADD COLUMN epoch_id INTEGER NOT NULL DEFAULT 1');
  }

  // server/services/nfl-page-explain-audit.js (line 34). The source runs the
  // ALTER unguarded inside try/catch on every import; a table_info guard has
  // the same effect (the column is not in the CREATE, so it fires on a fresh
  // database and the stored CREATE text gains it, exactly as before).
  const pageExplainColumns = db.prepare('PRAGMA table_info(nfl_page_explain_audits)').all().map(c => c.name);
  if (!pageExplainColumns.includes('tool_calls_json')) {
    db.exec(`ALTER TABLE nfl_page_explain_audits ADD COLUMN tool_calls_json TEXT`);
  }

  // server/services/nfl-player-state.js (lines 59-63). event_key is already in
  // the CREATE (NOT NULL UNIQUE), so on a fresh database neither the column
  // nor the unique index is created; the index stays inside this guard because
  // the source only creates it on the upgrade path.
  const eventColumns = new Set(db.prepare('PRAGMA table_info(nfl_player_roster_events)').all().map(column => column.name));
  if (!eventColumns.has('event_key')) {
    db.exec(`ALTER TABLE nfl_player_roster_events ADD COLUMN event_key TEXT`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_nfl_roster_event_key ON nfl_player_roster_events(event_key)`);
  }

  // server/services/nfl-prop-clv.js (lines 60-69): dynamic helper loop,
  // reproduced as the concrete columns in the same order. None are in the
  // CREATE, so all ten fire on a fresh database.
  const quoteCols = new Set(db.prepare('PRAGMA table_info(nfl_prop_clv)').all().map(c => c.name));
  for (const [column, type] of [
    ['commence_time', 'TEXT'], ['home_team', 'TEXT'], ['away_team', 'TEXT'],
    ['closing_fair_probability', 'REAL'], ['clv_probability', 'REAL'],
    ['model_match_status', 'TEXT'], ['model_match_reason', 'TEXT'],
    ['matched_player_id', 'TEXT'], ['capture_horizon_hours', 'INTEGER'],
    ['settlement_reason', 'TEXT']
  ]) {
    if (!quoteCols.has(column)) db.exec(`ALTER TABLE nfl_prop_clv ADD COLUMN ${column} ${type}`);
  }

  // server/services/nfl-props.js (lines 60-63): dynamic helper loop on
  // nfl_total_picks. Neither column is in the CREATE; both fire on a fresh database.
  for (const [name, type] of [['calibration_eligible', 'INTEGER'], ['calibrated_probability', 'REAL']]) {
    const cols = db.prepare('PRAGMA table_info(nfl_total_picks)').all().map(c => c.name);
    if (!cols.includes(name)) db.exec(`ALTER TABLE nfl_total_picks ADD COLUMN ${name} ${type}`);
  }

  // server/services/nfl-risk-lab.js (lines 209-216): dynamic helper loop. All
  // five columns are already in the CREATE above; no-ops on a fresh database.
  const riskPredictionColumns = new Set(db.prepare('PRAGMA table_info(nfl_risk_lab_predictions)').all()
    .map(item => item.name));
  for (const [column, type] of [
    ['market_total', 'REAL'], ['predicted_total_residual', 'REAL'], ['predicted_total_uncertainty', 'REAL'],
    ['actual_total', 'REAL'], ['target_total_residual', 'REAL']
  ]) {
    if (!riskPredictionColumns.has(column)) db.exec(`ALTER TABLE nfl_risk_lab_predictions ADD COLUMN ${column} ${type}`);
  }
}

/** `CREATE INDEX IF NOT EXISTS` and `CREATE TRIGGER IF NOT EXISTS`, verbatim. */
export function indexesAndTriggers(db) {
  // server/services/nfl-news-signal.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_nfl_news_signal_player ON nfl_news_signals(player_key,published_at);
  CREATE INDEX IF NOT EXISTS idx_nfl_news_signal_team ON nfl_news_signals(team,published_at);
`);

  // server/services/nfl-officials.js
  db.exec(`CREATE INDEX IF NOT EXISTS idx_off_season ON nfl_officials(season, week)`);

  // server/services/nfl-online-neural.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_online_neural_training
    ON nfl_online_neural_examples(head,trained_at,season,week);
`);

  // server/services/nfl-orthogonal-specialists.js
  db.exec(`
  CREATE TRIGGER IF NOT EXISTS nfl_orthogonal_artifacts_no_update
    BEFORE UPDATE ON nfl_orthogonal_specialist_artifacts
    BEGIN SELECT RAISE(ABORT, 'orthogonal specialist artifacts are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_orthogonal_artifacts_no_delete
    BEFORE DELETE ON nfl_orthogonal_specialist_artifacts
    BEGIN SELECT RAISE(ABORT, 'orthogonal specialist artifacts are immutable'); END;
`);

  // server/services/nfl-page-explain-audit.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_page_explain_lookup
    ON nfl_page_explain_audits(route,section,subview,created_at);
`);

  // server/services/nfl-pbp.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_twf_team ON nfl_team_week_features(team, season, week);
  CREATE INDEX IF NOT EXISTS idx_pwf_player ON nfl_player_week_features(player_id, season, week);
  CREATE INDEX IF NOT EXISTS idx_pwf_team ON nfl_player_week_features(team, season, week);
`);

  // server/services/nfl-pick-explanation-audit.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_pick_explanation_lookup
    ON nfl_pick_explanation_audits(season,week,matchup,market,selection,created_at);
`);

  // server/services/nfl-pick-watch.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_pick_watch_log_check
    ON nfl_pick_watch_log(pick_source, season, week, rank, checked_at);
`);

  // server/services/nfl-player-state.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_nfl_roster_snapshot_cutoff
    ON nfl_roster_snapshots(captured_at,team);
  CREATE INDEX IF NOT EXISTS idx_nfl_roster_event_cutoff
    ON nfl_player_roster_events(effective_at,player_id);
`);

  // server/services/nfl-postgame-truth.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_nfl_postgame_truth_week ON nfl_postgame_truth_packets(season,week,home);
  CREATE TRIGGER IF NOT EXISTS nfl_postgame_truth_no_update BEFORE UPDATE ON nfl_postgame_truth_packets
    BEGIN SELECT RAISE(ABORT, 'postgame truth packets are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_postgame_truth_no_delete BEFORE DELETE ON nfl_postgame_truth_packets
    BEGIN SELECT RAISE(ABORT, 'postgame truth packets are immutable'); END;
`);

  // server/services/nfl-prop-clv.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_prop_clv_settle ON nfl_prop_clv(settled, season, week);
`);

  // server/services/nfl-props.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_nfl_prop_quotes_event
    ON nfl_prop_quote_snapshots(event_id,market,captured_at);
`);

  // server/services/nfl-quote-tape.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_nfl_quote_event_time
    ON nfl_quote_tape(provider_event_id,market,snapshot_at);
  CREATE INDEX IF NOT EXISTS idx_nfl_quote_match_time
    ON nfl_quote_tape(home_team,away_team,commence_time,snapshot_at);
  CREATE TRIGGER IF NOT EXISTS nfl_quote_batches_no_update BEFORE UPDATE ON nfl_quote_batches
    BEGIN SELECT RAISE(ABORT, 'quote batches are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_quote_batches_no_delete BEFORE DELETE ON nfl_quote_batches
    BEGIN SELECT RAISE(ABORT, 'quote batches are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_quote_tape_no_update BEFORE UPDATE ON nfl_quote_tape
    BEGIN SELECT RAISE(ABORT, 'quote tape is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_quote_tape_no_delete BEFORE DELETE ON nfl_quote_tape
    BEGIN SELECT RAISE(ABORT, 'quote tape is immutable'); END;
`);

  // server/services/nfl-risk-lab.js
  db.exec(`CREATE INDEX IF NOT EXISTS idx_risk_lab_training
  ON nfl_risk_lab_predictions(epoch_id,model_id,trained_at,season,week);
`);

  // server/services/nfl-rookies.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_rookie_evidence_cutoff
    ON nfl_rookie_evidence(season,available_at,player_id);
`);

  // server/services/nfl-roster-strength.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_external_player_grade_cutoff
    ON nfl_external_player_grades(provider,season,week,team);
`);

  // server/services/nfl-sim-calibration.js
  db.exec(`
  CREATE TRIGGER IF NOT EXISTS nfl_sim_calibration_no_update BEFORE UPDATE ON nfl_sim_calibration_artifacts
    BEGIN SELECT RAISE(ABORT, 'simulation calibration artifacts are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_sim_calibration_no_delete BEFORE DELETE ON nfl_sim_calibration_artifacts
    BEGIN SELECT RAISE(ABORT, 'simulation calibration artifacts are immutable'); END;
`);

  // server/services/nfl-team-card.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_nfl_team_cards_cutoff ON nfl_team_cards(cutoff,season,week);
  CREATE TRIGGER IF NOT EXISTS nfl_team_cards_no_update BEFORE UPDATE ON nfl_team_cards
    BEGIN SELECT RAISE(ABORT, 'frozen team cards are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_team_cards_no_delete BEFORE DELETE ON nfl_team_cards
    BEGIN SELECT RAISE(ABORT, 'frozen team cards are immutable'); END;
`);

  // server/services/nfl-weekly-feature-store.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_nfl_team_feature_vector_cutoff
    ON nfl_team_feature_vectors(season,week,team);
  CREATE INDEX IF NOT EXISTS idx_nfl_player_feature_vector_cutoff
    ON nfl_player_feature_vectors(season,week,team,position);
  CREATE TRIGGER IF NOT EXISTS nfl_team_feature_vectors_no_update BEFORE UPDATE ON nfl_team_feature_vectors
    BEGIN SELECT RAISE(ABORT, 'weekly team feature vectors are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_team_feature_vectors_no_delete BEFORE DELETE ON nfl_team_feature_vectors
    BEGIN SELECT RAISE(ABORT, 'weekly team feature vectors are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_player_feature_vectors_no_update BEFORE UPDATE ON nfl_player_feature_vectors
    BEGIN SELECT RAISE(ABORT, 'weekly player feature vectors are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_player_feature_vectors_no_delete BEFORE DELETE ON nfl_player_feature_vectors
    BEGIN SELECT RAISE(ABORT, 'weekly player feature vectors are immutable'); END;
`);
}

/**
 * Default rows that lived inside DDL blocks. None in this batch: every
 * INSERT OR IGNORE / INSERT OR REPLACE in these 34 files is runtime data
 * (ingest, artifact persistence, the import-time policy-archive row in
 * nfl-prop-clv.js) and stays where it is — see the manifest's notes.
 */
export function seeds(db) { // eslint-disable-line no-unused-vars
}
