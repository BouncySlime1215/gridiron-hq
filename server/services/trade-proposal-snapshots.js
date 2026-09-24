/**
 * Offer snapshots: the terms of every ESPN trade offer, kept from the first
 * sighting, and every decision linked back to them. Migration 079 explains the
 * two tables.
 *
 * Two writers:
 *   - captureProposalSnapshots: called by scripts/collect-league-transactions.mjs
 *     with the ESPN payload it just stored, so the terms are read from the
 *     response itself, before the raw upsert can overwrite them.
 *   - linkTradeOutcomes: one pass over the league-season's raw rows. It first
 *     backfills snapshots from raw proposal rows that still carry items, then
 *     links every decision row. Run every collector pass, it is also the
 *     backfill for rows written before this existed.
 *
 * A decision whose proposal cannot be found is written as 'proposal_missing'
 * with a typed reason, never skipped. The share of decisions with unknown
 * terms is the number this unit exists to shrink, and a skip cannot be counted.
 */
import { rows, row, run } from '../db/index.js';

const RAW_TABLE = 'league_transactions_raw';
const PROPOSAL = 'TRADE_PROPOSAL';

export const MISSING_REASONS = Object.freeze(['no_related_tx_id', 'proposal_never_captured', 'proposal_items_empty']);

/** Later decisions win: a veto undoes an accept, and an accept or decline says more than the close record. */
const PRECEDENCE = Object.freeze({ closed: 0, declined: 1, accepted: 2, vetoed: 3 });

const tableExists = name =>
  rows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name).length > 0;

/**
 * Is this raw/ESPN transaction an offer (rather than the close record ESPN
 * writes under the proposer when an offer ends)? Close records are
 * TRADE_PROPOSAL / CANCEL and point at the offer through related_tx_id.
 */
const isOffer = (type, executionType) => type === PROPOSAL && executionType !== 'CANCEL';

/**
 * What a decision row decided, or null when the row is not a decision.
 * TRADE_ACCEPT / PROCESS is the league processing an accepted trade, and
 * TRADE_ACCEPT / CANCEL is that processing undone by a veto; neither is a
 * manager's answer (manager-signals.js txIndex, measured 2026-09-18).
 */
function resolutionOf(t) {
  if (t.type === 'TRADE_ACCEPT') return t.execution_type === 'EXECUTE' ? 'accepted' : null;
  if (t.type === 'TRADE_DECLINE') return t.execution_type === 'EXECUTE' ? 'declined' : null;
  if (t.type === 'TRADE_VETO') return 'vetoed';
  if (t.type === PROPOSAL && t.execution_type === 'CANCEL') return 'closed';
  return null;
}

/** A non-empty items list from JSON text, or null. Throws on JSON that is not JSON. */
function itemsFrom(text, txId) {
  if (text == null || text === '') return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    throw new Error(`${RAW_TABLE} ${txId}: items_json is not JSON (${e.message})`);
  }
  return Array.isArray(parsed) && parsed.length ? parsed : null;
}

const iso = ms => (ms ? new Date(ms).toISOString() : null);

const insertSnapshot = (s) => run(
  `INSERT INTO trade_proposal_snapshots
     (league_id, season, proposal_tx_id, proposer_team_id, proposed_at, scoring_period, items_json,
      first_raw_json, captured_from, captured_at, last_seen_at, last_status)
   VALUES (@league_id, @season, @proposal_tx_id, @proposer_team_id, @proposed_at, @scoring_period, @items_json,
      @first_raw_json, @captured_from, @captured_at, @last_seen_at, @last_status)
   ON CONFLICT(league_id, season, proposal_tx_id) DO NOTHING`, s);

/**
 * Snapshot every offer in one ESPN response. First write wins: the items,
 * proposer and `captured_from` of an existing snapshot are never rewritten;
 * a later sighting only moves `last_seen_at` and `last_status`. An offer that
 * arrives with no items is not snapshotted (the CHECK would refuse it) and is
 * counted, so a run that sees offers but can store none of them says so.
 */
export function captureProposalSnapshots(leagueId, season, transactions, now) {
  const out = { seen: 0, captured: 0, no_items: 0 };
  for (const t of transactions ?? []) {
    if (!t?.id || !isOffer(t.type, t.executionType ?? null)) continue;
    out.seen++;
    const id = String(t.id);
    const items = Array.isArray(t.items) && t.items.length ? t.items : null;
    if (items) {
      const r = insertSnapshot({
        league_id: leagueId, season, proposal_tx_id: id, proposer_team_id: t.teamId ?? null,
        proposed_at: iso(t.proposedDate), scoring_period: t.scoringPeriodId ?? null,
        items_json: JSON.stringify(items), first_raw_json: JSON.stringify(t),
        captured_from: t.isPending ? 'pending' : 'resolved', captured_at: now, last_seen_at: now,
        last_status: t.status ?? null,
      });
      if (r.changes) { out.captured++; continue; }
    } else {
      out.no_items++;
    }
    run(`UPDATE trade_proposal_snapshots SET last_seen_at = ?, last_status = ?
         WHERE league_id = ? AND season = ? AND proposal_tx_id = ?`,
    now, t.status ?? null, leagueId, season, id);
  }
  return out;
}

