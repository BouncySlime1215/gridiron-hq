/**
 * Legacy schema fragment: NFL services, nfl-advanced.js through nfl-model-watch.js.
 *
 * Lifted verbatim from the import-time DDL of the modules in `sources`. See
 * server/db/schema/README.md for the contract and nfl-a-to-m.manifest.json for
 * per-file provenance (line ranges, IF NOT EXISTS additions, conflicts, and
 * what was deliberately left in place).
 */

export const sources = [
  'server/services/nfl-advanced.js',
  'server/services/nfl-ai-replay.js',
  'server/services/nfl-auto-picks.js',
  'server/services/nfl-bitemporal.js',
  'server/services/nfl-blind-audit.js',
  'server/services/nfl-candidate-analysis.js',
  'server/services/nfl-capture-dispatch.js',
  'server/services/nfl-clv.js',
  'server/services/nfl-coaches.js',
  'server/services/nfl-cover-calibration.js',
  'server/services/nfl-engine-backfill.js',
  'server/services/nfl-engine-registry.js',
  'server/services/nfl-ensemble.js',
  'server/services/nfl-espn-line-watch.js',
  'server/services/nfl-espn-pbp.js',
  'server/services/nfl-event-archive.js',
  'server/services/nfl-evidence.js',
  'server/services/nfl-execution.js',
  'server/services/nfl-experiments.js',
  'server/services/nfl-expert-council.js',
  'server/services/nfl-external-ratings.js',
  'server/services/nfl-feature-coverage.js',
  'server/services/nfl-formations.js',
  'server/services/nfl-live-ledger.js',
  'server/services/nfl-model-growth.js',
  'server/services/nfl-model-watch.js'
];

/** ONLY `CREATE TABLE IF NOT EXISTS ...` statements, verbatim. */
export function tables(db) {
  // server/services/nfl-advanced.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_ngs (
    season INTEGER, week INTEGER, player_id TEXT, kind TEXT,
    player_name TEXT, team TEXT, position TEXT, stats TEXT,
    PRIMARY KEY (season, week, player_id, kind)
  );
  CREATE TABLE IF NOT EXISTS nfl_pfr_adv (
    season INTEGER, week INTEGER, player_name TEXT, kind TEXT,
    team TEXT, opponent TEXT, stats TEXT,
    PRIMARY KEY (season, week, player_name, kind)
  );
  CREATE TABLE IF NOT EXISTS nfl_snaps (
    season INTEGER, week INTEGER, player TEXT, team TEXT, position TEXT,
    offense_snaps INTEGER, offense_pct REAL,
    defense_snaps INTEGER, defense_pct REAL, st_pct REAL,
    PRIMARY KEY (season, week, player, team)
  );
  CREATE TABLE IF NOT EXISTS nfl_depth (
    season INTEGER, week INTEGER, team TEXT, gsis_id TEXT, player_name TEXT,
    pos_abb TEXT, pos_rank INTEGER, pos_slot TEXT, captured TEXT,
    PRIMARY KEY (season, week, team, gsis_id, pos_abb)
  );
  CREATE TABLE IF NOT EXISTS nfl_injuries (
    season INTEGER, week INTEGER, gsis_id TEXT, team TEXT, full_name TEXT,
    position TEXT, report_status TEXT, practice_status TEXT, injury TEXT,
    modified_at TEXT,
    PRIMARY KEY (season, week, gsis_id)
  );
`);

  // server/services/nfl-ai-replay.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_ai_replay_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, status TEXT NOT NULL,
  seasons_json TEXT NOT NULL, budget_usd REAL NOT NULL, estimated_cost_usd REAL NOT NULL,
  progress_json TEXT NOT NULL, result_json TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS nfl_ai_replay_reviews (
  run_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL,
  home TEXT NOT NULL, away TEXT NOT NULL, selection TEXT NOT NULL, packet_json TEXT NOT NULL,
  review_json TEXT, outcome TEXT, units REAL, PRIMARY KEY(run_id, ordinal)
);
CREATE TABLE IF NOT EXISTS nfl_ai_replay_candidate_cache (
  season INTEGER NOT NULL, cache_version TEXT NOT NULL, created_at TEXT NOT NULL,
  candidates_json TEXT NOT NULL, PRIMARY KEY(season, cache_version)
);`);

  // server/services/nfl-auto-picks.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_auto_picks (
    season INTEGER NOT NULL, week INTEGER NOT NULL, rank INTEGER NOT NULL,
    home_team TEXT, away_team TEXT, matchup TEXT,
    selection TEXT, side TEXT, line REAL, american_price INTEGER,
    model_probability REAL, implied_probability REAL, probability_difference REAL,
    detail TEXT, units_staked REAL DEFAULT 1, selected_at TEXT NOT NULL,
    PRIMARY KEY (season, week, rank)
  );
