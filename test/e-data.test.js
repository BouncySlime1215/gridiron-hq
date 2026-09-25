/**
 * E-DATA (Batch D item 2): offer capture with answer pairing, first-sight P(yes) for every
 * model, and a time-stamped FantasyCalc value history.
 *
 * Pre-registration: docs/tdd/2026-09-25-e-data.tdd.md.
 * Fixtures only: made-up league 9, teams 1-4, made-up ESPN player ids.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-e-data-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const CAP = await import('../server/services/offer-capture.js');
const BLEND = await import('../server/services/p-yes-blend.js');
const PYES = await import('../server/services/p-yes.js');
const FC = await import('../server/services/fc-value.js');
const { loadDecidedOffers } = await import('../server/services/eval/decided-offers.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const L = 9;
const S = 2025;

db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);

const items = (from, to) => [
  { fromTeamId: from, toTeamId: to, playerId: 501 },
  { fromTeamId: to, toTeamId: from, playerId: 602 },
];
const ms = s => Date.parse(s);

/** One ESPN transaction object, as mTransactions2 / mPendingTransactions return it. */
const espn = o => ({ type: 'TRADE_PROPOSAL', executionType: 'EXECUTE', status: 'PENDING', isPending: true,
  scoringPeriodId: 3, teamId: 1, items: items(1, 2), ...o });

/** The same row the collector's raw upsert writes (collect-league-transactions.mjs). */
function raw(o) {
  run(`INSERT OR REPLACE INTO league_transactions_raw
       (league_id, season, tx_id, type, status, execution_type, proposed_at, processed_at,
        team_id, member_id, related_tx_id, scoring_period, bid_amount, is_pending,
        items_json, raw_json, first_seen_at, last_seen_at)
       VALUES (@league_id,@season,@tx_id,@type,@status,@execution_type,@proposed_at,@processed_at,
        @team_id,@member_id,@related_tx_id,@scoring_period,@bid_amount,@is_pending,
        @items_json,@raw_json,@first_seen_at,@last_seen_at)`, {
    league_id: L, season: S, type: 'TRADE_PROPOSAL', status: 'PENDING', execution_type: 'EXECUTE',
    processed_at: null, member_id: null, related_tx_id: null, scoring_period: 3,
    bid_amount: null, is_pending: 0, items_json: JSON.stringify(items(1, 2)), raw_json: '{}',
    first_seen_at: '2025-10-01T00:00:00Z', last_seen_at: '2025-10-01T00:00:00Z',
    ...o,
  });
}

function clear() {
  for (const t of ['league_transactions_raw', 'trade_proposal_snapshots', 'offer_first_sight']) run(`DELETE FROM ${t}`);
}

/** Settled history: team 2 answered 6 offers (5 yes), team 3 answered 6 (1 yes), before October. */
function history() {
  const out = [];
  for (let i = 0; i < 12; i++) {
    const to = i < 6 ? 2 : 3;
    const yes = i < 6 ? i < 5 : i === 6;
    const day = String(10 + i).padStart(2, '0');
    const at = `2025-09-${day}T12:00:00.000Z`;
    const ans = `2025-09-${day}T13:00:00.000Z`;
    raw({ tx_id: `h${i}`, team_id: 1, items_json: JSON.stringify(items(1, to)), proposed_at: at, first_seen_at: at });
    raw({ tx_id: `h${i}a`, type: yes ? 'TRADE_ACCEPT' : 'TRADE_DECLINE', team_id: to, related_tx_id: `h${i}`,
      proposed_at: ans, first_seen_at: ans });
    out.push(`h${i}`);
  }
  return out;
}

// ---------------------------------------------------------------- (a) capture + pairing

