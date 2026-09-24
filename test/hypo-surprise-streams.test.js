/**
 * HYPO-01a sweep fixes (PR #277):
 *   FIX-277-2  the offer streams read E1's graded league offers (eval/e1-league.js, #246):
 *              every resolved ESPN offer priced as of its proposal (recorded or replayed
 *              P(accept)), plus the app's SENT offers only; and a roster burst never spans
 *              more than BURST_WINDOW_HOURS: a longer chain is split.
 *   FIX-277-3  the per-stream walk-forward threshold (95th percentile of surprisal on the
 *              history before each 7-day block), pre-registered.
 *   FIX-277-4  the projection_miss stream: surprisal of the actual under the served weekly
 *              range in weekly_prediction_snapshots.
 *
 * Every team id, player id and tx id below is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-hypo-streams-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
delete process.env.GRIDIRON_HYPO_ENABLED;
process.env.GRIDIRON_PROCESS_ROLE = 'test'; // a write also appends hypo.surprise events (FIX-277-6)

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { detectSurprises, listHypotheses, BURST_WINDOW_HOURS, ACCEPT_LOW } = await import('../server/services/hypo/surprise.js');
const { rangeTailP, PROJ_TAIL_P_MAX } = await import('../server/services/hypo/projection-stream.js');
const { walkForward, quantile, calibrateStreams, MIN_HISTORY } = await import('../server/services/hypo/calibrate.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const LEAGUE = 4;
const SEASON = 2026;
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount INTEGER, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT, last_seen_at TEXT,
  PRIMARY KEY (league_id, season, tx_id))`);

function reset() {
  for (const t of ['surprise_hypotheses', 'trade_outcomes', 'league_transactions_raw', 'weekly_prediction_snapshots',
    'league_roster_snapshots']) run(`DELETE FROM ${t}`);
}
const detect = () => detectSurprises({ leagueId: LEAGUE, season: SEASON, enabled: true, write: false });
const iso = (d, h = 12, m = 0) => new Date(Date.UTC(2026, 8, d, h, m)).toISOString();

function appOffer({ p, status, sent }) {
  return Number(run(`INSERT INTO trade_outcomes
    (league_id, season, source, proposer_team_id, counterparty_team_id, proposed_at, model_p_accept,
     model_p_accept_low, model_p_accept_high, model_basis, model_version, status, resolved_at, created_at, sent_at)
    VALUES (?, ?, 'app_proposed', '1', '7', ?, ?, ?, ?, 'heuristic_anchored', 'acc-test', ?, ?, ?, ?)`,
  LEAGUE, SEASON, iso(20), p, Math.max(0, p - 0.03), p + 0.03, status, iso(21), iso(20), sent ? iso(20, 12, 5) : null).lastInsertRowid);
}

let tx = 0;
/** An ESPN proposal from team `from` to team `to` on day d, answered ACCEPT or DECLINE a few hours later. */
function espnOffer(from, to, d, answer) {
  tx += 1;
  const id = `p-${tx}`;
  const items = JSON.stringify([{ type: 'TRADE', playerId: 500 + tx, fromTeamId: from, toTeamId: to },
    { type: 'TRADE', playerId: 600 + tx, fromTeamId: to, toTeamId: from }]);
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, proposed_at, team_id, items_json)
       VALUES (?, ?, ?, 'TRADE_PROPOSAL', 'EXECUTED', 'EXECUTE', ?, ?, ?)`, LEAGUE, SEASON, id, iso(d), from, items);
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, proposed_at, team_id,
       related_tx_id, items_json) VALUES (?, ?, ?, ?, 'EXECUTED', 'EXECUTE', ?, ?, ?, '[]')`,
  LEAGUE, SEASON, `a-${tx}`, answer === 'accept' ? 'TRADE_ACCEPT' : 'TRADE_DECLINE', iso(d, 18), to, id);
  return id;
}

/* ------------------------------------------------------------------ FIX-277-2: offers */

test('an unsent app row never produces a surprise; the same row sent does', () => {
  reset();
  appOffer({ p: 0.02, status: 'accepted', sent: false });
  appOffer({ p: 0.95, status: 'declined', sent: false });
  assert.deepEqual(detect().surprises, [], 'a suggestion nobody sent has no reply to be surprised by');
  const sent = appOffer({ p: 0.05, status: 'accepted', sent: true });
  const s = detect().surprises;
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].kind, s[0].evidence.trade_outcome_ids, s[0].evidence.p_basis], ['accept_low', [sent], 'recorded']);
});

