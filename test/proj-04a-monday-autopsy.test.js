/**
 * PROJ-04-a Monday Autopsy (ENGINE-SPECS.md, PROJ-04-a row). The RED list:
 *   1. link parts sum exactly to (actual - projection) for every row (1e-9);
 *   2. a TD-only miss is classed 100% luck;
 *   3. a fixture reproduces the example line
 *      ("Missed X by 11: 6 from targets, 5 TD luck");
 *   4. the job writes one row per player-link-week (migration 092), grades each
 *      start/sit call decision vs luck, and stores a plain summary.
 * Plus: exit and news-missed routing, Vegas miss in the script detail, and a
 * links failure surfaced in the stored summary rather than swallowed.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-proj04a-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');

const { db, run, rows, row } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const L = await import('../server/services/autopsy-links.js');
const { runMondayAutopsy, refreshMondayAutopsy, storedAutopsy } = await import('../server/services/monday-autopsy.js');

after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const sumLinks = links => Object.values(links).reduce((a, b) => a + b, 0);

// A receiver projected for 14 of his team's 35 targets at 1.5 points a target (21 PPR).
const WR_LINKS = {
  plays: { value: 65, team: { pass_att: 40, rush_att: 25, target_rate: 0.875 } },
  pass_rate: { value: 40 / 65 },
  volume: { targets: { value: 14 }, carries: { value: 0 }, attempts: 0 },
  eff: { catch_rate: 0.5, yards_per_target: 5, yards_per_carry: 0, yards_per_attempt: 0, int_rate: 0 },
  td: { rec_td_rate: 1 / 12, rush_td_rate: 0, pass_td_rate: 0 }
};
const TEAM = { attempts: 40, targets: 35, carries: 25 };
const box = o => ({ targets: 0, receptions: 0, receiving_yards: 0, receiving_tds: 0, carries: 0, rushing_yards: 0,
  rushing_tds: 0, attempts: 0, passing_yards: 0, passing_tds: 0, interceptions: 0, ...o });

// ---- 1. identity ---------------------------------------------------------------

test('RED 1: links sum to actual - projection to 1e-9, on every shape of row', () => {
  const projected = L.stateFromLinks(WR_LINKS);
  assert.ok(Math.abs(L.chainPoints(projected) - 21) < 1e-9, 'the fixture links rebuild 21 points');
  const cases = [
    { actual: 10, player: box({ targets: 10, receptions: 5, receiving_yards: 50 }), team: TEAM },
    { actual: 31.4, player: box({ targets: 9, receptions: 7, receiving_yards: 124, receiving_tds: 2, carries: 1, rushing_yards: 5 }),
      team: { attempts: 52, targets: 47, carries: 14 } },
    { actual: -1.2, player: box({ targets: 1 }), team: { attempts: 22, targets: 20, carries: 38 },
      snaps: { share: 0.12, prior: 0.8 } },
    { actual: 0, player: box({}), team: { attempts: 0, targets: 0, carries: 0 } },
    { actual: 14.3, player: box({ targets: 6, receptions: 4, receiving_yards: 43 }), team: TEAM,
      news: [{ signal_type: 'role' }] }
  ];
  for (const [i, c] of cases.entries()) {
    for (const projection of [21, 17.25, 0]) {
      const actualState = L.stateFromUsage(c.player, c.team, projected);
      const { links } = L.splitMiss({ projection, actual: c.actual, projected, actualState,
        snaps: c.snaps, newsMissed: c.news ?? [] });
      assert.deepEqual(Object.keys(links), [...L.LINKS]);
      assert.ok(Math.abs(sumLinks(links) - (c.actual - projection)) < 1e-9, `case ${i} projection ${projection}`);
    }
  }
  const none = L.splitMiss({ projection: 12, actual: 3, projected: null, actualState: null });
  assert.equal(none.basisOk, false);
  assert.ok(Math.abs(sumLinks(none.links) - (3 - 12)) < 1e-9, 'no basis: the whole miss is the blend link');
});

// ---- 2. TD-only miss is luck --------------------------------------------------

test('RED 2: a TD-only miss is classed 100% luck', () => {
  const projected = L.stateFromLinks(WR_LINKS);
  // Exactly his projected volume and efficiency; two touchdowns instead of 14/12.
  const player = box({ targets: 14, receptions: 7, receiving_yards: 70, receiving_tds: 2 });
  const actual = 7 + 7 + 12;
  const { links } = L.splitMiss({ projection: 21, actual, projected, actualState: L.stateFromUsage(player, TEAM, projected) });
  const luck = Object.entries(links).reduce((s, [l, p]) => s + (L.IS_LUCK[l] ? p : 0), 0);
  const knowable = Object.entries(links).reduce((s, [l, p]) => s + (L.IS_LUCK[l] ? 0 : p), 0);
  assert.ok(Math.abs(links.td - (actual - 21)) < 1e-9, `td link carries the whole miss: ${links.td}`);
  assert.ok(Math.abs(luck / (actual - 21) - 1) < 1e-9);
  assert.ok(Math.abs(knowable) < 1e-9);
});

// ---- 3. the example line -----------------------------------------------------

test('RED 3: the fixture reproduces "Missed X by 11: 6 from targets, 5 TD luck"', () => {
  const projected = L.stateFromLinks(WR_LINKS);
  const player = box({ targets: 10, receptions: 5, receiving_yards: 50 });
  const { links } = L.splitMiss({ projection: 21, actual: 10, projected, actualState: L.stateFromUsage(player, TEAM, projected) });
  assert.ok(Math.abs(links.share + 6) < 1e-9 && Math.abs(links.td + 5) < 1e-9, JSON.stringify(links));
  assert.equal(L.playerLine('X', 10 - 21, links, { channel: L.shareChannel(projected) }),
    'Missed X by 11: 6 from targets, 5 TD luck');
});

// ---- routing: exit, news, calls ------------------------------------------------

test('a snap collapse moves the lost volume to the exit link; a missed signal moves share to news_missed', () => {
  const projected = L.stateFromLinks(WR_LINKS);
  const player = box({ targets: 3, receptions: 2, receiving_yards: 20 });
  const actualState = L.stateFromUsage(player, TEAM, projected);
  const hurt = L.splitMiss({ projection: 21, actual: 4, projected, actualState, snaps: { share: 0.2, prior: 0.8 } });
  assert.equal(hurt.exit.detected, true);
  assert.ok(Math.abs(hurt.links.exit + 9 * 1.5) < 1e-9, `3 targets over 20% of snaps is 12 over 80%: ${hurt.links.exit}`);
  const healthy = L.splitMiss({ projection: 21, actual: 4, projected, actualState, snaps: { share: 0.75, prior: 0.8 } });
  assert.equal(healthy.exit.detected, false);
  assert.equal(healthy.links.exit, 0);
  const news = L.splitMiss({ projection: 21, actual: 4, projected, actualState, newsMissed: [{ signal_type: 'role' }] });
  assert.equal(news.links.share, 0);
  assert.ok(news.links.news_missed < 0);
  assert.equal(L.IS_LUCK.news_missed, 0);
});

test('start/sit calls: decision quality separate from outcome luck', () => {
  const S = { id: 1, projection: 21, actual: 10, links: { share: -6, td: -5 } };
  const lucky = L.gradeCall(S, { id: 2, projection: 15, actual: 17, links: { blend: -4, td: 6 } });
  assert.equal(lucky.decision, 'right');
  assert.equal(lucky.verdict, 'right call, unlucky');
  const model = L.gradeCall(S, { id: 2, projection: 15, actual: 17, links: { share: 8, td: -6 } });
  assert.match(model.verdict, /^model miss/);
  assert.equal(L.gradeCall(S, { id: 2, projection: 25, actual: 5, links: {} }).outcome, 'lucky');
  assert.equal(L.gradeCall(S, { id: 2, projection: 15, actual: 5, links: {} }).verdict, 'right call');
  assert.equal(L.sourceRight(21, 14, 10), 'espn');
  assert.equal(L.sourceRight(12, 14, 10), 'ours');
});

// ---- 4. the job and the store ------------------------------------------------

const SEASON = 2026, WEEK = 3;
function seed() {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id) VALUES (4, 'espn', 'fixture', ?, 'Fixture', '1')`, SEASON);
  const players = [[101, 'Test Receiver', 'WR'], [102, 'Bench Receiver', 'WR'], [103, 'Team Passer', 'QB'],
    [104, 'Team Runner', 'RB'], [105, 'Team Receiver', 'WR'], [106, 'Other Passer', 'QB']];
  for (const [id, name, pos] of players) run('INSERT INTO players (id, name, position) VALUES (?,?,?)', id, name, pos);
  const usage = (id, week, team, pos, o) => run(`INSERT INTO player_week_usage (player_id, season, week, team, position,
      attempts, carries, targets, receptions, passing_yards, rushing_yards, receiving_yards, passing_tds, rushing_tds,
      receiving_tds, interceptions, fumbles_lost) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
  id, SEASON, week, team, pos, o.attempts ?? 0, o.carries ?? 0, o.targets ?? 0, o.receptions ?? 0, o.passing_yards ?? 0,
  o.rushing_yards ?? 0, o.receiving_yards ?? 0, o.passing_tds ?? 0, o.rushing_tds ?? 0, o.receiving_tds ?? 0, 0);
  // Team AAA, week 3: 40 attempts, 35 targets, 25 carries -- exactly the projected chain.
  usage(103, WEEK, 'AAA', 'QB', { attempts: 40 });
  usage(104, WEEK, 'AAA', 'RB', { carries: 25 });
  usage(105, WEEK, 'AAA', 'WR', { targets: 25 });
  usage(101, WEEK, 'AAA', 'WR', { targets: 10, receptions: 5, receiving_yards: 50 });
  // Team BBB, weeks 2 and 3 identical, and the bench receiver's week 3 adds one TD.
  for (const w of [2, 3]) {
    usage(106, w, 'BBB', 'QB', { attempts: 35 });
    usage(102, w, 'BBB', 'WR', { targets: 8, receptions: 5, receiving_yards: 60, receiving_tds: w === 3 ? 1 : 0 });
  }
  const snap = (id, prediction) => run(`INSERT INTO weekly_prediction_snapshots (season, week, player_id, position, as_of,
      cutoff, engine_version, structural, prediction) VALUES (?,?,?,'WR','2026-09-18T12:00:00Z','2026-09-18','fixture',?,?)`,
  SEASON, WEEK, id, prediction, prediction);
  snap(101, 21);
  snap(102, 15);
  const roster = (id, name, starter, espn) => run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id,
      team_id, espn_player_id, player_id, player_name, position, lineup_slot_id, lineup_slot, is_starter, projected_points,
      actual_points, source, first_seen_at, changed_at) VALUES (4,?,?,1,?,?,?,'WR',?,?,?,?,NULL,'final','x','x')`,
  SEASON, WEEK, 9000 + id, id, name, starter ? 4 : 20, starter ? 'WR' : 'BENCH', starter ? 1 : 0, espn);
  roster(101, 'Test Receiver', true, 14);
  roster(102, 'Bench Receiver', false, 12);
  for (const [team, spread, us, them] of [['AAA', -3, 20, 27], ['BBB', 2.5, 24, 21]]) {
    run(`INSERT INTO game_lines (season, week, team, spread, total, team_score, opp_score, gameday, gametime)
      VALUES (?,?,?,?,45,?,?,'2026-09-20','13:00')`, SEASON, WEEK, team, spread, us, them);
  }
  run(`INSERT INTO nfl_news_signals (news_id, player_key, player_id, player_name, team, signal_type, confidence,
      published_at, evidence_span, extractor_version, verification_state)
    VALUES (1, 'bench-receiver', '102', 'Bench Receiver', 'BBB', 'role', 0.9, '2026-09-19T15:00:00Z', 'fixture', 'v1', 'verified')`);
}

test('RED 4: the job writes one row per player-link-week, grades the call and stores the summary', async () => {
  seed();
  assert.ok(row(`SELECT 1 FROM schema_migrations WHERE name='092_projection_autopsy'`), 'migration 092 applied');
  const linksFor = async () => ({ byId: new Map([[101, WR_LINKS]]), error: null });
  const out = await runMondayAutopsy({ leagueId: 4, season: SEASON, week: WEEK, linksFor, now: '2026-09-22T12:00:00Z' });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.players, 2);
  const linkRows = rows('SELECT * FROM projection_autopsy WHERE league_id=4 AND season=? AND week=?', SEASON, WEEK);
  assert.equal(linkRows.length, 2 * L.LINKS.length, 'one row per player-link-week');
  for (const p of rows('SELECT * FROM projection_autopsy_player WHERE league_id=4 AND week=?', WEEK)) {
    const sum = linkRows.filter(r => r.player_id === p.player_id).reduce((s, r) => s + r.points, 0);
    assert.ok(Math.abs(sum - p.miss) < 1e-9, `player ${p.player_id}: ${sum} vs ${p.miss}`);
    assert.ok(Math.abs(p.miss - (p.actual - p.projected)) < 1e-9);
  }
  const starter = row('SELECT * FROM projection_autopsy_player WHERE player_id=101');
  assert.equal(starter.basis, 'links');
  assert.equal(starter.line, 'Missed Test Receiver by 11: 6 from targets, 5 TD luck');
  const bench = row('SELECT * FROM projection_autopsy_player WHERE player_id=102');
  assert.equal(bench.basis, 'prior_weeks', 'no links for him: his own prior weeks');
  assert.equal(row(`SELECT source_right FROM projection_autopsy WHERE player_id=101 AND link='td'`).source_right, 'espn');
  const script = JSON.parse(row(`SELECT detail_json FROM projection_autopsy WHERE player_id=101 AND link='script'`).detail_json);
  assert.deepEqual(script, { spread: -3, total: 45, final_margin: -7, vegas_off: -10 });
  const news = JSON.parse(row(`SELECT detail_json FROM projection_autopsy WHERE player_id=102 AND link='news_missed'`).detail_json);
  assert.equal(news.signals.length, 1, 'a verified signal after our snapshot and before kickoff is news we missed');
  const stored = storedAutopsy(4, SEASON, WEEK);
  assert.equal(stored.calls.length, 1);
  assert.equal(stored.calls[0].verdict, 'right call, unlucky');
  assert.match(stored.summary, /^Week 3: 1 starters scored 10 against 21 projected/);
  assert.match(stored.summary, /Test Receiver over Bench Receiver \(right call, unlucky\)/);
  assert.equal(stored.links_error, null);

  // Re-running replaces the week; it never duplicates it.
  await runMondayAutopsy({ leagueId: 4, season: SEASON, week: WEEK, linksFor });
  assert.equal(row('SELECT COUNT(*) n FROM projection_autopsy WHERE week=?', WEEK).n, 2 * L.LINKS.length);
});

test('a links failure runs the week on prior weeks and says so in the stored summary', async () => {
  const linksFor = async () => { throw new Error('fixture: projections unavailable'); };
  const out = await runMondayAutopsy({ leagueId: 4, season: SEASON, week: WEEK, linksFor });
  assert.equal(out.ok, true);
  assert.equal(out.links_error, 'fixture: projections unavailable');
  const stored = storedAutopsy(4, SEASON, WEEK);
  assert.match(stored.summary, /Projection links unavailable \(fixture: projections unavailable\)/);
  assert.equal(stored.links_error, 'fixture: projections unavailable');
  // The starter has no prior weeks in the fixture: basis none, whole miss in blend, identity still exact.
  const p = stored.players.find(x => x.player_id === 101);
  assert.equal(p.basis, 'none');
  assert.ok(Math.abs(p.links.blend - p.miss) < 1e-9);
});

test('the scheduler entry skips a week already stored, and the job is registered', async () => {
  const again = await refreshMondayAutopsy({ leagueId: 4, season: SEASON, linksFor: async () => ({ byId: new Map(), error: null }) });
  assert.equal(again.skipped, true);
  const { JOBS } = await import('../server/services/scheduler.js');
  assert.equal(typeof JOBS.monday_autopsy?.run, 'function');
});