`);
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_pick_decisions (
    season INTEGER NOT NULL, week INTEGER NOT NULL, policy_id TEXT NOT NULL,
    policy_version TEXT NOT NULL, matchup TEXT NOT NULL, selection TEXT,
    market TEXT NOT NULL, line REAL, american_price INTEGER, book TEXT,
    quote_at TEXT, quote_source TEXT, edge REAL, disagreement REAL,
    eligible INTEGER NOT NULL, abstention_reason TEXT, policy_rank INTEGER,
    feature_snapshot_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
    PRIMARY KEY (season, week, policy_id, matchup, market, selection)
  );
`);

  // server/services/nfl-bitemporal.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_feature_revisions (
    revision_id  TEXT PRIMARY KEY,
    entity       TEXT NOT NULL,
    feature      TEXT NOT NULL,
    valid_from   TEXT,
    published_at TEXT NOT NULL,
    observed_at  TEXT NOT NULL,
    provenance   TEXT NOT NULL,
    source_id    TEXT NOT NULL,
    value_json   TEXT NOT NULL,
    raw_hash     TEXT NOT NULL,
    version      TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
`);

  // server/services/nfl-blind-audit.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_blind_audit_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    label TEXT NOT NULL,
    spec_hash TEXT NOT NULL UNIQUE,
    spec_json TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    data_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'registered',
    next_ordinal INTEGER NOT NULL DEFAULT 0,
    final_json TEXT
  );
  CREATE TABLE IF NOT EXISTS nfl_blind_audit_weeks (
    run_id INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    opened_at TEXT NOT NULL,
    prior_chain_hash TEXT NOT NULL,
    result_hash TEXT NOT NULL,
    chain_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    fault_json TEXT NOT NULL,
    PRIMARY KEY (run_id, ordinal),
    UNIQUE (run_id, season, week)
  );
  CREATE TABLE IF NOT EXISTS nfl_blind_input_mutations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    operation TEXT NOT NULL,
    changed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nfl_blind_audit_week_performance (
    run_id INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    freeze_check_ms INTEGER NOT NULL,
    compute_ms INTEGER NOT NULL,
    persist_ms INTEGER NOT NULL,
    total_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, ordinal)
  );
`);
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_blind_audit_retries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, ordinal INTEGER, at TEXT NOT NULL, error TEXT NOT NULL
)`);

  // server/services/nfl-candidate-analysis.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_candidate_robustness_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL,
  seasons_json TEXT NOT NULL, created_at TEXT NOT NULL, result_json TEXT NOT NULL
)`);

  // server/services/nfl-capture-dispatch.js: nfl_capture_triggers deliberately NOT
  // lifted — see manifest "conflicts". Its lazily-called ensureCaptureTriggerTable()
  // never runs at import, and server/migrations/014_profit_execution_triggers.js
  // creates the table (with CHECK constraints) unguarded, so creating it here would
  // make that migration throw on a fresh database.

  // server/services/nfl-clv.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_bet_log (
    bet_id INTEGER PRIMARY KEY AUTOINCREMENT,
    placed_at TEXT NOT NULL,
    event_id TEXT NOT NULL, commence_time TEXT,
    home_team TEXT, away_team TEXT,
    market TEXT NOT NULL, side TEXT NOT NULL,
    line REAL, price INTEGER NOT NULL, book TEXT,
    stake_units REAL DEFAULT 1,
    source TEXT, model_edge REAL,
    closing_line REAL, closing_price INTEGER, closing_fair_prob REAL,
    clv_points REAL, clv_pct REAL, graded_at TEXT,
    result TEXT, units_won REAL
  );
