/**
 * E1's evidence base: EVERY trade offer with a known answer in each ESPN
 * league, not only the ones this app sent — and each one scored as of the
 * moment it was proposed.
 *
 * WHY THE WHOLE LEAGUE. Waiting for 50 of Nick's own logged offers takes a
 * season or more. Every other manager's proposal is the same question (will
 * this person say yes to this offer?) with an answer ESPN already recorded.
 *
 * SOURCES, merged, one row per offer:
 *   1. `trade_outcomes`, source 'observed' (settled from ESPN) and
 *      'app_proposed' rows that were SENT (`sent_at`, CLONE-01b #239). An
 *      app_proposed row without sent_at is a suggestion nobody sent: it has
 *      no reply to grade, and it must not hide a real ESPN offer either.
 *      There is no separate offer log (FIX-09): trade_outcomes is it.
 *   2. `league_transactions_raw`, read directly for proposals the settler has
 *      not written yet. Same reading as trade-outcomes.js#settleObservedOutcomes:
 *      a TRADE_PROPOSAL/EXECUTE row, answered by a TRADE_ACCEPT or
 *      TRADE_DECLINE EXECUTE row that names it in related_tx_id.
 *
 * EXCLUDED, and counted so the report can say so (in total, and per league
 * in `excluded_by_league`):
 *   - withdrawn: cancelled by the proposer (TRADE_PROPOSAL/CANCEL, no answer).
 *     The other side never decided, so it is not an outcome.
 *   - unanswered ('proposed', 'ignored'): silence is not a no.
 *   - no proposal time: an offer that cannot be placed in time cannot be
 *     scored as of anything.
 *   - unsent_app_offer: an app_proposed row with no sent_at (loaded rows are
 *     filtered in SQL; this counts rows handed in directly).
 *   - espn_copy_of_app_offer: an observed row that is the ESPN copy of a
 *     sent, resolved app_proposed row — the app row wins because it carries
 *     the recorded prediction. Matched first on `matched_tx_id` (the ESPN
 *     proposal the settle job tied the sent offer to); only a sent row with
 *     no match yet falls back to same league, season, proposer and
 *     counterparty with the ESPN time within 72 h after the app's, and it
 *     claims one copy, the earliest. An app row not yet resolved claims
 *     nothing, so its ESPN copy counts until the app row settles.
 *
 * AS-OF SCORING. An offer with a prediction recorded when it was made uses
 * that (it cannot be improved on later without scoring a different model). Any
 * other offer is REPLAYED through the production band, `acceptanceBand` in
 * trade-acceptance.js, fed only what was knowable at its proposal time: the
 * responder's accept rate over offers RESOLVED before this one was proposed,
 * withheld under five decisions exactly as manager-signals.js:336 withholds it.
 * The band's perception, receptiveness and says-no terms read chat and
 * profile state that is not stored with a date, so a replay cannot see them
 * as of then; they stay inert and the row says `basis: 'replay_anchor_only'`.
 */
import { acceptanceBand } from '../trade-acceptance.js';
import { readSource } from './common.js';

export const OUTCOME = Object.freeze({ accepted: 1, declined: 0, countered: 0, expired: 0 });
export const ANCHOR_MIN_DECISIONS = 5;
const DEDUP_WINDOW_MS = 72 * 3_600_000;

const TO_COLS = ['league_id', 'season', 'source', 'proposer_team_id', 'counterparty_team_id', 'proposed_at',
  'model_p_accept', 'status', 'espn_tx_id', 'idea_id', 'resolved_at'];
const SENT_COLS = ['sent_at', 'matched_tx_id'];
const RAW_COLS = ['league_id', 'season', 'tx_id', 'type', 'execution_type', 'team_id', 'related_tx_id', 'proposed_at', 'items_json'];

const t = s => (s == null ? NaN : Date.parse(s));
const bump = (byLeague, lg) => { byLeague[lg] = (byLeague[lg] ?? 0) + 1; };
const key = (...xs) => xs.map(String).join(':');

/** Proposer and the single counterparty of a raw proposal, or null. */
function partiesOf(tx) {
  if (tx.team_id == null) return null;
  let items;
  try { items = JSON.parse(tx.items_json || '[]'); } catch { return { error: 'items_json is not valid JSON' }; }
  if (!Array.isArray(items)) return { error: 'items_json is not a list' };
  const proposer = String(tx.team_id);
  const others = [...new Set(items.flatMap(i => [i?.fromTeamId, i?.toTeamId])
    .filter(x => x != null && Number(x) > 0).map(String))].filter(x => x !== proposer);
  return others.length === 1 ? { proposer, counterparty: others[0] } : { error: `${others.length} counterparties` };
}

