/**
 * PYES-BASELINE: the ONE producer of the served "chance he says yes" (p_yes).
 *
 * WHY. R&D r33 FUSION-01 graded every candidate on the 2026 ESPN league
 * decisions: the served clone band (trade-acceptance.js#acceptanceBand
 * midpoint) ranked offers the wrong way (AUC 0.32), while the E1
 * activity-only baseline had the best log loss (0.554 vs base rate 0.561).
 * Until a challenger beats that baseline, the baseline is what is served.
 *
 * WHAT IS SERVED (flag on). The E1 grader's own activity-only baseline
 * (eval/e1.js#activityBaseline, reused, not copied): the responder's accept
 * rate over offers RESOLVED before now, shrunk to the pooled accept rate
 * (eval/e1-league.js#priorCounts, same cutoff rule). It knows nothing about
 * the offer's content, so every package to one manager gets the same number,
 * and it carries no band.
 *
 * THE CHALLENGER. The clone band stays computed, is attached to every step as
 * `p_yes_challenger` (logged in the plans file's `_run.next_step`), and is
 * graded by E1 (eval/e1.js grades the clone replay against this same
 * baseline). It is served again only when E1 grades it `passing`, i.e. its
 * log-loss gain over this baseline has a 95% anytime-valid CS above 0
 * (PROMOTION_RULE); the caller hands that status in as `challengerPassing`.
 *
 * FLAG. GRIDIRON_PYES_BASELINE=1 on, =0 off (vetoes preview), unset: on only
 * under preview-mode.js#previewUnconfirmed. Off, every served p_yes is the
 * incumbent clone band, byte for byte.
 */
import { activityBaseline } from '../eval/e1.js';
import { loadLeagueOffers, priorCounts } from '../eval/e1-league.js';
import { previewUnconfirmed, previewFields } from '../preview-mode.js';

export const PYES_ENV = 'GRIDIRON_PYES_BASELINE';
export const PYES_PRODUCER = 'people/p-yes';
export const PYES_VERSION = 'pyes-baseline-1';
export const PYES_LABEL = 'chance he says yes: activity baseline (clone not proven)';
export const PYES_BASIS = 'activity_baseline';
export const PREVIEW_REASON = 'PYES-BASELINE: activity-only P(yes) replaces the clone band (R&D r33 FUSION-01); default off until confirmed forward';
export const PROMOTION_RULE = 'a challenger is served only once E1 grades it passing: log-loss gain over the activity baseline, '
  + '95% anytime-valid CS > 0 (server/services/eval/e1.js)';

/** Flag reader, same shape as the other preview sites. */
export function pYesFlag(env = process.env) {
  if (env[PYES_ENV] === '1') return { on: true, preview: false };
  if (env[PYES_ENV] === '0') return { on: false, preview: false };
  return previewUnconfirmed() ? { on: true, preview: true, ...previewFields(PREVIEW_REASON) } : { on: false, preview: false };
}

/** The E1 activity baseline for one responder's prior counts { acc, n, accAll, nAll }. */
export function activityPYes(prior) {
  return activityBaseline([{}], [prior])[0];
}

/**
 * Per-responder P(yes) as of `now` from decided offers (e1-league.js#mergeOffers
 * shape: league_id, counterparty_team_id, proposed_at, resolved_at?, y).
 * Returns { byTeam: Map team -> { p, acc, n }, unseen: { p, acc: 0, n: 0 }, pooled: { acc, n }, as_of }.
 * A team with no decided offers gets `unseen` (the shrunk pooled rate).
 */
