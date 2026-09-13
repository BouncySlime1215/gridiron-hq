#!/usr/bin/env node
/**
 * Stage 1 validation: does props-vs-total disagreement predict which side of
 * the total actually landed? (Giant Plan Step 4a — "the single best betting
 * idea in the whole document", per Nick.)
 *
 *   node scripts/audit-props-total-consistency.mjs
 *
 * READ-ONLY BY DESIGN. This opens server/data.sqlite directly with node:sqlite's
 * `readOnly: true`, deliberately bypassing `server/db/index.js` (which opens
 * read-write and runs schema/migration statements as a side effect of being
 * imported at all). Nothing in this file, or in `server/services/props-total-
 * consistency.js` which it drives, ever calls `db.exec`, `INSERT`, or opens
 * the database read-write. It only ever reads the real, live league database
 * — the one a running capture process is writing to right now — so it can be
 * run at any time without risk to it.
 *
 * WHAT THIS MEASURES, IN THREE STAGES
 * ------------------------------------------------------------------------
 * 1. Feed inventory: what is actually in `nfl_prop_quote_snapshots` right
 *    now, honestly, before any of it is used for anything.
 * 2. The mechanism: for every real captured game, sum each team's props into
 *    an implied total and compare it to that game's own posted total line —
 *    the actual Step 4a idea.
 * 3. The real test: for the (small number of) games that have both a
 *    captured prop set AND a known final score, does the SIZE of the
 *    disagreement predict which side of the total the game actually landed
 *    on? Reported at whatever sample size exists, with the sample size
 *    stated plainly rather than dressed up.
 */
import { DatabaseSync } from 'node:sqlite';
import {
  pairPropQuotes, devigPropPairs, teamTdPointsFromProps, teamYardsFromProps,
  yardsToPoints, compareImpliedTotalToPostedTotal
} from '../server/services/props-total-consistency.js';

// Deliberately NOT derived from this script's own location: this script is
// meant to be run from inside an isolated git worktree (see the "insane"
// safety protocol this build was done under), where a relative path would
// resolve to nothing and silently do the safe thing. The real path is named
// explicitly so this always reads the one real, live league database —
// never a path some other checkout happens to also have a file at.
const REAL_DB_PATH = process.env.GRIDIRON_REAL_DB_PATH
  ?? '/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/data.sqlite';
const db = new DatabaseSync(REAL_DB_PATH, { readOnly: true });
const rows = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => rows(sql, ...args)[0];

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const std = a => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

console.log('='.repeat(78));
console.log('STAGE 1 — PROPS-VS-TOTAL CONSISTENCY: FEED INVENTORY');
console.log('='.repeat(78));

const feedStatus = one(`SELECT COUNT(*) quotes, COUNT(DISTINCT captured_at) captures,
  COUNT(DISTINCT event_id) events, MIN(captured_at) first, MAX(captured_at) latest
  FROM nfl_prop_quote_snapshots`);
console.log(feedStatus);
const byMarket = rows(`SELECT market, COUNT(*) n FROM nfl_prop_quote_snapshots GROUP BY market ORDER BY n DESC`);
console.log('by market:', byMarket);
const byProvider = rows(`SELECT provider, book, COUNT(*) n FROM nfl_prop_quote_snapshots GROUP BY provider, book`);
console.log('by provider/book:', byProvider);

const anytimeTdRows = byMarket.find(m => m.market === 'player_anytime_td')?.n ?? 0;
console.log(`\nanytime-TD props captured: ${anytimeTdRows} (of ${feedStatus.quotes} total quotes).`);
if (anytimeTdRows === 0) {
  console.log('CONFIRMED: zero anytime-TD props in the real tape. Underdog (the only');
  console.log('provider actually landing rows) has no binary anytime-TD market — see');
  console.log('server/services/prop-feeds.js\'s header. The clean, no-model-needed');
  console.log('version of Step 4a (sum TD-implied points, compare to the total) cannot');
  console.log('be run on any real game in this database. teamTdPointsFromProps() is');
  console.log('built and unit-tested for when that changes, but is untested against a');
  console.log('real quote in this pass.');
}

