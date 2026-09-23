/**
 * TM-09: market prices from real trades, and a hype index.
 *
 * Reads the aggregate table `server/data/trade-market/tm09-market-prices.json`,
 * written by `scripts/rnd/tm09_market_prices.py` from the local Sleeper trade
 * corpus (2-team, no-pick trade sides, 2021-2024; no 2025 trade is read and the
 * value curves are fit on 2021-2024 only, so no 2025 outcome enters a value).
 * Pre-registration: docs/tdd/2026-09-23-tm-09-market-prices.prereg.md.
 *
 * Units: points above replacement per game (PAR/g) in league scoring.
 *   value = our value at trade time (the study's consensus forecast minus replacement)
 *   price = the package paid for the player, in the same units
 *   hype  = price - value; positive = the market paid more than our value.
 *           In player_weeks rows price and value are medians over that week's
 *           trades and hype is their difference; cells.median_hype is the
 *           median of per-trade (price - value), a different aggregate.
 *
 * What this is NOT: a live market price. The app's live crowd value is
 * FantasyCalc `dynasty_values` (written by syncDynastyValues,
 * server/routes/aggregates.js:130). This table is historical revealed prices and
 * a position x week x league-size price-to-value ratio. No served trade number
 * reads it yet (default-off, "unconfirmed forward": no 2026 trade prices exist).
 *
 * Hype producers (one concept, three numbers that cannot be put on one input):
 *   - this table: trade price minus our consensus value, 2021-2024 trades;
 *   - server/routes/players.js:139 heuristicVerdict: FantasyCalc 30-day value
 *     momentum, live 2026;
 *   - server/services/waiver-brain.js:452 sellHigh: live 2026 FantasyCalc value
 *     above the league's per-position value-vs-projection curve.
 * The two live ones price 2026 players; this table has no 2026 row, so no
 * player-week exists where all three can be compared. Unification is AI-04.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TABLE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '../data/trade-market/tm09-market-prices.json');

/** Week bins from the pre-registration: 1-4, 5-8, 9-12, 13+. */
export function weekBin(week) {
  const w = Number(week);
  return w <= 4 ? '1-4' : w <= 8 ? '5-8' : w <= 12 ? '9-12' : '13+';
}

/** League-size bins from the pre-registration: <=10, 11-13 ("12"), >=14. */
export function sizeBin(teams) {
  const n = Number(teams);
  return n <= 10 ? 'le10' : n <= 13 ? '12' : 'ge14';
}

let cached = null;
/**
 * The committed table, or null when the file is absent (table_absent). Any
 * other read or parse error throws: a corrupt table is a fault, not an absence.
 */
export function loadMarketTable(file = TABLE_PATH) {
  if (file === TABLE_PATH && cached) return cached;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
  const doc = JSON.parse(text);
  if (file === TABLE_PATH) cached = doc;
  return doc;
}

/**
 * The market's price-to-value ratio for a position at a week and league size.
 * Served as a number only when the pre-registered held-out rule (H1) passed.
 */
export function marketPremium(table, { pos, week, teams }) {
  const wb = weekBin(week);
  const sb = sizeBin(teams);
  const base = { week_bin: wb, size_bin: sb, pos: pos ?? null };
  if (!table) return { ...base, available: false, price_to_value: null, source: null, n: 0, reason: 'table_absent' };
  if (table.results?.h1?.passed !== true) {
    return { ...base, available: false, price_to_value: null, source: null, n: 0,
      reason: 'the price model failed its pre-registered held-out rule (H1), so no ratio is served' };
  }
  const cell = (table.cells ?? []).find(c => c.pos === pos && c.week_bin === wb && c.size_bin === sb);
  if (cell && cell.price_to_value != null) {
    return { ...base, available: true, price_to_value: cell.price_to_value, source: 'cell', n: cell.n,
      median_hype: cell.median_hype ?? null, reason: null };
  }
  const posRatio = table.position_price_to_value?.[pos];
  if (posRatio != null) {
    return { ...base, available: true, price_to_value: posRatio, source: 'position', n: cell?.n ?? 0,
      median_hype: cell?.median_hype ?? null, reason: null };
  }
  return { ...base, available: false, price_to_value: null, source: null, n: 0, reason: 'no_cell_or_position_ratio' };
}

/** The player's historical per-week market rows (aggregates of >= 3 trades), oldest first. */
export function playerMarketHistory(table, sleeperId) {
  if (!table) return { available: false, reason: 'table_absent', rows: [] };
  if (sleeperId == null || sleeperId === '') return { available: false, reason: 'no_sleeper_id', rows: [] };
  const id = String(sleeperId);
  const rows = (table.player_weeks ?? [])
    .filter(r => r.sleeper_id === id)
    .sort((a, b) => a.season - b.season || a.week - b.week);
  if (!rows.length) return { available: false, reason: 'no_player_week_with_n_ge_3', rows: [] };
  return { available: true, reason: null, rows };
}

export const OTHER_HYPE_PRODUCERS = [
  { where: 'server/routes/players.js:139 heuristicVerdict', what: 'FantasyCalc 30-day value momentum', seasons: 'live 2026' },
  { where: 'server/services/waiver-brain.js:452 sellHigh', what: 'FantasyCalc value above the league per-position value-vs-projection curve', seasons: 'live 2026' },
];

/** The route payload for one player in one league. */
export function marketForPlayer({ player, week, teams }, table = loadMarketTable()) {
  const h2 = table?.results?.h2?.next4 ?? null;
  return {
    player: { id: player.id, name: player.name, position: player.position, sleeper_id: player.sleeper_id ?? null },
    week,
    league_size: teams ?? null,
    status: 'unconfirmed forward',
    default_off: true,
    units: table?.meta?.units ?? null,
    sign: table?.meta?.sign ?? null,
    seasons: table?.meta?.seasons ?? null,
    premium: marketPremium(table, { pos: player.position, week, teams }),
    history: playerMarketHistory(table, player.sleeper_id),
    hype_decay: h2 ? { c: h2.c, c_ci: h2.c_ci ? { lo: h2.c_ci.lo, hi: h2.c_ci.hi } : null,
      c_placebo: h2.placebo?.c_mean ?? null,
      c_minus_placebo: h2.c_minus_placebo ?? null,
      price_coef_given_value: h2.price_coef_given_value
        ? { coef: h2.price_coef_given_value.coef, lo: h2.price_coef_given_value.lo, hi: h2.price_coef_given_value.hi } : null,
      reading: 'c is the pre-registered slope of (next-4-game PAR/g minus our value) on hype. It is not a clean share: '
        + 'a shuffled price with no market information gets c_placebo, because hype and the outcome share our value. '
        + 'price_coef_given_value is what one PAR/g of price adds to next-4-game PAR/g once our value is held fixed '
        + '(0 = the price tells you nothing beyond our value).' } : null,
    other_hype_producers: OTHER_HYPE_PRODUCERS,
    note: 'Historical revealed prices from real trades (2021-2024), not the live FantasyCalc market value the Trade Lab '
      + 'uses. The live hype signals (players.js heuristicVerdict, waiver-brain sellHigh) price 2026 players and are not comparable row for row.',
  };
}
