/**
 * WR-FREEZE: Trade Brain fetches /brain/managers on load, and managerProfiles()
 * used to build the whole trade-engine asset universe (the projection stack) just to
 * list roster ids and owners. On a real league that blocked the event loop past the
 * watchdog. The tier list needs the rosters, never the assets.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-profiles-cost-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const real = await import('../server/services/trade-engine.js');
let universeBuilds = 0;
mock.module('../server/services/trade-engine.js', {
  namedExports: { ...real, assetUniverse: (...args) => { universeBuilds += 1; return real.assetUniverse(...args); } }
});
const brain = await import('../server/services/league-brain.js');
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const payload = {
  teams: [1, 2, 3].map(id => ({ id, name: `Team ${id}`, roster: { entries: [] } })),
  settings: { name: 'Cost fixture' }
};
run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
     roster_positions, connection_status)
     VALUES (8, 'espn', 'espn-cost-8', 2026, 'Cost fixture', ?, 3, '1', ?, 'connected')`,
JSON.stringify(payload), JSON.stringify(['QB', 'RB', 'WR', 'TE', 'FLEX']));

test('the manager tier list reads rosters without building the asset universe', () => {
  const out = brain.managerProfiles(8);
  assert.deepEqual(out.managers.map(m => [m.roster_id, m.owner]),
    [['1', 'Team 1'], ['2', 'Team 2'], ['3', 'Team 3']]);
  assert.equal(brain.setManagerProfile(8, '2', { tradeability: 'hard' }).ok, true);
  assert.equal(universeBuilds, 0);
});
