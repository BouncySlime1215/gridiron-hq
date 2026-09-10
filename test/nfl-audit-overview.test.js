/**
 * Work package 0 (2026-09-10): auditOverview/compareAuditRuns against the
 * real dev database, read-only. Run 27 is a completed, immutable historical
 * record (70 sealed weeks, 2021-2025) with numbers this project has
 * independently verified by hand several times tonight -- exercising this
 * against real data, not a synthetic fixture, is the honest way to prove the
 * generator reproduces the same figures a manual SQL query already found.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { row } = await import('../server/db/index.js');
const { auditOverview, compareAuditRuns } = await import('../server/services/nfl-audit-overview.js');

const run27Exists = () => row(`SELECT status FROM nfl_blind_audit_runs WHERE id=27`)?.status === 'complete';

test('auditOverview on a nonexistent run reports an error, never a fabricated summary', () => {
  const result = auditOverview(999999);
  assert.match(result.error, /no blind audit run/);
});

test('auditOverview reproduces run 27\'s known spread-only numbers exactly', { skip: !run27Exists() }, () => {
  const overview = auditOverview(27);
  assert.equal(overview.status, 'complete');
  assert.equal(overview.weeks_sealed, 70);
  assert.equal(overview.spread_only.bets, 153);
  assert.equal(overview.spread_only.wins, 72);
  assert.equal(overview.spread_only.losses, 78);
  assert.equal(overview.spread_only.pushes, 3);
  assert.equal(overview.spread_only.win_rate, 0.48);
  assert.ok(Math.abs(overview.spread_only.units - -11.855) < 0.01, overview.spread_only.units);
  assert.ok(overview.spread_only.uncertainty, 'a 153-bet sample must produce a real bootstrap interval');
  assert.ok(Array.isArray(overview.spread_only.uncertainty.roi_95));
});

test('auditOverview never pools markets into one misleading win rate, and separates the two explicitly', { skip: !run27Exists() }, () => {
  const overview = auditOverview(27);
  assert.ok(overview.by_market.spread);
  assert.ok(overview.by_market.total);
  assert.ok(overview.by_market.moneyline);
  // The combined figure this project mistakenly cited early on (37.5%) must
  // never appear silently as "the" win rate -- spread's own rate (48%) is
  // clearly distinct from moneyline's (well under 40%, dominated by dogs).
  assert.notEqual(overview.by_market.spread.win_rate, overview.by_market.moneyline.win_rate);
  assert.match(overview.warning, /NOT a spread win rate/);
});

test('auditOverview flags when weeks 1-4 are untested', { skip: !run27Exists() }, () => {
  const overview = auditOverview(27);
  // Run 27's protocol is weeks 5-18 every season -- weeks 1-4 are never opened.
  assert.match(overview.early_season_note, /does NOT test weeks 1-4/);
  for (const c of overview.season_coverage) {
    const [lo] = c.weeks.split('-').map(Number);
    assert.ok(lo >= 5, `season ${c.season} should start at week 5 or later in run 27, got week ${lo}`);
  }
});

test('compareAuditRuns on a run with itself reports every week unchanged', { skip: !run27Exists() }, () => {
  const cmp = compareAuditRuns(27, 27);
  assert.equal(cmp.changed_weeks, 0);
  assert.equal(cmp.unchanged_weeks, cmp.overlapping_weeks);
  assert.match(cmp.note, /byte-identical/);
});

test('compareAuditRuns correctly reports run 27 vs run 31 as byte-identical on their shared prefix (already independently verified tonight)', {
  skip: !(run27Exists() && row(`SELECT status FROM nfl_blind_audit_runs WHERE id=31`)?.status === 'complete')
}, () => {
  const cmp = compareAuditRuns(27, 31);
  assert.equal(cmp.overlapping_weeks, 70, 'runs 27 and 31 cover the identical 70-week protocol');
  assert.equal(cmp.changed_weeks, 0, 'runs 27 and 31 were independently confirmed identical earlier tonight');
  assert.match(cmp.note, /byte-identical/);
});

test('compareAuditRuns on two runs with no overlapping weeks says so plainly', () => {
  const cmp = compareAuditRuns(999997, 999998);
  assert.match(cmp.error, /has no sealed weeks/);
});
