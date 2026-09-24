#!/usr/bin/env node
/**
 * EA-02 "Measured: cheap-producer tick time", on a synthetic in-season volume (no real data):
 * 5 leagues x 12 teams x 16 rostered players over 3 scoring periods, four seasons of lines
 * (272 games a season), 1,500 injury lines and 500 transactions. Builds a fresh database in
 * a temp directory, runs the first tick (the backfill pass), then N steady ticks with
 * nothing changed and one tick after one injury changes, and prints per-producer and
 * whole-tick milliseconds as JSON (median of the steady ticks).
 *
 * Usage: node scripts/engine-daemon-bench.mjs [--ticks 5]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const i = process.argv.indexOf('--ticks');
const N = i > -1 ? Number(process.argv[i + 1]) || 5 : 5;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-engine-bench-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'bench.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_PROCESS_ROLE = 'script';
process.env.GRIDIRON_ENGINE_LOCK = path.join(temp, 'engine.lock');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { runTick } = await import('../server/services/engine/daemon/tick.js');
const { buildDag } = await import('../server/services/engine/daemon/dag.js');
const { daemonProducers } = await import('../server/services/engine/producers/index.js');

db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL, type TEXT, status TEXT, execution_type TEXT,
  proposed_at TEXT, processed_at TEXT, team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);
const TEAMS = Array.from({ length: 32 }, (_, k) => `T${String.fromCharCode(65 + (k % 26))}${String.fromCharCode(65 + Math.floor(k / 26))}`);
db.exec('BEGIN');
let pid = 100000;
for (let l = 1; l <= 5; l += 1) {
  for (let t = 1; t <= 12; t += 1) {
    for (let s = 0; s < 16; s += 1) {
      pid += 1;
      run(`INSERT INTO players (id, name, position, espn_id, gsis_id) VALUES (?, 'Bench', 'RB', ?, ?)`, pid, pid, `00-${pid}`);
      for (let period = 1; period <= 3; period += 1) {
        run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id, player_id, player_name,
            position, lineup_slot_id, lineup_slot, is_starter, on_roster, source, first_seen_at, changed_at)
            VALUES (?, 2026, ?, ?, ?, ?, 'Bench', 'RB', 2, 'RB', 1, 1, ?, '2026-09-20T10:00:00Z', '2026-09-20T10:00:00Z')`,
        900 + l, period, t, pid, pid, period === 3 ? 'live' : 'final');
      }
    }
  }
}
for (let season = 2023; season <= 2026; season += 1) {
  for (let week = 1; week <= 17; week += 1) {
    for (let g = 0; g < 16; g += 1) {
      const home = TEAMS[(g * 2 + week) % 32]; const away = TEAMS[(g * 2 + 1 + week) % 32];
      const day = new Date(Date.UTC(season, 8, 7 + week * 7)).toISOString().slice(0, 10);
      const final = season < 2026 || week < 3 ? 20 : null;
      for (const [team, opp, isHome, spread] of [[home, away, 1, -3], [away, home, 0, 3]]) {
        run(`INSERT OR IGNORE INTO game_lines (season, week, team, opponent, home, spread, total, source, fetched_at, gameday, gametime, team_score)
            VALUES (?, ?, ?, ?, ?, ?, 45.5, 'bench', '2026-09-18 12:00:00', ?, '13:00', ?)`, season, week, team, opp, isHome, spread, day, final);
      }
    }
  }
}
for (let k = 0; k < 1500; k += 1) {
  run(`INSERT OR IGNORE INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status, practice_status, injury, modified_at)
      VALUES (2026, ?, ?, 'TA', 'Bench', 'RB', 'Questionable', 'Limited', 'Ankle', '2026-09-19T20:00:00Z')`, 1 + (k % 3), `00-${100001 + k}`);
}
for (let k = 0; k < 500; k += 1) {
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, proposed_at, processed_at, team_id, scoring_period,
      items_json, first_seen_at, last_seen_at) VALUES (?, 2026, ?, 'FREEAGENT', 'EXECUTED', '2026-09-16T07:00:00Z', '2026-09-16T07:00:01Z',
      1, 3, '[]', '2026-09-17T21:00:00Z', '2026-09-17T21:00:00Z')`, 901 + (k % 5), `b-${k}`);
}
run(`INSERT INTO gamescript_model (target, b0, b_spread, b_total, r2, n, fitted_at) VALUES
    ('pass_att', 20, 0.6, 0.35, 0.3, 500, '2026-09-01'), ('rush_att', 30, -0.7, 0.05, 0.2, 500, '2026-09-01')`);
db.exec('COMMIT');

const dag = buildDag(daemonProducers()).order;
const noBeat = () => {};
const perProducer = t => Object.fromEntries(t.runs.map(r => [r.producer, { ms: r.ms, written: r.written, unchanged: r.unchanged }]));
const first = await runTick({ database: db, dag, heartbeat: noBeat });
const steady = [];
for (let k = 0; k < N; k += 1) steady.push(await runTick({ database: db, dag, heartbeat: noBeat }));
run(`UPDATE nfl_injuries SET report_status = 'Out', modified_at = '2026-09-21T20:00:00Z' WHERE gsis_id = '00-100003' AND week = 3`);
const changed = await runTick({ database: db, dag, heartbeat: noBeat });
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const cheapMs = t => t.runs.reduce((a, r) => a + r.ms, 0);
console.log(JSON.stringify({
  node: process.version,
  volume: { events: db.prepare('SELECT COUNT(*) AS n FROM engine_events').get().n,
    state_rows: db.prepare('SELECT COUNT(*) AS n FROM engine_state').get().n },
  first_tick: { ms: first.ms, events: first.events, cheap_producers_ms: cheapMs(first), producers: perProducer(first) },
  steady_ticks: { n: N, median_ms: median(steady.map(t => t.ms)), median_cheap_producers_ms: median(steady.map(cheapMs)),
    max_cheap_producers_ms: Math.max(...steady.map(cheapMs)), producers_last: perProducer(steady.at(-1)),
    rows_written: steady.reduce((a, t) => a + t.runs.reduce((b, r) => b + r.written, 0), 0),
    snapshots: steady.reduce((a, t) => a + t.snapshots.length, 0) },
  one_injury_tick: { ms: changed.ms, events: changed.events, cheap_producers_ms: cheapMs(changed), snapshots: changed.snapshots.length },
}, null, 2));
db.close();
fs.rmSync(temp, { recursive: true, force: true });
