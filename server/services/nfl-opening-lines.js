/**
 * Opening lines, and the one test they make possible.
 *
 * Every negative result in this project is measured against the CLOSING line,
 * and that is the right benchmark for "can we forecast better than the market"
 * — a question now answered no, across twenty-two models and five seasons.
 *
 * But it is the wrong benchmark for "can we make money", because nobody bets
 * into a closing line. You bet into a number that is posted early and then
 * moves, and the professional standard for whether a bet was good is not
 * whether it won — it is whether the line moved TOWARD you afterwards. That is
 * closing-line value, and it is the only edge measurement that gives a verdict
 * in weeks instead of seasons.
 *
 * This project could never measure it, because the `open_spread` and
 * `open_total` columns on `game_lines` have existed and been empty since the
 * schema was written. nflverse publishes `initial_lines.csv` — one book, one
 * season, 272 games — which is not much, but it is 272 real open-and-close
 * pairs where there were previously zero.
 *
 * WHAT 272 GAMES CAN AND CANNOT SAY. A directional rate on this sample carries
 * a standard error near three points, so it can separate "clearly better than
 * a coin flip" from "clearly not". It cannot support sizing, and a small
 * positive result here is a reason to capture lines going forward, not a reason
 * to bet. The prospective capture already runs — the free ESPN line watch polls
 * every fifteen minutes and its first observation of a game is an opening line
 * in everything but name.
 */
import { rows, row, run } from '../db/index.js';

const INITIAL_URL = 'https://github.com/nflverse/nfldata/raw/master/data/initial_lines.csv';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/**
 * nflverse game ids look like `2021_01_DAL_TB` — season, week, away, home.
 *
 * The team codes here are nflverse's, which mostly match ours but not always;
 * anything that fails to resolve is counted and reported rather than silently
 * dropped, because a quiet 30% match rate would make every downstream number
 * wrong in a way nothing would catch.
 */
function parseGameId(id) {
  const m = String(id ?? '').match(/^(\d{4})_(\d{2})_([A-Z]{2,4})_([A-Z]{2,4})$/);
  if (!m) return null;
  return { season: +m[1], week: +m[2], away: m[3], home: m[4] };
}

/** nflverse codes that differ from the abbreviations used in this database. */
// Washington is stored as WAS in this database, not WSH — mapping it the other
// way silently dropped all 17 of its 2021 games on the first run.
const ALIAS = { LA: 'LAR', SD: 'LAC', OAK: 'LV', STL: 'LAR', WSH: 'WAS', WFT: 'WAS',
  ARZ: 'ARI', BLT: 'BAL', CLV: 'CLE', HST: 'HOU', SL: 'LAR', JAC: 'JAX' };
const norm = t => ALIAS[t] ?? t;

/**
 * Team codes, resolved for the season being written.
 *
 * This database stores era-correct abbreviations — 2013 has OAK, SD and STL;
 * 2020 has LV, LAC and LAR — while the nflverse line files use modern codes
 * throughout. Normalising to today's names silently dropped every relocated
 * franchise's game before its move, which was 214 of 2,043 rows on the first
 * run and would have quietly biased coverage toward three fewer teams.
 */
const RELOCATIONS = [
  { modern: 'LV', legacy: 'OAK', movedIn: 2020 },
  { modern: 'LAR', legacy: 'STL', movedIn: 2016 },
  { modern: 'LAC', legacy: 'SD', movedIn: 2017 }
];
function normForSeason(team, season) {
  const t = norm(team);
  if (!Number.isFinite(season)) return t;
  const rel = RELOCATIONS.find(r => r.modern === t);
  return rel && season < rel.movedIn ? rel.legacy : t;
}

/**
 * Download and store opening lines.
 *
 * Writes into the `open_spread` / `open_total` columns that have been sitting
 * empty on `game_lines`, matching on (season, week, team, opponent) so both the
 * home and away row of a game get the number from their own perspective.
 */
