import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-league-roster-schedule-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations(); // adds leagues.connection_status/sync_error (migration 011)
const { refreshLeagueRosters, JOBS, resolveOffThread }
  = await import('../server/services/scheduler.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

// A real trade/waiver move made in the actual ESPN league previously never
// reached Trade Lab: loadRosters() in trade-engine.js reads leagues.payload
// directly with no cache of its own, but nothing ever re-fetched that payload
// automatically — only a manual click on "Sync" ever refreshed it. This is
// the regression test for the fix: league_rosters is now a real scheduled job.
//
// Split in two on 2026-09-20. The wiring — that this job exists on a tier with
// a cadence — is asserted below, on the registry. The BEHAVIOUR is asserted by
// calling refreshLeagueRosters directly, because driving it through runIfStale
// made these tests silently conditional on the job running inline: they stub
// globalThis.fetch on this thread, and a worker has its own. As written before,
// they turned red the moment the job moved off the request thread, which made
// two good tests into an argument against a fix. They now assert the behaviour
// rather than the thread it happens on.
test('league_rosters is wired to the scheduler, on a tier, with a cadence', () => {
  const job = JOBS.league_rosters;
  assert.ok(job, 'the job must exist in the registry; the regression this file '
    + 'was written for is a payload nothing ever re-fetched');
  assert.equal(job.run, refreshLeagueRosters);
  assert.equal(job.tier ?? 'live', 'live');
  assert.ok(Number.isFinite(job.maxAgeMinutes) && job.maxAgeMinutes > 0,
    'a job with no cadence is never stale, so runIfStale never runs it');
  // Off-thread or not is deliberately NOT asserted here. It is a scheduling
  // decision with its own guard in growth-jobs-off-thread.test.js, and pinning
  // it here is what coupled these tests to it in the first place.
  assert.equal(typeof resolveOffThread(job), 'boolean');
});

test('a connected league\'s own roster payload is re-synced, not left stale', async () => {
  run(`INSERT INTO leagues (platform, league_id, season, name, payload, connection_status)
       VALUES ('espn', '999', 2026, 'Old Name', '{}', 'connected')`);
  const leagueId = row(`SELECT id FROM leagues WHERE league_id='999'`).id;

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      settings: { name: 'Traded Since Last Sync', rosterSettings: { lineupSlotCounts: {} } },
      teams: [{ id: 1, name: 'Team A', roster: { entries: [] } }]
    })
  });

  const detail = await refreshLeagueRosters();
  assert.equal(detail.failed, 0, `must not fail: ${JSON.stringify(detail)}`);

  const updated = row('SELECT name, payload, connection_status FROM leagues WHERE id = ?', leagueId);
  assert.equal(updated.name, 'Traded Since Last Sync', 'the league\'s own name/payload must be refreshed from the real API, not left stale');
  assert.equal(updated.connection_status, 'connected');
});

test('a per-league sync failure does not block other leagues from refreshing', async () => {
  run(`DELETE FROM leagues`);
  run(`INSERT INTO leagues (platform, league_id, season, name, payload) VALUES ('espn','111',2026,'Broken League','{}')`);
  run(`INSERT INTO leagues (platform, league_id, season, name, payload) VALUES ('espn','222',2026,'Healthy League','{}')`);

  globalThis.fetch = async url => {
    if (url.includes('111')) return { ok: false, status: 500 };
    return {
      ok: true,
      json: async () => ({ settings: { name: 'Healthy League Refreshed', rosterSettings: { lineupSlotCounts: {} } }, teams: [] })
    };
  };

  const detail = await refreshLeagueRosters();
  assert.equal(detail.leagues, 2);
  assert.equal(detail.failed, 1);

  const broken = row(`SELECT connection_status FROM leagues WHERE league_id='111'`);
  const healthy = row(`SELECT name, connection_status FROM leagues WHERE league_id='222'`);
  assert.equal(broken.connection_status, 'sync_failed');
  assert.equal(healthy.connection_status, 'connected');
  assert.equal(healthy.name, 'Healthy League Refreshed', 'the healthy league must still refresh despite the other one failing');
});
