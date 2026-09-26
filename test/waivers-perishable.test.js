/**
 * Plan item 13, WAIVERS PERISHABLE (research R10, ONE-PLAN 4d spot-check row 9).
 *
 * League 4 resets the waiver order every week (reverse standings), so priority not
 * spent this week is gone: it is perishable. Three rules follow, pre-registered in
 * docs/tdd/2026-09-25-waivers-perishable.tdd.md:
 *
 *   (a) in a weekly-reset league no served waiver text may advise saving priority;
 *       the check throws rather than serve it (a hard rule, always on);
 *   (b) handcuff advice needs a workload test: a backup counts as a handcuff only
 *       when he has already carried a real workload in games his starter missed;
 *   (c) the D/ST streaming board reads points allowed: each defense carries the
 *       market's expected points allowed and the league's points for that tier
 *       (shadow fields, behind GRIDIRON_WAIVERS_PERISHABLE; the ranking and the
 *       suggestion do not move).
 *
 * Every team, league and player here is a fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-perishable-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';
process.env.NFL_WEEK = '3';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const P = await import('../server/services/waiver-perishable.js');
const { claimPriority, CLAIM_STRATEGY } = await import('../server/services/waiver-wire.js');
const { streamingBoard } = await import('../server/services/streaming-board.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------------ (a) priority */

test('(a) save-priority wording is detected in its common phrasings', () => {
  for (const s of [
    'Save your waiver priority for a bigger fish.',
    'Hold priority until a starter gets hurt.',
    'Keep your #1 priority for later.',
    "Don't burn your waiver priority on him.",
    'Conserve priority this week.',
    'Better to wait and protect your waiver position.',
  ]) assert.equal(P.advisesSavingPriority(s), true, s);
  for (const s of [
    CLAIM_STRATEGY.reset,
    CLAIM_STRATEGY.budget,
    'Claim him before the reset: priority you do not use this week is gone.',
    'You are 3rd in line this week.',
  ]) assert.equal(P.advisesSavingPriority(s), false, s);
});

test('(a) a weekly-reset league refuses save-priority text; a rolling league may say it', () => {
  assert.throws(() => P.assertPerishable('Save your priority.', { resets_weekly: true }), /perishable/i);
  assert.doesNotThrow(() => P.assertPerishable(CLAIM_STRATEGY.reset, { resets_weekly: true }));
  assert.doesNotThrow(() => P.assertPerishable('Save your priority.', { resets_weekly: false }));
  // Every canned strategy line passes its own league type.
  assert.doesNotThrow(() => P.assertPerishable(CLAIM_STRATEGY.reset, { resets_weekly: true }));
  assert.doesNotThrow(() => P.assertPerishable(CLAIM_STRATEGY.budget, { resets_weekly: true }));
});

const acq = reset => ({ acquisitionType: 'WAIVERS_TRADITIONAL', isUsingAcquisitionBudget: false,
  waiverOrderReset: reset, waiverProcessDays: ['WEDNESDAY'], waiverProcessHour: 11, waiverHours: 24 });
const lgFor = reset => {
  const payload = { settings: { acquisitionSettings: acq(reset) },
    teams: [{ id: 1, waiverRank: 3 }, { id: 2, waiverRank: 1 }, { id: 3, waiverRank: 2 }] };
  return { lg: { id: 1, platform: 'espn', season: 2026, payload_season: 2026, fetched_at: '2026-09-23 17:15:31',
    payload: JSON.stringify(payload) }, payload };
};

test('(a) flag off: claim_priority is exactly as before (no perishable block)', () => {
  delete process.env[P.PERISHABLE_ENV];
  const { lg, payload } = lgFor(true);
  const cp = claimPriority(lg, payload, '1');
  assert.equal('perishable' in cp, false);
});

test('(a) flag on: a weekly-reset league says priority is perishable and to claim before the reset', () => {
  process.env[P.PERISHABLE_ENV] = '1';
  try {
    const { lg, payload } = lgFor(true);
    const cp = claimPriority(lg, payload, '1').perishable;
    assert.equal(cp.perishable, true);
    assert.equal(cp.advise_save_priority, false);
    assert.match(cp.advice, /before the reset/i);
    assert.equal(P.advisesSavingPriority(cp.advice), false);
    const rolling = lgFor(false);
    const rp = claimPriority(rolling.lg, rolling.payload, '1').perishable;
    assert.equal(rp.perishable, false);
    assert.equal(rp.advice, null, 'nothing new is said for a rolling-order league');
  } finally { delete process.env[P.PERISHABLE_ENV]; }
});

/* ---------------------------------------------------------- (b) handcuffs */

const path_ = (o = {}) => ({ starter: 'Starter RB', starter_id: 1, starter_miss_rate: 0.2, opportunity_gain: 9,
  multiplier: 2.1, expected_gain: 1.8, expected_points: 1.2, opportunity_without: 15, games_observed: 3, ...o });

test('(b) a backup who carried a real workload in games the starter missed passes the workload test', () => {
  const t = P.handcuffWorkload({ position: 'RB', paths: [path_()] });
  assert.equal(t.passes, true, t.reason);
  assert.equal(t.games_observed, 3);
  assert.equal(t.opportunity_without, 15);
});

