import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Same isolation pattern as test/league-roster-schedule.test.js: a private
// temp database so this suite never reads the container's own data.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-league-ingest-field-contract-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations(); // adds leagues.waiver_type/faab_budget/trade_deadline/playoff_teams/playoff_week_start (migration 068)
const { syncEspnLeague, syncSleeperLeague } = await import('../server/routes/leagues.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

function insertLeague(platform, leagueId) {
  run(`INSERT INTO leagues (platform, league_id, season, name, payload) VALUES (?,?,2026,'Test League','{}')`,
    platform, leagueId);
  return row('SELECT * FROM leagues WHERE platform = ? AND league_id = ?', platform, leagueId);
}

// docs/wiring/league-ingest-field-contract.md item 2: ESPN_SLOT_NAME in
// routes/leagues.js (0/2/4/6/16/17/23 only) drops every bench and IR slot at
// the `.filter(Boolean)` on the line right after it, because it never learned
// slot ids 20 (BENCH) and 21 (IR) — even though server/services/espn-draft.js's
// SLOT_NAME already has both, and trade-engine.js already depends on that
// same map to find the IR slot (IR_SLOT_ID at trade-engine.js:2602). This is
// two independently maintained copies of the same ESPN constant with one of
// them stale, not an unknown value to look up.
test('an ESPN league\'s bench and IR lineup slots are not dropped from roster_positions', async () => {
  const lg = insertLeague('espn', '9001');
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      status: { currentMatchupPeriod: 3 },
      settings: {
        name: 'Bench Test League',
        rosterSettings: { lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 16: 1, 17: 1, 20: 6, 21: 2 } },
        scheduleSettings: { playoffTeamCount: 6 },
      },
      teams: [{ id: 1, name: 'Team A', roster: { entries: [{ id: 1 }] } }],
    }),
  });

  await syncEspnLeague(lg);

  const updated = row('SELECT roster_positions FROM leagues WHERE id = ?', lg.id);
  const rp = JSON.parse(updated.roster_positions);
  assert.equal(rp.filter(s => s === 'BENCH').length, 6, 'six BENCH slots must survive into roster_positions');
  assert.equal(rp.filter(s => s === 'IR').length, 2, 'two IR slots must survive into roster_positions');
});

// Item 6 (ESPN half): settings.scheduleSettings.playoffTeamCount is already a
// live field this codebase reads at request time (season-sim.js:198,
// trade-horizon.js's leagueSchedule()) but re-parses the payload from scratch
// on every call. Storing it at sync time is the ask; it must round-trip.
test('an ESPN league\'s playoff bracket size is stored on the row at sync time', async () => {
  const lg = insertLeague('espn', '9002');
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      status: { currentMatchupPeriod: 3 },
      settings: {
        name: 'Playoff Test League',
        rosterSettings: { lineupSlotCounts: {} },
        scheduleSettings: { playoffTeamCount: 4 },
      },
      teams: [{ id: 1, name: 'Team A', roster: { entries: [{ id: 1 }] } }],
    }),
  });

  await syncEspnLeague(lg);

  const updated = row('SELECT playoff_teams FROM leagues WHERE id = ?', lg.id);
  assert.equal(updated.playoff_teams, 4);
});

// Items 3/4/5/6 (Sleeper half): league.settings carries waiver_type,
// waiver_budget, trade_deadline, playoff_teams and playoff_week_start —
// sleeper-history.js already reads playoff_teams/playoff_week_start off this
// same object (sleeper-history.js:37,39,54), confirming the shape. None of
// these five reach leagues.* today; syncSleeperLeague only ever pulls
// scoring.rec out of scoring_settings and drops the rest of `league`.
test('a Sleeper league\'s waiver, trade-deadline and playoff settings are stored on the row', async () => {
  const lg = insertLeague('sleeper', '9003');
  globalThis.fetch = async url => {
    if (url.endsWith('/league/9003')) {
      return {
        ok: true,
        json: async () => ({
          name: 'Sleeper Test League',
          total_rosters: 10,
          scoring_settings: { rec: 1 },
          roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN'],
          settings: {
            waiver_type: 2,
            waiver_budget: 100,
            trade_deadline: 11,
            playoff_teams: 6,
            playoff_week_start: 15,
          },
        }),
      };
    }
    if (url.endsWith('/rosters')) return { ok: true, json: async () => [] };
    if (url.endsWith('/users')) return { ok: true, json: async () => [] };
    return { ok: true, json: async () => [] }; // traded_picks, drafts
  };

  await syncSleeperLeague(lg);

  const updated = row(`SELECT waiver_type, faab_budget, trade_deadline, playoff_teams, playoff_week_start
                        FROM leagues WHERE id = ?`, lg.id);
  assert.equal(updated.waiver_type, '2');
  assert.equal(updated.faab_budget, 100);
  assert.equal(updated.trade_deadline, 11);
  assert.equal(updated.playoff_teams, 6);
  assert.equal(updated.playoff_week_start, 15);
});

// Item 1: the contract's own finding — league.scoring_settings is already
// inside `payload` in full (payload = { league, ... }, and `league` is the
// raw Sleeper response), so no code change was needed here, only a test that
// says so and fails the day something narrows what goes into `payload`.
test('a Sleeper league\'s full scoring_settings survives into payload, not just the PPR flag', async () => {
  const lg = insertLeague('sleeper', '9004');
  const fullScoring = { rec: 1, pass_td: 6, rush_td: 6, rec_td: 6, bonus_rec_te: 0.5 };
  globalThis.fetch = async url => {
    if (url.endsWith('/league/9004')) {
      return { ok: true, json: async () => ({ name: 'L', total_rosters: 10, scoring_settings: fullScoring, roster_positions: [] }) };
    }
    return { ok: true, json: async () => [] };
  };

  await syncSleeperLeague(lg);

  const updated = row('SELECT payload FROM leagues WHERE id = ?', lg.id);
  assert.deepEqual(JSON.parse(updated.payload).league.scoring_settings, fullScoring,
    'the full per-stat scoring object must be readable off payload.league.scoring_settings, not reduced to the ppr flag');
});
