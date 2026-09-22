import { db as defaultDb } from '../db/index.js';

/**
 * The advanced-stats block for a player page, and the numbers it refuses to
 * invent.
 *
 * A fantasy player page is expected to carry yards per route run, route
 * participation, touchdown rate and red-zone share. Three of those four cannot
 * be computed from anything this app holds. The tempting shortcut is to reach
 * for the nearest column and call it close enough — snap share relabelled as
 * route participation, a receiving line divided by something that is not routes
 * — which is this project's signature bug, built on purpose instead of by
 * accident.
 *
 * ## What is actually here, measured rather than assumed
 *
 * `grep -rci route server/db/schema/*.js` returns 23 hits across four files and
 * every one of them is an HTTP route path, `routed_at`, or an index on an HTTP
 * route column. Control in the same scan: `targets` hits `mlb-model-misc.js`,
 * which is the real `player_week_usage` definition, so the scan works and the
 * absence is real. There is no routes-run column anywhere in this database, and
 * nflverse's weekly files — which is where `player_week_usage` comes from — do
 * not publish one. Routes are PFF / Fantasy Points Data, which is paid, and
 * nothing here is paid.
 *
 * `nfl_play_by_play` (`server/db/schema/nfl-a-to-m.js:306`) carries
 * `yards_to_endzone`, so field position exists — but the table has NO player
 * column at all, only a free-text `text` description of the play. A red-zone
 * touch therefore cannot be attributed to a player without parsing prose, which
 * is a guess wearing a number's clothes. Red-zone share is left out until it can
 * be attributed, not approximated.
 *
 * ## The contract
 *
 * Every stat carries EITHER a `value` OR an `unavailable_reason`. Never both,
 * never neither — a row with both null is a stat that quietly disappeared, and
 * disappearing is how a page ends up looking complete when it is not.
 *
 * The uncomputable three are still LISTED, with their reason. Dropping them is
 * the quieter lie: a reader counts what they can see and concludes the page
 * shows everything it knows about. An empty space makes no claim a reader can
 * argue with, which is exactly what makes it worse than a stated absence.
 *
 * A zero denominator is `not measured`, never a rate of 0. A player with no
 * targets does not have a touchdown rate of zero; he has no touchdown rate. The
 * same distinction the freshness banner draws between `stale` and `empty`.
 *
 * Every rate names its own denominator in `basis`, because "touchdown rate" on
 * its own is three different statistics depending on who is being described.
 */

/**
 * The reasons, as constants, so the same absence is explained the same way
 * everywhere and cannot drift into sounding like a fact about one player.
 * These are facts about the platform. A player with a full season of usage gets
 * the identical sentence to a player with none.
 */
export const UNAVAILABLE = {
  routes: 'No routes-run data exists on this platform. Route counts are not in the '
    + 'weekly files this page is built from, and the sources that publish them are paid.',
  redZone: 'Play-by-play records field position but not who touched the ball, so a '
    + 'red-zone touch cannot be attributed to a player. Left out rather than estimated.',
  noUsage: 'No usage rows on file for this season.',
  noOpportunities: 'No targets, carries or attempts on file, so there is no denominator '
    + 'to divide by. This is not a rate of zero.',
  noSnaps: 'No snap counts on file for this season.',
  notPopulated: 'The usage rows on file for this season do not carry this column.'
};

/** A measured stat: a value and no reason. */
const measured = (key, label, value, { unit = null, basis = null } = {}) =>
  ({ key, label, value, unit, basis, unavailable_reason: null });

/** An absent stat: a reason and no value. Still listed. */
const absent = (key, label, reason, { unit = null, basis = null } = {}) =>
  ({ key, label, value: null, unit, basis, unavailable_reason: reason });

/**
 * A rate, or the reason there isn't one. The denominator is checked before the
 * division rather than after, so a zero never becomes a 0.000 on the page.
 */
function rate(key, label, numerator, denominator, { basis, emptyReason }) {
  if (!denominator) return absent(key, label, emptyReason, { unit: 'rate', basis });
  return measured(key, label, numerator / denominator, { unit: 'rate', basis });
}

