/**
 * RL-10-2: the R&D poller/analysis pair for the ESPN zero-flip timing test
 * (rnd/loop/r10-external-espn-zero-is-the-inactive-feed.md section 6).
 *
 * Guarantees:
 *  - the poller reads only `leagues.payload` (no network call, never selects
 *    espn_s2/swid) and appends one well-formed JSONL row per rostered player;
 *  - a league with no payload, or unparseable payload, is skipped, not thrown;
 *  - two poll() calls append (never overwrite) the same day's file;
 *  - the analysis script's isFlipped fires on a sub-1 projection AND on OUT/
 *    DOUBTFUL/INJURY_RESERVE, and does not fire on a healthy nonzero projection
 *    (known-nonzero control) — a rule 8 "known-nonzero case" for a bespoke check;
 *  - flipLags finds the first flip per player and its lag against kickoff-90m,
 *    reproducing a hand-computed fixture's timing exactly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-flip-timing-'));
const DB_FILE = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_PATH = DB_FILE;
process.env.SCHEDULER_DISABLED = '1';

const { run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const Poller = await import('../scripts/rnd/espn-projection-poller.mjs');
const Analysis = await import('../scripts/rnd/espn-flip-timing-analysis.mjs');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

function stat(period, source, points, season = 2026, split = 1) {
  return { seasonId: season, scoringPeriodId: period, statSourceId: source, statSplitTypeId: split, appliedTotal: points };
}

function entry(pid, { period = 3, proj = 10, injury = 'ACTIVE' } = {}) {
  return {
    playerId: pid,
    playerPoolEntry: { id: pid, player: { id: pid, fullName: `Player ${pid}`, injuryStatus: injury, stats: [stat(period, 1, proj)] } },
  };
}

function payload({ season = 2026, period = 3, entries }) {
  return { seasonId: season, scoringPeriodId: period, teams: [{ id: 1, roster: { entries } }] };
}

// ---------------------------------------------------------------- rowsFromPayload / collectRows

test('rowsFromPayload: one row per rostered player, with projection and injury_status', () => {
  const p = payload({ entries: [entry(100, { proj: 14.2 }), entry(200, { proj: 0, injury: 'OUT' })] });
  const rows = Poller.rowsFromPayload(p, { league: 5, ts: '2026-09-27T15:10:00.000Z' });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { ts: '2026-09-27T15:10:00.000Z', source_fetched_at: null, league: 5, player_id: 100, projected_points: 14.2, injury_status: 'ACTIVE' });
  assert.deepEqual(rows[1], { ts: '2026-09-27T15:10:00.000Z', source_fetched_at: null, league: 5, player_id: 200, projected_points: 0, injury_status: 'OUT' });
});

test('rowsFromPayload: projected_points uses the shared periodPoints (round2) contract, same as league_roster_snapshots', async () => {
  const { periodPoints } = await import('../scripts/lib/espn-period-points.mjs');
  const p = payload({ entries: [entry(100, { proj: 12.345 })] });
  const [r] = Poller.rowsFromPayload(p, { league: 5, ts: 't' });
  assert.equal(r.projected_points, 12.35);
  assert.equal(r.projected_points, periodPoints([stat(3, 1, 12.345)], 2026, 3, 1));
});

test('collectRows: stamps each row with the payload fetch time (leagues.fetched_at) as ISO UTC', () => {
  const leagues = [{ id: 3, payload: JSON.stringify(payload({ entries: [entry(1)] })), fetched_at: '2026-09-27 15:02:11' }];
  const [r] = Poller.collectRows(leagues, '2026-09-27T15:10:00.000Z');
  assert.equal(r.ts, '2026-09-27T15:10:00.000Z');
  assert.equal(r.source_fetched_at, '2026-09-27T15:02:11.000Z');
});

test('rowsFromPayload: no scoring period yet is skipped, not thrown', () => {
  const rows = Poller.rowsFromPayload({ seasonId: 2026, scoringPeriodId: 0, teams: [] }, { league: 1, ts: 'x' });
  assert.deepEqual(rows, []);
});

test('collectRows: a league with no payload, and one with unparseable JSON, are both skipped', () => {
  const good = payload({ entries: [entry(1)] });
  const leagues = [
    { id: 1, payload: null },
    { id: 2, payload: 'not json' },
    { id: 3, payload: JSON.stringify(good) },
  ];
  const rows = Poller.collectRows(leagues, 'ts1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].league, 3);
});

// ---------------------------------------------------------------- poll() end-to-end

test('poll(): appends well-formed JSONL for every ESPN league with a stored payload', async () => {
  run(`INSERT INTO leagues (id, league_id, season, name, platform, payload, espn_s2, swid, fetched_at)
       VALUES (1, 'lg1', 2026, 'League One', 'espn', ?, 'SECRET_S2', 'SECRET_SWID', '2026-09-27 15:02:11')`,
  JSON.stringify(payload({ entries: [entry(100, { proj: 9 })] })));
  run(`INSERT INTO leagues (id, league_id, season, name, platform, payload)
       VALUES (2, 'lg2', 2026, 'League Two (not synced)', 'espn', NULL)`);

  const outDir = path.join(temp, 'out');
  const r1 = await Poller.poll({ outDir, now: '2026-09-27T15:10:00.000Z' });
  assert.equal(r1.count, 1);
  assert.equal(r1.leagues, 2);
  const file = path.join(outDir, '2026-09-27.jsonl');
  assert.equal(r1.file, file);

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.deepEqual(row, { ts: '2026-09-27T15:10:00.000Z', source_fetched_at: '2026-09-27T15:02:11.000Z', league: 1, player_id: 100, projected_points: 9, injury_status: 'ACTIVE' });

  // A second poll appends, it never overwrites the day's file.
  const r2 = await Poller.poll({ outDir, now: '2026-09-27T15:20:00.000Z' });
  assert.equal(r2.count, 1);
  const lines2 = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines2.length, 2);
  assert.equal(JSON.parse(lines2[1]).ts, '2026-09-27T15:20:00.000Z');
});

test('poll(): never selects or writes espn_s2/swid anywhere in the output', async () => {
  const outDir = path.join(temp, 'out-secrets');
  await Poller.poll({ outDir, now: '2026-09-27T15:30:00.000Z' });
  const file = path.join(outDir, '2026-09-27.jsonl');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('SECRET_S2'));
  assert.ok(!text.includes('SECRET_SWID'));
});

// ---------------------------------------------------------------- isFlipped / flipLags

test('isFlipped (canonical, default): sub-1 projection or a status outside player-availability ESPN_AVAILABLE', () => {
  assert.equal(Analysis.isFlipped({ projected_points: 0, injury_status: 'ACTIVE' }), true);
  assert.equal(Analysis.isFlipped({ projected_points: 0.4, injury_status: 'ACTIVE' }), true);
  assert.equal(Analysis.isFlipped({ projected_points: 8, injury_status: 'OUT' }), true);
  assert.equal(Analysis.isFlipped({ projected_points: 8, injury_status: 'INJURY_RESERVE' }), true);
  // The app's one availability producer (player-availability.js) reads DOUBTFUL as available.
  assert.equal(Analysis.isFlipped({ projected_points: 8, injury_status: 'DOUBTFUL' }), false);
});

test('isFlipped (r10, secondary): OUT/DOUBTFUL/INJURY_RESERVE, the manager-signals.js set', () => {
  assert.equal(Analysis.isFlipped({ projected_points: 8, injury_status: 'DOUBTFUL' }, 'r10'), true);
  assert.equal(Analysis.isFlipped({ projected_points: 8, injury_status: 'OUT' }, 'r10'), true);
  assert.equal(Analysis.isFlipped({ projected_points: 8, injury_status: 'QUESTIONABLE' }, 'r10'), false);
});

test('isFlipped: known-nonzero control — a healthy nonzero projection never fires', () => {
  assert.equal(Analysis.isFlipped({ projected_points: 12.4, injury_status: 'ACTIVE' }), false);
  assert.equal(Analysis.isFlipped({ projected_points: 5, injury_status: 'QUESTIONABLE' }), false);
});

test('flipLags: reproduces a hand-computed fixture exactly', () => {
  // Kickoff 18:00Z, so T-90 = 16:30:00Z.
  const kickoffs = { 100: '2026-09-27T18:00:00.000Z', 200: '2026-09-27T18:00:00.000Z', 300: '2026-09-27T18:00:00.000Z' };
  const jsonlRows = [
    // player 100: flips 10 minutes BEFORE T-90 -> lag -10
    { ts: '2026-09-27T16:10:00.000Z', player_id: 100, projected_points: 9, injury_status: 'ACTIVE' },
    { ts: '2026-09-27T16:20:00.000Z', player_id: 100, projected_points: 0.2, injury_status: 'ACTIVE' },
    { ts: '2026-09-27T16:30:00.000Z', player_id: 100, projected_points: 0, injury_status: 'OUT' },
    // player 200: flips 25 minutes AFTER T-90 -> lag +25
    { ts: '2026-09-27T16:20:00.000Z', player_id: 200, projected_points: 11, injury_status: 'QUESTIONABLE' },
    { ts: '2026-09-27T16:55:00.000Z', player_id: 200, projected_points: 0, injury_status: 'ACTIVE' },
    // player 300: never flips in the observed window
    { ts: '2026-09-27T16:10:00.000Z', player_id: 300, projected_points: 15, injury_status: 'ACTIVE' },
    { ts: '2026-09-27T17:00:00.000Z', player_id: 300, projected_points: 14.5, injury_status: 'ACTIVE' },
  ];
  const results = Analysis.flipLags(jsonlRows, kickoffs);
  assert.deepEqual(results, [
    { player_id: 100, rows_seen: 3, flipped: true, flip_ts: '2026-09-27T16:20:00.000Z', lag_minutes: -10,
      last_unflipped_ts: '2026-09-27T16:10:00.000Z', lag_lower_minutes: -20 },
    { player_id: 200, rows_seen: 2, flipped: true, flip_ts: '2026-09-27T16:55:00.000Z', lag_minutes: 25,
      last_unflipped_ts: '2026-09-27T16:20:00.000Z', lag_lower_minutes: -10 },
    { player_id: 300, rows_seen: 2, flipped: false, flip_ts: null, lag_minutes: null,
      last_unflipped_ts: '2026-09-27T17:00:00.000Z', lag_lower_minutes: null },
  ]);
  const summary = Analysis.summarize(results);
  assert.deepEqual(summary, { players_with_kickoff: 3, players_flipped: 2, flipped_at_or_before_t90: 1 });
});

test('flipLags: flip time is the payload fetch time (source_fetched_at), not the poll time', () => {
  // Hourly sync: fetched at 16:00 (healthy) and 17:00 (OUT). Polls every 10 min re-read
  // the same payload; the 16:10..16:50 polls must not move the flip earlier or later.
  const kickoffs = { 7: '2026-09-27T18:00:00.000Z' }; // T-90 = 16:30Z
  const jsonlRows = [];
  for (const m of ['00', '10', '20', '30', '40', '50']) {
    jsonlRows.push({ ts: `2026-09-27T16:${m}:00.000Z`, source_fetched_at: '2026-09-27T16:00:00.000Z', player_id: 7, projected_points: 9, injury_status: 'ACTIVE' });
  }
  jsonlRows.push({ ts: '2026-09-27T17:05:00.000Z', source_fetched_at: '2026-09-27T17:00:00.000Z', player_id: 7, projected_points: 0, injury_status: 'OUT' });
  const [r] = Analysis.flipLags(jsonlRows, kickoffs);
  assert.equal(r.flip_ts, '2026-09-27T17:00:00.000Z');
  assert.equal(r.lag_minutes, 30);
  assert.equal(r.last_unflipped_ts, '2026-09-27T16:00:00.000Z');
  assert.equal(r.lag_lower_minutes, -30);
});

test('flipLags: DOUBTFUL-only flip counts under r10 but not under the canonical definition', () => {
  const kickoffs = { 8: '2026-09-27T18:00:00.000Z' };
  const jsonlRows = [
    { ts: '2026-09-27T16:00:00.000Z', player_id: 8, projected_points: 9, injury_status: 'QUESTIONABLE' },
    { ts: '2026-09-27T16:10:00.000Z', player_id: 8, projected_points: 7, injury_status: 'DOUBTFUL' },
  ];
  assert.equal(Analysis.flipLags(jsonlRows, kickoffs)[0].flipped, false);
  assert.equal(Analysis.flipLags(jsonlRows, kickoffs, { definition: 'r10' })[0].flip_ts, '2026-09-27T16:10:00.000Z');
});

test('flipLags: a player with no kickoff entry is skipped, not counted as unflipped', () => {
  const results = Analysis.flipLags(
    [{ ts: '2026-09-27T16:00:00.000Z', player_id: 999, projected_points: 5, injury_status: 'ACTIVE' }],
    {},
  );
  assert.deepEqual(results, []);
});
