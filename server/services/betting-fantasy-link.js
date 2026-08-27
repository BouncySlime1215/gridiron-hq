/**
 * The bridge between the betting model and the fantasy projections.
 *
 * Props and fantasy now consume one player-week event state. This module is an
 * agreement assertion and explanation layer, not a second projection model.
 */
import { gameScriptFor } from './gamescript.js';
import { rolesFor, injuryFor } from './nfl-advanced.js';
import { PPR } from './scoring.js';
import {
  buildPlayerWeekEngine, playerWeekEventExpectation, playerWeekProjection
} from './player-week-engine.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));

/**
 * The shared event model's fantasy-point view, alongside the exact signals
 * that produced it.
 */
export function bettingViewOf(season, week, playerId, scoring = PPR) {
  const projection = playerWeekProjection(buildPlayerWeekEngine({ season, week, scoring }), playerId);
  if (!projection) return null;
  const gs = projection.team ? gameScriptFor(projection.team, season, week) : null;
  const line = gs?.line ?? null;
  const mult = line ? { pass: gs.pass_mult, rush: gs.rush_mult } : 1;
  const state = playerWeekEventExpectation(projection, { mult, scoring });
  const e = state.events;
  const stats = {
    pass_yds: e.passYd, pass_td: e.passTd, interceptions: e.int,
    rush_yds: e.rushYd, rush_td: e.rushTd,
    rec_yds: e.recYd, receptions: e.rec, rec_td: e.recTd,
    tds: e.rushTd + e.recTd
  };
  const points = state.structural_fantasy_points;
  const injury = injuryFor(season, week, playerId);
  const roles = projection.team ? rolesFor(season, week, projection.team) : [];
  const role = roles.find(r => r.gsis_id === playerId) ?? null;

  return {
    player_id: playerId, name: projection.name, team: projection.team, position: projection.position,
    betting_points: r2(points),
    structural_fantasy_points: r2(points),
    calibrated_fantasy_points: r2(projection.ppg),
    calibration_shift: r2(projection.ensemble_shift),
    engine_version: state.engine_version,
    cutoff: state.cutoff,
    projected_stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, r2(v)])),
    role: role ? { listed: role.role, by_snaps: role.snap_role, snap_pct: role.snap_pct,
      matches_usage: role.role_matches_usage } : null,
    game_script: line ? {
      spread: line.spread, total: line.total, implied_team_total: line.implied_points,
      opponent: line.opponent, pass_mult: gs.pass_mult, rush_mult: gs.rush_mult
    } : null,
    injury: injury ? { status: injury.report_status, practice: injury.practice_status, injury: injury.injury } : null,
    opportunity: {
      targets: r2(state.volume.targets), carries: r2(state.volume.carries), attempts: r2(state.volume.attempts),
      target_share: projection.volume?.target_share,
      wopr: null,
      opportunity_share: projection.volume?.carry_share
    }
  };
}

/**
 * Compares the betting view against a fantasy projection and explains the gap.
 * `fantasyPoints` is whatever the fantasy engine already produced for the week.
 */
export function reconcile(season, week, playerId, fantasyPoints, scoring = PPR) {
  const view = bettingViewOf(season, week, playerId, scoring);
  if (!view) return null;

  const expectedFantasy = fantasyPoints == null ? view.calibrated_fantasy_points : fantasyPoints;
  const delta = expectedFantasy == null ? null : r2(view.betting_points - expectedFantasy);
  const pctGap = expectedFantasy ? r2((view.betting_points - expectedFantasy) / expectedFantasy) : null;

  const reasons = [];
  if (view.game_script) {
    const { implied_team_total: it, total, spread, opponent } = view.game_script;
    if (it != null && it >= 26) reasons.push(`The market implies ${it} points for ${view.team} against ${opponent} — a high-scoring script that lifts everyone in this offense.`);
    else if (it != null && it <= 18) reasons.push(`The market implies only ${it} points for ${view.team} — a low-scoring script that caps the ceiling here.`);
    if (spread != null && spread >= 6) reasons.push(`As a ${spread}-point underdog they should be throwing to catch up, which helps pass-catchers and hurts early-down runs.`);
    if (spread != null && spread <= -6) reasons.push(`Favoured by ${Math.abs(spread)}, they are likely to run out the clock — good for carries, less so for volume passing.`);
    if (total != null && total >= 49) reasons.push(`A ${total} total is among the week's highest.`);
  }
  if (view.role && view.role.matches_usage === false) {
    reasons.push(`Listed as ${view.role.listed} but playing like ${view.role.by_snaps} on ${view.role.snap_pct != null ? (view.role.snap_pct * 100).toFixed(0) + '%' : 'unknown'} of snaps — the depth chart and the usage disagree.`);
  }
  if (view.injury?.status) {
    reasons.push(`Injury report: ${view.injury.status}${view.injury.injury ? ` (${view.injury.injury})` : ''}.`);
  }
  // Always state the underlying volume case. The conditional notes above only
  // fire on notable situations, and a flagged gap with no explanation next to
  // it is worse than no flag at all.
  const o = view.opportunity;
  const volume = [];
  if (o.carries >= 1) volume.push(`${o.carries} carries`);
  if (o.targets >= 1) volume.push(`${o.targets} targets`);
  if (o.attempts >= 1) volume.push(`${o.attempts} pass attempts`);
  if (volume.length) {
    reasons.push(`Projected on ${volume.join(' and ')}${
      o.target_share != null ? `, a ${(o.target_share * 100).toFixed(0)}% target share` : ''
    } — this is the opportunity the ${view.betting_points} point estimate is built from.`);
  }

  const structuralGap = r2(view.betting_points - view.structural_fantasy_points);
  const structurallyAligned = Math.abs(structuralGap ?? 0) <= 0.01;
  let verdict = 'structurally aligned';
  if (pctGap != null && pctGap >= 0.15) verdict = 'event state above calibrated fantasy head';
  else if (pctGap != null && pctGap <= -0.15) verdict = 'event state below calibrated fantasy head';

  return {
    ...view,
    fantasy_points: expectedFantasy == null ? null : r2(expectedFantasy),
    delta, pct_gap: pctGap, structural_gap: structuralGap,
    structurally_aligned: structurallyAligned, verdict,
    reasons,
    note: structurallyAligned
      ? 'Props and fantasy are identical at the event layer. Any remaining gap is the explicit fantasy calibration head or game-script adjustment, not a competing player model.'
      : 'Invariant failed: the props conversion does not equal the shared structural fantasy state.'
  };
}

/**
 * Week-level view for a whole roster: who the betting side is highest on,
 * relative to what the fantasy projection already says.
 */
export function reconcileRoster(season, week, players, scoring = PPR) {
  return players
    .map(p => reconcile(season, week, p.player_id, p.fantasy_points, scoring))
    .filter(Boolean)
    .sort((a, b) => (b.pct_gap ?? -9) - (a.pct_gap ?? -9));
}

/** Every player the betting model is unusually high on this week. */
export function standouts(season, week, { minPoints = 8, limit = 25, scoring = PPR } = {}) {
  const ids = [...buildPlayerWeekEngine({ season, week, scoring }).keys()];
  const out = [];
  for (const id of ids) {
    const v = bettingViewOf(season, week, id, scoring);
    if (!v || (v.betting_points ?? 0) < minPoints) continue;
    out.push(v);
  }
  return out.sort((a, b) => b.betting_points - a.betting_points).slice(0, limit);
}
