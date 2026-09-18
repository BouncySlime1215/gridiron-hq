/**
 * Matchup intelligence: how hard a defense is on a position, how a specific player
 * has actually fared against a specific opponent, and what a team's remaining
 * schedule is worth.
 *
 * Everything here is derived from `player_gamelog` (real weekly boxscores) and
 * `schedule_games` (the 2026 slate). No projections, no AI.
 *
 * WHAT IT KNOWS (tested 2026-09-17, see MATCHUP_EVIDENCE below): the schedule —
 * who a team plays, home or away, and its bye — is fact and is served as fact.
 * WHETHER a matchup makes a player score more is NOT something this module knows:
 * neither home/away nor defense-vs-position made the live weekly projection more
 * accurate out of sample, so every multiplier it emits is exactly 1 and every
 * schedule-strength field (sos, playoff_sos) reports `signal: false`. The DvP and
 * player-vs-opponent numbers are kept as DESCRIPTIVE history for display only.
 */
import { rows } from '../db/index.js';
import { shrink } from './stats-util.js';
import { canonicalTeamCode } from './team-codes.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
// Fantasy playoffs in nearly every ESPN/Sleeper league — the DEFAULT only. Leagues
// that say otherwise are priced on their own weeks via trade-horizon.js#leagueSchedule.
export const PLAYOFF_WEEKS = [15, 16, 17];

/*
 * STATE OF THIS MODULE, graded 2026-09-17 on the weekly harness. Read before using any number.
 *
 * THE TEST (pre-registered before 2025 was opened): the live weekly blend
 * (weekly-backtest.js#replaySeasonWeekly, weights fit-1, weeks 5-18) multiplied by each
 * candidate matchup multiplier, exactly as trade-engine applies thisGame.mult to
 * current_week_ppg. Fitted on 2023+2024, validated on 2025 once. Ship rule: MAE improves with
 * the player-clustered 90% CI entirely below zero, Spearman no worse than -0.002, and
 * DNP-included MAE no worse. Data: player_week_usage (weekly lines with opponent, 2021-2025,
 * used strictly prior to each graded week) and game_lines (home / neutral site).
 *
 *   2025, MAE change vs no adjustment (4.333)        mean     90% CI
 *   home/away as live, 1.02 / 0.98                  +0.0004  [-0.0037, +0.0045]
 *   home/away fitted, 1 +/- 0.0425                  +0.0036  [-0.0050, +0.0121]
 *   home/away fitted per position                   +0.0043  [-0.0045, +0.0129]
 *   DvP, strictly prior, fitted K 200, recency 0.5  +0.0007  [-0.0021, +0.0035]
 *
 * None passed; all four point estimates are slightly WORSE than no adjustment. Home field is
 * the closest thing to a signal: the unfitted 1.02/0.98 helped in 2023 (-0.0079, significant)
 * and 2024 (-0.0043, not significant) and did nothing in 2025 — a fading effect worth ~0.1%
 * of MAE at its best, which close start/sit calls cannot feel (their accuracy moved 0.02
 * percentage points). DvP was not significant even in-sample at its best K (-0.0009, CI
 * [-0.0032, +0.0014]), and at the old K_DVP = 12 it made in-sample predictions worse
 * (+0.0072), matching the audit (first-half -> second-half r = +0.027). A DvP read built
 * early in the season correlates r ~ 0.01 with the weeks 15-17 outcome, so a "playoff
 * schedule" built from it is noise too.
 *
 * WHAT THE MODULE THEREFORE DOES
 *  - Every multiplier is 1: dvpFor().mult, gameMultiplier(), scheduleOutlook().games[].mult,
 *    sos and playoff_sos, each with `signal: false` and a `reason`.
 *  - The two switches below are the only way to turn a multiplier back on. They are code
 *    constants, not env vars, so loading player_gamelog (0 rows today) or any other data
 *    change cannot silently start bending projections. Flip one only after the test above
 *    is re-run and passes on a season it was not fitted on.
 *  - DvP and player-vs-opponent splits remain as DESCRIPTIVE history (dvpTable,
 *    dvpFor().descriptive, relevantSplits) for display, labelled as such.
 *  - The schedule itself is fact and is served as fact: opponents are canonicalised (ESPN
 *    writes WSH) and Washington's home flags repaired, see repairSchedule().
 */
