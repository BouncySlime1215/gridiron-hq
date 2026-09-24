/**
 * Market values as events: `market.player_value` (ENGINE-ARCHITECTURE.md §2 sources table,
 * §4.2 `market` producer input).
 *
 * From `dynasty_values` (FantasyCalc, written by routes/aggregates.js), one event per
 * (format_key, player) per change: compare-latest on `<format_key>:<player_id>` over a payload
 * that holds the values and NOT fetched_at, so a refetch of an unchanged value appends
 * nothing ("hashed" in the architecture's table) and a moved value appends one event.
 * dynasty_values is upserted in place, so this log is the only history of what the market
 * said when: the value in force at a time T is the latest event with as_of <= T.
 *
 * as_of: fetched_at (first_seen: the fetch that saw the value). A row with no fetched_at
 * is stamped at capture (first_seen), never guessed earlier.
 */
import { registerEventType } from '../registry.js';

registerEventType('market.player_value', {
  description: 'A player\'s market value under one league format (dynasty_values), per change',
});

const present = v => v != null && v !== '';
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export const MARKET_VALUE_ADAPTER = Object.freeze({
  stream: 'market_values', table: 'dynasty_values', source: 'dynasty_values',
  sql: t => `SELECT format_key, player_id, value, redraft_value, trend30, pos_rank, fetched_at FROM ${t}`,
  map: r => {
    const pid = Number(r.player_id);
    if (!present(r.format_key) || !(pid > 0)) return [];
    return [{
      event_type: 'market.player_value', as_of: present(r.fetched_at) ? r.fetched_at : null, as_of_quality: 'first_seen',
      player_id: pid, natural_key: `${r.format_key}:${pid}`,
      entities: [{ type: 'player', id: String(pid), role: 'subject' }],
      payload: { format_key: r.format_key, player_id: pid, value: num(r.value), redraft_value: num(r.redraft_value),
        trend30: num(r.trend30), pos_rank: num(r.pos_rank) },
    }];
  },
});
