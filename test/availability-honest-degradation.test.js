/**
 * Chance to play must never fail open to a confident-looking number.
 *
 * review-fixes-2 finding 1 closed the bare catch in `fittedAvailability()`: a missing
 * fit table is now a NAMED basis ('role' | 'pooled' | 'constants'), warned once and
 * carried on `assetUniverse().context` and `lineupCall()`. Two holes of the same shape
 * were left open, and both are live on the Start/Sit screen:
 *
 *   1. `liveEspnStatuses()` still reads the `leagues` table inside a bare
 *      `catch { return null; }`. `leagues` is created by the legacy schema migration at
 *      import of server/db/index.js, so it always exists — which means that catch can
 *      only ever fire on a REAL fault (schema drift, a locked database), and when it
 *      does the whole ESPN designation layer disappears with no log, no throw and no
 *      change to `availabilityBasis()`. Measured on the fixture below: an ESPN
 *      INJURY_RESERVE starter goes from 0.006 to 0.953 and is started.
 *
 *   2. `lineupCall()` carries `availability_basis`, but nothing says it out loud. With
 *      the role layer inert the page prints "about 57% likely to suit up and see the
 *      ball this week" under
 *      "Check before kickoff" for a player with no injury at all — a pooled
 *      injury-report rate presented exactly like the validated one. The house rule is
 *      honest degradation with the reason attached (counterparty-pricing.js reports an
 *      inert source as { source, reason }), so the note names the layer, why it is
 *      inert, what the shown numbers therefore are, and how to fix it.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-availability-honest-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const C = await import('../server/services/contingency.js');
const realTradeEngine = await import('../server/services/trade-engine.js');

let mockedAssets = new Map();
mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realTradeEngine,
    assetUniverse: () => mockedAssets,
    tradeWeekContext: () => ({ season: 2026, week: 2 }),
    lineupDiff: () => ({ error: 'not under test' })
  }
});
const { lineupCall } = await import('../server/services/lineup-brain.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const warnings = () => {
  const spy = mock.method(console, 'warn', () => {});
  return {
    about: text => spy.mock.calls.filter(c => String(c.arguments.join(' ')).includes(text)).length,
    restore: () => spy.mock.restore()
  };
};

/* ----------------------------------------------- fixture: one healthy, one ESPN IR */

const player = (id, name, gsis, espn) =>
  run('INSERT INTO players (id, name, position, gsis_id, espn_id) VALUES (?,?,?,?,?)', id, name, 'WR', gsis, espn);
const appear = (id, season, week, team, pct) => {
  run(`INSERT INTO player_week_usage (player_id, season, week, team, position, targets, carries, attempts)
       VALUES (?,?,?,?,'WR',5,0,0)`, id, season, week, team);
  run('INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (?,?,?,?,?)',
    id, season, week, Math.round(pct * 65), pct);
};

const ROSTER = [[921, 'Honest Healthy', 'hon-h', 7001, 'ACTIVE'], [922, 'Honest EspnIR', 'hon-r', 7002, 'INJURY_RESERVE']];
for (const [id, name, gsis, espn] of ROSTER) {
  player(id, name, gsis, espn);
  for (let w = 1; w <= 5; w++) appear(id, 2025, w, 'AAA', 0.9);
}
run(`INSERT INTO leagues (platform, league_id, season, name, my_team_id, payload, fetched_at)
     VALUES ('espn', 'honest-1', 2025, 'Honest', '1', ?, datetime('now'))`,
JSON.stringify({ seasonId: 2025, scoringPeriodId: 6,
  teams: [{ id: 1, roster: { entries: ROSTER.map(([, name, , espn, status]) => ({
    lineupSlotId: 20, playerPoolEntry: { player: { id: espn, fullName: name, injuryStatus: status, proTeamId: 1 } }
  })) } }] }));

db.exec(C.AVAILABILITY_RATES_DDL);
db.exec(C.AVAILABILITY_ROLE_RATES_DDL);
const fittedAt = '2026-09-19T00:00:00Z';
for (const [rs, p, n] of [['none', 0.8314, 3564], ['out', 0.004, 900]]) {
  run(`INSERT INTO nfl_availability_rates (scope,team,report_status,practice_status,p_active,n,raw_rate,shrunk,fitted_at)
       VALUES ('league','',?,'any',?,?,?,0,?)`, rs, p, n, p, fittedAt);
}
const config = JSON.stringify({ k: 5, byPosition: false, durabilityCap: false });
for (const [rs, ps, tier, gap, p] of [
  ['noreport', '*', '*', '*', 0.70], ['noreport', 'none', '*', '*', 0.70],
  ['noreport', 'none', 'starter', '*', 0.90], ['noreport', 'none', 'starter', 'g0', 0.953],
  ['out', '*', '*', '*', 0.006]
]) {
  run(`INSERT INTO nfl_availability_role_rates
       (report_status,practice_status,position,tier,gap,p_active,n,raw_rate,config,fitted_at)
       VALUES (?,?,'*',?,?,?,100,?,?,?)`, rs, ps, tier, gap, p, p, config, fittedAt);
}
C.resetAvailabilityCache();

