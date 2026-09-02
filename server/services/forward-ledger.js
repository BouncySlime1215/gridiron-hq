/**
 * The only test left.
 *
 * The football-first model has now been measured three separate ways against
 * history, and every one lands in the same place:
 *
 *   Per-season fit, held out on 2024-25    57.9%  z =  0.83  n =  57
 *   Per-season fit, held out on 2021-25    48.4%  z = -1.26  n = 242
 *   Weekly walk-forward, refit each week   48.0%  z = -1.16  n = 177
 *
 * Directionally suggestive, never significant, and the one time it looked
 * convincing it collapsed as soon as the sample widened. That is not a model
 * that needs another backtest; it is a model whose backtest has been used up.
 * Every remaining slice of 2021-25 has been looked at, and looking again only
 * buys more chances to find a lucky one.
 *
 * So this records predictions BEFORE the games happen. A forward ledger is the
 * only evidence that cannot be retrofitted, re-sliced or accidentally fitted:
 * the row exists, timestamped, with its reasoning frozen, and then the game is
 * played. Nothing about the outcome can flow backwards into how the pick was
 * made.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT WILL TAKE, STATED NOW RATHER THAN LATER
 *
 * At a 3-point edge over the -110 break-even — 55.4%, which would be an
 * excellent result — proving it at 95% confidence needs roughly 1,065 settled
 * bets. At a 5-point edge, 384. A season produces a few hundred qualifying
 * games, so this answers in one to three seasons and not sooner. Any claim of
 * profitability before then is a claim about a sample too small to carry it, and
 * the ledger reports the required sample alongside the running record so the
 * gap is always visible.
 *
 * CLOSING LINE VALUE IS THE FASTER SIGNAL. Whether a pick beat the number it was
 * placed at converges far quicker than whether it won, because it is measured
 * against a price rather than against a coin flip. A model with no edge shows no
 * CLV within weeks; one with an edge shows it long before the win rate is
 * conclusive. Both are tracked, and CLV is the one to watch first.
 */
import { rows, row, run } from '../db/index.js';
import { nflKickoffDate } from './date-util.js';

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const BREAK_EVEN = 0.5238;

run(`CREATE TABLE IF NOT EXISTS forward_picks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at   TEXT NOT NULL,
  season        INTEGER NOT NULL,
  week          INTEGER NOT NULL,
  home          TEXT NOT NULL,
  away          TEXT NOT NULL,
  market        TEXT NOT NULL,
  side          TEXT NOT NULL,
  line_at_pick  REAL,
  price_at_pick INTEGER,
  source        TEXT NOT NULL,
  lean          REAL,
  confidence    REAL,
  leading_reason TEXT,
  reasoning     TEXT,
  features      TEXT,
  -- Settled later, never at insert.
  closing_line  REAL,
  actual_margin REAL,
  actual_total  REAL,
  result        TEXT,
  clv_points    REAL,
  settled_at    TEXT
)`);
run(`CREATE UNIQUE INDEX IF NOT EXISTS forward_picks_unique
     ON forward_picks (season, week, home, away, market, source)`);

/**
 * Record a pick before the game.
 *
 * Refuses to record one for a game that has already been played. That is the
 * whole integrity of the ledger: a "forward" pick entered after kickoff is not
 * evidence of anything, and nothing downstream could tell the difference.
 */
