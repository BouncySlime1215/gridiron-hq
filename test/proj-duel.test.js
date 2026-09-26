/**
 * PROJ-DUEL: ESPN's frozen weekly projection beside our shadow model (E-XGB arm A_xgb), from the one
 * producer (services/proj-duel). Pinned here:
 *   - rows read the grader's own inputs (frozen ESPN, latest pre-kickoff forecast; a late forecast is
 *     never shown), starters and plan targets first, then the biggest disagreement
 *   - after the week is final each row carries the actual and a "closer" side
 *   - the scoreboard is the grader's weekly MAEs (latest grade), weeks won, honest n, "Not proven yet"
 *   - Coach's one line per player, and the label; no served surface reads the duel
 * Made-up players only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-proj-duel-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_WARROOM_PLANS = path.join(temp, 'plans.json');
fs.writeFileSync(process.env.GRIDIRON_WARROOM_PLANS, JSON.stringify({ leagues: [{ league: 71, targets: { status: 'ok', value: [{ player: 8804 }] } }] }));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { projDuel, duelScoreboard, duelFacts, recordText, TESTING_LABEL } = await import('../server/services/proj-duel/index.js');

const S = 2026, W = 3;
// 8801 starter, 8802 bench (small gap), 8803 bench (big gap), 8804 plan target, 8805 no forecast.
const P = [[8801, 'Duel Starter', 'RB', 7801], [8802, 'Small Gap', 'WR', 7802], [8803, 'Big Gap', 'WR', 7803],
  [8804, 'Plan Target', 'TE', 7804], [8805, 'No Forecast', 'QB', 7805]];
for (const [id, name, pos, espn] of P) run('INSERT INTO players (id, name, position, espn_id) VALUES (?, ?, ?, ?)', id, name, pos, espn);
const KICK = '2026-09-21T17:00:00.000Z';
const espnRow = (pid, espn, pts, pos) => run(`INSERT INTO espn_weekly_projection_snapshots (season, week, player_id, espn_id, position, projected_pts,
  scoring_key, captured_at, kickoff_at, late, window_key, capture_id, source_url_hash) VALUES (?, ?, ?, ?, ?, ?, 'ppr', '2026-09-20T12:00:00.000Z', ?, 0, 'w', 'c', 'h')`,
  S, W, pid, espn, pos, pts, KICK);
espnRow(8801, 7801, 14.2, 'RB'); espnRow(8802, 7802, 10, 'WR'); espnRow(8803, 7803, 12, 'WR'); espnRow(8804, 7804, 8, 'TE'); espnRow(8805, 7805, 20, 'QB');
const fc = (pid, pred, { late = 0, at = '2026-09-20T15:00:00.000Z', arm = 'A_xgb' } = {}) => run(`INSERT INTO exgb_shadow_predictions
  (season, week, player_id, espn_id, position, arm, prediction, espn_input, predicted_at, kickoff_at, late, run_id) VALUES (?, ?, ?, NULL, 'X', ?, ?, NULL, ?, ?, ?, 'r1')`,
  S, W, pid, arm, pred, at, KICK, late);
fc(8801, 9.1); fc(8802, 11); fc(8803, 4); fc(8804, 9); fc(8804, 30, { late: 1, at: '2026-09-21T18:00:00.000Z' }); fc(8803, 99, { arm: 'B1' });
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload) VALUES (71, 'espn', 'pd-71', 2026, 'Duel', '1', 10, 1, ?)`,
  JSON.stringify({ teams: [{ id: 1, roster: { entries: [{ lineupSlotId: 2, playerPoolEntry: { player: { id: 7801 } } },
    { lineupSlotId: 20, playerPoolEntry: { player: { id: 7802 } } }, { lineupSlotId: 20, playerPoolEntry: { player: { id: 7803 } } }] } }] }));
const LG = { id: 71, my_team_id: '1', payload: JSON.stringify({ teams: [{ id: 1, roster: { entries: [{ lineupSlotId: 2, playerPoolEntry: { player: { id: 7801 } } }] } }] }) };

test('before the games: both numbers per player, starter and target pinned, then the biggest gap; a late forecast never shows', async () => {
  const d = await projDuel(LG, { season: S, week: W, now: new Date('2026-09-20T20:00:00Z') });
  assert.equal(d.status, 'ok');
  assert.equal(d.label, TESTING_LABEL);
  assert.deepEqual(d.rows.map(r => r.name), ['Duel Starter', 'Plan Target', 'Big Gap', 'Small Gap'], 'no forecast -> no row; pins, then |gap|');
  const t = d.rows.find(r => r.name === 'Plan Target');
  assert.deepEqual([t.espn, t.ours, t.gap, t.target], [8, 9, 1, true], 'the pre-kickoff forecast (9), not the late one (30)');
  assert.ok(d.rows.every(r => r.closer === null && r.actual === null), 'no closer chip before the week is final');
});

test('after the games: the actual and which side was closer', async () => {
  run(`INSERT INTO game_lines (season, week, team, gameday, gametime) VALUES (2026, 3, 'AAA', '2026-09-21', '13:00')`);
  run(`INSERT INTO player_week_usage (player_id, season, week, receptions, receiving_yards) VALUES (8803, 2026, 3, 1, 30)`);
  const d = await projDuel(LG, { season: S, week: W, now: new Date('2026-09-25T00:00:00Z') });
  assert.equal(d.final, true);
  const big = d.rows.find(r => r.name === 'Big Gap');
  assert.equal(big.actual, 4, '1 catch 30 yards PPR');
  assert.equal(big.closer, 'ours', 'ours 4 vs ESPN 12');
  assert.equal(d.rows.find(r => r.name === 'Duel Starter').closer, 'ours', 'no stat line scores 0: ours 9.1 beats 14.2');
});

test('scoreboard: the grader\'s latest weekly MAEs, weeks won, honest n, never proven here', () => {
  assert.deepEqual([duelScoreboard(S).weeks, duelScoreboard(S).n, duelScoreboard(S).verdict_text], [0, 0, 'Not proven yet']);
  const g = (week, pos, n, model, espn, at) => run(`INSERT INTO exgb_weekly_grades (season, week, position, arm, graded_at, signature, n, mae_model, mae_espn,
    confirmatory, provisional) VALUES (2026, ?, ?, 'A_xgb', ?, 's', ?, ?, ?, 0, 1)`, week, pos, at, n, model, espn);
  g(1, 'RB', 100, 5, 6, '2026-09-10'); g(1, 'WR', 100, 6, 5.5, '2026-09-10');    // week 1: 5.5 vs 5.75 -> won
  g(2, 'RB', 100, 7, 5, '2026-09-17'); g(2, 'RB', 100, 4, 5, '2026-09-18');       // week 2: the later grade (4 vs 5) counts -> won
  g(3, 'WR', 50, 8, 6, '2026-09-24');                                               // week 3: lost
  const b = duelScoreboard(S);
  assert.deepEqual([b.weeks, b.won, b.lost, b.n], [3, 2, 1, 350]);
  assert.equal(b.mae_ours, +((5 * 100 + 6 * 100 + 4 * 100 + 8 * 50) / 350).toFixed(1));
  assert.equal(b.verdict_text, 'Not proven yet');
  assert.equal(recordText(b), 'ours 2-1 vs ESPN so far');
});

test('Coach\'s one line per player, and nothing served reads the duel', () => {
  const [f] = duelFacts(S, W, [8801]);
  assert.equal(f.line, 'ESPN 14.2, our model 9.1 (shadow; ours 2-1 vs ESPN so far)');
  assert.equal(f.used_for_numbers, false);
  const readers = [];
  const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else if (p.endsWith('.js') && !p.includes(`${path.sep}migrations${path.sep}`) && /proj-duel/.test(fs.readFileSync(p, 'utf8')) && !path.relative(ROOT, p).includes(`services${path.sep}proj-duel${path.sep}`)) readers.push(path.relative(ROOT, p));
  } };
  walk(path.join(ROOT, 'server'));
  assert.deepEqual(readers.sort(), ['server/index.js', 'server/routes/proj-duel.js', 'server/services/coach/preload.js', 'server/services/scheduler.js'],
    'only the route, the server mount, Coach\'s bundle and the explain job read it: no served number');
});

test('drivers: stored beside each forecast, only shown when the recomputed prediction equals the stored one; predictions untouched', async () => {
  const { ingestDrivers, driversText, featureText } = await import('../server/services/proj-duel/explain.js');
  const { rows } = await import('../server/db/index.js');
  const crypto = await import('node:crypto');
  const hash = () => crypto.createHash('sha256').update(JSON.stringify(rows('SELECT * FROM exgb_shadow_predictions ORDER BY season, week, arm, player_id, predicted_at'))).digest('hex');
  const before = hash();
  const r = ingestDrivers({ season: S, week: W, manifest_sha256: 'm1', rows: [
    { player_id: 8801, arm: 'A_xgb', prediction: 9.1, base: 8, contribs: [{ feature: 'trail3_carries', contribution: -2.1, value: 11 },
      { feature: 'team_implied', contribution: -1.2, value: 20.5 }, { feature: 'opp_allowed_pos_trail', contribution: -0.8, value: 18.2 },
      { feature: 'home', contribution: 0.4, value: 1 }], expected: { trail3_carries: 17, trail3_targets: 2 } },
    { player_id: 8803, arm: 'A_xgb', prediction: 4.5, base: 8, contribs: [], expected: {} }] });
  assert.deepEqual(r, { inserted: 2, matched: 1, mismatched: 1 }, '8803 recomputed 4.5 but stored 4: flagged, never shown');
  assert.equal(hash(), before, 'the stored predictions are byte-identical');
  assert.equal(driversText({ ours: 9.1, espn: 14.2, contribs: [{ feature: 'trail3_carries', contribution: -2.1, value: 11 },
    { feature: 'team_implied', contribution: -1.2, value: 20.5 }, { feature: 'opp_allowed_pos_trail', contribution: -0.8, value: 18.2 },
    { feature: 'home', contribution: 0.4, value: 1 }], position: 'RB' }),
  'Ours lower: 3-week carries 11, team implied 20.5, opponent allows 18.2 to RBs lately.');
  assert.equal(featureText('missed_last_team_game', 1), 'missed the last team game');
  const d = await projDuel(LG, { season: S, week: W, now: new Date('2026-09-25T00:00:00Z') });
  assert.match(d.rows.find(x => x.name === 'Duel Starter').why, /^Ours lower: 3-week carries 11/);
  assert.equal(d.rows.find(x => x.name === 'Big Gap').why, null, 'a mismatched recompute is not explained');
});

test('residuals: every graded player-week stored with the usage line; the "what happened" line', async () => {
  const { ingestResiduals, happenedText } = await import('../server/services/proj-duel/explain.js');
  const { rows } = await import('../server/db/index.js');
  run(`UPDATE game_lines SET team_score = 13 WHERE season = 2026 AND week = 3 AND team = 'AAA'`);
  const n = ingestResiduals(S, W, { rows: [{ player_id: 8801, team: 'AAA', carries: 14, targets: 1, receptions: 1, snap_pct: 0.62, rz_share: 0.1, xfp: 11.2, tds: 0, team_implied: 24 }] });
  assert.equal(n, 4, 'every player with both numbers');
  const r = rows('SELECT * FROM proj_duel_residuals WHERE player_id = 8801')[0];
  assert.deepEqual([r.ours, r.espn, r.actual, +r.err_ours.toFixed(1), +r.err_espn.toFixed(1), r.team_points], [9.1, 14.2, 0, 9.1, 14.2, 13]);
  assert.equal(happenedText(r, { trail3_carries: 17, trail3_targets: 2 }), '14 carries vs 17 expected, 62% of snaps, 0 TDs, team scored 13 vs 24 implied.');
  assert.equal(ingestResiduals(S, W, { rows: [] }), 0, 'append-only: a week is stored once');
  const d = await projDuel(LG, { season: S, week: W, now: new Date('2026-09-25T00:00:00Z') });
  assert.match(d.rows.find(x => x.name === 'Duel Starter').happened, /^14 carries vs 17 expected/);
});

test('the fallback reason when nothing pushes toward the gap (a top player the model tops out on)', async () => {
  const { driversText, featureLabel } = await import('../server/services/proj-duel/explain.js');
  const contribs = [{ feature: 'lag1_snap_pct', contribution: 3.66, value: 0.83 }, { feature: 'prev_season_ppg', contribution: 2.93, value: 21.58 },
    { feature: 'std_ppr', contribution: 1.12, value: 28.45 }, { feature: 'week', contribution: 0.2, value: 3 }];
  assert.equal(driversText({ ours: 17.5, espn: 25.3, contribs, position: 'RB' }),
    'Ours lower even though 83% of snaps last game and last season 21.6 a game: the model tops out below ESPN for top players.');
  assert.equal(featureLabel('trail3_carries'), '3-week carries');
  assert.equal(featureLabel('opp_allowed_pos_trail', 'RB'), 'opponent vs RB lately');
});

test('the breakdown: every driver, usage expected vs actual, team implied vs scored, recent weeks', async () => {
  const { playerBreakdown } = await import('../server/services/proj-duel/index.js');
  const b = playerBreakdown({ season: S, week: W, playerId: 8801, now: new Date('2026-09-25T00:00:00Z') });
  assert.deepEqual([b.espn, b.ours, b.actual, b.closer], [14.2, 9.1, 0, 'ours']);
  assert.ok(b.drivers.length >= 4 && b.drivers[0].label === '3-week carries', 'every stored driver, biggest first');
  assert.deepEqual(b.usage.find(u => u.label === 'Carries'), { label: 'Carries', expected: 17, actual: 14, unit: '' });
  assert.deepEqual([b.team_implied, b.team_scored], [24, 13]);
  assert.deepEqual(b.history.map(h => h.week), [3], 'no earlier week with both numbers in this fixture');
  assert.equal(playerBreakdown({ season: S, week: W, playerId: 8805 }), null, 'no shadow forecast: no breakdown');
});
