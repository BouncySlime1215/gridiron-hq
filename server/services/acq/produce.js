/**
 * ACQ-01 producer: plan one league and return its War Room plans entry.
 *
 * Default-off. It runs only when previewUnconfirmed() is on (the one local
 * testing switch, server/services/preview-mode.js): its P(yes) numbers are
 * today's unfitted acceptance model and its claims assume they land, so nothing
 * here may reach a page by default. Off, `produceAcq` returns
 * { skipped: true, reason } and builds nothing.
 *
 * Offline only (scripts/acq/produce-acq-plans.mjs); nothing on the request thread
 * calls it.
 */
import { previewUnconfirmed, previewFields } from '../preview-mode.js';
import { planAcquisition, PLAN_DEFAULTS } from './planner.js';
import { leagueEntry } from './contract.js';

/** The whole run (world build + search) stays under 300 s per league with margin. */
export const TOTAL_BUDGET_MS = 270_000;

export const ACQ_PREVIEW_REASON = 'ACQ-01 planner: P(yes) is today\'s unfitted acceptance model (edge test assumed passed on every step) '
  + 'and claims are assumed to land; the path search is not yet graded against real offers.';

/** The served finder's best single offer by P(yes) x title delta, for the same league state. */
export async function finderBest(leagueId, me) {
  const { row } = await import('../../db/index.js');
  const { titleOddsTrades } = await import('../title-odds-trades.js');
  const { findTrades } = await import('../trade-engine.js');
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  const served = titleOddsTrades(leagueId, { teamId: me });
  if (served.error) return { error: served.error };
  const found = findTrades(lg, { myTeamId: me, requireMutual: true, limit: 24 });
  const ids = xs => xs.map(p => p.id).join();
  let best = null;
  for (const d of served.deals ?? []) {
    const f = (found.deals ?? []).find(x => x.partner_id === d.partner_id && ids(x.i_give) === ids(d.i_give) && ids(x.i_get) === ids(d.i_get));
    const p = f?.acceptance?.band?.mid;
    if (p == null) continue;
    const e = { expected: p * d.title_delta, se: d.title_delta_se == null ? null : p * d.title_delta_se };
    if (!best || e.expected > best.expected) best = e;
  }
  return best ?? { error: 'the finder served no deal with an acceptance band' };
}

/**
 * @param {number} leagueId
 * @param {object} opts  planner options (PLAN_DEFAULTS) plus { freeAgents, finder, adapterFactory }
 */
export async function produceAcq(leagueId, opts = {}) {
  if (!previewUnconfirmed()) {
    return { skipped: true, reason: 'ACQ-01 is default-off: it runs only with the local preview switch on (preview-mode.js previewUnconfirmed)' };
  }
  const factory = opts.adapterFactory ?? (async (id, o) => (await import('./world-adapter.js')).leagueAdapter(id, o));
  const t0 = Date.now();
  const built = await factory(leagueId, { freeAgents: opts.freeAgents ?? 6 });
  if (built.error) return { error: built.error, league: Number(leagueId) };
  const { adapter, meta } = built;
  const worldMs = Date.now() - t0;
  const planOpts = Object.fromEntries(Object.keys(PLAN_DEFAULTS).filter(k => opts[k] != null).map(k => [k, opts[k]]));
  // One end-to-end budget: what the world build spent comes off the search's share.
  if (planOpts.budgetMs == null) planOpts.budgetMs = Math.max(30_000, TOTAL_BUDGET_MS - worldMs);
  if (opts.target != null) planOpts.target = opts.target;
  const res = planAcquisition(adapter, planOpts);
  let finder = null;
  if (opts.finder) finder = await finderBest(leagueId, meta.me);
  const entry = leagueEntry(res, { league: meta.league, me: meta.me, name: meta.name, asOf: meta.as_of,
    finderBest: finder && !finder.error ? finder : null });
  return { entry, res, meta: { ...meta, world_ms: worldMs, total_ms: Date.now() - t0 }, finder, ...previewFields(ACQ_PREVIEW_REASON) };
}