export const DVP_MULTIPLIER_ENABLED = false;
export const HOME_FIELD_MULTIPLIER_ENABLED = false;
// Used only if HOME_FIELD_MULTIPLIER_ENABLED is set: the historical literal, which is also the
// arm that came closest to passing. The 2023+2024 fit (0.0425) did worse on 2025.
const HOME_FIELD_EDGE = 0.02;

export const MATCHUP_SIGNAL_REASON = 'Not a validated signal: on the weekly walk-forward test ' +
  '(fit 2023-24, validated on 2025) neither home/away nor defense-vs-position made projections ' +
  'more accurate than no adjustment, so matchup multipliers are held at 1.';

export const MATCHUP_EVIDENCE = Object.freeze({
  tested: '2026-09-17',
  method: 'weekly-backtest replaySeasonWeekly, live blend fit-1, weeks 5-18; fit 2023+2024, ' +
    'validate 2025 once; pairedBootstrapDiff clustered by player, 90% CI',
  baseline_2025: { mae: 4.333, spearman: 0.6789, dnp_mae: 4.730, crps: 3.107 },
  mae_change_2025: {
    home_live_0_02: { mean: 0.0004, ci90: [-0.0037, 0.0045] },
    home_fitted_0_0425: { mean: 0.0036, ci90: [-0.0050, 0.0121] },
    home_fitted_by_position: { mean: 0.0043, ci90: [-0.0045, 0.0129] },
    dvp_k200_recency_0_5: { mean: 0.0007, ci90: [-0.0021, 0.0035] }
  },
  verdict: 'no candidate beat no-adjustment; all multipliers held at 1'
});

// Descriptive weighting (nothing projects off it while the switches are off): each season back
// counts RECENCY times the one after it, the in-sample best of the DvP fit, so the current
// season counts most. This used to be keyed SEASON-1..3 with a `?? 0.2` catch-all, so the
// CURRENT season weighed 0.2 — less than a game from three years ago.
const RECENCY = 0.5;
const SEASON_WEIGHT = s => (s > SEASON ? 0 : RECENCY ** (SEASON - s));
// Below this many observed games a split is a coin flip, not a trend.
const MIN_SPLIT_GAMES = 2;

// Shrinkage strengths, in units of effective games. K_DVP = 200 is the fitted value (2023+2024,
// grid 12..1600, at the recency above); the old literal 12 overstated every defense's effect
// roughly tenfold. K_SPLIT is unfitted; splits are display-only (see relevantSplits).
const K_DVP = 200;
const K_SPLIT = 8;

let _cache = null;
export function clearMatchupCache() { _cache = null; }

/**
 * Every weekly line we have, tagged with position and season weight.
 *
 * Joined against nfl_teams so Pro Bowl lines (opponent 'AFC'/'NFC') drop out — they
 * are two-game samples with no defense played and they top every softest-matchup list.
 */
function gamelog() {
  return rows(`SELECT g.player_id, g.season, g.week, g.opponent, g.fantasy_points AS pts,
                      p.position, p.name
               FROM player_gamelog g
               JOIN players p ON p.id = g.player_id
               JOIN nfl_teams o ON o.abbr = g.opponent
               WHERE g.fantasy_points IS NOT NULL
                 AND p.position IN ('QB','RB','WR','TE')`);
}

