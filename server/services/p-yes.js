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
 * LIVE-BLEND (p-yes-blend.js) replaced that flag. Nick asked for live use (2026-09-24),
 * so the served p is ON by default and is the BLEND: weight x baseline + weight x clone,
 * the weights earned online from graded offers.
 *   GRIDIRON_PYES_BLEND unset or anything but '0' -> blend (default)
 *   GRIDIRON_PYES_BLEND=0                         -> activity baseline only
 * Either way, with no decided offer to learn from it fails closed to the clone band.
 * Nick's hard rules never read the served p: each step also carries `p_gate`, the
 * baseline p (what BLEND=0 would serve), and the one rule that reads a p (the served
 * move beats doing nothing on the confirm dice, planner.js#confirmGate) reads that.
 */
import { acceptanceBand } from './trade-acceptance.js';
import { activityBaseline } from './eval/e1.js';
import { loadLeagueOffers, priorCounts } from './eval/e1-league.js';
import { BLEND_BASIS, BLEND_ENV, BLEND_LABEL, blendP, blendState, probeEIG, basisSummary } from './p-yes-blend.js';

export { BLEND_BASIS, BLEND_LABEL };
/** LIVE-BLEND: the one env that sets the served P(yes) (was GRIDIRON_PYES_BASELINE under PYES-ONE). */
export const PYES_ENV = BLEND_ENV;
export const PYES_PRODUCER = 'p-yes';
export const PYES_BASIS = 'activity_baseline';
export const PYES_LABEL = 'activity baseline (E1 pending)';

/** LIVE-BLEND: on by default. mode 'blend' unless the env says exactly '0' (baseline only). */
export function pYesFlag(env = process.env) {
  return { on: true, mode: env[PYES_ENV] === '0' ? 'baseline' : 'blend' };
}

/**
 * Per-responder baseline as of `now`, from decided offers (e1-league.js#mergeOffers
 * shape: league_id, counterparty_team_id, proposed_at, resolved_at?, y).
 * Returns { byTeam: Map team -> { p, acc, n }, unseen: { p, n: 0 }, pooled: { acc, n }, as_of }.
 */
export function pYesTableFrom(offers, leagueId, teams = null, { now = Date.now(), mode = 'baseline' } = {}) {
  const at = new Date(now).toISOString();
  const seen = offers.filter(o => String(o.league_id) === String(leagueId)).map(o => o.counterparty_team_id);
  const list = [...new Set([...(teams ?? seen)].filter(t => t != null).map(String))];
  // Each team is scored as if an offer to it were proposed now: the grader's own cutoff.
  const probes = [...list, '__unseen__'].map(team => ({ league_id: leagueId, counterparty_team_id: team, proposed_at: at }));
  const priors = priorCounts([...offers, ...probes]).slice(offers.length);
  const ps = activityBaseline(probes, priors);
  const byTeam = new Map(list.map((t, i) => [t, { p: ps[i], acc: priors[i].acc, n: priors[i].n }]));
  const u = priors[priors.length - 1];
  return { byTeam, unseen: { p: ps[ps.length - 1], n: 0 }, pooled: { acc: u.accAll, n: u.nAll }, as_of: at, mode,
    // LIVE-BLEND: the weights, from every league's graded offers (pooled, shrunk to this league).
    ...(mode === 'blend' ? { blend: blendState(offers, leagueId, { now }) } : {}) };
}

/** The same table, reading decided offers from a database handle (node:sqlite). */
export function pYesTable(database, leagueId, teams = null, { now = Date.now(), mode = pYesFlag().mode } = {}) {
  const { offers, reason } = loadLeagueOffers(database);
  const table = { ...pYesTableFrom(offers, leagueId, teams, { now, mode }), league: String(leagueId), reason: reason ?? null };
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
  if (table.mode === 'blend' && table.blend) {
    // LIVE-BLEND: the band is the clone's band blended with the baseline point, so it keeps the
    // clone's width scaled by the clone's weight. p_gate is the baseline: the rules read that.
    const w = table.blend.weights;
    const at = c => blendP(w, { baseline: row.p, clone: c });
    return { ...clone, band: { low: at(clone.band.low), mid: at(clone.band.mid), high: at(clone.band.high) },
      basis: BLEND_BASIS, label: BLEND_LABEL, producer: PYES_PRODUCER, n: row.n,
      weights: { ...w }, p_gate: row.p, probe: probeEIG(w, { baseline: row.p, clone: clone.band.mid }),
      baseline: { p: row.p, n: row.n }, challenger: { band: clone.band, basis: clone.basis } };
  }
  // A point, not a band: the baseline has no width. low = high = mid says so on the
  // existing band readers; `point` and `label` say it in words.
  return { ...clone, band: { low: row.p, mid: row.p, high: row.p }, point: true,
    basis: PYES_BASIS, label: PYES_LABEL, producer: PYES_PRODUCER, n: row.n, p_gate: row.p,
    challenger: { band: clone.band, basis: clone.basis } };
}

/** Whether a served basis is one of p-yes.js's own (not the clone's). */
export function servedBasis(basis) {
  return basis === PYES_BASIS || basis === BLEND_BASIS;
}

/**
 * plans.json `p_yes_basis` value for a table (null with no table). Fallback: says why the clone
 * is served. Blend: each model's weight and record. Baseline: the mode and n.
 */
export function pYesBasis(table) {
  if (!table) return null;
  const why = fallbackReason(table);
  const head = { mode: table.mode ?? 'baseline' };
  if (why) return { ...head, source: 'clone.accept', label: 'clone band (no graded offers to blend)', fallback: why };
  if (table.mode === 'blend' && table.blend) return { ...head, source: 'blend.accept', label: BLEND_LABEL, ...basisSummary(table.blend) };
  return { ...head, source: 'activity.accept', label: PYES_LABEL, n_graded: table.pooled.n };
}

/** The War Room step shape ({ p, band, basis }) from pYesFor's result. */
export function stepPYes(a) {
  const b = a.band;
  // The offer ledger (I sent it) requires the acceptance model's band basis; a served baseline/blend band carries the
  // clone's basis from its challenger arm, which is the model the ledger logs (trade-outcomes.js#acceptanceFields).
  const bandBasis = b?.basis ?? a.challenger?.basis ?? a.challenger?.band?.basis ?? null;
  return { p: b?.mid ?? 0, band: b && !a.point ? { low: b.low, high: b.high, ...(bandBasis ? { basis: bandBasis } : {}) } : null, basis: a.basis,
    ...(a.point ? { label: a.label, n: a.n } : {}),
    ...(a.p_gate != null ? { p_gate: a.p_gate } : {}), ...(a.probe != null ? { probe: a.probe } : {}) };
}
