export const name = '055_repair_pinnacle_placeholder_openers';

/**
 * Migration 047 re-sourced every 2022-2025 `open_spread`/`open_total` from
 * Pinnacle's archived opener alone, to escape a sign bug in the old
 * many-book median. That fixed the sign and let in a different defect:
 * Pinnacle frequently posts a placeholder opener (almost always home -1.0)
 * before real betting opens, and the archive recorded it as "the open".
 *
 * Measured read-only against the live database on 2026-09-16:
 *   - 2025: 64 of 285 Pinnacle spread openers sit >= 1.5 pts from the median
 *     of the other books' openers; 44 of those 64 are exactly -1.0. Weeks 2,
 *     8 and 15 average 4-5.5 pt "moves" from open to close (other seasons:
 *     1.1-1.3). Example: 2025 wk 2 BAL v CLE, Pinnacle open -2.5, all nine
 *     other books -12.5 to -13, close -13.
 *   - 2024: 23 deviations, and the close lands nearer the other books' open
 *     in 83% of them -- Pinnacle's number is the bad one.
 *   - 2022-2023: deviations are mostly the reverse case: the other books'
 *     "opens" were posted days EARLIER (median 108 h / 43 h) and are stale
 *     look-ahead numbers; Pinnacle's is the live one.
 *
 * RULE, which uses only what was known at the open (never the close):
 *   keep Pinnacle's opener UNLESS at least 3 other books posted an opener
 *   within 48 hours of Pinnacle's own posting time AND their median differs
 *   by >= 1.5 points; then use that median, rounded to the nearest half
 *   point (a bettable number). The 48 h window is what separates the 2024-25
 *   placeholder case from the 2022-23 stale-peer case.
 *   Validation (uses the close only to check, not to decide): with this rule
 *   the close lands nearer the repaired value in 58/61 repaired 2025 games
 *   and 19/22 in 2024, and 2025's mean open-to-close spread move drops from
 *   1.87 to 1.20, in line with every other season.
 *
 * UNRESOLVED: a Pinnacle opener of exactly -1.0 that is >= 1.5 from the
 * median of all other books but has no peers inside the window keeps its
 * value and is labeled `suspect_pinnacle_placeholder_unresolved_2022_2025`,
 * so pooled statistics can exclude it by name. Guessing would be worse.
 *
 * Totals get the same rule on Pinnacle's 'Over' line, with provenance in a
 * new `open_total_source` column. Only rows 047 wrote
 * (`open_spread_source = 'pinnacle_archive_reopen_2022_2025'`) are touched,
 * which also makes a second run a no-op.
 *
 * NOT applied by this change. Running it against a real database is a
 * separate, explicit step (repo SAFETY rules).
 */

export const WINDOW_HOURS = 48;
export const MIN_PEERS = 3;
export const THRESHOLD = 1.5;
const SOURCE_047 = 'pinnacle_archive_reopen_2022_2025';
export const REPAIRED = 'consensus_open_pinnacle_placeholder_2022_2025';
export const SUSPECT = 'suspect_pinnacle_placeholder_unresolved_2022_2025';

const median = xs => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const toHalf = x => Math.floor(x * 2 + 0.5) / 2;

/** quotes: [{book, line, t}] openers for ONE side of ONE game. */
export function resolveOpener(quotes) {
  const pin = quotes.find(q => q.book === 'pinnacle');
  if (!pin || pin.line == null) return null;
  const others = quotes.filter(q => q.book !== 'pinnacle' && q.line != null);
  const tP = pin.t ? Date.parse(pin.t) : NaN;
  const peers = Number.isFinite(tP)
    ? others.filter(q => q.t && Math.abs(Date.parse(q.t) - tP) <= WINDOW_HOURS * 3600e3)
    : [];
  if (peers.length >= MIN_PEERS) {
    const m = median(peers.map(q => q.line));
    if (Math.abs(pin.line - m) >= THRESHOLD) return { value: toHalf(m), source: REPAIRED, pinnacle: pin.line };
  }
  if (pin.line === -1.0 && others.length >= MIN_PEERS
      && Math.abs(pin.line - median(others.map(q => q.line))) >= THRESHOLD) {
    return { value: pin.line, source: SUSPECT, pinnacle: pin.line };
  }
  return null;
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

export function up(db) {
  if (!columns(db, 'game_lines').includes('open_total_source')) {
    db.exec('ALTER TABLE game_lines ADD COLUMN open_total_source TEXT');
  }
  const hasArchive = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='nfl_odds_archive'`).get();
  if (!hasArchive || !columns(db, 'game_lines').includes('open_spread_source')) return;

  const quotes = db.prepare(`
    SELECT eid, season, week, home, away, market, side, book, line, book_updated_at AS t
    FROM nfl_odds_archive
    WHERE phase = 'open' AND season BETWEEN 2022 AND 2025 AND line IS NOT NULL
      AND ((market = 'spreads' AND side = home) OR (market = 'totals' AND side = 'Over'))`).all();
  const games = new Map();
  for (const q of quotes) {
    const key = `${q.eid}`;
    if (!games.has(key)) games.set(key, { season: q.season, week: q.week, home: q.home, away: q.away, spreads: [], totals: [] });
    games.get(key)[q.market].push({ book: q.book, line: q.line, t: q.t });
  }

  const setSpread = db.prepare(`UPDATE game_lines SET open_spread = ?, open_spread_source = ?
    WHERE season = ? AND week = ? AND team = ? AND opponent = ? AND open_spread_source = '${SOURCE_047}'`);
  const setTotal = db.prepare(`UPDATE game_lines SET open_total = ?, open_total_source = ?
    WHERE season = ? AND week = ? AND ((team = ? AND opponent = ?) OR (team = ? AND opponent = ?))
      AND open_spread_source IN ('${SOURCE_047}', '${REPAIRED}', '${SUSPECT}') AND open_total_source IS NULL`);

  // No BEGIN here: server/db/migrate.js already runs each migration inside
  // its own transaction, and SQLite refuses a nested one.
  for (const g of games.values()) {
    const s = resolveOpener(g.spreads);
    const tot = resolveOpener(g.totals);
    if (tot) setTotal.run(tot.value, tot.source, g.season, g.week, g.home, g.away, g.away, g.home);
    if (s) {
      setSpread.run(s.value, s.source, g.season, g.week, g.home, g.away);
      setSpread.run(s.value === 0 ? 0 : -s.value, s.source, g.season, g.week, g.away, g.home);
    }
  }
}

export function down(db) {
  // Same convention as 047: the repaired numbers are more accurate than the
  // placeholders they replace, so data stays; only the additive column goes.
  if (columns(db, 'game_lines').includes('open_total_source')) {
    db.exec('ALTER TABLE game_lines DROP COLUMN open_total_source');
  }
}
