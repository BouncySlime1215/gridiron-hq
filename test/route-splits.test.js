import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-route-splits-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { up } = await import('../server/migrations/069_nfl_route_splits.js');
const {
  SEASON_AGGREGATE_WEEK, ROUTES, SHELLS, slug, cleanRouteRow, upsertRouteSplits, syncRouteSplits
} = await import('../server/services/nfl-route-splits.js');

up(db);

/**
 * A raw nflsavant `wr-routes` payload, in the shape clean.mjs proved against
 * all 100 of the 2024 receivers. Two route families and two shells are absent
 * on purpose — that is the normal case, not an edge case (COVER_4 appears for
 * 20 of 100 receivers, COVER_0 for 6, COVER_6 for 2, re-derived from the
 * delivered 2024 file rather than taken on trust).
 */
const payload = (over = {}) => ({
  gsis_id: '00-0036900', name: "Ja'Marr Chase", team: 'CIN', position: 'WR',
  qualifies: true, total_targets: 100, motion_rate: 0.5543,
  air_yards_avg: 8.72, yac_avg: 4.1,
  routes: [
    { route: 'HITCH/CURL', targets: 50, epa_per_target: 0.4277, catch_pct: 71.4 },
    { route: 'GO', targets: 30, epa_per_target: 0.91, catch_pct: 40.0 },
    { route: 'SLANT', targets: 20, epa_per_target: 0.12, catch_pct: 80.0 }
  ],
  vs_coverage: [
    { shell: 'COVER_1', targets: 40, epa_per_target: 0.22, success_pct: 55.1 },
    { shell: 'COVER_3', targets: 60, epa_per_target: 0.61, success_pct: 61.9 }
  ],
  summary: 'Chase torched single-high all year.',
  ...over
});

test('slug rule matches the one proved against 192 receivers with zero misses', () => {
  assert.equal(slug("Ja'Marr Chase"), 'ja-marr-chase');
  assert.equal(slug('Amon-Ra St. Brown'), 'amon-ra-st-brown');
});

test('cleanRouteRow emits the nfl_ngs row shape keyed by the gsis id', () => {
  const row = cleanRouteRow(payload(), 2024, null);
  assert.equal(row.player_id, '00-0036900', 'joins nfl_ngs.player_id, which holds the gsis id');
  assert.equal(row.kind, 'routes');
  assert.equal(row.season, 2024);
  assert.equal(Object.keys(row.stats).length, 4 + ROUTES.length * 3 + SHELLS.length * 3 + 1,
    '65 numeric fields: 4 headline, 3 per route family, 3 per shell, plus route_entropy');
});

test('the generated prose summary is never ingested', () => {
  const row = cleanRouteRow(payload(), 2024, null);
  assert.equal(JSON.stringify(row).includes('torched'), false);
  for (const v of Object.values(row.stats)) {
    assert.ok(v == null || typeof v === 'number', 'every stats value is numeric or null');
  }
});

test('a season aggregate is stamped with the sentinel week, never NULL', () => {
  const row = cleanRouteRow(payload(), 2024, null);
  assert.equal(row.week, SEASON_AGGREGATE_WEEK);
  assert.notEqual(SEASON_AGGREGATE_WEEK, null);
});

/**
 * The defect this test exists for, demonstrated in node:sqlite before a line of
 * the loader was written: SQLite permits MANY NULLs in a composite PRIMARY KEY,
 * so `PRIMARY KEY (season, week, player_id)` with a NULL week — which is what
 * the handoff spec asked for — makes ON CONFLICT DO UPDATE silently unreachable
 * for every season-aggregate row. Re-syncing would append a duplicate season
 * each time instead of updating one, and nothing would say so.
 */
test('re-syncing a season aggregate updates the row instead of duplicating it', () => {
  const first = cleanRouteRow(payload(), 2024, null);
  upsertRouteSplits([first]);
  const second = cleanRouteRow(payload({ total_targets: 175 }), 2024, null);
  upsertRouteSplits([second]);
  const rows = db.prepare(`SELECT stats FROM nfl_route_splits
    WHERE season=2024 AND player_id='00-0036900' AND week=?`).all(SEASON_AGGREGATE_WEEK);
  assert.equal(rows.length, 1, 'one season aggregate per player per season');
  assert.equal(JSON.parse(rows[0].stats).route_targets, 175, 'and it carries the newer pull');
});

