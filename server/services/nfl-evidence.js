/**
 * NFL evidence inventory and validation firewall.
 *
 * This service does not manufacture missing history. It reports exactly which
 * pregame artifacts are present, distinguishes an import timestamp from a
 * preserved quote timestamp, and marks replay periods that have already been
 * opened during development. The UI can therefore say "development replay"
 * instead of implying that repeatedly inspected seasons remain untouched.
 */
import { db, rows, run } from '../db/index.js';
import { hasKey } from './odds-api.js';
import { FORWARD_SAMPLE_TARGETS } from './nfl-policy.js';

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

const SOURCES = [
  ['odds-live', 'Sportsbook snapshots', 'market', '2020-06-06', '5–10 minutes',
    'Only quotes observed at or before the decision cutoff are admissible.',
    'Abstain from priced claims; retain context-only evidence.', 'conditional',
    'Opening, multi-book, best-price, movement and CLV evidence require preserved bookmaker snapshots.'],
  ['nflverse-pbp', 'nflverse play-by-play', 'team efficiency', '1999', 'after game final',
    'Only completed games from weeks strictly before the prediction may enter features.',
    'Efficiency components abstain.', 'connected',
    'Team and player efficiency, success, explosiveness, drives and game state.'],
  ['nflverse-ngs', 'NFL Next Gen Stats via nflverse', 'player tracking summaries', '2016', 'nightly when available',
    'Only prior-week player summaries may enter a pregame feature.',
    'Tracking-derived player features remain unavailable.', 'connected',
    'CPOE, time to throw, separation, YAC over expected and rushing over expected.'],
  ['nflverse-snaps', 'PFR snap counts via nflverse', 'player participation', '2012', 'four times daily when available',
    'Target-week postgame snap counts are forbidden; use strictly prior games.',
    'Replacement value widens uncertainty.', 'connected',
    'Prior snap share supplies role and replacement-value denominators.'],
  ['nflverse-depth', 'Weekly depth charts via nflverse', 'roster role', '2001', 'daily when available',
    'Use the latest snapshot published before kickoff.',
    'Player availability stays shadow-only.', 'partial',
    'The local warehouse currently has historical depth snapshots only where explicitly synced.'],
  ['injury-reports', 'Archived injury and practice reports', 'availability', '2009', 'source dependent',
    'A report needs a preserved publication/observation time before it can affect production.',
    'Do not infer healthy; mark availability unknown.', 'partial',
    'Historical rows without original publication timestamps are research context, not production proof.'],
  ['nws-weather', 'Decision-time weather forecast', 'weather', null, 'forecast snapshots',
    'Use the forecast visible at the decision cutoff, never observed postgame weather.',
    'Weather component abstains or uses roof-only context.', 'not_configured',
    'A forecast snapshot adapter is required before weather can be provenance-complete.']
];

for (const s of SOURCES) run(`INSERT INTO nfl_source_registry
  (source_id,label,evidence_kind,available_from,live_cadence,cutoff_rule,missing_behavior,status,detail,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
  ON CONFLICT(source_id) DO UPDATE SET label=excluded.label,evidence_kind=excluded.evidence_kind,
    available_from=excluded.available_from,live_cadence=excluded.live_cadence,
    cutoff_rule=excluded.cutoff_rule,missing_behavior=excluded.missing_behavior,
    status=excluded.status,detail=excluded.detail,updated_at=excluded.updated_at`, ...s);

const WINDOWS = [
  ['nfl-dev-2021-2025', '2021,2022,2023,2024,2025', 'development_opened', 'model development and diagnostics',
    '2026-08-06T00:00:00.000Z', 'These seasons have been repeatedly inspected and used to select model and policy changes.'],
  ['nfl-forward-2026', '2026', 'forward_holdout', 'prospective frozen evaluation', null,
    'Only decisions captured before kickoff under a version-pinned policy count as untouched evidence.']
];
for (const w of WINDOWS) run(`INSERT INTO nfl_validation_windows
  (window_id,seasons,state,purpose,opened_at,reason,created_at)
  VALUES (?,?,?,?,?,?,datetime('now')) ON CONFLICT(window_id) DO NOTHING`, ...w);

const scalar = (sql, ...args) => rows(sql, ...args)[0]?.n ?? 0;
const tableExists = name => Boolean(rows("SELECT 1 present FROM sqlite_master WHERE type='table' AND name=?", name)[0]);
const tableCount = (name, where = '', ...args) => tableExists(name)
  ? scalar(`SELECT COUNT(*) n FROM ${name}${where ? ` WHERE ${where}` : ''}`, ...args) : 0;

function seasonCoverage() {
  return rows(`SELECT season,
      COUNT(*) AS games,
      SUM(spread IS NOT NULL) AS spread_games,
      SUM(spread_odds IS NOT NULL) AS priced_games,
      SUM(open_spread IS NOT NULL) AS opening_line_games,
      SUM(COALESCE(book_count,0) > 1) AS multi_book_games,
      SUM(fetched_at IS NOT NULL) AS imported_timestamp_games,
      SUM(team_score IS NOT NULL) AS completed_games
    FROM game_lines WHERE home=1 AND season BETWEEN 2021 AND 2026
    GROUP BY season ORDER BY season`).map(x => {
      const snapshots = scalar(`SELECT COUNT(DISTINCT event_id) n FROM nfl_line_snapshots
        WHERE commence_time >= ? AND commence_time < ?`, `${x.season}-08-01`, `${x.season + 1}-03-01`);
      const pregame = scalar(`SELECT COUNT(*) n FROM nfl_pregame_snapshot_history WHERE season=?`, x.season);
      const injuries = scalar(`SELECT COUNT(*) n FROM nfl_injuries WHERE season=?`, x.season);
      const depth = scalar(`SELECT COUNT(*) n FROM nfl_depth WHERE season=?`, x.season);
      const snaps = scalar(`SELECT COUNT(*) n FROM nfl_snaps WHERE season=?`, x.season);
      const ngs = scalar(`SELECT COUNT(*) n FROM nfl_ngs WHERE season=?`, x.season);
      return {
        ...x, preserved_line_events: snapshots, pregame_snapshots: pregame,
        injury_rows: injuries, depth_rows: depth, snap_rows: snaps, ngs_rows: ngs,
        quote_provenance: snapshots > 0 ? 'preserved_snapshots' : x.season < 2026 ? 'import_only' : 'current_board_only',
        replay_status: x.season <= 2025 ? 'development_only' : 'forward_holdout'
      };
    });
}

