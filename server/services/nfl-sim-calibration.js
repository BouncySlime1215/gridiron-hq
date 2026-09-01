/** Chronological calibration for the generative play/drive simulator. */
import crypto from 'node:crypto';
import { db, rows, run } from '../db/index.js';
import { RATE_SPEC } from './nfl-sim-learn.js';

export const SIM_CALIBRATION_VERSION = 'nfl-sim-calibration-v1';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_sim_calibration_artifacts (
    artifact_id TEXT PRIMARY KEY,version TEXT NOT NULL,season INTEGER NOT NULL,week INTEGER NOT NULL,
    evidence_hash TEXT NOT NULL,plays INTEGER NOT NULL,games INTEGER NOT NULL,
    calibration_json TEXT NOT NULL,created_at TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS nfl_sim_calibration_no_update BEFORE UPDATE ON nfl_sim_calibration_artifacts
    BEGIN SELECT RAISE(ABORT, 'simulation calibration artifacts are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_sim_calibration_no_delete BEFORE DELETE ON nfl_sim_calibration_artifacts
    BEGIN SELECT RAISE(ABORT, 'simulation calibration artifacts are immutable'); END;
`);

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const r4 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(4);
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rate = (successes, exposures, prior, strength = 300) =>
  (successes + prior * strength) / Math.max(1, exposures + strength);

function empirical(season, week) {
  const plays = rows(`SELECT event_id,sequence,offense,play_type,yards_gained,down,distance,
      yards_to_endzone,is_turnover,is_scoring,shotgun,no_huddle,clock_seconds
    FROM nfl_play_by_play WHERE season=? AND week<? ORDER BY event_id,sequence`, season, week);
  const games = new Set(plays.map(play => play.event_id));
  const pass = plays.filter(play => ['pass', 'incompletion', 'sack', 'interception'].includes(play.play_type));
  const attempts = pass.filter(play => play.play_type !== 'sack');
  const completions = pass.filter(play => play.play_type === 'pass');
  const rush = plays.filter(play => play.play_type === 'rush');
  const scrimmage = [...pass, ...rush];
  const interceptions = pass.filter(play => play.play_type === 'interception').length;
  const turnovers = scrimmage.filter(play => play.is_turnover).length;
  const redZone = scrimmage.filter(play => Number(play.yards_to_endzone) <= 20);
  const driveStarts = [];
  let prior = null;
  for (const play of plays) {
    if (!prior || prior.event_id !== play.event_id || prior.offense !== play.offense) driveStarts.push(play);
    prior = play;
  }
  const seconds = plays.map((play, i) => {
    const next = plays[i + 1];
    return next?.event_id === play.event_id && Number.isFinite(play.clock_seconds)
      && Number.isFinite(next.clock_seconds) && play.clock_seconds >= next.clock_seconds
      ? play.clock_seconds - next.clock_seconds : null;
  }).filter(value => Number.isFinite(value) && value >= 1 && value <= 45);
  const passYards = completions.map(play => Number(play.yards_gained)).filter(Number.isFinite);
  const rushYards = rush.map(play => Number(play.yards_gained)).filter(Number.isFinite);
  return { plays: plays.length, games: games.size,
    rates: {
      completion: rate(completions.length, attempts.length, RATE_SPEC.off_completion_pct),
      sack: rate(pass.filter(play => play.play_type === 'sack').length, pass.length, RATE_SPEC.off_sack_rate),
      interception: rate(interceptions, attempts.length, RATE_SPEC.off_int_rate),
      fumble: rate(Math.max(0, turnovers - interceptions), scrimmage.length, RATE_SPEC.off_fumble_rate),
      turnover: rate(turnovers, scrimmage.length, RATE_SPEC.off_turnover_rate),
      explosive_pass: rate(completions.filter(play => Number(play.yards_gained) >= 20).length,
        attempts.length, RATE_SPEC.off_explosive_pass_rate),
      explosive_rush: rate(rush.filter(play => Number(play.yards_gained) >= 10).length,
        rush.length, RATE_SPEC.off_explosive_rush_rate),
      stuff: rate(rush.filter(play => Number(play.yards_gained) <= 0).length, rush.length, RATE_SPEC.off_stuff_rate),
      red_zone_score: rate(redZone.filter(play => play.is_scoring).length, redZone.length, RATE_SPEC.off_red_zone_td_rate),
      shotgun: rate(scrimmage.filter(play => play.shotgun).length, scrimmage.length, RATE_SPEC.off_shotgun_rate),
      no_huddle: rate(scrimmage.filter(play => play.no_huddle).length, scrimmage.length, RATE_SPEC.off_no_huddle_rate)
    },
    shape: {
      pass_yards_mean: passYards.length ? passYards.reduce((a, b) => a + b, 0) / passYards.length : null,
      rush_yards_mean: rushYards.length ? rushYards.reduce((a, b) => a + b, 0) / rushYards.length : null,
      seconds_per_play: seconds.length ? seconds.reduce((a, b) => a + b, 0) / seconds.length : null,
      drives_per_team_game: games.size ? driveStarts.length / (games.size * 2) : null
    }
  };
}

const cache = new Map();
export function simulationCalibrationFor(season, week, { persist = false } = {}) {
  const key = `${season}|${week}`;
  if (cache.has(key)) return cache.get(key);
  const observed = empirical(season, week);
  if (observed.games < 16 || observed.plays < 1500) {
    return { available: false, season, week, plays: observed.plays, games: observed.games,
      reason: 'at least 16 earlier games and 1,500 plays are required' };
  }
  const multiplier = (actual, baseline, lo = 0.8, hi = 1.2) => clamp(actual / baseline, lo, hi);
  const adjustments = {
    completion: multiplier(observed.rates.completion, RATE_SPEC.off_completion_pct),
    sack: multiplier(observed.rates.sack, RATE_SPEC.off_sack_rate),
    interception: multiplier(observed.rates.interception, RATE_SPEC.off_int_rate),
    fumble: multiplier(observed.rates.fumble, RATE_SPEC.off_fumble_rate, 0.75, 1.25),
    explosive_pass: multiplier(observed.rates.explosive_pass, RATE_SPEC.off_explosive_pass_rate),
    explosive_rush: multiplier(observed.rates.explosive_rush, RATE_SPEC.off_explosive_rush_rate),
    stuff: multiplier(observed.rates.stuff, RATE_SPEC.off_stuff_rate),
    red_zone: multiplier(observed.rates.red_zone_score, RATE_SPEC.off_red_zone_td_rate),
    shotgun: multiplier(observed.rates.shotgun, RATE_SPEC.off_shotgun_rate),
    no_huddle: multiplier(observed.rates.no_huddle, RATE_SPEC.off_no_huddle_rate),
    clock: observed.shape.seconds_per_play == null ? 1
      : clamp(observed.shape.seconds_per_play / 27, 0.85, 1.15)
  };
  const evidenceHash = sha({ season, week, observed });
  const result = { available: true, version: SIM_CALIBRATION_VERSION, season, week,
    cutoff: `${season}-before-W${week}`, evidence_hash: evidenceHash,
    plays: observed.plays, games: observed.games, observed, adjustments };
  if (persist) {
    const id = sha({ version: SIM_CALIBRATION_VERSION, season, week, evidenceHash });
    run(`INSERT OR IGNORE INTO nfl_sim_calibration_artifacts
      (artifact_id,version,season,week,evidence_hash,plays,games,calibration_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, id, SIM_CALIBRATION_VERSION, season, week, evidenceHash,
    observed.plays, observed.games, JSON.stringify(result), new Date().toISOString());
    result.artifact_id = id;
  }
  cache.set(key, result);
  return result;
}