`);

  // server/services/nfl-coaches.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_team_coaches (
  season INTEGER NOT NULL, team TEXT NOT NULL, coach TEXT NOT NULL,
  games INTEGER NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, team)
)`);

  // server/services/nfl-cover-calibration.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_cover_calibrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_version TEXT NOT NULL, trained_from INTEGER NOT NULL, trained_through INTEGER NOT NULL,
  created_at TEXT NOT NULL, sample_size INTEGER NOT NULL,
  intercept REAL NOT NULL, edge_slope REAL NOT NULL,
  metrics_json TEXT NOT NULL, reliability_json TEXT NOT NULL,
  UNIQUE(model_version, trained_from, trained_through)
)`);

  // server/services/nfl-engine-backfill.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_engine_backfill_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL, finished_at TEXT,
  start_season INTEGER NOT NULL, end_season INTEGER NOT NULL,
  ingest_requested INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, detail_json TEXT
);
CREATE TABLE IF NOT EXISTS nfl_engine_backfill_checkpoints (
  run_id INTEGER NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL,
  stage TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, detail_json TEXT,
  PRIMARY KEY(run_id,season,week,stage),
  FOREIGN KEY(run_id) REFERENCES nfl_engine_backfill_runs(id)
);
CREATE TABLE IF NOT EXISTS nfl_historical_engine_replay (
  season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL, away TEXT NOT NULL,
  engine_version TEXT NOT NULL, generated_at TEXT NOT NULL,
  market_margin REAL, projected_margin REAL, projected_total REAL,
  actual_margin REAL NOT NULL, actual_total REAL NOT NULL,
  classification TEXT NOT NULL DEFAULT 'historical_development_replay',
  PRIMARY KEY(season,week,home,engine_version)
);
CREATE TABLE IF NOT EXISTS nfl_historical_signal_replay (
  season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL, away TEXT NOT NULL,
  signal_id TEXT NOT NULL, signal_version TEXT NOT NULL, generated_at TEXT NOT NULL,
  market_margin REAL, projected_margin REAL, projected_total REAL,
  actual_margin REAL NOT NULL, actual_total REAL NOT NULL,
  classification TEXT NOT NULL DEFAULT 'historical_shadow_signal',
  PRIMARY KEY(season,week,home,signal_id,signal_version)
);
`);

  // server/services/nfl-engine-registry.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_engine_artifacts (
  engine_version TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  season INTEGER NOT NULL,
  trained_through_week INTEGER NOT NULL,
  predicts_week INTEGER NOT NULL,
  epoch_id INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  data_hash TEXT NOT NULL,
  component_json TEXT NOT NULL,
  UNIQUE(season,predicts_week,data_hash)
);
CREATE TABLE IF NOT EXISTS nfl_learning_epochs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_epoch_id INTEGER,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','archived')),
  reason TEXT NOT NULL,
  reset_policy_json TEXT NOT NULL,
  FOREIGN KEY(parent_epoch_id) REFERENCES nfl_learning_epochs(id)
);
`);

  // server/services/nfl-ensemble.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_ensemble_fit_artifacts (
  artifact_key TEXT PRIMARY KEY, model_version TEXT NOT NULL,
  data_fingerprint TEXT NOT NULL, cutoff TEXT NOT NULL,
  weighting TEXT NOT NULL, created_at TEXT NOT NULL, result_json TEXT NOT NULL
)`);

  // server/services/nfl-espn-line-watch.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS espn_line_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    observed_at TEXT NOT NULL,
    season INTEGER NOT NULL, week INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    home_team TEXT, away_team TEXT, commence_time TEXT,
    home_spread REAL, total REAL,
    prev_home_spread REAL, prev_total REAL,
    spread_delta REAL, total_delta REAL,
    -- What the spread move is worth in win probability, priced against the real
    -- NFL margin distribution. A half point across 3 is not a half point across 5.
    spread_move_value REAL,
    first_sighting INTEGER NOT NULL DEFAULT 0
  );
