/**
 * FIX-285-1: the last three `?? 0.92` chance-to-play sites read avail.p_play.
 *
 * #285 routed trade-engine.js and season-sim.js through availPPlayWeek. Three
 * more callers still typed their own default, outside BROKEN-NUMBERS row E:
 *   - roster-risk.js:257           fragility's expected loss
 *   - role-scenario-engine.js:124  the inactive scenario's probability
 *   - news-fantasy-impact.js:87    a news item's baseline chance to play
 * With GRIDIRON_AVAIL_P_PLAY on, each now prices an unmeasured player at his
 * labelled prior and serves the typed unknown beside the number. With it off,
 * each serves exactly what it did (0.92 for that player, no p_play field).
 *
 * The ratchet at the end fails if a `?? 0.92` default appears anywhere in
 * served code (server/, client/src) outside contingency.js, which now holds the
 * one flag-off default, legacyActiveProbability.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-avail-p-play-sites-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '2';
delete process.env.GRIDIRON_AVAIL_P_PLAY;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const wrParams = targets => ({
  position: 'WR', attempts: 0, carries: 0, targets, dispersion: 10,
  ypa: 7, pass_td_rate: 0.045, int_rate: 0.025, ypc: 4.2, rush_td_rate: 0.03,
  catch_rate: 0.68, ypt: 8, rec_td_rate: 0.05
});
const projection = (id, name, gsis) => ({
  player_id: id, name, team: 'BBB', position: 'WR', gsis_id: gsis, ppg: 12, params: wrParams(8),
  ensemble_shift: 0, volume: { target_share: 0.2, targets_per_game: 8, carries_per_game: 0, attempts_per_game: 0 }
});
const ENGINE = () => new Map([[101, projection(101, 'Measured Veteran', 'meas-vet')],
  [102, projection(102, 'Unseen Rookie', 'unseen-rk')]]);
// Each distribution call records the chance to play it was handed.
const distributionCalls = [];
const realWeekEngine = await import('../server/services/player-week-engine.js');
mock.module('../server/services/player-week-engine.js', {
  namedExports: {
    ...realWeekEngine,
    buildPlayerWeekEngine: () => ENGINE(),
    playerWeekDistribution: (_p, opts = {}) => {
      distributionCalls.push(opts.activeProbability);
      return { p10: 4, p90: 20, mean: 12 * (opts.activeProbability ?? 1), boom_rate: 0.2, bust_rate: 0.1 };
    }
  }
});

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { weeklyAvailability } = await import('../server/services/contingency.js');
const pp = await import('../server/services/avail-p-play.js');
const { buildPlayerScenarios } = await import('../server/services/role-scenario-engine.js');
const { newsFantasyTracker } = await import('../server/services/news-fantasy-impact.js');
const { fragility } = await import('../server/services/roster-risk.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
const OFF = { GRIDIRON_AVAIL_P_PLAY: null, GRIDIRON_PREVIEW_UNCONFIRMED: null };
const ON = { GRIDIRON_AVAIL_P_PLAY: '1', GRIDIRON_PREVIEW_UNCONFIRMED: null };

/* ------------------------------------------------------------------ fixture */

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
     (1, 'AAA', 'Alpha', 'AFC', 'East'), (2, 'BBB', 'Beta', 'NFC', 'West')`);
for (let w = 1; w <= 14; w++) {
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 1, ?, 'BBB', 1)`, w);
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 2, ?, 'AAA', 0)`, w);
}
const player = (id, name, gsis, sleeper = null) =>
  run('INSERT INTO players (id, name, position, gsis_id, team_id, sleeper_id) VALUES (?,?,?,?,2,?)', id, name, 'WR', gsis, sleeper);
const usage = (id, season, week) =>
  run(`INSERT INTO player_week_usage (player_id, season, week, team, position, targets, carries, attempts)
       VALUES (?,?,?,'BBB','WR',5,0,0)`, id, season, week);
// 101: measured veteran. 102: never seen, no report (the row-E case).
player(101, 'Measured Veteran', 'meas-vet', 's101');
player(102, 'Unseen Rookie', 'unseen-rk', 's102');
for (const season of [2023, 2024, 2025]) for (let week = 1; week <= 16; week++) usage(101, season, week);
// 25 more measured, unlisted WRs, so the population prior has something to fit.
for (let i = 0; i < 25; i++) {
  player(200 + i, `Measured ${i}`, `meas-${i}`);
  for (const season of [2024, 2025]) for (let week = 1; week <= 10 + (i % 7); week++) usage(200 + i, season, week);
}
// The next game the news tracker targets.
run(`INSERT INTO game_lines (season, week, team, opponent, gameday) VALUES (2026, 2, 'BBB', 'AAA', '2026-09-14')`);

const PRIOR = () => pp.fittedUnknownPrior({ position: 'WR', rows: weeklyAvailability(2026, 2, { through: 2025 }), fitted: null });

test('control: the fixture prior is fitted and is not 0.92', () => {
  assert.equal(PRIOR().fitted, true);
  assert.notEqual(PRIOR().value, 0.92);
  assert.equal(weeklyAvailability(2026, 2).get(102).active_probability, 0.92, 'the old read prices him at the constant');
});

/* --------------------------------------------------------- the shared helper */

test('chanceToPlay: flag off is the old read; flag on is avail.p_play with its label', () => {
  assert.deepEqual(pp.chanceToPlay(null, undefined), { value: 0.92, p_play: null });
  assert.deepEqual(pp.chanceToPlay(null, { active_probability: 0 }), { value: 0, p_play: null }, '?? not ||');
  const week = pp.availPPlayWeek(2026, 2);
  const unknown = pp.chanceToPlay(week, null, 102, 'WR');
  assert.equal(unknown.value, PRIOR().value);
  assert.equal(unknown.p_play.status, 'unknown');
  assert.equal(unknown.p_play.p_play, null);
  assert.equal(unknown.p_play.prior.fitted, true);
  const ok = pp.chanceToPlay(week, null, 101, 'WR');
  assert.equal(ok.p_play.status, 'ok');
  assert.equal(ok.value, week.rows.get(101).active_probability);
});

/* ----------------------------------------------------- role-scenario-engine.js */

const scenarios = () => buildPlayerScenarios({ engine: ENGINE(), season: 2026, week: 2, playerId: 102 });

test('role scenarios, flag off: unchanged, 0.92 and no p_play', () => {
  const out = withEnv(OFF, scenarios);
  assert.equal(out.active_probability, 0.92);
  assert.equal('p_play' in out, false);
});

test('role scenarios, flag on: the unseen rookie is a typed unknown priced at the fitted prior', () => {
  const out = withEnv(ON, scenarios);
  assert.equal(out.active_probability, PRIOR().value);
  assert.equal(out.p_play.status, 'unknown');
  assert.equal(out.p_play.reason, 'no_games_no_report');
  const inactive = out.scenarios.find(s => s.id === 'inactive');
  assert.equal(+inactive.probability.toFixed(6), +(1 - PRIOR().value).toFixed(6), 'P(inactive) = 1 - prior');
});

/* ------------------------------------------------------ news-fantasy-impact.js */

const SIGNAL = { player_id: 102, player_name: 'Unseen Rookie', team: 'BBB', published_at: '2026-09-10T12:00:00Z',
  signal_type: 'role', role_delta: 0, confidence: 1 };
const track = () => newsFantasyTracker([SIGNAL]).signals[0].fantasy_model;

test('news impact, flag off: unchanged, the baseline is 0.92 and no p_play', () => {
  distributionCalls.length = 0;
  const model = withEnv(OFF, track);
  assert.equal(model.available, true, JSON.stringify(model));
  assert.equal(model.baseline_active_probability, 92);
  assert.equal('baseline_p_play' in model, false);
  assert.equal(distributionCalls[0], 0.92);
});

test('news impact, flag on: the baseline is the labelled prior and the typed unknown is served', () => {
  distributionCalls.length = 0;
  const model = withEnv(ON, track);
  assert.equal(distributionCalls[0], PRIOR().value, 'the baseline distribution ran on the prior, not 0.92');
  assert.equal(model.baseline_active_probability, +(PRIOR().value * 100).toFixed(1));
  assert.equal(model.baseline_p_play.status, 'unknown');
  assert.equal(model.baseline_p_play.p_play, null);
});

/* --------------------------------------------------------------- roster-risk.js */

const SLOTS = ['WR', 'WR'];
run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id, roster_positions)
     VALUES (285, 'sleeper', 'sl-285', 2026, 'Risk League', ?, 10, '1', ?)`,