test('(b) too few games, or too little work when the starter sat, fails the test', () => {
  const thin = P.handcuffWorkload({ position: 'RB', paths: [path_({ games_observed: 1 })] });
  assert.equal(thin.passes, false);
  assert.match(thin.reason, /game/i);
  const light = P.handcuffWorkload({ position: 'RB', paths: [path_({ opportunity_without: 7 })] });
  assert.equal(light.passes, false);
  assert.match(light.reason, /workload|opportunit/i);
  const none = P.handcuffWorkload({ position: 'RB', paths: [] });
  assert.equal(none.passes, false);
});

test('(b) the fragility reading no longer advises a handcuff without the workload test', async () => {
  const src = fs.readFileSync(new URL('../server/services/roster-risk.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /a handcuff off the wire is cheaper/, 'the unconditional handcuff advice is gone');
  assert.match(src, /HANDCUFF_READING/, 'roster-risk reads the one handcuff wording from waiver-perishable.js');
  assert.match(P.HANDCUFF_READING, /workload/i);
});

/* ------------------------------------------------------ (c) points allowed */

test('(c) paTier maps expected points allowed to the ESPN tier and the league\'s points for it', () => {
  const pts = { 89: 5, 90: 4, 91: 3, 92: 1, 121: 0, 122: -1, 123: -3, 124: -5, 125: -7 };
  assert.deepEqual(P.paTier(0, pts), { tier: '0', stat_id: 89, points: 5 });
  assert.deepEqual(P.paTier(16.4, pts), { tier: '14-17', stat_id: 92, points: 1 });
  assert.deepEqual(P.paTier(17.5, pts), { tier: '18-21', stat_id: 121, points: 0 });
  assert.deepEqual(P.paTier(24.75, pts), { tier: '22-27', stat_id: 122, points: -1 });
  assert.deepEqual(P.paTier(50, pts), { tier: '46+', stat_id: 125, points: -7 });
  assert.equal(P.paTier(null, pts), null);
  assert.equal(P.paTier(20, {}).points, null, 'a league that does not pay the tier says null, not 0');
});

const FUTURE = '2099-09-27';
function insertLine(team, opponent, spread, total) {
  run(`INSERT INTO game_lines (season, week, team, opponent, home, spread, total, implied_points, source, gameday, gametime)
       VALUES (2026, 3, ?, ?, 1, ?, ?, ?, 'espn', ?, '13:00')`, team, opponent, spread, total, total / 2 - spread / 2, FUTURE);
}
for (const [t, o, s, tot] of [['SEA', 'ARI', -7, 41], ['HOU', 'IND', -3, 42.5]]) { insertLine(t, o, s, tot); insertLine(o, t, -s, tot); }
const PRO = { SEA: 26, HOU: 34 };
const dst = team => ({ lineupSlotId: 16,
  playerPoolEntry: { player: { id: -16000 - PRO[team], fullName: `${team} D/ST`, defaultPositionId: 16, proTeamId: PRO[team] } } });
const PA_ITEMS = [[89, 5], [90, 4], [91, 3], [92, 1], [121, 0], [122, -1], [123, -3], [124, -5], [125, -7]]
  .map(([statId, points]) => ({ statId, points }));
// Enough offensive items for scoringFor to read the league's own settings.
const OFF_ITEMS = [[3, 0.04], [4, 4], [24, 0.1], [25, 6], [42, 0.1], [43, 6], [53, 1]].map(([statId, points]) => ({ statId, points }));
function dstLeague() {
  const payload = {
    settings: { rosterSettings: { lineupSlotCounts: { 16: 1, 20: 1 }, positionLimits: { 16: 2 } },
      scoringSettings: { scoringItems: [...OFF_ITEMS, ...PA_ITEMS] } },
    teams: [{ id: 1, roster: { entries: [dst('HOU')] } }, { id: 2, roster: { entries: [] } }]
  };
  return { id: 9, platform: 'espn', league_id: '1', season: 2026, team_count: 2, my_team_id: '1', ppr: 1,
    roster_positions: JSON.stringify(['DEF']), payload: JSON.stringify(payload) };
}
const NOW = new Date('2026-09-24T12:00:00Z');

test('(c) flag off: the streaming board carries no points-allowed fields', () => {
  delete process.env[P.PERISHABLE_ENV];
  const b = streamingBoard(dstLeague(), { season: 2026, week: 3, now: NOW, enabled: true });
  assert.equal(b.candidates[0].team, 'SEA');
  assert.equal('pa_points' in b.candidates[0], false);
  assert.equal('points_allowed' in b, false);
});

test('(c) flag on: each defense reads expected points allowed and the league tier, ranking and suggestion unchanged', () => {
  const off = streamingBoard(dstLeague(), { season: 2026, week: 3, now: NOW, enabled: true });
  process.env[P.PERISHABLE_ENV] = '1';
  try {
    const b = streamingBoard(dstLeague(), { season: 2026, week: 3, now: NOW, enabled: true });
    assert.deepEqual(b.candidates.map(c => c.team), off.candidates.map(c => c.team));
    assert.deepEqual(b.suggestion, off.suggestion);
    const sea = b.candidates.find(c => c.team === 'SEA');
    assert.equal(sea.expected_points_allowed, 17);
    assert.equal(sea.pa_tier, '14-17');
    assert.equal(sea.pa_points, 1);
    const hou = b.my_defenses.find(d => d.team === 'HOU');
    assert.equal(hou.expected_points_allowed, 19.75);
    assert.equal(hou.pa_points, 0);
    assert.equal(b.points_allowed.shadow, true);
    assert.equal(b.points_allowed.scoring_source, 'league');
  } finally { delete process.env[P.PERISHABLE_ENV]; }
});
