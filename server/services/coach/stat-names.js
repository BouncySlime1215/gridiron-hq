/**
 * One name per stat, everywhere, and an explanation someone who never deals
 * with stats can actually use.
 *
 * Nick's binding rule for the redesign, 2026-09-20: every stat carries one
 * normalised name across the whole platform, and its explanation is detailed
 * rather than "wtf". Today the same quantity wears different names on
 * different screens because each screen named it itself. This is the one
 * list. Coach's claims, TeamDetail, the player page and News all read from
 * here, and a test asserts that every field named below is a real column of a
 * real table and that no display name means two things.
 *
 * Three fields do the work in every explanation:
 *   plain   what the number IS, in a sentence with no jargon in it.
 *   why     why anyone should care, in fantasy terms.
 *   better  which direction is good, because a number with no direction is
 *           just a number.
 *
 * NOT_STORED at the bottom is the other half of being honest. A stat this app
 * does not have is named there with what it would take to have it, because a
 * screen that says nothing about a missing stat is how a screen ends up
 * inventing one. Yards per route run is the standing example: it is the stat
 * people ask for most and nothing in this database can produce it.
 *
 * Definitions of third-party stats (Next Gen Stats, Pro Football Reference,
 * nflverse) are those sources' own. Where a definition is this app's, `source`
 * says so.
 */

const concept = (name, unit, better, plain, why, source = 'nflverse') =>
  Object.freeze({ name, unit, better, plain, why, source });

/**
 * Every stat this app stores, by its normalised id. The id is internal; the
 * `name` is what a person reads and is the same on every screen.
 */