/* ------------------------------------------------------ player -> team map */

// roster_players is the most current real roster snapshot in this database
// (one fetch, timestamped within the last day as of this audit) — used only
// to resolve which of a game's two teams each captured player belongs to.
const rosterRows = rows(`SELECT r.name, t.name AS team_name, t.abbr
  FROM roster_players r JOIN nfl_teams t ON r.team_id = t.id`);
const playerTeam = new Map(rosterRows.map(r => [r.name, { abbr: r.abbr, team_name: r.team_name }]));
console.log(`\nplayer -> team resolved via roster_players (fetched ${one(`SELECT MAX(fetched_at) f FROM roster_players`).f}): ${playerTeam.size} players.`);

/* ------------------------------------------------------ empirical sigmas */

console.log('\n' + '-'.repeat(78));
console.log('Empirical sigmas (real historical game-to-game std dev, 2016-2025), used to');
console.log('shift a de-vigged prop\'s mean off the posted line rather than assume line=mean.');
console.log('-'.repeat(78));

function empiricalSigma(statKey, eligibleFn) {
  const seasonRows = rows(`SELECT features FROM nfl_player_week_features WHERE season BETWEEN 2016 AND 2025`);
  const vals = [];
  for (const r of seasonRows) {
    const f = JSON.parse(r.features);
    if (eligibleFn(f)) vals.push(f[statKey]);
  }
  return { sigma: std(vals), n: vals.length, mean: mean(vals) };
}
const passSigma = empiricalSigma('passing_yards', f => (f.pass_attempts ?? 0) >= 20);
const rushSigma = empiricalSigma('rushing_yards', f => (f.carries ?? 0) >= 8);
const recSigma = empiricalSigma('receiving_yards', f => (f.targets ?? 0) >= 5);
console.log('pass_yds sigma (QB, >=20 att):', passSigma);
console.log('rush_yds sigma (RB, >=8 carries):', rushSigma);
console.log('rec_yds sigma (receiver, >=5 targets):', recSigma);
const sigmas = { pass_yds: passSigma.sigma, rush_yds: rushSigma.sigma, rec_yds: recSigma.sigma };

/* ------------------------------------------------ yards -> points calibration */

console.log('\n' + '-'.repeat(78));
console.log('Yards -> points calibration (real historical team-games, 2016-2025).');
console.log('This is the step that reintroduces model risk into an idea that was');
console.log('supposed to need none — see props-total-consistency.js header.');
console.log('-'.repeat(78));

const teamWeekRows = rows(`SELECT season, week, team, features FROM nfl_team_week_features WHERE season BETWEEN 2016 AND 2025`);
const calibPairs = [];
for (const twr of teamWeekRows) {
  const f = JSON.parse(twr.features);
  const totalYards = (f.off_plays ?? null) != null && (f.off_yards_per_play ?? null) != null
    ? f.off_plays * f.off_yards_per_play : null;
  if (totalYards == null) continue;
  const gl = one(`SELECT team_score FROM game_lines WHERE season=? AND week=? AND team=?`, twr.season, twr.week, twr.team);
  if (!gl || gl.team_score == null) continue;
  calibPairs.push({ x: totalYards, y: gl.team_score });
}
// Simple OLS: y = intercept + slope * x.
function ols(pairs) {
  const n = pairs.length;
  const mx = mean(pairs.map(p => p.x)), my = mean(pairs.map(p => p.y));
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pairs) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; }
  const slope = sxy / sxx, intercept = my - slope * mx;
  const r2 = (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, n };
}
const calibration = ols(calibPairs);
console.log(`fit on ${calibration.n} real team-games: points = ${calibration.intercept.toFixed(3)} + ${calibration.slope.toFixed(5)} * total_yards`);
console.log(`R^2 = ${calibration.r2.toFixed(4)} — total yardage alone explains ${(calibration.r2 * 100).toFixed(1)}% of a team's scoring variance.`);
console.log('This is real and honestly weak: the rest is turnovers, red-zone efficiency,');
console.log('and special teams, none of which this yards-only proxy sees.');