`);

  // server/services/nfl-espn-pbp.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_play_by_play (
  event_id     TEXT NOT NULL,
  play_id      TEXT NOT NULL,
  season       INTEGER,
  week         INTEGER,
  sequence     INTEGER,
  period       INTEGER,
  clock_seconds INTEGER,
  offense      TEXT,
  defense      TEXT,
  down         INTEGER,
  distance     INTEGER,
  yards_to_endzone INTEGER,
  play_type    TEXT,
  yards_gained INTEGER,
  is_turnover  INTEGER,
  is_scoring   INTEGER,
  is_penalty   INTEGER,
  home_score   INTEGER,
  away_score   INTEGER,
  shotgun      INTEGER,
  no_huddle    INTEGER,
  pass_depth   TEXT,
  pass_direction TEXT,
  text         TEXT,
  fetched_at   TEXT,
  PRIMARY KEY (event_id, play_id)
)`);

  // server/services/nfl-event-archive.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_verified_events (
    event_key TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    season INTEGER,
    week INTEGER,
    team TEXT,
    other_team TEXT,
    player_id TEXT,
    pfr_id TEXT,
    player_name TEXT,
    position TEXT,
    status_before TEXT,
    status_after TEXT,
    body_part TEXT,
    occurred_at TEXT NOT NULL,
    available_at TEXT NOT NULL,
    time_precision TEXT NOT NULL,
    source TEXT NOT NULL,
    source_url TEXT NOT NULL,
    verification_state TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    archive_version TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

  // server/services/nfl-evidence.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_source_registry (
    source_id TEXT PRIMARY KEY, label TEXT NOT NULL, evidence_kind TEXT NOT NULL,
    available_from TEXT, live_cadence TEXT, cutoff_rule TEXT NOT NULL,
    missing_behavior TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nfl_validation_windows (
    window_id TEXT PRIMARY KEY, seasons TEXT NOT NULL, state TEXT NOT NULL,
    purpose TEXT NOT NULL, opened_at TEXT, reason TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

  // server/services/nfl-execution.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_execution_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  routed_at    TEXT NOT NULL,
  event_id     TEXT,
  matchup      TEXT,
  market       TEXT NOT NULL,
  side         TEXT NOT NULL,
  stake_units  REAL NOT NULL,
  chosen_book  TEXT NOT NULL,
  chosen_line  REAL,
  chosen_price INTEGER,
  median_price INTEGER,
  worst_price  INTEGER,
  books_compared INTEGER,
  saved_vs_median_pct REAL,
  saved_vs_worst_pct  REAL,
  note         TEXT
)`);

  // server/services/nfl-experiments.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_model_experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, hypothesis TEXT NOT NULL, created_at TEXT NOT NULL,
  spec_hash TEXT NOT NULL UNIQUE, spec_json TEXT NOT NULL,
  discovery_json TEXT, validation_json TEXT, holdout_json TEXT,
  validation_passed INTEGER, verdict TEXT
)`);

  // server/services/nfl-expert-council.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_weekly_expert_examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_run_id INTEGER NOT NULL,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    home TEXT NOT NULL,
    away TEXT NOT NULL,
    expert_id TEXT NOT NULL,
    council_version TEXT NOT NULL,
    engine_version TEXT,
    evidence_hash TEXT NOT NULL,
    evidence_cutoff TEXT NOT NULL,
    observed INTEGER NOT NULL,
    forecast_residual REAL,
    uncertainty REAL,
    actual_residual REAL,
    directional_correct INTEGER,
    squared_error REAL,
    authority TEXT NOT NULL,
    missing_reason TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(audit_run_id,season,week,home,expert_id)
  );
  CREATE TABLE IF NOT EXISTS nfl_expert_forward_predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL, away TEXT NOT NULL,
    expert_id TEXT NOT NULL, horizon TEXT NOT NULL, council_version TEXT NOT NULL,
    engine_version TEXT, evidence_hash TEXT NOT NULL, evidence_cutoff TEXT NOT NULL,
    captured_at TEXT NOT NULL, market_margin REAL NOT NULL, observed INTEGER NOT NULL,
    forecast_residual REAL, uncertainty REAL, authority TEXT NOT NULL, missing_reason TEXT,
    payload_json TEXT NOT NULL,
    UNIQUE(season,week,home,expert_id,horizon)
  );
  CREATE TABLE IF NOT EXISTS nfl_expert_forward_settlements (
    prediction_id INTEGER PRIMARY KEY,
    settled_at TEXT NOT NULL, actual_margin REAL NOT NULL, actual_residual REAL NOT NULL,
    directional_correct INTEGER, squared_error REAL,
    FOREIGN KEY(prediction_id) REFERENCES nfl_expert_forward_predictions(id) ON DELETE RESTRICT
  );