export const STAT_CONCEPTS = Object.freeze({
  // --- opportunity: how much work a player is actually given ---
  targets: concept('Targets', 'passes', 'higher',
    'How many times the quarterback threw the ball in this player\'s direction, whether or not he caught it.',
    'Catches depend on luck and coverage; being thrown at does not. It is the single most stable sign that a coach trusts a receiver.'),
  receptions: concept('Catches', 'catches', 'higher',
    'How many of those passes he actually caught.',
    'In a PPR league each catch is a point on its own, before any yards.'),
  carries: concept('Carries', 'runs', 'higher',
    'How many times he was handed the ball to run with.',
    'Carries near the goal line are where most rushing touchdowns come from, so volume here drives scoring.'),
  pass_attempts: concept('Pass attempts', 'passes', 'higher',
    'How many passes the quarterback threw.',
    'A quarterback who throws 40 times has roughly twice the chance to score as one who throws 20, whatever else is true.'),
  target_share: concept('Target share', 'share of 1', 'higher',
    'Of every pass his team threw, the fraction thrown at him. 0.28 means 28 of every 100.',
    'It separates a player who is genuinely first in line from one who happened to get eight targets in a game where his team threw fifty.'),
  air_yards_share: concept('Air-yards share', 'share of 1', 'higher',
    'Of all the yards his team\'s passes travelled in the air, the fraction that travelled toward him — counting the throw whether or not he caught it.',
    'This is the share of the DOWNFIELD work. A player with a high target share but a low air-yards share is being used on short passes, which caps how big his games can get.'),
  wopr: concept('WOPR', 'index', 'higher',
    'Weighted Opportunity Rating: target share and air-yards share combined into one number, weighted 1.5 to 0.7 in favour of targets.',
    'One number for "how central is he to this passing game", which is the question behind most start/sit and trade decisions.'),
  snap_share: concept('Snap share', 'share of 1', 'higher',
    'Of his team\'s offensive plays, the fraction he was on the field for.',
    'It is the first thing to move when a role changes — a player coming off the field on third down is being phased out before the box score shows it.'),
  first_downs: concept('First downs', 'first downs', 'higher',
    'How many of his plays moved the chains.',
    'Moving the chains keeps his offence on the field, which is how a player gets more chances in the same game.'),

  // --- efficiency: what he does with the work ---
  catch_rate: concept('Catch rate', 'percent', 'higher',
    'Of the passes thrown at him, the percentage he caught.',
    'Read it against how far downfield he plays: 60% on deep throws is excellent and 60% on screens is a problem.'),
  adot: concept('aDOT', 'yards', 'neither',
    'Average depth of target: how far past the line of scrimmage the ball was thrown, averaged over every pass aimed at him — caught or not.',
    'It is the shape of a player, not his quality. A low number means safe and steady; a high one means fewer catches and bigger ones.', 'Pro Football Reference'),
  racr: concept('RACR', 'ratio', 'higher',
    'Receiver Air Conversion Ratio: the receiving yards he produced for each yard the ball travelled in the air toward him.',
    'Above 1 means he is adding yards after the catch beyond what the throw gave him. It is how a short-target player can still be valuable.'),
  pacr: concept('PACR', 'ratio', 'higher',
    'Passer Air Conversion Ratio: the passing yards a quarterback produced for each yard his throws travelled in the air.',
    'It separates a quarterback whose receivers turn throws into yards from one whose deep balls fall incomplete.'),
  cpoe: concept('CPOE', 'percentage points', 'higher',
    'Completion Percentage Over Expected: how much more often a quarterback completed a pass than a typical quarterback would have, given the same throws.',
    'It adjusts for difficulty, so a checkdown artist and a deep thrower can be compared on the same scale.'),
  yac_over_expected: concept('YAC over expected', 'yards', 'higher',
    'Yards after the catch above what a typical receiver would have gained from the same catch in the same situation.',
    'This is the part of a receiver\'s production that is him rather than his offence.', 'Next Gen Stats'),
  separation: concept('Separation', 'yards', 'higher',
    'How far the nearest defender was when the ball arrived, averaged over his targets.',
    'A receiver who cannot get open is one coverage change away from losing his role, however good his box score looks.', 'Next Gen Stats'),
  cushion: concept('Cushion', 'yards', 'neither',
    'How far off him the defender lined up before the snap, averaged over his targets.',
    'A big cushion means defences fear him deep and are conceding the short throw; a small one means the opposite.', 'Next Gen Stats'),
  rush_yards_over_expected: concept('Rush yards over expected per carry', 'yards', 'higher',
    'Yards gained per carry above what a typical back would have gained with the same blocking and the same defenders in the box.',
    'It separates the runner from the offensive line, which is the whole question when a back changes teams.', 'Next Gen Stats'),
  rush_efficiency: concept('Rush efficiency', 'index', 'lower',
    'How much total distance he travelled, side to side included, for each yard gained downfield.',
    'A high number means a lot of dancing. It is context for a bad yards-per-carry, not a verdict on its own.', 'Next Gen Stats'),
  broken_tackles: concept('Broken tackles', 'tackles', 'higher',
    'How many tackles he made defenders miss.',
    'The clearest sign that a player creates yards his blocking did not give him.', 'Pro Football Reference'),
  drop_rate: concept('Drop rate', 'percent', 'lower',
    'The percentage of catchable passes he dropped.',
    'Drops are not very repeatable year to year, so a high rate is usually a reason to buy rather than to sell.', 'Pro Football Reference'),
  yac_per_reception: concept('Yards after catch per catch', 'yards', 'higher',
    'Of his yards, how many came after he caught the ball, per catch.',
    'It is the half of a receiver\'s yardage the quarterback did not give him.', 'Pro Football Reference'),
  ybc_per_reception: concept('Yards before catch per catch', 'yards', 'neither',
    'Of his yards, how many the ball had already travelled when he caught it, per catch.',
    'The companion to the one above: together they say whether a player is a deep threat or a yards-after-catch player.', 'Pro Football Reference'),

  // --- quarterback shape ---
  time_to_throw: concept('Time to throw', 'seconds', 'neither',
    'How long the quarterback held the ball before releasing it, averaged over his throws.',
    'A quick release protects a bad offensive line and shortens throws; a long one means deep shots and sacks.', 'Next Gen Stats'),
  aggressiveness: concept('Aggressiveness', 'percent', 'neither',
    'The percentage of his throws made into tight coverage, with a defender within a yard of the receiver when the ball arrives.',
    'An aggressive quarterback makes his receivers more valuable and his own completion rate worse.', 'Next Gen Stats'),
  pressure_rate: concept('Pressure rate', 'percent', 'lower',
    'The percentage of his dropbacks on which he was hurried, hit or sacked.',
    'Pressure is the best single predictor of a bad passing day, and it is mostly about the line rather than the quarterback.', 'Pro Football Reference'),
  on_target_rate: concept('On-target rate', 'percent', 'higher',
    'The percentage of his throws that were catchable, ignoring drops and throwaways.',
    'It is completion percentage with the receivers\' hands taken out of it.', 'Pro Football Reference'),
  pocket_time: concept('Pocket time', 'seconds', 'neither',
    'How long he had before the pocket broke down, averaged over his dropbacks.',
    'Read alongside time to throw: a quarterback holding the ball longer than his pocket lasts is about to be sacked a lot.', 'Pro Football Reference'),
  qbr: concept('QBR', 'index 0-100', 'higher',
    "ESPN's Total Quarterback Rating: every play a quarterback was involved in, weighted by how much it mattered to winning.",
    'The one quarterback number that accounts for running, sacks and situation rather than passing alone.', 'ESPN'),

  // --- value, expectation and outcomes ---
  fantasy_points: concept('Fantasy points', 'points', 'higher',
    'What he actually scored under this league\'s scoring.',
    'The outcome. Everything else on this list exists to predict it.', 'this app'),
  expected_fantasy_points: concept('Expected points', 'points', 'higher',
    'What a typical player would have scored from exactly the same opportunities — the same targets at the same depths, the same carries from the same places on the field.',
    'The gap between this and what he actually scored is the clearest sell-high or buy-low signal there is: opportunity repeats, finishing does not.', 'ffopportunity'),
  epa: concept('EPA', 'points', 'higher',
    'Expected Points Added: how much his plays improved his team\'s chance of scoring, compared with an average play in the same situation.',
    'It values a 4-yard gain on third-and-3 above a 9-yard gain on third-and-12, which is what actually happened.'),
  interceptions: concept('Interceptions', 'throws', 'lower',
    'Passes he threw that the defence caught.',
    'Directly negative in every scoring system, and they end drives that would otherwise have scored.'),
  fumbles_lost: concept('Fumbles lost', 'fumbles', 'lower',
    'Times he lost the ball and the other team recovered it.',
    'Negative points, and a back who fumbles twice tends to lose goal-line work.'),

  // --- availability ---
  chance_to_play: concept('Chance to play', 'probability 0-1', 'higher',
    'How likely this player is to be on the field this week, worked out from the official injury report, beat-reporter signals and his recent snap counts together.',
    'The first question before any lineup decision, and the one the box score cannot answer. Never show it without its basis (below): the same 0.82 can be a measurement or a constant.', 'this app'),
  availability_basis: concept('Chance-to-play basis', 'label', 'neither',
    'Where a chance-to-play number came from. "fitted" means it was measured from this player\'s own situation; "durability_prior" means it was measured from players like him; "default_durability" means nobody measured anything and a single constant was used.',
    'A default_durability number is not a measurement and a claim resting on one has to say so. Kickers and defences always land there, because the availability model covers quarterbacks, running backs, receivers and tight ends only.', 'this app')
});