test('a league offer replayed as of its proposal at a low P(accept) that was accepted is a surprise', () => {
  reset();
  // Team 9 said no to five offers, then yes to the sixth. Replayed on the production band
  // with only what was knowable then (0 accepts in 5 decisions) the sixth is priced at 2%,
  // the band's floor. (No replay lands on 0.05 exactly; the recorded case below does.)
  for (let d = 2; d <= 6; d++) espnOffer(3, 9, d, 'decline');
  const accepted = espnOffer(3, 9, 10, 'accept');
  const s = detect().surprises.filter(x => x.kind === 'accept_low');
  assert.equal(s.length, 1, JSON.stringify(detect().surprises));
  assert.equal(s[0].team_id, '9');
  assert.equal(s[0].evidence.p_basis, 'replay_anchor_only');
  assert.ok(s[0].model_p < ACCEPT_LOW, `replayed p ${s[0].model_p}`);
  assert.deepEqual(s[0].evidence.tx_ids, [accepted]);
  assert.deepEqual(s[0].evidence.trade_outcome_ids, []);
  assert.equal(s[0].evidence.prior.decisions, 5);
  assert.ok(Math.abs(s[0].surprisal + Math.log(s[0].model_p)) < 1e-12);
  // Control: an unanchored manager (fewer than 5 decisions) replays at the band's centre, no surprise.
  reset();
  espnOffer(3, 9, 2, 'decline');
  espnOffer(3, 9, 10, 'accept');
  assert.deepEqual(detect().surprises.filter(x => x.kind === 'accept_low'), []);
});

test('an observed league offer with a recorded P(accept) of 0.05 that was accepted is a surprise at p = 0.05', () => {
  reset();
  const id = Number(run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id,
      proposed_at, model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, status, espn_tx_id,
      resolved_at, created_at)
    VALUES (?, ?, 'observed', '3', '9', ?, 0.05, 0.02, 0.08, 'heuristic_anchored', 'accepted', 'obs-1', ?, ?)`, LEAGUE, SEASON, iso(10), iso(11), iso(10)).lastInsertRowid);
  const s = detect().surprises;
  assert.equal(s.length, 1);
  assert.equal(s[0].model_p, 0.05);
  assert.deepEqual([s[0].evidence.trade_outcome_ids, s[0].evidence.tx_ids], [[id], ['obs-1']]);
  // Written rows pass the evidence CHECK.
  assert.equal(detectSurprises({ leagueId: LEAGUE, season: SEASON, enabled: true }).written, 1);
});

/* ------------------------------------------------------------ FIX-277-2: burst cap */

function add(team, at) {
  tx += 1;
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, proposed_at,
       processed_at, team_id, items_json) VALUES (?, ?, ?, 'FREEAGENT', 'EXECUTED', 'EXECUTE', ?, ?, ?, ?)`,
  LEAGUE, SEASON, `tx-${tx}`, at, at, team, JSON.stringify([{ type: 'ADD', playerId: 900 + tx, toTeamId: team }]));
  return `tx-${tx}`;
}

test('a 113 h chain of moves splits into bursts of 72 h or less', () => {
  reset();
  add(8, iso(1)); add(5, iso(3));
  // Team 5: quiet, then ten separate decisions spread over 113 h (the local '10 moves in 113 h').
  const t0 = Date.UTC(2026, 8, 18, 0);
  const chain = [0, 10, 22, 35, 48, 60, 75, 88, 100, 113].map(h => add(5, new Date(t0 + h * 3_600_000).toISOString()));
  const bursts = detect().surprises.filter(x => x.kind === 'roster_burst' && x.team_id === '5');
  assert.ok(bursts.length >= 2, `one ${JSON.stringify(bursts.map(b => b.outcome))}`);
  for (const b of bursts) {
    const at = b.evidence.tx_ids.map(id => Date.parse(rows('SELECT processed_at FROM league_transactions_raw WHERE tx_id = ?', id)[0].processed_at));
    assert.ok(Math.max(...at) - Math.min(...at) <= BURST_WINDOW_HOURS * 3_600_000, `${b.outcome} spans more than 72 h`);
  }
  const all = bursts.flatMap(b => b.evidence.tx_ids);
  assert.equal(new Set(all).size, all.length, 'a move is in one burst only');
  assert.ok(all.every(id => chain.includes(id)));
  assert.equal(new Set(bursts.map(b => b.surprise_key)).size, bursts.length);
});

/* ------------------------------------------------------------ FIX-277-4: projections */