`);

  // server/services/nfl-external-ratings.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_external_ratings (
  source TEXT NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL, team TEXT NOT NULL,
  rating REAL NOT NULL, detail_json TEXT, fetched_at TEXT NOT NULL,
  PRIMARY KEY (source, season, week, team)
)`);

  // server/services/nfl-feature-coverage.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_feature_coverage_snapshots (
    season INTEGER NOT NULL,week INTEGER NOT NULL,version TEXT NOT NULL,
    evidence_hash TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,
    PRIMARY KEY(season,week,version)
  );
`);

  // server/services/nfl-formations.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_play_formations (
  game_id      TEXT NOT NULL,
  play_id      INTEGER NOT NULL,
  season       INTEGER,
  possession   TEXT,
  offense_formation TEXT,
  offense_personnel TEXT,
  defense_personnel TEXT,
  defenders_in_box  INTEGER,
  pass_rushers      INTEGER,
  PRIMARY KEY (game_id, play_id)
)`);
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_play_charting (
  game_id      TEXT NOT NULL,
  play_id      INTEGER NOT NULL,
  season       INTEGER, week INTEGER,
  qb_location  TEXT,
  backfield    INTEGER,
  defense_box  INTEGER,
  no_huddle    INTEGER, motion INTEGER, play_action INTEGER,
  screen       INTEGER, rpo INTEGER, trick INTEGER,
  out_of_pocket INTEGER, throw_away INTEGER, contested INTEGER,
  PRIMARY KEY (game_id, play_id)
)`);

  // server/services/nfl-live-ledger.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_live_possession_predictions (
    prediction_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,season INTEGER NOT NULL,week INTEGER NOT NULL,
    home_team TEXT NOT NULL,away_team TEXT NOT NULL,sequence INTEGER NOT NULL,
    possession_index INTEGER NOT NULL,classification TEXT NOT NULL,
    state_hash TEXT NOT NULL,team_card_hash TEXT NOT NULL,model_version TEXT NOT NULL,
    simulator_version TEXT,simulator_calibration_hash TEXT,
    state_json TEXT NOT NULL,prediction_json TEXT NOT NULL,evidence_json TEXT NOT NULL,
    source_observed_at TEXT,captured_at TEXT NOT NULL,
    UNIQUE(event_id,sequence,classification,model_version)
  );
  CREATE TABLE IF NOT EXISTS nfl_live_possession_settlements (
    prediction_id TEXT PRIMARY KEY,settled_at TEXT NOT NULL,home_won REAL NOT NULL,
    home_probability REAL NOT NULL,brier REAL NOT NULL,log_loss REAL NOT NULL,
    final_home_score INTEGER NOT NULL,final_away_score INTEGER NOT NULL,
    settlement_json TEXT NOT NULL,
    FOREIGN KEY(prediction_id) REFERENCES nfl_live_possession_predictions(prediction_id) ON DELETE RESTRICT
  );
`);

  // server/services/nfl-model-growth.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_model_growth_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  season INTEGER NOT NULL,
  finalized_week INTEGER,
  status TEXT NOT NULL,
  before_hash TEXT NOT NULL,
  after_hash TEXT,
  detail_json TEXT
)`);

  // server/services/nfl-model-watch.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_model_watch_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT NOT NULL,
  seasons TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  alerts INTEGER NOT NULL DEFAULT 0
)`);
}

