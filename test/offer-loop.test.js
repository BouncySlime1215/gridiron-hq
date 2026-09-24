/**
 * CLONE-01b b1, the offer loop: "I sent this" -> a graded row.
 *
 * Every offer Nick actually sends becomes one `trade_outcomes` row with
 * `sent_at`, carrying the model's P(accept) band from the moment it was
 * suggested. A post-sync settle job then matches it to the ESPN
 * TRADE_PROPOSAL he sent (same two teams, same players, near the tap) and to
 * the reply ESPN recorded against that proposal.
 *
 * Gates, pre-registered in docs/tdd/offer-loop.tdd.md:
 *  O1 record -> matched ESPN proposal + TRADE_ACCEPT settles 'accepted' with
 *     resolved_at = the accept's stamp and matched_tx_id = the proposal.
 *  O2 same with TRADE_DECLINE -> 'declined'.
 *  O3 a counter (his TRADE_PROPOSAL pointing at ours) -> 'countered', with the
 *     counter's items in counter_json.
 *  O4 no matching ESPN proposal: 'proposed' with a reason while the window is
 *     open; 'expired' once the collector has looked N days past the tap. Never
 *     expired on no evidence (raw table absent, or collector not run since).
 *  O5 the settle job is idempotent: a second run changes nothing.
 *  O6 "I sent this" on a suggestion the slate already recorded marks THAT row
 *     sent (no duplicate, prediction untouched); a second tap is a no-op.
 *  O7 a different package between the same teams does not match.
 *  O8 no code path in the loop sends anything to ESPN.
 *
 * Every team, player and league id below is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-offer-loop-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { recordSentOffer, settleSentOffers, settleOfferLoop, recordProposalSlate, OFFER_EXPIRE_DAYS }
  = await import('../server/services/trade-outcomes.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------------- fixtures */

function createRawTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
    league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
    type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
    team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
    bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    PRIMARY KEY (league_id, season, tx_id))`);
}

const SEASON = 2026;
const T0 = Date.parse('2026-10-01T15:00:00Z');
const at = ms => new Date(T0 + ms).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

const band = { band: { low: 0.2, mid: 0.35, high: 0.5 }, basis: 'heuristic_unanchored' };
// Nick is team 1; ESPN ids on the players, as the engine's `slim` carries them.
const deal = (partnerId, giveEspn, getEspn, id = null) => ({
  id, partner_id: String(partnerId),
  i_give: [{ id: 9000 + giveEspn, name: `Give ${giveEspn}`, espn_id: giveEspn }],
  i_get: [{ id: 9000 + getEspn, name: `Get ${getEspn}`, espn_id: getEspn }],
  acceptance: band,
});
const send = (leagueId, d, sentMs = 0) => recordSentOffer({
  league_id: leagueId, season: SEASON, proposer_team_id: '1', deal: d,
  model_version: 'test-v1', sent_at: at(sentMs) });

function raw(leagueId, tx) {
  run(`INSERT INTO league_transactions_raw
         (league_id, season, tx_id, type, status, execution_type, proposed_at, team_id,
          related_tx_id, items_json, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  leagueId, SEASON, tx.tx_id, tx.type, tx.status ?? null, tx.execution_type ?? 'EXECUTE',
  tx.proposed_at, tx.team_id, tx.related_tx_id ?? null, JSON.stringify(tx.items ?? []),
  tx.seen ?? tx.proposed_at, tx.seen ?? tx.proposed_at);
}
// A two-player swap proposed by `from`: `give` leaves from, `get` arrives.
const swap = (from, to, give, get) => [
  { fromTeamId: from, toTeamId: to, playerId: give },
  { fromTeamId: to, toTeamId: from, playerId: get },
];
const ledger = (leagueId, id) => row(`SELECT * FROM trade_outcomes WHERE league_id = ? AND id = ?`, leagueId, id);

createRawTable();

/* ------------------------------------------------------------------ O1 */
test('O1: a sent offer + the matching ESPN proposal + TRADE_ACCEPT settles to accepted', () => {
  const L = 501;
  const r = send(L, deal(2, 101, 202));
  assert.equal(r.state, 'recorded');
  raw(L, { tx_id: 'p1', type: 'TRADE_PROPOSAL', team_id: 1, proposed_at: at(-5 * MIN), items: swap(1, 2, 101, 202) });
  raw(L, { tx_id: 'a1', type: 'TRADE_ACCEPT', team_id: 2, related_tx_id: 'p1', proposed_at: at(3 * HOUR) });

  const out = settleSentOffers(L, SEASON, { now: at(4 * HOUR) });
  assert.equal(out.settled, 1);
  const o = ledger(L, r.id);
  assert.equal(o.status, 'accepted');
  assert.equal(o.matched_tx_id, 'p1');
  assert.equal(o.resolved_at, at(3 * HOUR));
  assert.equal(o.source, 'app_proposed');
  assert.equal(o.model_p_accept, 0.35, 'the band recorded at send time survives settling');
});