/* ------------------------------------- 1. the ESPN designation layer cannot vanish */

test('the fixture prices the ESPN INJURY_RESERVE starter as out while the leagues table reads', () => {
  C.resetAvailabilityCache();
  const a = C.weeklyAvailability(2025, 6);
  assert.equal(a.get(921).active_probability, 0.953, 'healthy starter on his role cell');
  assert.equal(a.get(922).active_probability, 0.006, 'ESPN IR priced on the out designation');
  assert.equal(a.get(922).espn_status, 'INJURY_RESERVE');
});

test('a leagues read fault throws instead of silently dropping every ESPN designation', () => {
  db.exec('ALTER TABLE leagues RENAME COLUMN fetched_at TO fetched_at_v2');
  C.resetAvailabilityCache();
  try {
    // Before this test: the bare catch swallowed it, `espn_status` went null and the
    // ESPN IR starter read 0.953 — startable, with nothing anywhere saying why.
    assert.throws(() => C.weeklyAvailability(2025, 6), /fetched_at/,
      'a real read fault on the ESPN source is a fault, not "no ESPN designations"');
  } finally {
    db.exec('ALTER TABLE leagues RENAME COLUMN fetched_at_v2 TO fetched_at');
    C.resetAvailabilityCache();
  }
});

test('no leagues table at all is a named state: null, said once, with its reason', () => {
  const saved = db.prepare('SELECT * FROM leagues').all();
  db.exec('ALTER TABLE leagues RENAME TO leagues_parked');
  C.resetAvailabilityCache();
  const warn = warnings();
  try {
    assert.equal(C.liveEspnStatuses(2025, 6), null, 'no leagues table: no ESPN statuses');
    assert.equal(C.liveEspnStatuses(2025, 6), null);
    assert.equal(warn.about('ESPN'), 1, 'said exactly once, not per call and not never');
    assert.equal(warn.about('leagues'), 1, 'the warning names the table it could not read');
  } finally {
    warn.restore();
    db.exec('ALTER TABLE leagues_parked RENAME TO leagues');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leagues').get().n, saved.length);
    C.resetAvailabilityCache();
  }
});

/* --------------------------- 2. Start/Sit says when the role layer is not the one pricing */

const POOLED = { basis: 'pooled', missing: ['nfl_availability_role_rates'], stamp: '139:x|0:' };
const ROLE = { basis: 'role', missing: [], stamp: '139:x|871:y' };

