import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-player-repair-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const { db, row, run } = await import('../server/db/index.js');
const { playerIdentityRepairPlan } = await import('../server/services/player-repair.js');

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