/**
 * Defense vs Position, adjusted for the quality of players faced.
 *
 * Raw points allowed conflates two things: how good the defense is, and how good the
 * offenses on its schedule happened to be. A unit that drew four bad receiving corps
 * looks elite for reasons that have nothing to do with the defense.
 *
 * The fix is to measure every game *relative to the player's own baseline* rather than
 * to a league average. A defense earns credit for holding a 20-ppg receiver to 12, and
 * gets none for holding a 6-ppg receiver to 5. Because each observation is normalised by
 * the specific player in it, opponent quality is controlled for at the player level,
 * which is finer-grained than any team-level offense adjustment could manage.
 *
 * The baseline is computed leave-one-out so a defense is never partly graded against a
 * number it helped produce.
 *
 * Raw points allowed is still carried through, because it is what a human reads.
 */
function computeDvp(log) {
  const FLOOR = { QB: 6, RB: 4, WR: 4, TE: 3 };
  // Only games where the player was a real fantasy contributor. Including every WR5 who
  // played six snaps drags every defense toward the same number.
  const useful = log.filter(g => g.pts >= (FLOOR[g.position] ?? 4));

  // Weighted per-player totals, for leave-one-out baselines.
  const player = new Map();   // player_id -> { w, wpts, n }
  for (const g of useful) {
    const w = SEASON_WEIGHT(g.season);
    const p = player.get(g.player_id) ?? { w: 0, wpts: 0, n: 0 };
    p.w += w; p.wpts += w * g.pts; p.n++;
    player.set(g.player_id, p);
  }

  const bucket = new Map();   // `${opp}|${pos}` -> { w, wpts, wratio, games }
  const posTotal = new Map(); // pos -> { w, wpts }

  for (const g of useful) {
    const w = SEASON_WEIGHT(g.season);
    const p = player.get(g.player_id);
    // Leave-one-out: this game removed from the player's own baseline.
    const remW = p.w - w, remPts = p.wpts - w * g.pts;
    const baseline = remW > 0 ? remPts / remW : null;
    // A player with a single logged game contributes to raw allowed but not to the ratio.
    const ratio = baseline && baseline > 0 ? g.pts / baseline : null;

    const k = `${g.opponent}|${g.position}`;
    const b = bucket.get(k) ?? { w: 0, wpts: 0, ratioW: 0, ratioSum: 0, games: 0 };
    b.w += w; b.wpts += w * g.pts; b.games++;
    if (ratio != null) { b.ratioW += w; b.ratioSum += w * ratio; }
    bucket.set(k, b);

    const t = posTotal.get(g.position) ?? { w: 0, wpts: 0 };
    t.w += w; t.wpts += w * g.pts;
    posTotal.set(g.position, t);
  }

  const leagueAvg = {};
  for (const [pos, t] of posTotal) leagueAvg[pos] = t.w ? t.wpts / t.w : 0;

  const dvp = new Map();
  for (const [k, b] of bucket) {
    const pos = k.split('|')[1];
    const allowed = b.w ? b.wpts / b.w : 0;
    const observed = b.ratioW ? b.ratioSum / b.ratioW : 1;
    dvp.set(k, {
      allowed: +allowed.toFixed(1),
      raw_mult: leagueAvg[pos] ? +(allowed / leagueAvg[pos]).toFixed(3) : 1,
      // Shrunk toward neutral: a defense with six observations does not get to claim
      // a 30% effect. 1.0 is the "no information" prior.
      mult: +shrink(observed, 1, b.ratioW, K_DVP).toFixed(3),
      games: b.games
    });
  }
  // Rank 1 = softest matchup, which is how fantasy sites read. Ranked on the adjusted
  // number. Projections only use it if DVP_MULTIPLIER_ENABLED is switched on (it is not;
  // see the header), so this rank is descriptive history.
  for (const pos of POSITIONS) {
    const list = [...dvp.entries()].filter(([k]) => k.endsWith(`|${pos}`))
      .sort((a, b) => b[1].mult - a[1].mult);
    list.forEach(([, v], i) => { v.rank = i + 1; v.of = list.length; });
  }
  return { dvp, leagueAvg };
}