/** Resolved offers straight from ESPN's raw rows. */
export function offersFromRaw(raw) {
  const out = [];
  const excluded = { withdrawn: 0, unanswered: 0, unreadable: 0 };
  const byLeague = {};
  const related = new Map();
  for (const r of raw) {
    if (r.related_tx_id == null) continue;
    const k = key(r.league_id, r.season, r.related_tx_id);
    (related.get(k) ?? related.set(k, []).get(k)).push(r);
  }
  for (const p of raw) {
    if (p.type !== 'TRADE_PROPOSAL' || p.execution_type !== 'EXECUTE') continue;
    const after = related.get(key(p.league_id, p.season, p.tx_id)) ?? [];
    const answer = after.find(a => (a.type === 'TRADE_ACCEPT' || a.type === 'TRADE_DECLINE') && a.execution_type === 'EXECUTE');
    if (!answer) {
      bump(byLeague, p.league_id);
      if (after.some(a => a.type === 'TRADE_PROPOSAL' && a.execution_type === 'CANCEL')) excluded.withdrawn += 1;
      else excluded.unanswered += 1;
      continue;
    }
    const sides = partiesOf(p);
    if (!sides || sides.error) { excluded.unreadable += 1; bump(byLeague, p.league_id); continue; }
    out.push({
      league_id: p.league_id, season: p.season, source: 'observed', proposer_team_id: sides.proposer,
      counterparty_team_id: sides.counterparty, proposed_at: p.proposed_at ?? null,
      resolved_at: answer.proposed_at ?? null, model_p_accept: null,
      status: answer.type === 'TRADE_ACCEPT' ? 'accepted' : 'declined', espn_tx_id: String(p.tx_id),
    });
  }
  return { offers: out, excluded, excluded_by_league: byLeague };
}

/**
 * Merge the sources into one list of resolved offers. `rows` are
 * trade_outcomes rows, `raw` league_transactions_raw rows.
 */
export function mergeOffers({ rows = [], raw = [] } = {}) {
  const excluded = { withdrawn: 0, unanswered: 0, unreadable: 0, no_proposal_time: 0, espn_copy_of_app_offer: 0, unsent_app_offer: 0 };
  const fromRaw = offersFromRaw(raw);
  for (const [k, v] of Object.entries(fromRaw.excluded)) excluded[k] += v;
  const byLeague = { ...fromRaw.excluded_by_league };
  const settled = new Set(rows.filter(r => r.espn_tx_id != null).map(r => key(r.league_id, r.season, r.espn_tx_id)));
  const all = [...rows, ...fromRaw.offers.filter(o => !settled.has(key(o.league_id, o.season, o.espn_tx_id)))];

  const unsent = o => o.source === 'app_proposed' && o.sent_at == null;
  const claimants = all.filter(o => o.source === 'app_proposed' && o.sent_at != null && Object.hasOwn(OUTCOME, o.status));
  const copies = new Set();
  const matched = new Set(claimants.filter(a => a.matched_tx_id != null).map(a => key(a.league_id, a.season, a.matched_tx_id)));
  const observed = all.filter(o => o.source === 'observed')
    .sort((a, b) => (t(a.proposed_at) || 0) - (t(b.proposed_at) || 0));
  for (const o of observed) if (o.espn_tx_id != null && matched.has(key(o.league_id, o.season, o.espn_tx_id))) copies.add(o);
  for (const a of claimants) {
    if (a.matched_tx_id != null || a.proposer_team_id == null) continue;
    const copy = observed.find(o => !copies.has(o) && o.league_id === a.league_id && o.season === a.season
      && String(a.proposer_team_id) === String(o.proposer_team_id)
      && String(a.counterparty_team_id) === String(o.counterparty_team_id)
      && t(o.proposed_at) >= t(a.proposed_at) && t(o.proposed_at) - t(a.proposed_at) <= DEDUP_WINDOW_MS);
    if (copy) copies.add(copy);
  }

  const out = [];
  for (const o of all) {
    const why = unsent(o) ? 'unsent_app_offer'
      : copies.has(o) ? 'espn_copy_of_app_offer'
        : !Object.hasOwn(OUTCOME, o.status) ? 'unanswered'
          : !Number.isFinite(t(o.proposed_at)) ? 'no_proposal_time' : null;
    if (why) { excluded[why] += 1; bump(byLeague, o.league_id); continue; }
    out.push({ ...o, y: OUTCOME[o.status] });
  }
  return { offers: out, excluded, excluded_by_league: byLeague };
}