export function validationFirewall() {
  const windows = rows('SELECT * FROM nfl_validation_windows ORDER BY window_id');
  const trialCounts = {
    saved_season_replays: tableCount('nfl_replay_runs'),
    canonical_policy_audits: tableCount('nfl_policy_audits'),
    registered_experiments: tableCount('nfl_model_experiments'),
    family_ablation_audits: tableCount('nfl_feature_ablation_audits'),
    calibration_fits: tableCount('nfl_cover_calibrations'),
    ai_replay_runs: tableCount('nfl_ai_replay_runs'),
    recorded_gate_audits: tableCount('model_gate_audits', 'sport=?', 'NFL')
  };
  // Promotion evidence counts selected, independent decisions only. Earlier
  // versions inserted the same event once per evidence horizon; counting raw
  // rows made six correlated snapshots look like six future bets.
  const forward = tableExists('shadow_decisions') ? rows(`SELECT
      COUNT(DISTINCT CASE WHEN decision='observe'
        THEN event_key||'|'||market||'|'||model_version END) decisions,
      COUNT(DISTINCT CASE WHEN decision='observe' AND result IN ('Won','Lost','Push')
        THEN event_key||'|'||market||'|'||model_version END) settled
    FROM shadow_decisions WHERE sport='NFL' AND captured_at IS NOT NULL`)[0] : { decisions: 0, settled: 0 };
  const totalTrials = Object.values(trialCounts).reduce((a, b) => a + Number(b || 0), 0);
  return {
    state: 'development_replay_opened', windows, trial_counts: trialCounts, total_recorded_trials: totalTrials,
    forward: { decisions: Number(forward.decisions || 0), settled: Number(forward.settled || 0), target: FORWARD_SAMPLE_TARGETS.overall },
    untouched_gate_passed: Number(forward.settled || 0) >= FORWARD_SAMPLE_TARGETS.overall,
    multiple_testing: {
      required: totalTrials > 1,
      status: 'track_all_trials',
      note: 'Historical ROI must be discounted for model and policy selection. The frozen 2026 forward ledger is the promotion evidence.'
    },
    canonical_label: 'Outcome-blind development replay — not an untouched profitability test'
  };
}

export function nflEvidenceCoverage() {
  const seasons = seasonCoverage();
  const historical = seasons.filter(x => x.season <= 2025);
  const sources = rows('SELECT * FROM nfl_source_registry ORDER BY evidence_kind,source_id').map(s =>
    s.source_id === 'odds-live' ? { ...s, status: hasKey() ? 'connected' : 'not_configured' } : s);
  const gaps = [
    {
      id: 'historical_quote_snapshots', priority: 1, severity: 'critical',
      title: 'Historical decision-time prices are not reconstructed',
      actual: `${historical.reduce((n, x) => n + x.opening_line_games, 0)} opening-line games · ${historical.reduce((n, x) => n + x.multi_book_games, 0)} multi-book games`,
      requirement: 'Opening, T-24h, T-60m and close snapshots with bookmaker and price',
      effect: 'Blocks honest line-movement, best-price and CLV claims for 2021–25.'
    },
    {
      id: 'injury_history', priority: 2, severity: 'critical',
      title: 'Availability history is incomplete and not publication-timestamped',
      actual: historical.filter(x => x.injury_rows > 0).map(x => x.season).join(', ') || 'none',
      requirement: 'Backfill reports and retain published_at/observed_at for every designation',
      effect: 'Player replacement adjustments remain shadow-only.'
    },
    {
      id: 'depth_history', priority: 3, severity: 'warn',
      title: 'Depth-chart history is sparse in the local warehouse',
      actual: historical.filter(x => x.depth_rows > 0).map(x => x.season).join(', ') || 'none',
      requirement: 'Weekly cutoff-safe GSIS-linked depth charts',
      effect: 'Starter-to-replacement deltas carry wider uncertainty.'
    },
    {
      id: 'forecast_weather', priority: 4, severity: 'warn',
      title: 'Weather is not stored as a decision-time forecast',
      actual: 'Game context exists; forecast provenance does not',
      requirement: 'Immutable forecast payload at every evidence horizon',
      effect: 'Weather stays descriptive and cannot independently promote a bet.'
    }
  ];
  return {
    generated_at: new Date().toISOString(), status: gaps.some(x => x.severity === 'critical') ? 'blocked' : 'ready',
    sources, seasons, gaps, firewall: validationFirewall(),
    rules: [
      'Missing evidence is never converted to a zero-valued football feature.',
      'Target-week outcomes and postgame participation are forbidden.',
      'Import timestamps do not prove that a quote existed before kickoff.',
      '2021–25 remains useful for development diagnostics but cannot re-qualify as untouched.'
    ]
  };
}
