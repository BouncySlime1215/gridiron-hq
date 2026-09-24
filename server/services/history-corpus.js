/**
 * The crawled league corpus: real completed redraft seasons, read one way.
 *
 * NAMED FOR WHAT IT IS, after two collisions worth recording so nobody re-walks them.
 * This was `league-history.js` until a different module of that name appeared -- one that
 * fetches ESPN league history over HTTP and WRITES it to the app database (PR #47,
 * migration 064). Two modules, one name, opposite directions, zero shared functions: git
 * reported add/add, and picking a side in that conflict would have lost one of them
 * outright. That name was the ESPN side's before either of us arrived, since
 * `scripts/backfill-league-history.mjs` and `test/helpers/seed-league-history.js` already
 * used it.
 *
 * `sleeper-history.js` was the obvious second choice and is ALSO taken, by the pure
 * parsing layer this corpus is built with. Two files called `sleeper-*history*` sitting
 * beside each other would have moved the confusion rather than removed it, so: the crawler
 * is `collect-sleeper-history.mjs`, the parser it uses is `sleeper-history.js`, and this is
 * the read-only reader of the database they produce.
 *
 * WHAT IT IS FOR. Team Outlook has to answer "where do we stand, and how much of that
 * is real" at week 2, when almost nothing has happened. That is a question about
 * signal and noise, and it can only be answered from seasons that already finished.
 * The master plan's first evidence for it came from Nick's own 7 completed
 * league-seasons -- 62 team-seasons, which it correctly labels small and descriptive.
 * This reads the crawled public history instead: 7,696 team-seasons at the time of
 * writing, from 692 real leagues with real managers.
 *
 * ONE READER, ONE CONTRACT (master plan D3). This module is the only code that opens
 * `data/derived/sleeper_history.sqlite`. Everything else asks it questions. The file is
 * a derived artifact built by `scripts/collect-sleeper-history.mjs`; it is not part of
 * the app's schema and is not guaranteed to exist, so every function here degrades to a
 * named absence rather than throwing. A machine without the crawl gets `available:
 * false` and a reason, never a silent zero.
 *
 * POINTS ARE NORMALISED WITHIN LEAGUE-SEASON, ALWAYS. Scoring settings differ enormously
 * across these leagues -- a week is worth 90 points in one and 150 in another -- so a
 * raw score is meaningless pooled. Everything below works in z-units against the
 * league-season's own mean and spread, which is also the only form in which "a good
 * week" is comparable between Nick's leagues and the public population.
 *
 * ANONYMOUS BY CONSTRUCTION. The crawl stores no user or team names, and nothing here
 * reads an identifier beyond the opaque league and roster ids it needs to group rows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.GRIDIRON_LEAGUE_HISTORY_PATH
  ?? path.join(process.cwd(), 'data', 'derived', 'sleeper_history.sqlite');

export const LEAGUE_HISTORY_SOURCE = Object.freeze({
  file: 'data/derived/sleeper_history.sqlite',
  built_by: 'scripts/collect-sleeper-history.mjs',
  upstream: 'Sleeper public API',
  anonymised: true
});

let _db = null;
let _tried = false;

/**
 * The handle, or null. Opened read-only and once: this is a derived file that a
 * background crawl may still be appending to, and a writer handle would be wrong.
 */
