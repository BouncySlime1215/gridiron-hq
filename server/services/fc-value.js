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