/**
 * Per-player opponent splits: how he does against a given team relative to his own
 * weighted baseline. This is the "when he plays the Bears he usually goes off" read.
 */
function computeSplits(log) {
  const byPlayer = new Map();
  for (const g of log) {
    const p = byPlayer.get(g.player_id) ?? { w: 0, wpts: 0, all: [], opp: new Map() };
    const w = SEASON_WEIGHT(g.season);
    p.w += w; p.wpts += w * g.pts; p.all.push(g.pts);
    const o = p.opp.get(g.opponent) ?? { games: [], seasons: [] };
    o.games.push(g.pts); o.seasons.push(g.season);
    p.opp.set(g.opponent, o);
    byPlayer.set(g.player_id, p);
  }

  const out = new Map();
  for (const [pid, p] of byPlayer) {
    const baseline = p.w ? p.wpts / p.w : 0;
    const splits = [];
    for (const [opp, o] of p.opp) {
      if (o.games.length < MIN_SPLIT_GAMES) continue;
      const avg = o.games.reduce((a, b) => a + b, 0) / o.games.length;
      // Shrunk toward the player's own baseline. Two games against a team is a
      // coin flip; the raw split reads as a 50% effect and almost never repeats.
      // The reported number is what you should actually expect next time.
      const adjusted = shrink(avg, baseline, o.games.length, K_SPLIT);
      splits.push({
        opponent: opp,
        games: o.games.length,
        raw_avg: +avg.toFixed(1),
        avg: +adjusted.toFixed(1),
        // Relative to his own norm, so a 22-ppg WR isn't flagged as "great vs X" for a 20.
        delta: +(adjusted - baseline).toFixed(1),
        pct: baseline ? +(((adjusted - baseline) / baseline) * 100).toFixed(0) : 0,
        raw_pct: baseline ? +(((avg - baseline) / baseline) * 100).toFixed(0) : 0,
        // How much of the raw signal survived the sample-size discount.
        // A SHRINKAGE WEIGHT, not evidential confidence: n / (n + K_SPLIT), 0.20 at the
        // two-game minimum. Measured on nflverse 2016-2025 (per the audit), the
        // player-vs-opponent effect it weights has split-half reliability r = -0.011
        // and first-two-meetings -> later r = -0.087, i.e. no surviving signal, so a
        // reader should not take 0.20 as "20% of a real effect survived".
        confidence: +(o.games.length / (o.games.length + K_SPLIT)).toFixed(2),
        best: +Math.max(...o.games).toFixed(1),
        worst: +Math.min(...o.games).toFixed(1),
        seasons: [...new Set(o.seasons)].sort()
      });
    }
    splits.sort((a, b) => b.delta - a.delta);
    out.set(pid, { baseline: +baseline.toFixed(1), games: p.all.length, splits });
  }
  return out;
}

/**
 * The schedule as stored, made internally consistent.
 *
 * nfldata.js#syncSchedules finds "this team" in each ESPN event by abbreviation,
 * and ESPN spells Washington WSH while nfl_teams says WAS. So (measured on the
 * 2026 slate, 544 rows): every WAS row has home = 0 — Washington never plays at
 * home — nine WAS rows name WSH, i.e. Washington, as its own opponent, and the 17
 * rows of teams facing Washington say WSH, which matches nothing keyed on WAS.
 * The fix at the source belongs in the sync; this repairs what is read:
 *   1. every opponent is canonicalised (team-codes.js#canonicalTeamCode);
 *   2. a row naming its own team as the opponent takes the opponent from the one
 *      other row that week pointing back at it;
 *   3. when the two rows of one game disagree on who is home, the row of the team
 *      that the feed misspelled (it could not recognise itself) takes the flag
 *      from its opponent's row, which was written by a team that matched itself.
 * Any disagreement it cannot attribute is left alone and counted.
 */
