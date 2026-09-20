/**
 * The snap-share ingest, and what it does with a number it cannot be (2026-09-20).
 *
 * WHY 0 TO 1 IS NOT A STYLE CHOICE. `offense_pct` is stored raw and its scale is load-bearing
 * in two places that read it:
 *
 *   - `role-changepoint.js:29` confirms a role change on `snapDelta >= 0.08` -- an ABSOLUTE
 *     difference of two `offense_pct` values. On a 0-1 scale that is eight percentage points.
 *     On a 0-100 scale it is eight hundredths of one percentage point, so `snapConfirms` is
 *     true for essentially every player and the confirmation step silently stops filtering.
 *   - `contingency.js:299 roleTier` bands at 0.60 / 0.35 / 0.15. On a 0-100 scale every
 *     player is a 'starter'.
 *
 * Neither fails. Both keep returning verdicts. So the ingest has to guarantee what the
 * consumers require, and say so loudly when the source disagrees -- it must never quietly
 * scale, because a silent divide-by-100 would also silently "fix" a genuinely corrupt row.
 *
 * TWO TABLES, ONE QUANTITY, SAME UPSTREAM FILE. `nflverse.js#syncSnapCounts` writes
 * `player_week_snaps` keyed on our `player_id`; `nfl-advanced.js#syncSnaps` writes `nfl_snaps`
 * keyed on the raw player name and team. Both read
 * `snap_counts/snap_counts_<season>.csv` from the same nflverse release. Nothing asserts the
 * two agree, and they have different failure modes: one drops players it cannot name-match,
 * the other keeps the name it was given. That is recorded in the evidence file as a finding,
 * not fixed here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-snap-ingest-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { syncSnapCounts, snapShareVerdict, SNAP_SHARE_RANGE }
  = await import('../server/services/nflverse.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

run(`INSERT INTO players (id, name, position) VALUES (?,?,?)`, 701, 'Snap Receiver', 'WR');
run(`INSERT INTO players (id, name, position) VALUES (?,?,?)`, 702, 'Other Receiver', 'WR');

const HEADER = 'season,week,game_type,player,position,offense_snaps,offense_pct';
const csv = lines => [HEADER, ...lines].join('\n');

/** Stub the one network call; fetchCsv uses global fetch and parses text as CSV. */
function withCsv(text, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => text });
  try { return fn(); } finally { globalThis.fetch = real; }
}

const snapRows = () => rows('SELECT player_id, week, offense_snaps, offense_pct FROM player_week_snaps ORDER BY player_id, week');

/* ------------------------------------------------------- the pure verdict */

test('the range is 0 to 1 because that is what the consumers require', () => {
  assert.equal(SNAP_SHARE_RANGE.min, 0);
  assert.equal(SNAP_SHARE_RANGE.max, 1);
  assert.match(SNAP_SHARE_RANGE.required_by, /role-changepoint|roleTier|contingency/i,
    'the range has to name what would break, or the next reader will widen it');
});

test('a share inside the range is accepted unchanged', () => {
  for (const value of [0, 0.001, 0.5, 0.847, 1]) {
    const v = snapShareVerdict(value);
    assert.equal(v.ok, true, `${value}`);
    assert.equal(v.value, value, 'never rescaled, never rounded');
  }
});

test('a share outside the range is refused and says what it was, and is NEVER scaled', () => {
  for (const value of [84.7, 100, 1.0001, -0.2, 2]) {
    const v = snapShareVerdict(value);
    assert.equal(v.ok, false, `${value}`);
    assert.equal(v.value, null, 'the stored value is absent, not a guess');
    assert.equal(v.observed, value, 'the number that arrived is carried so it can be read');
    assert.match(v.reason, /0 and 1|out of range/i);
    // The tempting fix is the dangerous one: dividing by 100 would also "repair" a corrupt
    // row into a plausible one, and nobody would ever see it.
    assert.notEqual(v.value, value / 100);
  }
});

test('a missing share is absent, which is different from out of range', () => {
  for (const value of [null, undefined, NaN]) {
    const v = snapShareVerdict(value);
    assert.equal(v.ok, false);
    assert.equal(v.value, null);
    assert.match(v.reason, /no snap share|absent|missing/i,
      `a missing value must not be reported as out of range: ${String(value)}`);
    // `observed` is what the ingest loop reads to decide whether a row was out of RANGE as
    // opposed to simply absent, so a missing value substituting any number here -- a zero
    // included -- collapses the two reasons the function exists to keep apart.
    assert.equal(v.observed, null,
      `a missing value must report no observation, not a substituted one: ${String(value)}`);
  }
});

/* ------------------------------------------------------- the ingest */

