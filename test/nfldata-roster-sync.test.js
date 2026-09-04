import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-roster-sync-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, run } = await import('../server/db/index.js');
// Creates player_accolades/slot_weakness (roster_players' only FK referencers) on import.
await import('../server/routes/accolades.js');
const { syncRosters } = await import('../server/routes/nfldata.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

function espnAthlete(id, name) {
  return { id: String(id), displayName: name, fullName: name,
    position: { abbreviation: 'WR' }, jersey: '1', age: 25,
    experience: { years: 3 }, displayHeight: `6' 0"`, weight: 200, status: { type: 'active' } };
}

/** Only WAS (ESPN team id 28) resolves; every other team 404s, same as a real partial outage. */
function stubEspnRoster(athletes) {
  globalThis.fetch = async url => {
    if (url.includes('/teams/28/roster')) {
      return { ok: true, json: async () => ({ athletes: [{ position: 'WR', items: athletes }] }) };
    }
    return { ok: false, status: 404 };
  };
}

test('a roster sync survives a departed player who has accolades or a slot-weakness verdict attached, instead of throwing on the FK and failing every team', async () => {
  run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (28, 'WAS', 'Washington Commanders', 'NFC', 'East')`);

  // Still on the roster this sync, and already has both a real accolade and a
  // slot-weakness verdict recorded against their CURRENT roster_players row —
  // this is exactly the shape that used to crash the sync (DELETE FROM
  // roster_players WHERE team_id=? hit the FK the moment either table had a row).
  run(`INSERT INTO roster_players (team_id, espn_id, name, position, unit) VALUES (28, 111, 'Still Here', 'WR', 'WR')`);
  const stayingId = row(`SELECT id FROM roster_players WHERE espn_id = 111`).id;
  run(`INSERT INTO player_accolades (roster_player_id, name, pro_bowls) VALUES (?, 'Still Here', 2)`, stayingId);
  run(`INSERT INTO slot_weakness (roster_player_id, verdict, reasoning) VALUES (?, 'fine', 'solid WR2')`, stayingId);

  // No longer on the roster this sync — also has an accolade attached.
  run(`INSERT INTO roster_players (team_id, espn_id, name, position, unit) VALUES (28, 222, 'Long Gone', 'WR', 'WR')`);
  const goneId = row(`SELECT id FROM roster_players WHERE espn_id = 222`).id;
  run(`INSERT INTO player_accolades (roster_player_id, name, pro_bowls) VALUES (?, 'Long Gone', 1)`, goneId);

  stubEspnRoster([espnAthlete(111, 'Still Here')]);

  await assert.doesNotReject(() => syncRosters(), 'a departed player with accolades/slot-weakness must not crash the whole sync');

  const staying = row(`SELECT id FROM roster_players WHERE espn_id = 111`);
  assert.equal(staying.id, stayingId, 'a still-rostered player must keep the same row id, or every FK pointing at it breaks again next sync');
  assert.ok(row(`SELECT 1 FROM player_accolades WHERE roster_player_id = ?`, stayingId), 'their accolade must survive');
  assert.ok(row(`SELECT 1 FROM slot_weakness WHERE roster_player_id = ?`, stayingId), 'their slot-weakness verdict must survive');

  assert.equal(row(`SELECT 1 FROM roster_players WHERE espn_id = 222`), undefined, 'the departed player\'s roster row must actually be removed');
  assert.equal(row(`SELECT 1 FROM player_accolades WHERE roster_player_id = ?`, goneId), undefined,
    'their now-orphaned accolade must be cleaned up too, not left pointing at a deleted row');
});
