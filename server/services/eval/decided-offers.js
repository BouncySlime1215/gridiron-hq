/**
 * THE decided-offers set: every trade offer in an ESPN league that its
 * receiver answered, one row per offer, with its terms and as-of timestamps.
 * This is the one producer. E1 (e1-league.js) grades it; any study or grader
 * that counts "decided offers" should read it here instead of re-deriving it,
 * because four readings of the same tables gave four different counts
 * (E1-DATA, 2026-09-24: 37 / 77 / 82 / 21).
 *
 * SOURCES, one row per (league, season, proposal tx id):
 *   - league_transactions_raw — the truth for ESPN offers. A TRADE_PROPOSAL/
 *     EXECUTE row is the offer; a TRADE_ACCEPT or TRADE_DECLINE EXECUTE row
 *     from the other team, naming it in related_tx_id, is the answer.
 *   - trade_outcomes — 'app_proposed' rows (the app's own offers, with the
 *     prediction recorded when made) and 'observed' rows (settled copies of the
 *     raw offers). An observed row's status was written once, the first time
 *     the settler saw the offer, and is never updated: an offer settled while
 *     still pending stays 'proposed' forever. So where the raw rows cover an
 *     offer, the raw answer decides; the row only lends its recorded
 *     prediction and idea id. Counted as `stale_outcome_row`.
 *   - trade_proposal_snapshots (#247, when built) — the offer's terms and
 *     proposal time as first seen. It fills a proposal the raw table lacks.
 *   - screenshot_proposals (SHOT-01, when built) is NOT read: it holds offers
 *     read off images with no ESPN tx id and no answer, so it cannot add a
 *     decision; `sources` says so.
 *
 * EXCLUDED, each counted per league (one rule per offer, first match wins):
 *   not_an_offer           trade_outcomes 'considered_only' rows: never sent.
 *   unsent_app_offer       app_proposed row with no sent_at: nobody sent it.
 *   unlinked_answer        an ACCEPT/DECLINE with no related_tx_id that no
 *                          other row answers: nothing says which offer it is
 *                          (counted per answer).
 *   answer_to_non_proposal an answer whose related_tx_id names a transaction
 *                          that is not a proposal (seen: an ACCEPT answering a
 *                          pending ACCEPT). There is no offer row to read terms
 *                          or a proposer from, and no reading of ESPN's flow
 *                          makes it one; counted once per parent.
 *   withdrawn              the proposer cancelled before any answer.
 *   expired                ESPN's TradeTaskProcessor closed it at expiry with
 *                          no answer. Silence is not a no.
 *   unanswered             no answer and no close yet (still pending, or a
 *                          trade_outcomes row still 'proposed'/'ignored').
 *   unreadable             more than one counterparty, or no parties at all.
 *   missing_proposal       answered, but the proposal row was never collected
 *                          (ESPN only serves ~3 days back) and no snapshot
 *                          has it: no proposal time, so it cannot be scored as
 *                          of anything. Kept in `orphans` with the answer time,
 *                          which is only an upper bound on when it was made.
 *   no_proposal_time       a trade_outcomes row with no proposed_at.
 *   duplicate_outcome_row  a second trade_outcomes row for the same ESPN tx.
 *   espn_copy_of_app_offer the ESPN copy of a sent, resolved app offer: the
 *                          app row wins because it carries the prediction.
 *                          Matched on matched_tx_id, else same league, season,
 *                          proposer and counterparty within 72 h after.
 *
 * Accepted then vetoed still counts as accepted: the receiver said yes.
 */
import { readSource } from './common.js';

export const OUTCOME = Object.freeze({ accepted: 1, declined: 0, countered: 0, expired: 0 });
export const EXCLUSION_RULES = Object.freeze([
  'not_an_offer', 'unsent_app_offer', 'unlinked_answer', 'answer_to_non_proposal', 'withdrawn', 'expired', 'unanswered', 'unreadable',
  'missing_proposal', 'no_proposal_time', 'duplicate_outcome_row', 'espn_copy_of_app_offer',
]);
const DEDUP_WINDOW_MS = 72 * 3_600_000;
const EXPIRY_ACTOR = /^TradeTaskProcessor/;
const ANSWER = { TRADE_ACCEPT: 'accepted', TRADE_DECLINE: 'declined' };

const TO_COLS = ['league_id', 'season', 'source', 'proposer_team_id', 'counterparty_team_id', 'proposed_at',
  'model_p_accept', 'status', 'espn_tx_id', 'idea_id', 'resolved_at'];
