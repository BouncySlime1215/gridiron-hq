/**
 * AJ-HEALTHY: A.J. Brown (277) may move only for a Blue chip (83+) who is a consistent weekly scorer
 * now (Nick 9/24, ONE-PLAN 10b.3). This unit measures "consistent weekly scorer now" with a
 * pre-registered rule (campaign/consistent-now.js, CONSISTENT_NOW) and wires it into never-give.js's
 * consistentOf hook behind its own flag, GRIDIRON_AJ_HEALTHY=1. Flag off (the default): 277 stays
 * locked exactly as before. Made-up ids, names and points only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-aj-healthy-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const plansFile = path.join(temp, 'plans.json');
process.env.GRIDIRON_WARROOM_PLANS = plansFile;
delete process.env.GRIDIRON_WARROOM_OBJECTIVES;
delete process.env.GRIDIRON_AJ_HEALTHY;

const { row, rows, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const NG = await import('../server/services/campaign/never-give.js');
const CN = await import('../server/services/campaign/consistent-now.js');

const DB = { row, rows };
const L = 4, ME = '5', SEASON = 2026, WEEK = 5;

/* ------------------------------------------------------------ fixture */
// 301 steady WR chip, 302 boom/bust WR chip, 303 steady WR scored 80 (below Blue chip),
// 304 steady WR chip who is Out on this week's report, 305 steady chip with two games only.
const PLAYERS = [
  [80, 'Rb Pinned', 'RB'], [160, 'Wr Pinned', 'WR'], [277, 'Wr Maybe', 'WR'],
  [301, 'Steady Chip', 'WR'], [302, 'Boom Chip', 'WR'], [303, 'Steady Low', 'WR'],
  [304, 'Steady Hurt', 'WR'], [305, 'Steady New', 'WR'],
];
for (const [id, name, pos] of PLAYERS) {
  run('INSERT INTO players (id, name, position, espn_id, gsis_id) VALUES (?, ?, ?, ?, ?)', id, name, pos, 7000 + id, `G-${id}`);
}
const FC = { 80: 5000, 160: 5000, 277: 3000, 301: 6000, 302: 6000, 303: 6000, 304: 6000, 305: 6000 };
for (const [id, v] of Object.entries(FC)) run(`INSERT INTO player_metrics (player_id, source, value) VALUES (?, 'fc_value', ?)`, Number(id), v);
run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id, current_week)
     VALUES (?, 'espn', 'aj-4', ?, 'AJ League', '{"teams":[]}', 10, ?, ?)`, L, SEASON, ME, WEEK);
fs.writeFileSync(plansFile, JSON.stringify({ schema: 'warroom-plans/1', leagues: [{ league: L, me: ME,
  blue_chips: { status: 'ok', value: { rows: [[301, 90], [302, 90], [303, 80], [304, 90], [305, 90], [80, 88], [160, 93]]
    .map(([player, score]) => ({ player: String(player), score })) } } }] }));

// Weeks 1-4 actual (PPR) and expected points; week 5 is this week and is never read.
const WEEKS = {
  301: [[18, 16], [16, 15], [20, 17], [17, 16], [2, 2]],
  302: [[35, 14], [3, 12], [28, 13], [4, 12], [40, 14]],
  303: [[18, 16], [16, 15], [20, 17], [17, 16]],
  304: [[18, 16], [16, 15], [20, 17], [17, 16]],
  305: [[null, null], [null, null], [20, 17], [17, 16]],
};
for (const [id, ws] of Object.entries(WEEKS)) {
  ws.forEach(([actual, expected], i) => {
    if (actual == null) return;
    run(`INSERT INTO nfl_ffopportunity_weekly (season, week, player_gsis_id, position, expected_fantasy_points, actual_fantasy_points,
         source_release, ingested_at) VALUES (?, ?, ?, 'WR', ?, ?, 'test', 'now')`, SEASON, i + 1, `G-${id}`, expected, actual);
  });
}
// This week's injury report: every player's team has filed (team column), 304 is Out.
run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (901, 'ZZA', 'Made-up Team', 'AFC', 'East')`);
run('UPDATE players SET team_id = 901');
for (const id of [301, 302, 303, 304, 305]) {
  run(`INSERT INTO nfl_injuries (season, week, gsis_id, team, report_status) VALUES (?, ?, ?, 'ZZA', ?)`,
    SEASON, WEEK, `G-${id}`, id === 304 ? 'Out' : null);
}

