/**
 * nflsavant route-tree and coverage-shell splits.
 *
 * For each receiver, how his targets divide across 13 route families and 7
 * coverage shells, with EPA per target, catch % and success % inside each.
 * Nothing else in the project has route-level or shell-level detail; the
 * nearest neighbours (nfl_ngs separation/cushion, nfl_pfr_adv charting) are
 * per-player-week totals with no breakdown.
 *
 * WHAT THIS IS NOT: routes *run*. There is still no denominator anywhere free —
 * this is targets by route, so a receiver who ran forty go routes and was
 * targeted on one appears once. Anything consuming it must not describe it as
 * usage, and the routes-run gap stays open.
 *
 * TRUST: this is one site's derived computation, undocumented and unversioned,
 * not a league feed like nflverse. The taxonomy below was discovered by
 * enumerating every code across all 100 receivers nflsavant lists for 2024, not
 * read off a spec, so a code added upstream is a code we have never seen. The
 * loader reports unknown codes rather than dropping them, and the registry
 * entry says plainly that there is no fallback when this source goes away.
 */
import { db } from '../db/index.js';
import { recordSync } from './scheduler.js';

const BASE = 'https://nflsavant.com/api';

/** Season aggregates live at week 0 — see migration 069 for why not NULL. */
export const SEASON_AGGREGATE_WEEK = 0;

export const ROUTES = Object.freeze(['HITCH/CURL', 'QUICK OUT', 'SHALLOW CROSS/DRAG', 'IN/DIG',
  'GO', 'DEEP OUT', 'SLANT', 'CORNER', 'POST', 'SCREEN', 'SWING', 'WHEEL', 'TEXAS/ANGLE']);

/**
 * COVER_4 appears for 20 of 100 receivers, COVER_0 for 6, COVER_6 for 2
 * (re-derived from the delivered 2024 file, not taken on trust). Only COVER_1,
 * COVER_2, COVER_3 and 2_MAN carry enough targets to model on; the rest are
 * kept because a sparse real column beats a missing one, and are left null
 * rather than zeroed so a consumer can apply its own coverage gate.
 */
export const SHELLS = Object.freeze(['COVER_1', 'COVER_2', 'COVER_3', '2_MAN',
  'COVER_4', 'COVER_0', 'COVER_6']);

/** Name → nflsavant path segment. Resolved 100/100 (2024) and 92/92 (2025). */
export const slug = name => String(name).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const key = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const r4 = v => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);
const r2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

async function fetchJsonDefault(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/**
 * One raw payload → one storable row, or null when the payload cannot be
 * trusted to identify a player. `onUnknown` is called once per route or shell
 * code we have no column for; the caller decides what to do about it, but it is
 * never silent.
 */
export function cleanRouteRow(payload, season, week, { onUnknown } = {}) {
  const total = payload?.total_targets || 0;
  if (!payload?.gsis_id || total <= 0) return null;

  const byRoute = new Map((payload.routes ?? []).map(r => [r.route, r]));
  const coverage = payload.vs_coverage ?? [];
  const byShell = new Map(coverage.map(c => [c.shell, c]));
  if (onUnknown) {
    for (const code of byRoute.keys()) if (!ROUTES.includes(code)) onUnknown({ kind: 'route', code });
    for (const code of byShell.keys()) if (!SHELLS.includes(code)) onUnknown({ kind: 'shell', code });
  }

  const stats = {
    route_targets: total,
    motion_rate: r4(payload.motion_rate),
    air_yards_avg: r2(payload.air_yards_avg),
    yac_avg: r2(payload.yac_avg)
  };
  for (const name of ROUTES) {
    const k = key(name), r = byRoute.get(name);
    // Share is a real zero when he was never targeted on the route; efficiency
    // is null, because no targets means nothing was measured.
    stats[`route_share_${k}`] = r ? r4(r.targets / total) : 0;
    stats[`route_epa_${k}`] = r ? r4(r.epa_per_target) : null;
    stats[`route_catch_${k}`] = r ? r2(r.catch_pct) : null;
  }
  const covTotal = coverage.reduce((s, c) => s + (c.targets || 0), 0);
  for (const name of SHELLS) {
    const k = key(name), c = byShell.get(name);
    stats[`shell_share_${k}`] = c && covTotal ? r4(c.targets / covTotal) : 0;
    stats[`shell_epa_${k}`] = c ? r4(c.epa_per_target) : null;
    stats[`shell_success_${k}`] = c ? r2(c.success_pct) : null;
  }
  // Normalised Shannon entropy of the route tree: low means one-trick and easy
  // to game-plan for, high means used everywhere.
  const p = (payload.routes ?? []).map(r => r.targets / total).filter(x => x > 0);
  stats.route_entropy = p.length > 1
    ? r4(-p.reduce((s, x) => s + x * Math.log2(x), 0) / Math.log2(ROUTES.length)) : 0;

  return {
    season, week: week == null ? SEASON_AGGREGATE_WEEK : week,
    player_id: payload.gsis_id, player_name: payload.name, team: payload.team,
    position: payload.position, kind: 'routes', qualifies: payload.qualifies === true,
    stats
    // payload.summary is generated prose and is deliberately not carried.
  };
}

/** Upserts in one transaction. Returns how many rows were written. */
export function upsertRouteSplits(rows, fetchedAt = new Date().toISOString()) {
  const stmt = db.prepare(`INSERT INTO nfl_route_splits
    (season, week, player_id, kind, player_name, team, position, qualifies, stats, source_fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(season, week, player_id, kind) DO UPDATE SET
      stats=excluded.stats, team=excluded.team, position=excluded.position,
      player_name=excluded.player_name, qualifies=excluded.qualifies,
      source_fetched_at=excluded.source_fetched_at`);
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(r.season, r.week, r.player_id, r.kind, r.player_name, r.team,
        r.position, r.qualifies ? 1 : 0, JSON.stringify(r.stats), fetchedAt);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return rows.length;
}

/**
 * Pulls one or more seasons (optionally one week) and stores them.
 *
 * A failing upstream throws, after recording the failure — it never returns an
 * empty result, which downstream would read as "these receivers ran no routes".
 */
export async function syncRouteSplits(seasons, { week = null, fetchJson = fetchJsonDefault, delayMs = 120 } = {}) {
  let rows = 0; const misses = []; const unknown = new Map();
  try {
    for (const season of seasons) {
      const spotlight = await fetchJson(`${BASE}/route-spotlight?season=${season}`);
      const q = week == null ? `?season=${season}` : `?season=${season}&week=${week}`;
      const batch = [];
      for (const rec of spotlight.receivers ?? []) {
        const payload = await fetchJson(`${BASE}/wr-routes/${encodeURIComponent(slug(rec.name))}${q}`);
        const row = cleanRouteRow(payload, season, week,
          { onUnknown: u => unknown.set(`${u.kind}:${u.code}`, u) });
        if (row) batch.push(row);
        else misses.push({ name: rec.name, slug: slug(rec.name), reason: payload?.gsis_id ? 'no_targets' : 'slug_miss' });
        if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      }
      rows += upsertRouteSplits(batch);
    }
  } catch (e) {
    recordSync('nfl_route_splits', 'error', e.message);
    throw e;
  }
  const result = { rows, misses, unknown: [...unknown.values()] };
  // An unknown code is data we are dropping on the floor, so it is part of the
  // sync's recorded outcome rather than a log line nobody reads.
  recordSync('nfl_route_splits', 'ok', result);
  return result;
}
