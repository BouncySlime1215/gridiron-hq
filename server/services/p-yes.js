/**
 * PYES-ONE: the one module every served "chance he says yes" goes through.
 *
 * WHY. Two screens priced P(yes) by calling trade-acceptance.js#acceptanceBand
 * themselves: the War Room (scripts/campaign/league-adapter.mjs priceStep) and
 * Trade Lab / Coach / trade cards (trade-engine.js attachTactics). A change to
 * the served number (PYES-BASELINE, #319) reached one and not the other. Every
 * production reader now asks `pYesFor` here; the only other importer of
 * `acceptanceBand` is the E1 grader's replay (eval/e1-league.js), which must
 * keep scoring the clone as of each offer.
 *
 * WHAT IS SERVED.
 *   flag off (default) -> the clone band, the exact object acceptanceBand returns.
 *   flag on            -> the E1 activity-only baseline (eval/e1.js#activityBaseline,
 *                         reused, not copied): the responder's accept rate over
 *                         offers RESOLVED before now, shrunk to the pooled rate
 *                         (eval/e1-league.js#priorCounts, the grader's cutoff).
 *                         It ignores the offer's content, so every package to one
 *                         manager gets the same p; the clone band rides along as
 *                         `challenger`. An idea that fails the edge test still
 *                         carries no number at all.
 *
 * FLAG. GRIDIRON_PYES_BASELINE=1 on; anything else off. No preview-mode default:
 * this moves a number Nick sees and is unmeasured on league 4 (ONE-PLAN L7: the
 * forward-only split favours the clone, 0.602 -> 0.666 log loss).
 */
import { acceptanceBand } from './trade-acceptance.js';
import { activityBaseline } from './eval/e1.js';
import { loadLeagueOffers, priorCounts } from './eval/e1-league.js';

export const PYES_ENV = 'GRIDIRON_PYES_BASELINE';
export const PYES_PRODUCER = 'p-yes';
export const PYES_BASIS = 'activity_baseline';
export const PYES_LABEL = 'activity baseline (E1 pending)';

/** On only when the env says exactly '1'. */
export function pYesFlag(env = process.env) {
  return { on: env[PYES_ENV] === '1' };
}

/**
 * Per-responder baseline as of `now`, from decided offers (e1-league.js#mergeOffers
 * shape: league_id, counterparty_team_id, proposed_at, resolved_at?, y).
 * Returns { byTeam: Map team -> { p, acc, n }, unseen: { p, n: 0 }, pooled: { acc, n }, as_of }.
 */
export function pYesTableFrom(offers, leagueId, teams = null, { now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  const seen = offers.filter(o => String(o.league_id) === String(leagueId)).map(o => o.counterparty_team_id);
  const list = [...new Set([...(teams ?? seen)].filter(t => t != null).map(String))];
  // Each team is scored as if an offer to it were proposed now: the grader's own cutoff.
  const probes = [...list, '__unseen__'].map(team => ({ league_id: leagueId, counterparty_team_id: team, proposed_at: at }));
  const priors = priorCounts([...offers, ...probes]).slice(offers.length);
  const ps = activityBaseline(probes, priors);
  const byTeam = new Map(list.map((t, i) => [t, { p: ps[i], acc: priors[i].acc, n: priors[i].n }]));
  const u = priors[priors.length - 1];
  return { byTeam, unseen: { p: ps[ps.length - 1], n: 0 }, pooled: { acc: u.accAll, n: u.nAll }, as_of: at };
}

/** The same table, reading decided offers from a database handle (node:sqlite). */
export function pYesTable(database, leagueId, teams = null, { now = Date.now() } = {}) {
  const { offers, reason } = loadLeagueOffers(database);
  const table = { ...pYesTableFrom(offers, leagueId, teams, { now }), league: String(leagueId), reason: reason ?? null };
  const why = fallbackReason(table);
  // Logged once per table read (per adapter build / finder search), not per offer.
  if (why) console.warn(`[p-yes] league ${leagueId}: serving the clone band, not the activity baseline: ${why}`);
  return table;
}

/**
 * Why a table cannot be served (null when it can). With no decided offer the baseline
 * is the pooled prior of an empty pool, 0.5 for everyone, and labelling that "activity
 * baseline" would be a number with nothing behind it: fail closed to the clone.
 */
export function fallbackReason(table) {
  if (!table) return 'no decided-offer table was read';
  if (table.reason) return `the decided-offer loader said: ${table.reason}`;
  if (!(table.pooled?.n > 0)) return 'no decided offers resolved before now, so the baseline is an empty prior';
  return null;
}

/**
 * The served acceptance for one offer, in acceptanceBand's shape.
 * table: pYesTable(...) or null; on: pYesFlag().on. With no table or the flag
 * off this IS acceptanceBand's return value, untouched. Flag on with a table that
 * cannot be served (fallbackReason), it is the clone plus `pyes_fallback` saying why.
 */
export function pYesFor({ counterparty = null, edge = null, profile = null, team = null, table = null, on = false } = {}) {
  const clone = acceptanceBand({ counterparty, edge, profile });
  if (!on || !table || !clone.band) return clone;
  const why = fallbackReason(table);
  if (why) return { ...clone, pyes_fallback: why };
  const row = table.byTeam.get(String(team)) ?? table.unseen;
  // A point, not a band: the baseline has no width. low = high = mid says so on the
  // existing band readers; `point` and `label` say it in words.
  return { ...clone, band: { low: row.p, mid: row.p, high: row.p }, point: true,
    basis: PYES_BASIS, label: PYES_LABEL, producer: PYES_PRODUCER, n: row.n,
    challenger: { band: clone.band, basis: clone.basis } };
}

/** The War Room step shape ({ p, band, basis }) from pYesFor's result. */
export function stepPYes(a) {
  const b = a.band;
  return { p: b?.mid ?? 0, band: b && !a.point ? { low: b.low, high: b.high } : null, basis: a.basis,
    ...(a.point ? { label: a.label, n: a.n } : {}) };
}
