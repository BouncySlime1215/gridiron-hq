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
import { rows, row, run, db as appDb } from '../db/index.js';
import { rawOfferGroups } from './eval/decided-offers.js';
import { allowsWithdrawn } from '../db/trade-outcomes-withdrawn.js';

/** ESPN's own expiry close; any other actor closing a proposal is its proposer withdrawing it (decided-offers.js). */
const EXPIRY_ACTOR = /^TradeTaskProcessor/;

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
function partiesOf(items) {
  return new Set(items.flatMap(i => [i?.fromTeamId, i?.toTeamId])
    .filter(x => x != null && Number(x) > 0)
    .map(String));
}

/**
 * A raw row's items, or the reason they could not be read.
 *
 * NOT a catch that defaults to []. That version turned a corrupt items_json into
 * "the raw row names no counterparty in its items", which is a sentence about the
 * deal produced by a read that failed. The two have different fixes (one is in
 * the collector, the other is not a deal at all), so the reason names which.
 */
function itemsOf(itemsJson) {
  if (itemsJson == null || itemsJson === '') return { items: [] };
  let parsed;
  try {
    parsed = JSON.parse(itemsJson);
  } catch (e) {
    return { error: `its items_json is not valid JSON (${e.message}), so the parties cannot be read` };
  }
  if (!Array.isArray(parsed)) {
    return { error: 'its items_json is not a list of items, so the parties cannot be read' };
  }
  return { items: parsed };
}

/** The two sides of one raw proposal, or null with the reason it is not a deal. */
function sidesOf(tx) {
  const proposer = tx.team_id == null ? null : String(tx.team_id);
  if (!proposer) return { error: 'the raw row names no acting team, so there is no proposer' };
  const read = itemsOf(tx.items_json);
  if (read.error) return { error: read.error };
  const { items } = read;
  const parties = partiesOf(items);
  const others = [...parties].filter(p => p !== proposer);
  if (!others.length) {
    return { error: 'the raw row names no counterparty in its items, and a deal with one side is not a deal' };
  }
  if (others.length > 1) {
    return { error: `the raw row names ${others.length} counterparties, and this ledger stores two-party deals only` };
  }
  const give = [];
  const get = [];
  for (const i of items) {
    if (String(i?.fromTeamId) === proposer) give.push(i);
    else if (String(i?.toTeamId) === proposer) get.push(i);
  }
  return { proposer, counterparty: others[0], give, get };
}

/**
 * What ESPN decided about one proposal, from E1's own pairing
 * (`decided-offers.js#rawOfferGroups`), as a ledger status. Null = no answer
 * and no close yet, so the row stays 'proposed'.
 *
 * There is no 'vetoed' status. Accepted then vetoed stays 'accepted', as E1
 * counts it (the receiver said yes). ESPN's expiry is 'expired' (the other
 * manager let it lapse). A proposer's withdrawal is 'withdrawn' (migration 105 /
 * preflight): it is NOT the other manager's silence, so Coach and E2 must not read
 * it as a reply. On a database not yet widened, a withdrawal is left 'proposed'
 * (never written as 'expired'), with the reason saying so.
 * Every reason starts `backfill_observed:`, so a reader can tell these from a
 * sent offer's settle and knows no prediction was recorded for them.
 */
function observedVerdict(g, txId, { withdrawnOk = true } = {}) {
  if (!g) return null;
  if (g.excluded === 'expired') {
    return { status: 'expired', at: g.closed_at ?? null,
      reason: `backfill_observed: ESPN expired proposal ${txId} (CANCEL ${g.close_tx_id}) with no answer` };
  }
  if (g.excluded === 'withdrawn') {
    const reason = `backfill_observed: proposal ${txId} withdrawn by the proposer (CANCEL ${g.close_tx_id}) before any answer`;
    return withdrawnOk ? { status: 'withdrawn', at: g.closed_at ?? null, reason } : { status: 'proposed', at: null, reason };
  }
  if (g.excluded || !ANSWER_TYPE[g.status]) return null;
  return { status: g.status, at: g.decided_at ?? null,
    reason: `backfill_observed: ESPN ${ANSWER_TYPE[g.status]} ${g.decision_tx_id}${g.vetoed ? ', then vetoed' : ''}` };
}
const ANSWER_TYPE = Object.freeze({ accepted: 'TRADE_ACCEPT', declined: 'TRADE_DECLINE' });

/**
 * Turn the ESPN rows this league has collected into observed outcome rows.
 *
 * Idempotent on (league_id, season, espn_tx_id), which is the raw table's own
 * primary key. A second run over the same rows writes nothing and rewrites
 * nothing: re-running the collector is a normal thing to do and must not double
 * every outcome, and an outcome that has already been settled is not re-settled
 * with today's clock.
 *
 * LEDGER-BACKFILL: an observed row written while its offer was still pending
 * is settled once the answer (or ESPN's close) is collected. Before, the row
 * stayed 'proposed' forever. Only rows still 'proposed' are updated; a settled
 * row and every app row are never touched. The verdict comes from the pairing
 * E1 grades, so the ledger and the grader cannot disagree about an offer.
 */