test('E-DATA a1: an offer seen pending keeps its terms after ESPN returns it with no items', () => {
  clear();
  const now = '2025-10-01T10:00:00.000Z';
  const first = CAP.captureOffers(db, { leagueId: L, season: S, now,
    transactions: [espn({ id: 'p1', proposedDate: ms('2025-10-01T09:58:00Z') })] });
  assert.equal(first.state, 'ok');
  assert.equal(first.captured, 1);
  assert.deepEqual(first.new_live.map(s => s.proposal_tx_id), ['p1']);
  const again = CAP.captureOffers(db, { leagueId: L, season: S, now: '2025-10-01T11:00:00.000Z',
    transactions: [espn({ id: 'p1', status: 'CANCELED', isPending: false, items: [], proposedDate: ms('2025-10-01T09:58:00Z') })] });
  assert.equal(again.captured, 0);
  assert.equal(again.new_live.length, 0);
  const s = row(`SELECT * FROM trade_proposal_snapshots WHERE proposal_tx_id = 'p1'`);
  assert.deepEqual(JSON.parse(s.items_json), items(1, 2));
  assert.equal(s.captured_from, 'pending');
  assert.equal(s.captured_at, now);
  assert.equal(s.proposer_team_id, 1);
  assert.equal(String(s.counterparty_team_id), '2');
  assert.equal(s.last_seen_at, '2025-10-01T11:00:00.000Z');
});

test('E-DATA a2: an answer whose raw proposal row is gone still pairs through the snapshot', () => {
  clear();
  CAP.captureOffers(db, { leagueId: L, season: S, now: '2025-10-02T10:00:00.000Z',
    transactions: [espn({ id: 'p2', proposedDate: ms('2025-10-02T09:55:00Z') })] });
  // The raw table holds only the answer and the proposer-side close: the proposal row itself was
  // never stored (the gap #247 measured: 38 of 82 decided offers).
  raw({ tx_id: 'p2d', type: 'TRADE_DECLINE', team_id: 2, related_tx_id: 'p2', proposed_at: '2025-10-02T10:20:00.000Z',
    first_seen_at: '2025-10-02T10:22:00.000Z' });
  const built = loadDecidedOffers(db);
  const offer = built.offers.find(o => o.espn_tx_id === 'p2');
  assert.ok(offer, 'the decline pairs with its proposal');
  assert.equal(offer.proposal_basis, 'snapshot');
  assert.equal(offer.y, 0);
  assert.equal(built.orphans.length, 0);
  const rep = CAP.offerCaptureReport(db, { since: '2025-10-01T00:00:00.000Z' });
  assert.equal(rep.pooled.orphans, 0);
  assert.equal(rep.pooled.decided, 1);
  assert.equal(rep.pooled.orphan_rate, 0);
});

test('E-DATA a3: the orphan report counts an answer with no proposal and no snapshot', () => {
  clear();
  raw({ tx_id: 'x1a', type: 'TRADE_ACCEPT', team_id: 2, related_tx_id: 'x1', proposed_at: '2025-10-03T10:00:00.000Z',
    items_json: '[]', first_seen_at: '2025-10-03T10:05:00.000Z' });
  raw({ tx_id: 'x0', team_id: 1, proposed_at: '2025-10-03T08:00:00.000Z', first_seen_at: '2025-10-03T08:01:00.000Z' });
  raw({ tx_id: 'x0d', type: 'TRADE_DECLINE', team_id: 2, related_tx_id: 'x0', proposed_at: '2025-10-03T09:00:00.000Z',
    first_seen_at: '2025-10-03T09:01:00.000Z' });
  // An answer collected before `since` does not count toward the watcher's bar.
  raw({ tx_id: 'old1a', type: 'TRADE_ACCEPT', team_id: 2, related_tx_id: 'old1', proposed_at: '2025-09-20T10:00:00.000Z',
    items_json: '[]', first_seen_at: '2025-09-20T10:05:00.000Z' });
  const rep = CAP.offerCaptureReport(db, { since: '2025-10-01T00:00:00.000Z' });
  assert.equal(rep.pooled.decided, 1);
  assert.equal(rep.pooled.orphans, 1);
  assert.equal(rep.pooled.orphan_rate, 0.5);
  assert.equal(rep.by_league[String(L)].orphan_rate, 0.5);
  assert.equal(rep.bar, 0.1);
  assert.equal(rep.pass, false);
});