/** Guarded column additions, verbatim guards translated to plain JS. */
export function alters(db) {
  // server/services/nfl-advanced.js (lines 64-68)
  const snapColumns = new Set(db.prepare('PRAGMA table_info(nfl_snaps)').all().map(x => x.name));
  if (!snapColumns.has('defense_snaps')) db.exec('ALTER TABLE nfl_snaps ADD COLUMN defense_snaps INTEGER');
  if (!snapColumns.has('defense_pct')) db.exec('ALTER TABLE nfl_snaps ADD COLUMN defense_pct REAL');
  const injuryColumns = new Set(db.prepare('PRAGMA table_info(nfl_injuries)').all().map(x => x.name));
  if (!injuryColumns.has('modified_at')) db.exec('ALTER TABLE nfl_injuries ADD COLUMN modified_at TEXT');

  // server/services/nfl-auto-picks.js (lines 29-39): dynamic column helper loop,
  // reproduced with the concrete (name, type) pairs it is called with, in order.
  for (const [name, type] of [
    ['policy_id', 'TEXT'], ['policy_version', 'TEXT'], ['book', 'TEXT'], ['quote_at', 'TEXT'],
    ['quote_source', 'TEXT'], ['feature_snapshot_json', 'TEXT'],
    ['voided_at', 'TEXT'], ['void_reason', 'TEXT']
  ]) {
    const cols = db.prepare('PRAGMA table_info(nfl_auto_picks)').all().map(c => c.name);
    if (!cols.includes(name)) db.exec(`ALTER TABLE nfl_auto_picks ADD COLUMN ${name} ${type}`);
  }

  // server/services/nfl-engine-registry.js (lines 46-48, 61-65). The source guards
  // with tableExists()/columnExists() helpers built on sqlite_master + PRAGMA
  // table_info; reproduced inline with the same semantics.
  const tableExists = table => Boolean(db.prepare(`SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?`).get(table));
  const columnExists = (table, column) => tableExists(table)
    && db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column);
  if (!columnExists('nfl_engine_artifacts', 'epoch_id')) {
    db.exec(`ALTER TABLE nfl_engine_artifacts ADD COLUMN epoch_id INTEGER NOT NULL DEFAULT 1`);
  }
  // These three tables are owned by other fragments (weekly-learning.js /
  // nfl-online-neural.js); the registry upgrades them regardless of import order.
  for (const table of ['weekly_ensemble_fits', 'nfl_online_neural_artifacts', 'nfl_online_neural_examples']) {
    if (tableExists(table) && !columnExists(table, 'epoch_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN epoch_id INTEGER NOT NULL DEFAULT 1`);
    }
  }

  // server/services/nfl-espn-pbp.js (lines 76-80): the source's guard is a
  // try/catch around each ALTER (duplicate-column error is the expected no-op).
  for (const col of ['shotgun INTEGER', 'no_huddle INTEGER', 'pass_depth TEXT',
    'pass_direction TEXT']) {
    try { db.prepare(`ALTER TABLE nfl_play_by_play ADD COLUMN ${col}`).run(); }
    catch { /* already present */ }
  }

  // server/services/nfl-live-ledger.js (lines 39-46)
  const predictionColumns = db.prepare('PRAGMA table_info(nfl_live_possession_predictions)').all()
    .map(column => column.name);
  if (!predictionColumns.includes('simulator_version')) {
    db.exec('ALTER TABLE nfl_live_possession_predictions ADD COLUMN simulator_version TEXT');
  }
  if (!predictionColumns.includes('simulator_calibration_hash')) {
    db.exec('ALTER TABLE nfl_live_possession_predictions ADD COLUMN simulator_calibration_hash TEXT');
  }
}

/**
 * The input tables whose mutations nfl-blind-audit.js journals. Verbatim copy of
 * that module's INPUT_TABLES (lines 73-84); the trigger loop below is a verbatim
 * copy of installInputMutationJournal() (lines 88-120), existence guard included.
 */
