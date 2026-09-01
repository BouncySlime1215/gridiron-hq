/** Possession-by-possession immutable live prediction ledger. */
import crypto from 'node:crypto';
import { db, rows, run } from '../db/index.js';
import { simulateRemainder } from './nfl-drive-sim.js';
import { matchupTeamCards } from './nfl-team-card.js';

export const LIVE_LEDGER_VERSION = 'nfl-live-possession-ledger-v1';

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

const predictionColumns = db.prepare('PRAGMA table_info(nfl_live_possession_predictions)').all()
  .map(column => column.name);
if (!predictionColumns.includes('simulator_version')) {
  db.exec('ALTER TABLE nfl_live_possession_predictions ADD COLUMN simulator_version TEXT');
}
if (!predictionColumns.includes('simulator_calibration_hash')) {
  db.exec('ALTER TABLE nfl_live_possession_predictions ADD COLUMN simulator_calibration_hash TEXT');
}

const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
};
const sha = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const r6 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(6);

function gameForEvent(eventId) {
  const meta = rows(`SELECT MAX(season) season,MAX(week) week,MAX(fetched_at) fetched_at
    FROM nfl_play_by_play WHERE event_id=?`, eventId)[0];
  if (!meta?.season || !meta?.week) return null;
  const teams = rows(`SELECT DISTINCT offense team FROM nfl_play_by_play
    WHERE event_id=? AND offense IS NOT NULL`, eventId).map(item => item.team);
  if (teams.length < 2) return null;
  const game = rows(`SELECT season,week,team home,opponent away,spread,total,team_score,opp_score,gameday,gametime
    FROM game_lines WHERE season=? AND week=? AND home=1
      AND team IN (${teams.map(() => '?').join(',')}) LIMIT 1`, meta.season, meta.week, ...teams)[0];
  return game ? { ...game, event_id: eventId, fetched_at: meta.fetched_at } : null;
}

export function possessionStates(eventId) {
  const game = gameForEvent(eventId);
  if (!game) return { error: 'event cannot be joined to a stored game' };
  const plays = rows(`SELECT sequence,period,clock_seconds,offense,defense,down,distance,
      yards_to_endzone,home_score,away_score,play_type,fetched_at
    FROM nfl_play_by_play WHERE event_id=? AND offense IS NOT NULL
      AND clock_seconds IS NOT NULL AND home_score IS NOT NULL AND away_score IS NOT NULL
    ORDER BY sequence`, eventId);
  const states = [];
  let priorOffense = null, possessionIndex = 0;
  for (const play of plays) {
    if (play.offense === priorOffense) continue;
    priorOffense = play.offense; possessionIndex++;
    const possession = play.offense === game.home ? 'home' : play.offense === game.away ? 'away' : null;
    if (!possession) continue;
    states.push({ sequence: play.sequence, possession_index: possessionIndex,
      period: play.period, seconds_left: play.clock_seconds,
      possession, offense: play.offense, defense: play.defense,
      yard: play.yards_to_endzone == null ? 25 : clamp(100 - play.yards_to_endzone, 1, 99),
      down: play.down ?? 1, to_go: play.distance ?? 10,
      home_score: play.home_score, away_score: play.away_score,
      source_observed_at: play.fetched_at ?? game.fetched_at ?? null } );
  }
  return { game, states };
}

function deterministicSeed(eventId, sequence, version) {
  return crypto.createHash('sha256').update(`${eventId}|${sequence}|${version}`)
    .digest().readUInt32BE(0);
}

