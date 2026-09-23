/**
 * BLEND-01: the served weekly blend (server/services/weekly-blend.js).
 *
 * What these tests pin (docs/tdd/2026-09-22-weekly-blend-tournament.tdd.md):
 *   - each of the seven pre-registered candidates computes exactly its formula;
 *   - the fallbacks are decided once and labelled: a bye is 0 whatever ESPN says, a K/DEF keeps
 *     ours, a player ESPN has no number for keeps ours ('no_espn_value');
 *   - the late-news trigger fires on ESPN's 0 (while ours is not) or an Out/Doubtful status,
 *     and nothing else;
 *   - the served switch: off serves ours ('blend_off'), on serves the recorded winner;
 *   - ESPN's number is read from league_roster_snapshots for this league and identically
 *     scored leagues only, current period, rostered rows, one value per player (leagues that
 *     disagree give none), and an ESPN id of 0 is never a player.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-weekly-blend-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const blend = await import('../server/services/weekly-blend.js');
const {
  phaseFor, lateNewsTrigger, blendWeekPoints, servedWeekBlend, espnWeekProjections, espnValueFor,
  weekBlendContext, CANDIDATES, SERVED_BLEND
} = blend;

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const X = { ours: 10, espn: 16, position: 'WR', week: 6, reportStatus: null };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test('phaseFor puts each week in its pre-registered band', () => {
  assert.deepEqual([1, 2, 4, 5, 8, 9, 13, 14, 18].map(phaseFor),
    ['2-4', '2-4', '2-4', '5-8', '5-8', '9-13', '9-13', '14-18', '14-18']);
});

test('the late-news trigger: ESPN at 0 while ours is not, or Out/Doubtful; nothing else', () => {
  assert.equal(lateNewsTrigger({ ours: 5, espn: 0 }), true);
  assert.equal(lateNewsTrigger({ ours: 0, espn: 0 }), false);
  assert.equal(lateNewsTrigger({ ours: 5, espn: 3 }), false);
  assert.equal(lateNewsTrigger({ ours: 5, espn: 3, reportStatus: 'Out' }), true);
  assert.equal(lateNewsTrigger({ ours: 5, espn: 3, reportStatus: 'Doubtful' }), true);
  assert.equal(lateNewsTrigger({ ours: 5, espn: 3, reportStatus: 'Out (ESPN)' }), true);
  assert.equal(lateNewsTrigger({ ours: 5, espn: 3, reportStatus: 'Questionable' }), false);
  assert.equal(lateNewsTrigger({ ours: 5, espn: 3, reportStatus: 'outside' }), false);
  // No ESPN number, no switch: there is nothing to switch to.
  assert.equal(lateNewsTrigger({ ours: 5, espn: null, reportStatus: 'Out' }), false);
});

test('each candidate computes exactly its pre-registered formula', () => {
  const params = {
    fit_shrunk: { w: 0.25 },
    pos_phase: { pooled: 0.3, w: { WR: { '5-8': 0.4 } } },
    espn_proven: { b: { WR: { '5-8': 0.3 } } }
  };
  const v = c => blendWeekPoints(X, { candidate: c, params: params[c] ?? null });
  near(v('ours').ppg, 10);
  near(v('espn').ppg, 16);
  near(v('half').ppg, 13);
  near(v('fit_shrunk').ppg, 0.25 * 10 + 0.75 * 16);
  near(v('pos_phase').ppg, 0.4 * 10 + 0.6 * 16);
  near(v('espn_proven').ppg, 16 + 0.3 * (10 - 16));
  near(v('news').ppg, 10);
  assert.equal(v('half').basis, 'blend');
  near(v('half').weight_ours, 0.5);
  near(v('fit_shrunk').weight_ours, 0.25);
  near(v('espn').weight_ours, 0);
  // A cell with no fitted value: pos_phase falls back to its pooled weight, espn_proven to ESPN.
  const rb = { ...X, position: 'RB' };
  near(blendWeekPoints(rb, { candidate: 'pos_phase', params: params.pos_phase }).ppg, 0.3 * 10 + 0.7 * 16);
  near(blendWeekPoints(rb, { candidate: 'espn_proven', params: params.espn_proven }).ppg, 16);
  // The phase is read from the week: week 9 is a different cell.
  near(blendWeekPoints({ ...X, week: 9 }, { candidate: 'pos_phase', params: params.pos_phase }).ppg, 0.3 * 10 + 0.7 * 16);
  assert.deepEqual(Object.values(CANDIDATES).map(c => c.id), ['C1', 'C2', 'C3', 'C7', 'C4', 'C5', 'C6']);
  assert.deepEqual(Object.fromEntries(Object.entries(CANDIDATES).map(([k, c]) => [k, c.ladder])),
    { ours: 0, espn: 1, half: 1, news: 2, fit_shrunk: 3, pos_phase: 4, espn_proven: 5 });
});

test('the fallbacks are decided once and labelled', () => {
  const half = { candidate: 'half' };
  assert.deepEqual(blendWeekPoints({ ...X, espn: null }, half), { ppg: 10, basis: 'no_espn_value', weight_ours: 1, espn: null });
  assert.deepEqual(blendWeekPoints({ ...X, espn: Number.NaN }, half), { ppg: 10, basis: 'no_espn_value', weight_ours: 1, espn: null });
  assert.deepEqual(blendWeekPoints({ ...X, position: 'K' }, half), { ppg: 10, basis: 'ours_position_not_graded', weight_ours: 1, espn: 16 });
  assert.deepEqual(blendWeekPoints({ ...X, position: 'DEF' }, half).basis, 'ours_position_not_graded');
  // No game this week (a bye, or no team) is 0 whatever ESPN says, labelled no_game.
  assert.deepEqual(blendWeekPoints({ ...X, bye: true }, half), { ppg: 0, basis: 'no_game', weight_ours: null, espn: 16 });
  assert.deepEqual(blendWeekPoints(X, { candidate: 'ours' }), { ppg: 10, basis: 'ours', weight_ours: 1, espn: 16 });
  assert.throws(() => blendWeekPoints(X, { candidate: 'nope' }), /unknown blend candidate/);
  assert.throws(() => blendWeekPoints({ ...X, ours: Number.NaN }, half), /finite number of ours/);
});

test('late news: the news candidate and the layer take ESPN only when the trigger fires', () => {
  const out = { ...X, espn: 0 };
  assert.deepEqual(blendWeekPoints(out, { candidate: 'news' }), { ppg: 0, basis: 'espn_late_news', weight_ours: 0, espn: 0 });
  assert.deepEqual(blendWeekPoints(X, { candidate: 'news' }), { ppg: 10, basis: 'ours', weight_ours: 1, espn: 16 });
  const doubtful = { ...X, reportStatus: 'Doubtful' };
  assert.equal(blendWeekPoints(doubtful, { candidate: 'half', newsLayer: true }).ppg, 16);
  assert.equal(blendWeekPoints(doubtful, { candidate: 'half', newsLayer: true }).basis, 'espn_late_news');
  assert.equal(blendWeekPoints(doubtful, { candidate: 'half' }).ppg, 13);
  assert.equal(blendWeekPoints(X, { candidate: 'half', newsLayer: true }).ppg, 13);
});

test('the served switch: off serves ours, labelled; on serves the recorded candidate', () => {
  const off = { on: false, candidate: 'half', params: null, news_layer: false, verdict: 'unconfirmed forward' };
  assert.deepEqual(servedWeekBlend(X, off), { ppg: 10, basis: 'blend_off', weight_ours: 1, espn: 16 });
  assert.deepEqual(servedWeekBlend({ ...X, bye: true }, off), { ppg: 0, basis: 'no_game', weight_ours: null, espn: 16 });
  const on = { on: true, candidate: 'half', params: null, news_layer: false, verdict: 'shipped' };
  assert.equal(servedWeekBlend(X, on).ppg, 13);
  assert.equal(servedWeekBlend({ ...X, espn: null }, on).basis, 'no_espn_value');
  const layered = { ...on, news_layer: true };
  assert.equal(servedWeekBlend({ ...X, espn: 0 }, layered).basis, 'espn_late_news');
  assert.match(weekBlendContext(null, off).label, /our projection alone/);
  assert.match(weekBlendContext(null, off).label, /unconfirmed forward/);
  assert.match(weekBlendContext(null, on).label, /blend our projection with ESPN's weekly projection/);
  assert.equal(weekBlendContext(null, on).espn.state, 'empty');
  // SERVED_BLEND is one of the candidates and carries its evidence path.
  assert.ok(Object.hasOwn(CANDIDATES, SERVED_BLEND.candidate));
  assert.match(SERVED_BLEND.evidence, /weekly-blend-tournament-output\.json$/);
});

test('ESPN\'s number: this league and identically scored leagues, current period, rostered, one value', () => {
  // Leagues 1 and 2 score PPR (no payload: scoringFor's PPR fallback); league 3 scores standard.
  for (const [id, ppr] of [[1, 1], [2, 1], [3, 0]]) {
    run(`INSERT INTO leagues (id, platform, league_id, season, name, team_count, ppr) VALUES (?, 'espn', ?, 2026, ?, 10, ?)`,
      id, `L${id}`, `League ${id}`, ppr);
  }
  const league = { id: 1, platform: 'espn', ppr: 1, payload: null };
  // Empty first: no rows for the period is 'empty', not a zero.
  const empty = espnWeekProjections({ league, season: 2026, week: 3 });
  assert.equal(empty.state, 'empty');
  assert.equal(empty.values.size, 0);
  const snap = (leagueId, team, espnId, pts, { week = 3, season = 2026, onRoster = 1, at = '2026-09-22T20:50:00Z' } = {}) =>
    run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id, player_id,
           lineup_slot_id, is_starter, projected_points, on_roster, source, first_seen_at, changed_at)
         VALUES (?, ?, ?, ?, ?, NULL, 0, 1, ?, ?, 'live', ?, ?)`, leagueId, season, week, team, espnId, pts, onRoster, at, at);
  snap(1, 1, 100, 12.5);                                    // this league
  snap(2, 4, 100, 12.505);                                  // identically scored, agrees to 0.01
  snap(2, 4, 200, 9.0, { at: '2026-09-22T22:55:00Z' });     // only in league 2: still this league's scoring
  snap(1, 2, 300, 7.0); snap(2, 5, 300, 8.0);               // the two leagues disagree: no value
  snap(3, 1, 400, 11.0);                                    // standard scoring: never read for a PPR league
  snap(1, 3, 500, 6.0, { onRoster: 0 });                    // dropped this week: not his current number
  snap(1, 1, 600, 5.0, { week: 2 });                        // another week
  snap(1, 1, 700, 5.0, { season: 2025 });                   // another season
  const espn = espnWeekProjections({ league, season: 2026, week: 3 });
  assert.equal(espn.state, 'present');
  assert.deepEqual([...espn.values.entries()].sort(), [['100', 12.5], ['200', 9]]);
  assert.equal(espn.conflicting, 1);
  assert.deepEqual(espn.leagues, [1, 2]);
  assert.equal(espn.captured_at, '2026-09-22T22:55:00Z');
  assert.equal(espnValueFor(espn, 100), 12.5);
  assert.equal(espnValueFor(espn, '200'), 9);
  assert.equal(espnValueFor(espn, 300), null);
  assert.equal(espnValueFor(espn, 400), null);
  assert.equal(espnValueFor(espn, 0), null);
  assert.equal(espnValueFor(espn, null), null);
  // The standard-scoring league reads its own row only.
  const std = espnWeekProjections({ league: { id: 3, platform: 'espn', ppr: 0, payload: null }, season: 2026, week: 3 });
  assert.deepEqual([...std.values.entries()], [['400', 11]]);
  const ctx = weekBlendContext(espn, { on: false, candidate: 'ours', verdict: 'declined', evidence: 'x' });
  assert.deepEqual(ctx.espn, { state: 'present', rows: 5, players: 2, conflicting: 1, leagues: 2, captured_at: '2026-09-22T22:55:00Z' });
});

test('SERVED_BLEND is the committed tournament decision, not a hand-set switch', () => {
  const out = JSON.parse(fs.readFileSync(new URL('../docs/evidence/2026-09-22/weekly-blend-tournament-output.json', import.meta.url), 'utf8'));
  const d = out.decision;
  assert.equal(SERVED_BLEND.on, d.on);
  assert.equal(SERVED_BLEND.candidate, d.winner);
  assert.equal(SERVED_BLEND.news_layer, d.news_layer);
  assert.equal(SERVED_BLEND.verdict, d.verdict);
  assert.deepEqual(SERVED_BLEND.params, d.served_params);
  // The pre-registered rule was applied to the grade the evidence records.
  assert.equal(out.prereg.path, 'docs/evidence/2026-09-22/weekly-blend-tournament-preregistration.md');
  assert.equal(out.selection.winner, d.winner);
});
