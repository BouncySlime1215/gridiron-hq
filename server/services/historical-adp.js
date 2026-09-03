/**
 * Historical preseason consensus rank (ADP-equivalent), by season.
 *
 * Nothing in this app retains this: `player_metrics`/`dynasty_values` hold
 * only the current live snapshot, overwritten in place every sync — there is
 * no way to ask "what did the market think of this player before the 2023
 * season" from that data. This is the one real gap behind the planned
 * boom/bust-vs-preseason-perception analysis (see the fantasy-coordinator
 * plan), and it needs a source that actually retained history.
 *
 * Source: dynastyprocess/data (github.com/dynastyprocess/data), an openly
 * licensed, freely fetchable fantasy-football data release — the same kind
 * of public GitHub-hosted release this codebase already pulls nflverse/odds
 * history from. `files/db_fpecr.csv.gz` is FantasyPros expert-consensus-rank
 * scrapes, ecr_type='ro' (redraft overall) is the "who's good this year"
 * slice. Verified directly before building this (downloaded and inspected,
 * 2026-09-03): 1.5M+ rows, real weekly scrapes July-September for every
 * season 2021-2025, columns include player/pos/team/ecr/sd/mergename/
 * ecr_type/scrape_date. `mergename` is FantasyPros' own normalized name key;
 * this module re-normalizes through this codebase's own
 * normalizePlayerName() rather than trusting theirs, so it composes cleanly
 * with every other identity match here.
 *
 * Deliberately snapshotted per (season, source) here — the same reason
 * nfl-external-ratings.js snapshots TeamRankings per (season, week) instead
 * of overwriting a single row: a value that gets replaced in place can never
 * be backtested, only ever describe "now."
 *
 * No player_id resolution happens here on purpose. The players table changes
 * as rosters sync and seasons pass; coupling a fixed historical fact (what
 * the market thought of someone in July 2022) to a mutable, evolving table
 * would make this ingestion re-derive a different answer every time it's
 * consulted. Resolution to an internal player happens downstream, at the
 * point that actually needs it (the boom/bust join), the same way
 * nfl-news-signal.js keeps its raw extraction separate from resolution.
 */
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { db, rows, run } from '../db/index.js';
import { normalizePlayerName } from './player-identity.js';

const SOURCE_URL = 'https://github.com/dynastyprocess/data/raw/master/files/db_fpecr.csv.gz';
export const HISTORICAL_ADP_SOURCE = 'dynastyprocess_fpecr';
// The two page_types that are standard offense-only redraft consensus rank —
// see the ecr_type='ro' comment below for why page_type must also be checked.
const PAGE_TYPES = new Set(['redraft-overall', 'redraft-offense']);

// Real, well-known historical facts (each season's actual Week 1 opening
// night), not derived — used only to pick "the last scrape before the season
// started" out of the weekly July-September scrape cadence. 2026 is excluded:
// this table is for *past* seasons only, where "what did the market expect"
// can be checked against a real outcome; the current season has no outcome
// yet to grade against.
export const SEASON_WEEK1_KICKOFF = Object.freeze({
  2021: '2021-09-09', 2022: '2022-09-08', 2023: '2023-09-07',
  2024: '2024-09-05', 2025: '2025-09-04'
});

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_historical_adp (
    season INTEGER NOT NULL,
    source TEXT NOT NULL,
    player_key TEXT NOT NULL,
    name TEXT NOT NULL,
    position TEXT,
    team TEXT,
    ecr_rank REAL NOT NULL,
    ecr_std_dev REAL,
    scrape_date TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (season, source, player_key)
  )
