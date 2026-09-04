/**
 * Auction-draft dollar values.
 *
 * Real, standard methodology (Footballguys "Draft Dollar Values", FantasySixpack,
 * DraftExpert Pro auction calculators):
 *   1. Convert each player's projection to Value Over Replacement (VOR) at their
 *      position. This app already computes exactly that in routes/edge.js's
 *      `vorBoard()` (projected points minus the last startable player at the
 *      position) — reused here rather than rebuilt.
 *   2. Restrict to the realistic room: as many players as there are total roster
 *      spots across every team (`teams * rounds`, since a snake draft's `rounds`
 *      is literally "how many players each team ends up with" — see drafts.rounds
 *      in server/db/index.js). Anyone outside that pool is a waiver-wire player,
 *      not an auction player.
 *   3. Reserve $1 per roster spot off the top for the "wire" tier — every real
 *      auction room has players who go for the minimum bid, which is why total
 *      spend is never simply proportional-to-VOR for every player (a replacement-
 *      level player has ~0 VOR but is never actually free). The remainder is
 *      scaled proportionally to VOR among VOR-positive players.
 *   4. Round to whole dollars with the largest-remainder method so the total
 *      assigned across the room is EXACTLY `teams * budget`, not just close to it
 *      after independent per-player rounding.
 *
 * Live inflation tracking during an actual auction:
 *   Inflation% = (Remaining $ in room / Remaining projected $ in room - 1) * 100
 * (same sources). As players sell for more or less than book value, everyone
 * left in the room gets more or less expensive — this is the number serious
 * auction drafters watch pick to pick.
 *
 * ESPN's own live-draft mirror (server/services/espn-draft.js) only captures a
 * snake-style pick stream — `draftDetail.picks` carries `playerId`/`teamId`/
 * `overallPickNumber`/`keeper`, no `bidAmount` field — confirmed by reading
 * fetchDraftDetail()'s actual consumers in that file before building this. There
 * is no existing sale-price feed to read from, so live-auction state (who's been
 * nominated/sold for how much) is tracked here rather than re-derived from
 * espn-draft.js, which stays snake-only on purpose.
 */
import { db, rows, row, run } from '../db/index.js';
import { vorBoard } from '../routes/edge.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS auction_sales (
    draft_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    team_slot INTEGER NOT NULL,
    price INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (draft_id, player_id)
  );
  CREATE TABLE IF NOT EXISTS auction_settings (
    draft_id INTEGER PRIMARY KEY,
    budget INTEGER NOT NULL,
    roster_size INTEGER NOT NULL
  );