/**
 * Where each concept actually lives. The same concept appearing under two
 * tables is the point: one stat, one name, wherever it is read from.
 */
export const STAT_FIELDS = Object.freeze({
  'player_week_usage.targets': 'targets',
  'player_week_usage.receptions': 'receptions',
  'player_week_usage.carries': 'carries',
  'player_week_usage.attempts': 'pass_attempts',
  'player_week_usage.target_share': 'target_share',
  'player_week_usage.air_yards_share': 'air_yards_share',
  'player_week_usage.wopr': 'wopr',
  'player_week_usage.racr': 'racr',
  'player_week_usage.pacr': 'pacr',
  'player_week_usage.cpoe': 'cpoe',
  'player_week_usage.first_downs': 'first_downs',
  'player_week_usage.passing_epa': 'epa',
  'player_week_usage.rushing_epa': 'epa',
  'player_week_usage.receiving_epa': 'epa',
  'player_week_usage.interceptions': 'interceptions',
  'player_week_usage.fumbles_lost': 'fumbles_lost',

  'player_week_snaps.offense_pct': 'snap_share',
  'nfl_snaps.offense_pct': 'snap_share',

  'player_gamelog.fantasy_points': 'fantasy_points',
  'nfl_ffopportunity_weekly.expected_fantasy_points': 'expected_fantasy_points',
  'nfl_ffopportunity_weekly.actual_fantasy_points': 'fantasy_points',

  'off_ngs_season.air_yards_share': 'air_yards_share',
  'off_ngs_season.catch_percentage': 'catch_rate',
  'off_ngs_season.avg_separation': 'separation',
  'off_ngs_season.avg_cushion': 'cushion',
  'off_ngs_season.avg_yac_above_expectation': 'yac_over_expected',
  'off_ngs_season.rush_yards_over_expected_per_att': 'rush_yards_over_expected',
  'off_ngs_season.rush_efficiency': 'rush_efficiency',
  'off_ngs_season.avg_time_to_throw': 'time_to_throw',
  'off_ngs_season.aggressiveness': 'aggressiveness',
  'off_ngs_season.completion_pct_above_expectation': 'cpoe',

  'off_pfr_adv_season.adot': 'adot',
  'off_pfr_adv_season.yac_per_rec': 'yac_per_reception',
  'off_pfr_adv_season.ybc_per_rec': 'ybc_per_reception',
  'off_pfr_adv_season.broken_tackles': 'broken_tackles',
  'off_pfr_adv_season.drop_pct': 'drop_rate',
  'off_pfr_adv_season.pressure_pct': 'pressure_rate',
  'off_pfr_adv_season.on_target_pct': 'on_target_rate',
  'off_pfr_adv_season.pocket_time': 'pocket_time',

  'off_qbr_season.qbr_total': 'qbr'
});