export function calibrateSimulationContext(context, calibration) {
  if (!calibration?.available) return { ...context, calibration_applied: false, clockScale: 1 };
  const a = calibration.adjustments;
  return { ...context,
    completionPct: clamp(context.completionPct * a.completion, 0.42, 0.82),
    sackRate: clamp(context.sackRate * a.sack, 0.025, 0.16),
    intRate: clamp(context.intRate * a.interception, 0.006, 0.07),
    fumbleRate: clamp(context.fumbleRate * a.fumble, 0.003, 0.04),
    explosivePass: clamp(context.explosivePass * a.explosive_pass, 0.04, 0.25),
    explosiveRush: clamp(context.explosiveRush * a.explosive_rush, 0.025, 0.20),
    stuffRate: clamp(context.stuffRate * a.stuff, 0.08, 0.35),
    redZoneTd: clamp(context.redZoneTd * a.red_zone, 0.10, 0.45),
    shotgunRate: clamp(context.shotgunRate * a.shotgun, 0.25, 0.95),
    noHuddle: clamp(context.noHuddle * a.no_huddle, 0.01, 0.30),
    clockScale: a.clock,
    calibration_applied: true, calibration_version: calibration.version,
    calibration_cutoff: calibration.cutoff, calibration_evidence_hash: calibration.evidence_hash
  };
}

export function simulationCalibrationStatus() {
  return { version: SIM_CALIBRATION_VERSION,
    artifacts: rows(`SELECT season,week,plays,games,created_at FROM nfl_sim_calibration_artifacts
      ORDER BY season DESC,week DESC LIMIT 20`) };
}

export const __test = { empirical };
