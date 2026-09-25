/**
 * FC-VALUE (integration-8, coordinator decision on #410): Nick's overpay rule is defined on FantasyCalc
 * value, `player_metrics` rows with source 'fc_value' (the number the League Hub, the rankings and the
 * hourly rule check read). This is the ONE reader the planner prices Nick's rules on: the overpay cap,
 * the +12% depth-only 2-for-1 exception and the value edge (his screen %) shown on a card.
 *
 * Fails closed: a player with no fc_value row has no value (null), never another value number, so the
 * planner cannot give or get him (search.js#playerValues `tradable` needs a value > 0) and the run
 * counts him under `_run.dropped_by_reason.no_fc_value`.
 *
 * db: an object with rows(sql, ...params) (the app's db module or the producer's svc.db).
 * -> { status: 'ok' | 'empty' | 'table_absent' | 'error', reason?, source, fetched_at, byId: Map<id, number> }
 */
export const FC_VALUE_SOURCE = 'fc_value';
export const FC_VALUE_LABEL = "FantasyCalc value (player_metrics source 'fc_value')";

export function fcValues(db) {
  const base = { source: FC_VALUE_LABEL, fetched_at: null, byId: new Map() };
  try {
    const t = db.rows(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'player_metrics'`);
    if (!t.length) return { ...base, status: 'table_absent', reason: 'player_metrics is not on this database, so no move can be priced' };
    const rows = db.rows(`SELECT player_id, value, fetched_at FROM player_metrics WHERE source = ?`, FC_VALUE_SOURCE);
    const byId = new Map();
    let fetched = null;
    for (const r of rows) {
      const v = Number(r.value);
      if (!Number.isFinite(v) || v < 0) continue;
      byId.set(String(r.player_id), v);
      if (r.fetched_at && (!fetched || r.fetched_at > fetched)) fetched = r.fetched_at;
    }
    if (!byId.size) return { ...base, status: 'empty', reason: 'no FantasyCalc values on file, so no move can be priced' };
    return { ...base, status: 'ok', fetched_at: fetched, byId };
  } catch (e) {
    return { ...base, status: 'error', reason: `FantasyCalc value read failed: ${e?.message ?? String(e)}` };
  }
}

/** One player's FantasyCalc value, or null (fail closed: never a fallback number). */
export const fcValueOf = (fc, id) => (fc?.byId?.has(String(id)) ? fc.byId.get(String(id)) : null);

/**
 * RADAR-WIRE (#405 review finding 2): the FORMAT-AWARE FantasyCalc value and 30-day trend for one
 * league format (`dynasty_values`, written per league format by routes/aggregates.js). The
 * `player_metrics` fc_value / fc_trend30 rows are one league-agnostic set priced for the FIRST
 * league's settings, so a label read from them in another league (8 vs 10 teams, 1QB vs SF) is
 * another format's trend. Same fail-closed rules as fcValues: no row, no value; never a fallback.
 * value = redraft_value (the number player_metrics' fc_value holds for league 1's format).
 *
 * -> { status: 'ok' | 'empty' | 'table_absent' | 'no_format' | 'error', reason?, format_key, byId: Map<id, { value, trend30 }> }
 */
export function fcFormatValues(db, formatKey) {
  const base = { source: "FantasyCalc value by league format (dynasty_values)", format_key: formatKey ?? null, byId: new Map() };
  if (formatKey == null) return { ...base, status: 'no_format', reason: 'no league format key, so no format-aware value' };
  try {
    const t = db.rows(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dynasty_values'`);
    if (!t.length) return { ...base, status: 'table_absent', reason: 'dynasty_values is not on this database' };
    const rows = db.rows(`SELECT player_id, redraft_value, trend30 FROM dynasty_values
      WHERE format_key = ? AND retired_at IS NULL`, formatKey);
    const byId = new Map();
    for (const r of rows) {
      const v = Number(r.redraft_value);
      if (r.redraft_value == null || !Number.isFinite(v) || v < 0) continue;
      const t30 = r.trend30 == null ? null : Number(r.trend30);
      byId.set(String(r.player_id), { value: v, trend30: Number.isFinite(t30) ? t30 : null });
    }
    if (!byId.size) return { ...base, status: 'empty', reason: `no FantasyCalc values on file for format ${formatKey}` };
    return { ...base, status: 'ok', byId };
  } catch (e) {
    return { ...base, status: 'error', reason: `FantasyCalc format read failed: ${e?.message ?? String(e)}` };
  }
}