export function pYesTableFrom(offers, leagueId, teams = null, { now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  const probe = team => ({ league_id: leagueId, counterparty_team_id: team, proposed_at: at });
  const list = [...new Set([...(teams ?? offers.filter(o => String(o.league_id) === String(leagueId)).map(o => o.counterparty_team_id))]
    .filter(t => t != null).map(String))];
  const probes = [...list, '__unseen__'].map(probe);
  // Reuse the grader's cutoff exactly: probes are scored like an offer proposed now.
  const priors = priorCounts([...offers, ...probes]).slice(offers.length);
  const byTeam = new Map();
  list.forEach((t, i) => byTeam.set(t, { p: activityPYes(priors[i]), acc: priors[i].acc, n: priors[i].n }));
  const u = priors[priors.length - 1];
  return { byTeam, unseen: { p: activityPYes(u), acc: 0, n: 0 }, pooled: { acc: u.accAll, n: u.nAll }, as_of: at };
}

/** Same, reading the decided offers from a database (the served path). teams: null = every responder seen. */
export function pYesTable(database, leagueId, teams = null, { now = Date.now() } = {}) {
  const { offers, reason } = loadLeagueOffers(database);
  return { ...pYesTableFrom(offers, leagueId, teams, { now }), league: String(leagueId), reason: reason ?? null };
}

/*
 * The table per league for this process. counterparty-pricing.js#counterpartyLayer
 * (the per-league read every served path already makes: the campaign adapter and
 * the trade finder) builds it from the database and registers it here, so the
 * planner stays free of the database and there is still one producer.
 */
const tables = new Map();
export function registerPYesTable(leagueId, table) { tables.set(String(leagueId), table); return table; }
export function pYesTableFor(leagueId) { return tables.get(String(leagueId)) ?? null; }
export function clearPYesTables() { tables.clear(); }

/**
 * The served P(yes) for one offer. clone: the incumbent's { p, band, basis }.
 * Flag off -> the clone, unchanged. Flag on -> the baseline, with the clone as
 * the shadow challenger (never served unless challengerPassing).
 */
export function servePYes({ team, clone, table, on, challengerPassing = false }) {
  if (!on || !table || table.error) return clone;
  const challenger = { p: clone?.p ?? null, band: clone?.band ?? null, basis: clone?.basis ?? null };
  if (challengerPassing) return { ...clone, producer: PYES_PRODUCER, challenger: null, promoted: true };
  const row = table.byTeam.get(String(team)) ?? table.unseen;
  return { p: row.p, band: null, basis: PYES_BASIS, label: PYES_LABEL, producer: PYES_PRODUCER, n: row.n, challenger,
    ...(clone?.features ? { features: clone.features } : {}) };
}

/**
 * Wrap an adapter so every priceStep the planner and search make is served here.
 * Returns the wrapped adapter; `shadow(team, get, give)` returns the challenger
 * logged for that offer (or null).
 */
export function withPYes(adapter, table, { on = true, challengerPassing = false } = {}) {
  if (!on || !table || table.error) return { adapter, shadow: () => null, on: false };
  const log = new Map();
  const k = (team, a, b) => `${team}|${a.map(String).join(',')}|${b.map(String).join(',')}`;
  const priceStep = (team, theyGive, theyGet) => {
    const clone = adapter.priceStep(team, theyGive, theyGet);
    const served = servePYes({ team, clone, table, on, challengerPassing });
    if (served.challenger) log.set(k(team, theyGive, theyGet), served.challenger);
    return served;
  };
  return { adapter: { ...adapter, priceStep }, shadow: (team, get, give) => log.get(k(team, get, give)) ?? null, on: true };
}

/**
 * What the planner reports about the served P(yes) for one run (res.p_yes).
 * flag: pYesFlag() result; table: the league's table or null; used: withPYes result.
 */
export function pYesSummary(flag, table, used, { challengerPassing = false } = {}) {
  const head = { producer: PYES_PRODUCER, version: PYES_VERSION, rule: PROMOTION_RULE };
  if (!flag.on) return { ...head, status: 'off', served: 'clone', reason: `${PYES_ENV} unset: the clone band is served (incumbent)` };
  const pv = flag.preview ? { preview: true, preview_reason: flag.preview_reason } : {};
  if (!used.on) {
    return { ...head, ...pv, status: 'unknown', served: 'clone',
      reason: table?.error ?? 'no decided-offer table was read for this league, so the clone band is served' };
  }
  return { ...head, ...pv, status: 'ok', served: challengerPassing ? 'challenger' : PYES_BASIS, label: PYES_LABEL,
    as_of: table.as_of, pooled: table.pooled, unseen_p: table.unseen.p,
    by_team: Object.fromEntries([...table.byTeam].map(([t, r]) => [t, { p: r.p, n: r.n }])) };
}
