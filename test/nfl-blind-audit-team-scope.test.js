/**
 * Real bug found tonight: run 28 crashed 22 weeks in because a live
 * scheduler job updated nfl_teams' current coaching-staff fields
 * (head_coach/oc_name/off_scheme/etc), and the blind audit's freeze check
 * hashed the WHOLE table unconditionally -- voiding a multi-hour historical
 * replay over a field that has zero bearing on it. Those columns are
 * explicitly documented elsewhere (nfl-scheme.js, nfl-offseason-change.js,
 * offseason-model.js) as "one undated current snapshot," and prediction
 * code only ever reads id/abbr/name from this table (verified:
 * nfl-expert-council.js). This mirrors the exact fix already in place for
 * `players` (fantasy draft-room churn vs the canonical NFL identity the
 * model actually depends on).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-blind-audit-team-scope-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { __test } = await import('../server/services/nfl-blind-audit.js');
const { inputDataState } = __test;

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('a live coaching-staff update to nfl_teams does not change the frozen input hash', () => {
  db.exec(`INSERT INTO nfl_teams (id, abbr, name, conference, division, head_coach)
    VALUES (1, 'AAA', 'Test Team', 'AFC', 'East', 'Original Coach')`);
  const before = inputDataState({ seasons: [2021, 2022, 2023, 2024, 2025] });

  db.exec(`UPDATE nfl_teams SET head_coach='New Coach', oc_name='New OC', off_scheme='Air Raid',
    analysis_updated_at=datetime('now') WHERE id=1`);
  const afterCoachChange = inputDataState({ seasons: [2021, 2022, 2023, 2024, 2025] });

  assert.equal(afterCoachChange.hash, before.hash,
    'a coaching-staff update must not void a historical audit — that data is an undated current snapshot the replay never reads');
});

test('a change to nfl_teams\' actual identity columns (abbr/name) DOES change the hash', () => {
  db.exec(`INSERT INTO nfl_teams (id, abbr, name, conference, division)
    VALUES (2, 'BBB', 'Original Name', 'NFC', 'West')`);
  const before = inputDataState({ seasons: [2021, 2022, 2023, 2024, 2025] });

  db.exec(`UPDATE nfl_teams SET name='Renamed Team' WHERE id=2`);
  const after = inputDataState({ seasons: [2021, 2022, 2023, 2024, 2025] });

  assert.notEqual(after.hash, before.hash,
    'a real identity change must still be caught -- this fix narrows the scope, it does not blind the freeze check entirely');
});