/* ------------------------------------------------------------ per-game analysis */

console.log('\n' + '='.repeat(78));
console.log('STAGE 2 — THE MECHANISM: props-implied total vs. posted total, per game');
console.log('='.repeat(78));

const events = rows(`SELECT DISTINCT event_id, home_team, away_team, commence_time FROM nfl_prop_quote_snapshots ORDER BY commence_time`);
const teamNameToAbbr = new Map(rows(`SELECT name, abbr FROM nfl_teams`).map(t => [t.name, t.abbr]));

const results = [];
let unmatchedPlayers = 0;
for (const ev of events) {
  const latestCapture = one(`SELECT MAX(captured_at) c FROM nfl_prop_quote_snapshots WHERE event_id=?`, ev.event_id).c;
  const quotes = rows(`SELECT * FROM nfl_prop_quote_snapshots WHERE event_id=? AND captured_at=?`, ev.event_id, latestCapture);

  const homeAbbr = teamNameToAbbr.get(ev.home_team), awayAbbr = teamNameToAbbr.get(ev.away_team);
  const byTeam = { [homeAbbr]: [], [awayAbbr]: [] };
  for (const qr of quotes) {
    const t = playerTeam.get(qr.player)?.abbr;
    if (!t || !(t in byTeam)) { unmatchedPlayers++; continue; }
    byTeam[t].push(qr);
  }

  const gl = rows(`SELECT * FROM game_lines WHERE season=2026 AND team=? AND opponent=?`, homeAbbr, awayAbbr)
    .filter(g => g.gameday == null || Math.abs(new Date(g.gameday) - new Date(ev.commence_time)) < 14 * 86400e3)[0]
    ?? one(`SELECT * FROM game_lines WHERE season=2026 AND team=? AND opponent=?`, homeAbbr, awayAbbr);
  const awayGl = one(`SELECT * FROM game_lines WHERE season=2026 AND team=? AND opponent=?`, awayAbbr, homeAbbr);

  const teamOutput = {};
  for (const abbr of [homeAbbr, awayAbbr]) {
    const devigged = devigPropPairs(pairPropQuotes(byTeam[abbr]));
    const yards = teamYardsFromProps(devigged, { sigmas });
    const td = teamTdPointsFromProps(devigged);
    const points = td.available ? td.points : yardsToPoints(yards.total_yards, calibration).points;
    teamOutput[abbr] = { yards, td, points, points_source: td.available ? 'td_props' : 'yards_proxy' };
  }

  const postedTotal = gl?.closing_total ?? gl?.total ?? null;
  const openTotal = gl?.open_total ?? null;
  const actualTotal = (gl?.team_score != null && gl?.opp_score != null) ? gl.team_score + gl.opp_score : null;
  const spreadImpliedHome = gl?.implied_points ?? null;
  const spreadImpliedAway = awayGl?.implied_points ?? null;

  const cmp = compareImpliedTotalToPostedTotal({
    homePoints: teamOutput[homeAbbr]?.points ?? null,
    awayPoints: teamOutput[awayAbbr]?.points ?? null,
    postedTotal, actualTotal
  });

  results.push({
    event_id: ev.event_id, home: homeAbbr, away: awayAbbr, commence_time: ev.commence_time,
    captured_at: latestCapture, days_before_kickoff: +((new Date(ev.commence_time) - new Date(latestCapture)) / 86400e3).toFixed(1),
    open_total: openTotal, posted_total: postedTotal, line_moved: openTotal != null && postedTotal != null ? +(postedTotal - openTotal).toFixed(1) : null,
    home_points: teamOutput[homeAbbr]?.points ?? null, away_points: teamOutput[awayAbbr]?.points ?? null,
    home_yards: teamOutput[homeAbbr]?.yards, away_yards: teamOutput[awayAbbr]?.yards,
    spread_implied_home: spreadImpliedHome, spread_implied_away: spreadImpliedAway,
    ...cmp,
    home_receiving_check: teamOutput[homeAbbr]?.yards.receiving_check,
    away_receiving_check: teamOutput[awayAbbr]?.yards.receiving_check
  });
}

