/**
 * Matchup intelligence: how hard a defense is on a position, how a specific player
 * has actually fared against a specific opponent, and what a team's remaining
 * schedule is worth.
 *
 * Everything here is derived from `player_gamelog` (real weekly boxscores) and
 * `schedule_games` (the 2026 slate). No projections, no AI — these are the
 * observed numbers that the projection layer gets bent by.
 */
import { rows } from '../db/index.js';
import { shrink } from './stats-util.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
// Fantasy playoffs in nearly every ESPN/Sleeper league.
export const PLAYOFF_WEEKS = [15, 16, 17];
// Older seasons still carry signal (scheme continuity, personnel), just less of it.
const SEASON_WEIGHT = s => ({ [SEASON - 1]: 1, [SEASON - 2]: 0.6, [SEASON - 3]: 0.35 })[s] ?? 0.2;
// Below this many observed games a split is a coin flip, not a trend.
const MIN_SPLIT_GAMES = 2;

// Shrinkage strengths, in units of effective games. A defense accumulates observations
// fast (every skill player it faces is one), so it earns trust sooner than a single
// player's head-to-head history does.
const K_DVP = 12;
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
  // number, since that is the one the projections actually use.
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

/** Built once per process; the underlying tables only change on an explicit sync. */
export function matchupModel() {
  if (_cache) return _cache;
  const log = gamelog();
  const { dvp, leagueAvg } = computeDvp(log);
  const splits = computeSplits(log);

  // Every NFL team's 2026 slate, keyed by abbr.
  const schedule = new Map();
  for (const g of rows(`SELECT t.abbr, g.week, g.opponent_abbr, g.home
                        FROM schedule_games g JOIN nfl_teams t ON t.id = g.team_id
                        WHERE g.season = ? ORDER BY g.week`, SEASON)) {
    (schedule.get(g.abbr) ?? schedule.set(g.abbr, []).get(g.abbr)).push(g);
  }
  // A missing week is a bye — useful on its own for lineup planning.
  const byeWeek = new Map();
  for (const [abbr, games] of schedule) {
    const weeks = new Set(games.map(g => g.week));
    for (let w = 4; w <= 14; w++) if (!weeks.has(w)) { byeWeek.set(abbr, w); break; }
  }

  _cache = { dvp, leagueAvg, splits, schedule, byeWeek, seasons: [...new Set(log.map(g => g.season))].sort() };
  return _cache;
}

/** Matchup multiplier for one position against one defense; 1 when we have no read. */
export function dvpFor(opponent, position) {
  const { dvp } = matchupModel();
  return dvp.get(`${opponent}|${position}`) ?? { mult: 1, allowed: null, games: 0, rank: null };
}

/**
 * Schedule outlook for a player: his team's remaining slate scored through the DvP
 * lens for his position, plus the fantasy-playoff stretch called out separately
 * (weeks 15-17 are the only ones that decide a title).
 *
 * @returns {{ sos: number, playoff_sos: number, bye: number|null,
 *             best: object[], worst: object[], playoff_games: object[] }}
 */
export function scheduleOutlook(teamAbbr, position, fromWeek = 1) {
  const { schedule, byeWeek } = matchupModel();
  const games = (schedule.get(teamAbbr) ?? []).filter(g => g.week >= fromWeek);
  if (!games.length) return { sos: 1, playoff_sos: 1, bye: byeWeek.get(teamAbbr) ?? null, best: [], worst: [], playoff_games: [] };

  const scored = games.map(g => {
    const d = dvpFor(g.opponent_abbr, position);
    return {
      week: g.week,
      opponent: g.opponent_abbr,
      home: !!g.home,
      // Home field is worth a little, and it is the one adjustment every book makes.
      mult: +(d.mult * (g.home ? 1.02 : 0.98)).toFixed(3),
      allowed: d.allowed,
      rank: d.rank,
      sample: d.games
    };
  });
  const mean = list => (list.length ? list.reduce((s, g) => s + g.mult, 0) / list.length : 1);
  const playoff = scored.filter(g => PLAYOFF_WEEKS.includes(g.week));
  const ranked = [...scored].sort((a, b) => b.mult - a.mult);

  return {
    sos: +mean(scored).toFixed(3),
    playoff_sos: +mean(playoff).toFixed(3),
    bye: byeWeek.get(teamAbbr) ?? null,
    best: ranked.slice(0, 3),
    worst: ranked.slice(-3).reverse(),
    playoff_games: playoff,
    games: scored
  };
}

/**
 * The headline opponent trends for a player, filtered to opponents he actually
 * plays this year — a split against a team he won't see is trivia.
 */
export function relevantSplits(playerId, teamAbbr, limit = 3) {
  const { splits, schedule } = matchupModel();
  const s = splits.get(playerId);
  if (!s) return { baseline: null, upcoming: [], notable: [] };
  const upcomingOpps = new Set((schedule.get(teamAbbr) ?? []).map(g => g.opponent_abbr));
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
    notable: s.splits.filter(x => Math.abs(x.pct) >= 8).slice(0, 6)
  };
}

/** Ranked DvP table for the UI — softest and toughest defenses per position. */
export function dvpTable(position) {
  const { dvp } = matchupModel();
  return [...dvp.entries()]
    .filter(([k]) => k.endsWith(`|${position}`))
    .map(([k, v]) => ({ opponent: k.split('|')[0], ...v }))
    .sort((a, b) => a.rank - b.rank);
}
