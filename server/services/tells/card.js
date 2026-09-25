/**
 * TELLS-01b: the one response the Trade Brain tells card reads.
 *
 * Default OFF. On with GRIDIRON_TELLS_CARD=1 (the ship switch, flipped only
 * once E1 passes for the clone on league offers), or locally with preview mode
 * (previewUnconfirmed()), in which case the response is labelled a preview.
 *
 * READ ONLY. The card and its E1 grade are computed off the request thread by
 * producer 'tells' (tells/producer.js, run by scripts/engine-tells.mjs after each
 * sync) and stored in engine_state as `tells.card`. This serves the stored row as
 * of `asOf` with that row's as_of; it never fits or grades anything, so a request
 * costs one indexed read however many offers the league has.
 */
import { getState } from '../engine/state.js';
import { previewUnconfirmed, previewFields } from '../preview-mode.js';

export const TELLS_CARD_FLAG = 'GRIDIRON_TELLS_CARD';
export const OFF_REASON = 'TELLS-01b tells card is default-off: the clone features have not passed E1 (log loss vs activity-only) on league offers';
export const NOT_RUN_REASON = 'no tells card is stored for this league yet: the tells producer (scripts/engine-tells.mjs, run after each sync) has not written one';

const engineStateBuilt = database =>
  !!database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'engine_state'`).get();

export function tellsCardResponse(database, leagueId, { asOf = new Date() } = {}) {
  const flagOn = process.env[TELLS_CARD_FLAG] === '1';
  const preview = !flagOn && previewUnconfirmed();
  if (!flagOn && !preview) return { enabled: false, reason: OFF_REASON, flag: TELLS_CARD_FLAG };
  const labels = preview ? previewFields(OFF_REASON) : {};
  if (!engineStateBuilt(database)) {
    return { enabled: true, ...labels, card: null, as_of: null, reason: 'engine_state is not built on this database (migration 075)' };
  }
  const row = getState('league', String(leagueId), 'tells.card', { asOf, leagueId }, database);
  if (!row) return { enabled: true, ...labels, card: null, as_of: null, reason: NOT_RUN_REASON };
  return { enabled: true, ...labels, card: row.value, grade: row.value?.grade ?? null, as_of: row.as_of,
    producer_version: row.producer_version, written_at: row.written_at };
}
