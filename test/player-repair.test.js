import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-player-repair-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const { db, row, run } = await import('../server/db/index.js');
const { playerIdentityRepairPlan, unclaimedTeamPositionDuplicates } = await import('../server/services/player-repair.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('repair plan is read-only and separates safe shadows from stable-id collisions', () => {
  run(`INSERT INTO players (name,position,espn_id,fantasy_relevant) VALUES ('Ja''Marr Chase','WR',111,1)`);
  const canonical = row('SELECT last_insert_rowid() id').id;
  run(`INSERT INTO players (name,position,espn_id,fantasy_relevant) VALUES ('Ja’Marr Chase','WR',NULL,0)`);
  const shadow = row('SELECT last_insert_rowid() id').id;
  run(`INSERT INTO players (name,position,espn_id,fantasy_relevant) VALUES ('Same Name','RB',201,1)`);
  run(`INSERT INTO players (name,position,espn_id,fantasy_relevant) VALUES ('Same Name','RB',202,1)`);
  const before = row('SELECT COUNT(*) n FROM players').n;

  const plan = playerIdentityRepairPlan();
  assert.equal(plan.dry_run, true);
  assert.ok(plan.safe.some(x => x.canonical_id === canonical && x.merge_ids.includes(shadow)));
  assert.ok(plan.review.some(x => x.name === 'Same Name' && /Multiple stable ESPN identities/.test(x.reason)));
  assert.equal(row('SELECT COUNT(*) n FROM players').n, before, 'dry-run must not mutate players');
});

test('flags a stale unclaimed row sitting on the same team+position as the espn-linked occupant', () => {
  // Reproduces the Antonio Williams / Noah Brown bug: a rookie takes over a
  // roster slot, ESPN sync creates a fresh row for the new occupant, and the
  // old occupant's row is left behind on the same team+position under its
  // own (now stale) name, unclaimed and still carrying real league activity.
  run(`INSERT INTO nfl_teams (abbr, name, conference, division) VALUES
       ('WAS','Washington','NFC','East'), ('OTH','Other','AFC','West')`);
  const was = row(`SELECT id FROM nfl_teams WHERE abbr='WAS'`).id;
  const other = row(`SELECT id FROM nfl_teams WHERE abbr='OTH'`).id;

  run(`INSERT INTO players (name,position,team_id,espn_id,sleeper_id,fantasy_relevant)
       VALUES ('Noah Brown','WR',?,NULL,'13301',1)`, was);
  const stale = row('SELECT last_insert_rowid() id').id;
  run(`INSERT INTO players (name,position,team_id,espn_id,slot_code,fantasy_relevant)
       VALUES ('Antonio Williams','WR',?,5081432,'WR3',1)`, was);
  const current = row('SELECT last_insert_rowid() id').id;
  // A same-named unclaimed shadow elsewhere must not be swept in here — that
  // case belongs to playerIdentityRepairPlan, not this detector.
  run(`INSERT INTO players (name,position,team_id,espn_id,fantasy_relevant) VALUES ('Someone Else','WR',?,NULL,1)`, other);

  const plan = unclaimedTeamPositionDuplicates();
  assert.equal(plan.dry_run, true);
  const hit = plan.review.find(x => x.team_id === was && x.position === 'WR');
  assert.ok(hit, 'expected a review candidate for the WAS / WR pair');
  assert.equal(hit.espn_linked.id, current);
  assert.ok(hit.shadows.some(s => s.id === stale));
  assert.equal(plan.review.length, 1, 'the unrelated team-OTH row must not be flagged');
});
