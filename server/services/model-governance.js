/** Shared evidence, feature-contract and champion/challenger governance. */
import { createHash } from 'node:crypto';
import { db, rows, run } from '../db/index.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS model_feature_contracts (
    sport TEXT NOT NULL, market TEXT NOT NULL, feature_key TEXT NOT NULL,
    source TEXT NOT NULL, availability_rule TEXT NOT NULL, cadence TEXT NOT NULL,
    max_staleness_minutes INTEGER, missing_behavior TEXT NOT NULL,
    allowed_modes_json TEXT NOT NULL, leakage_risk TEXT NOT NULL,
    contract_version TEXT NOT NULL, registered_at TEXT NOT NULL,
    PRIMARY KEY (sport,market,feature_key,contract_version)
  );
  CREATE TABLE IF NOT EXISTS model_evidence_manifests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sport TEXT NOT NULL, market TEXT NOT NULL,
    model_version TEXT NOT NULL, cutoff_at TEXT NOT NULL, captured_at TEXT NOT NULL,
    manifest_hash TEXT NOT NULL UNIQUE, manifest_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS model_registry (
    sport TEXT NOT NULL, market TEXT NOT NULL, role TEXT NOT NULL,
    model_version TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL,
    metrics_json TEXT, registered_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (sport,market,role)
  );
  CREATE TABLE IF NOT EXISTS model_gate_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sport TEXT NOT NULL, market TEXT NOT NULL,
    model_version TEXT NOT NULL, created_at TEXT NOT NULL, audit_hash TEXT NOT NULL UNIQUE,
    verdict TEXT NOT NULL, gates_json TEXT NOT NULL, evidence_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS model_registry_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sport TEXT NOT NULL, market TEXT NOT NULL,
    action TEXT NOT NULL, changed_at TEXT NOT NULL, before_json TEXT, after_json TEXT NOT NULL,
    gate_audit_id INTEGER, reason TEXT NOT NULL
  );