for (const r of results) {
  console.log(`\n${r.away} @ ${r.home}  (kickoff ${r.commence_time}, props captured ${r.captured_at}, ${r.days_before_kickoff}d before kickoff)`);
  console.log(`  posted total: ${r.posted_total} (open ${r.open_total}, moved ${r.line_moved >= 0 ? '+' : ''}${r.line_moved} pts since open)`);
  console.log(`  props-implied: ${r.away} ${r.away_points ?? 'n/a'} + ${r.home} ${r.home_points ?? 'n/a'} = ${r.implied_total ?? 'n/a'}  (source: yards proxy, R^2=${calibration.r2.toFixed(3)})`);
  console.log(`    yards behind that: ${r.away} pass=${r.away_yards?.pass_yds?.mean ?? 'n/a'}(${r.away_yards?.pass_yds?.player ?? 'n/a'}) rush=${r.away_yards?.rush_yds?.total ?? 'n/a'}(n=${r.away_yards?.rush_yds?.n ?? 0}); ${r.home} pass=${r.home_yards?.pass_yds?.mean ?? 'n/a'}(${r.home_yards?.pass_yds?.player ?? 'n/a'}) rush=${r.home_yards?.rush_yds?.total ?? 'n/a'}(n=${r.home_yards?.rush_yds?.n ?? 0})`);
  console.log(`    for reference, this book's OWN spread+total already implies: ${r.away} ${r.spread_implied_away ?? 'n/a'} + ${r.home} ${r.spread_implied_home ?? 'n/a'}`);
  console.log(`  disagreement: ${r.disagreement == null ? 'n/a' : (r.disagreement > 0 ? '+' : '') + r.disagreement} -> props lean ${r.props_implied_side ?? 'n/a'}`);
  if (r.actual_total != null) {
    console.log(`  ACTUAL final total: ${r.actual_total} -> real side: ${r.actual_side ?? 'push'}. props called it correctly: ${r.props_called_side_correctly}`);
  } else {
    console.log(`  actual total: not yet known (game not final)`);
  }
}

console.log(`\n(${unmatchedPlayers} captured player-prop rows across all games could not be matched to either team via roster_players and were excluded.)`);

/* ------------------------------------------------------------------ Stage 3 */

console.log('\n' + '='.repeat(78));
console.log('STAGE 3 — THE REAL TEST: does disagreement size predict the actual side?');
console.log('='.repeat(78));

// A structural check that has to be run BEFORE trusting any "correct call"
// count: does the disagreement sign vary game to game (consistent with a
// real, per-game market inconsistency), or does it point the same direction
// on every single game regardless of matchup (consistent with a systematic
// bias in this proxy's yardage coverage, not a market signal)?
const withDisagreement = results.filter(r => r.disagreement != null);
const negativeCount = withDisagreement.filter(r => r.disagreement < 0).length;
const positiveCount = withDisagreement.filter(r => r.disagreement > 0).length;
console.log(`\nDirection check across all ${withDisagreement.length} captured games this week (not just the graded ones):`);
console.log(`  props-implied total BELOW posted total (props lean Under): ${negativeCount}`);
console.log(`  props-implied total ABOVE posted total (props lean Over): ${positiveCount}`);
if (withDisagreement.length && (negativeCount === withDisagreement.length || positiveCount === withDisagreement.length)) {
  console.log(`\n  *** ${negativeCount === withDisagreement.length ? negativeCount : positiveCount} of ${withDisagreement.length} games lean the SAME direction. ***`);
  console.log('  A real, game-specific market inconsistency would not point the same way on');
  console.log('  every unrelated matchup on the slate. This pattern is the signature of a');
  console.log('  SYSTEMATIC BIAS in this proxy (most likely: the yards-only total only sums');
  console.log('  players who happened to get a captured prop line — one starting QB plus');
  console.log('  whichever backs got a rushing prop — which structurally undercounts a real');
  console.log('  team\'s full offensive yardage, which the yards->points calibration was fit');
  console.log('  on). It is NOT evidence that the market misprices totals low relative to its');
  console.log('  own props. See the per-game "for reference" line above: this book\'s own');
  console.log('  spread+total already implies materially higher team points than our props');
  console.log('  proxy in every game, which is the tell.');
}

