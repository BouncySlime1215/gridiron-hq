/**
 * The gate on a playoff percentage nobody had ever graded (2026-09-20).
 *
 * `docs/tdd/playoff-odds-calibration.tdd.md` measured this app's own
 * simulate-and-count procedure against 184,959 real team-weeks and found that
 * before four weeks of results are in, its Brier score is WORSE than telling every
 * team its league's base rate: 0.2855 and 0.2439 at weeks 2 and 3 against 0.2410.
 * It is also overconfident at both ends at every week — a team it gives no chance
 * qualifies 12% of the time.
 *
 * So the payload says whether its own odds are worth publishing yet. The server
 * does not blank the number; it flags it, and the client renders the state.
 *
 * THE RULE WORTH TESTING is not "four". It is that the threshold is the
 * MEASUREMENT: `MIN_PUBLISHABLE_WEEKS` is derived from the calibration table as the
 * first week whose measured Brier beats the base rate. A hardcoded 4 would be a
 * number someone chose, and the next person to look would have no way to tell
 * whether it still followed from anything. Edit the table and the threshold moves;
 * that is asserted below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-odds-gate-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { oddsGate, simulateSeason, PLAYOFF_ODDS_CALIBRATION, MIN_PUBLISHABLE_WEEKS }
  = await import('../server/services/season-sim.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('the threshold is the measurement, not a chosen number', () => {
  const weeks = Object.keys(PLAYOFF_ODDS_CALIBRATION.by_week).map(Number).sort((a, b) => a - b);
  const beats = weeks.filter(w => {
    const row = PLAYOFF_ODDS_CALIBRATION.by_week[w];
    return row.brier < row.base_rate;
  });
  assert.equal(MIN_PUBLISHABLE_WEEKS, Math.min(...beats),
    'the gate opens at the first graded week whose Brier beats the base rate');
  assert.equal(MIN_PUBLISHABLE_WEEKS, 4, 'which, on the shipped table, is week 4');
});

test('the calibration table says what the gate is for', () => {
  // If someone edits these numbers so the gate looks unnecessary, this fails rather
  // than the gate silently opening a week earlier.
  const w = PLAYOFF_ODDS_CALIBRATION.by_week;
  assert.ok(w[2].brier > w[2].base_rate, 'week 2 loses to the base rate');
  assert.ok(w[3].brier > w[3].base_rate, 'week 3 loses to the base rate');
  assert.ok(w[4].brier < w[4].base_rate, 'week 4 beats it');
  assert.ok(w[8].brier < w[8].base_rate, 'and so does week 8');
  assert.equal(PLAYOFF_ODDS_CALIBRATION.graded_team_weeks, 184959);
  // The overconfidence facts, which are the reason a published number still needs a
  // caveat and not only a gate.
  assert.ok(PLAYOFF_ODDS_CALIBRATION.extremes.no_chance_qualify_rate > 0.1);
  assert.ok(PLAYOFF_ODDS_CALIBRATION.extremes.certain_miss_rate > 0.1);
  assert.match(PLAYOFF_ODDS_CALIBRATION.not_graded, /from week 1|not graded/i,
    'the payload must admit which configuration was never graded');
});

test('weeks_played is what the odds stand on, not the week being simulated', () => {
  // from_week is the first UNPLAYED week, so four weeks are in the books at from_week 5.
  assert.equal(oddsGate({ fromWeek: 1 }).weeks_played, 0);
  assert.equal(oddsGate({ fromWeek: 5 }).weeks_played, 4);
  assert.equal(oddsGate({}).weeks_played, 0, 'a missing from_week is week one, nothing played');
});

test('the gate is shut below the threshold and open at it', () => {
  for (const fromWeek of [1, 2, 3, 4]) {
    assert.equal(oddsGate({ fromWeek }).published, false, `from_week ${fromWeek}`);
  }
  for (const fromWeek of [5, 6, 12]) {
    assert.equal(oddsGate({ fromWeek }).published, true, `from_week ${fromWeek}`);
  }
  assert.equal(oddsGate({ fromWeek: 5 }).reason, null, 'nothing to explain once it is published');
  assert.equal(oddsGate({ fromWeek: 5 }).min_week, MIN_PUBLISHABLE_WEEKS);
});

test('the reason names the measurement, and names it in plain words', () => {
  const r = oddsGate({ fromWeek: 3 }).reason;   // two weeks played
  assert.match(r, /base rate/i, 'a reader is told what it loses to, not just that it is early');
  assert.match(r, /184,?959/, 'and on how much evidence');
  assert.ok(!/brier/i.test(r) || /score/i.test(r),
    'jargon is either avoided or explained; a page is not a paper');
});

test('no results at all is its own state, because it is a different claim', () => {
  // League Hub sends no from_week today, so this is the live case: the odds are not
  // early, they are standing on nothing. "Too early to say" would undersell it.
  const zero = oddsGate({ fromWeek: 1 });
  assert.equal(zero.weeks_played, 0);
  assert.equal(zero.published, false);
  assert.match(zero.reason, /no results|nothing/i);
  assert.notEqual(zero.reason, oddsGate({ fromWeek: 3 }).reason,
    'the two states must not share one sentence');
});

test('the numbers are still in the payload: the server flags, it does not blank', () => {
  const gate = oddsGate({ fromWeek: 2 });
  assert.equal(gate.published, false);
  assert.ok(gate.calibration, 'the evidence travels with the flag');
  assert.equal(gate.calibration.graded_team_weeks, PLAYOFF_ODDS_CALIBRATION.graded_team_weeks);
  assert.ok(gate.calibration.source.includes('playoff-odds-calibration'),
    'a reader can find how this was measured');
});

test('a payload with no odds in it carries no gate', () => {
  // The error shape has no teams and no percentages, so there is nothing to gate, and
  // an odds_gate there would invite a consumer to read a flag about numbers that do
  // not exist.
  const lg = { id: 1, league_id: '1', season: 2026, league_type: 'redraft',
    payload: JSON.stringify({ teams: [], schedule: [], settings: {} }) };
  const out = simulateSeason(lg, { runs: 1 });
  assert.ok(out.error, `expected the no-fixtures shape, got ${JSON.stringify(out).slice(0, 120)}`);
  assert.equal(out.odds_gate, undefined);
});
