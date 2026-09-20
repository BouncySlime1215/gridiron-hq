/**
 * One of Nick's own leagues, scored against the STORED Team Outlook fit.
 *
 * This is the consumer O4 has never had. #42 built the panel and deliberately stopped
 * short of wiring it, and the reason was correct at the time: `history-corpus.js` opens
 * the crawled corpus from `process.cwd()/data/derived/` and the Dockerfile's runtime
 * stage copies only `client/dist`, `server` and `scripts`, so `fitOutlook` resolved to
 * nothing on the deployed app -- silently, and only there. Migration 065 and
 * `outlook-fit-store.js` closed that: the fit is a row in the app's own database now, and
 * the request path only ever reads. So this file fits nothing. It loads a fit or it says
 * why it cannot.
 *
 * WHY ITS OWN FILE. `outlook-fit-store.js` imports `OUTLOOK_FEATURES` from
 * `team-outlook.js` to validate what it stores. A consumer inside `team-outlook.js` would
 * have to import the store back, and a cycle between the model and its own persistence is
 * the kind of thing that works until an unrelated import order changes.
 *
 * THE THREE CORRECTIONS THIS MAKES, AND WHY EACH IS NOT OPTIONAL. Every one of them is a
 * case where the untouched pipeline returns a number rather than an error:
 *
 *   1. `weeks_left`. `weeklyPanel` computes it as `totalWeeks - (i + 1)` over the rows a
 *      team HAS. For a corpus row from a finished season that IS the weeks remaining; for
 *      a league three weeks into a fourteen-week season it is zero. `weeks_left` is one of
 *      the six fitted features, so the team is then priced as though its record were
 *      final: a bad start reads as fatal and a good one as safe, at exactly the weeks
 *      where the model's whole claim is that little is settled. The season length comes
 *      from the payload (`settings.scheduleSettings.matchupPeriodCount`), and a payload
 *      without it is refused rather than served, because there is no honest substitute --
 *      a default would be inventing the length of somebody's season.
 *   2. The league's format. `featureRow` falls back to `playoff_share = 0.5` and
 *      `weeklyPanel` puts the playoff cut at the whole field when `playoff_teams` is
 *      missing. Six of twelve and two of four are different worlds, and both `games_back`
 *      and `playoff_share` are fitted features, so a fallback here is an invented format
 *      scored as though it were the real one.
 *   3. A week the fit does not cover. The fit is per week and `OUTLOOK_GATE.weeks` is
 *      2 to 8. `predictOutlook` returns null outside them, `verdictFor(null, …)` returns
 *      null, and a surface handed nulls prints blanks with nothing beside them saying why.
 *
 * WHAT IT DOES NOT DO. It does not promote a verdict to `act`. The plan defines Act as two
 * conditions -- odds below the fitted threshold AND a move that raises them -- and only the
 * first is computable here. A caller holding the Trade Brain's best move is the one that
 * can promote it; see `team-outlook.js`'s header.
 */
import { weeklyPanel } from './history-corpus.js';
import { activeOutlookFit, outlookFitStatus } from './outlook-fit-store.js';
import { espnWeeklyRows } from './espn-weekly-scores.js';
import {
  featureRow, predictOutlook, verdictFor, decompose, OUTLOOK_FEATURES
} from './team-outlook.js';

const notReady = reason => ({ ready: false, reason });

/** The finest probability a surface shows, and the reason it is not `toFixed` alone. */
const PLACES = 4;
const FINEST = 10 ** -PLACES;

/**
 * Round a probability for display WITHOUT handing back a certainty.
 *
 * `predictOutlook` returns a clamped value -- `team-outlook.js`'s `clamp01` caps it at
 * 1 - 1e-6 and floors it at 1e-6 -- because a logistic fit on a few hundred league-seasons
 * is not entitled to say a team is certain. `(0.9999996).toFixed(4)` is `'1.0000'`, so
 * rounding alone puts back exactly the value the clamp was written to remove, and the page
 * prints a 100% playoff chance at week 3. This keeps the rounded number strictly inside the
 * bounds: at four places, 0.9999 and 0.0001.
 */
function forDisplay(p) {
  if (p == null || !Number.isFinite(p)) return null;
  return Math.min(1 - FINEST, Math.max(FINEST, +p.toFixed(PLACES)));
}

/**
 * The outlook panel for one league row from `leagues`, or a sentence saying why there
 * isn't one.
 *
 * Never returns a half-filled shape: the caller gets `ready: true` with every team priced,
 * or `ready: false` with a `reason` a page can print as it stands. That is the shape the
 * store's header argues for, and the reason a chip pointed at nothing is worse than the
 * heuristic label it would replace.
 */
export function leagueOutlook(lg) {
  // ONE read decides, and the status is consulted only for the words. Both functions call
  // the store's `latest()` and refuse on exactly the same condition, so a `status.present`
  // check ahead of this one cannot reject anything the load would accept: it was here, and a
  // mutation that deleted it changed no test, which is how it was found to be dead.
  const fit = activeOutlookFit();
  if (!fit) {
    return notReady(outlookFitStatus().reason ?? 'the outlook model has not been fitted on this deployment');
  }

  const raw = espnWeeklyRows(lg);
  if (!raw.ok) return notReady(raw.reason);

  if (!(raw.regular_periods > 0)) {
    return notReady('this league\'s payload does not say how many weeks its regular season runs, '
      + 'and the model reads the weeks remaining as one of its inputs');
  }
  if (!(raw.num_teams > 0) || !(raw.playoff_teams > 0)) {
    return notReady('this league\'s payload does not say how many teams make the playoffs, '
      + 'and how far a team is from that line is one of the model\'s inputs');
  }

  const week = raw.last_week;
  if (!fit.byWeek?.[week]) {
    return notReady(`the stored outlook model covers weeks ${fit.weeks.join(', ')}, `
      + `and this league has played through week ${week}`);
  }

  const weeksLeft = raw.regular_periods - week;
  const panel = weeklyPanel({ rows: raw.rows })
    .filter(r => r.week === week)
    // The one correction, applied where it is visible, rather than inside the shared
    // producer: `weeklyPanel` is right for the corpus it was written for, and changing it
    // there would put the live league's assumption into every fit.
    .map(r => ({ ...r, weeks_left: weeksLeft }));

  if (!panel.length) {
    return notReady(`no team rows survived for week ${week} of this league`);
  }

  const teams = panel.map(row => {
    const features = featureRow(row, fit.k);
    const probability = predictOutlook(fit, row);
    return {
      roster_id: row.roster_id,
      probability: forDisplay(probability),
      verdict: verdictFor(probability, fit.thresholds),
      features: Object.fromEntries(OUTLOOK_FEATURES.map(name => [name, features[name]])),
      decomposition: decompose(fit, row),
      games: row.games,
      wins_so_far: row.wins_so_far,
      games_back: row.games_back
    };
  });

  return {
    ready: true,
    season: raw.season,
    week,
    weeks_played: raw.weeks_played,
    weeks_left: weeksLeft,
    regular_periods: raw.regular_periods,
    num_teams: raw.num_teams,
    playoff_teams: raw.playoff_teams,
    fit: {
      id: fit.id, k: fit.k, weeks: fit.weeks, thresholds: fit.thresholds,
      fitted_at: fit.fitted_at, through_season: fit.through_season,
      basis: `the stored Team Outlook fit, fitted through ${fit.through_season ?? 'an unrecorded season'} `
        + 'on completed league seasons and read from this database'
    },
    teams
  };
}
