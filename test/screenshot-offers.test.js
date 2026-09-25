/**
 * SCREENSHOT-OFFERS: offers read off chat screenshots enter trade_outcomes as
 * 'observed_screenshot' rows, through trade-outcomes.js, never twice.
 * SYNTHETIC FIXTURES ONLY: made-up leagues, rosters and player ids; no chat data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-screenshot-offers-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run, rows } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { recordScreenshotOffer, settleScreenshotOffers, outcomesFor } = await import('../server/services/trade-outcomes.js');
const { decidedOffers, loadDecidedOffers } = await import('../server/services/eval/decided-offers.js');
const { allowsScreenshotSource } = await import('../server/db/trade-outcomes-screenshot-source.js');
const { planPreflightRepairs, applyPreflightRepairs, TRADE_OUTCOMES_SCREENSHOT_REPAIR } = await import('../server/db/preflight.js');
const { widenTradeOutcomesStatus } = await import('../server/db/trade-outcomes-withdrawn.js');
const M067 = await import('../server/migrations/067_outcome_ledgers.js');
const M080 = await import('../server/migrations/080_trade_outcomes_offer_loop.js');
const M108 = await import('../server/migrations/108_trade_outcomes_screenshot_source.js');
const { feed } = await import('../scripts/chat/feed_screenshot_offers.mjs');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const L = 21, S = 2026;
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);
const items = (from, to, a, b) => JSON.stringify([
  { fromTeamId: from, toTeamId: to, playerId: a }, { fromTeamId: to, toTeamId: from, playerId: b }]);
function raw(o) {
  run(`INSERT OR REPLACE INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, proposed_at,
       team_id, member_id, related_tx_id, items_json, raw_json, first_seen_at, last_seen_at)
       VALUES (@league_id,@season,@tx_id,@type,@status,@execution_type,@proposed_at,@team_id,@member_id,@related_tx_id,
       @items_json,'{}','2026-09-01T00:00:00Z','2026-09-24T00:00:00Z')`, {
    league_id: L, season: S, type: 'TRADE_PROPOSAL', status: 'PENDING', execution_type: 'EXECUTE', member_id: null,
    related_tx_id: null, ...o });
}
const shot = (guid, a, b, at, extra = {}) => ({
  league_id: L, season: S, attachment_guid: guid, kind: 'offer', status: 'proposed',
  proposer_team_id: 1, counterparty_team_id: 2,
  give: [{ playerId: a, fromTeamId: 1, toTeamId: 2 }], get: [{ playerId: b, fromTeamId: 2, toTeamId: 1 }],
  proposed_at: at, proposed_at_basis: 'posted_at_upper_bound', seen_at: at, confidence: 0.9, ...extra });

test('a fresh database allows the observed_screenshot source (migration 108)', () => {
  assert.equal(allowsScreenshotSource(db), true);
});

test('an existing database with child rows is widened by the preflight repair, rows, ids and children intact', () => {
  const d = new DatabaseSync(':memory:');
  d.exec('PRAGMA foreign_keys = ON');
  M067.up(d); M080.up(d); widenTradeOutcomesStatus(d);          // a database already at 105
  d.exec(`CREATE TABLE child (id INTEGER PRIMARY KEY, trade_outcome_id INTEGER NOT NULL REFERENCES trade_outcomes(id))`);
  d.exec(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, status, espn_tx_id, created_at)
          VALUES (1, 2026, 'observed', '1', '2', 'declined', 'tx-1', 'x'), (1, 2026, 'observed', '1', '3', 'accepted', 'tx-2', 'x')`);
  d.exec(`DELETE FROM trade_outcomes WHERE id = 2`);
  d.exec(`INSERT INTO child VALUES (1, 1)`);
  d.exec('BEGIN IMMEDIATE'); M108.up(d); d.exec('COMMIT');     // child rows: 108 leaves it to preflight
  assert.equal(allowsScreenshotSource(d), false);
  const plan = planPreflightRepairs(d);
  assert.deepEqual(plan.map(r => r.name), [TRADE_OUTCOMES_SCREENSHOT_REPAIR]);
  applyPreflightRepairs(d, plan);
  assert.equal(allowsScreenshotSource(d), true);
  assert.equal(d.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(d.prepare('PRAGMA foreign_key_check').all(), []);
  d.exec(`INSERT INTO trade_outcomes (league_id, season, source, status, created_at) VALUES (1, 2026, 'observed_screenshot', 'proposed', 'x')`);
  assert.equal(d.prepare(`SELECT MAX(id) AS id FROM trade_outcomes`).get().id, 3, 'AUTOINCREMENT never reuses a deleted id');
  assert.throws(() => d.exec(`INSERT INTO trade_outcomes (league_id, season, source, status, created_at) VALUES (1, 2026, 'bogus', 'proposed', 'x')`), /CHECK/);
  assert.deepEqual(planPreflightRepairs(d), [], 'idempotent');
});

test('a confident offer is recorded once, labelled honestly, with no prediction', () => {
  const r = recordScreenshotOffer(shot('g-1', 9101, 9102, '2026-09-10T15:00:00Z'));
  assert.equal(r.state, 'recorded');
  const o = outcomesFor(L, S).find(x => x.id === r.id);
  assert.equal(o.source, 'observed_screenshot');
  assert.equal(o.status, 'proposed');
  assert.equal(o.model_p_accept, null); assert.equal(o.model_basis, null);
  assert.match(o.settle_reason, /never scored when it was sent/);
  assert.match(o.settle_reason, /posted_at_upper_bound/);
  assert.equal(recordScreenshotOffer(shot('g-1', 9101, 9102, '2026-09-10T15:00:00Z')).state, 'already_recorded');
});

test('the same offer posted again settles the first row instead of adding one', () => {
  const r = recordScreenshotOffer(shot('g-1b', 9101, 9102, '2026-09-11T15:00:00Z',
    { kind: 'accepted', status: 'accepted', proposed_at: null, proposed_at_basis: 'unknown' }));
  assert.equal(r.state, 'same_offer'); assert.equal(r.settled, true);
  const all = outcomesFor(L, S).filter(o => o.source === 'observed_screenshot');
  assert.equal(all.length, 1);
  assert.equal(all[0].status, 'accepted');
  assert.equal(all[0].resolved_at, '2026-09-11T15:00:00Z');
});

test('an offer ESPN already has (same teams, players, within 72 h) is a duplicate, not a row', () => {
  raw({ tx_id: 'p-espn', team_id: 1, proposed_at: '2026-09-12T10:00:00Z', items_json: items(1, 2, 9201, 9202) });
  const r = recordScreenshotOffer(shot('g-2', 9201, 9202, '2026-09-13T20:00:00Z'));
  assert.deepEqual(r, { state: 'espn_duplicate', matched_tx_id: 'p-espn' });
  // mostly the same players (a cropped screen): still ESPN's offer
  raw({ tx_id: 'p-espn3', team_id: 1, proposed_at: '2026-09-12T11:00:00Z', items_json: JSON.stringify([
    { fromTeamId: 1, toTeamId: 2, playerId: 9211 }, { fromTeamId: 1, toTeamId: 2, playerId: 9212 },
    { fromTeamId: 2, toTeamId: 1, playerId: 9213 }]) });
  const near = recordScreenshotOffer({ ...shot('g-2b', 9211, 9213, '2026-09-12T12:00:00Z') });
  assert.deepEqual([near.state, near.matched_tx_id], ['espn_near_duplicate', 'p-espn3']);
  // other players, or outside the window: not the same offer
  assert.equal(recordScreenshotOffer(shot('g-3', 9201, 9299, '2026-09-13T20:00:00Z')).state, 'recorded');
  assert.equal(recordScreenshotOffer(shot('g-4', 9201, 9202, '2026-09-17T20:00:00Z')).state, 'recorded');
});

test('a finalize screen alone is a draft, not a sent offer; with an ESPN trace it settles', () => {
  const draft = { ...shot('g-fin', 9701, 9702, '2026-09-18T09:00:00Z'), kind: 'finalize' };
  assert.equal(recordScreenshotOffer(draft).state, 'unconfirmed_draft');
  raw({ tx_id: 'a-fin', type: 'TRADE_ACCEPT', team_id: 2, related_tx_id: 'p-fin', proposed_at: '2026-09-18T20:00:00Z',
    items_json: items(1, 2, 9701, 9702) });
  const r = recordScreenshotOffer(draft);
  assert.equal(r.state, 'recorded');
  assert.equal(outcomesFor(L, S).find(x => x.id === r.id).status, 'accepted');
});

test('an app offer Nick marked sent is the same deal: app_duplicate', () => {
  run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json,
       proposed_at, model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, status, idea_id, created_at, sent_at)
       VALUES (?, ?, 'app_proposed', '1', '3', ?, ?, '2026-09-14T10:00:00Z', 0.4, 0.3, 0.5, 'heuristic_anchored', 'proposed',
       'idea-x', 'x', '2026-09-14T10:00:00Z')`, L, S, JSON.stringify([{ espn_id: 9301 }]), JSON.stringify([{ espn_id: 9302 }]));
  const r = recordScreenshotOffer({ ...shot('g-5', 9301, 9302, '2026-09-14T18:00:00Z'), counterparty_team_id: 3 });
  assert.equal(r.state, 'app_duplicate');
});

test('an ESPN orphan answer settles the screenshot row and lends it nothing twice', () => {
  // ESPN no longer serves the proposal (p-gone); its decline is collected.
  raw({ tx_id: 'd-gone', type: 'TRADE_DECLINE', team_id: 2, related_tx_id: 'p-gone', proposed_at: '2026-09-15T12:00:00Z',
    items_json: items(1, 2, 9401, 9402) });
  const r = recordScreenshotOffer(shot('g-6', 9401, 9402, '2026-09-15T09:00:00Z'));
  assert.equal(r.state, 'recorded'); assert.equal(r.matched_tx_id, 'p-gone');
  const o = outcomesFor(L, S).find(x => x.id === r.id);
  assert.equal(o.status, 'declined'); assert.equal(o.resolved_at, '2026-09-15T12:00:00Z');
  assert.match(o.settle_reason, /TRADE_DECLINE d-gone/);
});

test('a pending screenshot row is settled later by an ESPN answer collected after it', () => {
  const r = recordScreenshotOffer(shot('g-7', 9501, 9502, '2026-09-16T09:00:00Z'));
  assert.equal(r.state, 'recorded');
  raw({ tx_id: 'a-late', type: 'TRADE_ACCEPT', team_id: 2, related_tx_id: 'p-late', proposed_at: '2026-09-17T12:00:00Z',
    items_json: items(1, 2, 9501, 9502) });
  const s = settleScreenshotOffers(L, S);
  assert.ok(s.settled >= 1);
  assert.equal(outcomesFor(L, S).find(x => x.id === r.id).status, 'accepted');
  assert.equal(settleScreenshotOffers(L, S).settled, 0, 'idempotent');
});

test('the grader counts a decided screenshot offer once, and never beside its ESPN copy', () => {
  const base = { league_id: L, season: S, model_p_accept: null, idea_id: null, resolved_at: '2026-09-20T00:00:00Z' };
  const espn = [{ league_id: L, season: S, tx_id: 'p1', type: 'TRADE_PROPOSAL', execution_type: 'EXECUTE', team_id: 1,
    related_tx_id: null, proposed_at: '2026-09-18T00:00:00Z', items_json: items(1, 2, 1, 2) },
  { league_id: L, season: S, tx_id: 'a1', type: 'TRADE_ACCEPT', execution_type: 'EXECUTE', team_id: 2,
    related_tx_id: 'p1', proposed_at: '2026-09-19T00:00:00Z', items_json: null },
  { league_id: L, season: S, tx_id: 'd9', type: 'TRADE_DECLINE', execution_type: 'EXECUTE', team_id: 4,
    related_tx_id: 'p9', proposed_at: '2026-09-19T00:00:00Z', items_json: null }];   // an orphan: no proposal, no terms
  const shotRow = (id, extra) => ({ ...base, source: 'observed_screenshot', proposer_team_id: '1', counterparty_team_id: '2',
    proposed_at: '2026-09-18T05:00:00Z', status: 'accepted', espn_tx_id: null,
    give_json: JSON.stringify([{ playerId: 1 }]), get_json: JSON.stringify([{ playerId: 2 }]), id, ...extra });
  const r = decidedOffers({ raw: espn, outcomes: [
    shotRow(1, {}),                                                          // copy of p1 by deal
    shotRow(2, { proposer_team_id: '3', counterparty_team_id: '4', status: 'declined', matched_tx_id: 'p9',
      give_json: JSON.stringify([{ playerId: 7 }]), get_json: JSON.stringify([{ playerId: 8 }]) }),  // places orphan p9
    shotRow(3, { proposer_team_id: '5', counterparty_team_id: '6', status: 'declined',
      give_json: JSON.stringify([{ playerId: 11 }]), get_json: JSON.stringify([{ playerId: 12 }]) }), // new
  ] });
  assert.deepEqual(r.offers.map(o => [o.source, o.status]).sort(),
    [['observed', 'accepted'], ['observed_screenshot', 'declined'], ['observed_screenshot', 'declined']]);
  assert.equal(r.excluded.screenshot_copy_of_espn_offer, 1);
  assert.equal(r.excluded.orphan_placed_by_screenshot, 1);
  assert.equal(r.orphans.length, 0);
});

test('feed: confident real offers go through the ledger with as-of values; review rows, hypotheticals and dupes do not', async () => {
  run(`INSERT OR REPLACE INTO leagues (id, platform, league_id, season, name, team_count, ppr, superflex) VALUES (?, 'espn', 'x', ?, 'fixture', 10, 1, 0)`, L, S);
  for (const [id, espn] of [[70001, 9601], [70002, 9602], [70003, 9603], [70004, 9604], [70005, 9201], [70006, 9202]]) {
    run(`INSERT OR REPLACE INTO players (id, name, position, espn_id) VALUES (?, ?, 'WR', ?)`, id, `Fixture ${id}`, espn);
  }
  run(`INSERT INTO dynasty_value_history (format_key, player_id, captured_on, captured_at, value, redraft_value)
       VALUES ('rd_sf1_t10_ppr1', 70001, '2026-09-19', 'x', 100, 90), ('rd_sf1_t10_ppr1', 70002, '2026-09-19', 'x', 80, 70),
              ('rd_sf1_t10_ppr1', 70001, '2026-09-22', 'x', 999, 999)`);
  const chatPath = path.join(temp, 'chat.sqlite');
  const c = new DatabaseSync(chatPath);
  c.exec(`CREATE TABLE screenshot_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, msg_id INTEGER, posted_at TEXT, source TEXT,
    attachment_guid TEXT, kind TEXT, league_id INTEGER, season INTEGER, from_roster INTEGER, to_roster INTEGER,
    give_ids TEXT, get_ids TEXT, proposed_at TEXT, proposed_at_basis TEXT, confidence REAL, needs_review INTEGER,
    matched_tx_id TEXT, ledger_state TEXT, ledger_id INTEGER)`);
  const ins = c.prepare(`INSERT INTO screenshot_trades (source, attachment_guid, kind, league_id, season, from_roster, to_roster,
    give_ids, get_ids, proposed_at, proposed_at_basis, posted_at, confidence, needs_review) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('ocr', 'f-1', 'offer', L, S, 1, 2, '[70001]', '[70002]', '2026-09-20T10:00:00Z', 'posted_at_upper_bound', '2026-09-20T10:00:00Z', 0.9, 0);
  ins.run('ocr', 'f-2', 'hypothetical', L, S, 1, 2, '[70003]', '[70004]', null, null, '2026-09-20T10:00:00Z', 0.9, 0);
  ins.run('ocr', 'f-3', 'offer', L, S, 1, 2, '[70003]', '[70004]', '2026-09-20T10:00:00Z', 'posted_at_upper_bound', '2026-09-20T10:00:00Z', 0.5, 1);
  ins.run('ocr', 'f-4', 'finalize', L, S, 1, 2, '[70005]', '[70006]', '2026-09-13T08:00:00Z', 'posted_at_upper_bound', '2026-09-13T08:00:00Z', 0.8, 0);
  ins.run('rnd_manual', null, null, null, null, null, null, null, null, null, null, '2026-09-01T00:00:00Z', 0.9, 0);
  c.close();

  const connects = [];
  const orig = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...a) { connects.push(a); return orig.apply(this, a); };
  let dry, out, again;
  try {
    const n0 = rows(`SELECT COUNT(*) AS n FROM trade_outcomes`)[0].n;
    dry = await feed({ chatDbPath: chatPath, dryRun: true });
    assert.equal(rows(`SELECT COUNT(*) AS n FROM trade_outcomes`)[0].n, n0, 'dry run writes nothing');
    out = await feed({ chatDbPath: chatPath });
    again = await feed({ chatDbPath: chatPath });
  } finally {
    net.Socket.prototype.connect = orig;
  }
  assert.deepEqual(connects, [], 'the feed opens no socket at all');
  assert.equal(dry.counts.candidates, 2);
  assert.equal(out.counts.recorded, 1);
  assert.equal(out.counts.espn_duplicate, 1);      // f-4 is ESPN's p-espn
  assert.deepEqual(out.counts.by_league, { [L]: 1 });
  assert.equal(out.counts.with_fc_values, 1);
  assert.equal(again.counts.candidates, 0, 'idempotent: nothing left to feed');
  const row = outcomesFor(L, S).find(o => o.idea_id === 'shot:f-1');
  const give = JSON.parse(row.give_json);
  assert.deepEqual([give[0].playerId, give[0].fc_value, give[0].fc_captured_on], [9601, 90, '2026-09-19'], 'as-of value, not a later one');
  const cc = new DatabaseSync(chatPath, { readOnly: true });
  assert.deepEqual(cc.prepare(`SELECT attachment_guid, ledger_state FROM screenshot_trades WHERE ledger_state IS NOT NULL ORDER BY 1`).all()
    .map(r => [r.attachment_guid, r.ledger_state]), [['f-1', 'recorded'], ['f-4', 'espn_duplicate']]);
  cc.close();
  assert.ok(out.decided_offers.after.offers >= out.decided_offers.before.offers);
  assert.ok(loadDecidedOffers(db).offers.length >= 1);
});
