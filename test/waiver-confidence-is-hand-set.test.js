/**
 * The waiver board's acceptance number is hand-set, and it was being published
 * into a column that elsewhere holds a fitted one (2026-09-20).
 *
 * `waiverUpgrades` gave every upgrade `accept_probability: 0.9`, a literal, and
 * handed it to the Decision Inbox as that item's `confidence`. The trade
 * publisher writes `headline.p_right` into the same column
 * (trade-engine.js:2874) — a fitted estimate of how often that model is right,
 * scored against outcomes. Two unlike quantities under one heading, with nothing
 * on the record to separate them.
 *
 * They are not even the same KIND of number. `p_right` answers "is this
 * recommendation correct". 0.9 answers "will somebody else claim him first". A
 * reader ranking an inbox on that column is comparing a model's track record
 * against a guess about other managers.
 *
 * Two changes, neither of which moves a ranking:
 *
 *  1. The constant is named (`CLAIM_FRICTION`) and its basis travels on the wire
 *     beside the number, so a surface that shows a waiver and a trade together
 *     can say which of the two was fitted. Two shapes, following this file's own
 *     rule at the `vegas` field that a note on every row trains a reader to skip
 *     them: a one-token `accept_probability_basis` per row to branch on, and the
 *     sentence stated once on the payload as `acceptance`, beside `not_modelled` and
 *     `scored_on`. Named for the thing rather than the row's field, so no one
 *     name carries two shapes in one response.
 *  2. The inbox item publishes no confidence at all rather than borrowing one.
 *     An absent confidence is a smaller lie than a borrowed one, and this column
 *     has no reader today, so nothing regresses by its absence.
 *
 * The friction factor itself is unchanged and still applies to expected_value.
 * It is a flat multiplier on every row, so it reorders nothing within the list —
 * which is precisely why it was easy to leave unexamined.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-waiver-conf-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { seedIfEmpty } = await import('../server/db/seed/index.js');
seedIfEmpty();
// Every seeded team needs a week-1 game or current_week_ppg is 0 for everyone,
// and matchupModel() caches the slate per process, so this lands before the
// first assetUniverse() call. Same note as test/waiver-kicker-defense.test.js.
run(`INSERT OR IGNORE INTO schedule_games (season, team_id, week, opponent_abbr, home)
     SELECT 2026, id, 1, abbr, 1 FROM nfl_teams`);
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');

const { waiverUpgrades } = await import('../server/services/waiver-brain.js');
const { publishRecommendation } = await import('../server/routes/decision-inbox.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
const POSITION_ID = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DEF: 16 };
const project = (player, points) => run(
  `INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games) VALUES (?,2026,'projected',?,17)`,
  player.id, points);

// A receiver good enough to clear the publish threshold (expected_value >= 0.75),
// over a roster weak enough that he plainly starts. The publish path is the half
// of this finding that leaves the process, so the fixture has to reach it.
const freeWideout = row(
  `SELECT id, name FROM players WHERE position = 'WR' AND fantasy_relevant = 1 ORDER BY id LIMIT 1`);
project(freeWideout, 340);

const mine = ['QB', 'RB', 'RB', 'WR', 'TE'].map((position, i) => {
  const p = rows(`SELECT id, name FROM players WHERE position = ? AND fantasy_relevant = 1
                  AND id != ? ORDER BY id LIMIT 5`, position, freeWideout.id)[i % 5];
  project(p, 60);
  return { ...p, position };
});
const entry = p => ({ playerPoolEntry: { player: {
  id: p.id, fullName: p.name, defaultPositionId: POSITION_ID[p.position] } } });

run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id,
     roster_positions, connection_status)
     VALUES (701, 'espn', 'conf-701', 2026, 'Waiver confidence', ?, 2, '1', ?, 'connected')`,
  JSON.stringify({ teams: [{ id: 1, name: 'My Team', roster: { entries: mine.map(entry) } }] }),
  JSON.stringify(SLOTS));

const result = waiverUpgrades(701, { myTeamId: '1' });
const top = result.upgrades[0];

test('the fixture produced a real upgrade, so everything below is about a live row', () => {
  // Without this the whole file is assertions over `undefined`, which pass by
  // saying nothing. The publish threshold is the same one waiverUpgrades uses.
  assert.ok(top, 'a free agent must have ranked');
  assert.ok(top.ppg_gain > 0, 'and he must actually gain points');
  assert.ok(top.expected_value >= 0.75, 'and clear the inbox publish threshold');
});

test('the acceptance number says on the wire that it is hand-set', () => {
  assert.equal(top.accept_probability_basis, 'hand-set');
});

test('the basis is on every row, not just the one that happened to be first', () => {
  // A basis on the headline and nothing on the rest is the shape that makes a
  // page look labelled while most of it is not.
  assert.ok(result.upgrades.length > 0);
  for (const u of result.upgrades) {
    assert.equal(u.accept_probability, 0.9, `${u.player.name} carries the constant`);
    assert.equal(u.accept_probability_basis, 'hand-set', `${u.player.name} carries the basis`);
  }
});

test('the sentence that explains it is on the payload, not repeated per row', () => {
  // This file's own rule, stated at the `vegas` field: a note on every row trains
  // a reader to skip them. So the row carries a token to branch on and the payload
  // carries the sentence once, beside not_modelled and scored_on, which are the
  // other two places this payload explains itself.
  const stated = result.acceptance;
  assert.ok(stated, 'the payload states it');
  // Named for the thing, not for the row's field: one name must never carry two
  // shapes in one response, or a consumer reading `.why` off the row gets undefined.
  assert.equal(typeof result.upgrades[0].accept_probability_basis, 'string');
  assert.equal(typeof stated, 'object');
  assert.equal(stated.basis, 'hand-set');
  assert.equal(stated.value, 0.9);
  assert.match(stated.why, /not fitted/);
  assert.match(stated.why, /changes no ordering/);
  // And the explanation is genuinely not on the rows, or the rule is only stated.
  for (const u of result.upgrades) {
    assert.equal(u.accept_probability_basis.length < 20, true,
      `${u.player.name}: the row carries a token, not the sentence`);
  }
});

test('expected_value is the gain times that same constant, not a second copy of it', () => {
  // Two literals for one concept is how they drift. Computed from the served
  // fields, so a change to either one that is not matched by the other fails here.
  for (const u of result.upgrades) {
    assert.equal(u.expected_value, +(u.ppg_gain * u.accept_probability).toFixed(2),
      `${u.player.name}: expected_value must be ppg_gain x the number beside it`);
  }
});

test('the inbox item carries no confidence, rather than borrowing the friction factor', () => {
  // The defect itself. Read from the stored row, not from the call, because the
  // column is what a reader eventually sees.
  const rec = row(`SELECT confidence, expected_value, source_model FROM decision_recommendations
                   WHERE dedup_key = 'waiver:701:1'`);
  assert.ok(rec, 'the recommendation must have been published, or this checks nothing');
  assert.equal(rec.source_model, 'waiver-brain');
  assert.equal(rec.confidence, null, 'a claim-friction factor is not a confidence');
  assert.ok(rec.expected_value > 0, 'and the value it does have is still published');
});

test('the column itself still accepts a fitted confidence, so this is not a schema retreat', () => {
  // The trade publisher writes p_right here and must keep working. If the fix had
  // been "drop the field", this test is the one that would have caught it.
  publishRecommendation({
    dedupKey: 'trade-shaped:701', leagueId: 701, sport: 'NFL', type: 'trade',
    subjectIds: [freeWideout.id], title: 'A fitted confidence still stores',
    rationale: 'Stands in for the trade publisher, which writes headline.p_right here.',
    expectedValue: 4.2, confidence: 0.63, urgency: 'medium',
    sourceModel: 'trade-engine', sourceVersion: 'v1', link: '/trades'
  });
  const rec = row(`SELECT confidence FROM decision_recommendations WHERE dedup_key = 'trade-shaped:701'`);
  assert.equal(rec.confidence, 0.63);
});
