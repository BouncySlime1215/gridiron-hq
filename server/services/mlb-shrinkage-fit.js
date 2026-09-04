/**
 * Fits the NRFI shrinkage constants from real first-inning history instead of
 * hand-picking them — the MLB counterpart to shrinkage-fit.js's football work.
 *
 * `nrfiFor` (mlb-projections.js) shrinks two proportions toward a league prior:
 * a team's own first-inning-score rate (k was a hand-picked 12) and a venue's
 * YRFI rate (k was a hand-picked 40). A modelAudit run against 751 graded picks
 * found the resulting probabilities INVERSELY calibrated — the model's more
 * confident bucket won less often than its less confident one, a textbook
 * winner's-curse symptom of under-corrected shrinkage on a hand-picked k.
 *
 * This reuses the exact same method-of-moments one-way ANOVA (`fitK`, Searle
 * 1992) shrinkage-fit.js already established for football:
 *
 *     k* = sigma^2_within / sigma^2_between
 *
 * but applied to REPEATED per-group observations. A single season-to-date
 * rate per team (or per venue) is one number — there is nothing to take a
 * within-group variance of. So each team's (or venue's) history is split into
 * monthly chunks (the same split-season idea Brown 2008 uses for batting
 * averages): each chunk yields one proportion, arcsine-transformed so its
 * sampling variance is ~1/(4n) regardless of where the rate happens to sit,
 * then fed to `fitK` as {group, weight: games in chunk, value: transformed
 * rate}. The between-team (between-venue) spread across chunk means net of
 * within-chunk noise is exactly sigma^2_between; the residual scatter within
 * a team's/venue's own chunks is sigma^2_within.
 */
import { rows } from '../db/index.js';
import { fitK } from './shrinkage-fit.js';
import { arcsine } from './stats-util.js';

/** Groups items by `${group}|${YYYY-MM}` and reduces each chunk to {group, n, scored}. */
function monthlyChunks(items) {
  const byKey = new Map();
  for (const it of items) {
    if (it.group == null) continue;
    const month = String(it.date).slice(0, 7);
    const key = `${it.group}|${month}`;
    const c = byKey.get(key) ?? { group: it.group, n: 0, scored: 0 };
    c.n += 1;
    c.scored += it.value;
    byKey.set(key, c);
  }
  return [...byKey.values()].filter(c => c.n > 0);
}

/** {group, weight, value} observations for fitK, from monthly rate chunks. */
function chunkObservations(items) {
  return monthlyChunks(items).map(c => ({ group: c.group, weight: c.n, value: arcsine(c.scored / c.n) }));
}

/**
 * Every completed game strictly before `throughDate`, across all seasons on
 * hand — this is a structural constant (how noisy a team's first-inning
 * scoring is relative to real between-team spread), not something that should
 * reset to a handful of April games each season the way the shrink target
 * itself does.
 */
function firstInningTeamGames(throughDate) {
  return rows(`SELECT date, home_team_id, away_team_id,
                      first_inning_home_runs h, first_inning_away_runs a
               FROM mlb_games
               WHERE date < ? AND first_inning_home_runs IS NOT NULL AND first_inning_away_runs IS NOT NULL`,
    throughDate);
}

function venueYrfiGames(throughDate) {
  return rows(`SELECT date, venue, yrfi FROM mlb_games
               WHERE date < ? AND venue IS NOT NULL AND yrfi IS NOT NULL`, throughDate);
}

/** Fits k for a team's own first-inning-score rate (offense side of nrfiFor). */
export function fitTeamFirstInningK(throughDate) {
  const games = firstInningTeamGames(throughDate);
  const items = [];
  for (const g of games) {
    items.push({ group: g.home_team_id, date: g.date, value: g.h > 0 ? 1 : 0 });
    items.push({ group: g.away_team_id, date: g.date, value: g.a > 0 ? 1 : 0 });
  }
  return fitK(chunkObservations(items));
}

/** Fits k for a venue's YRFI rate (park factor side of nrfiFor). */
export function fitVenueYrfiK(throughDate) {
  const games = venueYrfiGames(throughDate);
  const items = games.map(g => ({ group: g.venue, date: g.date, value: g.yrfi }));
  return fitK(chunkObservations(items));
}

const cache = new Map();

/**
 * The k's nrfiFor should use as of `throughDate`, falling back to the old
 * hand-picked constants when there isn't yet enough history to fit from (e.g.
 * an early, mostly-empty database) — never NaN, never Infinity's poison into
 * the shrink formula (shrinkRate already treats k===Infinity as "trust the
 * prior"). Cached per calendar day: the underlying dataset only grows one
 * day's worth of games between calls, so re-fitting on every request would be
 * wasted work for an identical answer.
 */
export function nrfiKs(throughDate) {
  const key = String(throughDate).slice(0, 10);
  if (cache.has(key)) return cache.get(key);
  const team = fitTeamFirstInningK(throughDate);
  const venue = fitVenueYrfiK(throughDate);
  const out = {
    team_first_inning: team?.k != null && Number.isFinite(team.k) ? team.k : (team?.k === Infinity ? Infinity : 12),
    venue_yrfi: venue?.k != null && Number.isFinite(venue.k) ? venue.k : (venue?.k === Infinity ? Infinity : 40),
    team_fit: team, venue_fit: venue
  };
  cache.set(key, out);
  return out;
}

/** Test-only: clears the per-day cache so a test DB's fresh data is picked up. */
export function _clearNrfiKCache() { cache.clear(); }
