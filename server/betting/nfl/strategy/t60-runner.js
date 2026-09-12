/**
 * The durable T-60 operation (Codex plan section 7, correction C12).
 *
 * Correction C12's finding, verbatim: "The reviewed production callers do not
 * invoke `cutoffBatches`/`sequentialCapacity` to drive a durable T-60
 * operation. A GET packet route is not a scheduled collector."
 *
 * That was exactly right. Both helpers were pure functions with test callers
 * and nothing else. This is the caller: a job that walks the schedule, opens a
 * prospective observation for every game BEFORE its cutoff, freezes what was
 * knowable at that cutoff, and records what happened -- including, especially,
 * when nothing happened.
 *
 * THE OBSERVATION ROW IS THE POINT. It is created ahead of the cutoff and
 * carries its own state. A row that is still `scheduled` after its cutoff has
 * passed is a MISSED capture, and it stays in the denominator. Section 7.1:
 * "If capture was missed, record a missing prospective observation; never
 * reconstruct it with later receipts and call it prospective." A system that
 * only writes rows when it succeeds cannot tell a quiet week from a broken
 * collector, and coverage computed from such rows is always 100%.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not place bets, and it does not
 * grant a forecast authority. It records observations and reserves capacity.
 * Whether any of it is worth acting on is a separate question that the policy
 * gate answers, and today the honest answer is that nothing here is qualified.
 */
import crypto from 'node:crypto';
import { db, rows, row, run } from '../../../db/index.js';
import { cutoffBatches, decisionCutoff, sequentialCapacity, T60_PROTOCOL_VERSION }
  from '../../../services/nfl-t60-protocol.js';
import { eventKey } from '../../../services/nfl-contract-key.js';
import { freezeT60Packet, t60PacketHash } from '../../../services/nfl-t60-packet.js';
import { nflKickoffDate } from '../../../services/date-util.js';

export const T60_RUNNER_VERSION = 'nfl-t60-runner-v1';

/** How far ahead of a cutoff an observation row is opened. */
export const SCHEDULE_HORIZON_MINUTES = 24 * 60;

/**
 * Every scheduled game for a week, with the cutoff its kickoff implies.
 *
 * Read from `game_lines`, which is the same schedule the execution pipeline
 * uses -- two schedules would be two answers to "when does this game start",
 * and the cutoff is defined relative to that answer.
 */
export function scheduledGames(season, week) {
  return rows(`SELECT team AS home, opponent AS away, gameday, gametime
    FROM game_lines WHERE season=? AND week=? AND home=1`, season, week)
    .map(g => {
      const kickoff = nflKickoffDate(g.gameday, g.gametime)?.toISOString() ?? null;
      if (!kickoff) return null;
      const key = eventKey({ homeTeam: g.home, awayTeam: g.away, commenceTime: kickoff });
      if (!key?.key) return null;
      return { home: g.home, away: g.away, kickoff, event_key: key.key };
    })
    .filter(Boolean);
}

/**
 * Open a prospective observation for every game whose cutoff has not passed.
 *
 * Idempotent by (experiment, event, cutoff): running the scheduler twice in
 * one window does not create two observations of the same thing. A reschedule
 * produces a DIFFERENT cutoff and therefore a new observation row, which is
 * correct -- the old one describes a capture that was planned against a
 * kickoff that no longer applies, and deleting it would erase that.
 */
export function openObservations({ season, week, experimentId, scheduleVersion = null,
  now = new Date().toISOString(), horizonMinutes = SCHEDULE_HORIZON_MINUTES } = {}) {
  const opened = [], skipped = [];
  const nowMs = Date.parse(now);
  const horizonMs = nowMs + horizonMinutes * 60_000;

  for (const game of scheduledGames(season, week)) {
    const cutoff = decisionCutoff(game.kickoff, { scheduleVersion });
    if (!cutoff) { skipped.push({ ...game, reason: 'unresolvable_kickoff' }); continue; }
    const cutoffMs = Date.parse(cutoff.cutoff_at);
    if (cutoffMs < nowMs) { skipped.push({ ...game, reason: 'cutoff_already_passed' }); continue; }
    if (cutoffMs > horizonMs) { skipped.push({ ...game, reason: 'beyond_scheduling_horizon' }); continue; }

    const existing = row(`SELECT id FROM nfl_t60_observations
      WHERE experiment_id=? AND event_key=? AND cutoff_at=?`, experimentId, game.event_key, cutoff.cutoff_at);
    if (existing) { skipped.push({ ...game, reason: 'already_open', id: existing.id }); continue; }

    const id = crypto.randomUUID();
    run(`INSERT INTO nfl_t60_observations
         (id, experiment_id, season, week, event_key, home, away, kickoff_at, schedule_version,
          cutoff_at, horizon, state)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'scheduled')`,
    id, experimentId, season, week, game.event_key, game.home, game.away, cutoff.kickoff,
    scheduleVersion, cutoff.cutoff_at, `T-${cutoff.lead_minutes}`);
    opened.push({ id, ...game, cutoff_at: cutoff.cutoff_at });
  }
  return { opened, skipped, protocol_version: T60_PROTOCOL_VERSION, runner_version: T60_RUNNER_VERSION };
}