const TO_OPTIONAL = ['sent_at', 'matched_tx_id', 'give_json', 'get_json'];
const RAW_COLS = ['league_id', 'season', 'tx_id', 'type', 'execution_type', 'team_id', 'related_tx_id', 'proposed_at', 'items_json'];
const RAW_OPTIONAL = ['member_id', 'first_seen_at'];
const SNAP_COLS = ['league_id', 'season', 'proposal_tx_id', 'proposer_team_id', 'proposed_at', 'items_json'];

const t = s => (s == null ? NaN : Date.parse(s));
const key = (...xs) => xs.map(String).join(':');
const emptyCounts = () => Object.fromEntries(EXCLUSION_RULES.map(r => [r, 0]));

function parseItems(json) {
  if (json == null) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) && v.length ? v : null;
  } catch { return null; }
}

/** Teams on either side of a trade's items, excluding ids <= 0 (the pool). */
function teamsIn(items) {
  return [...new Set((items ?? []).flatMap(i => [i?.fromTeamId, i?.toTeamId])
    .filter(x => x != null && Number(x) > 0).map(String))];
}

/**
 * Build the set from already-read rows. `outcomes` are trade_outcomes rows,
 * `raw` league_transactions_raw rows, `snapshots` trade_proposal_snapshots rows.
 * Returns `offers` (decided, placed in time: the set E1 grades), `orphans`
 * (decided, proposal never seen), `excluded` totals and `by_league` counts,
 * including `stale_outcome_row` (observed rows the raw answer overrode).
 */
export function decidedOffers({ outcomes = [], raw = [], snapshots = [] } = {}) {
  const byLeague = new Map();
  const league = lid => {
    const k = String(lid);
    if (!byLeague.has(k)) byLeague.set(k, { offers: 0, accepted: 0, orphans: 0, excluded: emptyCounts(), stale_outcome_row: 0 });
    return byLeague.get(k);
  };
  const exclude = (row, rule) => { league(row.league_id).excluded[rule] += 1; };

  const fromRaw = rawOfferGroups({ raw, snapshots, exclude });

  // ---- trade_outcomes rows
  const all = [];
  const seenObserved = new Set();
  const usedRaw = new Set();
  for (const o of outcomes) {
    if (o.source === 'considered_only' || o.status === 'not_proposed') { exclude(o, 'not_an_offer'); continue; }
    if (o.source === 'app_proposed') {
      if (o.sent_at == null) { exclude(o, 'unsent_app_offer'); continue; }
      all.push({ ...o, offer_id: o.idea_id != null ? `app:${o.idea_id}` : null, decided_at: o.resolved_at ?? null,
        proposal_basis: 'app_sent', terms: termsOfRow(o), terms_source: 'trade_outcomes' });
      continue;
    }
    const k = o.espn_tx_id == null ? null : key(o.league_id, o.season, o.espn_tx_id);
    if (k && seenObserved.has(k)) { exclude(o, 'duplicate_outcome_row'); continue; }
    if (k) seenObserved.add(k);
    const r = k ? fromRaw.get(k) : null;
    if (r) {
      usedRaw.add(k);
      // The settler writes a row once and never revisits it: an answer that
      // arrived later shows up here as a row still saying 'proposed'.
      if (!r.excluded && r.status !== o.status) league(o.league_id).stale_outcome_row += 1;
      all.push(r.excluded ? r : { ...r, model_p_accept: o.model_p_accept ?? null, idea_id: o.idea_id ?? null,
        terms: r.terms ?? termsOfRow(o), terms_source: r.terms ? r.terms_source : 'trade_outcomes' });
      continue;
    }
    all.push({ ...o, offer_id: o.espn_tx_id ?? null, decided_at: o.resolved_at ?? null,
      proposal_basis: 'trade_outcomes', terms: termsOfRow(o), terms_source: 'trade_outcomes' });
  }
  for (const [k, r] of fromRaw) if (!usedRaw.has(k)) all.push(r);

  // ---- the ESPN copy of a sent app offer
  const claimants = all.filter(o => o.source === 'app_proposed' && Object.hasOwn(OUTCOME, o.status));
  const matched = new Set(claimants.filter(a => a.matched_tx_id != null).map(a => key(a.league_id, a.season, a.matched_tx_id)));
  const observed = all.filter(o => o.source === 'observed' && !o.excluded)
    .sort((a, b) => (t(a.proposed_at ?? a.decided_at) || 0) - (t(b.proposed_at ?? b.decided_at) || 0));
  const copies = new Set(observed.filter(o => o.espn_tx_id != null && matched.has(key(o.league_id, o.season, o.espn_tx_id))));
  for (const a of claimants) {
    if (a.matched_tx_id != null || a.proposer_team_id == null) continue;
    const copy = observed.find(o => !copies.has(o) && o.league_id === a.league_id && o.season === a.season
      && String(a.proposer_team_id) === String(o.proposer_team_id)
      && String(a.counterparty_team_id) === String(o.counterparty_team_id)
      && t(o.proposed_at) >= t(a.proposed_at) && t(o.proposed_at) - t(a.proposed_at) <= DEDUP_WINDOW_MS);
    if (copy) copies.add(copy);
  }

  const offers = [];
  const orphans = [];
  for (const o of all) {
    if (o.excluded) { exclude(o, o.excluded); continue; }
    if (copies.has(o)) { exclude(o, 'espn_copy_of_app_offer'); continue; }
    if (!Object.hasOwn(OUTCOME, o.status)) { exclude(o, 'unanswered'); continue; }
    const y = OUTCOME[o.status];
    if (!Number.isFinite(t(o.proposed_at))) {
      if (o.proposal_basis === null) {
        exclude(o, 'missing_proposal');
        orphans.push({ ...o, y, proposed_before: o.decided_at });
        league(o.league_id).orphans += 1;
      } else exclude(o, 'no_proposal_time');
      continue;
    }
    offers.push({ ...o, y });
    const L = league(o.league_id);
    L.offers += 1; L.accepted += y;
  }

  const excluded = emptyCounts();
  for (const L of byLeague.values()) for (const r of EXCLUSION_RULES) excluded[r] += L.excluded[r];
  const by_league = Object.fromEntries([...byLeague].sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b)));
  return { offers, orphans, excluded, by_league };
}

