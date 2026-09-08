/**
 * The FULL preseason ECR scrape history — every weekly FantasyPros scrape per
 * player-season, not just the last one before kickoff.
 *
 * `historical-adp.js` deliberately keeps one row per (season, player): the
 * closest approximation to "what the market thought right before the season,"
 * which is exactly what the boom/bust join and DRAFT_AUDIT_2021_2025.md want.
 * That collapse (`latestByKey`) is correct for those readers and destroys the
 * one thing this table exists for: the *movement* between scrapes. A price you
 * only ever observe once has no velocity.
 *
 * Kept as a separate table rather than by widening `nfl_historical_adp`'s
 * primary key, for the same reason nfl-external-ratings.js snapshots rather
 * than overwrites: every existing reader of `nfl_historical_adp` assumes one
 * row per player-season, and silently turning that into ~10 would change what
 * `historicalAdpFor()` means for the boom/bust model, the draft audit, and the
 * draft board, none of which asked for a time series. Ingestion is shared —
 * this module reuses `eachPreseasonRow` from historical-adp.js rather than
 * re-implementing the CSV stream, so both tables are parsed by exactly one
 * piece of code and can never disagree about what a 'ro' row is.
 *
 * Motivation: docs/BETTING_CAPABILITY_AUDIT.md candidate #3 — the fantasy
 * analogue of signal-latency.js. On the betting side "we knew at 14:02 and the
 * number moved at 14:40" is measurable only because a quote tape exists. This
 * is that tape for ECR, five seasons deep.
 */
import { db, rows, run } from '../db/index.js';
import { normalizePlayerName } from './player-identity.js';
import { recordSync } from './scheduler.js';
import {
  eachPreseasonRow, HISTORICAL_ADP_SOURCE, SEASON_WEEK1_KICKOFF
} from './historical-adp.js';

/** Every retained scrape for a season, oldest first. */
export function adpScrapesFor(season) {
  return rows(`SELECT * FROM nfl_historical_adp_scrape WHERE season = ?
               ORDER BY player_key, scrape_date`, season);
}

/** Proof-of-retention view: rows, distinct scrape dates, distinct players, and
 *  the median scrapes-per-player — the number that was 1 before this table
 *  existed. */
export function adpScrapeCoverage() {
  return rows(`SELECT season,
                      COUNT(*) AS rows,
                      COUNT(DISTINCT scrape_date) AS scrape_dates,
                      COUNT(DISTINCT player_key) AS players,
                      MIN(scrape_date) AS first_scrape,
                      MAX(scrape_date) AS last_scrape,
                      ROUND(CAST(COUNT(*) AS REAL) / COUNT(DISTINCT player_key), 2) AS scrapes_per_player
               FROM nfl_historical_adp_scrape GROUP BY season ORDER BY season`);
}

/**
 * Re-fetch db_fpecr.csv.gz and store EVERY preseason 'ro' scrape row, keyed by
 * (season, player, scrape_date). A player who appears twice on the same scrape
 * date (FantasyPros occasionally emits a duplicate line for a player listed at
 * two positions) keeps the better-ranked row — an arbitrary but deterministic
 * choice, and preferable to letting the INSERT throw and lose the whole season.
 */
export async function syncHistoricalAdpScrapes(
  seasons = Object.keys(SEASON_WEEK1_KICKOFF).map(Number)
) {
  const wanted = seasons.filter(s => SEASON_WEEK1_KICKOFF[s]);
  const byKey = new Map(); // `${season}|${key}|${scrape_date}` -> row
  let scanned = 0, dupes = 0;

  try {
    await eachPreseasonRow(wanted, r => {
      scanned++;
      const key = normalizePlayerName(r.name);
      if (!key) return;
      const mapKey = `${r.season}|${key}|${r.scrape_date}`;
      const prev = byKey.get(mapKey);
      if (prev) { dupes++; if (r.ecr_rank >= prev.ecr_rank) return; }
      byKey.set(mapKey, { ...r, player_key: key });
    });
  } catch (e) { recordSync('historical_adp_scrapes', 'error', e.message); throw e; }

  const fetchedAt = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const season of wanted) {
      run(`DELETE FROM nfl_historical_adp_scrape WHERE season = ? AND source = ?`,
        season, HISTORICAL_ADP_SOURCE);
    }
    const stmt = db.prepare(`INSERT INTO nfl_historical_adp_scrape
      (season, source, player_key, scrape_date, name, position, team, ecr_rank, ecr_std_dev, fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const r of byKey.values()) {
      stmt.run(r.season, HISTORICAL_ADP_SOURCE, r.player_key, r.scrape_date, r.name,
        r.position || null, r.team || null, r.ecr_rank, r.ecr_std_dev, fetchedAt);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); recordSync('historical_adp_scrapes', 'error', e.message); throw e; }

  const result = { seasons: wanted, scanned, stored: byKey.size, same_date_duplicates: dupes };
  recordSync('historical_adp_scrapes', 'ok', result);
  return result;
}