const BLIND_AUDIT_INPUT_TABLES = [
  'players', 'player_week_usage', 'game_lines', 'nflverse_player_positions',
  'nfl_team_week_features', 'nfl_player_week_features', 'nfl_depth',
  'nfl_injuries', 'nfl_ngs', 'nfl_pfr_adv', 'nfl_snaps', 'nfl_teams',
  'weekly_ensemble_fits', 'nfl_ensemble_fit_artifacts', 'nfl_line_snapshots',
  'nfl_news_signals', 'news_items', 'nfl_external_player_grades',
  'nfl_rookie_evidence', 'nfl_team_coaches', 'player_team_changes',
  'nfl_player_roster_events', 'nfl_roster_snapshots', 'nfl_play_by_play',
  'nfl_play_formations', 'nfl_play_charting', 'nfl_verified_events',
  'nfl_team_feature_vectors', 'nfl_player_feature_vectors', 'nfl_team_cards',
  'nfl_quote_tape'
];

/** `CREATE INDEX IF NOT EXISTS` and `CREATE TRIGGER IF NOT EXISTS`, verbatim. */
export function indexesAndTriggers(db) {
  // server/services/nfl-advanced.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_snaps_team ON nfl_snaps(season, week, team);
  CREATE INDEX IF NOT EXISTS idx_depth_player ON nfl_depth(gsis_id, season, week);
`);

  // server/services/nfl-bitemporal.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_feature_revisions_read
    ON nfl_feature_revisions(entity, feature, published_at, observed_at);
  CREATE TRIGGER IF NOT EXISTS nfl_feature_revisions_no_update BEFORE UPDATE ON nfl_feature_revisions
    BEGIN SELECT RAISE(ABORT, 'feature revisions are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_feature_revisions_no_delete BEFORE DELETE ON nfl_feature_revisions
    BEGIN SELECT RAISE(ABORT, 'feature revisions are append-only'); END;
`);

  // server/services/nfl-blind-audit.js — installInputMutationJournal(), verbatim.
  // NOTE: the tables it fans out over are owned by many fragments; the assembler
  // runs every fragment's tables() before this, so the existence guard normally
  // passes for all 31 (see manifest notes for how that differs from a legacy
  // fresh build, where import order left 4 of them without triggers).
  {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(item => item.name));
    for (const table of BLIND_AUDIT_INPUT_TABLES) {
      if (!tables.has(table)) continue;
      const prefix = `nfl_blind_input_${table}`;
      if (table === 'players') {
        db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${prefix}_insert AFTER INSERT ON ${table}
        WHEN NEW.gsis_id IS NOT NULL BEGIN
          INSERT INTO nfl_blind_input_mutations(table_name,operation,changed_at)
          VALUES ('${table}','insert',datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS ${prefix}_update AFTER UPDATE OF id,name,position,gsis_id ON ${table}
        WHEN OLD.gsis_id IS NOT NULL OR NEW.gsis_id IS NOT NULL BEGIN
          INSERT INTO nfl_blind_input_mutations(table_name,operation,changed_at)
          VALUES ('${table}','update',datetime('now'));
        END;
        CREATE TRIGGER IF NOT EXISTS ${prefix}_delete AFTER DELETE ON ${table}
        WHEN OLD.gsis_id IS NOT NULL BEGIN
          INSERT INTO nfl_blind_input_mutations(table_name,operation,changed_at)
          VALUES ('${table}','delete',datetime('now'));
        END;
      `);
        continue;
      }
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${prefix}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
      BEGIN
        INSERT INTO nfl_blind_input_mutations(table_name,operation,changed_at)
        VALUES ('${table}','${operation.toLowerCase()}',datetime('now'));
      END;
    `);
    }
  }

  // server/services/nfl-capture-dispatch.js: idx_capture_triggers_state NOT lifted —
  // owned by server/migrations/014_profit_execution_triggers.js (see manifest).

  // server/services/nfl-clv.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_betlog_event ON nfl_bet_log(event_id, market, side);
`);

  // server/services/nfl-engine-registry.js
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_nfl_one_active_learning_epoch
  ON nfl_learning_epochs(status) WHERE status='active';
`);

  // server/services/nfl-espn-line-watch.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_espn_moves_event ON espn_line_moves(event_id, observed_at);
  CREATE INDEX IF NOT EXISTS idx_espn_moves_time ON espn_line_moves(observed_at);
