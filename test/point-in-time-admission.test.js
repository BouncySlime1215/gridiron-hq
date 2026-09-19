import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admitPointInTimeRow, admitPointInTimeRows, assertPointInTimeRow,
  NFL_OBSERVATION_CLOCKS, STRICT_CLOCK_FROM
} from '../server/modeling/contracts.js';

/*
 * FINAL ORDER #3 (2026-09-16, RUNBOOK §10.3) — point-in-time admission for
 * the five raw tables the NFL betting path reads.
 *
 * The recipe's exit tests, in its own words: "a backdated row (modified_at
 * after the cutoff) is rejected by the freeze path; a row with null
 * modified_at in 2025+ is rejected; 2021-2024 rows with valid clocks pass
 * unchanged."
 *
 * Pure functions over plain rows — no database, so this runs anywhere.
 */

const CUTOFF_2023 = '2023-10-01T17:00:00Z';
const CUTOFF_2025 = '2025-10-01T17:00:00Z';

test('a row modified BEFORE the cutoff is admitted, under the regime it actually earns', () => {
  const v = admitPointInTimeRow({ modified_at: '2023-09-28T12:00:00Z' },
    { table: 'nfl_injuries', cutoffAt: CUTOFF_2023 });
  assert.equal(v.admitted, true);
  assert.equal(v.regime, 'unmodified_since',
    'a current-state row is admissible but must never be labelled an archived version');
  assert.equal(v.knownAt, '2023-09-28T12:00:00.000Z');
});

test('a backdated row — modified AFTER the cutoff — is refused', () => {
  const v = admitPointInTimeRow({ modified_at: '2023-10-02T12:00:00Z' },
    { table: 'nfl_injuries', cutoffAt: CUTOFF_2023 });
  assert.equal(v.admitted, false);
  assert.match(v.reason, /after the cutoff/);
});

test('a null clock in 2025+ is refused — this is the nflverse regression, not a technicality', () => {
  // Measured 2026-09-16: nfl_injuries.modified_at is 0% populated for 2025
  // (5,783 rows) and 2026 (182 rows). Treating that as "fine" would mean
  // reading today's injury table and calling it last week's.
  const v = admitPointInTimeRow({ modified_at: null },
    { table: 'nfl_injuries', cutoffAt: CUTOFF_2025 });
  assert.equal(v.admitted, false);
  assert.match(v.reason, /missing/);
  assert.match(v.reason, /2025-01-01/);
});

test('the same null clock BEFORE the strict date is still refused, but without the strict-era reason', () => {
  const v = admitPointInTimeRow({ modified_at: null },
    { table: 'nfl_injuries', cutoffAt: CUTOFF_2023 });
  assert.equal(v.admitted, false, 'a clocked table with no clock value is never admissible');
  assert.doesNotMatch(v.reason, /2025-01-01/);
});

test('nfl_depth is admitted on OUR receipt clock, which is a stronger claim than unmodified_since', () => {
  const v = admitPointInTimeRow({ captured: '2025-09-28T12:00:00Z' },
    { table: 'nfl_depth', cutoffAt: CUTOFF_2025 });
  assert.equal(v.admitted, true);
  assert.equal(v.regime, 'observed');
  // And a chart captured after kickoff is refused even though the table is healthy.
  const late = admitPointInTimeRow({ captured: '2025-10-02T12:00:00Z' },
    { table: 'nfl_depth', cutoffAt: CUTOFF_2025 });
  assert.equal(late.admitted, false);
});

test('a clockless table is grandfathered before the strict date and refused at or after it', () => {
  for (const table of ['nfl_team_week_features', 'nfl_snaps', 'nfl_pfr_adv']) {
    assert.equal(NFL_OBSERVATION_CLOCKS[table].regime, 'none');
    const old = admitPointInTimeRow({}, { table, cutoffAt: CUTOFF_2023 });
    assert.equal(old.admitted, true, `${table} should be grandfathered pre-${STRICT_CLOCK_FROM}`);
    assert.equal(old.regime, 'none_grandfathered',
      'grandfathered rows must be labelled as such, never as a real point-in-time claim');
    const now = admitPointInTimeRow({}, { table, cutoffAt: CUTOFF_2025 });
    assert.equal(now.admitted, false, `${table} must be refused at or after ${STRICT_CLOCK_FROM}`);
    assert.match(now.reason, /no publication clock/);
  }
});

test('a malformed timestamp is refused as malformed, never silently treated as absent or as zero', () => {
  const v = admitPointInTimeRow({ modified_at: 'week 4' },
    { table: 'nfl_injuries', cutoffAt: CUTOFF_2023 });
  assert.equal(v.admitted, false);
  assert.match(v.reason, /not a parseable timestamp/);
});

test('a missing or unparseable cutoff is refused rather than defaulted', () => {
  for (const cutoffAt of [null, undefined, '', 'sometime']) {
    const v = admitPointInTimeRow({ modified_at: '2023-09-01T00:00:00Z' },
      { table: 'nfl_injuries', cutoffAt });
    assert.equal(v.admitted, false);
  }
});

test('an unknown table is refused by name rather than waved through', () => {
  const v = admitPointInTimeRow({}, { table: 'nfl_some_new_table', cutoffAt: CUTOFF_2023 });
  assert.equal(v.admitted, false);
  assert.match(v.reason, /unknown table/);
});

test('assertPointInTimeRow throws for the freeze path, where one leaked row must stop the run', () => {
  assert.throws(() => assertPointInTimeRow({ modified_at: '2023-10-02T12:00:00Z' },
    { table: 'nfl_injuries', cutoffAt: CUTOFF_2023 }), /point-in-time refusal/);
  assert.doesNotThrow(() => assertPointInTimeRow({ modified_at: '2023-09-01T00:00:00Z' },
    { table: 'nfl_injuries', cutoffAt: CUTOFF_2023 }));
});

test('batch admission reports WHAT it refused and why — a silent drop is indistinguishable from no data', () => {
  const rows = [
    { modified_at: '2023-09-01T00:00:00Z' },   // fine
    { modified_at: '2023-09-02T00:00:00Z' },   // fine
    { modified_at: '2023-12-01T00:00:00Z' },   // after cutoff
    { modified_at: null }                       // no clock
  ];
  const out = admitPointInTimeRows(rows, { table: 'nfl_injuries', cutoffAt: CUTOFF_2023 });
  assert.equal(out.admitted.length, 2);
  assert.equal(out.refused, 2);
  assert.equal(Object.values(out.refused_by).reduce((a, b) => a + b, 0), 2);
  assert.ok(Object.keys(out.refused_by).some(r => /after the cutoff/.test(r)));
  assert.ok(Object.keys(out.refused_by).some(r => /missing/.test(r)));
});

test('2021-2024 rows with valid clocks pass unchanged — the recipe\'s third exit test', () => {
  for (const [season, stamp] of [[2021, '2021-10-01'], [2022, '2022-10-01'],
    [2023, '2023-10-01'], [2024, '2024-10-01']]) {
    const cutoff = `${stamp}T17:00:00Z`;
    const v = admitPointInTimeRow({ modified_at: `${stamp}T09:00:00Z` },
      { table: 'nfl_injuries', cutoffAt: cutoff });
    assert.equal(v.admitted, true, `season ${season} should pass`);
  }
});