export async function ingestOpeningLines({ url = INITIAL_URL } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) return { error: `nflverse returned ${res.status} for initial_lines.csv` };
  const text = await res.text();
  const lines = text.trim().split('\n');
  const header = lines[0].split(',').map(h => h.trim());
  const iType = header.indexOf('type'), iAbout = header.indexOf('about');
  const iSide = header.indexOf('side'), iLine = header.indexOf('line');
  if ([iType, iAbout, iSide, iLine].some(i => i < 0)) {
    return { error: 'initial_lines.csv is missing expected columns' };
  }

  // Collapse the two rows per game per market into one home-perspective number.
  const byGame = new Map();
  for (const raw of lines.slice(1)) {
    const p = raw.split(',');
    const g = parseGameId(p[iAbout]);
    if (!g) continue;
    const line = Number(p[iLine]);
    if (!Number.isFinite(line)) continue;
    const key = p[iAbout];
    if (!byGame.has(key)) byGame.set(key, { ...g, open_spread: null, open_total: null });
    const entry = byGame.get(key);
    const type = String(p[iType]).toUpperCase();
    const side = String(p[iSide]).trim();
    if (type === 'SPREAD') {
      // Keep the HOME side's number, in this database's convention where a
      // negative home spread means the home team is favoured.
      if (norm(side) === norm(g.home)) entry.open_spread = line;
    } else if (type === 'TOTAL') {
      if (/^over$/i.test(side)) entry.open_total = line;
    }
  }

  let matched = 0, unmatched = 0, updated = 0;
  const misses = [];
  for (const g of byGame.values()) {
    const home = norm(g.home), away = norm(g.away);
    const exists = row(
      `SELECT COUNT(*) AS n FROM game_lines
       WHERE season = ? AND week = ? AND team = ? AND opponent = ? AND home = 1`,
      g.season, g.week, home, away)?.n ?? 0;
    if (!exists) {
      unmatched++;
      if (misses.length < 8) misses.push(`${g.season} wk${g.week} ${away}@${home}`);
      continue;
    }
    matched++;
    // Home row keeps the number as-is; the away row is its mirror, which is the
    // same convention `game_lines.spread` already uses.
    run(`UPDATE game_lines SET open_spread = ?, open_total = ?
         WHERE season = ? AND week = ? AND team = ? AND opponent = ? AND home = 1`,
    g.open_spread, g.open_total, g.season, g.week, home, away);
    run(`UPDATE game_lines SET open_spread = ?, open_total = ?
         WHERE season = ? AND week = ? AND team = ? AND opponent = ? AND home = 0`,
    g.open_spread == null ? null : -g.open_spread, g.open_total,
    g.season, g.week, away, home);
    updated += 2;
  }

  const coverage = row(`SELECT COUNT(*) AS n FROM game_lines WHERE open_spread IS NOT NULL`)?.n ?? 0;
  return {
    source: 'nflverse initial_lines.csv',
    games_in_file: byGame.size, matched, unmatched, rows_updated: updated,
    unmatched_examples: misses,
    open_spread_rows_now: coverage,
    note: matched
      ? 'These are the first opening lines this database has ever held. The columns existed from the ' +
        'start and were never populated, which is why closing-line value has never been measurable here.'
      : 'Nothing matched — check team-code normalisation before trusting any downstream number.'
  };
}

/**
 * Closing-line value: does the market move toward our number after it opens?
 *
 * The professional test of a bet, and the reason it matters is timing. Grading
 * picks by whether they won needs thousands of settled bets to separate skill
 * from variance. Grading them by whether the line moved toward you needs far
 * fewer, because line movement is much less noisy than game outcomes — the
 * market is aggregating information, not flipping coins.
 *
 * Three things get measured here, in increasing order of how much they matter:
 *
 *   1. How much the line moves at all, open to close. If it barely moves there
 *      is no value to capture regardless of how good the model is.
 *   2. Whether our disagreement with the OPENING line predicts the direction of
 *      that movement. This is the actual CLV test.
 *   3. Whether we beat the opening line against the spread — a far lower bar
 *      than the closing line, and the one a real bettor actually faces.
 */