test('E-DATA a4: raw proposal rows written before the table existed are backfilled, never as live first sight', () => {
  clear();
  raw({ tx_id: 'b1', proposed_at: '2025-09-01T10:00:00.000Z' });
  raw({ tx_id: 'b2', items_json: '[]', proposed_at: '2025-09-01T10:00:00.000Z' });
  const r = CAP.backfillSnapshots(db, { leagueId: L, season: S, now: '2025-10-04T00:00:00.000Z' });
  assert.equal(r.backfilled, 1);
  assert.equal(row(`SELECT captured_from FROM trade_proposal_snapshots WHERE proposal_tx_id = 'b1'`).captured_from, 'raw_backfill');
  assert.equal(row(`SELECT COUNT(*) AS n FROM trade_proposal_snapshots WHERE proposal_tx_id = 'b2'`).n, 0);
  assert.equal(row(`SELECT COUNT(*) AS n FROM offer_first_sight`).n, 0);
  assert.equal(CAP.backfillSnapshots(db, { leagueId: L, season: S, now: '2025-10-05T00:00:00.000Z' }).backfilled, 0);
});

test('E-DATA a5: a close record (TRADE_PROPOSAL / CANCEL) and non-trade rows are not offers', () => {
  clear();
  const r = CAP.captureOffers(db, { leagueId: L, season: S, now: '2025-10-06T00:00:00.000Z', transactions: [
    espn({ id: 'c1', executionType: 'CANCEL', relatedTransactionId: 'p9' }),
    { id: 'w1', type: 'WAIVER', executionType: 'EXECUTE', items: [{ toTeamId: 1, playerId: 5 }] },
  ] });
  assert.equal(r.seen, 0);
  assert.equal(row(`SELECT COUNT(*) AS n FROM trade_proposal_snapshots`).n, 0);
});

test('E-DATA a6: without migration 106 the capture says table_absent instead of failing silently', () => {
  const fake = { prepare: sql => ({ get: () => (/sqlite_master/.test(sql) ? undefined : null), all: () => [], run: () => ({ changes: 0 }) }) };
  const r = CAP.captureOffers(fake, { leagueId: L, season: S, now: '2025-10-06T00:00:00.000Z', transactions: [espn({ id: 'z' })] });
  assert.equal(r.state, 'table_absent');
  assert.match(r.reason, /106/);
});

// ---------------------------------------------------------------- (a) cadence

test('E-DATA a7: poll every 120 s in active hours (07:00-24:00 New York), 600 s otherwise; env overrides', () => {
  assert.equal(CAP.pollSeconds(new Date('2025-10-01T11:00:00Z'), {}), 120); // 07:00 EDT
  assert.equal(CAP.pollSeconds(new Date('2025-10-02T03:59:00Z'), {}), 120); // 23:59 EDT
  assert.equal(CAP.pollSeconds(new Date('2025-10-01T07:00:00Z'), {}), 600); // 03:00 EDT
  assert.equal(CAP.pollSeconds(new Date('2025-10-01T10:59:00Z'), {}), 600); // 06:59 EDT
  const env = { GRIDIRON_OFFER_WATCH_ACTIVE_SECONDS: '60', GRIDIRON_OFFER_WATCH_IDLE_SECONDS: '900',
    GRIDIRON_OFFER_WATCH_ACTIVE_HOURS: '9-17', GRIDIRON_OFFER_WATCH_TZ: 'UTC' };
  assert.equal(CAP.pollSeconds(new Date('2025-10-01T09:00:00Z'), env), 60);
  assert.equal(CAP.pollSeconds(new Date('2025-10-01T17:00:00Z'), env), 900);
  // Nonsense falls back to the defaults, never to 0 (a busy loop against ESPN).
  assert.equal(CAP.pollSeconds(new Date('2025-10-01T11:00:00Z'), { GRIDIRON_OFFER_WATCH_ACTIVE_SECONDS: '0' }), 120);
});

