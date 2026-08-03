/**
 * The bridge between the betting model and the fantasy projections.
 *
 * These were solving the same problem twice. A prop projection says "we expect
 * 78 receiving yards from him this week"; a fantasy projection says "we expect
 * 13.4 points". They are the same forecast in different units, and when they
 * disagree, one of them is wrong.
 *
 * So the prop simulation is converted straight into fantasy points using the
 * league's own scoring, and the two are compared. The interesting output is not
 * the agreement — it is the gap. A player the props model loves but the fantasy
 * projection is cool on is exactly the start/sit call worth a second look.
 *
 * Nothing here overwrites a fantasy projection. It annotates, and says why.
 */
import { rows } from '../db/index.js';
import { playerFeatureVector } from './nfl-features.js';
import { playerWeeks } from './nfl-pbp.js';
import { gameScriptFor } from './gamescript.js';
import { rolesFor, injuryFor } from './nfl-advanced.js';
import { PPR } from './scoring.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));

/** Turns a projected stat line into fantasy points under the given scoring. */
function statsToPoints(s, scoring = PPR) {
  return (s.pass_yds ?? 0) * (scoring.pass_yd ?? 0.04)
    + (s.pass_td ?? 0) * (scoring.pass_td ?? 4)
    + (s.rush_yds ?? 0) * (scoring.rush_yd ?? 0.1)
    + (s.rec_yds ?? 0) * (scoring.rec_yd ?? 0.1)
    + (s.receptions ?? 0) * (scoring.rec ?? 1)
    + (s.tds ?? 0) * 6;
}

/**
 * The betting model's fantasy-point view of a player's week, alongside the
 * signals that produced it.
 */
export function bettingViewOf(season, week, playerId, scoring = PPR) {
  const pv = playerFeatureVector(season, week, playerId);
  if (!pv) return null;
  const f = pv.features;

  const gs = pv.team ? gameScriptFor(pv.team, season, week) : null;
  const line = gs?.line ?? null;
  const mPass = gs?.line ? gs.pass_mult : 1;
  const mRush = gs?.line ? gs.rush_mult : 1;

  const blend = (recent, all) => (recent == null ? all : all == null ? recent : 0.65 * recent + 0.35 * all);
  const targets = (blend(f.targets_last3, f.targets) ?? 0) * mPass;
  const carries = (blend(f.carries_last3, f.carries) ?? 0) * mRush;
  const attempts = (f.pass_attempts ?? 0) * mPass;

  const stats = {
    pass_yds: attempts * (f.yards_per_attempt ?? 7),
    pass_td: attempts * (f.pass_td_rate ?? 0.045),
    rush_yds: carries * (f.yards_per_carry ?? 4.2),
    rec_yds: targets * (f.yards_per_target ?? 7.5),
    receptions: targets * (f.catch_rate ?? 0.65),
    tds: carries * (f.rush_td_rate ?? 0.03) + targets * (f.rec_td_rate ?? 0.05)
  };

  const points = statsToPoints(stats, scoring);
  const injury = injuryFor(season, week, playerId);
  const roles = pv.team ? rolesFor(season, week, pv.team) : [];
  const role = roles.find(r => r.gsis_id === playerId) ?? null;

  return {
    player_id: playerId, name: pv.name, team: pv.team, position: pv.position,
    betting_points: r2(points),
    projected_stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, r2(v)])),
    role: role ? { listed: role.role, by_snaps: role.snap_role, snap_pct: role.snap_pct,
      matches_usage: role.role_matches_usage } : null,
    game_script: line ? {
      spread: line.spread, total: line.total, implied_team_total: line.implied_points,
      opponent: line.opponent, pass_mult: gs.pass_mult, rush_mult: gs.rush_mult
    } : null,
    injury: injury ? { status: injury.report_status, practice: injury.practice_status, injury: injury.injury } : null,
    opportunity: {
      targets: r2(targets), carries: r2(carries), attempts: r2(attempts),
      target_share: f.target_share, wopr: f.wopr, opportunity_share: f.opportunity_share
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

  const delta = fantasyPoints == null ? null : r2(view.betting_points - fantasyPoints);
  const pctGap = fantasyPoints ? r2((view.betting_points - fantasyPoints) / fantasyPoints) : null;

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
  if (view.opportunity.wopr != null && view.opportunity.wopr >= 0.6) {
    reasons.push(`A ${view.opportunity.wopr.toFixed(2)} weighted opportunity rating puts him among the primary options in this offense.`);
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

  let verdict = 'aligned';
  if (pctGap != null && pctGap >= 0.15) verdict = 'betting model is higher';
  else if (pctGap != null && pctGap <= -0.15) verdict = 'betting model is lower';

  return {
    ...view,
    fantasy_points: fantasyPoints == null ? null : r2(fantasyPoints),
    delta, pct_gap: pctGap, verdict,
    reasons,
    note: verdict === 'aligned'
      ? 'The prop-side simulation and the fantasy projection agree within 15%.'
      : 'The two models disagree by more than 15%. They use the same usage data but weight recent form and game script differently — worth a look before starting or sitting.'
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
  const ids = [...new Set(playerWeeks(season).filter(p => p.week < week).map(p => p.player_id))];
  const out = [];
  for (const id of ids) {
    const v = bettingViewOf(season, week, id, scoring);
    if (!v || (v.betting_points ?? 0) < minPoints) continue;
    out.push(v);
  }
  return out.sort((a, b) => b.betting_points - a.betting_points).slice(0, limit);
}
