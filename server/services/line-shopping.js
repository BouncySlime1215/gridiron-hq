/**
 * Line shopping — the one edge that does not require out-predicting anyone.
 *
 * Every model in this project is trying to beat a market that already knows
 * everything we know. That is a hard fight, and the replay shows we lose it.
 * Line shopping is a different kind of edge entirely: when one book has a game
 * at -3 and another has it at -2.5, the half point is free. You are not
 * predicting better than the market, you are just refusing to accept the worst
 * available price.
 *
 * The size of it is not small. Half a point on an NFL spread is worth roughly
 * 1.5-2% of expected return, and the difference between -110 and -105 on the
 * same side is about 2.3% by itself. Both are larger than the edge the model
 * was chasing, and neither depends on being right about football.
 *
 * This is also the honest answer to "make the model profitable": the model may
 * never beat the closing line, but always taking the best of nine books is
 * arithmetic, not forecasting.
 */
import { rows, run, db } from '../db/index.js';
import { hasKey, gameOdds } from './odds-api.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_line_snapshots (
    captured_at TEXT NOT NULL, event_id TEXT NOT NULL,
    commence_time TEXT, home_team TEXT, away_team TEXT,
    book TEXT NOT NULL, market TEXT NOT NULL,
    side TEXT, line REAL, price INTEGER,
    PRIMARY KEY (captured_at, event_id, book, market, side)
  );
  CREATE INDEX IF NOT EXISTS idx_lines_event ON nfl_line_snapshots(event_id, market);
