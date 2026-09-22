/**
 * A trade's season-long gain counted weeks that had already been played
 * (2026-09-20).
 *
 * `evaluate` returned `season_delta = ppg_delta * GAMES`, with `GAMES = 17`
 * (trade-engine.js:120), and both surfaces render it as "over the season"
 * (`client/src/components/TradeCard.tsx:109`, `server/routes/trades.js:1055`).
 * 17 is the length of an NFL regular season, not the length of what is left of
 * one. In week 2 that prices a week already played and, worse, a week this league
 * will never play: a fantasy season ends at its last playoff week, which
 * `leagueSchedule` reads from the league's own settings.
 *
 * The same file already had the right idiom one screen up — the asset's own
 * `proj` is `weeklyPpg * Math.max(1, 18 - target.week)` — so this was one
 * expression disagreeing with its neighbour rather than a missing concept.
 *
 * The error is proportional and always in the same direction: at week 2 of a
 * league ending in week 17, 17 weeks are charged for 16, and by week 10 it is 17
 * charged for 8 — a trade's headline season number is then more than double what
 * the roster can still collect.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-season-delta-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { evaluate, weeksLeftFor, lineupSlots } = await import('../server/services/trade-engine.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Two players who differ by exactly 3 points a week, so ppg_delta is 3 and the
// season figure is 3 x whatever horizon the code chose. Nothing here needs a
// league sync, a projection engine or a market.
const player = (id, name, position, ppg) => ({
  id, name, position, adj_ppg: ppg, ros_ppg: ppg, current_week_ppg: ppg,
  playoff_ppg: ppg, value: 100, available: true
});
const SLOTS = ['QB', 'RB', 'WR', 'TE', 'FLEX'];
const me = { roster_id: '1', owner: 'Me', players: [player(1, 'Mine', 'WR', 10)] };
const them = { roster_id: '2', owner: 'Them', players: [player(2, 'Theirs', 'WR', 13)] };
const deal = ctx => evaluate(
  { team: me, gives: [me.players[0]] }, { team: them, gives: [them.players[0]] }, SLOTS, ctx).me;

// An ESPN league whose settings really are synced, so leagueSchedule reads them
// rather than falling back: 14 regular-season weeks, 4 playoff teams (2 rounds),
// one week per round -> last week is 16.
const synced = { payload: JSON.stringify({ settings: { scheduleSettings: {
  matchupPeriodCount: 14, playoffMatchupPeriodLength: 1, playoffTeamCount: 4, matchupPeriodLength: 1 } } }) };
const unsynced = { payload: null };

test('the fixture really does produce a three-point weekly gain', () => {
  // The premise. Every figure below is that delta times a horizon, so if the
  // lineup solve produced no gain the horizon assertions would be 0 === 0.
  assert.equal(deal({ weeksLeft: 10 }).ppg_delta, 3);
});

test('the season figure is the weekly gain over the weeks that are left', () => {
  assert.equal(deal({ weeksLeft: 10 }).season_delta, 30);
  assert.equal(deal({ weeksLeft: 4 }).season_delta, 12);
});

test('and it says how many weeks those are, so no surface has to guess', () => {
  assert.equal(deal({ weeksLeft: 10 }).season_delta_weeks, 10);
});

test('with no horizon given it reports nothing rather than a plausible number', () => {
  // The defect being fixed was a plausible wrong number, so the fallback must not
  // be another one. A caller that forgets is visibly empty, not quietly wrong.
  assert.equal(deal({}).season_delta, null);
  assert.equal(deal({}).season_delta_weeks, null);
});

test('a league that ends in week 16 has 15 weeks left in week 2, not 17', () => {
  assert.equal(weeksLeftFor(synced, 2), 15);
  assert.equal(weeksLeftFor(synced, 10), 7);
  assert.equal(weeksLeftFor(synced, 16), 1);
});

test('the last week is never negative, and never zero', () => {
  // Past the end of a league's season the honest answer is one week, not a
  // negative multiplier that would flip the sign of every trade's headline.
  assert.equal(weeksLeftFor(synced, 18), 1);
  assert.equal(weeksLeftFor(synced, 99), 1);
});

test('an unsynced league falls back to the app default rather than throwing', () => {
  const fallback = weeksLeftFor(unsynced, 2);
  assert.ok(Number.isFinite(fallback) && fallback > 1, 'a default horizon is still a horizon');
  assert.ok(fallback < 17, 'but it is still fewer weeks than a whole NFL season in week 2');
});