let leagueSeq = 80;
const callWith = (availability_basis, active_probability) => {
  mockedAssets = new Map([[1, {
    id: 1, name: 'Jayden Placeholder', position: 'QB', team_abbr: 'MID', espn_id: 9101, available: true,
    current_week_ppg: 18, adj_ppg: 18, ppg: 18, ros_ppg: 18, ceiling: 27, floor: 9, active_probability, bye: 9
  }]]);
  mockedAssets.context = { season: 2026, week: 2, availability_basis };
  const id = ++leagueSeq;
  const payload = { teams: [{ id: 1, name: 'Mine', roster: { entries: [{ lineupSlotId: 0,
    playerPoolEntry: { player: { id: 9101, fullName: 'Jayden Placeholder', defaultPositionId: 1, injuryStatus: 'ACTIVE' } } }] } }],
  schedule: [] };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, 'espn', ?, 2026, 'Honest lineup', '1', 10, 1, ?, ?)`,
  id, `honest-lg-${id}`, JSON.stringify(['QB']), JSON.stringify(payload));
  const call = lineupCall(id);
  assert.ok(!call.error, call.error);
  return call;
};

/**
 * The five assertions below replaced two pipe alternations, and each one carries the
 * mutation that motivated it, re-run AFTER the split. A replacement a neighbouring
 * clause can satisfy is not a split, so "it looks tighter" is not the test -- the row
 * is. Run with --experimental-test-module-mocks; without it this file does not load at
 * all and reports one failure that is not a test result.
 *
 * | assertion                          | mutation                                        | old | new |
 * |---|---|---|---|
 * | effect names the pooled rate       | `pooled injury-report rate` -> `pooled rate`    |  0  |  1  |
 * | effect carries the placeholder read| `known-low placeholder` -> `rough placeholder`  |  0  |  1  |
 * | effect is not the constants branch | the ternary always takes the constants side     |  1  |  1  |
 * | the caveat rides with the number   | caveat -> `not running from the fitted layer`   |  0  |  1  |
 * | the caveat names the inert layer   | `is not running (docs/...)` -> `is idle (...)`  |  0  |  1  |
 *
 * `old` is the failure count against the two alternations, `new` against the split.
 * Four rows are 0 -> 1: the mutation slid past the alternation and is caught now.
 *
 * THE THIRD ROW IS 1 -> 1, AND AN EARLIER VERSION OF THIS TABLE SAID 0 -> 1. That was
 * asserted rather than measured, and it was wrong: the constants sentence contains
 * neither `pooled` nor `injury report`, so the old alternation did catch the ternary
 * swap. The split preserves that coverage, it does not add it. The row is kept because
 * a `doesNotMatch` guard is worth having explicitly, not because the alternation was
 * blind to it. It is also not isolated -- the swap fails the first two assertions too
 * -- and is recorded that way rather than dressed up with a contrived edit only it
 * would catch.
 *
 * Hashes, so a row that failed to apply cannot read as a row the tests caught.
 * `contingency.js` base `28bffcd49d70`, `lineup-brain.js` base `7002b98fc00c`, both
 * restored and re-verified. Rows in order: `2f4c4bc310f0`, `252ef4a1b26c`,
 * `c97785591dff`, `8fe828b8e578` (lineup-brain), `f6649190a2cc`.
 */
test('an inert role layer is reported on the lineup call with its reason, like counterparty-pricing', () => {
  const note = callWith(POOLED, 0.574).availability_note;
  assert.ok(note, 'the pooled basis is a degradation and must be named');
  assert.equal(note.basis, 'pooled');
  assert.match(note.inert, /role/i, 'names the layer that is not running');
  assert.match(note.reason, /nfl_availability_role_rates/, 'names why, down to the table');
  // One assertion per claim, not an alternation. `effect` has exactly two possible
  // values, chosen by a ternary on the basis, and this fixture is the pooled one --
  // so an alternation here does not express a closed set, it accepts three wordings
  // of the one string the fixture can produce. The `injury report` branch never
  // matched anything at all: the producer writes `injury-report`, hyphenated.
  assert.match(note.effect, /pooled injury-report rate/,
    'names the layer that is actually pricing the numbers');
  assert.match(note.effect, /known-low placeholder/,
    'and says how to read it, which is the half a reader acts on');
  assert.doesNotMatch(note.effect, /hand-set constant/,
    'this is the pooled branch of the ternary, not the constants one');
  assert.match(note.fix, /fit-availability/, 'says what makes it live again');
});

test('no note when the fitted role layer is the one pricing the page', () => {
  assert.equal(callWith(ROLE, 0.574).availability_note, null);
  // A call solved on a universe that never reported a basis is not evidence of health.
  assert.equal(callWith(null, 0.574).availability_note, null);
});

test('a chance-to-play warning never reads as a fitted number while the layer is inert', () => {
  const degraded = callWith(POOLED, 0.574).warnings.find(w => w.player === 'Jayden Placeholder');
  assert.ok(degraded, 'a 57% chance to play is still flagged');
  assert.match(degraded.issue, /57% likely to suit up and see the ball/, 'the number is still shown');
  // Same again: the fixture pins the basis, so exactly one sentence is produced and
  // the three branches were three wordings of it. Two matched and one (`pooled`)
  // never did, so a reworded caveat could slide through on whichever branch still
  // happened to hit.
  assert.match(degraded.issue, /but that is not the fitted number:/,
    'the caveat is attached to the number, not left to the reader to infer');
  assert.match(degraded.issue, /the role layer is not running/,
    'and names the layer that is inert, not just that something is wrong');
  assert.equal(degraded.availability_basis, 'pooled');

  const fitted = callWith(ROLE, 0.574).warnings.find(w => w.player === 'Jayden Placeholder');
  assert.match(fitted.issue, /^about 57% likely to suit up and see the ball this week$/,
    'a fitted number carries no caveat');
  assert.equal(fitted.availability_basis, 'role');
});

test('the Start/Sit page renders the note instead of leaving it on the wire', () => {
  // availability_basis was added to this payload by review-fixes-2 "so the page can say
  // so" and no page ever read it. A served field nothing renders is not a disclosure.
  const src = fs.readFileSync(new URL('../client/src/pages/Lineup.tsx', import.meta.url), 'utf8');
  assert.match(src, /availability_note/, 'the lineup page reads the degradation note');
  assert.match(src, /\.reason/, 'and renders its reason, not just its existence');
});

test('the Start/Sit page labels the fitted state too, not only the broken one', () => {
  // The asymmetry this closes: a degraded percentage got a panel and a fitted one got
  // nothing, so "74% likely to play" rendered identically whether it was measured or a
  // hand-set constant standing in for a measurement. The reader could not tell them
  // apart from the number, which is the same defect the panel exists to prevent —
  // it was simply waiting for the next time the tables went missing.
  const src = fs.readFileSync(new URL('../client/src/pages/Lineup.tsx', import.meta.url), 'utf8');
  assert.match(src, /availability_basis\?\.basis === 'role'/,
    'the page reads the basis, not just the absence of a note');
  assert.match(src, /measured rate from the fitted availability/,
    'and says so on the fitted path instead of rendering nothing');
});
