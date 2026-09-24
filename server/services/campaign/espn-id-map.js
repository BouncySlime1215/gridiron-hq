/**
 * FEAS-140-ESPN-WIRE: internal player id -> ESPN player id, so a plan's post-trade roster
 * can be priced on ESPN's projected lineup (espn-lineup.js#espnLineupContext).
 *
 * The map is built from the ESPN league payload with the same resolver the sim's rosters
 * come from (trade-engine.js#espnPlayerResolver via loadRosters), so every rostered player
 * the planner can move resolves the same way the sim placed him. An asset outside every
 * ESPN roster (a free agent) maps by its own espn_id when it carries one.
 *
 * Pure: the producer (scripts/campaign/league-adapter.mjs) hands in the payload, the
 * resolver and the assets; the planner calls rosterAfter with ids only.
 */

/**
 * payload: ESPN league JSON (teams[].roster.entries[]); resolve: pl -> { asset, match }; assets: Map id -> asset.
 * Returns { toEspn: Map(String internal id -> String ESPN id), rosterOf: Map(String team id -> [ESPN ids]),
 *           rostered: Set(ESPN ids), coverage }.
 * coverage: { rostered (ESPN roster entries), mapped (resolved to an asset), by_espn_id, by_name_position,
 *             unresolved: [ESPN ids], share (mapped / rostered, null when no entries) }.
 */
export function buildEspnIdMap(payload, resolve, assets = new Map()) {
  const toEspn = new Map();
  const rosterOf = new Map();
  const rostered = new Set();
  const cov = { rostered: 0, mapped: 0, by_espn_id: 0, by_name_position: 0, unresolved: [] };
  for (const t of payload?.teams ?? []) {
    const ids = [];
    for (const e of t.roster?.entries ?? []) {
      const pl = e?.playerPoolEntry?.player;
      const espnId = pl?.id ?? e?.playerId ?? null;
      if (espnId == null) continue;
      const eid = String(espnId);
      ids.push(eid);
      rostered.add(eid);
      cov.rostered++;
      const r = resolve ? resolve(pl) : { asset: null, match: null };
      if (r?.asset?.id == null) { cov.unresolved.push(eid); continue; }
      toEspn.set(String(r.asset.id), eid);
      cov.mapped++;
      if (r.match === 'espn_id') cov.by_espn_id++; else cov.by_name_position++;
    }
    rosterOf.set(String(t.id), ids);
  }
  for (const a of assets.values()) {
    if (a?.id == null || a.espn_id == null || toEspn.has(String(a.id))) continue;
    toEspn.set(String(a.id), String(a.espn_id));
  }
  return { toEspn, rosterOf, rostered, coverage: { ...cov, share: cov.rostered ? cov.mapped / cov.rostered : null } };
}

/**
 * Nick's ESPN roster after a plan: his ESPN roster today, minus what he gives, plus what he gets
 * (both read off the internal before/after rosters). K and D/ST, never traded by the planner,
 * stay as ESPN has them.
 * Returns { ids: [ESPN ids] } or { ids: null, missing: [internal ids], reason } when a moved
 * player has no ESPN id, or a received one is on no ESPN roster (ESPN has no projection for him).
 */
export function espnRosterAfter(map, team, before, after) {
  const base = map?.rosterOf?.get(String(team));
  if (!base) return { ids: null, missing: [], reason: `team ${team} has no ESPN roster in the league payload` };
  const b = new Set((before ?? []).map(String));
  const a = new Set((after ?? []).map(String));
  const give = [...b].filter(id => !a.has(id));
  const get = [...a].filter(id => !b.has(id));
  const missing = [];
  const off = new Set();
  for (const id of give) { const e = map.toEspn.get(id); if (e == null) missing.push(id); else off.add(e); }
  const on = [];
  for (const id of get) {
    const e = map.toEspn.get(id);
    if (e == null || !map.rostered.has(e)) missing.push(id); else on.push(e);
  }
  if (missing.length) {
    return { ids: null, missing, reason: `no ESPN id on an ESPN roster for internal player id(s) ${missing.join(', ')}` };
  }
  return { ids: [...base.filter(e => !off.has(e)), ...on], missing: [] };
}
