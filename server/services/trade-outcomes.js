/**
 * The trade outcome ledger: what actually happened to a trade, written down
 * once instead of re-derived on every page load.
 *
 * Migration 067 explains why the tables are shaped the way they are. This file
 * is the four writers and one reader over them.
 *
 * WHAT THIS DOES NOT DO. It does not replace the read-time passes in
 * `counterparty-pricing.js` and `manager-signals.js`. Those keep working
 * against the same raw rows and are untouched. `settleObservedOutcomes` is the
 * same reading, pointed at a store, so that an outcome gains a stamp and a join
 * key rather than being computed and discarded.
 *
 * ABSENCE IS A STATE, NOT AN ERROR AND NOT AN EMPTY. On this machine
 * `league_transactions_raw` has never existed: it is created by hand in
 * `scripts/collect-league-transactions.mjs`, which needs an ESPN cookie and has
 * not been run here. Every current reader guards on that and continues, and so
 * does the writer — but it says WHICH absence it is, because "the collector has
 * never run" and "this league has no trades" are the same empty with completely
 * different fixes, and a caller that cannot tell them apart will report the
 * first as the second.
 */
import { rows, row, run } from '../db/index.js';

const tableExists = name =>
  rows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name).length > 0;

const RAW_TABLE = 'league_transactions_raw';

/**
 * Why the raw table is not here, in the caller's words rather than an
 * exception's. Kept as one constant because it is served, and a sentence that
 * reaches a user from two places must not be able to disagree with itself.
 */
const RAW_ABSENT_REASON =
  `${RAW_TABLE} has never been created on this machine — it is created by `
  + 'scripts/collect-league-transactions.mjs, which needs an ESPN cookie and has not been run here';

/** The ESPN transaction vocabulary, read off the rows the collector writes. */
const PROPOSAL = 'TRADE_PROPOSAL';
const ANSWERS = Object.freeze({ TRADE_ACCEPT: 'accepted', TRADE_DECLINE: 'declined' });
const EXECUTED = 'EXECUTE';

/**
 * The teams a raw proposal is between, from its items.
 *
 * ESPN writes one item per player moving, each with the team it leaves and the
 * team it joins, so the parties are the union of both ends. `team_id` is the
 * team that ACTED — the proposer on a proposal — and is not enough on its own:
 * it says who sent the offer, never who received it.
 */
function partiesOf(itemsJson) {
  let items = [];
  try { items = JSON.parse(itemsJson || '[]'); } catch { items = []; }
  if (!Array.isArray(items)) items = [];
  return new Set(items.flatMap(i => [i?.fromTeamId, i?.toTeamId])
    .filter(x => x != null && Number(x) > 0)
    .map(String));
}

/** The two sides of one raw proposal, or null with the reason it is not a deal. */
function sidesOf(tx) {
  const proposer = tx.team_id == null ? null : String(tx.team_id);
  if (!proposer) return { error: 'the raw row names no acting team, so there is no proposer' };
  const parties = partiesOf(tx.items_json);
  const others = [...parties].filter(p => p !== proposer);
  if (!others.length) {
    return { error: 'the raw row names no counterparty in its items, and a deal with one side is not a deal' };
  }
  if (others.length > 1) {
    return { error: `the raw row names ${others.length} counterparties, and this ledger stores two-party deals only` };
  }
  const give = [];
  const get = [];
  let items = [];
  try { items = JSON.parse(tx.items_json || '[]'); } catch { items = []; }
  for (const i of Array.isArray(items) ? items : []) {
    if (String(i?.fromTeamId) === proposer) give.push(i);
    else if (String(i?.toTeamId) === proposer) get.push(i);
  }
  return { proposer, counterparty: others[0], give, get };
}

/**
 * Turn the ESPN rows this league has collected into observed outcome rows.
 *
 * Idempotent on (league_id, season, espn_tx_id), which is the raw table's own
 * primary key. A second run over the same rows writes nothing and rewrites
 * nothing: re-running the collector is a normal thing to do and must not double
 * every outcome, and an outcome that has already been settled is not re-settled
 * with today's clock.
 */