`);

/**
 * Core scaling step shared by the book-value board and the live-inflation path:
 * given a VOR board and room shape, assign whole-dollar auction values that sum
 * to exactly `teams * budget` across the `poolSize` most valuable players.
 */
function scaleToRoom(board, { teams, budget, poolSize }) {
  const totalBudget = teams * budget;
  const pool = board.slice(0, Math.max(0, poolSize));
  const reserve = Math.min(totalBudget, pool.length); // $1 floor per roster spot
  const spendable = Math.max(0, totalBudget - reserve);
  const totalVor = pool.reduce((s, p) => s + Math.max(0, p.vor), 0);
  const perVorDollar = totalVor > 0 ? spendable / totalVor : 0;

  // Raw (fractional) dollar value per player, floor $1.
  const raw = pool.map(p => 1 + Math.max(0, p.vor) * perVorDollar);
  const floors = raw.map(Math.floor);
  let assigned = floors.reduce((s, n) => s + n, 0);
  let remainder = totalBudget - assigned;

  // Largest-remainder method: hand the leftover whole dollars (from flooring)
  // to whoever's fractional part was closest to rounding up, so the total comes
  // out exactly right instead of merely close after independent rounding.
  const order = raw.map((v, i) => ({ i, frac: v - floors[i] }))
    .sort((a, b) => b.frac - a.frac);
  const values = [...floors];
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
    values[order[k].i] += 1;
  }

  const valued = pool.map((p, i) => ({ ...p, auction_value: values[i] }));
  const outside = board.slice(poolSize).map(p => ({ ...p, auction_value: null }));
  return { valued, outside, total_budget: totalBudget };
}

/** Roster spots per team — `rounds` on a synced/mock draft IS the roster size. */
function teamsAndRosterSize(leagueId) {
  if (leagueId == null) return {};
  const lg = row('SELECT team_count FROM leagues WHERE id = ?', leagueId);
  const draft = row(`SELECT team_count, rounds FROM drafts WHERE league_row_id = ? ORDER BY id DESC LIMIT 1`, leagueId);
  return {
    teams: draft?.team_count ?? lg?.team_count ?? null,
    rosterSize: draft?.rounds ?? null
  };
}

/**
 * Book auction dollar values for every rosterable player, scaled to a real
 * budget: `teams` teams each with `budget` to spend (e.g. 12 * $200 = $2,400
 * total in the room). `rosterSize` (players per team) sets how big the
 * realistic auction pool is; defaults to a standard 16-man roster when the
 * league/draft can't supply one.
 */
export function auctionValues(leagueId, { budget = 200, teams, rosterSize } = {}) {
  const resolved = teamsAndRosterSize(leagueId);
  const finalTeams = teams ?? resolved.teams ?? 12;
  const finalRosterSize = rosterSize ?? resolved.rosterSize ?? 16;

  const board = vorBoard(finalTeams);
  const { valued, outside, total_budget } = scaleToRoom(board, {
    teams: finalTeams, budget, poolSize: finalTeams * finalRosterSize
  });

  return {
    teams: finalTeams, budget, roster_size: finalRosterSize, total_budget,
    players: valued.concat(outside).sort((a, b) => (b.auction_value ?? 0) - (a.auction_value ?? 0) || b.vor - a.vor)
  };
}

/** Configure (or reconfigure) the live auction room for a draft. Idempotent. */
export function initAuctionDraft(draftId, { budget = 200, rosterSize = 16 } = {}) {
  run(`INSERT INTO auction_settings (draft_id, budget, roster_size) VALUES (?,?,?)
       ON CONFLICT(draft_id) DO UPDATE SET budget = excluded.budget, roster_size = excluded.roster_size`,
    draftId, budget, rosterSize);
  return { draft_id: draftId, budget, roster_size: rosterSize };
}

/**
 * Record a player selling in a live/mock auction. Idempotent overwrite on the
 * same player (a corrected sale), same convention as draft_picks elsewhere.
 */
export function recordSale(draftId, playerId, teamSlot, price) {
  if (!Number.isFinite(price) || price < 1) throw Object.assign(new Error('price must be >= 1'), { status: 400 });
  run(`INSERT INTO auction_sales (draft_id, player_id, team_slot, price) VALUES (?,?,?,?)
       ON CONFLICT(draft_id, player_id) DO UPDATE SET team_slot = excluded.team_slot, price = excluded.price`,
    draftId, playerId, teamSlot, Math.round(price));
  return { ok: true };
}

/**
 * Live-inflation-adjusted board for an in-progress auction.
 *
 * Inflation% = (remaining $ in the room / remaining book $ in the room - 1) * 100.
 * A positive number means bargains happened (players sold for LESS than book),
 * leaving more spare cap chasing the same remaining value — so remaining prices
 * should run hot. A negative number means someone overpaid, leaving less cap
 * behind than the remaining value represents — remaining prices should run
 * cold. (Since total book value is scaled to equal the total cap exactly, this
 * is the mirror image of the more familiar "spent / value-drafted - 1" framing
 * some calculators use on players already taken — same real mechanic, read
 * from the remaining side of the room instead.) Every unsold player's live
 * price is their book value scaled by (1 + inflation%), floored at $1.
 */
export function liveAuctionValues(draftId) {
  const draft = row('SELECT * FROM drafts WHERE id = ?', draftId);
  if (!draft) throw Object.assign(new Error('draft not found'), { status: 404 });
  const settings = row('SELECT * FROM auction_settings WHERE draft_id = ?', draftId)
    ?? initAuctionDraft(draftId, {}); // sane defaults if the room was never configured

  const { players, total_budget } = auctionValues(draft.league_row_id, {
    budget: settings.budget, teams: draft.team_count, rosterSize: settings.roster_size
  });

  const sales = rows('SELECT * FROM auction_sales WHERE draft_id = ?', draftId);
  const soldIds = new Set(sales.map(s => s.player_id));
  const spent = sales.reduce((s, x) => s + x.price, 0);
  const remainingBudget = total_budget - spent;

  const remainingPool = players.filter(p => p.auction_value != null && !soldIds.has(p.id));
  const remainingBookValue = remainingPool.reduce((s, p) => s + p.auction_value, 0);
  const inflationPct = remainingBookValue > 0
    ? +((remainingBudget / remainingBookValue - 1) * 100).toFixed(1)
    : 0;
  const scale = 1 + inflationPct / 100;

  return {
    draft_id: draftId,
    total_budget, spent, remaining_budget: remainingBudget,
    remaining_book_value: remainingBookValue, inflation_pct: inflationPct,
    sales,
    players: players.map(p => ({
      ...p,
      sold: soldIds.has(p.id),
      live_value: p.auction_value != null && !soldIds.has(p.id)
        ? Math.max(1, Math.round(p.auction_value * scale))
        : null
    }))
  };
}