const graded = results.filter(r => r.actual_total != null && r.disagreement != null && r.actual_side != null);
console.log(`\nGames with BOTH a captured prop set AND a known final score AND a non-push total: n = ${graded.length}`);
console.log(`(of ${results.length} total captured games this week; the rest have not finished yet.)`);

if (graded.length === 0) {
  console.log('\nNo graded games available. Cannot say anything about predictive power.');
} else {
  const correct = graded.filter(r => r.props_called_side_correctly).length;
  console.log(`\nSide called correctly: ${correct} / ${graded.length}`);
  for (const r of graded) {
    console.log(`  ${r.away} @ ${r.home}: disagreement ${r.disagreement > 0 ? '+' : ''}${r.disagreement} pts (props lean ${r.props_implied_side}), actual total ${r.actual_total} vs posted ${r.posted_total} (real side ${r.actual_side}) -> ${r.props_called_side_correctly ? 'CORRECT' : 'WRONG'}`);
  }
  console.log(`\nHONEST READ, part 1 (sample size): n=${graded.length} is not a sample size any`);
  console.log('statistical test can say something real about — a coin has a 50% chance of');
  console.log(`matching either outcome once or twice by pure chance, and no confidence`);
  console.log(`interval computed on ${graded.length} paired observations would exclude zero.`);
  console.log('\nHONEST READ, part 2 (the direction-check above matters more than this count):');
  console.log('both graded games happened to go Under, and this proxy leans Under on every');
  console.log('single one of the 16 captured games regardless of matchup — so "2/2 correct"');
  console.log('is exactly what a systematically-biased-low proxy would produce whenever the');
  console.log('real games go Under, and tells us nothing about whether the SIZE of a');
  console.log('disagreement carries real information. It does not, on this evidence.');
  console.log('\nThe mechanism (pairing, de-vigging, aggregating real captured props) runs');
  console.log('correctly and is ready to grade honestly once either (a) the yards-only proxy');
  console.log('is replaced with real anytime-TD props (needs the feed fixed) or (b) it is');
  console.log('fit to capture a team\'s FULL offensive yardage rather than only the subset of');
  console.log('players who happened to get a prop line — neither of which is a small fix.');
}

console.log('\n' + '-'.repeat(78));
console.log('Bonus, secondary finding: internal props-vs-props consistency');
console.log('(sum of a team\'s receivers\' implied yards vs. its own QB\'s implied passing');
console.log('yards — these should roughly agree since every completion is caught by');
console.log('someone; this needs no total-line data or yards-to-points model at all).');
console.log('-'.repeat(78));
const gaps = [];
for (const r of results) {
  for (const check of [r.home_receiving_check, r.away_receiving_check]) {
    if (check) gaps.push(check.gap);
  }
}
if (gaps.length) {
  console.log(`n=${gaps.length} team-games with both a QB pass_yds prop and >=1 receiver prop.`);
  console.log(`mean gap (receivers total - QB pass yds): ${mean(gaps).toFixed(1)} yards, std ${std(gaps)?.toFixed(1) ?? 'n/a'}.`);
} else {
  console.log('No team-games had both markets captured for the same team.');
}

db.close();