export function settleObservedOutcomes(leagueId, season) {
  const result = { state: 'settled', written: 0, skipped: 0, skips: [], reason: null };
  if (!tableExists(RAW_TABLE)) {
    return { ...result, state: 'raw_table_absent', reason: RAW_ABSENT_REASON };
  }

  const tx = rows(
    `SELECT tx_id, type, execution_type, team_id, related_tx_id, proposed_at, items_json
     FROM ${RAW_TABLE} WHERE league_id = ? AND season = ?`, leagueId, season);

  const proposals = tx.filter(t => t.type === PROPOSAL && t.execution_type === EXECUTED);
  const proposalIds = new Set(proposals.map(t => String(t.tx_id)));

  // An answer points at the proposal it answers. An answer whose proposal is
  // not in these rows is NOT an outcome: there is no deal to attach it to, and
  // inventing one from the answer alone would be a deal nobody proposed.
  const answer = new Map();
  for (const t of tx) {
    const verdict = ANSWERS[t.type];
    if (!verdict || t.execution_type !== EXECUTED) continue;
    const target = t.related_tx_id == null ? null : String(t.related_tx_id);
    if (!target || !proposalIds.has(target)) {
      result.skipped++;
      result.skips.push({
        tx_id: String(t.tx_id),
        reason: target
          ? `its related_tx_id ${target} names a proposal that is not in the collected rows`
          : 'it carries no related_tx_id, so the proposal it answers is unknown',
      });
      continue;
    }
    answer.set(target, { verdict, at: t.proposed_at ?? null });
  }

  const now = new Date().toISOString();
  for (const p of proposals) {
    const sides = sidesOf(p);
    if (sides.error) {
      result.skipped++;
      result.skips.push({ tx_id: String(p.tx_id), reason: sides.error });
      continue;
    }
    const a = answer.get(String(p.tx_id));
    // An unanswered offer is 'proposed', never 'declined'. Scoring silence as a
    // rejection is the cheapest way to make every P(accept) read low forever,
    // and it is wrong about the manager rather than about the model.
    const status = a ? a.verdict : 'proposed';
    const resolvedAt = a ? a.at : null;

    const existing = row(
      `SELECT id FROM trade_outcomes WHERE league_id = ? AND season = ? AND espn_tx_id = ?`,
      leagueId, season, String(p.tx_id));
    if (existing) continue;

    run(`INSERT INTO trade_outcomes
           (league_id, season, source, proposer_team_id, counterparty_team_id,
            give_json, get_json, proposed_at, status, espn_tx_id, resolved_at, created_at)
         VALUES (?, ?, 'observed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    leagueId, season, sides.proposer, sides.counterparty,
    JSON.stringify(sides.give), JSON.stringify(sides.get),
    p.proposed_at ?? null, status, String(p.tx_id), resolvedAt, now);
    result.written++;
  }
  return result;
}

function requireFields(o, fields) {
  for (const f of fields) {
    if (o?.[f] == null) throw new Error(`trade-outcomes: ${f} is required and was not given`);
  }
}

/**
 * The app proposed this deal. Records the model's P(accept) AT THIS MOMENT and
 * which model gave it.
 *
 * Both are required, and the table requires them too. A prediction not written
 * down when it was made cannot be recovered afterwards — re-running the model
 * later scores a different model against an older decision — so a proposed row
 * without one is a row that can never be scored, and is refused rather than
 * stored as a gap someone will later fill with a guess.
 */
export function recordProposedOutcome(o) {
  requireFields(o, ['league_id', 'season', 'model_p_accept', 'model_version']);
  const info = run(`INSERT INTO trade_outcomes
      (league_id, season, source, proposer_team_id, counterparty_team_id,
       give_json, get_json, proposed_at, model_p_accept, model_version, status, created_at)
    VALUES (?, ?, 'app_proposed', ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
  o.league_id, o.season, o.proposer_team_id ?? null, o.counterparty_team_id ?? null,
  JSON.stringify(o.give ?? []), JSON.stringify(o.get ?? []),
  o.proposed_at ?? new Date().toISOString(), o.model_p_accept, o.model_version,
  new Date().toISOString());
  return Number(info.lastInsertRowid);
}

/**
 * The app considered this deal and did NOT propose it, with the reason.
 *
 * This is the selection-bias half, and it is the reason the ledger is worth
 * having. A store of what was SENT is a store of the model's own filter; a
 * calibration over it measures the filter and reports the number as the
 * model's. The candidates that were rejected are the control group, and a
 * control group added later does not exist for the period that matters.
 *
 * The reason is required here and in the table. A non-event with no reason is a
 * row that every non-event satisfies.
 */
export function recordConsideredOnly(o) {
  requireFields(o, ['league_id', 'season', 'not_proposed_reason']);
  const info = run(`INSERT INTO trade_outcomes
      (league_id, season, source, proposer_team_id, counterparty_team_id,
       give_json, get_json, proposed_at, model_p_accept, model_version,
       status, not_proposed_reason, created_at)
    VALUES (?, ?, 'considered_only', ?, ?, ?, ?, ?, ?, ?, 'not_proposed', ?, ?)`,
  o.league_id, o.season, o.proposer_team_id ?? null, o.counterparty_team_id ?? null,
  JSON.stringify(o.give ?? []), JSON.stringify(o.get ?? []),
  o.proposed_at ?? new Date().toISOString(), o.model_p_accept ?? null, o.model_version ?? null,
  o.not_proposed_reason, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

/**
 * A simulated deal, into its own table.
 *
 * A simulation is a stress test of the machinery. A real outcome is evidence
 * about a person. They are never the same kind of thing, so they do not share a
 * table and are never joined: a flag would be one forgotten WHERE clause away
 * from pricing a human being on negotiations that never happened.
 */
export function recordSyntheticOutcome(o) {
  requireFields(o, ['league_id', 'season', 'sim_run_id', 'status']);
  const info = run(`INSERT INTO trade_outcomes_synthetic
      (sim_run_id, label, league_id, season, source, proposer_team_id, counterparty_team_id,
       give_json, get_json, proposed_at, model_p_accept, model_version, status, created_at)
    VALUES (?, 'synthetic', ?, ?, 'app_proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  o.sim_run_id, o.league_id, o.season, o.proposer_team_id ?? null, o.counterparty_team_id ?? null,
  JSON.stringify(o.give ?? []), JSON.stringify(o.get ?? []),
  o.proposed_at ?? new Date().toISOString(), o.model_p_accept ?? null, o.model_version ?? null,
  o.status, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

/** Every real outcome for one league-season, oldest first. Synthetic rows are not here. */
export function outcomesFor(leagueId, season) {
  if (!tableExists('trade_outcomes')) return [];
  return rows(`SELECT * FROM trade_outcomes WHERE league_id = ? AND season = ?
               ORDER BY COALESCE(proposed_at, created_at), id`, leagueId, season);
}