/**
 * Freeze the packet for every observation whose cutoff has arrived.
 *
 * A failure is recorded on the row rather than thrown: one game's collector
 * breaking must not stop the other fifteen from being captured, and the broken
 * one must be visible rather than absent.
 */
export function captureDueObservations({ experimentId, now = new Date().toISOString() } = {}) {
  const due = rows(`SELECT * FROM nfl_t60_observations
    WHERE experiment_id=? AND state='scheduled' AND cutoff_at <= ?
    ORDER BY cutoff_at, event_key`, experimentId, now);

  const captured = [], failed = [];
  for (const observation of due) {
    const startedAt = new Date().toISOString();
    try {
      const packet = freezeT60Packet({
        season: observation.season, week: observation.week,
        home: observation.home, away: observation.away,
        kickoff: observation.kickoff_at, scheduleVersion: observation.schedule_version,
        mode: 'prospective', computationStartedAt: startedAt
      });
      if (packet.error) {
        run(`UPDATE nfl_t60_observations SET state='failed', last_error=?, capture_started_at=?,
             capture_finished_at=? WHERE id=?`,
        packet.error, startedAt, new Date().toISOString(), observation.id);
        failed.push({ id: observation.id, event_key: observation.event_key, reason: packet.error });
        continue;
      }
      run(`UPDATE nfl_t60_observations SET state='frozen', packet_hash=?, packet_json=?, capture_started_at=?,
           capture_finished_at=? WHERE id=?`,
      t60PacketHash(packet), JSON.stringify(packet), startedAt, new Date().toISOString(), observation.id);
      captured.push({ id: observation.id, event_key: observation.event_key, packet });
    } catch (error) {
      run(`UPDATE nfl_t60_observations SET state='failed', last_error=?, capture_started_at=?,
           capture_finished_at=? WHERE id=?`,
      error.message, startedAt, new Date().toISOString(), observation.id);
      failed.push({ id: observation.id, event_key: observation.event_key, reason: error.message });
    }
  }
  return { captured, failed };
}

/**
 * Mark as MISSED every observation whose cutoff has passed without a capture.
 *
 * This is the function that makes coverage honest. Without it a collector
 * outage looks identical to a quiet week: no rows either way. With it, the
 * denominator holds a row saying a capture was due and did not happen, which
 * is a fact an evaluation needs and cannot recover later.
 *
 * `graceMinutes` exists because a capture that starts at the cutoff takes a
 * moment to finish; anything still `scheduled` well past its cutoff was not
 * running late, it was not running.
 */
export function markMissedObservations({ experimentId, now = new Date().toISOString(),
  graceMinutes = 10 } = {}) {
  const deadline = new Date(Date.parse(now) - graceMinutes * 60_000).toISOString();
  const missed = rows(`SELECT id, event_key, cutoff_at FROM nfl_t60_observations
    WHERE experiment_id=? AND state='scheduled' AND cutoff_at < ?`, experimentId, deadline);
  for (const observation of missed) {
    run(`UPDATE nfl_t60_observations SET state='missed', note=? WHERE id=?`,
      `cutoff ${observation.cutoff_at} passed with no capture — recorded as a missing prospective ` +
      'observation rather than reconstructed later from receipts that arrived afterwards',
      observation.id);
  }
  return { missed };
}

/* ------------------------------------------------------- capacity ledger */

/**
 * Reserve a weekly slot, at a stated instant.
 *
 * Codex correction C12: capacity is a question about a MOMENT, so both the
 * reservation and any later release carry the time they actually happened.
 * `occurredAt` is deliberately a parameter rather than `now()`: a release
 * learned about late is still a release at its own time, and back-stamping it
 * to when we found out would change what earlier batches are judged to have
 * seen.
 */
export function reserveSlot({ experimentId, season, week, eventKey: key, observationId = null,
  occurredAt, reason = null, actor = 'system:t60-runner' }) {
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new TypeError('reserveSlot requires the instant the reservation actually happened');
  }
  run(`INSERT INTO nfl_capacity_events
       (experiment_id, season, week, event_key, observation_id, kind, occurred_at, reason, actor)
       VALUES (?,?,?,?,?,'reserved',?,?,?)`,
  experimentId, season, week, key, observationId, occurredAt, reason, actor);
  return { reserved: true, event_key: key, occurred_at: occurredAt };
}

