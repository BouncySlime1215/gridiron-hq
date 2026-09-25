/**
 * PLAYER-SCORE: the FantasyPros bridge. The latest in-season rest-of-season expert
 * consensus rank (ECR) per player, cached in the DB, read by the blue-chip board.
 *
 * Source: the DynastyProcess public weekly FantasyPros scrape (github.com/dynastyprocess/data,
 * GPL-3.0), the same release historical-adp.js / historical-adp-scrapes.js already read.
 * We never scrape fantasypros.com. Two files, both read-only GETs of public GitHub raw files:
 *   files/db_fpecr_latest.csv   the newest weekly scrape only (~1 MB). Default.
 *   files/db_fpecr.csv.gz       every scrape since 2021 (~100 MB, streamed). Only with
 *                               { history: true }, to seed earlier in-season scrapes so the
 *                               board can say whether a player's rank is falling.
 * Rows kept: ecr_type 'ro' on page_type 'redraft-overall' (redraft overall; after kickoff the
 * redraft page IS the rest-of-season ranking) and ecr_type 'rp' on redraft-qb/rb/wr/te
 * (the positional rank). Scrapes dated before this season's kickoff are preseason, not
 * rest-of-season, and are dropped (see IN_SEASON_FROM).
 *
 * Licence / NICK-FP (2026-09-23): FantasyPros-derived per-player data never goes in the
 * public repo. It lives in the local DB table `fp_ros_ecr` and in the local plans file only;
 * tests use made-up players.
 *
 * Table: fp_ros_ecr, one row per (scrape_date, fp_id), created by the writer here on first
 * sync (CREATE TABLE IF NOT EXISTS, additive; the reader treats a missing table as
 * "never synced" and says so). Each sync adds its scrape date and keeps older ones, so the
 * rank's movement accrues.
 *
 * Join to our players: normalizePlayerName(name) + position, the name mapping every other
 * FantasyPros reader here uses (historical-adp.js). Two of our players sharing a name and a
 * position are both left unjoined rather than guessed.
 */
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { normalizePlayerName } from '../player-identity.js';

export const FP_ROS_SOURCE = 'dynastyprocess_fpecr';
export const LATEST_URL = 'https://github.com/dynastyprocess/data/raw/master/files/db_fpecr_latest.csv';
export const HISTORY_URL = 'https://github.com/dynastyprocess/data/raw/master/files/db_fpecr.csv.gz';
export const FP_ROS_TABLE = 'fp_ros_ecr';
/** Week 1 kickoff per season: a scrape on or after it is a rest-of-season ranking. */
export const IN_SEASON_FROM = Object.freeze({ 2026: '2026-09-10' });
const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);
const POS_PAGES = new Set(['redraft-qb', 'redraft-rb', 'redraft-wr', 'redraft-te']);
/** A cached scrape older than this is refreshed by syncIfStale. */
export const STALE_HOURS = 24;

/** Minimal quoted-CSV splitter (the same rules as historical-adp.js#parseCsvLine). */
export function parseCsvLine(line) {
  const out = [];
  let field = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(field); field = ''; } else field += c;
  }
  out.push(field);
  return out;
}

const seasonOf = date => Number(String(date).slice(0, 4));
/** True when a scrape date is a rest-of-season scrape (on or after that season's kickoff). */
export function inSeason(date) {
  const from = IN_SEASON_FROM[seasonOf(date)];
  return !!from && String(date) >= from;
}

/**
 * A line consumer: feed it CSV lines (header first); it keeps rest-of-season rows only.
 * Returns { push(line), rows(): [{ scrape_date, fp_id, name, position, team, ecr, sd, pos_rank }] }
 * with the positional rank folded onto the overall row of the same (scrape_date, fp_id).
 */
