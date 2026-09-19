/**
 * Export a lookup of `home_team_rating - away_team_rating` for every game,
 * from TeamRankings' free predictive power rating
 * (`nfl_external_ratings`, `source='teamrankings_predictive'`, live in the
 * read-only fantasy-football-dashboard research database) -- so
 * `nfl-ensemble.js`'s synchronous `predict(ctx)` loop can read a plain
 * number instead of touching that database live. See
 * `server/services/nfl-teamrankings-lookup.js` for why a lookup rather than
 * a live query, and `research/betting/nfl/export_market_correction_lookup.py`
 * for the sibling precompute this mirrors.
 *
 * WHY NODE:SQLITE DIRECTLY, NOT `server/db/index.js`. That module opens
 * `server/data.sqlite` (or `GRIDIRON_DB_PATH`) and immediately applies this
 * app's own migrations (`applyLegacySchema`) against whatever it opens --
 * exactly the wrong thing to point at a read-only copy of a completely
 * different database (the fantasy-football-dashboard research DB) that this
 * app has no schema authority over and must never write to. This script
 * instead opens `--db` directly with `node:sqlite`'s `DatabaseSync` in
 * `{ readOnly: true }` mode, so a mistaken `--db` pointed at the live
 * database still cannot write anything.
 *
 * WHY THE MOST RECENT WEEK *STRICTLY EARLIER* THAN THE GAME'S OWN WEEK, NOT
 * THE GAME'S OWN WEEK'S RATING. `nfl_external_ratings.fetched_at` was
 * checked before writing this script, hoping it could confirm each week's
 * rating was published before that week's games kicked off (which would
 * make the game's own week's rating safe to use, the way a market's closing
 * line is safe to use as of kickoff). It does not confirm that: every row
 * for a given historical season was fetched within the same few-minute
 * window on 2026-09-02 (e.g. every 2024 week's `fetched_at` sits between
 * 22:30:08 and 22:30:36 UTC that single day) -- a bulk historical backfill,
 * not a week-by-week live capture. That timestamp says only when this
 * database scraped TeamRankings' site, nothing about when TeamRankings
 * itself first published that week's number, so it cannot rule out the
 * possibility that a given week's "predictive" rating already reflects that
 * week's own results. The safe fallback the task called for is used
 * unconditionally instead: each team's rating is taken from the most recent
 * week strictly before the game's own week, within the same season. A
 * week-1 game therefore has no admissible rating for either team (there is
 * no earlier week that season) and is correctly omitted rather than guessed.
 *
 * VALUE SCALE. Measured directly against the live database before writing
 * this script: `MIN(rating)=-13.68, MAX(rating)=13.06, AVG(rating)=-0.033`
 * across all 2,368 `teamrankings_predictive` rows (2022-2026). That is
 * already a point-margin scale centered near zero -- consistent with
 * TeamRankings' own description of this rating as the expected margin
 * against a league-average team -- so `rating_diff` is written as a plain
 * subtraction with no rescaling, the same convention `massey` in
 * `nfl-ensemble.js` uses for its own already-point-scale rating (unlike
 * `colley`, whose [0,1]-ish win-value rating is deliberately multiplied by
 * 55 before it can stand in for a margin).
 *
 * MISSING COVERAGE IS NOT AN ERROR. A game where either team has no
 * admissible earlier-week rating simply has no entry in the output. The JS
 * lookup reads that as `null` and the ensemble component abstains for that
 * game -- the same missing-evidence pattern every other component in
 * `nfl-ensemble.js` already follows. This script does not paper over a gap
 * with a fabricated zero.
 *
 * Usage:
 *   node scripts/export-teamrankings-features.mjs \
 *     --db /path/to/read-only-research-db.sqlite \
 *     --out research/betting/nfl/teamrankings-lookup.json \
 *     [--min-season 1999] [--through-season 2026]
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = 'teamrankings_predictive';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, reason: message }));
  process.exit(1);
}

function main() {
  const dbPath = arg('--db');
  const out = arg('--out');
  if (!dbPath || !out) {
    console.error('usage: node scripts/export-teamrankings-features.mjs --db <path> --out <path> '
      + '[--min-season 1999] [--through-season 2026]');
    process.exit(2);
  }
  const minSeason = Number(arg('--min-season', '1999'));
  const throughSeason = Number(arg('--through-season', '2026'));
  if (!Number.isFinite(minSeason) || !Number.isFinite(throughSeason)) {
    fail(`--min-season/--through-season must be numbers (got ${arg('--min-season')}, ${arg('--through-season')})`);
  }

  let db;
  try {
    db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
  } catch (exc) {
    fail(`could not open --db ${dbPath} read-only: ${exc.message}`);
    return;
  }

  try {
    // rating[`${season}|${team}`] -> Map(week -> rating)
    const ratingRows = db.prepare(
      `SELECT season, week, team, rating FROM nfl_external_ratings
       WHERE source = ? AND season BETWEEN ? AND ?`
    ).all(SOURCE, minSeason, throughSeason);

    const bySeasonTeam = new Map();
    for (const r of ratingRows) {
      const key = `${r.season}|${r.team}`;
      let weeks = bySeasonTeam.get(key);
      if (!weeks) { weeks = new Map(); bySeasonTeam.set(key, weeks); }
      weeks.set(r.week, r.rating);
    }

    // The most recent rating strictly before `week` for `team` in `season`,
    // or null if none exists (e.g. week 1, or a team/season TeamRankings
    // never covered).
    function priorRating(season, team, week) {
      const weeks = bySeasonTeam.get(`${season}|${team}`);
      if (!weeks) return null;
      let best = null, bestWeek = -Infinity;
      for (const [w, rating] of weeks) {
        if (w < week && w > bestWeek) { bestWeek = w; best = rating; }
      }
      return best;
    }

    // One row per game: `game_lines` carries one row per team per game, so
    // `home = 1` picks the home team's own row, which already names the
    // opponent as `away`.
    const games = db.prepare(
      `SELECT season, week, team AS home, opponent AS away FROM game_lines
       WHERE home = 1 AND season BETWEEN ? AND ?
       ORDER BY season, week, team`
    ).all(minSeason, throughSeason);

    const entries = [];
    for (const g of games) {
      if (!g.away) continue; // no opponent on record -- not a real scheduled game
      const homeRating = priorRating(g.season, g.home, g.week);
      const awayRating = priorRating(g.season, g.away, g.week);
      if (homeRating == null || awayRating == null) continue; // omit, never fabricate a zero
      entries.push({
        season: g.season, week: g.week, home: g.home, away: g.away,
        rating_diff: homeRating - awayRating,
      });
    }

    const payload = {
      schema: 'nfl-teamrankings-lookup-v1',
      created_at: new Date().toISOString(),
      source: 'nfl_external_ratings (source=teamrankings_predictive) via game_lines schedule; '
        + 'rating_diff uses each team\'s most recent rating from a week strictly before the '
        + 'game\'s own week (see this script\'s header for why)',
      db_path: path.resolve(dbPath),
      min_season: minSeason,
      through_season: throughSeason,
      games: games.length,
      entries_with_rating: entries.length,
      entries,
    };

    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    const tmp = `${path.resolve(out)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, path.resolve(out));

    console.log(JSON.stringify({
      out: path.resolve(out), games: games.length, entries_with_rating: entries.length,
      coverage: games.length ? +(entries.length / games.length).toFixed(4) : 0,
    }, null, 2));
  } catch (exc) {
    fail(`${exc.constructor?.name ?? 'Error'}: ${exc.message}`);
  } finally {
    db.close();
  }
}

main();
