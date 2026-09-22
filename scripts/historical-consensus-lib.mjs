/**
 * HX-01 study library: our SERVED start/sit number, replayed walk-forward on past seasons, as
 * rows the consensus arm (scripts/consensus-arm.mjs) can grade. Pre-registration:
 * docs/evidence/2026-09-22/historical-consensus-head-to-head-preregistration.md.
 *
 * This file produces no served number. OURS is built by calling the served chain:
 *   B     = S-02 constructArms (buildPlayerWeekEngine -> weeklyExpertValues -> coordinateFantasy)
 *   p     = weeklyAvailability(season, week, { through: season - 1 }) (contingency.js:933),
 *           DEFAULT_ACTIVE_PROBABILITY when he has no row                (trade-engine.js:304,346)
 *   week  = round2(B x thisGame.mult x p)                                (trade-engine.js:359,449)
 *   OURS  = startSitWeekPoints({ team_abbr, position, current_week_ppg }).week_points
 *                                                                        (lineup-brain.js:356)
 * The lift is keyed on the engine's team at the cutoff (proj.team), as S-02 does: the page keys
 * it on players.team_abbr, today's team, which would misprice a past season.
 *
 * Walk-forward: every coordinator fit that grades season S is built from examples that end at
 * S - 1 (S-02's assertFitCutoff) and re-checked where the grade receives it (S-02's
 * assertContextCutoff). The k control (standing rule 3) removes a season whose fitted volume k
 * is missing or the hand-set 6. 2025 is the used-up holdout and is refused everywhere.
 */
import {
  constructArms, eligibleRows, assertKControl, assertFitCutoff, assertContextCutoff
} from './weekly-construction-grade-lib.mjs';
import { fitFantasyCoordinator } from '../server/services/fantasy-coordinator.js';
import { startSitWeekPoints } from '../server/services/lineup-brain.js';
import { removeByes } from '../server/services/gates/start-sit-gate.js';

/** The seasons HX-01 was asked to grade (2025 is not one of them). */
export const REQUESTED_SEASONS = Object.freeze([2021, 2022, 2023, 2024]);
/** The used-up holdout (docs/evidence/HOLDOUT-LEDGER.md). */
export const HELD_OUT = 2025;
export const FORWARD = 2026;
export const FIRST_WEEK = 2;
export const LAST_WEEK = 18;
/** trade-engine.js:346, `availability?.active_probability ?? 0.92`; pinned to the source by the test. */
export const DEFAULT_ACTIVE_PROBABILITY = 0.92;
/** thisGame.mult (trade-engine.js:359): exactly 1 while matchups.js#matchupSignalActive() is false. */
export const THIS_GAME_MULT = 1;
/** Every arm with points; the common pair set holds each to the threshold (prereg §5.3). */
export const POINT_ARMS = Object.freeze(['ours', 'D', 'A', 'std', 'l3']);

/** The served functions OURS is built from, and C-01's bye rule. Identity-tested, never copied. */
export const SERVED_CHAIN = Object.freeze({ constructArms, startSitWeekPoints, removeByes });

const round2 = v => +v.toFixed(2);

export function assertNotHoldout(season) {
  if (season === HELD_OUT) {
    throw new Error(`holdout: ${HELD_OUT} is the used-up held-out season (HOLDOUT-LEDGER.md); HX-01 does not open it`);
  }
  return season;
}

/**
 * Standing rule 3's k control per season. A season whose target-share k is missing or the
 * hand-set 6 is excluded, with S-02's reason, and never graded.
 */
export function kControlSeasons(seasons, resolveK) {
  const graded = [], excluded = [];
  for (const season of seasons) {
    assertNotHoldout(season);
    try {
      graded.push({ season, target_share_k: assertKControl(resolveK(season), season) });
    } catch (error) {
      if (!/k control failed/.test(error?.message ?? '')) throw error;
      excluded.push({ season, reason: error.message });
    }
  }
  return { graded, excluded };
}