`);

  // server/services/nfl-espn-pbp.js
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pbp_season_week ON nfl_play_by_play(season, week)`);

  // server/services/nfl-event-archive.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_nfl_verified_events_team_time
    ON nfl_verified_events(team,available_at,event_type);
  CREATE INDEX IF NOT EXISTS idx_nfl_verified_events_player_time
    ON nfl_verified_events(player_id,available_at,event_type);
  CREATE TRIGGER IF NOT EXISTS nfl_verified_events_no_update BEFORE UPDATE ON nfl_verified_events
    BEGIN SELECT RAISE(ABORT, 'verified event archive is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_verified_events_no_delete BEFORE DELETE ON nfl_verified_events
    BEGIN SELECT RAISE(ABORT, 'verified event archive is immutable'); END;
`);

  // server/services/nfl-expert-council.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_nfl_weekly_expert_cutoff
    ON nfl_weekly_expert_examples(season,week,expert_id);
  CREATE TRIGGER IF NOT EXISTS nfl_weekly_expert_examples_no_update
    BEFORE UPDATE ON nfl_weekly_expert_examples BEGIN
      SELECT RAISE(ABORT, 'weekly expert examples are immutable');
    END;
  CREATE TRIGGER IF NOT EXISTS nfl_weekly_expert_examples_no_delete
    BEFORE DELETE ON nfl_weekly_expert_examples BEGIN
      SELECT RAISE(ABORT, 'weekly expert examples are immutable');
    END;
  CREATE TRIGGER IF NOT EXISTS nfl_expert_forward_predictions_no_update BEFORE UPDATE ON nfl_expert_forward_predictions
    BEGIN SELECT RAISE(ABORT, 'forward expert predictions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_expert_forward_predictions_no_delete BEFORE DELETE ON nfl_expert_forward_predictions
    BEGIN SELECT RAISE(ABORT, 'forward expert predictions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_expert_forward_settlements_no_update BEFORE UPDATE ON nfl_expert_forward_settlements
    BEGIN SELECT RAISE(ABORT, 'forward expert settlements are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_expert_forward_settlements_no_delete BEFORE DELETE ON nfl_expert_forward_settlements
    BEGIN SELECT RAISE(ABORT, 'forward expert settlements are immutable'); END;
`);

  // server/services/nfl-feature-coverage.js
  db.exec(`
  CREATE TRIGGER IF NOT EXISTS nfl_feature_coverage_snapshots_no_update
    BEFORE UPDATE ON nfl_feature_coverage_snapshots BEGIN
      SELECT RAISE(ABORT, 'feature coverage snapshots are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_feature_coverage_snapshots_no_delete
    BEFORE DELETE ON nfl_feature_coverage_snapshots BEGIN
      SELECT RAISE(ABORT, 'feature coverage snapshots are immutable'); END;
`);

  // server/services/nfl-formations.js
  db.exec(`CREATE INDEX IF NOT EXISTS idx_form_season ON nfl_play_formations(season, offense_formation)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chart_season ON nfl_play_charting(season)`);

  // server/services/nfl-live-ledger.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_nfl_live_ledger_event ON nfl_live_possession_predictions(event_id,sequence);
  CREATE TRIGGER IF NOT EXISTS nfl_live_predictions_no_update BEFORE UPDATE ON nfl_live_possession_predictions
    BEGIN SELECT RAISE(ABORT, 'live possession predictions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_live_predictions_no_delete BEFORE DELETE ON nfl_live_possession_predictions
    BEGIN SELECT RAISE(ABORT, 'live possession predictions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_live_settlements_no_update BEFORE UPDATE ON nfl_live_possession_settlements
    BEGIN SELECT RAISE(ABORT, 'live possession settlements are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_live_settlements_no_delete BEFORE DELETE ON nfl_live_possession_settlements
    BEGIN SELECT RAISE(ABORT, 'live possession settlements are immutable'); END;
`);
}

/**
 * Default rows that lived inside DDL blocks (`INSERT OR IGNORE ...`), verbatim.
 * None in this batch: the default-row inserts in nfl-evidence.js (source registry
 * upsert, validation windows) and nfl-engine-registry.js (initial active learning
 * epoch) are parameterized run() calls outside any DDL block, so they stay in
 * their modules — see manifest "left in place" notes.
 */
export function seeds(db) { // eslint-disable-line no-unused-vars
}
