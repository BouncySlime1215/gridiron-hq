/**
 * S-19: the one hype producer.
 *
 * "Hype" is price minus value: how much more the market pays for a player than
 * our value of him. Every surface that says anything about hype or selling high
 * calls `playerHype` and passes its result through unchanged:
 *   - POST /api/players/:id/analyze (server/routes/players.js), both branches;
 *   - waiverBrain `sellHigh` (server/services/waiver-brain.js);
 *   - GET /api/trades/:leagueId/market/:playerId (server/routes/trades.js).
 * test/hype-one-producer.test.js pins that they return the same value.
 *
 * Why TM-09 is the producer: it is the only one of the three with a held-out
 * test (docs/tdd/2026-09-23-tm-09-market-prices.prereg.md, H1 passed). The two
 * it replaced were untested heuristics: players.js heuristicVerdict (FantasyCalc
 * 30-day momentum, > +5% = SELL) and sellHigh's per-position price curve. On the
 * same rostered players they disagreed outright (docs/tdd/2026-09-23-s19-one-hype-producer.tdd.md).
 *
 * Source: TM-09's table (server/data/trade-market/tm09-market-prices.json via
 * trade-market.js#loadMarketTable), player-week medians of revealed Sleeper
 * trade prices, units PAR/g. Only a row from the CURRENT season, at or before
 * the current week, is served: a 2024 price is not a 2026 hype. The table has no
 * 2026 row today, so every live player reads `available: false` with the reason.
 *
 * Default-off: TM-09 has no forward (2026) test ("unconfirmed forward"), so no
 * SELL/BUY call is made from hype. `verdict` is always null until a forward test
 * passes; the field exists so a surface never invents its own call.
 */
import { loadMarketTable } from './trade-market.js';
import { tradeWeekContext } from './trade-engine.js';

export const HYPE_PRODUCER = 'server/services/hype.js#playerHype';

/**
 * One player's hype this season, or the reason there is none.
 * Season and week come from tradeWeekContext() so every surface reads the same row.
 */
export function playerHype({ sleeperId }, table = loadMarketTable()) {
  const { season, week } = tradeWeekContext();
  const base = {
    producer: HYPE_PRODUCER,
    source: 'TM-09 revealed trade prices (Sleeper public-league trades)',
    units: table?.meta?.units ?? null,
    sign: 'hype = price - value; positive = the market pays more than our value',
    status: 'unconfirmed forward',
    default_off: true,
    verdict: null,
    verdict_reason: 'No SELL/BUY call is made from hype: TM-09 has no forward (2026) test.',
    as_of: { season, week },
  };
  const none = reason => ({ ...base, available: false, hype: null, price: null, value: null,
    season: null, week: null, n: 0, reason });
  if (!table) return none('table_absent');
  if (sleeperId == null || sleeperId === '') return none('no_sleeper_id');
  const id = String(sleeperId);
  let hit = null;
  for (const r of table.player_weeks ?? []) {
    if (r.sleeper_id !== id || r.season !== season || r.week > week) continue;
    if (!hit || r.week > hit.week) hit = r;
  }
  if (!hit) {
    return none(`no revealed trade price for this player in ${season} (the TM-09 table covers `
      + `${(table.meta?.seasons ?? []).join(', ') || 'no season'})`);
  }
  return { ...base, available: true, hype: hit.hype, price: hit.price, value: hit.value,
    season: hit.season, week: hit.week, n: hit.n, reason: null };
}