JSON.stringify({ users: [{ user_id: 'u1' }], rosters: [{ roster_id: 1, owner_id: 'u1', players: ['s101', 's102'] }] }),
JSON.stringify(SLOTS));
const rookieRisk = () => fragility(285).most_fragile.find(r => r.name === 'Unseen Rookie');

test('fragility, flag off: unchanged, expected loss priced at 0.92 and no p_play', () => {
  const r = withEnv(OFF, rookieRisk);
  assert.ok(r, 'the rookie is a starter');
  assert.ok(r.cost_if_lost > 0, `control: losing him costs points (${r.cost_if_lost}), so the product is tested`);
  assert.equal(r.active_probability, 0.92);
  assert.equal('p_play' in r, false);
  assert.equal(r.expected_loss, +(r.cost_if_lost * (1 - 0.92)).toFixed(2));
});

test('fragility, flag on: expected loss uses the labelled prior and serves the typed unknown', () => {
  const r = withEnv(ON, rookieRisk);
  assert.equal(r.p_play.status, 'unknown');
  assert.equal(r.active_probability, PRIOR().value);
  assert.equal(r.expected_loss, +(r.cost_if_lost * (1 - PRIOR().value)).toFixed(2));
});

/* ------------------------------------------------------------------ ratchet */

function servedFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) servedFiles(full, out);
    else if (/\.(m?js|tsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('ratchet: no `?? 0.92` chance-to-play default in served code outside contingency.js', () => {
  const hits = [];
  for (const file of [...servedFiles(path.join(REPO, 'server')), ...servedFiles(path.join(REPO, 'client/src'))]) {
    const rel = path.relative(REPO, file);
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/^\s*(\*|\/\*)/.test(code)) return;             // block-comment lines
      if (/\?\?\s*0?\.92\b/.test(code)) hits.push(`${rel}:${i + 1}`);
    });
  }
  const outside = hits.filter(h => !h.startsWith('server/services/contingency.js:'));
  assert.deepEqual(outside, [], `a chance-to-play default outside contingency.js: ${outside.join(', ')}`);
  assert.equal(hits.length, 1, `contingency.js holds exactly one, legacyActiveProbability: ${hits.join(', ')}`);
});