export function settleObservedOutcomes(leagueId, season) {
  const result = { state: 'settled', written: 0, updated: 0, skipped: 0, skips: [], by_status: {}, reason: null };
  if (!tableExists(RAW_TABLE)) {
    return { ...result, state: 'raw_table_absent', reason: RAW_ABSENT_REASON };
  }

  // member_id tells ESPN's expiry close (TradeTaskProcessor) from a withdrawal; decided-offers reads it as optional.
  const memberCol = rows(`PRAGMA table_info(${RAW_TABLE})`).some(c => c.name === 'member_id') ? 'member_id' : 'NULL AS member_id';
  const tx = rows(
    `SELECT league_id, season, tx_id, type, execution_type, team_id, ${memberCol}, related_tx_id, proposed_at, items_json
     FROM ${RAW_TABLE} WHERE league_id = ? AND season = ?`, leagueId, season);

  const proposals = tx.filter(t => t.type === PROPOSAL && t.execution_type === EXECUTED);
  const proposalIds = new Set(proposals.map(t => String(t.tx_id)));

  // An answer points at the proposal it answers. An answer whose proposal is
  // not in these rows is NOT an outcome: there is no deal to attach it to, and
  // inventing one from the answer alone would be a deal nobody proposed.
  for (const t of tx) {
    if (!ANSWERS[t.type] || t.execution_type !== EXECUTED) continue;
    const target = t.related_tx_id == null ? null : String(t.related_tx_id);
    if (target && proposalIds.has(target)) continue;
    result.skipped++;
    result.skips.push({
      tx_id: String(t.tx_id),
      reason: target
        ? `its related_tx_id ${target} names a proposal that is not in the collected rows`
        : 'it carries no related_tx_id, so the proposal it answers is unknown',
    });
  }

  const groups = rawOfferGroups({ raw: tx });
  const groupOf = txId => groups.get([leagueId, season, txId].map(String).join(':'));
  const hasReason = rows(`PRAGMA table_info(trade_outcomes)`).some(c => c.name === 'settle_reason');
  const withdrawnOk = allowsWithdrawn(appDb);
  result.resettled = 0;
  result.disagree = [];

  const now = new Date().toISOString();
  for (const p of proposals) {
    const sides = sidesOf(p);
    if (sides.error) {
      result.skipped++;
      result.skips.push({ tx_id: String(p.tx_id), reason: sides.error });
      continue;
    }
    // An unanswered offer is 'proposed', never 'declined'. Scoring silence as a
    // rejection is the cheapest way to make every P(accept) read low forever,
    // and it is wrong about the manager rather than about the model.
    const v = observedVerdict(groupOf(p.tx_id), String(p.tx_id), { withdrawnOk });

    const existing = row(
      `SELECT id, status, ${hasReason ? 'settle_reason' : 'NULL AS settle_reason'} FROM trade_outcomes
       WHERE league_id = ? AND season = ? AND espn_tx_id = ?`,
      leagueId, season, String(p.tx_id));
    if (existing) {
      // #409 review finding 2: a row an OLDER settler wrote (settle_reason NULL) or an earlier
      // backfill wrote (e.g. a withdrawal as 'expired') is re-settled from E1's pairing when it
      // disagrees. Idempotent: once it agrees, nothing is written again. A row E1's pairing
      // cannot settle (no answer, or not an offer) is never guessed at: it is listed in
      // `disagree` for a one-off look instead.
      const ours = existing.settle_reason == null || String(existing.settle_reason).startsWith('backfill_observed:');
      if (existing.status !== 'proposed') {
        if (v && v.status !== 'proposed' && v.status !== existing.status && ours) {
          run(`UPDATE trade_outcomes SET status = ?, resolved_at = ?${hasReason ? ', settle_reason = ?' : ''} WHERE id = ?`,
            ...[v.status, v.at, ...(hasReason ? [`${v.reason} (re-settled from ${existing.status})`] : []), existing.id]);
          result.resettled++;
        } else if (!v && ours && existing.settle_reason == null) {
          result.disagree.push({ id: existing.id, espn_tx_id: String(p.tx_id), status: existing.status,
            why: 'settled by the old settler, but E1\'s pairing finds no answer or close for it' });
        }
        continue;
      }
      if (!v || v.status === 'proposed') {
        if (v && hasReason && existing.settle_reason !== v.reason) {
          run(`UPDATE trade_outcomes SET settle_reason = ? WHERE id = ?`, v.reason, existing.id);
        }
        continue;
      }
      if (hasReason) {
        run(`UPDATE trade_outcomes SET status = ?, resolved_at = ?, settle_reason = ? WHERE id = ? AND status = 'proposed'`,
          v.status, v.at, v.reason, existing.id);
      } else {
        run(`UPDATE trade_outcomes SET status = ?, resolved_at = ? WHERE id = ? AND status = 'proposed'`,
          v.status, v.at, existing.id);
      }
      result.updated++;
      continue;
    }

    run(`INSERT INTO trade_outcomes
           (league_id, season, source, proposer_team_id, counterparty_team_id,
            give_json, get_json, proposed_at, status, espn_tx_id, resolved_at, created_at)
         VALUES (?, ?, 'observed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    leagueId, season, sides.proposer, sides.counterparty,
    JSON.stringify(sides.give), JSON.stringify(sides.get),
    p.proposed_at ?? null, v ? v.status : 'proposed', String(p.tx_id), v ? v.at : null, now);
    if (v && hasReason) {
      run(`UPDATE trade_outcomes SET settle_reason = ? WHERE league_id = ? AND season = ? AND espn_tx_id = ?`,
        v.reason, leagueId, season, String(p.tx_id));
    }
    result.written++;
  }
  for (const r of rows(`SELECT status, COUNT(*) AS n FROM trade_outcomes
      WHERE league_id = ? AND season = ? AND source = 'observed' GROUP BY status ORDER BY status`, leagueId, season)) {
    result.by_status[r.status] = r.n;
  }
  return result;
}

/**
 * The model's prediction, as the model actually states it.
 *
 * `trade-acceptance.js` returns a BAND and refuses to state a point: `fitted` is
 * false on every path and its own served sentence says "not a calibrated
 * probability". So the ledger stores the midpoint — a calibration needs a point
 * to score — WITH the width the evidence bought and the basis that produced it.
 * A midpoint stored alone would be the invented precision this project keeps
 * finding and removing, and a later reader would have no way to tell a declared
 * starting point from a measurement.
 *
 * Accepts either `acceptance` (the band object the engine attaches to a deal at
 * trade-engine.js:1921) or the three values directly, so a caller does not have
 * to take the band apart to record it.
 */
function predictionOf(o, { required = true } = {}) {
  // PYES-ONE: with GRIDIRON_PYES_BASELINE=1 the served acceptance is the activity baseline and the
  // clone band rides on `challenger`. The ledger keeps logging the clone (its basis is what the
  // model_basis CHECK allows, and model_version names the clone) until a migration adds the baseline.
  const acc = o?.acceptance?.challenger ?? o?.acceptance ?? null;
  const band = acc?.band ?? null;
  const mid = o?.model_p_accept ?? band?.mid ?? null;
  const low = o?.model_p_accept_low ?? band?.low ?? null;
  const high = o?.model_p_accept_high ?? band?.high ?? null;
  const basis = o?.model_basis ?? acc?.basis ?? null;
  if (mid == null) {
    if (!required) return { mid: null, low: null, high: null, basis: null };
    throw new Error('trade-outcomes: model_p_accept is required and was not given');
  }
  // A point with no band is a claim the model does not make. Refused here rather
  // than written and explained away in whatever reads it next.
  if (low == null || high == null) {
    throw new Error('trade-outcomes: model_p_accept_low and model_p_accept_high are required — '
      + 'the acceptance model states a band, never a point, so a midpoint alone would record '
      + 'a precision it never claimed');
  }
  if (!basis) {
    throw new Error('trade-outcomes: model_basis is required — an anchored band and a declared '
      + 'starting point are different evidence and must not pool in one calibration curve');
  }
  return { mid, low, high, basis };
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
  requireFields(o, ['league_id', 'season', 'model_version']);
  const p = predictionOf(o);
  const info = run(`INSERT INTO trade_outcomes
      (league_id, season, source, proposer_team_id, counterparty_team_id,
       give_json, get_json, proposed_at, model_p_accept, model_p_accept_low,
       model_p_accept_high, model_basis, model_version, idea_id, status, created_at)
    VALUES (?, ?, 'app_proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
  o.league_id, o.season, o.proposer_team_id ?? null, o.counterparty_team_id ?? null,
  JSON.stringify(o.give ?? []), JSON.stringify(o.get ?? []),
  o.proposed_at ?? new Date().toISOString(),
  p.mid, p.low, p.high, p.basis, o.model_version, o.idea_id ?? null,
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
  const p = predictionOf(o, { required: false });
  const info = run(`INSERT INTO trade_outcomes
      (league_id, season, source, proposer_team_id, counterparty_team_id,
       give_json, get_json, proposed_at, model_p_accept, model_p_accept_low,
       model_p_accept_high, model_basis, model_version, idea_id,
       status, not_proposed_reason, created_at)
    VALUES (?, ?, 'considered_only', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_proposed', ?, ?)`,
  o.league_id, o.season, o.proposer_team_id ?? null, o.counterparty_team_id ?? null,
  JSON.stringify(o.give ?? []), JSON.stringify(o.get ?? []),
  o.proposed_at ?? new Date().toISOString(), p.mid, p.low, p.high, p.basis, o.model_version ?? null,
  o.idea_id ?? null, o.not_proposed_reason, new Date().toISOString());
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

/**
 * Record what one proposals run decided: what it sent, and what it considered and
 * did not send.
 *
 * THIS IS THE SELECTION-BIAS HALF, AT THE ONLY LAYER THAT CAN SEE BOTH. The
 * route has the whole slate that passed the edge test AND the model's answer, so
 * it is the one place that knows which candidates were dropped. Downstream of
 * here the rejected ones are gone, and a ledger written downstream would be a
 * ledger of the model's own filter.
 *
 * A CACHE HIT WRITES NOTHING. `GET /:leagueId/proposals` is a GET a page calls on
 * every open, and `source: 'cache'` means no decision was made this time — the
 * answer was paid for once and is being re-read. Writing on a re-read would let
 * one decision become a hundred rows and a calibration would weight it by how
 * often somebody refreshed the page. The unique index on
 * (league_id, season, idea_id, source) is the second guard, for a fresh call over
 * a slate already recorded.
 *
 * Absence-safe: if the tables are not there, this no-ops with a state rather than
 * throwing. A ledger write must never be able to take down the page whose work it
 * is recording — the proposals are the product, the ledger is the measurement.
 */
export function recordProposalSlate(leagueId, season, { ideas = [], result = null,
  modelVersion = null, proposerTeamId = null } = {}) {
  const out = { state: 'recorded', proposed: 0, considered: 0, skipped: 0, reason: null };
  if (!tableExists('trade_outcomes')) {
    return { ...out, state: 'ledger_absent',
      reason: 'trade_outcomes does not exist on this database — migration 067 has not run here' };
  }
  if (!result || result.source === 'cache') {
    return { ...out, state: 'no_decision_made',
      reason: result
        ? 'this slate was served from cache, so no decision was made on this request and '
          + 'recording one would count a single decision once per page open'
        : 'no proposals result was given, so there is nothing to record' };
  }

  // A refused run made no selection. The call was refused (no key, budget
  // spent), or the answer could not be read, so the model never chose or passed
  // over any idea on this slate. Writing the slate as "not selected" would put a
  // decision in the ledger that nobody made. `all_rejected` is the exception: the
  // model did choose, and the verifier said why each choice died.
  if (result.refused && result.problem !== 'all_rejected') {
    return { ...out, state: 'no_decision_made',
      reason: `the proposals run made no selection (${result.problem ?? 'refused'}: `
        + `${result.reason ?? 'no reason given'}), so no idea on this slate was chosen or passed over` };
  }

  // What was sent, in the verifier's shape: a proposal cites `idea_ids`, a LIST,
  // because one proposal may merge two ideas (trade-proposals.js
  // REQUIRED_PROPOSAL_FIELDS). Every cited idea was sent.
  const sent = new Set((result.proposals ?? []).flatMap(citedIdeas));

  // Why each dropped idea was dropped, from the run's own words where it has
  // them. A rejection is `{ proposal, violations }`; every idea the discarded
  // proposal cited carries the verifier's violations. Anything else the model
  // simply did not choose, and saying so is more honest than attributing a
  // reason the run never gave.
  const rejectedReason = new Map();
  for (const r of result.rejected ?? []) {
    const violations = Array.isArray(r?.violations) ? r.violations.map(String).filter(Boolean) : [];
    if (!violations.length) continue;
    for (const id of citedIdeas(r?.proposal)) {
      const prior = rejectedReason.get(id);
      rejectedReason.set(id, prior
        ? `${prior}; ${violations.join('; ')}`
        : `the proposals verifier discarded the proposal citing it: ${violations.join('; ')}`);
    }
  }

  for (const idea of ideas) {
    const id = idea?.id == null ? null : String(idea.id);
    if (!id) { out.skipped++; continue; }
    const common = {
      league_id: leagueId, season, idea_id: id,
      proposer_team_id: proposerTeamId, counterparty_team_id: counterpartyOf(idea),
      // The engine's own names for the package (trade-engine.js:1691).
      give: idea?.i_give ?? [], get: idea?.i_get ?? [],
      acceptance: idea?.acceptance ?? null, model_version: modelVersion,
    };
    const already = row(`SELECT id FROM trade_outcomes
      WHERE league_id = ? AND season = ? AND idea_id = ? AND source = ?`,
    leagueId, season, id, sent.has(id) ? 'app_proposed' : 'considered_only');
    if (already) { out.skipped++; continue; }

    if (sent.has(id)) {
      // An idea with no acceptance band cannot be an app_proposed row: the table
      // requires the prediction, precisely so an unscoreable row is not written.
      if (common.acceptance?.band?.mid == null) { out.skipped++; continue; }
      recordProposedOutcome(common);
      out.proposed++;
    } else {
      recordConsideredOnly({
        ...common,
        not_proposed_reason: rejectedReason.get(id)
          ?? 'the model did not select it from the slate, and the run gave no reason of its own',
      });
      out.considered++;
    }
  }
  return out;
}

/** The slate ids one proposal cites, as strings. `idea_ids` is a list. */
function citedIdeas(proposal) {
  return (Array.isArray(proposal?.idea_ids) ? proposal.idea_ids : [])
    .filter(x => x != null && String(x).trim())
    .map(String);
}

/**
 * The other side of a deal: the engine's `partner_id` (trade-engine.js:1689,
 * `them.roster_id`). `idea.counterparty` is the engine's read of that manager
 * and carries no roster id, and `idea.partner` is his display name.
 */
function counterpartyOf(idea) {
  const v = idea?.partner_id ?? null;
  return v == null ? null : String(v);
}

/** Every real outcome for one league-season, oldest first. Synthetic rows are not here. */
export function outcomesFor(leagueId, season) {
  if (!tableExists('trade_outcomes')) return [];
  return rows(`SELECT * FROM trade_outcomes WHERE league_id = ? AND season = ?
               ORDER BY COALESCE(proposed_at, created_at), id`, leagueId, season);
}

/* ------------------------------------------------ the offer loop (CLONE-01b b1) */

/**
 * How long an offer with no ESPN trace stays open before it settles 'expired'.
 * A GUESS, not a measured ESPN setting: the league's own proposal expiry is not
 * read anywhere yet. Seven days is past any reply seen in the collector's sample.
 */
export const OFFER_EXPIRE_DAYS = 7;
/** How far from the tap an ESPN proposal may sit and still be the one he sent. */
export const OFFER_MATCH_WINDOW_HOURS = 48;
const HOUR_MS = 3_600_000;

const hasSentColumns = () => tableExists('trade_outcomes')
  && rows(`PRAGMA table_info(trade_outcomes)`).some(c => c.name === 'sent_at');

/** The ESPN ids of one side of a deal, sorted; null if any player has none. */
function espnIdsOf(players) {
  const ids = (players ?? []).map(p => p?.espn_id ?? p?.playerId ?? null);
  if (!ids.length || ids.some(x => x == null)) return null;
  return ids.map(String).sort();
}
const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The app-side key for a deal: the engine's own id when it has one (the slate
 * cites it, so a tap on a slate suggestion lands on that row), else partner and
 * players, so the same package tapped twice is still one offer.
 */
function offerKeyOf(deal) {
  if (deal?.id != null && String(deal.id).trim()) return String(deal.id);
  const side = ps => (ps ?? []).map(p => p?.espn_id ?? p?.id ?? p?.name).map(String).sort().join('+');
  return `${deal?.partner_id ?? '?'}:${side(deal?.i_give)}>${side(deal?.i_get)}`;
}

/** The price bands 083 allows: where the sent deal sat against the card's yes-point. */
export const PRICE_BANDS = Object.freeze(['below', 'at_point', 'above']);

const hasSeamColumns = () => rows(`PRAGMA table_info(trade_outcomes)`).some(c => c.name === 'price_band');

/**
 * "I sent this." Nick proposed this deal on ESPN himself; the app records that
 * it was sent and what the model said about it. It never sends anything.
 *
 * If the slate already wrote this suggestion as `app_proposed`, THAT row is
 * marked sent: its prediction is the one made when the deal was suggested, and
 * a second row would count one offer twice. Otherwise a new row is written
 * through `recordProposedOutcome`, which refuses a deal with no band.
 *
 * `move_id` and `price_band` (FIX-07, columns from 083) come from a War Room
 * card: the campaign move this offer is a step of, and whether the deal sent sat
 * below, at or above the card's yes-point. The TradeCard tap sends neither.
 */
export function recordSentOffer({ league_id, season, proposer_team_id = null, deal,
  model_version = null, sent_at = null, move_id = null, price_band = null } = {}) {
  requireFields({ league_id, season, deal }, ['league_id', 'season', 'deal']);
  if (!hasSentColumns()) {
    throw new Error('trade-outcomes: trade_outcomes.sent_at does not exist — migration 080 has not run here');
  }
  const seam = move_id != null || price_band != null;
  if (price_band != null && !PRICE_BANDS.includes(price_band)) {
    throw new Error(`trade-outcomes: price_band must be one of ${PRICE_BANDS.join(', ')}`);
  }
  if (seam && !hasSeamColumns()) {
    throw new Error('trade-outcomes: trade_outcomes.price_band does not exist — migration 083 has not run here');
  }
  const sentAt = sent_at ?? new Date().toISOString();
  const ideaId = offerKeyOf(deal);
  const existing = row(`SELECT id, sent_at FROM trade_outcomes
    WHERE league_id = ? AND season = ? AND idea_id = ? AND source = 'app_proposed'`,
  league_id, season, ideaId);
  if (existing?.sent_at) return { state: 'already_sent', id: existing.id };
  const stampSeam = id => {
    if (seam) run(`UPDATE trade_outcomes SET move_id = COALESCE(?, move_id), price_band = COALESCE(?, price_band)
                   WHERE id = ?`, move_id, price_band, id);
  };
  if (existing) {
    run(`UPDATE trade_outcomes SET sent_at = ?, proposer_team_id = COALESCE(proposer_team_id, ?)
         WHERE id = ?`, sentAt, proposer_team_id, existing.id);
    stampSeam(existing.id);
    return { state: 'marked_sent', id: existing.id };
  }
  const id = recordProposedOutcome({
    league_id, season, proposer_team_id,
    counterparty_team_id: deal.partner_id == null ? null : String(deal.partner_id),
    give: deal.i_give ?? [], get: deal.i_get ?? [], proposed_at: sentAt,
    acceptance: deal.acceptance ?? null, model_version, idea_id: ideaId,
  });
  run(`UPDATE trade_outcomes SET sent_at = ? WHERE id = ?`, sentAt, id);
  stampSeam(id);
  return { state: 'recorded', id };
}

/**
 * Undo one "I sent this" inside its undo window (War Room retract). Only a row
 * ESPN has not yet settled or matched goes back to unsent; one that has is left
 * alone and says so, because ESPN's record outranks the tap.
 */
export function unmarkSentOffer(id) {
  const o = row(`SELECT id, status, matched_tx_id, sent_at FROM trade_outcomes WHERE id = ?`, id);
  if (!o) return { state: 'absent', id };
  if (!o.sent_at) return { state: 'not_sent', id };
  if (o.status !== 'proposed' || o.matched_tx_id != null) {
    return { state: 'kept', id, reason: `ESPN already has this offer (${o.matched_tx_id ?? o.status}); the sent mark stays` };
  }
  run(`UPDATE trade_outcomes SET sent_at = NULL, settle_reason = NULL${hasSeamColumns() ? ', price_band = NULL, move_id = NULL' : ''}
       WHERE id = ?`, id);
  return { state: 'unmarked', id };
}

/** What ESPN recorded against one proposal, most decisive first. */
function replyTo(txId, related, counterparty, { withdrawnOk = false } = {}) {
  const after = related.get(txId) ?? [];
  for (const t of after) {
    const verdict = ANSWERS[t.type];
    if (verdict && t.execution_type === EXECUTED) {
      return { status: verdict, at: t.proposed_at ?? null, reason: `ESPN ${t.type} ${t.tx_id}` };
    }
  }
  const counter = after.find(t => t.type === PROPOSAL && t.execution_type === EXECUTED
    && String(t.team_id) === counterparty);
  if (counter) {
    return { status: 'countered', at: counter.proposed_at ?? null,
      counter: { tx_id: String(counter.tx_id), items: itemsOf(counter.items_json).items ?? null },
      reason: `ESPN counter proposal ${counter.tx_id} from team ${counterparty}` };
  }
  const cancel = after.find(t => t.type === PROPOSAL && t.execution_type === 'CANCEL');
  if (cancel) {
    // #409: a CANCEL by ESPN's expiry task is 'expired'; by anyone else it is Nick withdrawing
    // his own offer, which is not the other manager's silence. Unknown actor: as before.
    const actor = cancel.member_id ?? null;
    if (actor != null && !EXPIRY_ACTOR.test(actor) && withdrawnOk) {
      return { status: 'withdrawn', at: cancel.proposed_at ?? null,
        reason: `ESPN proposal ${txId} withdrawn by the proposer (CANCEL ${cancel.tx_id}) before any answer` };
    }
    return { status: 'expired', at: cancel.proposed_at ?? null,
      reason: actor != null && EXPIRY_ACTOR.test(actor)
        ? `ESPN expired proposal ${txId} (CANCEL ${cancel.tx_id}) with no answer`
        : `ESPN closed proposal ${txId} (CANCEL ${cancel.tx_id}) with no answer — withdrawn or expired` };
  }
  return null;
}

/**
 * Match every sent, still-open offer to the ESPN proposal Nick sent and settle
 * it from ESPN's reply. Reads `league_transactions_raw`; writes only the sent
 * rows' status, resolved_at, matched_tx_id, counter_json and settle_reason.
 *
 * A match is: proposed by his team, to the offer's counterparty, with exactly
 * the offer's players on each side (ESPN ids), within
 * OFFER_MATCH_WINDOW_HOURS of the tap, and not already claimed by another
 * offer. The closest in time wins.
 *
 * SILENCE IS NOT A DECLINE, AND NO EVIDENCE IS NOT SILENCE. An unmatched offer
 * expires only once the collector has looked at this league at least
 * OFFER_EXPIRE_DAYS past the tap. Before that it stays 'proposed' and says why.
 *
 * Idempotent: settled rows are never touched again, and a pending row's reason
 * is rewritten only when it changes. `now` only shapes the reason text.
 */
export function settleSentOffers(leagueId, season, { now = null,
  expireDays = OFFER_EXPIRE_DAYS } = {}) {
  const out = { state: 'settled', pending: 0, matched: 0, settled: 0, reason: null };
  if (!hasSentColumns()) {
    return { ...out, state: 'ledger_absent',
      reason: 'trade_outcomes.sent_at does not exist on this database — migration 080 has not run here' };
  }
  // Only the app's own sent offers: a screenshot row carries sent_at too (when it was posted), and is
  // settled by settleScreenshotOffers, never matched here as one of Nick's taps.
  const open = rows(`SELECT * FROM trade_outcomes WHERE league_id = ? AND season = ?
    AND sent_at IS NOT NULL AND status = 'proposed' AND source = 'app_proposed' ORDER BY sent_at, id`, leagueId, season);
  const setReason = (o, reason) => {
    if (o.settle_reason !== reason) run(`UPDATE trade_outcomes SET settle_reason = ? WHERE id = ?`, reason, o.id);
  };
  if (!tableExists(RAW_TABLE)) {
    for (const o of open) setReason(o, `left pending: ${RAW_ABSENT_REASON}`);
    return { ...out, state: 'raw_table_absent', pending: open.length, reason: RAW_ABSENT_REASON };
  }

  const memberCol = rows(`PRAGMA table_info(${RAW_TABLE})`).some(c => c.name === 'member_id') ? 'member_id' : 'NULL AS member_id';
  const withdrawnOk = allowsWithdrawn(appDb);
  const tx = rows(`SELECT tx_id, type, execution_type, team_id, ${memberCol}, related_tx_id, proposed_at, items_json,
                          last_seen_at
                   FROM ${RAW_TABLE} WHERE league_id = ? AND season = ?`, leagueId, season);
  const related = new Map();
  for (const t of tx) {
    if (t.related_tx_id == null) continue;
    const k = String(t.related_tx_id);
    (related.get(k) ?? related.set(k, []).get(k)).push(t);
  }
  // His counter to someone else's offer carries a related_tx_id and is still an
  // offer he sent, so it is not filtered out here; the team check does that job.
  const proposals = tx.filter(t => t.type === PROPOSAL && t.execution_type === EXECUTED);
  const claimed = new Set(rows(`SELECT matched_tx_id FROM trade_outcomes WHERE league_id = ? AND season = ?
    AND matched_tx_id IS NOT NULL`, leagueId, season).map(r => String(r.matched_tx_id)));
  const seen = tx.map(t => Date.parse(t.last_seen_at)).filter(Number.isFinite);
  const lastLooked = seen.length ? Math.max(...seen) : null;
  const lastLookedIso = lastLooked == null ? 'never' : new Date(lastLooked).toISOString();
  const nowMs = now == null ? Date.now() : Date.parse(now);

  for (const o of open) {
    const sentMs = Date.parse(o.sent_at);
    const proposer = o.proposer_team_id == null ? null : String(o.proposer_team_id);
    const counterparty = o.counterparty_team_id == null ? null : String(o.counterparty_team_id);
    const deadline = sentMs + expireDays * 24 * HOUR_MS;
    const covered = lastLooked != null && lastLooked >= deadline;
    let txId = o.matched_tx_id == null ? null : String(o.matched_tx_id);

    if (!txId) {
      const giveRead = itemsOf(o.give_json);
      const getRead = itemsOf(o.get_json);
      if (giveRead.error || getRead.error) {
        setReason(o, `left pending: the offer's stored package cannot be read (${giveRead.error ?? getRead.error})`);
        out.pending++;
        continue;
      }
      const give = espnIdsOf(giveRead.items);
      const get = espnIdsOf(getRead.items);
      if (!proposer || !counterparty || !give || !get) {
        setReason(o, 'left pending: the offer is missing its teams or an ESPN id on a player, '
          + 'so it cannot be matched to an ESPN proposal');
        out.pending++;
        continue;
      }
      let best = null;
      for (const p of proposals) {
        if (String(p.team_id) !== proposer || claimed.has(String(p.tx_id))) continue;
        const gap = Math.abs(Date.parse(p.proposed_at) - sentMs);
        if (!(gap <= OFFER_MATCH_WINDOW_HOURS * HOUR_MS)) continue;
        const sides = sidesOf(p);
        if (sides.error || sides.counterparty !== counterparty) continue;
        if (!sameIds(give, espnIdsOf(sides.give) ?? []) || !sameIds(get, espnIdsOf(sides.get) ?? [])) continue;
        if (!best || gap < best.gap) best = { tx: p, gap };
      }
      if (best) {
        txId = String(best.tx.tx_id);
        claimed.add(txId);
        run(`UPDATE trade_outcomes SET matched_tx_id = ? WHERE id = ?`, txId, o.id);
        out.matched++;
      }
    }

    if (txId) {
      const reply = replyTo(txId, related, counterparty, { withdrawnOk });
      if (reply) {
        run(`UPDATE trade_outcomes SET status = ?, resolved_at = ?, counter_json = ?, settle_reason = ?
             WHERE id = ?`, reply.status, reply.at, reply.counter ? JSON.stringify(reply.counter) : null,
        `matched ESPN proposal ${txId}; ${reply.reason}`, o.id);
        out.settled++;
      } else if (covered) {
        run(`UPDATE trade_outcomes SET status = 'expired', resolved_at = ?, settle_reason = ? WHERE id = ?`,
          new Date(deadline).toISOString(), `matched ESPN proposal ${txId}; no answer recorded in `
          + `${expireDays} days (collector last looked ${lastLookedIso})`, o.id);
        out.settled++;
      } else {
        setReason(o, `matched ESPN proposal ${txId}; no answer yet (collector last looked ${lastLookedIso})`);
        out.pending++;
      }
      continue;
    }

    if (covered) {
      run(`UPDATE trade_outcomes SET status = 'expired', resolved_at = ?, settle_reason = ? WHERE id = ?`,
        new Date(deadline).toISOString(), `no ESPN proposal matched this offer in ${expireDays} days `
        + `(collector last looked ${lastLookedIso})`, o.id);
      out.settled++;
      continue;
    }
    const clockPast = Number.isFinite(nowMs) && nowMs >= deadline;
    setReason(o, `left pending: no ESPN proposal from team ${proposer} to team ${counterparty} with these `
      + `players within ${OFFER_MATCH_WINDOW_HOURS}h of the tap; the collector last looked ${lastLookedIso}`
      + (clockPast ? ` and has not looked since the ${expireDays}-day window closed, so it cannot be called expired`
        : ''));
    out.pending++;
  }
  return out;
}

/**
 * The post-sync job: observed rows first (every ESPN proposal becomes a row),
 * then the sent offers settled against the same raw rows. Idempotent.
 */
export function settleOfferLoop(leagueId, season, opts = {}) {
  return { observed: settleObservedOutcomes(leagueId, season), sent: settleSentOffers(leagueId, season, opts) };
}

/* ------------------------------------- offers read off chat screenshots (SCREENSHOT-OFFERS) */

/**
 * An offer read off an ESPN screenshot someone posted in the league chat. The parse runs on
 * Nick's Mac (scripts/chat/screenshot_offers.py, on-device OCR); scripts/chat/
 * feed_screenshot_offers.mjs hands the confident, real offers to the writer below.
 *
 * WHAT A SCREENSHOT ROW IS, HONESTLY. It has no ESPN tx id (else it is ESPN's own row and
 * is skipped as a duplicate) and NO PREDICTION: nobody scored it when it was sent, so
 * model_p_accept and its band stay NULL and the settle_reason says so. A grader can use
 * it as an outcome and never as a scored prediction. `proposed_at` is the date on the
 * screen when the screen shows one, else the posting time (an upper bound, said so in
 * settle_reason), else NULL for an accepted/declined screen that shows no date.
 *
 * NOTHING COUNTS TWICE. Before writing, the offer is looked for:
 *   - among ESPN's own proposals (same two teams, same players, within
 *     SCREENSHOT_DEDUP_HOURS): found => 'espn_duplicate', nothing written; the same two
 *     teams with mostly the same players (SCREENSHOT_NEAR_JACCARD) => 'espn_near_duplicate',
 *     nothing written either (a cropped screen or an edit before Send is still ESPN's offer);
 *   - among app offers Nick marked sent: found => 'app_duplicate', nothing written;
 *   - among earlier screenshot rows (the same offer posted twice, or its pending screen
 *     then its accepted screen): found => that row is settled from the newer screen if it
 *     was still 'proposed', nothing new is written.
 * A FINALIZE or pending OFFER screen is a SENT offer (Nick, 9/25: he knows his league), with sent_at
 * = when it was posted. Its outcome comes from ESPN (screenshotOutcomeOf): a paired orphan answer, an
 * executed trade with the same players, or 'declined' (screenshot_not_executed) once SCREENSHOT_SETTLE_DAYS
 * pass with neither.
 * An ESPN answer or close whose proposal row ESPN no longer serves (an orphan, which the
 * grader cannot place in time) is not a duplicate: it SETTLES the screenshot row, and the
 * row gains the proposal time the orphan lacks. `matched_tx_id` then names that proposal.
 */
export const SCREENSHOT_SOURCE = 'observed_screenshot';
export const SCREENSHOT_DEDUP_HOURS = 72;
/** Share of players (intersection over union) at which an ESPN proposal between the same teams is this offer. */
export const SCREENSHOT_NEAR_JACCARD = 0.6;
const SCREENSHOT_STATUSES = Object.freeze(['proposed', 'accepted', 'declined']);
const DECIDED = new Set(['accepted', 'declined', 'countered', 'expired', 'withdrawn']);

const screenshotReady = () => tableExists('trade_outcomes')
  && /'observed_screenshot'/.test(row(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'trade_outcomes'`)?.sql ?? '');

/** Sorted ESPN player ids of a list of items, or null when one has none. */
function espnSet(items) {
  const ids = (items ?? []).map(i => i?.playerId ?? i?.espn_id ?? null);
  if (ids.some(x => x == null)) return null;
  return ids.map(String).sort();
}
const pairOf = (a, b) => [String(a), String(b)].sort().join('|');

function parseList(json) {
  const r = itemsOf(json);
  return r.error ? null : r.items;
}

/**
 * ESPN's trace of a screenshot offer, if any: its proposal ('proposal', a duplicate), or an
 * orphan answer/close whose proposal is not in the collected rows ('orphan', a settle).
 * `o` = { league_id, season, pair, players (sorted espn ids), at (ms) }.
 */
function espnTraceOf(o) {
  if (!tableExists(RAW_TABLE)) return null;
  const memberCol = rows(`PRAGMA table_info(${RAW_TABLE})`).some(c => c.name === 'member_id') ? 'member_id' : 'NULL AS member_id';
  const tx = rows(`SELECT tx_id, type, execution_type, team_id, ${memberCol}, related_tx_id, proposed_at, items_json
                   FROM ${RAW_TABLE} WHERE league_id = ? AND season = ? AND type IN ('TRADE_PROPOSAL', 'TRADE_ACCEPT', 'TRADE_DECLINE')`,
  o.league_id, o.season);
  const win = SCREENSHOT_DEDUP_HOURS * HOUR_MS;
  const same = t => {
    const items = parseList(t.items_json);
    if (!items?.length) return false;
    const parties = [...partiesOf(items)];
    const ids = espnSet(items);
    return parties.length === 2 && pairOf(...parties) === o.pair && ids && sameIds(ids, o.players);
  };
  const proposals = tx.filter(t => t.type === PROPOSAL && t.execution_type === EXECUTED);
  let best = null;
  let near = null;
  for (const p of proposals) {
    const gap = Math.abs(Date.parse(p.proposed_at) - o.at);
    if (!(gap <= win)) continue;
    if (same(p)) { if (!best || gap < best.gap) best = { tx: p, gap }; continue; }
    // Same two teams, mostly the same players: the screen missed a player (cropped, or one name
    // the OCR could not read) or the deal was edited before Send. Either way ESPN has this offer.
    const items = parseList(p.items_json) ?? [];
    const parties = [...partiesOf(items)];
    const ids = espnSet(items);
    if (parties.length !== 2 || pairOf(...parties) !== o.pair || !ids) continue;
    const union = new Set([...ids, ...o.players]);
    const j = ids.filter(x => o.players.includes(x)).length / union.size;
    if (j >= SCREENSHOT_NEAR_JACCARD && (!near || j > near.j)) near = { tx: p, j };
  }
  if (best) return { kind: 'proposal', tx_id: String(best.tx.tx_id) };
  if (near) return { kind: 'near_proposal', tx_id: String(near.tx.tx_id), jaccard: Math.round(near.j * 100) / 100 };
  return null;
}

/** Hours after the screenshot within which an orphan ESPN answer between the same two teams pairs with it. */
export const SCREENSHOT_PAIR_HOURS = 72;
/** Days after the screenshot within which an executed trade can settle it, and after which silence is 'expired'. */
export const SCREENSHOT_SETTLE_DAYS = 7;
/** settle_reason prefix of a screenshot offer that never became a trade: a confirmed no (Nick, 9/25). */
export const SCREENSHOT_NOT_EXECUTED = 'screenshot_not_executed';

/**
 * What became of a screenshot offer ESPN has no proposal row for (Nick, 9/25: a finalize or pending
 * screen posted in the chat is a SENT offer). In order:
 *   1. an ORPHAN answer: ESPN's accept/decline whose proposal row is gone, answered by the receiving
 *      team within SCREENSHOT_PAIR_HOURS after the post; its proposal's close row (if any) must name
 *      the proposer, and when the orphan's items name players they must overlap by
 *      SCREENSHOT_NEAR_JACCARD. A veto after an accept stays 'accepted' (the receiver said yes).
 *   2. an EXECUTED trade between the two teams within SCREENSHOT_SETTLE_DAYS with at least 60% of
 *      the players: 'accepted'.
 *   3. neither, once the collector has looked past SCREENSHOT_SETTLE_DAYS: 'declined', settle_reason
 *      'screenshot_not_executed' (Nick, 9/25: a screenshot trade that doesn't get done is a confirmed no).
 * Null while the window is open. `claimed`: proposal ids other rows already paired with.
 * o = { league_id, season, from, to, players (sorted espn ids), seen (ms) }.
 */
function screenshotOutcomeOf(o, claimed = new Set()) {
  if (!tableExists(RAW_TABLE)) return null;
  const memberCol = rows(`PRAGMA table_info(${RAW_TABLE})`).some(c => c.name === 'member_id') ? 'member_id' : 'NULL AS member_id';
  const tx = rows(`SELECT tx_id, type, status, execution_type, team_id, ${memberCol}, related_tx_id, proposed_at, processed_at,
                          items_json, last_seen_at
                   FROM ${RAW_TABLE} WHERE league_id = ? AND season = ? AND type LIKE 'TRADE%'`, o.league_id, o.season);
  const from = String(o.from), to = String(o.to);
  const jaccard = items => {
    const ids = espnSet((items ?? []).filter(i => i?.playerId != null));
    if (!ids?.length) return null;
    const union = new Set([...ids, ...o.players]);
    return ids.filter(x => o.players.includes(x)).length / union.size;
  };
  const proposalIds = new Set(tx.filter(t => t.type === PROPOSAL && t.execution_type === EXECUTED).map(t => String(t.tx_id)));
  const byRelated = new Map();
  for (const t of tx) if (t.related_tx_id != null) (byRelated.get(String(t.related_tx_id)) ?? byRelated.set(String(t.related_tx_id), []).get(String(t.related_tx_id))).push(t);
  const pairEnd = o.seen + SCREENSHOT_PAIR_HOURS * HOUR_MS;
  const candidates = [];
  for (const [pid, kids] of byRelated) {
    if (proposalIds.has(pid) || claimed.has(pid)) continue;
    const answer = kids.find(k => ANSWERS[k.type] && k.execution_type === EXECUTED);
    if (!answer || String(answer.team_id) !== to) continue;
    const at = Date.parse(answer.proposed_at);
    if (!(at >= o.seen - HOUR_MS && at <= pairEnd)) continue;
    const close = kids.find(k => k.type === PROPOSAL && k.execution_type === 'CANCEL');
    if (close && close.team_id != null && String(close.team_id) !== from) continue;
    const items = [close, answer].map(k => parseList(k?.items_json)).find(x => x?.length) ?? null;
    if (items) {
      const parties = [...partiesOf(items)];
      if (parties.length === 2 && pairOf(...parties) !== pairOf(from, to)) continue;
      const j = jaccard(items);
      if (j != null && j < SCREENSHOT_NEAR_JACCARD) continue;
    }
    const vetoed = tx.some(v => v.type === 'TRADE_VETO' && [pid, String(answer.tx_id)].includes(String(v.related_tx_id)));
    candidates.push({ pid, answer, at, vetoed });
  }
  candidates.sort((a, b) => a.at - b.at);
  const c = candidates[0];
  if (c) {
    return { kind: 'orphan', tx_id: c.pid, status: ANSWERS[c.answer.type], at: c.answer.proposed_at,
      reason: `paired with ESPN ${c.answer.type} ${c.answer.tx_id} (its proposal ${c.pid} is not in the collected rows; `
        + `same two teams, ${Math.round((c.at - o.seen) / HOUR_MS)} h after the post)${c.vetoed ? ', then vetoed (still a yes)' : ''}` };
  }
  const settleEnd = o.seen + SCREENSHOT_SETTLE_DAYS * 24 * HOUR_MS;
  for (const t of tx) {
    if (!(t.type === 'TRADE_ACCEPT' && t.execution_type === 'PROCESS' && t.status === 'EXECUTED')) continue;
    const at = Date.parse(t.processed_at ?? t.proposed_at);
    if (!(at >= o.seen - HOUR_MS && at <= settleEnd)) continue;
    const items = parseList(t.items_json) ?? [];
    const parties = [...partiesOf(items)];
    const j = jaccard(items);
    if (parties.length === 2 && pairOf(...parties) === pairOf(from, to) && j != null && j >= 0.6) {
      const key = String(t.related_tx_id ?? t.tx_id);
      if (claimed.has(key)) continue;
      return { kind: 'executed', tx_id: key, status: 'accepted', at: t.processed_at ?? t.proposed_at,
        reason: `ESPN executed trade ${t.tx_id} between the same two teams with ${Math.round(j * 100)}% of the players` };
    }
  }
  const seen = tx.map(t => Date.parse(t.last_seen_at)).filter(Number.isFinite);
  const lastLooked = seen.length ? Math.max(...seen) : null;
  // Nick (9/25): "screenshots that are trades that don't get done = confirmed nos."
  if (lastLooked != null && lastLooked >= settleEnd) {
    return { kind: 'not_executed', tx_id: null, status: 'declined', at: new Date(settleEnd).toISOString(),
      reason: `${SCREENSHOT_NOT_EXECUTED}: no ESPN answer paired within ${SCREENSHOT_PAIR_HOURS} h and no executed trade with these `
        + `players within ${SCREENSHOT_SETTLE_DAYS} days (collector last looked ${new Date(lastLooked).toISOString()})` };
  }
  return null;
}

const claimedIds = (leagueId, season, exceptId = null) => new Set(rows(`SELECT matched_tx_id FROM trade_outcomes
  WHERE league_id = ? AND season = ? AND matched_tx_id IS NOT NULL AND id IS NOT ?`, leagueId, season, exceptId).map(r => String(r.matched_tx_id)));

/** An app offer Nick marked sent that is this same deal. */
function appCopyOf(o) {
  const win = SCREENSHOT_DEDUP_HOURS * HOUR_MS;
  if (!hasSentColumns()) return null;
  for (const a of rows(`SELECT id, proposer_team_id, counterparty_team_id, give_json, get_json, sent_at FROM trade_outcomes
      WHERE league_id = ? AND season = ? AND source = 'app_proposed' AND sent_at IS NOT NULL`, o.league_id, o.season)) {
    if (a.proposer_team_id == null || a.counterparty_team_id == null) continue;
    if (pairOf(a.proposer_team_id, a.counterparty_team_id) !== o.pair) continue;
    const ids = espnSet([...(parseList(a.give_json) ?? [{}]), ...(parseList(a.get_json) ?? [{}])]);
    if (ids && sameIds(ids, o.players) && Math.abs(Date.parse(a.sent_at) - o.at) <= win) return a;
  }
  return null;
}

/** An earlier screenshot row that is this same deal. */
function screenshotCopyOf(o) {
  const win = SCREENSHOT_DEDUP_HOURS * HOUR_MS;
  for (const s of rows(`SELECT * FROM trade_outcomes WHERE league_id = ? AND season = ? AND source = ?`,
    o.league_id, o.season, SCREENSHOT_SOURCE)) {
    if (pairOf(s.proposer_team_id, s.counterparty_team_id) !== o.pair) continue;
    const ids = espnSet([...(parseList(s.give_json) ?? [{}]), ...(parseList(s.get_json) ?? [{}])]);
    const at = Date.parse(s.proposed_at ?? s.created_at);
    if (ids && sameIds(ids, o.players) && Math.abs(at - o.at) <= win) return s;
  }
  return null;
}

/**
 * Record one offer read off a screenshot. `o`:
 *   league_id, season, attachment_guid, kind ('offer'|'finalize'|'accepted'|'declined'),
 *   status ('proposed'|'accepted'|'declined', what the screen shows), proposer_team_id,
 *   counterparty_team_id, give/get (items: { playerId (ESPN id), player_id, fromTeamId,
 *   toTeamId, fc_value, fc_captured_on }), proposed_at (null when the screen has no time),
 *   proposed_at_basis, seen_at (when it was posted), confidence (the parse's).
 * Returns { state, id?, matched_tx_id?, reason? }; states: recorded, already_recorded,
 * same_offer, espn_duplicate, espn_near_duplicate, app_duplicate,
 * refused, ledger_not_widened.
 */
export function recordScreenshotOffer(o) {
  requireFields(o, ['league_id', 'season', 'attachment_guid', 'status', 'seen_at']);
  if (!SCREENSHOT_STATUSES.includes(o.status)) {
    throw new Error(`trade-outcomes: a screenshot status must be one of ${SCREENSHOT_STATUSES.join(', ')}`);
  }
  if (!screenshotReady()) {
    return { state: 'ledger_not_widened',
      reason: "trade_outcomes.source does not allow 'observed_screenshot' here — migration 108 / its preflight repair has not run" };
  }
  const ideaId = `shot:${o.attachment_guid}`;
  const mine = row(`SELECT id FROM trade_outcomes WHERE league_id = ? AND season = ? AND idea_id = ? AND source = ?`,
    o.league_id, o.season, ideaId, SCREENSHOT_SOURCE);
  if (mine) return { state: 'already_recorded', id: mine.id };
  if (o.proposer_team_id == null || o.counterparty_team_id == null || String(o.proposer_team_id) === String(o.counterparty_team_id)) {
    return { state: 'refused', reason: 'a screenshot offer needs two different teams and a known proposer' };
  }
  const give = o.give ?? [];
  const get = o.get ?? [];
  const players = espnSet([...give, ...get]);
  if (!players?.length) return { state: 'refused', reason: 'no players, or a player with no ESPN id, so it cannot be matched or deduplicated' };
  const at = Date.parse(o.proposed_at ?? o.seen_at);
  const key = { league_id: o.league_id, season: o.season, pair: pairOf(o.proposer_team_id, o.counterparty_team_id), players, at };

  const trace = espnTraceOf(key);
  if (trace?.kind === 'proposal') return { state: 'espn_duplicate', matched_tx_id: trace.tx_id };
  if (trace?.kind === 'near_proposal') return { state: 'espn_near_duplicate', matched_tx_id: trace.tx_id, jaccard: trace.jaccard };
  const app = appCopyOf(key);
  if (app) return { state: 'app_duplicate', id: app.id };

  // Nick (9/25): a finalize or pending screen posted in the chat is a SENT offer, sent when posted.
  const seen = Date.parse(o.seen_at);
  const screenDecided = o.status !== 'proposed';
  const outcome = screenshotOutcomeOf({ league_id: o.league_id, season: o.season, from: o.proposer_team_id,
    to: o.counterparty_team_id, players, seen }, claimedIds(o.league_id, o.season));
  const status = screenDecided ? o.status : (outcome?.status ?? 'proposed');
  const resolvedAt = screenDecided ? (outcome && outcome.status === o.status ? outcome.at : o.seen_at) : (outcome?.at ?? null);
  const statusFrom = screenDecided ? `the ${o.status} screen (posted ${o.seen_at})` : (outcome?.reason ?? 'pending: no ESPN answer paired yet');
  const matched = outcome && (!screenDecided || outcome.status === o.status) ? outcome.tx_id : null;
  const reason = `${outcome?.kind === 'not_executed' && !screenDecided ? `${SCREENSHOT_NOT_EXECUTED}; ` : ''}`
    + `observed_screenshot: read off a chat screenshot (${o.kind ?? 'offer'} screen, parse confidence `
    + `${o.confidence ?? 'n/a'}); sent_at = when it was posted; proposed_at from `
    + `${o.proposed_at ? (o.proposed_at_basis ?? 'the screen') : 'nothing (no time on the screen)'}; `
    + `status from ${statusFrom}; no model prediction: this offer was never scored when it was sent`;

  const copy = screenshotCopyOf(key);
  if (copy) {
    if (copy.status === 'proposed' && DECIDED.has(status)) {
      run(`UPDATE trade_outcomes SET status = ?, resolved_at = ?, settle_reason = ?, matched_tx_id = COALESCE(matched_tx_id, ?)
           WHERE id = ? AND status = 'proposed'`, status, resolvedAt, `${reason} (settled by ${ideaId})`, matched, copy.id);
      return { state: 'same_offer', id: copy.id, settled: true };
    }
    return { state: 'same_offer', id: copy.id, settled: false };
  }

  const sentCol = hasSentColumns();
  const info = run(`INSERT INTO trade_outcomes
      (league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json, proposed_at,
       status, idea_id, resolved_at, matched_tx_id, settle_reason, created_at${sentCol ? ', sent_at' : ''})
    VALUES (?, ?, 'observed_screenshot', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${sentCol ? ', ?' : ''})`,
  o.league_id, o.season, String(o.proposer_team_id), String(o.counterparty_team_id),
  JSON.stringify(give), JSON.stringify(get), o.proposed_at ?? null, status, ideaId, resolvedAt,
  matched, reason, new Date().toISOString(), ...(sentCol ? [o.seen_at] : []));
  return { state: 'recorded', id: Number(info.lastInsertRowid), status, paired: outcome?.kind ?? null, matched_tx_id: matched };
}

/**
 * Settle still-pending screenshot rows from ESPN rows collected since: an orphan answer or
 * close settles it; ESPN's own proposal turning up means the row is a copy, which is said in
 * settle_reason and left 'proposed' (so no grader counts it). Idempotent.
 */
export function settleScreenshotOffers(leagueId, season) {
  const out = { state: 'settled', pending: 0, settled: 0, duplicates: 0, by_status: {} };
  if (!screenshotReady()) return { ...out, state: 'ledger_not_widened' };
  for (const s of rows(`SELECT * FROM trade_outcomes WHERE league_id = ? AND season = ? AND source = ? AND status = 'proposed'
                        ORDER BY COALESCE(sent_at, created_at), id`, leagueId, season, SCREENSHOT_SOURCE)) {
    const players = espnSet([...(parseList(s.give_json) ?? [{}]), ...(parseList(s.get_json) ?? [{}])]);
    if (!players) { out.pending++; continue; }
    const seen = Date.parse(s.sent_at ?? s.proposed_at ?? s.created_at);
    const trace = espnTraceOf({ league_id: leagueId, season, pair: pairOf(s.proposer_team_id, s.counterparty_team_id), players, at: seen });
    if (trace?.kind === 'proposal' || trace?.kind === 'near_proposal') {
      const why = `observed_screenshot: a copy of ESPN proposal ${trace.tx_id}, collected after the screenshot; left pending so it is not counted twice`;
      if (s.settle_reason !== why) run(`UPDATE trade_outcomes SET settle_reason = ? WHERE id = ?`, why, s.id);
      out.duplicates++;
      continue;
    }
    const outcome = screenshotOutcomeOf({ league_id: leagueId, season, from: s.proposer_team_id, to: s.counterparty_team_id,
      players, seen }, claimedIds(leagueId, season, s.id));
    if (!outcome) { out.pending++; continue; }
    run(`UPDATE trade_outcomes SET status = ?, resolved_at = ?, matched_tx_id = COALESCE(?, matched_tx_id), settle_reason = ?
         WHERE id = ? AND status = 'proposed'`, outcome.status, outcome.at, outcome.tx_id,
    `${outcome.kind === 'not_executed' ? `${SCREENSHOT_NOT_EXECUTED}; ` : ''}${s.settle_reason ?? 'observed_screenshot:'}; settled later from ${outcome.reason}`, s.id);
    out.settled++;
    out.by_status[outcome.status] = (out.by_status[outcome.status] ?? 0) + 1;
  }
  return out;
}