export function predictPossession(eventId, sequence, { classification = 'historical_reconstruction',
  trials = 300, capturedAt = new Date().toISOString() } = {}) {
  if (!['historical_reconstruction', 'forward_live'].includes(classification)) {
    return { error: 'classification must be historical_reconstruction or forward_live' };
  }
  const packet = possessionStates(eventId);
  if (packet.error) return packet;
  const state = packet.states.find(item => Number(item.sequence) === Number(sequence));
  if (!state) return { error: `sequence ${sequence} is not a possession boundary` };
  const game = packet.game;
  const cards = matchupTeamCards(game.season, game.week, game.home, game.away);
  if (cards.error) return { error: `team cards unavailable: ${cards.error}` };
  const result = simulateRemainder({ home: game.home, away: game.away, season: game.season,
    week: game.week, trials: Math.max(80, Math.min(5000, trials)), spread: game.spread,
    total: game.total, seed: deterministicSeed(eventId, sequence, LIVE_LEDGER_VERSION),
    state: { possession: state.possession, yard: state.yard, down: state.down,
      toGo: state.to_go, secondsLeft: state.seconds_left,
      homeScore: state.home_score, awayScore: state.away_score } });
  if (result.error) return result;
  const stateHash = sha(state), prediction = {
    home_win: result.live_moneyline.home_win, tie: result.live_moneyline.tie,
    away_win: result.live_moneyline.away_win, projected_home_score: result.projection.home_score,
    projected_away_score: result.projection.away_score, projected_margin: result.projection.margin,
    projected_total: result.projection.total, margin_sd: result.projection.margin_sd,
    live_spread: result.live_spread, live_total: result.live_total, trials: result.trials
  };
  const simulatorVersion = result.play_model?.version ?? null;
  const calibrationHash = result.play_model?.calibration?.evidence_hash ?? null;
  const predictionId = sha({ eventId, sequence, classification, version: LIVE_LEDGER_VERSION,
    stateHash, teamCardHash: cards.evidence_hash, simulatorVersion, calibrationHash, prediction });
  run(`INSERT OR IGNORE INTO nfl_live_possession_predictions
    (prediction_id,event_id,season,week,home_team,away_team,sequence,possession_index,
     classification,state_hash,team_card_hash,model_version,simulator_version,
     simulator_calibration_hash,state_json,prediction_json,evidence_json,source_observed_at,captured_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, predictionId, eventId, game.season, game.week,
  game.home, game.away, state.sequence, state.possession_index, classification, stateHash,
  cards.evidence_hash, LIVE_LEDGER_VERSION, simulatorVersion, calibrationHash,
  JSON.stringify(state), JSON.stringify(prediction),
  JSON.stringify({ team_card_version: cards.version, home_card_hash: sha(cards.home),
    away_card_hash: sha(cards.away), simulator_profile_cutoff: result.profile_cutoff ?? null,
    historical_reconstruction_warning: classification === 'historical_reconstruction'
      ? 'Generated after outcome existed; useful for algorithmic replay, never forward proof.' : null }),
  state.source_observed_at, capturedAt);
  return { prediction_id: predictionId, classification, state, prediction,
    team_card_hash: cards.evidence_hash, simulator_version: simulatorVersion,
    simulator_calibration_hash: calibrationHash, model_version: LIVE_LEDGER_VERSION };
}

export function settlePossessionPredictions(eventId) {
  const game = gameForEvent(eventId);
  if (!game || !Number.isFinite(game.team_score) || !Number.isFinite(game.opp_score)) {
    return { error: 'final score unavailable' };
  }
  const homeWon = game.team_score === game.opp_score ? 0.5 : game.team_score > game.opp_score ? 1 : 0;
  const predictions = rows(`SELECT p.* FROM nfl_live_possession_predictions p
    LEFT JOIN nfl_live_possession_settlements s ON s.prediction_id=p.prediction_id
    WHERE p.event_id=? AND s.prediction_id IS NULL`, eventId);
  let settled = 0;
  for (const item of predictions) {
    const prediction = JSON.parse(item.prediction_json);
    const probability = clamp(Number(prediction.home_win) + Number(prediction.tie) * 0.5, 1e-6, 1 - 1e-6);
    const brier = (probability - homeWon) ** 2;
    const logLoss = -(homeWon * Math.log(probability) + (1 - homeWon) * Math.log(1 - probability));
    run(`INSERT OR IGNORE INTO nfl_live_possession_settlements
      (prediction_id,settled_at,home_won,home_probability,brier,log_loss,final_home_score,
       final_away_score,settlement_json) VALUES (?,?,?,?,?,?,?,?,?)`, item.prediction_id,
    new Date().toISOString(), homeWon, probability, brier, logLoss, game.team_score,
    game.opp_score, JSON.stringify({ outcome: homeWon, final_margin: game.team_score - game.opp_score,
      scoring_contract: 'Brier and log loss at each possession boundary' }));
    settled++;
  }
  return { event_id: eventId, settled, final: { home: game.team_score, away: game.opp_score } };
}

export function backfillPossessionLedger({ seasons = [2024, 2025], maxGames = 64,
  trials = 160, maxPossessionsPerGame = 28, onProgress = null } = {}) {
  const events = rows(`SELECT event_id,MAX(season) season,MAX(week) week
    FROM nfl_play_by_play WHERE season IN (${seasons.map(() => '?').join(',')})
    GROUP BY event_id ORDER BY season,week,event_id LIMIT ?`, ...seasons, maxGames);
  let predictions = 0, settled = 0;
  const failures = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const packet = possessionStates(event.event_id);
    if (packet.error) {
      failures.push({ event_id: event.event_id, error: packet.error });
      if (onProgress) onProgress({ current: index + 1, total: events.length,
        predictions, settled, failures: failures.length, event_id: event.event_id,
        season: event.season, week: event.week });
      continue;
    }
    for (const state of packet.states.slice(0, maxPossessionsPerGame)) {
      const result = predictPossession(event.event_id, state.sequence,
        { classification: 'historical_reconstruction', trials });
      if (result.error) failures.push({ event_id: event.event_id, sequence: state.sequence, error: result.error });
      else predictions++;
    }
    const settlement = settlePossessionPredictions(event.event_id);
    if (!settlement.error) settled += settlement.settled;
    if (onProgress) onProgress({ current: index + 1, total: events.length,
      predictions, settled, failures: failures.length, event_id: event.event_id,
      season: event.season, week: event.week });
  }
  return { version: LIVE_LEDGER_VERSION, games: events.length, predictions, settled, failures };
}

export function liveLedgerCalibration({ classification = null, season = null } = {}) {
  const args = [];
  let where = '1=1';
  if (classification) { where += ' AND p.classification=?'; args.push(classification); }
  if (season != null) { where += ' AND p.season=?'; args.push(season); }
  const samples = rows(`SELECT p.event_id,p.season,p.week,p.classification,p.possession_index,
      s.home_probability,s.home_won,s.brier,s.log_loss
    FROM nfl_live_possession_predictions p JOIN nfl_live_possession_settlements s
      ON s.prediction_id=p.prediction_id WHERE ${where}`, ...args);
  if (!samples.length) return { available: false, samples: 0 };
  const mean = key => samples.reduce((sum, item) => sum + item[key], 0) / samples.length;
  const buckets = Array.from({ length: 10 }, (_, index) => {
    const lo = index / 10, hi = (index + 1) / 10;
    const items = samples.filter(item => item.home_probability >= lo
      && item.home_probability < (index === 9 ? 1.000001 : hi));
    return { range: [lo, hi], n: items.length,
      predicted: items.length ? r6(items.reduce((sum, item) => sum + item.home_probability, 0) / items.length) : null,
      actual: items.length ? r6(items.reduce((sum, item) => sum + item.home_won, 0) / items.length) : null };
  });
  const ece = buckets.reduce((sum, bucket) => sum + bucket.n * Math.abs((bucket.predicted ?? 0)
    - (bucket.actual ?? 0)), 0) / samples.length;
  return { available: true, version: LIVE_LEDGER_VERSION, samples: samples.length,
    games: new Set(samples.map(item => item.event_id)).size,
    brier: r6(mean('brier')), log_loss: r6(mean('log_loss')), expected_calibration_error: r6(ece),
    buckets, classification: classification ?? 'all',
    authority: classification === 'forward_live' ? 'forward_measurement' : 'historical_diagnostic_only' };
}

export function liveLedgerStatus() {
  const counts = rows(`SELECT classification,COUNT(*) predictions,COUNT(DISTINCT event_id) games,
      MIN(captured_at) first_at,MAX(captured_at) last_at
    FROM nfl_live_possession_predictions GROUP BY classification`);
  return { version: LIVE_LEDGER_VERSION, counts,
    forward: liveLedgerCalibration({ classification: 'forward_live' }),
    historical: liveLedgerCalibration({ classification: 'historical_reconstruction' }) };
}
