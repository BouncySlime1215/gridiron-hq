/**
 * Regression coverage for the receipt-clock fix in nfl-team-card.js's
 * injuryReport: the pregame injury list it hands to every downstream model
 * (Immutable shared team state -- simulator, neural head, injury model,
 * explanation layer) was previously gated on `nfl_injuries.modified_at`
 * alone -- the SOURCE's own claim about when a report changed, not this
 * system's receipt clock. Worse, because `nfl_injuries` is a mutable
 * latest-value table (test/nfl-injuries-bitemporal.test.js: "nfl_injuries
 * stays the mutable latest view -- it is no longer the evidence"), even a
 * correctly-gated row would still have handed an early cutoff a LATER
 * designation. injuryReport now reads both the cutoff gate and the reported
 * values from `nfl_feature_revisions` (observed_at), the same convention
 * nfl-t60-packet.js's injury read already established (Giant Plan 8.14).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-team-card-injury-cutoff-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();

const { __test } = await import('../server/services/nfl-team-card.js');
const { recordRevision } = await import('../server/services/nfl-bitemporal.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026, WEEK = 3;
const CUTOFF = '2026-09-20T16:00:00.000Z';

// injuryReport returns the whole roster for a (season, week, team), so tests
// that share a team would see each other's seeded players. Each test gets
// its own synthetic team code instead (same isolation strategy as
// test/nfl-expert-council-news-feed-cutoff.test.js's per-test team pairs).
let nextTeamId = 701;
const freshTeam = () => `Z${nextTeamId++}`;

/**
 * The identity row nfl-advanced.js's syncInjuries writes in the same
 * transaction as every real revision (server/services/nfl-advanced.js's
 * batch loop, `stmt.run(...b)` unconditionally). `report_status` here is
 * deliberately set to a LATER value than the revision passed in, so a test
 * can prove the read comes from the revision store, not this row.
 */
function seedIdentity(gsisId, team, { name = `${gsisId} Player`, position = 'WR',
  latestReportStatus = 'Out' } = {}) {
  run(`INSERT INTO nfl_injuries (season,week,gsis_id,team,full_name,position,report_status,modified_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    SEASON, WEEK, gsisId, team, name, position, latestReportStatus, '2026-09-21T12:00:00.000Z');
}

function seedRevision(gsisId, { publishedAt, observedAt = publishedAt, provenance = 'captured',
  value = { report_status: 'Questionable', practice_status: 'Limited', injury: 'Ankle' } } = {}) {
  recordRevision({ entity: `player:${gsisId}:${SEASON}:${WEEK}`, feature: 'injury_report',
    value, publishedAt, observedAt, provenance, sourceId: 'nflverse_injuries',
    entitySeason: SEASON, entityWeek: WEEK });
}

test('injuryReport: a report published and observed before the cutoff is included, with values from the revision, not nfl_injuries', () => {
  const team = freshTeam();
  seedIdentity('00-1000001', team);
  seedRevision('00-1000001', { publishedAt: '2026-09-19T18:00:00.000Z',
    value: { report_status: 'Questionable', practice_status: 'Limited', injury: 'Ankle' } });

  const result = __test.injuryReport(SEASON, WEEK, team, CUTOFF);
  assert.equal(result.players.length, 1);
  assert.equal(result.players[0].game_status, 'Questionable',
    'the reported status must come from the revision as of cutoff, not the later nfl_injuries row (seeded as Out)');
});

test('injuryReport: a report observed AFTER the cutoff is excluded even though its own published_at precedes the cutoff', () => {
  const team = freshTeam();
  seedIdentity('00-1000002', team);
  // Published Wednesday, but not actually received by this system until
  // Saturday -- a late-arriving correction, or a backfill.
  seedRevision('00-1000002', { publishedAt: '2026-09-17T10:00:00.000Z',
    observedAt: '2026-09-21T09:00:00.000Z' });

  const result = __test.injuryReport(SEASON, WEEK, team, CUTOFF);
  assert.equal(result.players.length, 0,
    'a revision this system had not yet received by the cutoff must not appear, regardless of its publish time');
});

test('injuryReport: a legacy nfl_injuries row with no matching revision is invisible, not silently trusted', () => {
  const team = freshTeam();
  seedIdentity('00-1000003', team);
  const result = __test.injuryReport(SEASON, WEEK, team, CUTOFF);
  assert.equal(result.players.length, 0,
    'without a revision, there is no receipt-clock evidence this system ever knew the report by the cutoff');
});

test('injuryReport: only the LATEST revision known by the cutoff is used, not an earlier one still on file', () => {
  const team = freshTeam();
  seedIdentity('00-1000004', team);
  seedRevision('00-1000004', { publishedAt: '2026-09-17T10:00:00.000Z',
    value: { report_status: 'Full Participation', practice_status: 'Full', injury: 'Ankle' } });
  seedRevision('00-1000004', { publishedAt: '2026-09-19T15:00:00.000Z',
    value: { report_status: 'Doubtful', practice_status: 'Did Not Participate', injury: 'Ankle' } });

  const result = __test.injuryReport(SEASON, WEEK, team, CUTOFF);
  assert.equal(result.players.length, 1);
  assert.equal(result.players[0].game_status, 'Doubtful',
    'the most recent report actually known by the cutoff must win over a stale earlier one');
});

test('injuryReport: mixing on-time and late-observed players only returns the on-time ones', () => {
  const team = freshTeam();
  seedIdentity('00-1000005', team);
  seedRevision('00-1000005', { publishedAt: '2026-09-18T12:00:00.000Z',
    value: { report_status: 'Out', practice_status: 'Did Not Participate', injury: 'Knee' } });
  seedIdentity('00-1000006', team, { name: 'Late Arrival' });
  seedRevision('00-1000006', { publishedAt: '2026-09-20T15:55:00.000Z',
    observedAt: '2026-09-20T16:05:00.000Z' }); // five minutes after CUTOFF

  const result = __test.injuryReport(SEASON, WEEK, team, CUTOFF);
  assert.equal(result.players.length, 1);
  assert.equal(result.players[0].id, '00-1000005');
});
