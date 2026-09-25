/**
 * Executed moves from league_transactions_raw rows, pure (no database): players
 * added and dropped per team, and completed trades. The one reader of these
 * rows' move semantics: manager-signals.js (the activity signals) and
 * eval/living-gate.js (the LIVING-01b re-gate) both count through it.
 * Moved here from manager-signals.js unchanged, so the re-gate can count moves
 * without opening the app database on import (brain-gate.js must stay DB-free).
 */

/**
 * Players added, per team, as [scoring period, count] pairs. An EXECUTED
 * WAIVER or FREEAGENT row can carry an ADD and a DROP (or, in principle, more
 * than one ADD), so the ADD items are counted, not the rows. On the 2026 rows
 * (local copy, 2026-09-23) the two agree: 134 executed rows, 134 ADD items.
 */
export function addsByTeam(all) {
  const out = new Map();
  for (const t of all) {
    if ((t.type !== 'WAIVER' && t.type !== 'FREEAGENT') || t.status !== 'EXECUTED') continue;
    let items;
    try { items = JSON.parse(t.items_json || '[]'); } catch (err) {
      throw new Error(`league_transactions_raw ${t.tx_id}: items_json is not JSON (${err.message})`);
    }
    for (const i of items) {
      if (i?.type !== 'ADD' || !(Number(i.toTeamId) > 0)) continue;
      const k = Number(i.toTeamId);
      (out.get(k) ?? out.set(k, []).get(k)).push(Number(t.scoring_period));
    }
  }
  return out;
}

/**
 * Players dropped, per team, as scoring periods: the DROP items on EXECUTED
 * WAIVER or FREEAGENT rows (a claim's drop and a drop-only move alike), keyed
 * by the team that let the player go. Same reading rules as addsByTeam.
 */
export function dropsByTeam(all) {
  const out = new Map();
  for (const t of all) {
    if ((t.type !== 'WAIVER' && t.type !== 'FREEAGENT') || t.status !== 'EXECUTED') continue;
    let items;
    try { items = JSON.parse(t.items_json || '[]'); } catch (err) {
      throw new Error(`league_transactions_raw ${t.tx_id}: items_json is not JSON (${err.message})`);
    }
    for (const i of items) {
      if (i?.type !== 'DROP' || !(Number(i.fromTeamId) > 0)) continue;
      const k = Number(i.fromTeamId);
      (out.get(k) ?? out.set(k, []).get(k)).push(Number(t.scoring_period));
    }
  }
  return out;
}

/**
 * Completed trades as { period, parties }: the league PROCESSED them. ESPN
 * writes TRADE_ACCEPT / PROCESS with status EXECUTED, under the proposer, when
 * a trade goes through (CANCEL if it is vetoed), and that row carries the
 * items, so both sides are on it. Reading the responder's EXECUTE row instead
 * misses trades: on the 2026 rows (local copy, 2026-09-23) 8 of 17 accept
 * EXECUTE rows have no proposal row to take the parties from, while all 9
 * PROCESS / EXECUTED rows carry their items.
 */
export function completedTrades(all) {
  const out = [];
  for (const t of all) {
    if (t.type !== 'TRADE_ACCEPT' || t.execution_type !== 'PROCESS' || t.status !== 'EXECUTED') continue;
    let items;
    try { items = JSON.parse(t.items_json || '[]'); } catch (err) {
      throw new Error(`league_transactions_raw ${t.tx_id}: items_json is not JSON (${err.message})`);
    }
    const parties = new Set(items.flatMap(i => [i.fromTeamId, i.toTeamId]).filter(x => Number(x) > 0).map(Number));
    if (parties.size) out.push({ period: Number(t.scoring_period), parties });
  }
  return out;
}