export function rosCollector() {
  let idx = null;
  const overall = new Map(), posRank = new Map();
  return {
    push(line) {
      if (!line) return;
      const rec = parseCsvLine(line);
      if (!idx) { idx = Object.fromEntries(rec.map((h, i) => [h, i])); return; }
      const et = rec[idx.ecr_type], pt = rec[idx.page_type], date = rec[idx.scrape_date];
      const isOverall = et === 'ro' && pt === 'redraft-overall';
      const isPos = et === 'rp' && POS_PAGES.has(pt);
      if ((!isOverall && !isPos) || !inSeason(date)) return;
      const pos = String(rec[idx.pos] ?? '').replace(/\d+$/, '');
      const ecr = Number(rec[idx.ecr]);
      const fpId = String(rec[idx.id] ?? '');
      if (!SKILL.has(pos) || !Number.isFinite(ecr) || !fpId || !rec[idx.player]) return;
      const key = `${date}|${fpId}`;
      if (isPos) { const prev = posRank.get(key); if (prev == null || ecr < prev) posRank.set(key, ecr); return; }
      const prev = overall.get(key);
      if (prev && prev.ecr <= ecr) return;
      overall.set(key, { scrape_date: date, fp_id: fpId, name: rec[idx.player], position: pos,
        team: rec[idx.tm] || rec[idx.team] || null, ecr, sd: Number.isFinite(Number(rec[idx.sd])) ? Number(rec[idx.sd]) : null });
    },
    rows() {
      return [...overall.entries()].map(([k, r]) => ({ ...r, pos_rank: posRank.get(k) ?? null }));
    },
  };
}

/** Parse a whole CSV text (the latest file). */
export function parseRosCsv(text) {
  const c = rosCollector();
  for (const line of String(text).split('\n')) c.push(line.replace(/\r$/, ''));
  return c.rows();
}

function ensureTable(dbm) {
  dbm.db.exec(`CREATE TABLE IF NOT EXISTS ${FP_ROS_TABLE} (
    scrape_date TEXT NOT NULL, fp_id TEXT NOT NULL, source TEXT NOT NULL, player_key TEXT NOT NULL,
    name TEXT NOT NULL, position TEXT NOT NULL, team TEXT, ecr REAL NOT NULL, sd REAL, pos_rank REAL,
    fetched_at TEXT NOT NULL, PRIMARY KEY (scrape_date, fp_id))`);
}

/** Store parsed rows (replacing only the scrape dates they carry). Returns the dates written. */
export function storeRosRows(dbm, list, fetchedAt = new Date().toISOString()) {
  ensureTable(dbm);
  const dates = [...new Set(list.map(r => r.scrape_date))];
  dbm.db.exec('BEGIN IMMEDIATE');
  try {
    for (const d of dates) dbm.run(`DELETE FROM ${FP_ROS_TABLE} WHERE scrape_date = ? AND source = ?`, d, FP_ROS_SOURCE);
    for (const r of list) {
      dbm.run(`INSERT INTO ${FP_ROS_TABLE} (scrape_date, fp_id, source, player_key, name, position, team, ecr, sd, pos_rank, fetched_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`, r.scrape_date, r.fp_id, FP_ROS_SOURCE, normalizePlayerName(r.name), r.name,
      r.position, r.team, r.ecr, r.sd, r.pos_rank, fetchedAt);
    }
    dbm.db.exec('COMMIT');
  } catch (e) { dbm.db.exec('ROLLBACK'); throw e; }
  return dates.sort();
}

/**
 * Fetch and cache. { history: true } streams the full scrape file too (every in-season scrape
 * this season). fetchImpl is injectable for tests. Returns { dates, rows }.
 */