test('a clean file lands every row unchanged', async () => {
  const out = await withCsv(csv([
    '2026,1,REG,Snap Receiver,WR,55,0.812',
    '2026,2,REG,Snap Receiver,WR,60,0.905',
    '2026,1,REG,Other Receiver,WR,20,0.31'
  ]), () => syncSnapCounts(2026));
  assert.equal(out.inserted, 3);
  assert.equal(out.out_of_range, 0);
  assert.equal(out.unmatched, 0);
  assert.deepEqual(snapRows().map(r => r.offense_pct), [0.812, 0.905, 0.31]);
});

test('an out-of-range share is stored as absent, counted, and sampled in the report', async () => {
  run('DELETE FROM player_week_snaps');
  const out = await withCsv(csv([
    '2026,3,REG,Snap Receiver,WR,55,81.2',
    '2026,4,REG,Snap Receiver,WR,60,0.905'
  ]), () => syncSnapCounts(2026));

  assert.equal(out.out_of_range, 1, 'the count is the point: a silent drop is what this replaces');
  assert.ok(Array.isArray(out.out_of_range_samples) && out.out_of_range_samples.length,
    'a count with no example cannot be investigated');
  assert.equal(out.out_of_range_samples[0].observed, 81.2);

  const stored = snapRows();
  assert.equal(stored.length, 2, 'the appearance is still a real appearance');
  const bad = stored.find(r => r.week === 3);
  assert.equal(bad.offense_pct, null, 'absent, not scaled and not a zero');
  assert.equal(bad.offense_snaps, 55, 'the snap COUNT is unaffected and still usable');
  assert.equal(stored.find(r => r.week === 4).offense_pct, 0.905);
});

test('a row with no share at all is not counted as out of range', async () => {
  // The distinction the verdict draws is only worth drawing if the REPORT keeps it. A source
  // row that simply carries no `offense_pct` is a gap in the feed; an 81.2 is a unit change
  // upstream. If the first is counted as the second, `out_of_range` stops meaning what it
  // says and the number nobody can act on is the one the guard exists to produce.
  run('DELETE FROM player_week_snaps');
  const out = await withCsv(csv([
    '2026,5,REG,Snap Receiver,WR,41,',
    '2026,6,REG,Snap Receiver,WR,60,0.71'
  ]), () => syncSnapCounts(2026));

  assert.equal(out.out_of_range, 0,
    'a missing share is a gap in the feed, not a value that cannot be a share');
  assert.equal(out.out_of_range_samples.length, 0,
    'and it contributes no sample, or the samples stop being investigable');

  const stored = snapRows();
  assert.equal(stored.length, 2, 'the appearance is still real, as with an out-of-range share');
  const gap = stored.find(r => r.week === 5);
  assert.equal(gap.offense_pct, null);
  assert.equal(gap.offense_snaps, 41, 'the snap COUNT is unaffected by a missing share too');
});

test('a whole file on the wrong scale is reported as such, not ingested as football', async () => {
  // The case that matters most: not one bad row but an upstream unit change, where every row
  // is plausible on its own scale and every consumer silently stops discriminating.
  run('DELETE FROM player_week_snaps');
  const out = await withCsv(csv([
    '2026,5,REG,Snap Receiver,WR,55,81.2',
    '2026,6,REG,Snap Receiver,WR,60,90.5',
    '2026,5,REG,Other Receiver,WR,20,31.0'
  ]), () => syncSnapCounts(2026));

  assert.equal(out.out_of_range, 3);
  assert.equal(out.inserted, 3);
  assert.equal(snapRows().every(r => r.offense_pct === null), true,
    'not one of them may be stored, because every one of them is unusable');
  assert.ok(out.out_of_range >= out.inserted,
    'a report where every row failed has to be distinguishable from one bad row');
});

test('a player we cannot name-match is counted, not silently dropped', async () => {
  // It used to `continue` with no counter, so the return value said `inserted: n` and nothing
  // about how many players never arrived. A sync that matched a third of the league and one
  // that matched all of it returned the same shape.
  run('DELETE FROM player_week_snaps');
  const out = await withCsv(csv([
    '2026,7,REG,Snap Receiver,WR,55,0.8',
    '2026,7,REG,Nobody We Carry,WR,40,0.6'
  ]), () => syncSnapCounts(2026));
  assert.equal(out.inserted, 1);
  assert.equal(out.unmatched, 1, 'the players that never arrived must be countable');
});

test('postseason rows are not regular-season snap shares', async () => {
  run('DELETE FROM player_week_snaps');
  const out = await withCsv(csv([
    '2026,8,REG,Snap Receiver,WR,55,0.8',
    '2026,19,POST,Snap Receiver,WR,70,0.99'
  ]), () => syncSnapCounts(2026));
  assert.equal(out.inserted, 1);
  assert.equal(snapRows().some(r => r.week === 19), false);
});