/**
 * Backfill snapshots from the raw rows, then link every decision row.
 * Idempotent: a link is keyed by the decision's own tx id, and a miss is
 * re-evaluated each run so it turns into a link once its proposal is captured.
 */
export function linkTradeOutcomes(leagueId, season, now) {
  const result = { state: 'linked', backfilled: 0, linked: 0, missing: 0,
    byReason: Object.fromEntries(MISSING_REASONS.map(r => [r, 0])) };
  if (!tableExists(RAW_TABLE)) {
    return { ...result, state: 'raw_table_absent',
      reason: `${RAW_TABLE} has never been created here — scripts/collect-league-transactions.mjs creates it` };
  }
  const tx = rows(
    `SELECT tx_id, type, status, execution_type, team_id, related_tx_id, proposed_at, processed_at,
            scoring_period, items_json
     FROM ${RAW_TABLE} WHERE league_id = ? AND season = ?`, leagueId, season);

  const rawOffers = new Map();
  for (const t of tx) {
    if (!isOffer(t.type, t.execution_type)) continue;
    const items = itemsFrom(t.items_json, t.tx_id);
    rawOffers.set(String(t.tx_id), items);
    if (!items) continue;
    const r = insertSnapshot({
      league_id: leagueId, season, proposal_tx_id: String(t.tx_id), proposer_team_id: t.team_id ?? null,
      proposed_at: t.proposed_at ?? null, scoring_period: t.scoring_period ?? null,
      items_json: JSON.stringify(items), first_raw_json: null, captured_from: 'raw_backfill',
      captured_at: now, last_seen_at: now, last_status: t.status ?? null,
    });
    result.backfilled += r.changes;
  }

  const snapped = new Set(rows(
    `SELECT proposal_tx_id FROM trade_proposal_snapshots WHERE league_id = ? AND season = ?`,
    leagueId, season).map(r => r.proposal_tx_id));

  const best = new Map();
  for (const t of tx) {
    const resolution = resolutionOf(t);
    if (!resolution) continue;
    const related = t.related_tx_id == null ? null : String(t.related_tx_id);
    let reason = null;
    if (!related) reason = 'no_related_tx_id';
    else if (!snapped.has(related)) reason = rawOffers.has(related) ? 'proposal_items_empty' : 'proposal_never_captured';
    const decidedAt = t.processed_at ?? t.proposed_at ?? null;

    run(`INSERT INTO trade_outcome_links
           (league_id, season, outcome_tx_id, outcome_type, resolution, related_tx_id, proposal_tx_id,
            link_state, missing_reason, decided_at, recorded_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(league_id, season, outcome_tx_id) DO UPDATE SET
           proposal_tx_id = excluded.proposal_tx_id, link_state = excluded.link_state,
           missing_reason = excluded.missing_reason, decided_at = excluded.decided_at,
           updated_at = excluded.updated_at
         WHERE link_state IS NOT excluded.link_state OR missing_reason IS NOT excluded.missing_reason`,
    leagueId, season, String(t.tx_id), t.type, resolution, related, reason ? null : related,
    reason ? 'proposal_missing' : 'linked', reason, decidedAt, now, now);

    if (reason) { result.missing++; result.byReason[reason]++; continue; }
    result.linked++;
    const prev = best.get(related);
    if (!prev || PRECEDENCE[resolution] > PRECEDENCE[prev.resolution]
        || (PRECEDENCE[resolution] === PRECEDENCE[prev.resolution] && String(decidedAt) > String(prev.at))) {
      best.set(related, { resolution, tx: String(t.tx_id), at: decidedAt });
    }
  }

  for (const [proposal, b] of best) {
    run(`UPDATE trade_proposal_snapshots SET resolution = ?, resolution_tx_id = ?, resolved_at = ?
         WHERE league_id = ? AND season = ? AND proposal_tx_id = ?`,
    b.resolution, b.tx, b.at, leagueId, season, proposal);
  }
  return result;
}

/** Share of linked decisions for one league-season, for the collector's log line. */
export function linkCoverage(leagueId, season) {
  return row(`SELECT COUNT(*) AS decisions, SUM(link_state = 'linked') AS linked
              FROM trade_outcome_links WHERE league_id = ? AND season = ?`, leagueId, season);
}