/**
 * Stats this app does NOT have, named on purpose.
 *
 * A screen that says nothing about a missing stat is how a screen ends up
 * inventing one, and a model asked for a number it cannot retrieve is how an
 * answer ends up wrong. Each of these is a real question someone will ask.
 */
export const NOT_STORED = Object.freeze([
  Object.freeze({
    name: 'Yards per route run',
    plain: 'Receiving yards divided by the number of pass routes the player actually ran, rather than by games or by targets.',
    why: 'It is the best single efficiency number for a receiver, because it counts the plays he was available to be thrown to rather than the plays he was thrown to.',
    needs: 'A routes-run count per player per week. Nothing in this database has one — not player_week_usage, not nfl_snaps, not the off_* season tables — and it is not derivable from snap counts, because a snap is not a route. It would need a charting feed (PFF, Fantasy Points Data or similar), which is a paid source.'
  }),
  Object.freeze({
    name: 'Touchdown rate',
    plain: 'The share of a player\'s touches or targets that ended in a touchdown.',
    why: 'Touchdown rate swings wildly year to year, so a player far above or below his own history is usually about to move back toward it — which is exactly when to buy or sell him.',
    needs: 'The pieces exist (touchdowns and touches are both in player_week_usage) but nothing computes or stores the rate, and doing it properly needs red-zone and goal-line touches split out, which this database does not carry. Coach can compute a crude version per player through the ledger; it should not be shown as a stored stat until the red-zone split exists.'
  }),
  Object.freeze({
    name: 'Route participation',
    plain: 'The share of his team\'s pass plays on which the player ran a route, rather than blocked or stayed in.',
    why: 'It is the cleanest early sign that a tight end or a running back has been given a real receiving role.',
    needs: 'The same routes-run feed as above.'
  }),
  Object.freeze({
    name: 'Red-zone share',
    plain: 'The share of his team\'s plays inside the opponent\'s 20-yard line that went to him.',
    why: 'Touchdowns come from a small number of plays, and this is the only opportunity measure that counts the plays that score.',
    needs: 'Play-by-play filtered by field position per player. nfl_play_by_play holds the plays, but nothing aggregates them per player per week, so this is buildable here — it is missing rather than impossible.'
  })
]);

/** The concept behind a `table.column`, with its id, or null. */
export function conceptFor(field) {
  const id = Object.hasOwn(STAT_FIELDS, field) ? STAT_FIELDS[field] : null;
  return id ? { id, ...STAT_CONCEPTS[id] } : null;
}

/** Everything a screen needs to label one number. Null when the field is not a stat. */
export function describeField(field) {
  const found = conceptFor(field);
  return found ? { field, ...found } : null;
}

/** The whole lexicon, ready to hand to a client. */
export function statLexicon() {
  return {
    concepts: Object.fromEntries(Object.entries(STAT_CONCEPTS).map(([id, c]) => [id, { ...c }])),
    fields: { ...STAT_FIELDS },
    not_stored: NOT_STORED.map(s => ({ ...s }))
  };
}
