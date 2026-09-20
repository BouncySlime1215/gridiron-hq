/**
 * The odds page must not state a bracket it did not simulate.
 *
 * `season-sim.js` decides three things about every set of odds it returns and serves
 * all three — which bracket it played (`playoff_basis`), which games the projections
 * rest on (`projection_basis`), and what the ± range beside the championship number
 * actually measures (`odds_interval`). My Team rendered none of them. In their place
 * it carried a flat sentence, "real playoff bracket weeks 15–17", which is false for
 * any league whose bracket is not those weeks and worse when it happens to be right:
 * `default_weeks_15_17` is the FALLBACK, taken when the league's schedule could not
 * be read at all, so the sentence read as a fact about the reader's league while
 * being a fact about our default.
 *
 * These tests run the real `playoffRounds` and `simProjectionBasis` and then hold the
 * client to what they emit. The four basis values are written out by hand rather than
 * scraped from either side, because a check that derives its expectation from the
 * thing it checks passes the exact defect it exists to catch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-odds-basis-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { playoffRounds, simProjectionBasis } = await import('../server/services/season-sim.js');

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const component = read('client/src/components/OddsBasis.tsx');

/** Every value playoffRounds can put on the response. Written out, not derived. */
const BASES = [
  'league_schedule',
  'league_schedule_short_of_field',
  'sleeper_playoff_week_start',
  'default_weeks_15_17'
];

test('an unreadable league schedule really does fall back, and says so', () => {
  // The case the old hardcoded sentence silently agreed with.
  assert.equal(playoffRounds({ platform: 'espn', payload: null }, 4).basis, 'default_weeks_15_17');
  assert.equal(playoffRounds({ platform: 'espn', payload: '{not json' }, 4).basis, 'default_weeks_15_17');
  assert.equal(playoffRounds({ platform: 'sleeper', payload: { settings: {} } }, 4).basis, 'default_weeks_15_17');
});

test("a league that states its own bracket is not reported as the default", () => {
  const sleeper = playoffRounds({ platform: 'sleeper', payload: { settings: { playoff_week_start: 14 } } }, 4);
  assert.equal(sleeper.basis, 'sleeper_playoff_week_start');
  assert.deepEqual(sleeper.rounds, [[14], [15]]);

  const espn = playoffRounds({
    platform: 'espn',
    payload: { settings: { scheduleSettings: { matchupPeriodCount: 13, matchupPeriods: { 14: [14], 15: [15], 16: [16] } } } }
  }, 4);
  assert.equal(espn.basis, 'league_schedule');
  assert.deepEqual(espn.rounds, [[14], [15]]);
});

test('a schedule shorter than the field is its own case, not the default', () => {
  // It uses what the league lists rather than inventing a week, so reporting it as
  // either the good case or the fallback would misdescribe the bracket played.
  const short = playoffRounds({
    platform: 'espn',
    payload: { settings: { scheduleSettings: { matchupPeriodCount: 13, matchupPeriods: { 14: [14] } } } }
  }, 8);
  assert.equal(short.basis, 'league_schedule_short_of_field');
  assert.equal(short.rounds_needed, 3);
  assert.equal(short.rounds.length, 1);
});

test('an empty current-season log is named, not quietly treated as measured', () => {
  // The live defect: `{through: 2026}` against an empty 2026 log returns exactly the
  // prior seasons' rows, so the odds are unchanged while the label would claim this
  // season. The string has to say the log was empty.
  const empty = simProjectionBasis(3, 2026, 0);
  assert.equal(empty.through, 2025);
  assert.match(empty.basis, /usage log is empty/);
  assert.match(empty.basis, /2 weeks played/);
});

test('a log behind the calendar is reported as behind, not rounded up', () => {
  const behind = simProjectionBasis(7, 2026, 4);
  assert.equal(behind.through, 2026);
  assert.equal(behind.throughWeek, 6, 'the cutoff stays the calendar, which is leak-safe');
  assert.match(behind.basis, /only 4 of those 6 weeks are in the usage log/);
});

test('the page has a sentence for every basis the simulator can emit', () => {
  // A basis with no entry renders as nothing at all, which is the silence this
  // component exists to end — and it would be silent exactly on a new, unhandled case.
  for (const basis of BASES) {
    assert.match(component, new RegExp(`${basis}:`), `OddsBasis has no sentence for ${basis}`);
  }
  const server = read('server/services/season-sim.js');
  const emitted = [...server.matchAll(/basis: '([a-z_0-9]+)'/g)].map(m => m[1]);
  assert.deepEqual([...new Set(emitted)].sort(), [...BASES].sort(),
    'the simulator emits a basis this test does not know about; add it here and to OddsBasis');
});

test('the false sentence is gone, and the fallback is called an assumption', () => {
  const page = read('client/src/pages/MyTeam.tsx');
  assert.doesNotMatch(page, /real playoff bracket weeks 15/,
    'My Team still states one league\'s bracket as a fact for every league');
  assert.match(page, /<OddsBasis sim=\{sim\} \/>/, 'and renders what the server decided instead');
  assert.match(component, /weeks 15–17 are assumed/, 'the fallback is described as an assumption');
  assert.match(component, /odds_interval/, 'the range says what it measures');
  assert.match(component, /projection_basis/, 'and the odds say which games they rest on');
});

test('no active fit is a sentence, not a missing line', () => {
  // `projection_fit: null` is the live state today — shrinkage_fits holds zero rows
  // on the deployed volume — and it is the case a reader most needs told, because an
  // absent field is invisible and reads as "nothing to say about this".
  assert.match(component, /if \(fit === null\) return '[^']*no fitted model is active/,
    'null renders as a statement about the constants, not as nothing');
  assert.match(component, /if \(fit === undefined\) return null;/,
    'a response that predates the field renders nothing, which is different from null');
});

test('the fitted/hand-set volume split is stated, not collapsed into "fitted"', () => {
  // The whole reason a fit id alone could not answer this. With an active fit the
  // simulator runs on fitted efficiency constants and hand-set VOLUME constants at
  // once: activeKVectorFor withholds the volume entries from every caller that is
  // not on weekly-role recency, and the simulator never is.
  assert.match(component, /volume_k === 'hand_set'/);
  assert.match(component, /fitted efficiency constants and hand-set volume constants/,
    'the page says both halves rather than calling the whole thing fitted');
});

test('the projection basis is rendered whole', () => {
  // It can read "2026 through week 5, but only 3 of those 5 weeks are in the usage
  // log". Clipping it would delete exactly the caveat it exists to carry, so nothing
  // here truncates or slices it.
  assert.match(component, /\$\{sim\.projection_basis\}/);
  assert.doesNotMatch(component, /projection_basis[^\n]*\.slice\(|projection_basis[^\n]*substring\(/,
    'the sentence is never cut');
});