`);

/** `season|player_key` -> row, for the boom/bust join and any other reader. */
export function historicalAdpFor(season) {
  return rows(`SELECT * FROM nfl_historical_adp WHERE season = ? ORDER BY ecr_rank`, season);
}

export function historicalAdpCoverage() {
  return rows(`SELECT season, COUNT(*) AS players, MIN(scrape_date) AS earliest_used_here,
                      MAX(scrape_date) AS latest_used_here
               FROM nfl_historical_adp GROUP BY season ORDER BY season`);
}

/** Minimal quoted-CSV line splitter — mirrors nfl-advanced.js's streamer, kept
 *  local since this file's source (a different host, ~100MB) doesn't share
 *  any other plumbing with that module. */
function parseCsvLine(line) {
  const out = [];
  let field = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

/**
 * Streams db_fpecr.csv.gz and calls `onRow(record)` for each `ecr_type='ro'`
 * row whose scrape_date falls in `wantedSeasons`' July 1 - kickoff window.
 * Streamed rather than buffered whole: the decompressed file is well over a
 * gigabyte, and only a tiny slice of it (redraft-overall, preseason weeks) is
 * ever used.
 */
async function eachPreseasonRow(wantedSeasons, onRow) {
  const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(240000) });
  if (!res.ok) throw new Error(`${SOURCE_URL} -> HTTP ${res.status}`);
  const src = Readable.fromWeb(res.body).pipe(createGunzip());
  src.setEncoding('utf8');

  let header = null;
  let carry = '';
  const idx = {};
  const handleLine = line => {
    if (!line) return;
    const rec = parseCsvLine(line);
    if (!header) {
      header = rec;
      header.forEach((h, i) => { idx[h] = i; });
      return;
    }
    // ecr_type='ro' alone is not enough: it's shared by both standard
    // offense-only redraft rankings AND individual-defensive-player (IDP)
    // redraft rankings, distinguished only by page_type — confirmed by
    // inspecting the real file (54,402 'redraft-idp' rows and a stray 319
    // 'dynasty-offense' rows hide under the same ecr_type). Without this,
    // linebackers ranked ahead of Ja'Marr Chase silently entered the data
    // as if they were standard fantasy consensus.
    if (rec[idx.ecr_type] !== 'ro' || !PAGE_TYPES.has(rec[idx.page_type])) return;
    const scrapeDate = rec[idx.scrape_date];
    const season = seasonForScrapeDate(scrapeDate, wantedSeasons);
    if (season == null) return;
    // A blank/'NA' ecr shows up on a real but incomplete scrape row (a player
    // FantasyPros listed without yet ranking) — dropped rather than stored as
    // a fabricated 0 or NaN, same as every other feed in this codebase that
    // abstains on an unresolvable value instead of guessing.
    const ecrRank = Number(rec[idx.ecr]);
    if (!Number.isFinite(ecrRank) || !rec[idx.player]) return;
    onRow({
      season, name: rec[idx.player], position: rec[idx.pos], team: rec[idx.tm] || rec[idx.team],
      ecr_rank: ecrRank, ecr_std_dev: Number(rec[idx.sd]) || null, scrape_date: scrapeDate
    });
  };

  for await (const chunk of src) {
    carry += chunk;
    const lines = carry.split('\n');
    carry = lines.pop();
    for (const line of lines) handleLine(line.replace(/\r$/, ''));
  }
  if (carry) handleLine(carry.replace(/\r$/, ''));
}

/** A scrape_date belongs to season S's preseason window if it falls between
 *  July 1 of year S and S's real Week 1 kickoff (exclusive) — the same July-
 *  September cadence confirmed in the source data. */
function seasonForScrapeDate(scrapeDate, wantedSeasons) {
  if (!scrapeDate) return null;
  for (const season of wantedSeasons) {
    const kickoff = SEASON_WEEK1_KICKOFF[season];
    if (!kickoff) continue;
    if (scrapeDate >= `${season}-07-01` && scrapeDate < kickoff) return season;
  }
  return null;
}

/**
 * Fetch and store the last preseason redraft-overall ECR scrape before each
 * requested season's real Week 1 kickoff. Only the LAST such scrape per
 * (season, player) is kept — the closest real-world approximation to "what
 * the market thought right before the season," not an average across a
 * whole summer of movement.
 */
export async function syncHistoricalAdp(seasons = Object.keys(SEASON_WEEK1_KICKOFF).map(Number)) {
  const wanted = seasons.filter(s => SEASON_WEEK1_KICKOFF[s]);
  const latestByKey = new Map(); // `${season}|${player_key}` -> row, kept if scrape_date is newer
  let scanned = 0, unresolvedPosition = 0;

  await eachPreseasonRow(wanted, r => {
    scanned++;
    const key = normalizePlayerName(r.name);
    if (!key) return;
    if (!r.position) unresolvedPosition++;
    const mapKey = `${r.season}|${key}`;
    const prev = latestByKey.get(mapKey);
    if (!prev || r.scrape_date > prev.scrape_date) latestByKey.set(mapKey, { ...r, player_key: key });
  });

  const fetchedAt = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const season of wanted) run(`DELETE FROM nfl_historical_adp WHERE season = ? AND source = ?`, season, HISTORICAL_ADP_SOURCE);
    const stmt = db.prepare(`INSERT INTO nfl_historical_adp
      (season, source, player_key, name, position, team, ecr_rank, ecr_std_dev, scrape_date, fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const r of latestByKey.values()) {
      stmt.run(r.season, HISTORICAL_ADP_SOURCE, r.player_key, r.name, r.position || null, r.team || null,
        r.ecr_rank, r.ecr_std_dev, r.scrape_date, fetchedAt);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  return { seasons: wanted, scanned, stored: latestByKey.size, unresolved_position: unresolvedPosition };
}
