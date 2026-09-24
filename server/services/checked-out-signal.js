/**
 * BROKEN-H: one "checked out" signal in Trade Brain, not two.
 *
 * Under preview (preview-mode.js#previewUnconfirmed) or GRIDIRON_LIVING01A_ENABLED=1,
 * the LIVING-01a producer's `activity.manager` row is shown for every league-mate,
 * and it carries its own P(checked out). counterpartyLayer used to add a second,
 * separate checked-out term beside it (counterparty-pricing.js#checkedOutFactor,
 * last week's dead starts), so a page could print both, disagreeing. The producer
 * declares `replaces: counterparty-pricing.js#checkedOutFactor` (activity-model.js
 * registerProducer), so whenever its row is visible it is the only checked-out input:
 *
 *   - a live `activity.manager` row exists for the team (after a promotion PR), or
 *   - the flag / preview is on (the shadow row is what the page shows).
 *
 * In both cases counterpartyLayer never calls checkedOutFactor (ratchet test:
 * test/broken-h-checked-out.test.js). With neither, nothing changes.
 *
 * The term is P(checked out) x the corpus dead-start coefficient the old factor
 * used at full strength: the old factor was a flag for "one or more dead starts",
 * the state model turns that into a probability. When the replacement is in charge
 * but has no row for the team, the term is withheld with the reason, never refilled
 * from the legacy function and never from the league prior (which is the same for
 * everyone and says nothing about this manager).
 */
import { getState } from './engine/state.js';
import { FLAG as LIVING01A_FLAG, MODEL_VERSION } from './engine/activity-model.js';
import { previewUnconfirmed } from './preview-mode.js';

export const ACTIVITY_FIELD = 'activity.manager';
const LABEL = 'Checked out (engagement state, LIVING-01a)';

/** Whether the shadow activity.manager rows are shown (same rule as activity-model.js#activityEnabled, sync). */
export const activityManagerShown = () => process.env[LIVING01A_FLAG] === '1' || previewUnconfirmed();

/**
 * The checked-out term from activity.manager for one roster, or `{ replaced: false }`
 * when the legacy term still owns it. `perUnit` is the score change at P = 1.
 * Returns { replaced, factor } where factor is a receptiveness_factors entry or null.
 */
export function activityCheckedOut(leagueId, rosterId, { perUnit, asOf = new Date(), database = undefined } = {}) {
  const id = `${leagueId}:${rosterId}`;
  const opts = { asOf, leagueId: Number(leagueId) };
  const live = getState('league_team', id, ACTIVITY_FIELD, opts, database);
  const shown = activityManagerShown();
  if (!live && !shown) return { replaced: false, factor: null };
  const row = live ?? getState('league_team', id, ACTIVITY_FIELD, { ...opts, lane: 'shadow', version: MODEL_VERSION }, database);
  const p = row?.value?.probs?.checked_out;
  if (!Number.isFinite(p)) {
    return { replaced: true, factor: { source: 'checked_out', label: LABEL, effect: null, n: 0, cap: null, fitted: true,
      engine: { field: ACTIVITY_FIELD, row_id: row?.id ?? null, lane: row?.lane ?? null },
      why: `withheld: no ${ACTIVITY_FIELD} row for this team yet (the activity producer has not run on it)` } };
  }
  const effect = p * perUnit;
  return { replaced: true, factor: { source: 'checked_out', label: LABEL, effect: +effect.toFixed(4),
    n: row.value.weeks_seen ?? 0, cap: null, fitted: true,
    engine: { field: ACTIVITY_FIELD, row_id: row.id, lane: row.lane, as_of: row.as_of, version: row.producer_version },
    why: `P(checked out) ${Math.round(p * 100)}% (state: ${String(row.value.state).replace('_', ' ')}); `
      + 'checked-out teams complete about 11% fewer trades' } };
}