/**
 * When an offer's answer became known. An offer with no recorded answer time
 * is treated as answered at its proposal time — the earliest it could have
 * been — only for ordering its OWN row; it never leaks into an offer proposed
 * at the same instant (strictly-before comparisons everywhere).
 */
const resolvedTime = o => (Number.isFinite(t(o.resolved_at)) ? t(o.resolved_at) : t(o.proposed_at));

/**
 * For each offer, the responder's decided offers and the league-wide ones that
 * were RESOLVED strictly before it was PROPOSED. O(n^2) on purpose: a league
 * has at most a few hundred offers a season, and the obvious code is the one
 * whose cutoff can be checked by eye.
 */
export function priorCounts(offers) {
  return offers.map(o => {
    const at = t(o.proposed_at);
    const cp = key(o.league_id, o.counterparty_team_id);
    let acc = 0; let n = 0; let accAll = 0; let nAll = 0;
    for (const q of offers) {
      if (q === o || !(resolvedTime(q) < at)) continue;
      accAll += q.y; nAll += 1;
      if (key(q.league_id, q.counterparty_team_id) === cp) { acc += q.y; n += 1; }
    }
    return { acc, n, accAll, nAll };
  });
}

/** The production band, fed only what was knowable when the offer was made. */
export function replayAsOf(prior) {
  const anchored = prior.n >= ANCHOR_MIN_DECISIONS;
  const band = acceptanceBand({
    counterparty: {
      counterparty_data: true,
      accept_rate: anchored ? prior.acc / prior.n : null,
      accept_rate_n: anchored ? prior.n : 0,
      perception_informed: false,
    },
    // The edge test asks whether a deal is good for NICK. For a replay of an
    // offer somebody actually sent, "would they say yes" is the question
    // whatever its edge, so the band is asked for directly.
    edge: { passes: true },
  }).band;
  return band ? band.mid : null;
}

/** Score every offer as of its proposal time. Adds p, basis, prior. */
export function scoreAsOf(offers) {
  const priors = priorCounts(offers);
  return offers.map((o, i) => {
    if (o.model_p_accept != null) return { ...o, p: Number(o.model_p_accept), basis: 'recorded', prior: priors[i] };
    return { ...o, p: replayAsOf(priors[i]), basis: 'replay_anchor_only', prior: priors[i] };
  }).filter(o => o.p != null && Number.isFinite(o.p));
}

/**
 * Read and merge every source present. Absent sources are reasons, not errors.
 * Without sent_at (CLONE-01b, #239, not merged) no app row can be shown to have
 * been sent, so only observed rows are read and `app_arm` says why.
 */
export function loadLeagueOffers(database) {
  const reasons = [];
  const sources = [];
  let appArm = null;
  let to = readSource(database, 'trade_outcomes', [...TO_COLS, ...SENT_COLS],
    `SELECT ${[...TO_COLS, ...SENT_COLS].join(', ')} FROM trade_outcomes
     WHERE source = 'observed' OR (source = 'app_proposed' AND sent_at IS NOT NULL)`);
  if (!to.ok && /lacks column/.test(to.reason)) {
    const observedOnly = readSource(database, 'trade_outcomes', TO_COLS,
      `SELECT ${TO_COLS.join(', ')} FROM trade_outcomes WHERE source = 'observed'`);
    if (observedOnly.ok) {
      appArm = `${to.reason}; CLONE-01b (#239) adds it, so no app offer can be shown to have been sent`;
      to = observedOnly;
    }
  }
  if (to.ok) sources.push('trade_outcomes'); else reasons.push(to.reason);
  const raw = readSource(database, 'league_transactions_raw', RAW_COLS,
    `SELECT ${RAW_COLS.join(', ')} FROM league_transactions_raw
     WHERE type IN ('TRADE_PROPOSAL', 'TRADE_ACCEPT', 'TRADE_DECLINE')`);
  if (raw.ok) sources.push('league_transactions_raw'); else reasons.push(raw.reason);
  const merged = mergeOffers({ rows: to.ok ? to.rows : [], raw: raw.ok ? raw.rows : [] });
  return { ...merged, sources, app_arm: appArm, reason: sources.length ? null : reasons.join('; ') };
}