test('a weekly row and a season aggregate for one player coexist', () => {
  upsertRouteSplits([cleanRouteRow(payload(), 2025, 5)]);
  upsertRouteSplits([cleanRouteRow(payload(), 2025, null)]);
  const weeks = db.prepare(`SELECT week FROM nfl_route_splits
    WHERE season=2025 AND player_id='00-0036900' ORDER BY week`).all().map(r => r.week);
  assert.deepEqual(weeks, [SEASON_AGGREGATE_WEEK, 5]);
});

/**
 * R&D discovered the taxonomy by enumeration rather than from documentation, so
 * a code nflsavant adds later is a code we have never seen. Dropping it quietly
 * is the failure this project has shipped twice; the loader reports it.
 */
test('an unknown route or shell code is reported, not silently dropped', () => {
  const p = payload();
  p.routes.push({ route: 'JET SWEEP', targets: 7, epa_per_target: 0.3, catch_pct: 85 });
  p.vs_coverage.push({ shell: 'COVER_9', targets: 3, epa_per_target: 0.1, success_pct: 33 });
  const unknown = [];
  const row = cleanRouteRow(p, 2024, null, { onUnknown: u => unknown.push(u) });
  assert.ok(row, 'the known families still load');
  assert.deepEqual(unknown.map(u => u.code).sort(), ['COVER_9', 'JET SWEEP']);
});

/**
 * An absent shell is missing data, not a measured zero. Keeping the rate at 0
 * while the efficiency stays null is what lets a consumer tell "never faced
 * Cover 6" from "faced it and gained nothing" — the honest-degradation rule.
 */
test('an absent shell yields a null efficiency, not a fabricated zero', () => {
  const row = cleanRouteRow(payload(), 2024, null);
  assert.equal(row.stats.shell_epa_cover_6, null);
  assert.equal(row.stats.shell_success_cover_6, null);
  assert.equal(row.stats.shell_share_cover_6, 0, 'share of nothing is a real zero');
  assert.equal(row.stats.route_epa_corner, null);
});

test('a payload with no gsis id is refused rather than stored under a guess', () => {
  assert.equal(cleanRouteRow(payload({ gsis_id: null }), 2024, null), null);
  assert.equal(cleanRouteRow(payload({ total_targets: 0 }), 2024, null), null);
});

/**
 * No bare catch: a failing upstream is recorded and rethrown, never swallowed
 * into an empty result that reads downstream as "this receiver ran no routes".
 */
test('a failing fetch throws instead of returning an empty sync', async () => {
  await assert.rejects(
    () => syncRouteSplits([2024], { fetchJson: async () => { throw new Error('503 nflsavant'); } }),
    /503 nflsavant/
  );
});

test('syncRouteSplits stores what it pulled and reports its misses', async () => {
  const fetchJson = async url => {
    if (url.includes('route-spotlight')) return { receivers: [{ name: "Ja'Marr Chase" }, { name: 'Ghost Player' }] };
    if (url.includes('ja-marr-chase')) return payload();
    return payload({ gsis_id: null, name: 'Ghost Player' });
  };
  const out = await syncRouteSplits([2026], { fetchJson, delayMs: 0 });
  assert.equal(out.rows, 1);
  assert.equal(out.misses.length, 1);
  assert.equal(out.misses[0].reason, 'slug_miss');
  const stored = db.prepare(`SELECT COUNT(*) n FROM nfl_route_splits WHERE season=2026`).get().n;
  assert.equal(stored, 1);
});

/**
 * The key is four columns, matching nfl_ngs exactly
 * (server/db/schema/nfl-a-to-m.js:46), where one player-week holds a passing, a
 * receiving and a rushing row. Only 'routes' exists here today; the point is
 * that a second slice of the same source can land without altering an applied
 * migration, which this project does not do.
 */
test('two kinds coexist for one player-week', () => {
  const routes = cleanRouteRow(payload(), 2023, 7);
  upsertRouteSplits([routes, { ...routes, kind: 'routes_vs_man' }]);
  const kinds = db.prepare(`SELECT kind FROM nfl_route_splits
    WHERE season=2023 AND week=7 AND player_id='00-0036900' ORDER BY kind`).all().map(r => r.kind);
  assert.deepEqual(kinds, ['routes', 'routes_vs_man']);
});