`);

const VERSION = 'evidence-contract-v1';
const MODES = JSON.stringify(['training', 'replay', 'forward_shadow', 'production']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = value => { try { return JSON.parse(value); } catch { return null; } };

const CONTRACTS = [
  ['NFL', 'spread', 'market_consensus', 'timestamped sportsbook quotes', 'quote_at <= kickoff and quote_at <= prediction_at', 'on refresh', 30, 'abstain', 'critical'],
  ['NFL', 'spread', 'team_efficiency', 'nflverse play-by-play', 'season/week strictly before target week', 'weekly', 10080, 'abstain family', 'critical'],
  ['NFL', 'spread', 'quarterback_state', 'pregame roster snapshot', 'captured before kickoff; never reconstructed from final starter', 'on refresh', 720, 'abstain adjustment', 'critical'],
  ['NFL', 'spread', 'injury_availability', 'weekly injury report', 'exact season/week designation available before kickoff', 'daily', 1440, 'shrink to durability prior', 'high'],
  ['NFL', 'spread', 'roster_continuity', 'pregame roster snapshots', 'compare only snapshots captured before target game', 'weekly', 10080, 'abstain adjustment', 'high'],
  ['NFL', 'spread', 'weather_venue', 'pregame weather and venue feed', 'forecast captured before kickoff', 'hourly', 180, 'neutral weather', 'medium'],
  ['NFL', 'total', 'market_total', 'timestamped sportsbook quotes', 'quote_at <= kickoff and quote_at <= prediction_at', 'on refresh', 30, 'abstain', 'critical'],
  ['NFL', 'total', 'pace_and_script', 'prior play-by-play and usage', 'all games/weeks strictly before target week', 'weekly', 10080, 'abstain family', 'critical'],
  ['NFL', 'player_props', 'canonical_player_identity', 'players crosswalk', 'GSIS and internal id mapping must exist before prediction', 'weekly', 10080, 'abstain player', 'critical'],
  ['NFL', 'player_props', 'pregame_role_eligibility', 'depth chart + prior usage snapshot', 'captured before kickoff; target-week participation is forbidden', 'on refresh', 720, 'abstain market', 'critical'],
  ['NFL', 'player_props', 'joint_event_state', 'shared player-week engine', 'all usage and efficiency rows strictly before target week', 'weekly', 10080, 'abstain player', 'critical'],
  ['NFL', 'player_props', 'sportsbook_quote', 'timestamped player prop quote', 'quote_at < kickoff and quote_at <= prediction_at', 'on refresh', 30, 'model-only; never report edge or ROI', 'critical'],
  ['NFL', 'player_props', 'game_environment', 'pregame spread, total, weather and venue snapshot', 'snapshot timestamp <= prediction_at and < kickoff', 'on refresh', 180, 'neutral game script', 'high'],
  ['MLB', 'nrfi', 'first_inning_market', 'timestamped sportsbook quotes', 'quote_at < first pitch and quote_at <= prediction_at', 'on refresh', 15, 'abstain', 'critical'],
  ['MLB', 'nrfi', 'confirmed_lineup', 'MLB pregame boxscore', 'lineup captured before first pitch', 'on refresh', 30, 'abstain', 'critical'],
  ['MLB', 'nrfi', 'probable_starters', 'MLB probable starter feed', 'snapshot captured before first pitch', 'on refresh', 60, 'abstain', 'critical'],
  ['MLB', 'nrfi', 'park_weather_umpire', 'pregame context feeds', 'captured before first pitch', 'hourly', 120, 'shrink to league prior', 'high'],
  ['MLB', 'pitcher_strikeouts', 'pitcher_workload', 'prior pitcher game logs', 'date strictly before slate date', 'daily', 1440, 'abstain', 'critical'],
  ['MLB', 'pitcher_strikeouts', 'opponent_lineup_k', 'confirmed lineup + prior batter logs', 'lineup pregame; batter outcomes strictly earlier', 'on refresh', 30, 'abstain', 'critical'],
  ['MLB', 'pitcher_strikeouts', 'strikeout_price', 'timestamped player prop quote', 'quote_at < first pitch and quote_at <= prediction_at', 'on refresh', 15, 'abstain', 'critical'],
  ['MLB', 'batter_total_bases', 'plate_appearance_context', 'confirmed batting order', 'lineup captured before first pitch', 'on refresh', 30, 'abstain', 'critical'],
  ['MLB', 'batter_total_bases', 'pitch_mix_matchup', 'prior pitch/batter observations', 'date strictly before slate date', 'daily', 1440, 'shrink to population prior', 'high'],
  ['MLB', 'batter_total_bases', 'total_bases_price', 'timestamped player prop quote', 'quote_at < first pitch and quote_at <= prediction_at', 'on refresh', 15, 'abstain', 'critical']
];

function seedContracts() {
  for (const [sport, market, key, source, availability, cadence, stale, missing, risk] of CONTRACTS) {
    run(`INSERT INTO model_feature_contracts
      (sport,market,feature_key,source,availability_rule,cadence,max_staleness_minutes,
       missing_behavior,allowed_modes_json,leakage_risk,contract_version,registered_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT DO NOTHING`,
      sport, market, key, source, availability, cadence, stale, missing, MODES, risk, VERSION);
  }
}

function seedRegistry() {
  const defaults = [
    ['NFL', 'spread', 'champion', 'market-consensus-v1', 'baseline', 'Market remains the strongest unseen margin baseline.'],
    ['NFL', 'spread', 'challenger', 'nfl-ensemble-v1', 'research_only', 'Must beat the market and pass calibration plus forward CLV gates.'],
    ['NFL', 'total', 'champion', 'market-consensus-v1', 'baseline', 'Totals ensemble is too sparse for production promotion.'],
    ['NFL', 'total', 'challenger', 'nfl-total-ensemble-v1', 'blocked', 'Too few active total models and no proven residual edge.'],
    ['NFL', 'player_props', 'champion', 'shared-event-structural-v1', 'baseline', 'Shared structural event state; no betting promotion without real priced evidence.'],
    ['NFL', 'player_props', 'challenger', 'player-head-registry-v1', 'research_only', 'Must pass chronological accuracy, calibration, null, coverage and forward CLV gates.'],
    ['MLB', 'nrfi', 'challenger', 'mlb-nrfi-v2-cutoff', 'blocked', 'Overconfident retrospective audit; real priced forward evidence required.'],
    ['MLB', 'pitcher_strikeouts', 'challenger', 'mlb-k-v2-cutoff', 'blocked', 'No cutoff-valid validation sample or priced forward evidence.'],
    ['MLB', 'batter_total_bases', 'challenger', 'mlb-tb-v2-cutoff', 'blocked', 'No cutoff-valid validation sample or priced forward evidence.']
  ];
  for (const x of defaults) run(`INSERT INTO model_registry
    (sport,market,role,model_version,state,reason,registered_at,updated_at)
    VALUES (?,?,?,?,?,?,datetime('now'),datetime('now')) ON CONFLICT DO NOTHING`, ...x);
}

seedContracts();
seedRegistry();

export function featureContracts(sport = null) {
  const data = sport
    ? rows('SELECT * FROM model_feature_contracts WHERE sport=? ORDER BY market,feature_key', String(sport).toUpperCase())
    : rows('SELECT * FROM model_feature_contracts ORDER BY sport,market,feature_key');
  return data.map(x => ({ ...x, allowed_modes: parse(x.allowed_modes_json), allowed_modes_json: undefined }));
}

export function registry(sport = null) {
  const data = sport
    ? rows('SELECT * FROM model_registry WHERE sport=? ORDER BY market,role', String(sport).toUpperCase())
    : rows('SELECT * FROM model_registry ORDER BY sport,market,role');
  return data.map(x => ({ ...x, metrics: parse(x.metrics_json), metrics_json: undefined }));
}

export function captureEvidenceManifest({ sport, market, modelVersion, cutoffAt, manifest }) {
  if (!sport || !market || !modelVersion || !cutoffAt) throw new Error('sport, market, modelVersion and cutoffAt are required');
  validateEvidenceCutoff(manifest, cutoffAt);
  const normalized = { sport: String(sport).toUpperCase(), market, model_version: modelVersion,
    cutoff_at: cutoffAt, manifest };
  const manifestHash = hash(normalized);
  run(`INSERT INTO model_evidence_manifests
    (sport,market,model_version,cutoff_at,captured_at,manifest_hash,manifest_json)
    VALUES (?,?,?,?,datetime('now'),?,?) ON CONFLICT DO NOTHING`, normalized.sport, market,
    modelVersion, cutoffAt, manifestHash, JSON.stringify(manifest));
  return rows('SELECT * FROM model_evidence_manifests WHERE manifest_hash=?', manifestHash)[0];
}

/** Rejects outcome-era timestamps hidden anywhere inside an evidence payload. */
export function validateEvidenceCutoff(value, cutoffAt, path = 'manifest') {
  const cutoff = Date.parse(cutoffAt);
  if (!Number.isFinite(cutoff)) throw new Error('cutoffAt must be a valid timestamp');
  const visit = (node, keyPath) => {
    if (Array.isArray(node)) return node.forEach((x, i) => visit(x, `${keyPath}[${i}]`));
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      const childPath = `${keyPath}.${key}`;
      if (typeof child === 'string' && (/_at$|timestamp|fetched_at|data_cutoff/i.test(key))) {
        const at = Date.parse(child);
        if (Number.isFinite(at) && at > cutoff) throw new Error(`${childPath} occurs after the evidence cutoff`);
      }
      visit(child, childPath);
    }
  };
  visit(value, path);
  return true;
}

export function evidenceManifests(sport, limit = 20) {
  return rows(`SELECT id,sport,market,model_version,cutoff_at,captured_at,manifest_hash,manifest_json
    FROM model_evidence_manifests WHERE sport=? ORDER BY id DESC LIMIT ?`, String(sport).toUpperCase(), Number(limit))
    .map(x => ({ ...x, manifest: parse(x.manifest_json), manifest_json: undefined }));
}

export function recordGateAudit({ sport, market, modelVersion, gates, evidence }) {
  const normalized = { sport: String(sport).toUpperCase(), market, model_version: modelVersion, gates, evidence };
  const auditHash = hash(normalized);
  const passed = gates.length > 0 && gates.every(g => g.passed === true);
  const verdict = passed ? 'promotion_eligible' : 'blocked';
  run(`INSERT INTO model_gate_audits
    (sport,market,model_version,created_at,audit_hash,verdict,gates_json,evidence_json)
    VALUES (?,?,?,datetime('now'),?,?,?,?) ON CONFLICT DO NOTHING`, normalized.sport, market,
    modelVersion, auditHash, verdict, JSON.stringify(gates), JSON.stringify(evidence));
  return rows('SELECT * FROM model_gate_audits WHERE audit_hash=?', auditHash).map(unpackGate)[0];
}

const unpackGate = x => x && ({ ...x, gates: parse(x.gates_json), evidence: parse(x.evidence_json),
  gates_json: undefined, evidence_json: undefined });

export function gateAudits(sport, limit = 20) {
  return rows('SELECT * FROM model_gate_audits WHERE sport=? ORDER BY id DESC LIMIT ?', String(sport).toUpperCase(), Number(limit)).map(unpackGate);
}

export function updateRegistry({ sport, market, role, modelVersion, state, reason, metrics = null }) {
  if (!['champion', 'challenger'].includes(role)) throw new Error('role must be champion or challenger');
  run(`INSERT INTO model_registry
    (sport,market,role,model_version,state,reason,metrics_json,registered_at,updated_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))
    ON CONFLICT(sport,market,role) DO UPDATE SET model_version=excluded.model_version,
      state=excluded.state,reason=excluded.reason,metrics_json=excluded.metrics_json,updated_at=datetime('now')`,
    String(sport).toUpperCase(), market, role, modelVersion, state, reason, JSON.stringify(metrics));
  return registry(sport).find(x => x.market === market && x.role === role);
}

export function promoteEligibleAudit(auditId, expectedSport = null) {
  const audit = unpackGate(rows('SELECT * FROM model_gate_audits WHERE id=?', Number(auditId))[0]);
  if (!audit) throw new Error('gate audit not found');
  if (expectedSport && audit.sport !== String(expectedSport).toUpperCase()) throw new Error('gate audit belongs to a different sport');
  if (audit.verdict !== 'promotion_eligible' || !audit.gates?.every(x => x.passed === true)) {
    throw new Error('a model cannot be promoted until every immutable gate passes');
  }
  const before = registry(audit.sport).filter(x => x.market === audit.market);
  updateRegistry({ sport: audit.sport, market: audit.market, role: 'champion', modelVersion: audit.model_version,
    state: 'production', reason: `Promoted from immutable gate audit #${audit.id}.`, metrics: audit.evidence });
  const after = registry(audit.sport).filter(x => x.market === audit.market);
  run(`INSERT INTO model_registry_history
    (sport,market,action,changed_at,before_json,after_json,gate_audit_id,reason)
    VALUES (?,?,?,datetime('now'),?,?,?,?)`, audit.sport, audit.market, 'promote', JSON.stringify(before),
    JSON.stringify(after), audit.id, `All ${audit.gates.length} promotion gates passed.`);
  return { audit, registry: after };
}

export function registryHistory(sport, limit = 30) {
  return rows('SELECT * FROM model_registry_history WHERE sport=? ORDER BY id DESC LIMIT ?', String(sport).toUpperCase(), Number(limit))
    .map(x => ({ ...x, before: parse(x.before_json), after: parse(x.after_json), before_json: undefined, after_json: undefined }));
}

export const governanceProtocol = () => ({
  contract_version: VERSION,
  rules: [
    'Every feature declares when it becomes available and how missing or stale values behave.',
    'Every evaluation is chronological; final holdouts are immutable and opened once.',
    'Market baselines remain champion until a challenger wins unseen accuracy, calibration, CLV and forward gates.',
    'A blocked or stale input causes abstention; it is never silently reconstructed from final outcomes.',
    'ROI requires real stored prices and excludes retrospective or quarantined rows.'
  ]
});