function repairSchedule(raw) {
  const games = raw.map(g => {
    const rawOpp = String(g.opponent_abbr ?? '').trim().toUpperCase();
    const opponent = canonicalTeamCode(rawOpp);
    return { abbr: g.abbr, week: g.week, opponent_abbr: opponent, home: g.home ? 1 : 0,
      aliased: rawOpp !== opponent };
  });
  const misspelled = new Set(games.filter(g => g.aliased).map(g => g.opponent_abbr));
  const at = new Map(games.map(g => [`${g.week}|${g.abbr}`, g]));
  const stats = { opponents_canonicalised: games.filter(g => g.aliased).length,
    self_opponent_repaired: 0, home_flag_repaired: 0, home_flag_unresolved: 0 };
  for (const g of games) {
    if (g.opponent_abbr !== g.abbr) continue;
    const back = games.filter(x => x.week === g.week && x.abbr !== g.abbr && x.opponent_abbr === g.abbr);
    if (back.length === 1) { g.opponent_abbr = back[0].abbr; stats.self_opponent_repaired++; }
  }
  for (const g of games) {
    const o = at.get(`${g.week}|${g.opponent_abbr}`);
    if (!o || o.opponent_abbr !== g.abbr || g.home + o.home === 1) continue;
    if (misspelled.has(g.abbr) && !misspelled.has(o.abbr)) { g.home = 1 - o.home; stats.home_flag_repaired++; }
    else if (!misspelled.has(o.abbr)) stats.home_flag_unresolved++;
  }
  return { games: games.map(({ aliased, ...g }) => g), stats };
}

/** Built once per process; the underlying tables only change on an explicit sync. */
export function matchupModel() {
  if (_cache) return _cache;
  const log = gamelog();
  const { dvp, leagueAvg } = computeDvp(log);
  const splits = computeSplits(log);

  // Every NFL team's 2026 slate, keyed by abbr.
  const schedule = new Map();
  const { games: slate, stats: scheduleRepairs } = repairSchedule(rows(
    `SELECT t.abbr, g.week, g.opponent_abbr, g.home
     FROM schedule_games g JOIN nfl_teams t ON t.id = g.team_id
     WHERE g.season = ? ORDER BY g.week`, SEASON));
  for (const g of slate) {
    (schedule.get(g.abbr) ?? schedule.set(g.abbr, []).get(g.abbr)).push(g);
  }
  // A missing week is a bye — useful on its own for lineup planning.
  const byeWeek = new Map();
  for (const [abbr, games] of schedule) {
    const weeks = new Set(games.map(g => g.week));
    for (let w = 4; w <= 14; w++) if (!weeks.has(w)) { byeWeek.set(abbr, w); break; }
  }

  _cache = { dvp, leagueAvg, splits, schedule, byeWeek, schedule_repairs: scheduleRepairs,
    seasons: [...new Set(log.map(g => g.season))].sort() };
  return _cache;
}

/**
 * Matchup multiplier for one position against one defense.
 *
 * With DVP_MULTIPLIER_ENABLED off (the tested state) `mult` is 1 and `rank`/`allowed`
 * are null whether or not player_gamelog has data, so no consumer can turn a
 * descriptive table into a projection by accident. `has_data` separates "no data"
 * from "data, but not used"; `descriptive` carries the history for display.
 */
export function dvpFor(opponent, position) {
  const { dvp } = matchupModel();
  const d = dvp.get(`${canonicalTeamCode(opponent)}|${position}`) ?? null;
  const descriptive = d ? { allowed: d.allowed, raw_mult: d.raw_mult, observed_mult: d.mult,
    games: d.games, rank: d.rank, of: d.of } : null;
  if (!DVP_MULTIPLIER_ENABLED) {
    return { mult: 1, signal: false, has_data: !!d, reason: MATCHUP_SIGNAL_REASON,
      allowed: null, games: d?.games ?? 0, rank: null, of: null, descriptive };
  }
  if (!d) return { mult: 1, signal: false, has_data: false, reason: 'no defense-vs-position data',
    allowed: null, games: 0, rank: null, of: null, descriptive: null };
  return { ...d, signal: true, has_data: true, reason: null, descriptive };
}