/* ------------------------------------------------------------------ O2 */
test('O2: a TRADE_DECLINE against the matched proposal settles to declined', () => {
  const L = 502;
  const r = send(L, deal(3, 111, 222));
  raw(L, { tx_id: 'p2', type: 'TRADE_PROPOSAL', team_id: 1, proposed_at: at(-2 * MIN), items: swap(1, 3, 111, 222) });
  raw(L, { tx_id: 'd2', type: 'TRADE_DECLINE', team_id: 3, related_tx_id: 'p2', proposed_at: at(DAY) });

  settleSentOffers(L, SEASON, { now: at(2 * DAY) });
  const o = ledger(L, r.id);
  assert.equal(o.status, 'declined');
  assert.equal(o.resolved_at, at(DAY));
  assert.equal(o.matched_tx_id, 'p2');
});

/* ------------------------------------------------------------------ O3 */
test('O3: his proposal pointing back at ours settles to countered, with the counter items', () => {
  const L = 503;
  const r = send(L, deal(4, 121, 232));
  raw(L, { tx_id: 'p3', type: 'TRADE_PROPOSAL', team_id: 1, proposed_at: at(-MIN), items: swap(1, 4, 121, 232) });
  raw(L, { tx_id: 'c3', type: 'TRADE_PROPOSAL', team_id: 4, related_tx_id: 'p3', proposed_at: at(5 * HOUR),
    items: swap(4, 1, 233, 121) });

  settleSentOffers(L, SEASON, { now: at(6 * HOUR) });
  const o = ledger(L, r.id);
  assert.equal(o.status, 'countered');
  assert.equal(o.resolved_at, at(5 * HOUR));
  assert.deepEqual(JSON.parse(o.counter_json).tx_id, 'c3');
});

/* ------------------------------------------------------------------ O4 */
test('O4: no ESPN match stays proposed with a reason inside the window, then expires after N days', () => {
  const L = 504;
  const r = send(L, deal(2, 141, 242));
  // Some unrelated league activity, so the collector has visibly looked.
  raw(L, { tx_id: 'w1', type: 'WAIVER', team_id: 5, proposed_at: at(HOUR), seen: at(HOUR) });

  settleSentOffers(L, SEASON, { now: at(DAY) });
  let o = ledger(L, r.id);
  assert.equal(o.status, 'proposed');
  assert.match(o.settle_reason, /no ESPN proposal/);
  assert.equal(o.resolved_at, null);

  // Past the window by the clock, but the collector has not looked since: no evidence, no verdict.
  settleSentOffers(L, SEASON, { now: at((OFFER_EXPIRE_DAYS + 1) * DAY) });
  o = ledger(L, r.id);
  assert.equal(o.status, 'proposed', 'silence the collector never saw is not an expiry');
  assert.match(o.settle_reason, /collector/);

  // The collector has now looked past the window and still nothing matches.
  raw(L, { tx_id: 'w2', type: 'WAIVER', team_id: 5, proposed_at: at((OFFER_EXPIRE_DAYS + 1) * DAY),
    seen: at((OFFER_EXPIRE_DAYS + 1) * DAY) });
  settleSentOffers(L, SEASON, { now: at((OFFER_EXPIRE_DAYS + 1) * DAY) });
  o = ledger(L, r.id);
  assert.equal(o.status, 'expired');
  assert.ok(o.resolved_at);
  assert.match(o.settle_reason, new RegExp(`${OFFER_EXPIRE_DAYS} days`));
});

test('O4b: an ESPN CANCEL with no answer settles to expired', () => {
  const L = 505;
  const r = send(L, deal(3, 151, 252));
  raw(L, { tx_id: 'p5', type: 'TRADE_PROPOSAL', team_id: 1, proposed_at: at(-MIN), items: swap(1, 3, 151, 252) });
  raw(L, { tx_id: 'x5', type: 'TRADE_PROPOSAL', execution_type: 'CANCEL', team_id: 1, related_tx_id: 'p5',
    proposed_at: at(2 * DAY) });
  settleSentOffers(L, SEASON, { now: at(3 * DAY) });
  const o = ledger(L, r.id);
  assert.equal(o.status, 'expired');
  assert.equal(o.resolved_at, at(2 * DAY));
  assert.match(o.settle_reason, /no answer/);
});

