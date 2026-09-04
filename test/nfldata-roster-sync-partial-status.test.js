import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-roster-sync-partial-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows, run } = await import('../server/db/index.js');
// Creates player_accolades/slot_weakness (roster_players' only FK referencers) on import.
await import('../server/routes/accolades.js');
const { syncRosters } = await import('../server/routes/nfldata.js');
const { lastRun } = await import('../server/services/scheduler.js');
const { confidence } = await import('../server/services/source-registry.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

// Every abbr syncRosters() will iterate over, in the same order it builds
// ABBR_TO_ESPN from PRO_TEAM (ascending ESPN team id). One nfl_teams row per
// abbr, using the ESPN id as our internal id purely for test convenience.
const ESPN_TEAM_ID = {
  ATL: 1, BUF: 2, CHI: 3, CIN: 4, CLE: 5, DAL: 6, DEN: 7, DET: 8,
  GB: 9, TEN: 10, IND: 11, KC: 12, LV: 13, LAR: 14, MIA: 15, MIN: 16,
  NE: 17, NO: 18, NYG: 19, NYJ: 20, PHI: 21, ARI: 22, PIT: 23, LAC: 24,
  SF: 25, SEA: 26, TB: 27, WAS: 28, CAR: 29, JAX: 30, BAL: 33, HOU: 34
};
const ABBRS = Object.keys(ESPN_TEAM_ID);
assert.equal(ABBRS.length, 32, 'sanity check: this test must mirror all 32 real teams');

for (const abbr of ABBRS) {
  run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (?, ?, ?, 'NFC', 'East')`,
    ESPN_TEAM_ID[abbr], abbr, `${abbr} Team`);
}

const FAILING_ABBR = 'JAX'; // arbitrary single team standing in for one transient ESPN hiccup

function espnAthlete(id, name) {
  return { id: String(id), displayName: name, fullName: name,
    position: { abbreviation: 'WR' }, jersey: '1', age: 25,
    experience: { years: 3 }, displayHeight: `6' 0"`, weight: 200, status: { type: 'active' } };
}

/** 31 of 32 teams resolve fine; one (FAILING_ABBR) 404s, same as a real transient blip. */
function stubMostlyHealthyEspn() {
  globalThis.fetch = async url => {
    const failingTeamId = ESPN_TEAM_ID[FAILING_ABBR];
    if (url.includes(`/teams/${failingTeamId}/roster`)) return { ok: false, status: 503 };
    const matchedAbbr = ABBRS.find(a => url.includes(`/teams/${ESPN_TEAM_ID[a]}/roster`));
    return {
      ok: true,
      json: async () => ({ athletes: [{ position: 'WR', items: [espnAthlete(1000 + ESPN_TEAM_ID[matchedAbbr], `${matchedAbbr} Player`)] }] })
    };
  };
}

test('a single team\'s transient fetch failure among 32 is reported as partial, not error, and does not lose the other 31 teams\' data', async () => {
  stubMostlyHealthyEspn();

  await assert.doesNotReject(() => syncRosters(), 'one failed team out of 32 must not throw or crash the whole sync');

  // (b) the 31 successful teams' data is actually committed
  const healthyAbbrs = ABBRS.filter(a => a !== FAILING_ABBR);
  for (const abbr of healthyAbbrs) {
    const teamId = ESPN_TEAM_ID[abbr];
    const player = rows(`SELECT name FROM roster_players WHERE team_id = ?`, teamId)[0];
    assert.ok(player, `${abbr} (team_id ${teamId}) should have its roster committed`);
    assert.equal(player.name, `${abbr} Player`);
  }
  assert.equal(rows(`SELECT 1 FROM roster_players WHERE team_id = ?`, ESPN_TEAM_ID[FAILING_ABBR]).length, 0,
    'the one failed team should simply have no data, not a crash');

  // (c) sync_log reflects partial success, not 'error'
  const logged = lastRun('espn_rosters');
  assert.equal(logged.last_status, 'partial', 'a 31/32 sync must not be logged the same as a total failure');
  const detail = JSON.parse(logged.last_detail);
  assert.equal(detail.teamsAttempted, 32);
  assert.deepEqual(detail.failedTeams, [FAILING_ABBR], 'result must clearly report which team(s) failed');

  // (d) confidence() scores meaningfully better than the 0.1 error floor
  const score = confidence('espn_rosters');
  assert.ok(score > 0.9, `31/32 teams succeeding should score close to full confidence, got ${score}`);
});

test('confidence() scores a worse partial (16/32) noticeably lower than a mild one (31/32)', async () => {
  // Simulate by writing sync_log directly via another syncRosters() run where
  // half the teams fail, to prove the scaling is proportional, not a fixed bump.
  const { recordSync } = await import('../server/services/scheduler.js');
  const halfFailed = ABBRS.slice(0, 16);
  recordSync('espn_rosters', 'partial', { teams: 16, players: 16, teamsAttempted: 32, failedTeams: halfFailed });

  const halfScore = confidence('espn_rosters');
  assert.ok(halfScore < 0.9 && halfScore >= 0.1, `16/32 should score between the error floor and near-full confidence, got ${halfScore}`);
});