const env = on => ({ ...process.env, ...(on ? { GRIDIRON_AJ_HEALTHY: '1' } : {}) });

/* ------------------------------------------------------------ the pure rule */

test('CONSISTENT_NOW is pre-registered and frozen', () => {
  assert.equal(CN.CONSISTENT_NOW.version, 'consistent-now-v1');
  assert.ok(Object.isFrozen(CN.CONSISTENT_NOW));
  assert.equal(CN.CONSISTENT_NOW.lookback, 4);
  assert.equal(CN.CONSISTENT_NOW.min_games, 3);
  assert.equal(CN.CONSISTENT_NOW.max_cv, 0.4);
  assert.equal(CN.CONSISTENT_NOW.min_floor_share, 0.75);
  assert.deepEqual({ ...CN.CONSISTENT_NOW.floor_pts }, { QB: 15, RB: 10, WR: 10, TE: 8 });
});

test('a steady healthy scorer with a real role is consistent', () => {
  const v = CN.consistencyVerdict([{ actual: 18, expected: 16 }, { actual: 16, expected: 15 }, { actual: 20, expected: 17 }, { actual: 17, expected: 16 }],
    { position: 'WR', role: 'healthy' });
  assert.equal(v.consistent, true, JSON.stringify(v));
  assert.deepEqual(v.reasons, []);
  assert.equal(v.games, 4);
});

test('boom/bust fails on variance and floor, never on the mean', () => {
  const v = CN.consistencyVerdict([{ actual: 35, expected: 14 }, { actual: 3, expected: 12 }, { actual: 28, expected: 13 }, { actual: 4, expected: 12 }],
    { position: 'WR', role: 'healthy' });
  assert.equal(v.consistent, false);
  assert.ok(v.reasons.includes('high_variance'), v.reasons.join());
  assert.ok(v.reasons.includes('below_floor'), v.reasons.join());
});

test('too few games, a low-usage role, an unhealthy or unknown report, or no position all fail closed', () => {
  const steady = [{ actual: 18, expected: 16 }, { actual: 16, expected: 15 }, { actual: 20, expected: 17 }, { actual: 17, expected: 16 }];
  assert.deepEqual(CN.consistencyVerdict(steady.slice(0, 2), { position: 'WR', role: 'healthy' }).reasons, ['too_few_games']);
  const lucky = steady.map(w => ({ ...w, expected: 6 }));
  assert.deepEqual(CN.consistencyVerdict(lucky, { position: 'WR', role: 'healthy' }).reasons, ['no_established_role']);
  assert.deepEqual(CN.consistencyVerdict(steady, { position: 'WR', role: 'unhealthy' }).reasons, ['not_healthy']);
  assert.deepEqual(CN.consistencyVerdict(steady, { position: 'WR', role: 'unknown' }).reasons, ['not_healthy']);
  assert.deepEqual(CN.consistencyVerdict(steady, { position: 'K', role: 'healthy' }).reasons, ['no_position_floor']);
  assert.deepEqual(CN.consistencyVerdict([], { position: 'WR', role: 'healthy' }).reasons, ['too_few_games']);
});

/* ------------------------------------------------------------ the reader */

test('readConsistency reads prior weeks and this week\'s report, one verdict per player', () => {
  const { byId, sources } = CN.readConsistency(DB, { season: SEASON, week: WEEK, ids: [301, 302, 304, 305] });
  assert.equal(sources.weekly.status, 'ok');
  assert.equal(byId.get('301').consistent, true, JSON.stringify(byId.get('301')));
  assert.equal(byId.get('301').games, 4, 'week 5 (this week) is never read');
  assert.equal(byId.get('302').consistent, false);
  assert.deepEqual(byId.get('304').reasons, ['not_healthy']);
  assert.deepEqual(byId.get('305').reasons, ['too_few_games']);
});

test('readConsistency with no weekly table says so and certifies nobody', () => {
  const fake = { row: () => null, rows: () => [] };
  const { byId, sources } = CN.readConsistency(fake, { season: SEASON, week: WEEK, ids: [301] });
  assert.equal(sources.weekly.status, 'table_absent');
  assert.equal(byId.get('301').consistent, false);
});

/* ------------------------------------------------------------ the gate */

const gives277For = (gate, get) => gate.check({ give: ['277'], get });

test('flag off: 277 stays locked even for a consistent Blue chip (byte-for-byte the incumbent rule)', () => {
  const g = NG.ruleGate(DB, { leagueId: L, env: env(false) });
  const v = gives277For(g, ['301']);
  assert.equal(v.ok, false);
  assert.deepEqual(v.reasons, ['never_give']);
  assert.equal(g.rules.consistency, 'off');
});