/** Release a slot at the instant it actually came free. */
export function releaseSlot({ experimentId, season, week, eventKey: key, observationId = null,
  occurredAt, reason, actor = 'system:t60-runner' }) {
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new TypeError('releaseSlot requires the instant the slot actually came free');
  }
  if (!reason) throw new TypeError('a released slot must say why — an unexplained release is not evidence');
  run(`INSERT INTO nfl_capacity_events
       (experiment_id, season, week, event_key, observation_id, kind, occurred_at, reason, actor)
       VALUES (?,?,?,?,?,'released',?,?,?)`,
  experimentId, season, week, key, observationId, occurredAt, reason, actor);
  return { released: true, event_key: key, occurred_at: occurredAt };
}

/** Commit a slot: the contract was accepted or recorded as a paper observation. */
export function commitSlot({ experimentId, season, week, eventKey: key, observationId = null,
  occurredAt, reason = null, actor = 'system:t60-runner' }) {
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new TypeError('commitSlot requires the instant the commitment actually happened');
  }
  run(`INSERT INTO nfl_capacity_events
       (experiment_id, season, week, event_key, observation_id, kind, occurred_at, reason, actor)
       VALUES (?,?,?,?,?,'committed',?,?,?)`,
  experimentId, season, week, key, observationId, occurredAt, reason, actor);
  return { committed: true, event_key: key, occurred_at: occurredAt };
}

/**
 * How many weekly slots are held AT a given instant.
 *
 * The whole point of the event ledger: a slot reserved at 12:00 and released
 * at 12:10 is held at 12:05 and free at 12:15, and the same query answers both
 * without either answer depending on which one is asked first.
 */
export function slotsHeldAt({ experimentId, season, week, at }) {
  const events = rows(`SELECT event_key, kind, occurred_at FROM nfl_capacity_events
    WHERE experiment_id=? AND season=? AND week=? AND occurred_at <= ?
    ORDER BY occurred_at, id`, experimentId, season, week, at);

  const state = new Map();
  for (const event of events) state.set(event.event_key, event.kind);
  const held = [...state.entries()].filter(([, kind]) => kind !== 'released').map(([key]) => key);
  return { held: held.sort(), count: held.length, as_of: at };
}

/**
 * One durable pass: open what is due, capture what has arrived, mark what was
 * missed. Registered with the existing job framework rather than a second
 * scheduling system, per section 7.1.
 */
export function runT60Pass({ season, week, experimentId, scheduleVersion = null,
  now = new Date().toISOString() } = {}) {
  const startedAt = now;
  const opened = openObservations({ season, week, experimentId, scheduleVersion, now });
  const captured = captureDueObservations({ experimentId, now });
  const missed = markMissedObservations({ experimentId, now });
  return {
    runner_version: T60_RUNNER_VERSION, protocol_version: T60_PROTOCOL_VERSION,
    experiment_id: experimentId, season, week, started_at: startedAt,
    opened: opened.opened.length, skipped: opened.skipped,
    captured: captured.captured.length, failed: captured.failed,
    missed: missed.missed.length,
    finished_at: new Date().toISOString()
  };
}

/**
 * Section 7.4's observability: for every scheduled game, what actually
 * happened. A healthy empty slate and a failed collector must not look the
 * same, so `missed` and `failed` are counted separately from `abstained`.
 */
export function t60Coverage({ experimentId, season, week }) {
  const observations = rows(`SELECT * FROM nfl_t60_observations
    WHERE experiment_id=? AND season=? AND week=? ORDER BY cutoff_at, event_key`,
  experimentId, season, week);

  const byState = {};
  for (const o of observations) byState[o.state] = (byState[o.state] ?? 0) + 1;

  const scheduled = scheduledGames(season, week);
  const covered = new Set(observations.map(o => o.event_key));
  const neverScheduled = scheduled.filter(g => !covered.has(g.event_key));

  return {
    runner_version: T60_RUNNER_VERSION,
    season, week, experiment_id: experimentId,
    games_on_schedule: scheduled.length,
    observations: observations.length,
    by_state: byState,
    // A game with no observation row at all is a different failure from one
    // whose capture was attempted and missed: nothing ever planned to look.
    never_scheduled: neverScheduled.map(g => g.event_key),
    // The number an honest coverage report leads with.
    captured_rate: scheduled.length
      ? +(((byState.frozen ?? 0) + (byState.decided ?? 0)) / scheduled.length).toFixed(4) : null,
    detail: observations.map(o => ({
      event_key: o.event_key, cutoff_at: o.cutoff_at, state: o.state,
      packet_hash: o.packet_hash, decision_run_id: o.decision_run_id, last_error: o.last_error
    }))
  };
}

/** Re-export so a caller has one import for the whole operation. */
export { cutoffBatches, sequentialCapacity };