`);

const americanToProb = o => (o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100));
const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

/**
 * Pulls every book's current number for the slate and records a snapshot.
 *
 * Snapshots are what make closing line value measurable later: with a stored
 * history of where a number opened and where it closed, whether a pick beat the
 * close becomes a fact rather than a guess. That matters because CLV tells you
 * whether you have edge in about fifty bets, where win rate needs a thousand.
 */
export async function snapshotLines({ markets = 'h2h,spreads,totals' } = {}) {
  if (!hasKey()) return { error: 'no ODDS_API_KEY configured' };
  // Every market costs a credit per call, so a scheduled capture asks for only
  // the two it needs. h2h is worth a credit on demand, not twice a day forever.
  const data = await gameOdds({ markets, ttlMs: 0 });
  if (!data) return { error: 'odds fetch returned nothing (quota, or no slate posted)' };

  const at = new Date().toISOString();
  let n = 0;
  for (const ev of data) {
    for (const b of ev.bookmakers ?? []) {
      for (const m of b.markets ?? []) {
        for (const o of m.outcomes ?? []) {
          run(`INSERT INTO nfl_line_snapshots
              (captured_at, event_id, commence_time, home_team, away_team, book, market, side, line, price)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT DO NOTHING`,
            at, ev.id, ev.commence_time, ev.home_team, ev.away_team,
            b.key, m.key, o.name, o.point ?? null, o.price ?? null);
          n++;
        }
      }
    }
  }
  // The shopping board memoises the latest simultaneous quote set per market.
  // A fresh capture is exactly the event that makes that memo wrong, so drop it
  // here rather than relying on a TTL that would serve a stale board in the
  // window right after a snapshot — the one moment the board matters most.
  const { clearShoppingBoardCache } = await import('./nfl-shopping-board.js');
  clearShoppingBoardCache();

  return { captured_at: at, games: data.length, quotes: n };
}

/**
 * The best available number on every side of every game, and what taking it is
 * worth against the worst number on offer.
 *
 * `edge_vs_worst` is the honest measure of what shopping saves: the difference
 * in implied probability between the best and worst price for the identical
 * bet. It is pure arithmetic — no model, no forecast.
 */
export async function shopSlate({ live = true } = {}) {
  if (!hasKey()) return { error: 'no ODDS_API_KEY configured' };
  const data = live ? await gameOdds({ markets: 'h2h,spreads,totals' }) : null;
  if (!data) return { error: 'no odds available' };

  const out = [];
  for (const ev of data) {
    const byKey = new Map(); // market|side -> quotes[]
    for (const b of ev.bookmakers ?? []) {
      for (const m of b.markets ?? []) {
        for (const o of m.outcomes ?? []) {
          // Spreads and totals must be compared at the same number, otherwise
          // "best price" would just pick whoever hung the worst line.
          const key = [m.key, o.name, o.point ?? ''].join('|');
          const arr = byKey.get(key) ?? [];
          arr.push({ book: b.key, price: o.price, line: o.point ?? null });
          byKey.set(key, arr);
        }
      }
    }

    for (const [key, quotes] of byKey) {
      if (quotes.length < 2) continue;
      const [market, side, point] = key.split('|');
      const best = quotes.reduce((a, b) => (b.price > a.price ? b : a));
      const worst = quotes.reduce((a, b) => (b.price < a.price ? b : a));
      if (best.price === worst.price) continue;
      out.push({
        matchup: `${ev.away_team} at ${ev.home_team}`,
        commence_time: ev.commence_time,
        market, side, line: point === '' ? null : Number(point),
        best_book: best.book, best_price: best.price,
        worst_book: worst.book, worst_price: worst.price,
        books_quoting: quotes.length,
        // What the better price is worth, in implied probability.
        edge_vs_worst: r3(americanToProb(worst.price) - americanToProb(best.price)),
        all_quotes: quotes.sort((a, b) => b.price - a.price)
      });
    }
  }

  out.sort((a, b) => (b.edge_vs_worst ?? 0) - (a.edge_vs_worst ?? 0));
  return {
    games: data.length,
    opportunities: out,
    note: 'edge_vs_worst is the implied-probability gain from taking the best available price instead of the worst, for the identical bet. It requires no prediction — only refusing the worse number.'
  };
}

/**
 * Line spread across books on the same game — a different signal from price.
 *
 * When books disagree on the *number* rather than the price, one of them is
 * offering a materially different bet. A game hung at -3 in one shop and -2.5
 * in another is the classic case: on a key number like 3, that half point is
 * worth far more than the usual half point.
 */
export async function numberDisagreement() {
  if (!hasKey()) return { error: 'no ODDS_API_KEY configured' };
  const data = await gameOdds({ markets: 'spreads,totals' });
  if (!data) return { error: 'no odds available' };

  const out = [];
  for (const ev of data) {
    for (const market of ['spreads', 'totals']) {
      const nums = new Map(); // side -> [{book, line}]
      for (const b of ev.bookmakers ?? []) {
        const m = (b.markets ?? []).find(x => x.key === market);
        for (const o of m?.outcomes ?? []) {
          if (o.point == null) continue;
          const arr = nums.get(o.name) ?? [];
          arr.push({ book: b.key, line: o.point, price: o.price });
          nums.set(o.name, arr);
        }
      }
      for (const [side, arr] of nums) {
        if (arr.length < 2) continue;
        const lines = arr.map(x => x.line);
        const lo = Math.min(...lines), hi = Math.max(...lines);
        if (lo === hi) continue;
        // Crossing 3 or 7 matters far more than any other half point, because
        // that is where NFL margins actually cluster.
        const crossesKey = market === 'spreads' &&
          [3, 7].some(k => (Math.abs(lo) < k && Math.abs(hi) >= k) || (Math.abs(lo) <= k && Math.abs(hi) > k));
        out.push({
          matchup: `${ev.away_team} at ${ev.home_team}`,
          commence_time: ev.commence_time,
          market, side, best_line: hi, worst_line: lo, spread_of_numbers: r3(hi - lo),
          crosses_key_number: crossesKey,
          quotes: arr.sort((a, b) => b.line - a.line)
        });
      }
    }
  }
  out.sort((a, b) => (b.crosses_key_number ? 1 : 0) - (a.crosses_key_number ? 1 : 0)
    || b.spread_of_numbers - a.spread_of_numbers);
  return { games: data.length, disagreements: out };
}

/**
 * Closing line value on picks already recorded.
 *
 * CLV is the fastest honest read on whether a strategy has edge. If picks
 * consistently get a better number than the market closes at, profit follows
 * over time even when the short-run record looks bad — and if they do not, no
 * amount of good results proves anything.
 *
 * This needs snapshots to have been captured before kickoff, so it reports
 * honestly when there is not yet enough history rather than inventing a number.
 */
export function closingLineValue() {
  const snaps = rows(`SELECT COUNT(*) AS n, COUNT(DISTINCT captured_at) AS captures,
                             MIN(captured_at) AS first, MAX(captured_at) AS last
                      FROM nfl_line_snapshots`)[0];
  if (!snaps || snaps.captures < 2) {
    return {
      available: false,
      snapshots: snaps?.n ?? 0, captures: snaps?.captures ?? 0,
      note: 'Closing line value needs at least two snapshots of the same game — one when the bet was placed and one near kickoff. Capture lines regularly (POST /api/nfl-betting/lines/snapshot) and this becomes measurable within a week of games.'
    };
  }
  const moves = rows(`
    SELECT event_id, home_team, away_team, market, side,
           MIN(captured_at) AS first_at, MAX(captured_at) AS last_at
    FROM nfl_line_snapshots GROUP BY event_id, market, side`);
  return { available: true, tracked: moves.length, snapshots: snaps.n, window: [snaps.first, snaps.last] };
}