test('E-DATA a8: the watcher runs only on its own flag, never on GRIDIRON_PREVIEW_UNCONFIRMED', () => {
  assert.equal(CAP.offerWatchOn({}), false);
  assert.equal(CAP.offerWatchOn({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), false);
  assert.equal(CAP.offerWatchOn({ GRIDIRON_OFFER_WATCH: 'true' }), false);
  assert.equal(CAP.offerWatchOn({ GRIDIRON_OFFER_WATCH: '1' }), true);
});

test('E-DATA a9: the refresh loop starts the watcher child only with the flag', async () => {
  const LOOP = await import('../scripts/refresh-live-data.mjs');
  const calls = [];
  const spawn = (cmd, args) => { calls.push(args); return { pid: 1, on() {}, kill() {}, stdout: null, stderr: null }; };
  assert.equal(LOOP.startOfferWatch({ env: { GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, spawn, log: () => {} }), null);
  assert.equal(calls.length, 0);
  const child = LOOP.startOfferWatch({ env: { GRIDIRON_OFFER_WATCH: '1' }, spawn, log: () => {} });
  assert.ok(child);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('scripts/watch-trade-offers.mjs'));
});

// ---------------------------------------------------------------- (b) first sight

test('E-DATA b1: every offer first seen live gets one row with baseline, clone, blend and served p', () => {
  clear();
  history();
  const now = '2025-10-01T10:00:00.000Z';
  const cap = CAP.captureOffers(db, { leagueId: L, season: S, now, transactions: [
    espn({ id: 'f1', proposedDate: ms('2025-10-01T09:59:00Z'), items: items(1, 2) }),
    espn({ id: 'f2', proposedDate: ms('2025-10-01T09:59:30Z'), teamId: 4, items: items(4, 3) }),
  ] });
  const r = CAP.recordFirstSight(db, { leagueId: L, season: S, snapshots: cap.new_live, now, env: {} });
  assert.equal(r.recorded, 2);
  const f1 = row(`SELECT * FROM offer_first_sight WHERE proposal_tx_id = 'f1'`);
  const f2 = row(`SELECT * FROM offer_first_sight WHERE proposal_tx_id = 'f2'`);
  for (const f of [f1, f2]) {
    for (const k of ['p_baseline', 'p_clone', 'p_blend', 'p_served', 'w_baseline', 'w_clone']) {
      assert.ok(Number.isFinite(f[k]) && f[k] > 0 && f[k] < 1, `${f.proposal_tx_id} ${k} = ${f[k]}`);
    }
    assert.equal(f.seen_state, 'pending');
    assert.equal(f.recorded_at, now);
    assert.equal(f.reason, null);
    assert.equal(f.n_graded, 12);
    assert.ok(Math.abs(f.p_blend - (f.w_baseline * f.p_baseline + f.w_clone * f.p_clone)) < 1e-9);
    assert.equal(f.served_basis, PYES.BLEND_BASIS);
    assert.equal(f.p_served, f.p_blend);
  }
  // The yes-sayer (team 2, 5 of 6) gets a higher baseline than the no-sayer (team 3, 1 of 6).
  assert.ok(f1.p_baseline > f2.p_baseline);
  assert.equal(f1.baseline_n, 6);
  // Same numbers the served table gives for that team at that instant (one producer).
  const tbl = PYES.pYesTableFrom(loadDecidedOffers(db).offers, L, ['2'], { now: ms(now), mode: 'blend' });
  assert.ok(Math.abs(tbl.byTeam.get('2').p - f1.p_baseline) < 1e-12);
  assert.ok(Math.abs(tbl.blend.weights.clone - f1.w_clone) < 1e-12);
  // GRIDIRON_PYES_BLEND=0 records the baseline as the served p.
  clear(); history();
  const cap2 = CAP.captureOffers(db, { leagueId: L, season: S, now, transactions: [espn({ id: 'f3', proposedDate: ms('2025-10-01T09:59:00Z') })] });
  CAP.recordFirstSight(db, { leagueId: L, season: S, snapshots: cap2.new_live, now, env: { GRIDIRON_PYES_BLEND: '0' } });
  const f3 = row(`SELECT * FROM offer_first_sight WHERE proposal_tx_id = 'f3'`);
  assert.equal(f3.p_served, f3.p_baseline);
  assert.equal(f3.served_basis, PYES.PYES_BASIS);
});

test('E-DATA b2: a first-sight row is never rewritten, and later answers never reach it', () => {
  clear();
  history();
  const now = '2025-10-01T10:00:00.000Z';
  const cap = CAP.captureOffers(db, { leagueId: L, season: S, now, transactions: [espn({ id: 'g1', proposedDate: ms('2025-10-01T09:59:00Z') })] });
  CAP.recordFirstSight(db, { leagueId: L, season: S, snapshots: cap.new_live, now, env: {} });
  const before = row(`SELECT * FROM offer_first_sight WHERE proposal_tx_id = 'g1'`);
  // Team 2 declines this offer and three more; the recorder runs again on a later pass.
  raw({ tx_id: 'g1d', type: 'TRADE_DECLINE', team_id: 2, related_tx_id: 'g1', proposed_at: '2025-10-01T10:20:00.000Z', first_seen_at: '2025-10-01T10:21:00.000Z' });
  for (let i = 0; i < 3; i++) {
    raw({ tx_id: `k${i}`, team_id: 1, proposed_at: `2025-10-01T1${i + 1}:00:00.000Z` });
    raw({ tx_id: `k${i}d`, type: 'TRADE_DECLINE', team_id: 2, related_tx_id: `k${i}`, proposed_at: `2025-10-01T1${i + 1}:30:00.000Z` });
  }
  const again = CAP.recordFirstSight(db, { leagueId: L, season: S, snapshots: cap.new_live, now: '2025-10-02T00:00:00.000Z', env: {} });
  assert.equal(again.recorded, 0);
  assert.deepEqual(row(`SELECT * FROM offer_first_sight WHERE proposal_tx_id = 'g1'`), before);
});

test('E-DATA b3: an offer first seen already answered is recorded without its own answer and marked resolved', () => {
  clear();
  history();
  // Proposed and declined inside one gap: first sight is the resolved row, and its decline is collected in the same pass.
  raw({ tx_id: 'r1d', type: 'TRADE_DECLINE', team_id: 2, related_tx_id: 'r1', proposed_at: '2025-10-01T09:50:00.000Z', first_seen_at: '2025-10-01T10:00:00.000Z' });
  const now = '2025-10-01T10:00:00.000Z';
  const cap = CAP.captureOffers(db, { leagueId: L, season: S, now, transactions: [
    espn({ id: 'r1', status: 'CANCELED', isPending: false, proposedDate: ms('2025-10-01T09:40:00Z') })] });
  CAP.recordFirstSight(db, { leagueId: L, season: S, snapshots: cap.new_live, now, env: {} });
  const f = row(`SELECT * FROM offer_first_sight WHERE proposal_tx_id = 'r1'`);
  assert.equal(f.seen_state, 'resolved');
  // Its own decline is excluded: the baseline equals the one computed without it.
  const others = loadDecidedOffers(db).offers.filter(o => o.espn_tx_id !== 'r1');
  const tbl = PYES.pYesTableFrom(others, L, ['2'], { now: ms(now), mode: 'blend' });
  assert.ok(Math.abs(tbl.byTeam.get('2').p - f.p_baseline) < 1e-12);
  assert.equal(f.n_graded, 12);
});

test('E-DATA b4: an offer with no single counterparty gets a row with a typed reason, no p', () => {
  clear();
  history();
  const now = '2025-10-01T10:00:00.000Z';
  const cap = CAP.captureOffers(db, { leagueId: L, season: S, now, transactions: [
    espn({ id: 'm1', items: [...items(1, 2), { fromTeamId: 3, toTeamId: 1, playerId: 777 }] })] });
  CAP.recordFirstSight(db, { leagueId: L, season: S, snapshots: cap.new_live, now, env: {} });
  const f = row(`SELECT * FROM offer_first_sight WHERE proposal_tx_id = 'm1'`);
  assert.equal(f.reason, 'no_single_counterparty');
  assert.equal(f.p_baseline, null);
  assert.equal(f.p_served, null);
});

test('E-DATA b5: with no decided offer the served p is the clone and the row says why', () => {
  clear();
  const now = '2025-10-01T10:00:00.000Z';
  const cap = CAP.captureOffers(db, { leagueId: L, season: S, now, transactions: [espn({ id: 'e1' })] });
  CAP.recordFirstSight(db, { leagueId: L, season: S, snapshots: cap.new_live, now, env: {} });
  const f = row(`SELECT * FROM offer_first_sight WHERE proposal_tx_id = 'e1'`);
  assert.equal(f.served_basis, 'clone.accept');
  assert.equal(f.p_served, f.p_clone);
  assert.match(f.reason, /no decided offers/);
});

// ---------------------------------------------------------------- (b) forward weights

test('E-DATA b6: forward grading reads only first-sight rows seen pending, in answer order', () => {
  const offers = [
    { league_id: 9, season: 2025, espn_tx_id: 'a', y: 1, proposed_at: '2025-10-01T00:00:00Z', resolved_at: '2025-10-01T05:00:00Z' },
    { league_id: 9, season: 2025, espn_tx_id: 'b', y: 0, proposed_at: '2025-10-01T01:00:00Z', resolved_at: '2025-10-01T02:00:00Z' },
    { league_id: 9, season: 2025, espn_tx_id: 'c', y: 0, proposed_at: '2025-10-01T01:00:00Z', resolved_at: '2025-10-01T03:00:00Z' },
    { league_id: 9, season: 2025, espn_tx_id: 'd', y: 1, proposed_at: '2025-10-01T01:00:00Z', resolved_at: '2025-10-01T04:00:00Z' },
    { league_id: 9, season: 2025, espn_tx_id: 'late', y: 1, proposed_at: '2025-10-01T01:00:00Z', resolved_at: '2025-10-09T00:00:00Z' },
  ];
  const fs1 = [
    { league_id: 9, season: 2025, proposal_tx_id: 'a', seen_state: 'pending', p_baseline: 0.6, p_clone: 0.3 },
    { league_id: 9, season: 2025, proposal_tx_id: 'b', seen_state: 'pending', p_baseline: 0.4, p_clone: 0.2 },
    { league_id: 9, season: 2025, proposal_tx_id: 'c', seen_state: 'resolved', p_baseline: 0.4, p_clone: 0.2 },
    { league_id: 9, season: 2025, proposal_tx_id: 'late', seen_state: 'pending', p_baseline: 0.5, p_clone: 0.5 },
  ];
  const g = BLEND.forwardGraded(offers, fs1, { now: Date.parse('2025-10-02T00:00:00Z') });
  assert.deepEqual(g.map(x => [x.p.baseline, x.p.clone, x.y]), [[0.4, 0.2, 0], [0.6, 0.3, 1]]);
  const st = BLEND.blendState(offers, 9, { now: Date.parse('2025-10-02T00:00:00Z'), graded: g });
  assert.equal(st.pooled.n, 2);
  assert.equal(st.forward, true);
});

test('E-DATA b7: GRIDIRON_PYES_FORWARD is its own flag; off, the served table is unchanged', () => {
  assert.equal(BLEND.forwardOn({}), false);
  assert.equal(BLEND.forwardOn({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), false);
  assert.equal(BLEND.forwardOn({ GRIDIRON_PYES_FORWARD: '1' }), true);
  clear();
  history();
  const off = PYES.pYesTable(db, L, ['2', '3'], { now: ms('2025-10-01T10:00:00Z'), mode: 'blend', env: {} });
  const plain = PYES.pYesTable(db, L, ['2', '3'], { now: ms('2025-10-01T10:00:00Z'), mode: 'blend' });
  assert.deepEqual(PYES.pYesBasis(off), PYES.pYesBasis(plain));
  assert.equal(off.blend.forward, undefined);
  // On, with no first-sight row graded yet, the weights sit at the prior and the basis says forward.
  const on = PYES.pYesTable(db, L, ['2', '3'], { now: ms('2025-10-01T10:00:00Z'), mode: 'blend', env: { GRIDIRON_PYES_FORWARD: '1' } });
  assert.equal(on.blend.forward, true);
  assert.equal(on.blend.pooled.n, 0);
  assert.equal(PYES.pYesBasis(on).forward, true);
});

// ---------------------------------------------------------------- (c) FantasyCalc history

test('E-DATA c1: every FantasyCalc capture is a time-stamped row; as-of reads the value in force', () => {
  run(`INSERT OR IGNORE INTO players (id, name, position) VALUES (90001, 'Test Runner', 'RB'), (90002, 'Test Catcher', 'WR')`);
  run(`DELETE FROM fc_value_history`);
  assert.equal(FC.fcValuesAsOf({ rows }, '2025-10-01T00:00:00Z').status, 'empty');
  const cap = (at, vals) => FC.recordFcCapture({ run }, at, vals);
  cap('2025-10-01 08:00:00', [[90001, 'fc_value', 5000], [90002, 'fc_value', 3000], [90001, 'fc_trend30', 120]]);
  cap('2025-10-01 20:00:00', [[90001, 'fc_value', 5200], [90002, 'fc_value', 3000]]);
  cap('2025-10-01 20:00:00', [[90001, 'fc_value', 9999]]); // same instant twice: first write wins
  assert.equal(row(`SELECT COUNT(*) AS n FROM fc_value_history WHERE player_id = 90001 AND source = 'fc_value'`).n, 2);
  const noon = FC.fcValuesAsOf({ rows }, '2025-10-01T12:00:00Z');
  assert.equal(noon.status, 'ok');
  assert.equal(FC.fcValueOf(noon, 90001), 5000);
  assert.equal(noon.captured_at, '2025-10-01 08:00:00');
  const night = FC.fcValuesAsOf({ rows }, new Date('2025-10-01T21:00:00Z'));
  assert.equal(FC.fcValueOf(night, 90001), 5200);
  assert.equal(FC.fcValueOf(night, 90002), 3000);
  assert.equal(FC.fcValuesAsOf({ rows }, '2025-09-30T00:00:00Z').status, 'empty');
  assert.deepEqual(FC.fcValueHistory({ rows }, 90001).map(r => [r.captured_at, r.value]),
    [['2025-10-01 08:00:00', 5000], ['2025-10-01 20:00:00', 5200]]);
  assert.deepEqual(FC.fcValueHistory({ rows }, 90001, { source: 'fc_trend30' }).map(r => r.value), [120]);
  assert.equal(FC.fcValuesAsOf({ rows: () => [] }, '2025-10-01T12:00:00Z').status, 'table_absent');
});

test('E-DATA c2: syncFantasyCalc writes player_metrics and the history from one response, one stamp', async (t) => {
  run(`DELETE FROM fc_value_history`);
  run(`INSERT OR IGNORE INTO players (id, name, position, sleeper_id) VALUES (90003, 'Test Mover', 'WR', 'slp-90003')`);
  run(`UPDATE players SET sleeper_id = 'slp-90003' WHERE id = 90003`);
  const body = [{ player: { sleeperId: 'slp-90003', name: 'Test Mover', position: 'WR' }, redraftValue: 4100, trend30Day: -50, maybeAdp: 40.5 }];
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), { status: 200 }));
  const { syncFantasyCalc } = await import('../server/routes/aggregates.js');
  await syncFantasyCalc();
  await syncFantasyCalc();
  const hist = rows(`SELECT source, value, captured_at FROM fc_value_history WHERE player_id = 90003 ORDER BY source, captured_at`);
  assert.ok(hist.length >= 3);
  const pm = rows(`SELECT source, value, fetched_at FROM player_metrics WHERE player_id = 90003 AND source IN ('fc_value','fc_trend30','fc_adp') ORDER BY source`);
  assert.equal(pm.length, 3);
  const latest = hist.filter(h => h.source === 'fc_value').at(-1);
  const served = pm.find(p => p.source === 'fc_value');
  assert.equal(latest.value, 4100);
  assert.equal(latest.captured_at, served.fetched_at);
  // fcValues (Nick's rules) reads player_metrics exactly as before.
  assert.equal(FC.fcValueOf(FC.fcValues({ rows }), 90003), 4100);
});

test('E-DATA a10: one watcher pass runs the collector and reports its offers line, never a cookie', async () => {
  const W = await import('../scripts/watch-trade-offers.mjs');
  const logs = [];
  const spawn = (cmd, args) => {
    assert.ok(args.includes('scripts/collect-league-transactions.mjs'));
    return { status: 0, stdout: 'league 9 X: 3 in window, 1 new, 40 stored\nleague 9: offers 1 captured / 2 seen; 0 backfilled; first sight 1 recorded\nespn_s2=secret\ntransactions: seen 3, new 1, failed 0\n', stderr: '' };
  };
  const r = W.watchOnce({ spawn, log: l => logs.push(l) });
  assert.equal(r.ok, true);
  assert.match(logs[0], /offer_watch\s+ok transactions: seen 3, new 1, failed 0 \| offers 1 captured \/ 2 seen/);
  assert.doesNotMatch(logs.join('\n'), /secret/);
  const bad = W.watchOnce({ spawn: () => ({ status: 0, stdout: 'transactions: seen 0, new 0, failed 2\n', stderr: '' }), log: l => logs.push(l) });
  assert.equal(bad.ok, false);
});
