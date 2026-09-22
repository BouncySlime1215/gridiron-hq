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
 *
 * ## Two absences that are not the same absence
 *
 * A stat can be missing because nobody measured it, or because it is not a
 * statistic about this player's position. The block used to say the first when
 * it meant the second: a quarterback's `target_share` is null in every row the
 * ingest writes — `nflverse.js:218` carries the column and `numAt` turns
 * nflverse's `NA` into SQL null — and the block reported "the usage rows do not
 * carry this column", which is false. The rows carry it. A passer is not
 * targeted.
 *
 * So `unavailable_kind` names which of the two it is, `not_applicable` or
 * `not_measured`, and the page groups on that field rather than reading the
 * sentence. Sorting absences by prose is how a reworded sentence moves a row
 * into the wrong group without anybody noticing.
 *
 * Applicability is decided from the position and nothing else, and it is NOT
 * decided at all when the position is unknown — a blank `players.position`
 * (the column is NOT NULL, so unknown arrives blank) or no player row. Ruling
 * "not applicable" without knowing what it would not apply to is the same guess
 * in a third costume.
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

/**
 * The positions a pass can be thrown to. Target share, WOPR and anything built
 * on routes describe these and nobody else.
 *
 * A set rather than a "not a quarterback" test: a kicker has no target share
 * either, and writing the rule as an exception for one position means every
 * other position silently falls on the wrong side of it.
 */
export const RECEIVING_POSITIONS = new Set(['RB', 'FB', 'HB', 'WR', 'TE']);

/**
 * The sentence for a stat that does not describe this position.
 *
 * It names the position it is about, so it reads as an answer rather than a
 * general disclaimer, and it says outright that this is not a gap in the data,
 * because that is the whole distinction being drawn.
 */
export const notApplicableTo = (position, why) =>
  `Not a statistic about a ${position}: ${why}. This is a fact about the position, `
  + 'not a gap in the data.';

/** Why each positional stat is not about a position that is not thrown to. */
const NOT_THROWN_TO = {
  target_share: 'target share counts the passes thrown at a player',
  wopr: 'weighted opportunity is built out of targets and air yards',
  yards_per_route_run: 'running pass routes is not part of the job',
  route_participation: 'running pass routes is not part of the job'
};

/**
 * Does this stat describe this position — yes, no, or we cannot say.
 *
 * `null` is the third answer and it is load-bearing: an unknown position gets
 * no ruling, and the stat falls back to whatever the data says about it.
 */
function appliesToPosition(position) {
  const p = String(position ?? '').trim().toUpperCase();
  if (p === '') return null;
  return RECEIVING_POSITIONS.has(p);
}

/** A measured stat: a value, no reason, and no kind of absence to report. */
const measured = (key, label, value, { unit = null, basis = null } = {}) =>
  ({ key, label, value, unit, basis, unavailable_reason: null, unavailable_kind: null });

/**
 * An absent stat: a reason, no value, and which kind of absence it is. Still
 * listed. `kind` defaults to `not_measured` because that is the ordinary case;
 * `not_applicable` is only ever set deliberately, from a known position.
 */
const absent = (key, label, reason,
  { unit = null, basis = null, kind = 'not_measured' } = {}) =>
  ({ key, label, value: null, unit, basis, unavailable_reason: reason,
    unavailable_kind: kind });

/** The absence of a stat that does not describe this position. */
const inapplicable = (key, label, position, { unit = null } = {}) =>
  absent(key, label, notApplicableTo(String(position).trim().toUpperCase(),
    NOT_THROWN_TO[key]), { unit, kind: 'not_applicable' });

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

  // Decided once, from the position alone. `null` means we do not know the
  // position, and an unknown position rules on nothing.
  const position = player?.position ?? null;
  const applies = appliesToPosition(position);

  // Four different absences now, and none of them may share a sentence: the
  // stat does not describe this position; there are no rows at all; the rows
  // exist and leave this column null; or there is a value. The third used to
  // borrow the snap-count reason, which described a table this stat does not
  // read, and the first used to borrow the third's, which described a file that
  // is not at fault.
  //
  // Applicability is asked FIRST. A quarterback with no rows this season still
  // has no target share for the same reason he would have none with twelve
  // weeks of rows, so "no usage rows" would be true and beside the point.
  const share = (key, label, value, unit) => {
    if (applies === false) return inapplicable(key, label, position, { unit });
    if (value != null) return measured(key, label, value, { unit });
    return absent(key, label, noUsage ? UNAVAILABLE.noUsage : UNAVAILABLE.notPopulated, { unit });
  };

  /** A routes stat: not about this position, or absent from the platform. */
  const routes = (key, label, unit) => applies === false
    ? inapplicable(key, label, position, { unit })
    : absent(key, label, UNAVAILABLE.routes, { unit });

  return {
    player_id: Number(playerId),
    name: player?.name ?? null,
    position,
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
        : touchdownRate(position, totals),
      // Absent by platform for anyone who runs routes, and not about the
      // position for anyone who does not.
      routes('yards_per_route_run', 'Yards per route run', 'yards'),
      routes('route_participation', 'Route participation', 'pct'),
      // Red-zone share is NOT gated on position. A quarterback takes red-zone
      // carries, so the position does not rule this one out; what rules it out
      // is that play-by-play carries no player column. Gating it here would be
      // a true-sounding sentence for the wrong reason, and it would go on being
      // wrong after the attribution problem was solved.
      absent('red_zone_share', 'Red-zone share', UNAVAILABLE.redZone, { unit: 'pct' })
    ]
  };
}