export async function syncFpRos(dbm, { history = false, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(LATEST_URL, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${LATEST_URL} -> HTTP ${res.status}`);
  const list = parseRosCsv(await res.text());
  if (history) {
    const h = await fetchImpl(HISTORY_URL, { signal: AbortSignal.timeout(300000) });
    if (!h.ok) throw new Error(`${HISTORY_URL} -> HTTP ${h.status}`);
    const c = rosCollector();
    const src = Readable.fromWeb(h.body).pipe(createGunzip());
    src.setEncoding('utf8');
    let carry = '';
    for await (const chunk of src) {
      carry += chunk;
      const lines = carry.split('\n');
      carry = lines.pop();
      for (const l of lines) c.push(l.replace(/\r$/, ''));
    }
    if (carry) c.push(carry.replace(/\r$/, ''));
    const have = new Set(list.map(r => `${r.scrape_date}|${r.fp_id}`));
    for (const r of c.rows()) if (!have.has(`${r.scrape_date}|${r.fp_id}`)) list.push(r);
  }
  if (!list.length) throw new Error('no in-season FantasyPros rest-of-season rows in the DynastyProcess file');
  return { dates: storeRosRows(dbm, list), rows: list.length };
}

const hasTable = dbm => !!dbm.row(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`, FP_ROS_TABLE);

/** Refresh when the newest cached fetch is older than STALE_HOURS. Never throws: returns the outcome. */
export async function syncIfStale(dbm, { now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    const last = hasTable(dbm) ? dbm.row(`SELECT MAX(fetched_at) AS at FROM ${FP_ROS_TABLE}`)?.at : null;
    if (last && now - Date.parse(last) < STALE_HOURS * 3600e3) return { status: 'fresh', fetched_at: last };
    const r = await syncFpRos(dbm, { fetchImpl });
    return { status: 'synced', ...r };
  } catch (e) {
    return { status: 'failed', reason: `FantasyPros rest-of-season sync failed (${e.message})` };
  }
}

/** Earliest in-season scrape at least `gapDays` before `latest`, else null. */
function previousDate(dates, latest, gapDays = 7) {
  const cut = new Date(Date.parse(latest) - gapDays * 864e5).toISOString().slice(0, 10);
  const older = dates.filter(d => d <= cut);
  return older.length ? older[older.length - 1] : null;
}

/**
 * The bridge for a set of our players: Map id -> { ecr, pos_rank, scrape_date, prev_ecr, prev_date }.
 * players: [{ id, name, position }]. Returns { status, reason?, scrape_date, prev_date, byId }.
 */
export function fpRosFor(dbm, players) {
  if (!hasTable(dbm)) return { status: 'unknown', reason: 'FantasyPros rest-of-season ranks have never been synced (no fp_ros_ecr table).', byId: new Map() };
  const dates = dbm.rows(`SELECT DISTINCT scrape_date AS d FROM ${FP_ROS_TABLE} WHERE source = ? ORDER BY scrape_date`, FP_ROS_SOURCE).map(r => r.d).filter(inSeason);
  if (!dates.length) return { status: 'unknown', reason: 'No in-season FantasyPros scrape is cached yet.', byId: new Map() };
  const latest = dates[dates.length - 1];
  const prev = previousDate(dates, latest);
  const at = d => new Map(dbm.rows(`SELECT player_key, position, ecr, pos_rank FROM ${FP_ROS_TABLE} WHERE scrape_date = ? AND source = ?`, d, FP_ROS_SOURCE)
    .map(r => [`${r.player_key}|${r.position}`, r]));
  const now = at(latest), before = prev ? at(prev) : new Map();
  // Our side: a (name, position) two of our players share is ambiguous and left out.
  const count = new Map();
  for (const p of players) { const k = `${normalizePlayerName(p.name)}|${p.position}`; count.set(k, (count.get(k) ?? 0) + 1); }
  const byId = new Map();
  for (const p of players) {
    const k = `${normalizePlayerName(p.name)}|${p.position}`;
    if (count.get(k) !== 1) continue;
    const r = now.get(k);
    if (!r) continue;
    const b = before.get(k);
    byId.set(String(p.id), { ecr: r.ecr, pos_rank: r.pos_rank ?? null, scrape_date: latest, prev_ecr: b?.ecr ?? null, prev_date: b ? prev : null });
  }
  return { status: 'ok', scrape_date: latest, prev_date: prev, byId };
}
