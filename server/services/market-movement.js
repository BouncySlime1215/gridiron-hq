/** Price/line movement diagnostics. Forecasts are labelled hypotheses, never edge. */
import { rows } from '../db/index.js';
import { polymarketMovement } from './polymarket-lines.js';

const r3 = n => n == null || !Number.isFinite(n) ? null : +n.toFixed(3);
const elapsedHours = (a, b) => Math.max((new Date(b) - new Date(a)) / 3600000, 1 / 60);

export function nflMarketMovement() {
  const groups = rows(`SELECT event_id,home_team,away_team,commence_time,market,side,
    COUNT(DISTINCT captured_at) captures,MIN(captured_at) first_at,MAX(captured_at) last_at
    FROM nfl_line_snapshots GROUP BY event_id,market,side HAVING COUNT(DISTINCT captured_at) >= 2
    ORDER BY last_at DESC LIMIT 60`);
  const moves = groups.map(g => {
    const q = rows(`SELECT captured_at,line,price FROM nfl_line_snapshots WHERE event_id=? AND market=? AND side=? ORDER BY captured_at`, g.event_id,g.market,g.side);
    const first = q[0], last = q.at(-1), hours = elapsedHours(first.captured_at,last.captured_at);
    const lineVelocity = first.line != null && last.line != null ? (last.line-first.line)/hours : null;
    return { event_id:g.event_id, matchup:`${g.away_team} at ${g.home_team}`, market:g.market, side:g.side, captures:g.captures,
      first_at:g.first_at,last_at:g.last_at, opening_line:first.line, latest_line:last.line, opening_price:first.price,latest_price:last.price,
      line_change:r3(first.line == null || last.line == null ? null : last.line-first.line), price_change:first.price == null || last.price == null ? null : last.price-first.price,
      line_velocity_per_hour:r3(lineVelocity), projected_close_line: r3(last.line == null || lineVelocity == null ? null : last.line + lineVelocity * Math.min(24, Math.max(0,(new Date(g.commence_time)-new Date(last.captured_at))/3600000))),
      label:'descriptive only; projected close is a linear extrapolation, not a betting signal' };
  });
  const total = rows('SELECT COUNT(*) n,COUNT(DISTINCT captured_at) captures FROM nfl_line_snapshots')[0];
  // Polymarket is the primary movement source: an exchange-priced implied line
  // every thirty minutes, independent of any sportsbook feed or credit.
  let polymarket = null;
  try { polymarket = polymarketMovement({ hours: 168, limit: 40 }); } catch (error) { polymarket = { error: error.message }; }
  return { available:moves.length>0 || (polymarket?.games ?? 0) > 0, quotes:total?.n??0,captures:total?.captures??0,moves,
    polymarket,
    note:moves.length ? 'Movement is based on stored timestamped prices. It cannot be used until sufficient forward closing outcomes accumulate.' : 'Book snapshots: awaiting at least two real-price captures of the same market side. Polymarket implied lines are reported above regardless.' };
}

export function mlbMarketMovement() {
  const groups = rows(`SELECT game_pk,market,selection,side,line,COUNT(DISTINCT captured_at) captures,
    MIN(captured_at) first_at,MAX(captured_at) last_at FROM mlb_market_quotes
    GROUP BY game_pk,market,selection,side,line HAVING COUNT(DISTINCT captured_at)>=2 ORDER BY last_at DESC LIMIT 60`);
  const moves = groups.map(g => {
    const q = rows(`SELECT captured_at,price FROM mlb_market_quotes WHERE game_pk=? AND market=? AND selection=? AND side=? AND COALESCE(line,-999)=COALESCE(?,-999) ORDER BY captured_at`,g.game_pk,g.market,g.selection,g.side,g.line);
    const first=q[0],last=q.at(-1);
    return { game_pk:g.game_pk,market:g.market,selection:g.selection,side:g.side,line:g.line,captures:g.captures,first_at:g.first_at,last_at:g.last_at,
      opening_price:first.price,latest_price:last.price,price_change:first.price == null || last.price == null ? null : last.price-first.price,
      label:'descriptive only; requires a real quoted market' };
  });
  const total=rows('SELECT COUNT(*) n,COUNT(DISTINCT captured_at) captures FROM mlb_market_quotes')[0];
  return { available:moves.length>0,quotes:total?.n??0,captures:total?.captures??0,moves,
    note:moves.length ? 'Movement reflects preserved MLB quotes only.' : 'Awaiting real MLB quotes and at least two snapshots per selection.' };
}
