/**
 * HYPO-01a surprise detector: an outcome the model did not expect becomes a
 * hypothesis row for Jev / R&D to test, carrying the ids of the evidence.
 *
 * Three surprise kinds, exactly as the unit states them:
 *   - accept_low     an offer we gave P(accept) < 10% was accepted
 *   - decline_high   an offer we gave P(accept) > 70% was declined
 *   - roster_burst   a team made a sudden run of roster moves (adds + trades)
 *                    far above its own base rate
 *
 * Every team id, player id and tx id below is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-hypo-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
delete process.env.GRIDIRON_HYPO_ENABLED;

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const hypo = await import('../server/services/hypo/surprise.js');
const { detectSurprises, hypoEnabled, listHypotheses, poissonTail, DETECTOR_VERSION } = hypo;

const LEAGUE = 4;
const SEASON = 2026;

// The collector creates this table by hand (scripts/collect-league-transactions.mjs:21).
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount INTEGER, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT, last_seen_at TEXT,
  PRIMARY KEY (league_id, season, tx_id))`);

function reset() {
  run('DELETE FROM surprise_hypotheses');
  run('DELETE FROM trade_outcomes');
  run('DELETE FROM league_transactions_raw');
}

let idea = 0;
function proposed({ p, status, counterparty = '7', low = null, high = null }) {
  idea += 1;
  const r = run(`INSERT INTO trade_outcomes
    (league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json,
     proposed_at, model_p_accept, model_p_accept_low, model_p_accept_high, model_basis,
     model_version, status, idea_id, resolved_at, created_at)
    VALUES (?, ?, 'app_proposed', '1', ?, '[101]', '[202]', '2026-09-20T12:00:00.000Z', ?, ?, ?,
            'heuristic_anchored', 'acc-test', ?, ?, ?, '2026-09-20T12:00:00.000Z')`,
  LEAGUE, SEASON, counterparty, p, low ?? Math.max(0, p - 0.05), high ?? Math.min(1, p + 0.05),
  status, `idea-${idea}`, status === 'proposed' ? null : '2026-09-21T12:00:00.000Z');
  return Number(r.lastInsertRowid);
}

let tx = 0;
function add(team, at, type = 'FREEAGENT') {
  tx += 1;
  run(`INSERT INTO league_transactions_raw
    (league_id, season, tx_id, type, status, execution_type, proposed_at, processed_at, team_id,
     scoring_period, items_json)
    VALUES (?, ?, ?, ?, 'EXECUTED', 'EXECUTE', ?, ?, ?, 3, ?)`,
  LEAGUE, SEASON, `tx-${tx}`, type, at, at, team,
  JSON.stringify([{ type: 'ADD', playerId: 900 + tx, toTeamId: team, fromTeamId: 0 }]));
  return `tx-${tx}`;
}
function trade(a, b, at) {
  tx += 1;
  run(`INSERT INTO league_transactions_raw
    (league_id, season, tx_id, type, status, execution_type, proposed_at, processed_at, team_id,
     scoring_period, items_json)
    VALUES (?, ?, ?, 'TRADE_ACCEPT', 'EXECUTED', 'PROCESS', ?, ?, ?, 3, ?)`,
  LEAGUE, SEASON, `tx-${tx}`, at, at, a,
  JSON.stringify([{ type: 'TRADE', playerId: 800 + tx, fromTeamId: a, toTeamId: b },
    { type: 'TRADE', playerId: 700 + tx, fromTeamId: b, toTeamId: a }]));
  return `tx-${tx}`;
}
const day = d => new Date(Date.UTC(2026, 8, d, 12)).toISOString();
const at = (d, h) => new Date(Date.UTC(2026, 8, d, h)).toISOString();

test('off by default: the flag is GRIDIRON_HYPO_ENABLED and nothing is written without it', () => {
  reset();
  proposed({ p: 0.05, status: 'accepted' });
  assert.equal(hypoEnabled({}), false);
  assert.equal(hypoEnabled({ GRIDIRON_HYPO_ENABLED: '1' }), true);
  const r = detectSurprises({ leagueId: LEAGUE, season: SEASON, env: {} });
  assert.equal(r.enabled, false);
  assert.equal(r.written, 0);
  assert.equal(rows('SELECT * FROM surprise_hypotheses').length, 0);
});

test('accept at < 10% and decline at > 70% each write one hypothesis with the evidence ids', () => {
  reset();
  const low = proposed({ p: 0.06, status: 'accepted', counterparty: '7' });
  const high = proposed({ p: 0.82, status: 'declined', counterparty: '9' });
  proposed({ p: 0.10, status: 'accepted' }); // at the edge, not below it
  proposed({ p: 0.70, status: 'declined' }); // at the edge, not above it
  proposed({ p: 0.04, status: 'proposed' }); // unanswered: not an outcome
  proposed({ p: 0.90, status: 'accepted' }); // what the model expected

  const r = detectSurprises({ leagueId: LEAGUE, season: SEASON, enabled: true });
  assert.equal(r.enabled, true);
  assert.equal(r.written, 2);
  const got = listHypotheses({ leagueId: LEAGUE });
  assert.deepEqual(got.map(h => h.kind).sort(), ['accept_low', 'decline_high']);

  const a = got.find(h => h.kind === 'accept_low');
  assert.equal(a.team_id, '7');
  assert.equal(a.model_p, 0.06);
  assert.equal(a.outcome, 'accepted');
  assert.equal(a.status, 'open');
  assert.equal(a.detector_version, DETECTOR_VERSION);
  assert.ok(Math.abs(a.surprisal - -Math.log(0.06)) < 1e-9);
  assert.deepEqual(a.evidence.trade_outcome_ids, [low]);
  assert.ok(a.evidence.idea_ids.length === 1);
  assert.match(a.statement, /6%/);
  assert.match(a.statement, /accepted/);

  const d = got.find(h => h.kind === 'decline_high');
  assert.equal(d.team_id, '9');
  assert.ok(Math.abs(d.surprisal - -Math.log(1 - 0.82)) < 1e-9);
  assert.deepEqual(d.evidence.trade_outcome_ids, [high]);
});

test('idempotent: a second run writes nothing new', () => {
  reset();
  proposed({ p: 0.03, status: 'accepted' });
  assert.equal(detectSurprises({ leagueId: LEAGUE, season: SEASON, enabled: true }).written, 1);
  const again = detectSurprises({ leagueId: LEAGUE, season: SEASON, enabled: true });
  assert.equal(again.written, 0);
  assert.equal(again.already, 1);
  assert.equal(rows('SELECT * FROM surprise_hypotheses').length, 1);
});

test('only this league: another league\'s surprise is not read', () => {
  reset();
  proposed({ p: 0.03, status: 'accepted' });
  const r = detectSurprises({ leagueId: 5, season: SEASON, enabled: true });
  assert.equal(r.written, 0);
});

test('a sudden run of roster moves by a quiet team is a roster_burst with every tx id', () => {
  reset();
  // Coverage from the 1st; team 3 is quiet (one add on the 5th), then four moves in 48 h. The windows
  // starting at each move differ, so the one reported must be the most improbable.
  add(8, day(1));
  add(3, day(5));
  const burst = [add(3, day(20)), add(3, at(20, 18)), trade(3, 8, day(21)), add(3, day(22))];
  // Team 8 moves steadily: about one move every three days, never a burst.
  for (const d of [4, 7, 10, 13, 16, 19, 22]) add(8, day(d));

  const r = detectSurprises({ leagueId: LEAGUE, season: SEASON, enabled: true });
  const got = listHypotheses({ leagueId: LEAGUE }).filter(h => h.kind === 'roster_burst');
  assert.equal(got.length, 1, JSON.stringify(r));
  const h = got[0];
  assert.equal(h.team_id, '3');
  assert.deepEqual(h.evidence.tx_ids, burst);
  assert.equal(h.evidence.moves, 4);
  // The most improbable window: all 4 moves against 1 prior move in 19 covered days.
  assert.ok(Math.abs(h.model_p - poissonTail(4, ((1 + 0.5) / 19) * 3)) < 1e-12);
  assert.equal(h.evidence.baseline.prior_moves, 1);
  assert.ok(Math.abs(h.surprisal - -Math.log(h.model_p)) < 1e-9);
  assert.match(h.statement, /4 roster moves/);
});

test('a trade counts for both teams, but a steady team is not flagged', () => {
  reset();
  add(8, day(1));
  for (const d of [4, 5, 7, 10, 12, 13, 16, 18, 19, 21]) add(8, day(d));
  // Team 6 is quiet, then two adds and the trade: the trade is its third move.
  const burst6 = [add(6, at(20, 6)), add(6, day(20)), trade(8, 6, day(21))];
  detectSurprises({ leagueId: LEAGUE, season: SEASON, enabled: true });
  const got = listHypotheses({ leagueId: LEAGUE }).filter(h => h.kind === 'roster_burst');
  assert.deepEqual(got.map(h => h.team_id), ['6']);
  assert.deepEqual(got[0].evidence.tx_ids, burst6);
  assert.equal(got[0].evidence.trades, 1);
});

test('a waiver run is one decision: three claims processed at one instant are not a burst', () => {
  // Local run on PR #277 (league 4): '3 moves in 0 h' was flagged at p=0.000025. ESPN
  // processes a team's waiver claims in one batch at one timestamp, so counting each claim
  // as an independent Poisson event overstates the surprise.
  reset();
  add(8, day(1));
  add(3, day(5), 'WAIVER'); add(3, day(5), 'WAIVER'); // an earlier waiver run: one prior decision
  const run3 = [add(3, day(20), 'WAIVER'), add(3, day(20), 'WAIVER'), add(3, day(20), 'WAIVER')];
  const r = detectSurprises({ leagueId: LEAGUE, season: SEASON, enabled: true, write: false });
  assert.deepEqual(r.surprises.filter(x => x.team_id === '3'), [], JSON.stringify(r.surprises));
  // One more move a few hours later makes two decisions, still not three.
  add(3, at(20, 20));
  const r2 = detectSurprises({ leagueId: LEAGUE, season: SEASON, enabled: true, write: false });
  assert.deepEqual(r2.surprises.filter(x => x.team_id === '3'), []);
  // A third, separate decision makes it a burst, and the evidence still carries every tx id.
  const last = add(3, day(21));
  const r3 = detectSurprises({ leagueId: LEAGUE, season: SEASON, enabled: true, write: false });
  const b = r3.surprises.filter(x => x.team_id === '3');
  assert.equal(b.length, 1);
  assert.deepEqual(b[0].evidence.tx_ids, [...run3, `tx-${Number(last.slice(3)) - 1}`, last]);
  assert.equal(b[0].evidence.moves, 5);
  assert.equal(b[0].evidence.decisions, 3);
  assert.equal(b[0].evidence.baseline.prior_decisions, 1);
  assert.equal(b[0].evidence.baseline.prior_moves, 2);
  // p is the tail of 3 decisions (not 5 moves) against 1 prior decision (not 2) in 19 days.
  assert.ok(Math.abs(b[0].model_p - poissonTail(3, ((1 + 0.5) / 19) * 3)) < 1e-12);
});

test('moves minutes apart are one decision: a claim run processed over a few minutes is not a burst', () => {
  // Local run on PR #277 at 0e7f5e6e (v2): team 10 still showed '3 moves (3 decisions) in 0 h'.
  // The claims were not at one instant but within the same hour; ESPN processes a run of
  // claims one after another, so an exact-timestamp rule missed them.
  reset();
  add(8, day(1));
  add(3, day(5));
  const at2 = (d, h, m) => new Date(Date.UTC(2026, 8, d, h, m)).toISOString();
  add(3, at2(20, 12, 0)); add(3, at2(20, 12, 2)); add(3, at2(20, 12, 41));
  const r = detectSurprises({ leagueId: LEAGUE, season: SEASON, enabled: true, write: false });
  assert.deepEqual(r.surprises.filter(x => x.team_id === '3'), [], JSON.stringify(r.surprises));
  // Two more sessions hours apart make three decisions: a burst of 5 moves.
  add(3, at2(20, 18, 0)); add(3, at2(21, 9, 0));
  const r2 = detectSurprises({ leagueId: LEAGUE, season: SEASON, enabled: true, write: false });
  const b = r2.surprises.filter(x => x.team_id === '3');
  assert.equal(b.length, 1);
  assert.equal(b[0].evidence.moves, 5);
  assert.equal(b[0].evidence.decisions, 3);
});

test('too little history to know a base rate is reported, never silently skipped', () => {
  reset();
  add(3, at(20, 6)); add(3, day(20)); add(3, day(21));
  const r = detectSurprises({ leagueId: LEAGUE, season: SEASON, enabled: true });
  assert.equal(r.written, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /base rate/);
});

test('an absent transactions table is a stated state, not an empty success', () => {
  reset();
  db.exec('ALTER TABLE league_transactions_raw RENAME TO ltr_hidden');
  try {
    const r = detectSurprises({ leagueId: LEAGUE, season: SEASON, enabled: true });
    assert.equal(r.roster_moves, 'raw_table_absent');
  } finally {
    db.exec('ALTER TABLE ltr_hidden RENAME TO league_transactions_raw');
  }
});

test('poissonTail matches hand values', () => {
  assert.ok(Math.abs(poissonTail(1, 0.5) - (1 - Math.exp(-0.5))) < 1e-12);
  assert.ok(Math.abs(poissonTail(2, 1) - (1 - 2 * Math.exp(-1))) < 1e-12);
  assert.equal(poissonTail(0, 3), 1);
});

test('the table refuses a hypothesis with no evidence', () => {
  assert.throws(() => run(`INSERT INTO surprise_hypotheses
    (surprise_key, league_id, season, kind, model_p, surprisal, outcome, evidence_json, statement,
     detector_version, detected_at)
    VALUES ('k', 4, 2026, 'accept_low', 0.05, 3, 'accepted', '{}', 's', 'v', 'now')`));
});

test('dry run finds the surprise and writes nothing', () => {
  reset();
  proposed({ p: 0.02, status: 'accepted' });
  const r = detectSurprises({ leagueId: LEAGUE, season: SEASON, enabled: true, write: false });
  assert.equal(r.dry_run, true);
  assert.equal(r.surprises.length, 1);
  assert.equal(rows('SELECT * FROM surprise_hypotheses').length, 0);
});

test('CLI: off without the flag, writes with it, lists after', async () => {
  reset();
  proposed({ p: 0.02, status: 'accepted' });
  const { spawnSync } = await import('node:child_process');
  const cli = (env, ...args) => spawnSync(process.execPath, ['scripts/hypo-surprise.mjs', '--league', '4', ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH, GRIDIRON_DB_PATH: process.env.GRIDIRON_DB_PATH, ...env } });
  const off = cli({});
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /off \(GRIDIRON_HYPO_ENABLED is not set\)/);
  assert.equal(rows('SELECT * FROM surprise_hypotheses').length, 0);
  const on = cli({ GRIDIRON_HYPO_ENABLED: '1' });
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout, /season 2026 found 1 .* written 1/);
  const list = cli({}, '--list');
  assert.match(list.stdout, /1 open hypotheses for league 4/);
});