/** Home-field factor for one game; exactly 1 while HOME_FIELD_MULTIPLIER_ENABLED is off. */
export function homeFieldFactor(home) {
  if (!HOME_FIELD_MULTIPLIER_ENABLED) return 1;
  return home ? 1 + HOME_FIELD_EDGE : 1 - HOME_FIELD_EDGE;
}

/**
 * The one matchup multiplier a projection may use for a game: DvP x home field.
 * Exactly 1 in the tested state. ceiling-lineup.js and season-sim.js hard-code
 * `dvpFor(...).mult * (home ? 1.02 : 0.98)` themselves and should call this instead.
 */
export function gameMultiplier(opponent, home, position) {
  return dvpFor(opponent, position).mult * homeFieldFactor(home);
}

/** True when any matchup multiplier is switched on (i.e. schedule strength means something). */
export function matchupSignalActive() {
  return DVP_MULTIPLIER_ENABLED || HOME_FIELD_MULTIPLIER_ENABLED;
}

/**
 * Schedule outlook for a player: his team's remaining slate, game by game, plus the
 * fantasy-playoff stretch called out separately.
 *
 * THE SCHEDULE IS FACT, ITS "STRENGTH" IS NOT KNOWN. `games`, `playoff_games` and
 * `bye` are the real slate (opponent, home/away, week) and are safe to show and to
 * use for bye detection — trade-engine reads a missing `games` entry for the target
 * week as a bye. With no matchup multiplier switched on (the tested state, see the
 * header) every games[].mult is 1, `sos` and `playoff_sos` are exactly 1, `signal`
 * is false with a `reason`, and best/worst are EMPTY: ranking games by a constant
 * would just list the first three weeks. Before this change playoff_sos took three
 * values, {0.98, 0.993, 1.007}, which were a count of home games in weeks 15-17
 * dressed as schedule strength.
 *
 * `signal: false` means "no measured effect", not "average schedule": a consumer
 * must not rank, tag or explain anything on sos/playoff_sos while it is false.
 *
 * @param playoffWeeks the league's own playoff weeks (trade-horizon.js#leagueSchedule).
 *   Defaults to PLAYOFF_WEEKS = [15, 16, 17], which is right for a 14-week regular
 *   season with one-week playoff rounds and wrong for leagues 1 and 3 as synced.
 *
 * POLARITY (only meaningful when signal is true): playoff_sos here is a points
 * MULTIPLIER, higher = EASIER. edge.js#scheduleEdge emits an unrelated
 * opponent-strength field with the same name and the opposite polarity.
 *
 * @returns {{ sos: number, playoff_sos: number, signal: boolean, reason: string|null,
 *             bye: number|null, best: object[], worst: object[],
 *             playoff_games: object[], games: object[] }}
 */
