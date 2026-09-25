/**
 * #409 review findings 1 and 3, fixed on integration-9:
 *  1. A proposal its proposer withdrew is 'withdrawn' (trade_outcomes CHECK widened by the
 *     preflight repair on an existing DB, by migration 105 on a fresh one), never 'expired':
 *     Coach reads Nick's 'expired' rows as the other manager's silence, E2 as a "no".
 *  3. An offer Nick sent from the app is one reply in Coach, not two (app row + observed copy).
 * Fixtures only: made-up teams and player ids.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ledger-withdrawn-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { settleOfferLoop, outcomesFor } = await import('../server/services/trade-outcomes.js');
const { readReplies } = await import('../server/services/coach/brief-inputs.js');
const { allowsWithdrawn } = await import('../server/db/trade-outcomes-withdrawn.js');
const { planPreflightRepairs, applyPreflightRepairs, TRADE_OUTCOMES_WITHDRAWN_REPAIR, TRADE_OUTCOMES_SCREENSHOT_REPAIR } = await import('../server/db/preflight.js');
const M067 = await import('../server/migrations/067_outcome_ledgers.js');
const M080 = await import('../server/migrations/080_trade_outcomes_offer_loop.js');
const M105 = await import('../server/migrations/105_trade_outcomes_withdrawn.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
const raw_db = db.db ?? db;

test('a fresh database ends with withdrawn allowed (migration 105)', () => {
  assert.equal(allowsWithdrawn(raw_db), true);
});

test('an existing database with child rows is widened by the preflight repair, rows and children intact', () => {
  const d = new DatabaseSync(':memory:');
  d.exec('PRAGMA foreign_keys = ON');
  M067.up(d); M080.up(d);
  d.exec(`CREATE TABLE child (id INTEGER PRIMARY KEY, trade_outcome_id INTEGER NOT NULL REFERENCES trade_outcomes(id))`);
  d.exec(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, status, espn_tx_id, created_at)
          VALUES (1, 2026, 'observed', '1', '2', 'expired', 'tx-1', 'x'), (1, 2026, 'observed', '1', '3', 'declined', 'tx-2', 'x')`);
  d.exec(`INSERT INTO child VALUES (1, 1), (2, 2)`);
  // Inside a migration's transaction the rebuild cannot run with child rows: 105 leaves it for preflight.
  d.exec('BEGIN IMMEDIATE'); M105.up(d); d.exec('COMMIT');
  assert.equal(allowsWithdrawn(d), false);
  assert.throws(() => d.exec(`UPDATE trade_outcomes SET status = 'withdrawn' WHERE id = 1`), /CHECK/);
  const plan = planPreflightRepairs(d);
  // A database at 067 also predates 107's 'observed_screenshot' source: both widenings are planned, in order.
  assert.deepEqual(plan.map(r => r.name), [TRADE_OUTCOMES_WITHDRAWN_REPAIR, TRADE_OUTCOMES_SCREENSHOT_REPAIR]);
  applyPreflightRepairs(d, plan);
  assert.equal(allowsWithdrawn(d), true);
  assert.equal(d.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign keys restored');
  assert.deepEqual(d.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM child').get().n, 2);
  assert.deepEqual(d.prepare('SELECT id, status, espn_tx_id FROM trade_outcomes ORDER BY id').all().map(r => ({ ...r })),
    [{ id: 1, status: 'expired', espn_tx_id: 'tx-1' }, { id: 2, status: 'declined', espn_tx_id: 'tx-2' }]);
  const idx = d.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'trade_outcomes' AND sql IS NOT NULL`).all().map(r => r.name);
  assert.ok(idx.includes('idx_trade_outcomes_espn') && idx.includes('idx_trade_outcomes_matched_tx'), idx.join(','));
  d.exec(`UPDATE trade_outcomes SET status = 'withdrawn' WHERE id = 1`);
  assert.deepEqual(planPreflightRepairs(d), [], 'idempotent: nothing left to repair');
});

const L = 11, S = 2025;
raw_db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);
const items = (from, to, a = 501, b = 602) => JSON.stringify([
  { fromTeamId: from, toTeamId: to, playerId: a }, { fromTeamId: to, toTeamId: from, playerId: b }]);
function raw(o) {
  run(`INSERT OR REPLACE INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, proposed_at,
       team_id, member_id, related_tx_id, items_json, raw_json, first_seen_at, last_seen_at)
       VALUES (@league_id,@season,@tx_id,@type,@status,@execution_type,@proposed_at,@team_id,@member_id,@related_tx_id,
       @items_json,'{}','2025-10-01T00:00:00Z','2025-10-20T00:00:00Z')`, {
    league_id: L, season: S, type: 'TRADE_PROPOSAL', status: 'PENDING', execution_type: 'EXECUTE', member_id: null,
    related_tx_id: null, items_json: items(1, 2), ...o });
}
const window = { leagueId: L, me: '1', since: '2025-09-01T00:00:00Z', until: '2025-11-01T00:00:00Z' };

test('Nick withdrawing his own offer is not a reply: Coach reads no silence from it', () => {
  raw({ tx_id: 'p-wd', team_id: 1, proposed_at: '2025-10-03T14:00:00Z' });
  raw({ tx_id: 'c-wd', execution_type: 'CANCEL', status: 'CANCELED', team_id: 1, member_id: 'member-x',
    related_tx_id: 'p-wd', proposed_at: '2025-10-03T20:00:00Z' });
  settleOfferLoop(L, S);
  assert.equal(outcomesFor(L, S).find(o => o.espn_tx_id === 'p-wd').status, 'withdrawn');
  const r = readReplies(raw_db, window);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.rows, [], 'no "he ignored you" from Nick\'s own take-back');
});

test('an app-sent offer withdrawn on ESPN settles withdrawn too, not expired', () => {
  raw({ tx_id: 'p-app-wd', team_id: 1, proposed_at: '2025-10-05T10:05:00Z', items_json: items(1, 3, 701, 702) });
  raw({ tx_id: 'c-app-wd', execution_type: 'CANCEL', status: 'CANCELED', team_id: 1, member_id: 'member-x',
    related_tx_id: 'p-app-wd', proposed_at: '2025-10-05T18:00:00Z' });
  run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json,
       proposed_at, model_p_accept, model_basis, status, idea_id, created_at, sent_at)
       VALUES (?, ?, 'app_proposed', '1', '3', ?, ?, '2025-10-05T10:00:00Z', 0.4, 'heuristic_anchored', 'proposed', 'idea-wd', 'x',
       '2025-10-05T10:00:00Z')`, L, S, JSON.stringify([{ espn_id: 701 }]), JSON.stringify([{ espn_id: 702 }]));
  settleOfferLoop(L, S);
  const app = outcomesFor(L, S).find(o => o.idea_id === 'idea-wd');
  assert.equal(app.matched_tx_id, 'p-app-wd', 'matched to his ESPN proposal');
  assert.equal(app.status, 'withdrawn');
  assert.deepEqual(readReplies(raw_db, window).rows, []);
});

test('an app-sent offer that was answered is ONE reply in Coach, not two', () => {
  raw({ tx_id: 'p-app', team_id: 1, proposed_at: '2025-10-07T10:05:00Z', items_json: items(1, 2, 801, 802) });
  raw({ tx_id: 'd-app', type: 'TRADE_DECLINE', team_id: 2, related_tx_id: 'p-app', proposed_at: '2025-10-07T12:00:00Z' });
  run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json,
       proposed_at, model_p_accept, model_basis, status, idea_id, created_at, sent_at)
       VALUES (?, ?, 'app_proposed', '1', '2', ?, ?, '2025-10-07T10:00:00Z', 0.4, 'heuristic_anchored', 'proposed', 'idea-app', 'x',
       '2025-10-07T10:00:00Z')`, L, S, JSON.stringify([{ espn_id: 801 }]), JSON.stringify([{ espn_id: 802 }]));
  settleOfferLoop(L, S);
  const both = outcomesFor(L, S).filter(o => o.idea_id === 'idea-app' || o.espn_tx_id === 'p-app');
  assert.deepEqual(both.map(o => [o.source, o.status]).sort(), [['app_proposed', 'declined'], ['observed', 'declined']]);
  const rows = readReplies(raw_db, window).rows;
  assert.deepEqual(rows.map(r => [r.team, r.reply]), [['2', 'decline']]);
});