function snapshot(week, playerId, { prediction = 12, lower = 6, upper = 18, actual }) {
  run(`INSERT INTO weekly_prediction_snapshots (season, week, player_id, position, as_of, cutoff, engine_version,
       structural, prediction, lower_80, upper_80, actual, settled_at)
       VALUES (?, ?, ?, 'WR', ?, 'c', 'e-test', ?, ?, ?, ?, ?, ?)`,
  SEASON, week, playerId, iso(week * 7 - 3), prediction, prediction, lower, upper, actual, iso(week * 7));
}
function rostered(week, playerId, team) {
  run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id, player_id,
       lineup_slot_id, is_starter, on_roster, source, first_seen_at, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 1, 1, 'final', ?, ?)`, LEAGUE, SEASON, week, team, 7000 + playerId, playerId, iso(1), iso(1));
}

test('rangeTailP: the range\'s own percentiles', () => {
  const r = { prediction: 12, lower_80: 6, upper_80 : 18 };
  assert.ok(Math.abs(rangeTailP({ ...r, actual: 12 }) - 1) < 1e-6, 'the centre is not surprising');
  assert.ok(Math.abs(rangeTailP({ ...r, actual: 18 }) - 0.2) < 1e-4, 'the 90th percentile: two-sided p 0.2');
  assert.ok(Math.abs(rangeTailP({ ...r, actual: 6 }) - 0.2) < 1e-4, 'the 10th percentile: two-sided p 0.2');
  assert.equal(rangeTailP({ ...r, lower_80: 12, actual: 3 }), null, 'a range with no lower half is not usable');
  assert.equal(rangeTailP({ ...r, actual: null }), null);
});

test('projection_miss: a rostered player far outside his served range is a surprise; inside is not', () => {
  reset();
  snapshot(2, 101, { actual: 41 });        // far above
  snapshot(2, 102, { actual: 14 });        // inside
  snapshot(2, 103, { actual: 45 });        // far above, but on no roster in this league
  snapshot(2, 104, { actual: 44, lower: null, upper: null }); // no range served
  rostered(2, 101, 6); rostered(2, 102, 6); rostered(2, 104, 6);
  const r = detect();
  const s = r.surprises.filter(x => x.kind === 'projection_miss');
  assert.equal(r.projections, 'read');
  assert.equal(s.length, 1, JSON.stringify(s));
  assert.equal(s[0].team_id, '6');
  assert.deepEqual(s[0].evidence.snapshot_keys, ['2026:2:101']);
  assert.ok(s[0].model_p < PROJ_TAIL_P_MAX);
  assert.ok(Math.abs(s[0].surprisal + Math.log(s[0].model_p)) < 1e-9);
  // Behind the same flag, and the written row passes the evidence CHECK.
  assert.equal(detectSurprises({ leagueId: LEAGUE, season: SEASON, env: {} }).written, 0);
  assert.equal(detectSurprises({ leagueId: LEAGUE, season: SEASON, enabled: true }).written, 1);
  assert.equal(listHypotheses({ leagueId: LEAGUE })[0].kind, 'projection_miss');
});

test('projection_miss: no snapshots table is a stated state', () => {
  reset();
  db.exec('ALTER TABLE weekly_prediction_snapshots RENAME TO wps_hidden');
  try { assert.equal(detect().projections, 'snapshots_absent'); }
  finally { db.exec('ALTER TABLE wps_hidden RENAME TO weekly_prediction_snapshots'); }
});

/* ------------------------------------------------------------ FIX-277-3: thresholds */

test('walkForward: each block is judged by the 95th percentile of the blocks before it', () => {
  const day = d => new Date(Date.UTC(2026, 8, d)).toISOString();
  // Block 0 (days 1-7): 20 units with surprisal 1..20. Block 1: 3 units, one above the p95 of block 0.
  const units = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, at: day(1 + (i % 7)), p: Math.exp(-(i + 1)), surprisal: i + 1 }));
  units.push({ id: 'b0', at: day(9), p: Math.exp(-5), surprisal: 5 }, { id: 'b1', at: day(9), p: Math.exp(-19.5), surprisal: 19.5 },
    { id: 'b2', at: day(10), p: Math.exp(-25), surprisal: 25 });
  const w = walkForward(units);
  const threshold = quantile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95);
  assert.ok(Math.abs(threshold - 19.05) < 1e-12);
  assert.equal(w.blocks[0].threshold, null, 'block 0 has no history');
  assert.equal(w.blocks[1].threshold, threshold);
  assert.deepEqual([w.evaluated, w.flagged], [3, 2]);
  assert.deepEqual(w.flagged_units.map(u => u.id), ['b1', 'b2']);
  assert.ok(Math.abs(w.flag_rate - 2 / 3) < 1e-12);
  assert.equal(w.within_target, false);
  // Too little history: nothing is evaluated, and the rate says so instead of reading 0%.
  const short = walkForward(units.slice(0, MIN_HISTORY - 1));
  assert.deepEqual([short.evaluated, short.flag_rate, short.within_target], [0, null, null]);
});

test('calibrateStreams reports every stream with its state, read-only', () => {
  reset();
  snapshot(2, 101, { actual: 41 }); rostered(2, 101, 6);
  const before = rows('SELECT COUNT(*) AS n FROM surprise_hypotheses')[0].n;
  const c = calibrateStreams({ leagueId: LEAGUE, season: SEASON });
  assert.deepEqual(Object.keys(c.streams), ['offer', 'roster_burst', 'projection_miss']);
  assert.equal(c.streams.projection_miss.units, 1);
  assert.equal(c.streams.projection_miss.state, 'read');
  assert.deepEqual(c.rule.target, [0.035, 0.065]);
  assert.equal(rows('SELECT COUNT(*) AS n FROM surprise_hypotheses')[0].n, before);
});