function handle() {
  if (_tried) return _db;
  _tried = true;
  try {
    if (!fs.existsSync(DB_PATH)) return (_db = null);
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    // A file that exists but has no tables is a crawl that died before its first
    // commit, which is a different thing from no crawl and reads the same without this.
    const t = db.prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='sh_team_weeks'`).get();
    if (!t?.c) { db.close(); return (_db = null); }
    return (_db = db);
  } catch { return (_db = null); }
}

/** For tests: forget the handle so a fixture path is picked up. */
export function resetLeagueHistory() { _db = null; _tried = false; }

const rows = (sql, ...args) => {
  const db = handle();
  if (!db) return [];
  return db.prepare(sql).all(...args);
};

/** How much history is on file, so a consumer can state what backs a claim. */
export function historyStatus() {
  const db = handle();
  if (!db) {
    return {
      available: false, source: LEAGUE_HISTORY_SOURCE,
      reason: `no league history at ${LEAGUE_HISTORY_SOURCE.file}; build it with ${LEAGUE_HISTORY_SOURCE.built_by}`
    };
  }
  const bySeason = rows(`SELECT l.season,
      COUNT(DISTINCT l.league_id) AS leagues,
      COUNT(DISTINCT l.league_id || ':' || ts.roster_id) AS team_seasons
    FROM sh_leagues l JOIN sh_team_seasons ts ON ts.league_id = l.league_id
    GROUP BY l.season ORDER BY l.season`);
  return {
    available: true, source: LEAGUE_HISTORY_SOURCE, seasons: bySeason,
    leagues: bySeason.reduce((s, r) => s + r.leagues, 0),
    team_seasons: bySeason.reduce((s, r) => s + r.team_seasons, 0)
  };
}

/**
 * Every team-season's regular-season weeks, with the league's shape and its outcome.
 *
 * Regular season only: a week at or past `playoff_week_start` is a bracket game, and
 * pooling those with regular weeks would mix a game against a seeded opponent into a
 * measure of regular-season form -- and would count only playoff teams' later weeks,
 * which selects on the outcome being predicted.
 *
 * ABANDONED LEAGUES ARE NOT LEAGUES, and excluding them is not optional. Sleeper's public
 * API returns a league that nobody played: every team-week zero, fourteen weeks of it, a
 * `champion` flag on whichever roster the bracket happened to advance. Five league-seasons
 * in the crawl are zero for every single team-week, fifty more are zero for over half of
 * theirs. Their outcomes are not football, and left in they biased `k` downward -- pooled
 * with them k was 7.35, without them 8.42, which moves the week-2 weight on a team's own
 * record by two points in the direction of believing an early start more. A dataset defect
 * that makes the model MORE confident is the worst kind to leave in a model whose whole
 * subject is not being too confident too early.
 *
 * Two rules, both of them statements about the data rather than about any outcome:
 *
 * 1. A team-week of exactly zero is a MISSING observation, not an observation of zero. A
 *    fantasy team with a submitted lineup does not score 0.00; a team that scores 0 had no
 *    lineup, or the week was never played. Averaging it in as a real bad week both drags
 *    the league's scoring scale down and inflates that team's within-team variance.
 * 2. A league-season more than half of whose team-weeks are zero was abandoned, and every
 *    row of it goes, including its surviving weeks and its champion.
 *
 * The distribution justifies treating this as a defect and not a tail: of 939 league-seasons
 * 819 have no zero week at all and average 125.5 points, while the 55 caught by rule 2
 * average 12.1. Leagues in between are ones where one manager quit mid-season, which is real
 * football; rule 1 removes that manager's empty weeks and keeps the league.
 *
 * Not filtered, and stated because it was checked rather than assumed: two league-seasons
 * contain a negative team-week. Leagues with negative scoring can genuinely produce one, two
 * of 939 cannot move any estimate, and inventing a third rule for them would be tuning.
 */
const ZERO_WEEK_ABANDON_SHARE = 0.5;

function regularSeasonWeeks(seasons) {
  const filter = seasons?.length
    ? `AND l.season IN (${seasons.map(() => '?').join(',')})` : '';
  const all = rows(`SELECT l.season, l.league_id, l.num_teams, l.playoff_teams,
      tw.roster_id, tw.week, tw.points, tw.opponent_roster_id,
      ts.made_playoffs, ts.champion, ts.wins, ts.points_for
    FROM sh_team_weeks tw
    JOIN sh_leagues l ON l.league_id = tw.league_id
    JOIN sh_team_seasons ts ON ts.league_id = tw.league_id AND ts.roster_id = tw.roster_id
    WHERE l.playoff_week_start IS NOT NULL
      AND tw.week < l.playoff_week_start
      AND tw.points IS NOT NULL ${filter}
    ORDER BY l.league_id, tw.roster_id, tw.week`, ...(seasons ?? []));

  // Rule 2 is judged on the league's WHOLE regular season, before rule 1 drops anything,
  // so the share is of what the league was supposed to have played.
  const tally = new Map();
  for (const r of all) {
    const t = tally.get(r.league_id) ?? { n: 0, zeros: 0 };
    t.n++; if (r.points === 0) t.zeros++;
    tally.set(r.league_id, t);
  }
  const abandoned = new Set();
  for (const [id, t] of tally) if (t.zeros / t.n > ZERO_WEEK_ABANDON_SHARE) abandoned.add(id);

  return all.filter(r => r.points !== 0 && !abandoned.has(r.league_id));
}

/**
 * What the two data-quality rules above removed, so a reader can see the size of it rather
 * than trust that it was small.
 */
export function excludedByDataQuality(seasons = null) {
  const filter = seasons?.length
    ? `AND l.season IN (${seasons.map(() => '?').join(',')})` : '';
  const all = rows(`SELECT l.league_id, tw.points
    FROM sh_team_weeks tw
    JOIN sh_leagues l ON l.league_id = tw.league_id
    WHERE l.playoff_week_start IS NOT NULL
      AND tw.week < l.playoff_week_start
      AND tw.points IS NOT NULL ${filter}`, ...(seasons ?? []));
  const tally = new Map();
  for (const r of all) {
    const t = tally.get(r.league_id) ?? { n: 0, zeros: 0 };
    t.n++; if (r.points === 0) t.zeros++;
    tally.set(r.league_id, t);
  }
  let abandonedLeagues = 0, abandonedRows = 0, zeroRows = 0;
  for (const t of tally.values()) {
    if (t.zeros / t.n > ZERO_WEEK_ABANDON_SHARE) { abandonedLeagues++; abandonedRows += t.n; }
    else zeroRows += t.zeros;
  }
  return {
    rule: {
      zero_week_is_missing: 'a team-week of exactly 0 is treated as no observation',
      abandoned_league_share: ZERO_WEEK_ABANDON_SHARE
    },
    leagues_total: tally.size,
    abandoned_leagues: abandonedLeagues,
    abandoned_team_weeks: abandonedRows,
    zero_team_weeks_in_kept_leagues: zeroRows,
    team_weeks_total: all.length,
    team_weeks_kept: all.length - abandonedRows - zeroRows
  };
}

/**
 * The panel Team Outlook reads: one row per (team-season, week), carrying what was
 * KNOWN at the end of that week and what eventually happened.
 *
 * `all_play_wins` is how many of the league's other teams the team outscored that week.
 * It is the luck-free version of a record: a team can go 1-4 while outscoring most of
 * the league every week, and the difference between the two is the whole "is this real"
 * question. Ties count a half, as they do in a record.
 *
 * `points_z` is the team's score that week in league-season z-units.
 *
 * `win_pct` is the actual head-to-head record, recomputed week by week from the scheduled
 * opponent's score. It is deliberately not taken from `sh_team_seasons.wins`, which is the
 * season total: a row at week 3 carrying it would be reading the outcome it predicts.
 *
 * `games_back` is the distance in wins to the team sitting on the playoff line, as the
 * standings stood at the end of week w. `win_pct` cannot express this on its own -- 2-1 is
 * comfortable where six of twelve qualify and outside the line where four of eight do.
 *
 * Cumulative fields are the mean over weeks 1..w, so a row at week 3 knows nothing about
 * week 4. Nothing here reads a later week, which is what makes the panel usable as a
 * prediction input rather than a description.
 */
/*
 * `rows` is how a league that is NOT in the corpus gets the same features.
 *
 * The corpus lives in `data/derived/sleeper_history.sqlite`, which the Fly image does not
 * contain (the Dockerfile's runtime stage copies `client/dist`, `server` and `scripts`
 * only), and one of Nick's own ESPN leagues is not in it at all. Both cases need a panel
 * row computed the same way, and the one thing that must not happen is a second
 * implementation of all-play, the shrunk z-score and `games_back` for app leagues: the
 * features would drift from the ones the model was fitted on, and nothing would say so.
 *
 * So a caller may supply rows in `regularSeasonWeeks`'s own shape --
 * `{season, league_id, num_teams, playoff_teams, roster_id, week, points,
 * opponent_roster_id, made_playoffs, champion}` -- and every derivation below runs on them
 * unchanged. `team-outlook.js`'s `espnWeeklyRows` is the one producer.
 *
 * Supplied rows skip the two data-quality rules, deliberately: those exist to drop
 * abandoned and off-scale leagues from a public crawl, and a league Nick is playing in is
 * not a candidate for exclusion. It is his league whatever its scale.
 */
export function weeklyPanel({ seasons = null, rows: suppliedRows = null } = {}) {
  const raw = suppliedRows ?? regularSeasonWeeks(seasons);
  if (!raw.length) return [];

  // League-season scoring scale, from the regular-season weeks themselves.
  const scale = new Map();
  for (const r of raw) {
    const s = scale.get(r.league_id) ?? { n: 0, sum: 0, sumsq: 0 };
    s.n++; s.sum += r.points; s.sumsq += r.points * r.points;
    scale.set(r.league_id, s);
  }
  for (const s of scale.values()) {
    s.mean = s.sum / s.n;
    // Population sd over every team-week in the league-season. A league with one week
    // on file has no spread; those rows get z = 0 rather than a divide by zero.
    s.sd = Math.sqrt(Math.max(0, s.sumsq / s.n - s.mean * s.mean));
  }

  // All-play needs every team's score in the same (league, week).
  const byLeagueWeek = new Map();
  for (const r of raw) {
    const key = `${r.league_id}|${r.week}`;
    (byLeagueWeek.get(key) ?? byLeagueWeek.set(key, []).get(key)).push(r);
  }
  const allPlay = new Map();
  for (const [key, list] of byLeagueWeek) {
    for (const r of list) {
      let wins = 0;
      for (const o of list) {
        if (o.roster_id === r.roster_id) continue;
        if (r.points > o.points) wins += 1;
        else if (r.points === o.points) wins += 0.5;
      }
      allPlay.set(`${key}|${r.roster_id}`, { wins, games: list.length - 1 });
    }
  }

  // The head-to-head result of each week, from the scheduled opponent's score in the
  // same week. `sh_team_seasons.wins` is the SEASON total and so is unusable here: a
  // row at week 3 that carried it would be reading the outcome it is meant to predict.
  const pointsOf = new Map();
  for (const r of raw) pointsOf.set(`${r.league_id}|${r.week}|${r.roster_id}`, r.points);

  const out = [];
  const byTeam = new Map();
  for (const r of raw) {
    const key = `${r.league_id}|${r.roster_id}`;
    (byTeam.get(key) ?? byTeam.set(key, []).get(key)).push(r);
  }
  for (const [, weeks] of byTeam) {
    weeks.sort((a, b) => a.week - b.week);
    const totalWeeks = weeks.length;
    let sumZ = 0, apWins = 0, apGames = 0, wins = 0, headToHead = 0, sumPoints = 0;
    for (let i = 0; i < weeks.length; i++) {
      const r = weeks[i];
      const s = scale.get(r.league_id);
      const z = s.sd > 0 ? (r.points - s.mean) / s.sd : 0;
      const ap = allPlay.get(`${r.league_id}|${r.week}|${r.roster_id}`) ?? { wins: 0, games: 0 };
      sumZ += z; apWins += ap.wins; apGames += ap.games; sumPoints += r.points;

      // A week with no opponent on file (a bye in an odd-sized league, or a gap in the
      // crawl) is not a loss and not a win: it does not count as a game played. Scoring
      // it as a loss would penalise the team for a missing row.
      const oppPoints = r.opponent_roster_id == null
        ? null : pointsOf.get(`${r.league_id}|${r.week}|${r.opponent_roster_id}`) ?? null;
      if (oppPoints != null) {
        headToHead += 1;
        if (r.points > oppPoints) wins += 1;
        else if (r.points === oppPoints) wins += 0.5;
      }

      out.push({
        season: r.season, league_id: r.league_id, roster_id: r.roster_id,
        num_teams: r.num_teams, playoff_teams: r.playoff_teams,
        week: r.week, games: i + 1, weeks_left: totalWeeks - (i + 1),
        points_z: +z.toFixed(4),
        // Known at week w.
        mean_points_z: +(sumZ / (i + 1)).toFixed(4),
        all_play_pct: apGames ? +(apWins / apGames).toFixed(4) : null,
        win_pct: headToHead ? +(wins / headToHead).toFixed(4) : null,
        wins_so_far: wins,
        head_to_head_games: headToHead,
        points_so_far: +sumPoints.toFixed(2),
        // Filled below, once every team in the league-week is known.
        games_back: null,
        // The outcome. Never an input.
        made_playoffs: r.made_playoffs ? 1 : 0,
        champion: r.champion ? 1 : 0,
        // Carried through because this object is built field by field rather than spread,
        // so anything the supplied row said about itself is otherwise dropped here. A live
        // league's rows arrive with `false` and `fitOutlook` refuses them; corpus rows come
        // from completed seasons in `sh_team_seasons`, so `true` is a statement about them
        // and not a default standing in for a missing answer.
        outcome_known: r.outcome_known ?? true
      });
    }
  }

  // Distance to the playoff line, in wins, as the standings stood at the end of week w.
  // `win_pct` alone cannot express it: 2-1 is comfortable in a league that takes six of
  // twelve and is outside the line in one that takes four of eight.
  const outByLeagueWeek = new Map();
  for (const row of out) {
    const key = `${row.league_id}|${row.week}`;
    (outByLeagueWeek.get(key) ?? outByLeagueWeek.set(key, []).get(key)).push(row);
  }
  for (const list of outByLeagueWeek.values()) {
    // Standings order: wins, then points as the near-universal tiebreak. Points here are
    // cumulative through week w, not the season total, for the same reason as above.
    const ranked = [...list].sort((a, b) =>
      b.wins_so_far - a.wins_so_far || b.points_so_far - a.points_so_far);
    const cut = Math.min(list[0].playoff_teams ?? ranked.length, ranked.length) - 1;
    const line = ranked[Math.max(0, cut)];
    for (const row of list) row.games_back = +(line.wins_so_far - row.wins_so_far).toFixed(1);
  }
  return out;
}

/**
 * How much of a team's scoring so far is the team, and how much is the week.
 *
 * This is the number "early panic vs low data" reduces to, and it is a variance
 * decomposition rather than an opinion. Over a season a team's weekly scores vary for
 * two reasons: teams genuinely differ (between-team variance) and any team's week is
 * noisy (within-team variance). If a per-week score has noise variance s2_within and
 * the true team means are spread with variance s2_between, then the best estimate of a
 * team's true mean after n games shrinks its observed mean toward the league mean by
 *
 *     weight on observed = n / (n + k),    k = s2_within / s2_between
 *
 * which is the master plan's k(w) with k derived instead of fitted. A large k means many
 * games are needed before a record means much.
 *
 * ESTIMATION. Within-team variance is the mean of each team-season's own sample variance
 * about its own mean, which is unbiased for the noise and carries no between-team signal.
 * Between-team variance is the variance of team-season means MINUS the sampling error
 * those means still contain (s2_within / n), because an observed spread of means is
 * always wider than the true spread -- not subtracting it is the classic way to
 * understate k and overstate how much an early record tells you.
 *
 * Teams with fewer than `minGames` weeks are excluded: a two-week team-season
 * contributes almost nothing to the within estimate and a lot of sampling error to the
 * between one.
 */
export function varianceComponents({ seasons = null, minGames = 8, panel = null } = {}) {
  const p = panel ?? weeklyPanel({ seasons });
  if (!p.length) return null;

  // Each team-season's full set of weekly z-scores.
  const byTeam = new Map();
  for (const r of p) {
    const key = `${r.league_id}|${r.roster_id}`;
    (byTeam.get(key) ?? byTeam.set(key, []).get(key)).push(r.points_z);
  }

  const means = [];
  let withinSum = 0, withinTeams = 0, gamesSum = 0;
  for (const zs of byTeam.values()) {
    if (zs.length < minGames) continue;
    const n = zs.length;
    const mean = zs.reduce((s, z) => s + z, 0) / n;
    // Sample variance with n-1: unbiased for the per-week noise.
    const within = zs.reduce((s, z) => s + (z - mean) ** 2, 0) / (n - 1);
    withinSum += within; withinTeams++;
    means.push(mean); gamesSum += n;
  }
  if (withinTeams < 2) return null;

  const s2Within = withinSum / withinTeams;
  const meanOfMeans = means.reduce((s, m) => s + m, 0) / means.length;
  const observedSpread = means.reduce((s, m) => s + (m - meanOfMeans) ** 2, 0) / (means.length - 1);
  const avgGames = gamesSum / withinTeams;
  // The observed spread of means still contains sampling error; remove it.
  const rawBetween = observedSpread - s2Within / avgGames;

  /*
   * The subtraction can come out at or below zero, and that is a real finding rather
   * than an error: it says the spread between these teams' means is no wider than
   * sampling error alone would make it, so the data shows no measurable true difference
   * between teams. k is then unbounded -- no number of games would make a record
   * informative -- and clamping the variance to an epsilon would silently report a k in
   * the hundreds of millions with a weight curve of zeros that looks like a bug.
   *
   * So the degenerate case is labelled and k is capped at a stated maximum. `K_CAP` of
   * 1000 is far beyond anything a real population produces (the crawled history gives
   * 7.5) and keeps every downstream weight a usable number.
   */
  const K_CAP = 1000;
  const betweenPositive = rawBetween > 0;
  const s2Between = betweenPositive ? rawBetween : null;
  // Rounded ONCE, here, and every published number derived from this same value. The
  // weight table used to be built from the unrounded k while `k` was reported to two
  // decimals, so a reader recomputing n/(n+k) from the reported k got different numbers
  // than the table gave. A test pins the two together now.
  const k = +(betweenPositive ? Math.min(K_CAP, s2Within / rawBetween) : K_CAP).toFixed(2);

  return {
    team_seasons: withinTeams, avg_games: +avgGames.toFixed(2),
    s2_within: +s2Within.toFixed(4), s2_observed_between: +observedSpread.toFixed(4),
    s2_between: s2Between == null ? null : +s2Between.toFixed(4),
    between_positive: betweenPositive,
    k, k_capped: k >= K_CAP, k_cap: K_CAP,
    reason: betweenPositive ? null
      : 'the spread between team means is no wider than sampling error, so this data shows '
        + 'no measurable true difference between teams and k is reported at its cap',
    // What that k means in the only terms anyone cares about.
    weight_by_week: Object.fromEntries(
      Array.from({ length: 14 }, (_, i) => [i + 1, +((i + 1) / (i + 1 + k)).toFixed(6)])
    ),
    // Games needed before the observed mean carries half the weight: n = k.
    games_for_half_weight: k
  };
}

/**
 * Shrink a team's observed mean toward the league with a given k.
 * Exposed so the audit and any consumer apply the identical formula.
 */
export const shrinkToLeague = (observedMeanZ, games, k) =>
  (games / (games + k)) * observedMeanZ;

/**
 * "Teams like yours": the real base rate for a team in a given state at a given week.
 *
 * `n` is always returned and never hidden, because the answer to "of teams that started
 * 1-1 with a top-three lineup, how many made the playoffs" is worthless without it.
 * A bucket thinner than `minN` returns `available: false` and says how thin it was
 * rather than reporting a percentage nobody should read.
 *
 * Matching is on the things that actually change the base rate: the week, the league's
 * playoff share (6 of 12 is a different world from 6 of 8), and how the team has
 * scored so far in z-units. Record is deliberately NOT a matching key -- it is the
 * noisy signal being explained.
 */
export function compsFor({ week, playoffShare, meanPointsZ, zTolerance = 0.25, shareTolerance = 0.06 },
  { seasons = null, minN = 30, panel = null } = {}) {
  const p = panel ?? weeklyPanel({ seasons });
  if (!p.length) return { available: false, reason: 'no league history on file', n: 0 };
  const matches = p.filter(r =>
    r.week === week
    && Math.abs((r.playoff_teams / r.num_teams) - playoffShare) <= shareTolerance
    && Math.abs(r.mean_points_z - meanPointsZ) <= zTolerance);
  if (matches.length < minN) {
    return {
      available: false, n: matches.length, min_n: minN,
      reason: `only ${matches.length} comparable team-seasons on file (need ${minN})`
    };
  }
  const made = matches.reduce((s, r) => s + r.made_playoffs, 0);
  const won = matches.reduce((s, r) => s + r.champion, 0);
  const rate = made / matches.length;
  // Binomial standard error, reported so a consumer can widen rather than round.
  const se = Math.sqrt(rate * (1 - rate) / matches.length);
  return {
    available: true, n: matches.length,
    playoff_rate: +rate.toFixed(4), playoff_rate_se: +se.toFixed(4),
    title_rate: +(won / matches.length).toFixed(4),
    week, playoff_share: playoffShare, mean_points_z: meanPointsZ,
    tolerance: { z: zTolerance, playoff_share: shareTolerance }
  };
}