/**
 * The raw ESPN rows grouped under the proposal each belongs to, one entry per
 * (league, season, proposal tx id): an answered offer, an orphan (answered, no
 * proposal row), or `{ excluded: rule }` for withdrawn / expired / unanswered /
 * unreadable. Exported so the trade_outcomes settler reads the SAME pairing
 * E1 grades, rather than a second one (LEDGER-BACKFILL). `exclude(row, rule)`
 * is called for the answers that attach to no offer at all.
 */
export function rawOfferGroups({ raw = [], snapshots = [], exclude = () => {} } = {}) {
  const proposals = new Map();
  const children = new Map();
  const nonProposals = new Map(); // tx id -> a row that is not a proposal
  for (const r of raw) {
    if (r.type === 'TRADE_PROPOSAL' && r.execution_type === 'EXECUTE') {
      proposals.set(key(r.league_id, r.season, r.tx_id), r);
      continue;
    }
    nonProposals.set(key(r.league_id, r.season, r.tx_id), r);
    if (r.related_tx_id != null) {
      const k = key(r.league_id, r.season, r.related_tx_id);
      (children.get(k) ?? children.set(k, []).get(k)).push(r);
    }
  }
  for (const [k, r] of nonProposals) {
    if (r.related_tx_id == null && ANSWER[r.type] && r.execution_type === 'EXECUTE' && !children.has(k)) exclude(r, 'unlinked_answer');
  }
  const snaps = new Map(snapshots.map(s => [key(s.league_id, s.season, s.proposal_tx_id), s]));

  const fromRaw = new Map(); // key -> offer, orphan or { excluded: rule }
  for (const k of new Set([...proposals.keys(), ...children.keys()])) {
    const p = proposals.get(k);
    if (!p && nonProposals.has(k)) { exclude(nonProposals.get(k), 'answer_to_non_proposal'); continue; }
    const kids = (children.get(k) ?? []).slice().sort((a, b) => (t(a.proposed_at) || 0) - (t(b.proposed_at) || 0));
    const anchor = p ?? kids[0];
    const [lid, season, txId] = [anchor.league_id, anchor.season, String(p ? p.tx_id : anchor.related_tx_id)];
    const snap = snaps.get(k);
    const close = kids.find(x => x.type === 'TRADE_PROPOSAL' && x.execution_type === 'CANCEL');
    // A decline also writes a CANCEL of the proposal; its team_id is the proposer.
    const proposer = p?.team_id ?? snap?.proposer_team_id ?? close?.team_id ?? null;
    const answer = kids.find(x => ANSWER[x.type] && x.execution_type === 'EXECUTE'
      && (proposer == null || String(x.team_id) !== String(proposer)));
    // Only an offer ESPN itself knows the proposal of is a candidate: a group
    // made of nothing but a PROCESS/UPHOLD row is bookkeeping, not an offer.
    if (!p && !answer && !close) continue;
    const base = { league_id: lid, season, espn_tx_id: txId };
    if (!answer) {
      const rule = close ? (EXPIRY_ACTOR.test(close.member_id ?? '') ? 'expired' : 'withdrawn') : 'unanswered';
      fromRaw.set(k, { ...base, excluded: rule, closed_at: close?.proposed_at ?? null, close_tx_id: close ? String(close.tx_id) : null });
      continue;
    }
    const sources = [[p?.items_json, 'proposal'], [snap?.items_json, 'snapshot'], [close?.items_json, 'close'], [answer.items_json, 'answer']];
    const found = sources.map(([j, s]) => [parseItems(j), s]).find(([v]) => v);
    const terms = found?.[0] ?? null;
    const others = teamsIn(terms).filter(x => x !== String(proposer));
    // An answer with no proposal, no snapshot and no close row has no proposer
    // on record; it is still an orphan (missing_proposal), not unreadable.
    if (others.length > 1 || (proposer != null && others.length === 1 && others[0] !== String(answer.team_id))) {
      fromRaw.set(k, { ...base, excluded: 'unreadable' });
      continue;
    }
    const proposedAt = p?.proposed_at ?? snap?.proposed_at ?? null;
    fromRaw.set(k, {
      ...base, source: 'observed', offer_id: txId,
      proposer_team_id: proposer == null ? null : String(proposer), counterparty_team_id: String(answer.team_id),
      proposed_at: proposedAt, proposal_basis: p ? 'proposal_row' : (snap?.proposed_at ? 'snapshot' : null),
      proposal_seen_at: p?.first_seen_at ?? null,
      resolved_at: answer.proposed_at ?? null, decided_at: answer.proposed_at ?? null, decision_tx_id: String(answer.tx_id),
      decision_seen_at: answer.first_seen_at ?? null,
      status: ANSWER[answer.type], vetoed: kids.some(x => x.type === 'TRADE_VETO'),
      terms, terms_source: found?.[1] ?? null, model_p_accept: null, idea_id: null,
    });
  }

  return fromRaw;
}