test('flag on: 277 may move for a consistent healthy Blue chip, and only that', () => {
  const g = NG.ruleGate(DB, { leagueId: L, env: env(true) });
  assert.equal(g.rules.consistency, 'ok');
  assert.equal(gives277For(g, ['301']).ok, true, JSON.stringify(gives277For(g, ['301'])));
  assert.deepEqual(gives277For(g, ['302']).reasons, ['never_give'], 'boom/bust chip');
  assert.ok(gives277For(g, ['303']).reasons.includes('never_give'), 'consistent but scored 80');
  assert.deepEqual(gives277For(g, ['304']).reasons, ['never_give'], 'Out on this week\'s report');
  assert.deepEqual(gives277For(g, ['305']).reasons, ['never_give'], 'two games');
});

test('flag on: Nico Collins (160) and Chase Brown (80) stay locked whatever the get', () => {
  const g = NG.ruleGate(DB, { leagueId: L, env: env(true) });
  assert.deepEqual(g.check({ give: ['160'], get: ['301'] }).reasons, ['never_give']);
  assert.deepEqual(g.check({ give: ['80'], get: ['301'] }).reasons, ['never_give']);
  assert.ok(g.check({ give: ['160', '277'], get: ['301'] }).reasons.includes('never_give'));
});

test('flag on: 277 plus a consistent chip still has to pass the overpay rule', () => {
  const g = NG.ruleGate(DB, { leagueId: L, env: env(true) });
  // 277 (3000) + 301 (6000) for 302 (6000): overpays and 302 is not consistent.
  const v = g.check({ give: ['277', '301'], get: ['302'] });
  assert.ok(v.reasons.includes('overpay'));
  assert.ok(v.reasons.includes('never_give'));
});

test('flag on without a current week: 277 stays locked and the source says why', () => {
  run('UPDATE leagues SET current_week = NULL WHERE id = ?', L);
  try {
    const g = NG.ruleGate(DB, { leagueId: L, env: env(true) });
    assert.equal(g.rules.consistency, 'no_week');
    assert.deepEqual(gives277For(g, ['301']).reasons, ['never_give']);
  } finally {
    run('UPDATE leagues SET current_week = ? WHERE id = ?', WEEK, L);
  }
});

test('the gate never lets 277 go through GRIDIRON_PREVIEW_UNCONFIRMED', () => {
  const g = NG.ruleGate(DB, { leagueId: L, env: { ...process.env, GRIDIRON_PREVIEW_UNCONFIRMED: '1' } });
  assert.deepEqual(gives277For(g, ['301']).reasons, ['never_give']);
});

/* ------------------------------------------------------------ the grade (pre-registered bar) */

test('gradeConsistency: flagged players must hold their floor forward by the pre-registered margin', () => {
  // 60 steady players who stay steady, 60 boom/bust players who stay boom/bust, each over weeks 1-12.
  const series = [];
  for (let p = 0; p < 60; p++) {
    series.push({ player: `s${p}`, position: 'WR', season: 2024, weeks: Array.from({ length: 12 }, (_, w) => ({ week: w + 1, actual: 15 + ((p + w) % 3), expected: 14 })) });
    series.push({ player: `b${p}`, position: 'WR', season: 2024, weeks: Array.from({ length: 12 }, (_, w) => ({ week: w + 1, actual: (p + w) % 2 ? 30 : 4, expected: 14 })) });
  }
  const g = CN.gradeConsistency(series, { seed: 7 });
  assert.equal(g.bar.version, 'consistent-now-v1');
  assert.ok(g.flagged.n >= 200, JSON.stringify(g.flagged));
  assert.ok(g.flagged.forward_floor_share > 0.95);
  assert.ok(g.comparison.forward_floor_share < 0.6);
  assert.ok(g.diff_ci95[0] > 0);
  assert.equal(g.pass, true, JSON.stringify(g));

  // No signal: everyone is steady for four weeks and then random, so flagged == comparison.
  const noise = series.map(s => ({ ...s, weeks: s.weeks.map(w => ({ ...w, actual: w.week <= 4 ? 16 : ((w.week * 7 + s.player.length) % 2 ? 30 : 4) })) }));
  const n = CN.gradeConsistency(noise, { seed: 7 });
  assert.equal(n.pass, false);
  assert.ok(n.fails.length > 0);
});