/**
 * The walk-forward coordinator registry: for each graded season S, a fit on the examples that
 * end at S - 1. The cutoff travels with the fit (`through`), so gradingFit can re-check it.
 */
export function coordinatorRegistry(examples, seasons, { fit = fitFantasyCoordinator } = {}) {
  const out = new Map();
  for (const season of seasons) {
    assertNotHoldout(season);
    const base = examples.filter(e => e.season <= season - 1);
    assertFitCutoff(base, season - 1, `coordinator fit for ${season}`);
    const fitS = fit(base);
    if (!fitS?.ready) throw new Error(`coordinator fit for ${season} is not ready (${fitS?.reason ?? 'no reason given'})`);
    out.set(season, { fitS, through: season - 1, rows: base.length });
  }
  return out;
}

/** The fit that grades `season`, re-checked at the call that receives it. */
export function gradingFit(registry, season) {
  assertNotHoldout(season);
  const slot = registry.get(season);
  if (!slot?.fitS) throw new Error(`cutoff: no coordinator fit is registered to grade ${season}`);
  assertContextCutoff({ fitSThrough: slot.through, fitEThrough: slot.through }, season);
  return slot;
}

/** `${player_id}|${week}` -> the team he played for that week (player_week_usage rows). */
export function teamAtWeek(usageRows) {
  const out = new Map();
  for (const u of usageRows) if (u.team != null) out.set(`${u.player_id}|${u.week}`, u.team);
  return out;
}

/**
 * One graded week's rows: every S-02 eligible DECISION row (he played week - 1), valued by
 * every point arm. Stops when arm D is not what the served startSitWeekPoints makes of B (the
 * lift step), so OURS is known to run through the served lift.
 */
export function servedWeekRows({ season, week, engine, truth, fitS, availability, scoring }, deps = SERVED_CHAIN) {
  assertNotHoldout(season);
  const out = [];
  for (const row of eligibleRows(week, engine, truth)) {
    if (!row.decision) continue;
    const proj = row.proj;
    const arms = deps.constructArms(proj, { season, week, scoring, fitS, fitE: fitS, lambda: 1 });
    const lifted = deps.startSitWeekPoints({ team_abbr: proj.team, position: row.position, current_week_ppg: arms.B }, season, week);
    if (round2(arms.D) !== lifted.week_points) {
      throw new Error(`parity: ${season} W${week} player ${row.player_id} D ${arms.D} vs startSitWeekPoints ${lifted.week_points}`);
    }
    const p = availability.get(row.player_id)?.active_probability ?? DEFAULT_ACTIVE_PROBABILITY;
    const currentWeekPpg = round2(arms.B * THIS_GAME_MULT * p);
    const ours = deps.startSitWeekPoints({ team_abbr: proj.team, position: row.position, current_week_ppg: currentWeekPpg },
      season, week).week_points;
    const heads = proj.player_week_engine?.heads ?? {};
    out.push({
      season, week, position: row.position, player_id: row.player_id, played: row.played, actual: row.actual,
      ours, D: arms.D, A: arms.A, B: arms.B, p, lift: arms.lift,
      std: Number.isFinite(heads.season_to_date) ? heads.season_to_date : null,
      l3: Number.isFinite(heads.last3) ? heads.last3 : null
    });
  }
  return out;
}

/**
 * The pre-registration must be committed and unchanged before the full run (the S-02 runner's
 * rule). `git` is (...args) -> trimmed stdout.
 */
export function preregState(git, file) {
  if (!git('ls-files', file)) throw new Error(`${file} is not committed; pre-register before any number is run`);
  if (git('status', '--porcelain', '--', file)) throw new Error(`${file} has uncommitted changes; the grade must run against the committed text`);
  return { path: file, commit: git('log', '-1', '--format=%H', '--', file), blob: git('rev-parse', `HEAD:${file}`) };
}