/* ------------------------------------------------------------------ O5 */
test('O5: the settle job is idempotent', () => {
  const L = 506;
  const r = send(L, deal(2, 161, 262));
  raw(L, { tx_id: 'p6', type: 'TRADE_PROPOSAL', team_id: 1, proposed_at: at(-MIN), items: swap(1, 2, 161, 262) });
  raw(L, { tx_id: 'd6', type: 'TRADE_DECLINE', team_id: 2, related_tx_id: 'p6', proposed_at: at(HOUR) });
  const first = settleOfferLoop(L, SEASON, { now: at(2 * HOUR) });
  assert.equal(first.sent.settled, 1);
  const snap = JSON.stringify(rows(`SELECT * FROM trade_outcomes WHERE league_id = ? ORDER BY id`, L));
  const second = settleOfferLoop(L, SEASON, { now: at(3 * HOUR) });
  assert.equal(second.sent.settled, 0);
  assert.equal(second.observed.written, 0);
  assert.equal(JSON.stringify(rows(`SELECT * FROM trade_outcomes WHERE league_id = ? ORDER BY id`, L)), snap);
  assert.equal(ledger(L, r.id).status, 'declined');
});

/* ------------------------------------------------------------------ O6 */
test('O6: "I sent this" on a slate suggestion marks that row sent, once', () => {
  const L = 507;
  const idea = { ...deal(2, 171, 272, 'Give 171>Get 272'), partner_id: '2' };
  const slate = recordProposalSlate(L, SEASON, {
    ideas: [idea], result: { source: 'model', proposals: [{ idea_ids: ['Give 171>Get 272'] }] },
    modelVersion: 'slate-v1', proposerTeamId: '1' });
  assert.equal(slate.proposed, 1, 'precondition: the slate wrote the suggestion');
  const before = row(`SELECT * FROM trade_outcomes WHERE league_id = ?`, L);
  assert.equal(before.sent_at, null, 'a suggestion is not a sent offer');

  const r = send(L, idea, 10 * MIN);
  assert.equal(r.state, 'marked_sent');
  assert.equal(r.id, before.id);
  const after = ledger(L, r.id);
  assert.equal(after.sent_at, at(10 * MIN));
  assert.equal(after.model_version, 'slate-v1', 'the prediction made at suggestion time is kept');
  assert.equal(rows(`SELECT id FROM trade_outcomes WHERE league_id = ?`, L).length, 1);

  const again = send(L, idea, 20 * MIN);
  assert.equal(again.state, 'already_sent');
  assert.equal(ledger(L, r.id).sent_at, at(10 * MIN));
});

test('O6b: a deal with no acceptance band is refused, not written without a prediction', () => {
  assert.throws(() => recordSentOffer({ league_id: 508, season: SEASON, proposer_team_id: '1',
    deal: { ...deal(2, 1, 2), acceptance: null }, model_version: 'v' }), /model_p_accept/);
  assert.equal(rows(`SELECT id FROM trade_outcomes WHERE league_id = 508`).length, 0);
});

/* ------------------------------------------------------------------ O7 */
test('O7: a different package between the same two teams does not match', () => {
  const L = 509;
  const r = send(L, deal(2, 181, 282));
  raw(L, { tx_id: 'p9', type: 'TRADE_PROPOSAL', team_id: 1, proposed_at: at(-MIN), items: swap(1, 2, 181, 999) });
  raw(L, { tx_id: 'a9', type: 'TRADE_ACCEPT', team_id: 2, related_tx_id: 'p9', proposed_at: at(HOUR) });
  settleSentOffers(L, SEASON, { now: at(2 * HOUR) });
  const o = ledger(L, r.id);
  assert.equal(o.status, 'proposed');
  assert.equal(o.matched_tx_id, null);
});

/* ------------------------------------------------------------------ O8 */
test('O8: nothing in the offer loop sends to ESPN', () => {
  const src = fs.readFileSync(new URL('../server/services/trade-outcomes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(|espn\.com|lm-api|https?:\/\//i,
    'the ledger records and reads; the app never sends an offer');
  const routes = fs.readFileSync(new URL('../server/routes/trades.js', import.meta.url), 'utf8');
  const block = routes.slice(routes.indexOf("'/:leagueId/offers/sent'"));
  const handler = block.slice(0, block.indexOf('\n});') + 4);
  assert.ok(handler.length > 20, 'precondition: the /offers/sent route exists');
  assert.doesNotMatch(handler, /\bfetch\s*\(|espn\.com|lm-api/i);
});