function termsOfRow(o) {
  const give = parseItems(o.give_json);
  const get = parseItems(o.get_json);
  return give || get ? { give: give ?? [], get: get ?? [] } : null;
}

/** Columns of `table` that exist, from `wanted`. */
function present(database, table, wanted) {
  const have = new Set(database.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(c => c.name));
  return wanted.filter(c => have.has(c));
}

/**
 * Read every source present and build the set. Absent sources are reasons,
 * not errors. `season` narrows every source when given.
 */
export function loadDecidedOffers(database, { season = null } = {}) {
  const reasons = [];
  const sources = [];
  const where = season == null ? '' : ' AND season = ?';
  const args = season == null ? [] : [Number(season)];

  let outcomes = [];
  const to = readSource(database, 'trade_outcomes', TO_COLS);
  if (to.ok) {
    const cols = [...TO_COLS, ...present(database, 'trade_outcomes', TO_OPTIONAL)];
    outcomes = database.prepare(`SELECT ${cols.join(', ')} FROM trade_outcomes WHERE 1 = 1${where}`).all(...args);
    sources.push('trade_outcomes');
  } else reasons.push(to.reason);

  let raw = [];
  const rr = readSource(database, 'league_transactions_raw', RAW_COLS);
  if (rr.ok) {
    const cols = [...RAW_COLS, ...present(database, 'league_transactions_raw', RAW_OPTIONAL)];
    raw = database.prepare(`SELECT ${cols.join(', ')} FROM league_transactions_raw
      WHERE type IN ('TRADE_PROPOSAL', 'TRADE_ACCEPT', 'TRADE_DECLINE', 'TRADE_VETO')${where}`).all(...args);
    sources.push('league_transactions_raw');
  } else reasons.push(rr.reason);

  let snapshots = [];
  const sn = readSource(database, 'trade_proposal_snapshots', SNAP_COLS);
  if (sn.ok) {
    snapshots = database.prepare(`SELECT ${SNAP_COLS.join(', ')} FROM trade_proposal_snapshots WHERE 1 = 1${where}`).all(...args);
    sources.push('trade_proposal_snapshots');
  } else reasons.push(sn.reason);
  reasons.push('screenshot_proposals is not read: an offer read off an image has no ESPN tx id or answer');

  const built = decidedOffers({ outcomes, raw, snapshots });
  const hasEvidence = sources.includes('trade_outcomes') || sources.includes('league_transactions_raw');
  return { ...built, sources, reasons, reason: hasEvidence ? null : reasons.join('; ') };
}