export function closingLineValue({ season = 2021, model = 'simulator', trials = 250 } = {}) {
  const games = rows(
    `SELECT season, week, team, opponent, spread, total, open_spread, open_total,
            team_score, opp_score
     FROM game_lines
     WHERE home = 1 AND season = ? AND open_spread IS NOT NULL AND spread IS NOT NULL
       AND team_score IS NOT NULL AND opp_score IS NOT NULL`, season);
  if (games.length < 20) {
    return { error: `only ${games.length} games with both an opening and closing line for ${season}`,
      hint: 'Run ingestOpeningLines() first.' };
  }

  // How much does the number actually move? If the answer is "barely", there is
  // no value on the table for anyone.
  const moves = games.map(g => (g.spread ?? 0) - (g.open_spread ?? 0));
  const totalMoves = games.filter(g => g.open_total != null && g.total != null)
    .map(g => g.total - g.open_total);
  const movedAtAll = moves.filter(m => Math.abs(m) >= 0.5).length;
  // The mean is dragged badly by a handful of lookahead lines posted months
  // early and later corrected by six points or more, so the median is the
  // honest summary of what a typical game does.
  const med = a => { if (!a.length) return null; const s2 = [...a].sort((x, y) => x - y);
    return s2[Math.floor(s2.length / 2)]; };
  const absMoves = moves.map(Math.abs);

  return {
    season, games: games.length,
    movement: {
      median_absolute_spread_move: r2(med(absMoves)),
      mean_absolute_spread_move: r2(mean(absMoves)),
      median_absolute_total_move: r2(med(totalMoves.map(Math.abs))),
      mean_absolute_total_move: r2(mean(totalMoves.map(Math.abs))),
      share_moved_half_point_or_more: r4(movedAtAll / games.length),
      share_moved_three_or_more: r4(absMoves.filter(m => m >= 3).length / games.length),
      largest_move: r2(Math.max(...absMoves))
    },
    note: 'Movement only. Pass a model prediction through clvAgainstModel() to test whether our ' +
      'disagreement with the opening number predicts which way it moves — that is the CLV test, and ' +
      'it is the one measurement that returns a verdict in weeks rather than seasons.'
  };
}

/**
 * The CLV test proper: does the simulator's disagreement with the opening line
 * predict the direction the line then moves?
 *
 * If it does, the model is seeing something the market has not priced yet, and
 * that is worth money even though the same model loses to the closing line —
 * those two facts are compatible, and the distinction is the whole point.
 *
 * Cutoff-safe: the simulator is built from seasons strictly before the one
 * being tested.
 */
export function clvAgainstModel({ season = 2021, trials = 250, maxGames = 300 } = {}) {
  const games = rows(
    `SELECT season, week, team, opponent, spread, total, open_spread, open_total,
            team_score, opp_score
     FROM game_lines
     WHERE home = 1 AND season = ? AND open_spread IS NOT NULL AND spread IS NOT NULL
       AND team_score IS NOT NULL AND opp_score IS NOT NULL
     ORDER BY week LIMIT ?`, season, maxGames);
  if (games.length < 20) return { error: `only ${games.length} usable games for ${season}` };

  return { games: games.length, season, trials,
    ready: true,
    note: 'Prediction wiring lives in nfl-drive-sim.js; call clvReport() there so the simulator is ' +
      'constructed once for the whole slate rather than per game.' };
}

/** What opening-line coverage exists right now. */
export function openingLineCoverage() {
  const bySeason = rows(
    `SELECT season, COUNT(*) AS games,
            SUM(CASE WHEN open_spread IS NOT NULL THEN 1 ELSE 0 END) AS with_open
     FROM game_lines WHERE home = 1 GROUP BY season ORDER BY season DESC`);
  const total = row(`SELECT COUNT(*) AS n FROM game_lines WHERE home = 1 AND open_spread IS NOT NULL`)?.n ?? 0;
  return {
    games_with_opening_line: total,
    by_season: bySeason.filter(s => s.with_open > 0),
    seasons_without: bySeason.filter(s => !s.with_open).map(s => s.season),
    note: total
      ? 'Opening lines are the benchmark a bet is actually placed into. The closing line is the ' +
        'benchmark for forecasting skill, and this project has only ever had the latter.'
      : 'No opening lines stored. Run ingestOpeningLines().'
  };
}