/** The mean of the non-null values, or null when nothing was measured. */
function mean(values) {
  const present = values.filter(v => v != null && Number.isFinite(Number(v))).map(Number);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

/**
 * Which denominator a touchdown rate should use for this player.
 *
 * A passer's touchdowns come per attempt; everyone else's come per target or
 * carry, counted together because a receiving back earns them both ways and
 * splitting him in two describes neither half. The choice is made from the
 * player's own position rather than from whichever column happens to be
 * largest, so the basis sentence stays stable week to week.
 */
function touchdownRate(position, totals) {
  const passer = String(position ?? '').toUpperCase() === 'QB';
  if (passer) {
    return rate('td_rate', 'Touchdown rate', totals.passing_tds, totals.attempts, {
      basis: 'touchdown passes per attempt',
      emptyReason: UNAVAILABLE.noOpportunities
    });
  }
  return rate('td_rate', 'Touchdown rate',
    totals.receiving_tds + totals.rushing_tds, totals.targets + totals.carries, {
      basis: 'touchdowns per target or carry',
      emptyReason: UNAVAILABLE.noOpportunities
    });
}

/**
 * One player's advanced-stats block for a season.
 *
 * Pure over its inputs — takes the database and the season, so a test can pin
 * both without the wall clock or the live file.
 */
export function playerAdvancedStats(playerId, { season, database = defaultDb }) {
  const player = database.prepare(
    'SELECT id, name, position FROM players WHERE id = ?').get(playerId) ?? null;

  const weeks = database.prepare(
    `SELECT week, targets, carries, attempts, receiving_tds, rushing_tds, passing_tds,
            target_share, wopr
       FROM player_week_usage
      WHERE player_id = ? AND season = ?`).all(playerId, season);

  const snaps = database.prepare(
    `SELECT offense_pct FROM player_week_snaps
      WHERE player_id = ? AND season = ?`).all(playerId, season);

  const sum = col => weeks.reduce((a, w) => a + Number(w[col] ?? 0), 0);
  const totals = {
    targets: sum('targets'), carries: sum('carries'), attempts: sum('attempts'),
    receiving_tds: sum('receiving_tds'), rushing_tds: sum('rushing_tds'),
    passing_tds: sum('passing_tds')
  };

  const noUsage = weeks.length === 0;
  const targetShare = noUsage ? null : mean(weeks.map(w => w.target_share));
  const wopr = noUsage ? null : mean(weeks.map(w => w.wopr));
  const snapShare = mean(snaps.map(s => s.offense_pct));

  // Three different absences, and they must not share a sentence: no rows at
  // all, rows that exist but leave this column null, and a value. The middle
  // one used to borrow the snap-count reason, which described a table this stat
  // does not even read.
  const share = (key, label, value, unit) => value != null
    ? measured(key, label, value, { unit })
    : absent(key, label, noUsage ? UNAVAILABLE.noUsage : UNAVAILABLE.notPopulated, { unit });

  return {
    player_id: Number(playerId),
    name: player?.name ?? null,
    position: player?.position ?? null,
    season,
    // How much data is behind the numbers, stated rather than implied. Two weeks
    // and twelve weeks produce the same-looking rate and are not the same claim.
    weeks_measured: weeks.length,
    stats: [
      share('target_share', 'Target share', targetShare, 'pct'),
      share('wopr', 'Weighted opportunity (WOPR)', wopr, 'index'),
      snapShare == null
        ? absent('snap_share', 'Snap share', UNAVAILABLE.noSnaps, { unit: 'pct' })
        : measured('snap_share', 'Snap share', snapShare, { unit: 'pct' }),
      noUsage
        ? absent('td_rate', 'Touchdown rate', UNAVAILABLE.noUsage, { unit: 'rate' })
        : touchdownRate(player?.position, totals),
      // The three that are absent by platform, not by player. Listed every time,
      // for every player, with the same sentence — see UNAVAILABLE above.
      absent('yards_per_route_run', 'Yards per route run', UNAVAILABLE.routes, { unit: 'yards' }),
      absent('route_participation', 'Route participation', UNAVAILABLE.routes, { unit: 'pct' }),
      absent('red_zone_share', 'Red-zone share', UNAVAILABLE.redZone, { unit: 'pct' })
    ]
  };
}
