/**
 * The one producer of "likely gameday inactive" (RL-10-1), fed to SS-01's dead-starter guard
 * as its `inactive` hook (dead-starters.js#deadReason, lineup-brain.js#lineupCall).
 *
 * The signal is ESPN's own weekly projection going to 0. R&D round 10
 * (rnd/loop/r10-external-espn-zero-is-the-inactive-feed.md, 2021-24 REG) found that at ESPN's
 * final pregame projection, 218 of 238 (92%) fantasy-relevant surprise scratches (Friday
 * Questionable or undesignated) were already at 0 (< 0.05, this module's ZERO_MAX). Precision
 * is quoted on the population this hook can flag: Out/Doubtful are excluded below, so the
 * all-zeros 630/704 (90%, which includes 338 Friday Out/Doubtful players, every one inactive)
 * does not describe it. For Friday Questionable or undesignated players at 0, 265 of 306
 * (87%, 95% CI 0.83-0.90) did not play. Command: study/rl-10-1/r10x_prec_split.py.
 *
 * DEFAULT-OFF, "unconfirmed forward". R&D r10 section 6 gates default-on on a W4-W5 Sunday
 * timing test (when ESPN flips to 0 before lock; RL-10-2's poller), and the only 2026 check so
 * far (W2) used post-game captures. Set GRIDIRON_ESPN_ZERO_INACTIVE=1 to switch it on.
 *
 * Source: table `league_roster_snapshots` (migration 058), written by
 * scripts/collect-roster-snapshots.mjs#rowsFromEntries (`projected_points` at :92, ESPN
 * statSourceId 1) via #writePeriod (:109). No new network call and no new table.
 *
 * Rule, per rostered player of the league: ESPN projected him at >= 5 last week (any team in
 * this league, so a traded player still counts) and projects him at 0 now, and his ESPN
 * status (pregame or current) is not already Out / Doubtful / IR / Suspended through the
 * canonical contingency.js#weekDesignation. deadReason() checks those designations first
 * anyway, so the card can never show him twice.
 *
 * One number: when on, lineupCall() also holds every flagged player out of the solver (lineup,
 * bench, warnings) and names him in `unavailable`, so the card and the lineup never disagree.
 * Other surfaces that print contingency.js#weeklyAvailability's active_probability (TradeCard,
 * WaiverWire, Model) do not read this hook yet: named follow-up in the RL-10-1 evidence file.
 *
 * Not wired on purpose: RL-3-2's Bluesky arm (PR #184). One producer for this signal.
 */
import { rows } from '../db/index.js';
import { weekDesignation } from './contingency.js';
import { previewUnconfirmed, previewFields } from './preview-mode.js';

export const ESPN_ZERO_SOURCE = 'espn_projection_zero';
/** ESPN projection last week that makes a player relevant (R&D r10's pool rule). */
export const PRIOR_MIN = 5;
/** ESPN rounds to hundredths; anything below this is its 0. */
export const ZERO_MAX = 0.05;

export const ESPN_ZERO_SENTENCE = 'ESPN projects 0: likely inactive';
export const ESPN_ZERO_LABEL =
  "Source: ESPN's weekly projection, from this league's roster snapshot. 92% of surprise scratches " +
  "(2021-24) were at 0 at ESPN's final pregame projection, and 87% of Questionable or undesignated " +
  'players at 0 did not play. This is unconfirmed forward: timing not yet tested (when ESPN flips to 0 on game day).';

/** Default-off until R&D r10 section 6's W4-W5 Sunday timing test passes (RL-10-2). */
export const ESPN_ZERO_ENV = 'GRIDIRON_ESPN_ZERO_INACTIVE';
export const espnZeroEnabled = () => process.env[ESPN_ZERO_ENV] === '1';
export const ESPN_ZERO_OFF_REASON =
  'ESPN-projects-0 inactive flag is default-off, unconfirmed forward: R&D r10 section 6 gates it on a ' +
  `W4-W5 Sunday timing test (RL-10-2) that has not run. Set ${ESPN_ZERO_ENV}=1 to switch it on. ` +
  'RL-3-2 (live-inactive-monitor.js) has not landed either, so no in-week inactive source is on.';

const missingTable = e => /no such table/i.test(String(e?.message ?? e));

function uncovered(reason) {
  return { covered: false, source: ESPN_ZERO_SOURCE, reason, ids: new Set(),
    sentence: ESPN_ZERO_SENTENCE, label: ESPN_ZERO_LABEL, as_of: null };
}

const alreadyOut = status => {
  const { designation } = weekDesignation({ espnStatus: status ?? null });
  return designation === 'out' || designation === 'doubtful';
};

/**
 * The inactive hook for one league and week.
 * @returns {{covered, source, reason, ids: Set<players.id>, sentence, label, as_of}}
 */
export function espnZeroInactive(leagueId, { season, week, enabled }) {
  // PREVIEW-01: the local-testing switch turns the hook on when neither the caller nor the
  // site flag has; the hook then carries preview:true and the default-off reason.
  const preview = enabled === undefined && !espnZeroEnabled() && previewUnconfirmed();
  const on = enabled === undefined ? (espnZeroEnabled() || preview) : enabled;
  if (!on) return uncovered(ESPN_ZERO_OFF_REASON);
  const hook = hookFor(leagueId, season, week);
  return preview ? { ...hook, ...previewFields(ESPN_ZERO_OFF_REASON) } : hook;
}

function hookFor(leagueId, season, week) {
  if (leagueId == null || season == null || week == null) return uncovered('no league, season or week');
  let now, prior;
  try {
    now = rows(`SELECT s.espn_player_id, COALESCE(s.player_id, p.id) AS player_id, s.projected_points,
        s.injury_status, s.pregame_injury_status, s.changed_at
      FROM league_roster_snapshots s LEFT JOIN players p ON p.espn_id = s.espn_player_id
      WHERE s.league_id = ? AND s.season = ? AND s.scoring_period_id = ? AND s.on_roster = 1`,
    leagueId, season, week);
    prior = rows(`SELECT espn_player_id, MAX(projected_points) AS projected_points
      FROM league_roster_snapshots
      WHERE league_id = ? AND season = ? AND scoring_period_id = ?
      GROUP BY espn_player_id`, leagueId, season, week - 1);
  } catch (e) {
    if (missingTable(e)) return uncovered('league_roster_snapshots does not exist yet (migration 058 not applied)');
    throw e;
  }
  if (!now.length) {
    return uncovered(`no league_roster_snapshots rows for week ${week} in this league ` +
      '(the local refresh loop writes them); RL-3-2 (live-inactive-monitor.js) has not landed either');
  }
  if (!prior.length) return uncovered(`no league_roster_snapshots rows for week ${week - 1}, so there is no projection to compare`);

  const priorBy = new Map(prior.map(r => [r.espn_player_id, r.projected_points]));
  const ids = new Set();
  let asOf = null;
  for (const r of now) {
    if (asOf == null || r.changed_at > asOf) asOf = r.changed_at;
    if (r.player_id == null || r.projected_points == null) continue;
    const before = priorBy.get(r.espn_player_id);
    if (before == null || before < PRIOR_MIN) continue;
    if (r.projected_points >= ZERO_MAX) continue;
    if (alreadyOut(r.injury_status) || alreadyOut(r.pregame_injury_status)) continue;
    ids.add(r.player_id);
  }
  return { covered: true, source: ESPN_ZERO_SOURCE,
    reason: `ESPN projection read from league_roster_snapshots, last captured ${asOf}`,
    ids, sentence: ESPN_ZERO_SENTENCE, label: ESPN_ZERO_LABEL, as_of: asOf };
}