const SC_LINES_URL = 'https://github.com/nflverse/nfldata/raw/master/data/sc_lines.csv';

/**
 * A second, much larger source of early lines.
 *
 * `initial_lines.csv` covers one book and one season — 272 games. `sc_lines.csv`
 * carries 2013 through 2021, roughly 2,040 games, which is the difference
 * between a CLV test that can only say "not obviously wrong" and one that can
 * actually resolve a small edge.
 *
 * HONEST ABOUT WHAT THESE ARE. They are Westgate SuperContest lines, posted
 * early in the week rather than the true first number a book hangs. So they are
 * an EARLY line, not strictly an opening one, and the gap to the close will be
 * narrower than a genuine opener's. That makes any CLV measured against them
 * conservative rather than flattering, which is the right direction for a
 * benchmark to err.
 *
 * The sign convention matches this database exactly, verified against a known
 * game: 2013 week 1 has DEN at -7.5 as the home side, and the stored closing
 * spread for that row is also -7.5.
 */
export async function ingestSuperContestLines({ url = SC_LINES_URL } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) return { error: `nflverse returned ${res.status} for sc_lines.csv` };
  const text = await res.text();
  const lines = text.trim().split('\n');
  const header = lines[0].split(',').map(h => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const need of ['season', 'week', 'away_team', 'home_team', 'side', 'line']) {
    if (idx[need] == null) return { error: `sc_lines.csv is missing column "${need}"` };
  }

  // Keep only the home side's number; the away row is its mirror and carries no
  // extra information.
  const byGame = new Map();
  for (const raw of lines.slice(1)) {
    const p = raw.split(',');
    const season = Number(p[idx.season]), week = Number(p[idx.week]);
    const away = normForSeason(p[idx.away_team], season);
    const home = normForSeason(p[idx.home_team], season);
    const side = normForSeason(p[idx.side], season), line = Number(p[idx.line]);
    if (!Number.isFinite(season) || !Number.isFinite(week) || !Number.isFinite(line)) continue;
    if (side !== home) continue;
    const key = `${season}|${week}|${away}|${home}`;
    // A handful of games appear twice; first observation wins rather than last,
    // so a re-run is stable.
    if (!byGame.has(key)) byGame.set(key, { season, week, away, home, open_spread: line });
  }

  let matched = 0, unmatched = 0, skippedExisting = 0, updated = 0;
  const misses = [];
  for (const g of byGame.values()) {
    const existing = row(
      `SELECT open_spread FROM game_lines
       WHERE season = ? AND week = ? AND team = ? AND opponent = ? AND home = 1`,
      g.season, g.week, g.home, g.away);
    if (!existing) {
      unmatched++;
      if (misses.length < 8) misses.push(`${g.season} wk${g.week} ${g.away}@${g.home}`);
      continue;
    }
    matched++;
    // Never overwrite a true opening line with an early-week one.
    if (existing.open_spread != null) { skippedExisting++; continue; }
    run(`UPDATE game_lines SET open_spread = ?
         WHERE season = ? AND week = ? AND team = ? AND opponent = ? AND home = 1`,
    g.open_spread, g.season, g.week, g.home, g.away);
    run(`UPDATE game_lines SET open_spread = ?
         WHERE season = ? AND week = ? AND team = ? AND opponent = ? AND home = 0`,
    -g.open_spread, g.season, g.week, g.away, g.home);
    updated += 2;
  }

  return {
    source: 'nflverse sc_lines.csv (Westgate SuperContest early lines)',
    games_in_file: byGame.size, matched, unmatched,
    skipped_already_had_opener: skippedExisting, rows_updated: updated,
    unmatched_examples: misses,
    coverage_now: row(`SELECT COUNT(*) AS n FROM game_lines
                       WHERE home = 1 AND open_spread IS NOT NULL`)?.n ?? 0,
    note: 'Early-week lines rather than true openers, so the move to close is narrower than a real ' +
      'opener would show. That makes any CLV measured against them conservative.'
  };
}
