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

/**
 * E-DATA (c): the FantasyCalc value HISTORY. `player_metrics` keeps only the latest capture, so
 * every capture syncFantasyCalc makes is also appended to `fc_value_history` (migration 111): one
 * row per player, source and capture instant, first write wins. `dynasty_value_history` (073) is
 * the per-format, one-row-per-day record; this one is the league-agnostic value Nick's rules read,
 * at every capture.
 */
export const FC_HISTORY_SOURCES = Object.freeze(['fc_value', 'fc_trend30', 'fc_adp']);

/** SQLite 'YYYY-MM-DD HH:MM:SS' UTC (what datetime('now') and player_metrics.fetched_at hold). */
export function fcStamp(at = new Date()) {
  const d = at instanceof Date ? at : new Date(/[TZ]/.test(String(at)) ? at : `${String(at).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`fc-value: not a time: ${at}`);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Append one capture. db: an object with run(sql, ...params). values: [[player_id, source, value]].
 * Returns the number of rows written (a repeat of the same instant writes none).
 */
export function recordFcCapture(db, capturedAt, values) {
  const at = fcStamp(capturedAt);
  let n = 0;
  for (const [id, source, value] of values) {
    if (!FC_HISTORY_SOURCES.includes(source)) throw new Error(`fc-value: unknown FantasyCalc source ${source}`);
    const v = Number(value);
    if (value == null || !Number.isFinite(v)) continue;
    n += Number(db.run(`INSERT INTO fc_value_history (player_id, source, value, captured_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(player_id, source, captured_at) DO NOTHING`, id, source, v, at).changes ?? 0);
  }
  return n;
}

const historyAbsent = db =>
  !db.rows(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fc_value_history'`).length;

/**
 * fcValues' shape, as of an instant: each player's latest captured value at or before `at`.
 * Same fail-closed rules: no capture by then, no value. `captured_at` is the newest capture used.
 */
export function fcValuesAsOf(db, at, { source = FC_VALUE_SOURCE } = {}) {
  const asOf = fcStamp(at);
  const base = { source: `${FC_VALUE_LABEL}, history as of ${asOf}`, as_of: asOf, captured_at: null, byId: new Map() };
  try {
    if (historyAbsent(db)) return { ...base, status: 'table_absent', reason: 'fc_value_history is not on this database (migration 111)' };
    const rows = db.rows(`SELECT h.player_id, h.value, h.captured_at FROM fc_value_history h
      WHERE h.source = ? AND h.captured_at = (SELECT MAX(captured_at) FROM fc_value_history
        WHERE player_id = h.player_id AND source = h.source AND captured_at <= ?)`, source, asOf);
    const byId = new Map();
    let newest = null;
    for (const r of rows) {
      const v = Number(r.value);
      if (!Number.isFinite(v) || (source === FC_VALUE_SOURCE && v < 0)) continue;
      byId.set(String(r.player_id), v);
      if (!newest || r.captured_at > newest) newest = r.captured_at;
    }
    if (!byId.size) return { ...base, status: 'empty', reason: `no FantasyCalc capture on file at or before ${asOf}` };
    return { ...base, status: 'ok', captured_at: newest, byId };
  } catch (e) {
    return { ...base, status: 'error', reason: `FantasyCalc history read failed: ${e?.message ?? String(e)}` };
  }
}

/** Every capture of one player's value (or trend / ADP), oldest first. [] when the table is absent. */
export function fcValueHistory(db, playerId, { source = FC_VALUE_SOURCE, limit = 2000 } = {}) {
  if (historyAbsent(db)) return [];
  return db.rows(`SELECT captured_at, value FROM fc_value_history WHERE player_id = ? AND source = ?
    ORDER BY captured_at LIMIT ?`, Number(playerId), source, Math.max(1, Math.min(Number(limit) || 2000, 20000)));
}