export function scheduleOutlook(teamAbbr, position, fromWeek = 1, playoffWeeks = PLAYOFF_WEEKS) {
  const { schedule, byeWeek } = matchupModel();
  const active = matchupSignalActive();
  const noSignal = { signal: false, reason: active ? 'no remaining games' : MATCHUP_SIGNAL_REASON };
  const games = (schedule.get(canonicalTeamCode(teamAbbr)) ?? []).filter(g => g.week >= fromWeek);
  if (!games.length) {
    return { sos: 1, playoff_sos: 1, ...noSignal, bye: byeWeek.get(canonicalTeamCode(teamAbbr)) ?? null,
      best: [], worst: [], playoff_games: [], games: [] };
  }

  const scored = games.map(g => {
    const d = dvpFor(g.opponent_abbr, position);
    return {
      week: g.week,
      opponent: g.opponent_abbr,
      home: !!g.home,
      // 1 unless a switch is on; see gameMultiplier() and the header for why.
      mult: +(d.mult * homeFieldFactor(g.home)).toFixed(3),
      matchup_signal: active,
      allowed: d.allowed,
      rank: d.rank,
      sample: d.games
    };
  });
  const playoff = scored.filter(g => playoffWeeks.includes(g.week));
  const base = { bye: byeWeek.get(canonicalTeamCode(teamAbbr)) ?? null, playoff_games: playoff, games: scored };
  if (!active) return { sos: 1, playoff_sos: 1, ...noSignal, best: [], worst: [], ...base };

  const mean = list => (list.length ? list.reduce((s, g) => s + g.mult, 0) / list.length : 1);
  const ranked = [...scored].sort((a, b) => b.mult - a.mult);
  return {
    sos: +mean(scored).toFixed(3),
    // An empty playoff slate (the season is past it) is "no games", not "neutral".
    playoff_sos: +mean(playoff).toFixed(3),
    signal: true,
    reason: playoff.length ? null : 'no remaining playoff-week games',
    best: ranked.slice(0, 3),
    worst: ranked.slice(-3).reverse(),
    ...base
  };
}

const SPLITS_REASON = 'Descriptive history only: a player\'s record against a specific opponent ' +
  'has no measured predictive value (split-half r = -0.011).';

/**
 * The headline opponent trends for a player, filtered to opponents he actually
 * plays this year — a split against a team he won't see is trivia.
 *
 * HISTORY, NOT A FORECAST. Per the audit (nflverse 2016-2025) the player-vs-opponent
 * effect has split-half reliability r = -0.011 and first-two-meetings -> later
 * r = -0.087: how he did against a team does not predict how he will do against it.
 * `signal: false` travels with the result so a caller cannot present "+12% vs DAL"
 * as an expectation.
 */
export function relevantSplits(playerId, teamAbbr, limit = 3) {
  const { splits, schedule } = matchupModel();
  const s = splits.get(playerId);
  if (!s) return { baseline: null, upcoming: [], notable: [], signal: false, reason: SPLITS_REASON };
  const upcomingOpps = new Set((schedule.get(canonicalTeamCode(teamAbbr)) ?? []).map(g => g.opponent_abbr));
  const upcoming = s.splits.filter(x => upcomingOpps.has(x.opponent));

  // No hard cutoff on effect size. Shrinkage already discounts thin samples, so a
  // surviving 8% edge is worth more than a raw 50% one was — filtering on the shrunk
  // number the way we filtered the raw one would hide everything. The UI shows the
  // confidence alongside, which is the honest way to present it.
  return {
    baseline: s.baseline,
    games: s.games,
    upcoming: [...upcoming.slice(0, limit), ...upcoming.slice(-limit)]
      .filter((v, i, a) => a.findIndex(x => x.opponent === v.opponent) === i)
      .filter(x => Math.abs(x.pct) >= 4)
      .sort((a, b) => b.delta - a.delta),
    notable: s.splits.filter(x => Math.abs(x.pct) >= 8).slice(0, 6),
    signal: false,
    reason: SPLITS_REASON
  };
}

/**
 * Ranked DvP table for the UI — points allowed per position, softest first.
 *
 * DISPLAY ONLY. `mult` here is the descriptive, shrunk points-allowed ratio (K_DVP = 200),
 * kept under its old name so the Matchups tab keeps rendering; `applied_mult` is what any
 * projection actually uses (1 while DVP_MULTIPLIER_ENABLED is off). Empty while
 * player_gamelog has no rows.
 */
export function dvpTable(position) {
  const { dvp } = matchupModel();
  return [...dvp.entries()]
    .filter(([k]) => k.endsWith(`|${position}`))
    .map(([k, v]) => ({ opponent: k.split('|')[0], ...v, display_only: !DVP_MULTIPLIER_ENABLED,
      applied_mult: DVP_MULTIPLIER_ENABLED ? v.mult : 1 }))
    .sort((a, b) => a.rank - b.rank);
}
