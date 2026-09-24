/**
 * E1's evidence base: EVERY trade offer with a known answer in each ESPN
 * league, not only the ones this app sent — and each one scored as of the
 * moment it was proposed.
 *
 * WHY THE WHOLE LEAGUE. Waiting for 50 of Nick's own logged offers takes a
 * season or more. Every other manager's proposal is the same question (will
 * this person say yes to this offer?) with an answer ESPN already recorded.
 *
 * THE SET is decided-offers.js, the one producer of "decided offers" (E1-DATA):
 * its sources, every exclusion rule and the per-league counts live there.
 * This file only scores that set as of each offer's proposal time.
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
import { decidedOffers, loadDecidedOffers, OUTCOME } from './decided-offers.js';

export { OUTCOME };
export const ANCHOR_MIN_DECISIONS = 5;

const t = s => (s == null ? NaN : Date.parse(s));
const key = (...xs) => xs.map(String).join(':');

/**
 * The decided offers among already-read rows. `rows` are trade_outcomes rows,
 * `raw` league_transactions_raw rows. Offers with no proposal time (orphans)
 * are counted in `excluded.missing_proposal`, not returned.
 */
export function mergeOffers({ rows = [], raw = [], snapshots = [] } = {}) {
  const { offers, excluded } = decidedOffers({ outcomes: rows, raw, snapshots });
  return { offers, excluded };
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
 * Read every source present through the one producer. Without sent_at
 * (CLONE-01b, #239) no app row can be shown to have been sent, and `app_arm`
 * says why.
 */
export function loadLeagueOffers(database) {
  const built = loadDecidedOffers(database);
  const cols = new Set(database.prepare(`SELECT name FROM pragma_table_info('trade_outcomes')`).all().map(c => c.name));
  const appArm = built.sources.includes('trade_outcomes') && !cols.has('sent_at')
    ? 'source table trade_outcomes lacks column(s) sent_at; CLONE-01b (#239) adds it, so no app offer can be shown to have been sent'
    : null;
  return { offers: built.offers, excluded: built.excluded, by_league: built.by_league, sources: built.sources,
    app_arm: appArm, reason: built.reason };
}