export function recordForwardPick(input = {}) {
  const { season, week, home, away, market = 'spread', side,
    line, price = -110, source = 'football-first',
    lean = null, confidence = null, leadingReason = null,
    reasoning = null, features = null, recordedAt = null } = input;

  if (!season || !week || !home || !away || !side) {
    return { error: 'season, week, home, away and side are all required' };
  }
  if (market !== 'spread' && market !== 'total') return { error: 'market must be spread or total' };
  if (market === 'spread' && side !== home && side !== away) {
    return { error: 'a spread side must match the scheduled home or away team' };
  }
  if (market === 'total' && !/^(over|under)$/i.test(side)) {
    return { error: 'a total side must be over or under' };
  }
  if (line != null && !Number.isFinite(Number(line))) return { error: 'line must be numeric' };

  const game = row(
    `SELECT team_score, opp_score, gameday, gametime FROM game_lines
     WHERE season = ? AND week = ? AND team = ? AND home = 1`, season, week, home);
  if (!game) return { error: 'no matching scheduled game is loaded' };
  const now = recordedAt == null ? new Date() : new Date(recordedAt);
  if (Number.isNaN(now.getTime())) return { error: 'recordedAt must be a valid timestamp' };
  const kickoff = nflKickoffDate(game?.gameday, game?.gametime);
  if (game?.team_score != null || (kickoff && now >= kickoff)) {
    return { error: 'that game has already been played',
      note: 'A forward pick recorded at or after kickoff is not forward. The ledger refuses it ' +
        'rather than accepting a row nothing downstream could distinguish from a real one.' };
  }

  const nowIso = now.toISOString();
  try {
    run(`INSERT INTO forward_picks
         (recorded_at, season, week, home, away, market, side, line_at_pick, price_at_pick,
          source, lean, confidence, leading_reason, reasoning, features)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    nowIso, season, week, home, away, market, side, line ?? null, price ?? null,
    source, lean, confidence, leadingReason,
    reasoning ? String(reasoning).slice(0, 4000) : null,
    features ? JSON.stringify(features) : null);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return { error: 'a pick for this game from this source is already recorded',
        note: 'Append-only by design. Overwriting a recorded prediction would let a bad one be ' +
          'quietly replaced, which is the failure this ledger exists to make impossible.' };
    }
    throw e;
  }
  return { ok: true, recorded_at: nowIso, season, week, matchup: `${away} at ${home}`, side, source };
}

/**
 * Settle everything that has a result and does not yet have a grade.
 *
 * Closing line value is computed where a closing number is available: the
 * difference between the number the pick was placed at and the number the market
 * settled on, signed so positive always means the pick got the better of it.
 */
export function settleForwardPicks() {
  const open = rows(`SELECT * FROM forward_picks WHERE result IS NULL`);
  let settled = 0;
  for (const p of open) {
    const g = row(
      `SELECT spread, total, team_score, opp_score FROM game_lines
       WHERE season = ? AND week = ? AND team = ? AND home = 1`, p.season, p.week, p.home);
    // Both scores, or nothing: a half-ingested final would grade as NaN → 'Lost'.
    if (!g || g.team_score == null || g.opp_score == null) continue;

    const actualMargin = g.team_score - g.opp_score;
    const actualTotal = g.team_score + g.opp_score;
    const backedHome = p.side === p.home;
    const closing = p.market === 'total' ? g.total : (backedHome ? g.spread : -g.spread);

    let result;
    let clv = null;
    if (p.market === 'total') {
      const over = /over/i.test(p.side);
      const line = p.line_at_pick ?? g.total;
      result = actualTotal === line ? 'Push' : (actualTotal > line) === over ? 'Won' : 'Lost';
      if (p.line_at_pick != null && g.total != null) {
        clv = over ? g.total - p.line_at_pick : p.line_at_pick - g.total;
      }
    } else {
      const line = p.line_at_pick != null ? p.line_at_pick : closing;
      const sideMargin = backedHome ? actualMargin : -actualMargin;
      const cover = sideMargin + line;
      result = cover === 0 ? 'Push' : cover > 0 ? 'Won' : 'Lost';
      if (p.line_at_pick != null && closing != null) {
        // A larger handicap is always better for the backed team: -3 beats a
        // close of -4, and +4 beats a close of +3.
        clv = p.line_at_pick - closing;
      }
    }

    run(`UPDATE forward_picks SET closing_line = ?, actual_margin = ?, actual_total = ?,
         result = ?, clv_points = ?, settled_at = ? WHERE id = ?`,
    closing, actualMargin, actualTotal, result, r3(clv), new Date().toISOString(), p.id);
    settled++;
  }
  return { settled, still_open: open.length - settled };
}

/**
 * The running record, with the distance to a conclusion stated rather than
 * implied.
 */
export function forwardLedger({ source = null, season = null } = {}) {
  const where = [];
  const args = [];
  if (source) { where.push('source = ?'); args.push(source); }
  if (season) { where.push('season = ?'); args.push(season); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const all = rows(`SELECT * FROM forward_picks ${clause} ORDER BY recorded_at DESC`, ...args);
  const decided = all.filter(p => p.result === 'Won' || p.result === 'Lost');
  const wins = decided.filter(p => p.result === 'Won').length;
  const n = decided.length;
  const rate = n ? wins / n : null;
  const se = n ? Math.sqrt(BREAK_EVEN * (1 - BREAK_EVEN) / n) : null;
  const z = n ? (rate - BREAK_EVEN) / se : null;

  const withClv = decided.filter(p => p.clv_points != null);
  const meanClv = withClv.length
    ? withClv.reduce((s, p) => s + p.clv_points, 0) / withClv.length : null;
  const beatClose = withClv.filter(p => p.clv_points > 0).length;

  // How many more settled bets before a real edge of a given size is provable.
  const needed = edge => Math.ceil(Math.pow(1.96 * Math.sqrt(BREAK_EVEN * (1 - BREAK_EVEN)) / edge, 2));

  return {
    source: source ?? 'all sources',
    open: all.filter(p => p.result == null).length,
    settled: n,
    pushes: all.filter(p => p.result === 'Push').length,
    record: n ? `${wins}-${n - wins}` : null,
    win_rate: r3(rate),
    break_even: BREAK_EVEN,
    vs_break_even_pp: rate == null ? null : r3((rate - BREAK_EVEN) * 100),
    z: r3(z),
    significant: z != null && Math.abs(z) >= 1.96,
    clv: withClv.length ? {
      n: withClv.length,
      mean_points: r3(meanClv),
      beat_close_rate: r3(beatClose / withClv.length),
      reading: meanClv > 0.1
        ? 'The picks are consistently getting a better number than the close, which is the earliest ' +
          'honest sign of an edge and converges far faster than a win rate.'
        : meanClv < -0.1
          ? 'The picks are consistently getting a worse number than the close. That is the market ' +
            'moving against them, and it is the earliest honest sign of no edge.'
          : 'No meaningful closing line value either way yet.'
    } : null,
    distance_to_proof: {
      settled_so_far: n,
      for_a_2pp_edge: needed(0.02),
      for_a_3pp_edge: needed(0.03),
      for_a_5pp_edge: needed(0.05),
      reading: n < 100
        ? `${n} settled. Nothing here is evidence yet — a 5-point edge needs ${needed(0.05)} bets ` +
          `to prove and a 3-point edge needs ${needed(0.03)}. Watch closing line value first; it ` +
          'answers much sooner.'
        : n < needed(0.05)
          ? `${n} settled of the ${needed(0.05)} a 5-point edge would need. Still short of proving ` +
            'even a large edge.'
          : `${n} settled, enough to detect a 5-point edge if one exists.`
    },
    recent: all.slice(0, 25).map(p => ({
      recorded_at: p.recorded_at, season: p.season, week: p.week,
      matchup: `${p.away} at ${p.home}`, side: p.side, market: p.market,
      line_at_pick: p.line_at_pick, closing_line: p.closing_line,
      lean: p.lean, confidence: p.confidence,
      leading_reason: p.leading_reason,
      result: p.result, clv_points: p.clv_points
    })),
    note: 'Append-only and timestamped before kickoff. This is the only evidence in the project that ' +
      'cannot be re-sliced after the fact, which is why it is the one that will decide the question.'
  };
}

/**
 * Log this week's football-first leans, so the ledger fills without anyone
 * remembering to do it.
 */
export async function recordThisWeek({ season, week, minLean = 1.0 } = {}) {
  const { footballFirstLean } = await import('./football-first.js');
  const { pickConfidence } = await import('./pick-confidence.js');

  const games = rows(
    `SELECT season, week, team home, opponent away, spread FROM game_lines
     WHERE season = ? AND week = ? AND home = 1 AND spread IS NOT NULL AND team_score IS NULL`,
    season, week);
  if (!games.length) {
    return { recorded: 0,
      note: `No unplayed games on record for ${season} week ${week}. Picks are only recorded before ` +
        'kickoff, so a completed week produces nothing here by design.' };
  }

  const out = [];
  const abstained = [];
  const belowThreshold = [];
  for (const g of games) {
    let lean;
    try { lean = footballFirstLean(g.season, g.week, g.home, g.away); } catch { continue; }
    if (lean.error) { out.push({ matchup: `${g.away} at ${g.home}`, recorded: false, why: lean.error }); continue; }
    if (lean.abstains) {
      abstained.push({ matchup: `${g.away} at ${g.home}`, reason: lean.reason });
      continue;
    }
    if (lean.lean_points == null) continue;
    if (Math.abs(lean.lean_points) < minLean) {
      belowThreshold.push({ matchup: `${g.away} at ${g.home}`, lean: lean.lean_points });
      continue;
    }

    const conf = pickConfidence({
      season: g.season, market: 'spread',
      model_margin: (-g.spread) + lean.lean_points, market_margin: -g.spread
    }, { season: g.season });

    const res = recordForwardPick({
      season: g.season, week: g.week, home: g.home, away: g.away,
      market: 'spread', side: lean.side, line: lean.side === g.home ? g.spread : -g.spread,
      source: 'football-first',
      lean: lean.lean_points, confidence: conf.confidence,
      leadingReason: lean.leading_reason,
      reasoning: lean.leading_story,
      features: lean.contributions?.slice(0, 6)
    });
    out.push({ matchup: `${g.away} at ${g.home}`, side: lean.side,
      lean: lean.lean_points, confidence: conf.confidence,
      recorded: !!res.ok, why: res.error ?? null });
  }

  return {
    season, week,
    considered: games.length,
    recorded: out.filter(x => x.recorded).length,
    skipped: out.filter(x => !x.recorded).length,
    // Reported rather than swallowed. "16 considered, 0 recorded" with no reason
    // is indistinguishable from a broken pipeline.
    abstained: abstained.length,
    below_threshold: belowThreshold.length,
    why_nothing_recorded: out.length === 0 && abstained.length
      ? abstained[0].reason
      : out.length === 0 && belowThreshold.length
        ? `All ${belowThreshold.length} games produced a lean under the ${minLean}-point threshold. ` +
          'The model has an opinion but not a strong enough one to record.'
        : null,
    picks: out
  };
}
