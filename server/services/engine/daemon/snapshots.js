/**
 * Snapshots (ENGINE-ARCHITECTURE.md §2.7, §4.3 step 5, §4.6, D2, D3).
 *
 * A snapshot is a cut, published per league only when every producer of that league's DAG
 * finished the tick: (max event id, max state id, the version of every producer, the
 * fallbacks in force, the dice). A league whose DAG did not finish keeps its previous
 * snapshot, which keeps serving; nothing is published when nothing changed. League 0 is
 * the global snapshot for league-free views. `engine_snapshots` is append-only.
 *
 * Dice: world = keyedSeed('world', season, nfl_week), fixed within an NFL week (D3).
 */
import { keyedSeed } from '../../stats-util.js';
import { assertWriteRole } from '../role.js';

export function latestSnapshot(leagueId, database) {
  const r = database.prepare('SELECT * FROM engine_snapshots WHERE league_id = ? ORDER BY id DESC LIMIT 1').get(Number(leagueId));
  if (!r) return null;
  return { ...r, id: Number(r.id), version_set: JSON.parse(r.version_set), fallback_set: JSON.parse(r.fallback_set) };
}

/** {field: fallback_field} in force for a league (its own rows, else the global ones). */
export function fallbackSet(leagueId, database) {
  const out = {};
  for (const r of database.prepare(`SELECT field, fallback_field, league_id FROM engine_fallback WHERE league_id IN (0, ?)
      ORDER BY league_id`).all(Number(leagueId))) out[r.field] = r.fallback_field;
  return out;
}

export function worldSeed(season, nflWeek) {
  return season == null || nflWeek == null ? null : String(keyedSeed('world', season, nflWeek));
}

/** Append one snapshot row: the cut is the database's max ids now. Returns its id. */
export function publishSnapshot({ leagueId, tickId = null, versionSet, season = null, nflWeek = null, now = new Date() }, database) {
  assertWriteRole('publishSnapshot');
  const cut = database.prepare('SELECT (SELECT MAX(id) FROM engine_events) AS e, (SELECT MAX(id) FROM engine_state) AS s').get();
  const r = database.prepare(`INSERT INTO engine_snapshots (league_id, tick_id, max_event_id, max_state_id, version_set,
      fallback_set, season, nfl_week, world, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(Number(leagueId), tickId, Number(cut.e ?? 0), Number(cut.s ?? 0), JSON.stringify(versionSet ?? {}),
      JSON.stringify(fallbackSet(leagueId, database)), season, nflWeek, worldSeed(season, nflWeek), new Date(now).toISOString());
  return Number(r.id);
}
