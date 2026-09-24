/**
 * BROKEN-F: the three player values, named.
 *
 * The app carries three different numbers that all answer "what is he worth",
 * and until this file every page printed one of them as a bare `value`:
 *
 *   - market_value   FantasyCalc's trade-market price, format-matched
 *                    (dynasty-value-history.js#currentMarket). The trade finder
 *                    scores deals on it (trade-engine.js, asset `value`).
 *   - preseason_vor  projected SEASON points minus the last startable player at
 *                    his position (routes/edge.js#vorBoard). Built from the
 *                    preseason projection and never updated in-season. Rides
 *                    every finder asset as `vor` (named here preseason_vor).
 *   - clone_price    what one league-mate's clone would pay: market_value times
 *                    that manager's multiplier (counterparty-pricing.js#
 *                    playerValuation). Served as `their_value` in the deep dive's
 *                    valuation panel (routes/trades.js#valuationPanel).
 *
 * League Hub's roster analysis (routes/leagues.js) shows a FOURTH number under
 * the market_value name: FantasyCalc's redraft price fetched once in the first
 * league's format, not this league's. It is labelled as that (value_format).
 *
 * They are on different scales and answer different questions, so they must
 * never be compared as if they were one number. This module is the one
 * registry of their names and labels; each surface stamps `value_kind` (which
 * field its bare `value` is) and carries the other fields by name.
 *
 * Behind preview-mode.js#previewUnconfirmed(): with the switch off, no response
 * changes shape. With it on, the stamped responses carry `preview: true`.
 */
import { previewUnconfirmed, previewFields } from './preview-mode.js';

export const PLAYER_VALUE_FIELDS = Object.freeze({
  market_value: Object.freeze({
    label: 'Market value (FantasyCalc)',
    short: 'Market',
    scale: 'FantasyCalc price units',
    basis: 'trade-market price for this league format; moves daily',
  }),
  preseason_vor: Object.freeze({
    label: 'Preseason VOR',
    short: 'Pre-VOR',
    scale: 'season fantasy points over replacement',
    basis: 'preseason projected points minus the last startable player at his position; not updated in-season',
  }),
  clone_price: Object.freeze({
    label: 'Clone price',
    short: 'Clone',
    scale: 'FantasyCalc price units',
    basis: "market value times this league-mate's clone multiplier: what he would pay, not what the player is worth",
  }),
});

/**
 * League Hub's roster analysis (routes/leagues.js) reads player_metrics
 * 'fc_value': FantasyCalc's redraft price, fetched once for the first league
 * by id (aggregates.js#syncFantasyCalc), not the format-matched price the
 * finder reads. Same kind, different price; the label says which.
 */
export const LEAGUE_HUB_VALUE_FORMAT = "redraft price in the first-synced league's format";

export const VALUE_KINDS = Object.freeze(Object.keys(PLAYER_VALUE_FIELDS));

export const PREVIEW_REASON =
  'BROKEN-F: three player values named and labelled; unconfirmed forward until checked on the local app';

/** True when surfaces stamp the named fields (the preview switch). */
export const namedValuesOn = () => previewUnconfirmed();

const num = x => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));

/**
 * The named fields for one player, from the RAW inputs, not the bare `value` /
 * `vor` the builders default to 0: a player FantasyCalc does not price has no
 * market value (null), and a player with no preseason projection has no VOR.
 * `market` is the currentMarket() row, `board` the vorBoard() row, either absent.
 * Returns {} with the switch off.
 */
export function namedPlayerValues({ market = null, board = null } = {}) {
  if (!namedValuesOn()) return {};
  return {
    market_value: num(market?.value),
    preseason_vor: num(board?.vor),
    value_kind: 'market_value',
  };
}

/**
 * The response-level block a stamped surface carries: which field its bare
 * `value` is, and the label registry so the page prints the right words.
 * Returns {} with the switch off, so a spread of it changes nothing.
 */
export function valueLabelBlock(kind, { format = null } = {}) {
  if (!namedValuesOn()) return {};
  if (!PLAYER_VALUE_FIELDS[kind]) throw new Error(`unknown player value kind: ${kind}`);
  const label = PLAYER_VALUE_FIELDS[kind].label;
  return {
    value_kind: kind,
    // `format` says WHICH market price when a surface does not read the
    // league's own format (League Hub's redraft fc_value; see routes/leagues.js).
    value_label: format ? `${label}, ${format}` : label,
    value_format: format,
    value_fields: PLAYER_VALUE_FIELDS,
    ...previewFields(PREVIEW_REASON),
  };
}

/**
 * Copies an asset's named fields onto a slimmed copy of it. {} when the asset
 * carries none (switch off), so a spread of it changes nothing.
 */
export const carryNamedValues = p => (p?.value_kind
  ? { market_value: p.market_value ?? null, preseason_vor: p.preseason_vor ?? null, value_kind: p.value_kind }
  : {});

/**
 * A route's result with the label block added. Leaves anything that is not a
 * plain object (and every result, with the switch off) exactly as it was.
 */
export function stampValueKind(result, kind, opts = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const block = valueLabelBlock(kind, opts);
  return Object.keys(block).length ? { ...result, ...block } : result;
}
