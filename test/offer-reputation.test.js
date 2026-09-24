/**
 * offer-reputation (REP-01): the fatigue and reputation gate every outgoing
 * offer passes before the campaign producer or the trade finder sends it.
 *
 * Gates, written before the module existed:
 *  R1 a "never trades" manager is denied, whatever the offer.
 *  R2 fatigue: offers sent in the last 7 days are counted per manager, and one
 *     past the tier's weekly cap is DELAYED until the oldest leaves the window.
 *  R3 declines in a row are counted (declined / ignored / expired; an accept or
 *     a counter resets the run); at the tier's streak cap the next offer is
 *     delayed by the streak cooldown, and a single fresh decline delays by the
 *     short cooldown.
 *  R4 an offer to someone who has not answered the last one is delayed.
 *  R5 reputation budget: lopsided offers spend a per-manager budget that decays
 *     on a half-life; a lowball past the budget is delayed until enough has
 *     decayed, an offer lopsided enough to break the budget alone is denied,
 *     and a fair offer is never charged.
 *  R6 a league-wide budget caps lowball spam spread across managers.
 *  R7 defaults come from the profile tier, and "hard to deal with" is stricter
 *     on every limit; an unset tier falls back to 'fair' and says so; an unknown
 *     tier string throws rather than guessing.
 *  R8 pure: same inputs, same answer; `now` is required; other managers'
 *     history never changes this manager's per-manager counts.
 *  R9 the adapter reads trade_outcomes + manager_profiles for one league and
 *     only counts offers this app's team sent.
 *  R10 (RULINGS 4) the 7-day count is FIX-07's sentThisWeek, the one fatigue
 *     counter; an app_proposed row with no sent_at (a suggestion never sent)
 *     counts nowhere.
 *  R11 (RULINGS 8) the finder hook is behind GRIDIRON_REPUTATION, read through
 *     preview-mode.js previewUnconfirmed(): off, deals are served untouched;
 *     preview labels verdicts.
 *  R12 (FIX-264-1) one fatigue number: the count lives here
 *     (countSentThisWeek: trade_outcomes.sent_at IS NOT NULL plus ESPN's own
 *     proposals, de-duplicated on matched_tx_id) and the War Room producer's
 *     league-adapter.mjs#sentThisWeek calls it, not the other way round.
 *  R13 (FIX-264-2) GET /find with a seeded deal carries the verdict (kills the
 *     "remove the gateDeals wrap" mutant the fixture-less route missed).
 *  R14 (FIX-264-3) the reputation factor: selfRead carries per-manager and
 *     league lopsidedness from the ledger, and acceptanceBand's capped,
 *     default-off `reputation` factor lowers only that manager's P(accept),
 *     decays on the half-life, and is inert with a reason with no logged offers.
 */
import { mock } from 'node:test';
import express from 'express';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-offer-reputation-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
// The finder hook is flagged (R11 pins off / preview); every other test runs it on.
process.env.GRIDIRON_REPUTATION = '1';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
// The collector's table (scripts/collect-league-transactions.mjs): sentThisWeek reads ESPN's own proposals from it.
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);

const {
  offerGate, reputationLedger, reputationLimits, offerGateFor, gateDeals,
  REPUTATION_DEFAULTS, LEAGUE_REPUTATION_DEFAULTS, REPUTATION_HALF_LIFE_DAYS,
} = await import('../server/services/offer-reputation.js');
const reputationModule = await import('../server/services/offer-reputation.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------------- fixtures */

const NOW = '2026-09-24T12:00:00.000Z';
const DAY = 86_400_000;
const ago = days => new Date(Date.parse(NOW) - days * DAY).toISOString();
const plus = (iso, days) => new Date(Date.parse(iso) + days * DAY).toISOString();

/** One offer this app's team sent. Answered offers resolve half a day later. */
function sent(counterparty, daysAgo, status = 'declined', extra = {}) {
  return {
    counterparty_id: String(counterparty),
    proposed_at: ago(daysAgo),
    resolved_at: status === 'proposed' ? null : ago(daysAgo - 0.5),
    status,
    ...extra,
  };
}

const FAIR_OFFER = { counterparty_id: '3', lopsidedness: 0 };
const LOWBALL = { counterparty_id: '3', lopsidedness: 1 };

/* ------------------------------------------------------------------ R1 */

test('R1 a "never trades" manager is denied, with the reason', () => {
  const r = offerGate({ offer: FAIR_OFFER, history: [], tier: 'never', now: NOW });
  assert.equal(r.decision, 'deny');
  assert.equal(r.code, 'tier_never');
  assert.match(r.reason, /never/i);
  assert.equal(r.retry_at, null);
});

/* ------------------------------------------------------------------ R2 */

test('R2 a clean history allows a fair offer', () => {
  const r = offerGate({ offer: FAIR_OFFER, history: [], tier: 'fair', now: NOW });
  assert.equal(r.decision, 'allow');
  assert.equal(r.code, 'ok');
  assert.equal(r.ledger.offers_7d, 0);
});

test('R2 the weekly cap delays the next offer until the oldest leaves the 7-day window', () => {
  // Three offers this week, each countered (a counter resets the decline run,
  // so only the weekly cap is in play). Fair cap is 3.
  const history = [sent(3, 6, 'countered'), sent(3, 4, 'countered'), sent(3, 2, 'countered')];
  const r = offerGate({ offer: FAIR_OFFER, history, tier: 'fair', now: NOW });
  assert.equal(r.ledger.offers_7d, 3);
  assert.equal(r.decision, 'delay');
  assert.equal(r.code, 'weekly_cap');
  assert.equal(r.retry_at, plus(ago(6), 7));
  assert.match(r.reason, /3 offers in the last 7 days/);
});

test('R2 an offer 8 days old is outside the window', () => {
  const history = [sent(3, 8, 'countered'), sent(3, 4, 'countered'), sent(3, 2, 'countered')];
  const r = offerGate({ offer: FAIR_OFFER, history, tier: 'fair', now: NOW });
  assert.equal(r.ledger.offers_7d, 2);
  assert.equal(r.decision, 'allow');
});

/* ------------------------------------------------------------------ R3 */

test('R3 declines in a row are counted; an accept or counter resets the run', () => {
  const history = [
    sent(3, 20, 'declined'), sent(3, 15, 'accepted'),
    sent(3, 12, 'declined'), sent(3, 10, 'ignored'), sent(3, 9, 'expired'),
  ];
  const l = reputationLedger(history, { counterpartyId: '3', now: NOW });
  assert.equal(l.decline_streak, 3);
  const reset = reputationLedger([...history, sent(3, 8, 'countered')], { counterpartyId: '3', now: NOW });
  assert.equal(reset.decline_streak, 0);
});

test('R3 at the streak cap the next offer waits out the streak cooldown from the last decline', () => {
  const history = [sent(3, 12, 'declined'), sent(3, 10, 'declined'), sent(3, 9, 'declined')];
  const r = offerGate({ offer: FAIR_OFFER, history, tier: 'fair', now: NOW });
  assert.equal(r.decision, 'delay');
  assert.equal(r.code, 'decline_streak');
  const lastDecline = ago(9 - 0.5);
  assert.equal(r.retry_at, plus(lastDecline, REPUTATION_DEFAULTS.fair.streak_cooldown_days));
  assert.match(r.reason, /3 declines in a row/);
});

test('R3 one fresh decline delays by the short cooldown only', () => {
  const history = [sent(3, 1, 'declined')];
  const r = offerGate({ offer: FAIR_OFFER, history, tier: 'hard', now: NOW });
  assert.equal(r.decision, 'delay');
  assert.equal(r.code, 'decline_cooldown');
  assert.equal(r.retry_at, plus(ago(0.5), REPUTATION_DEFAULTS.hard.decline_cooldown_days));
  // Once the short cooldown has passed, the same history allows (fair tier, 1 day).
  const later = offerGate({ offer: FAIR_OFFER, history, tier: 'fair', now: plus(NOW, 1) });
  assert.equal(later.decision, 'allow');
});

/* ------------------------------------------------------------------ R4 */

test('R4 an unanswered offer to the same manager delays the next one', () => {
  const history = [sent(3, 1, 'proposed')];
  const r = offerGate({ offer: FAIR_OFFER, history, tier: 'fair', now: NOW });
  assert.equal(r.decision, 'delay');
  assert.equal(r.code, 'open_offer');
  assert.equal(r.retry_at, plus(ago(1), REPUTATION_DEFAULTS.fair.open_offer_wait_days));
  // An open offer to someone else does not block this manager.
  const other = offerGate({ offer: FAIR_OFFER, history: [sent(5, 1, 'proposed')], tier: 'fair', now: NOW });
  assert.equal(other.decision, 'allow');
});

/* ------------------------------------------------------------------ R5 */

test('R5 a fair offer is never charged against the budget', () => {
  const history = [sent(3, 20, 'countered', { lopsidedness: 1 }), sent(3, 18, 'countered', { lopsidedness: 1 })];
  const r = offerGate({ offer: FAIR_OFFER, history, tier: 'fair', now: NOW });
  assert.equal(r.decision, 'allow');
  assert.equal(r.offer_cost, 0);
});

test('R5 lowballs spend a decaying budget; the next lowball waits until enough has decayed', () => {
  // Two lowballs 1 day ago, both countered (so no decline cooldown). Fair budget 2.
  const history = [sent(3, 1, 'countered', { lopsidedness: 1 }), sent(3, 1, 'countered', { lopsidedness: 1 })];
  const l = reputationLedger(history, { counterpartyId: '3', now: NOW });
  const expected = 2 * 2 ** (-1 / REPUTATION_HALF_LIFE_DAYS);
  assert.ok(Math.abs(l.lopsided_spent - expected) < 1e-9);
  assert.equal(l.lopsided_offers_14d, 2);

  const r = offerGate({ offer: LOWBALL, history, tier: 'fair', now: NOW });
  assert.equal(r.decision, 'delay');
  assert.equal(r.code, 'reputation_budget');
  assert.equal(r.offer_cost, 1);
  // Retry when spent * 2^(-t/h) + 1 <= 2, i.e. spent has halved from 2 to 1.
  const retry = Date.parse(r.retry_at);
  const t = (retry - Date.parse(NOW)) / DAY;
  assert.ok(Math.abs(l.lopsided_spent * 2 ** (-t / REPUTATION_HALF_LIFE_DAYS) + 1 - 2) < 1e-6);
  assert.match(r.reason, /2 lopsided offers in 2 weeks/);

  // At retry_at the same lowball is allowed.
  const then = offerGate({ offer: LOWBALL, history, tier: 'fair', now: r.retry_at });
  assert.equal(then.decision, 'allow');
});

test('R5 an offer too lopsided to fit the budget on its own is denied, not delayed', () => {
  const r = offerGate({ offer: { counterparty_id: '3', lopsidedness: 1 }, history: [], tier: 'hard', now: NOW,
    overrides: { lopsided_budget: 0.5 } });
  assert.equal(r.decision, 'deny');
  assert.equal(r.code, 'offer_too_lopsided');
});

test('R5 lopsidedness falls back to the band: p_accept_high under the lowball line costs 1, labelled', () => {
  const r = offerGate({ offer: { counterparty_id: '3', p_accept_high: 0.1 }, history: [], tier: 'fair', now: NOW });
  assert.equal(r.offer_cost, 1);
  assert.equal(r.offer_cost_basis, 'p_accept_proxy');
  const fair = offerGate({ offer: { counterparty_id: '3', p_accept_high: 0.6 }, history: [], tier: 'fair', now: NOW });
  assert.equal(fair.offer_cost, 0);
  const none = offerGate({ offer: { counterparty_id: '3' }, history: [], tier: 'fair', now: NOW });
  assert.equal(none.offer_cost, 0);
  assert.equal(none.offer_cost_basis, 'unpriced');
  assert.match(none.reason, /unpriced/);
});

test('R5 the ledger decays: a lowball 10 half-lives old is effectively spent-out', () => {
  const history = [sent(3, 10 * REPUTATION_HALF_LIFE_DAYS, 'countered', { lopsidedness: 1 })];
  const l = reputationLedger(history, { counterpartyId: '3', now: NOW });
  assert.ok(l.lopsided_spent < 0.001);
});

/* ------------------------------------------------------------------ R6 */

test('R6 lowballs spread across managers hit the league-wide budget', () => {
  const cap = LEAGUE_REPUTATION_DEFAULTS.lopsided_budget;
  const history = [];
  for (let i = 0; i < cap; i++) history.push(sent(10 + i, 1, 'countered', { lopsidedness: 1 }));
  const r = offerGate({ offer: LOWBALL, history, tier: 'fair', now: NOW });
  assert.equal(r.ledger.lopsided_spent, 0, 'nothing sent to this manager');
  assert.equal(r.decision, 'delay');
  assert.equal(r.code, 'league_reputation_budget');
  // A fair offer still goes: the league budget prices lowballs only.
  assert.equal(offerGate({ offer: FAIR_OFFER, history, tier: 'fair', now: NOW }).decision, 'allow');
});

/* ------------------------------------------------------------------ R7 */

test('R7 "hard to deal with" is stricter than "fair" on every limit', () => {
  const fair = REPUTATION_DEFAULTS.fair;
  const hard = REPUTATION_DEFAULTS.hard;
  assert.ok(hard.max_offers_7d < fair.max_offers_7d);
  assert.ok(hard.max_decline_streak < fair.max_decline_streak);
  assert.ok(hard.decline_cooldown_days > fair.decline_cooldown_days);
  assert.ok(hard.streak_cooldown_days > fair.streak_cooldown_days);
  assert.ok(hard.open_offer_wait_days > fair.open_offer_wait_days);
  assert.ok(hard.lopsided_budget < fair.lopsided_budget);
});

test('R7 the same history allows for a fair manager and delays for a hard one', () => {
  const history = [sent(3, 5, 'countered'), sent(3, 3, 'countered')];
  assert.equal(offerGate({ offer: FAIR_OFFER, history, tier: 'fair', now: NOW }).decision, 'allow');
  const hard = offerGate({ offer: FAIR_OFFER, history, tier: 'hard', now: NOW });
  assert.equal(hard.decision, 'delay');
  assert.equal(hard.code, 'weekly_cap');
});

test('R7 an unset tier defaults to fair and says so; an unknown tier throws', () => {
  const r = offerGate({ offer: FAIR_OFFER, history: [], tier: null, now: NOW });
  assert.equal(r.tier, 'fair');
  assert.equal(r.tier_source, 'default');
  assert.throws(() => reputationLimits('grumpy'), /unknown tier/);
});

test('R7 overrides replace a default and nothing else', () => {
  const l = reputationLimits('hard', { max_offers_7d: 5 });
  assert.equal(l.max_offers_7d, 5);
  assert.equal(l.lopsided_budget, REPUTATION_DEFAULTS.hard.lopsided_budget);
  assert.throws(() => reputationLimits('fair', { max_offers_7day: 5 }), /unknown limit/);
});

/* ------------------------------------------------------------------ R8 */

test('R8 now is required, the answer is deterministic, and other managers do not leak in', () => {
  assert.throws(() => offerGate({ offer: FAIR_OFFER, history: [], tier: 'fair' }), /now/);
  assert.throws(() => offerGate({ offer: {}, history: [], tier: 'fair', now: NOW }), /counterparty/);
  const history = [sent(5, 1, 'declined'), sent(5, 2, 'declined'), sent(5, 3, 'declined'), sent(3, 6, 'countered')];
  const a = offerGate({ offer: FAIR_OFFER, history, tier: 'fair', now: NOW });
  const b = offerGate({ offer: FAIR_OFFER, history: [...history].reverse(), tier: 'fair', now: NOW });
  assert.deepEqual(a, b);
  assert.equal(a.ledger.offers_7d, 1);
  assert.equal(a.ledger.decline_streak, 0);
  assert.equal(a.decision, 'allow');
});

test('R8 not_proposed rows and offers from the future are ignored', () => {
  const history = [
    { counterparty_id: '3', proposed_at: ago(1), status: 'not_proposed' },
    sent(3, -2, 'declined'),
  ];
  const l = reputationLedger(history, { counterpartyId: '3', now: NOW });
  assert.equal(l.offers_7d, 0);
  assert.equal(l.decline_streak, 0);
});

/* ------------------------------------------------------------------ R9 */

test('R9 the adapter reads trade_outcomes and the profile tier for one league', () => {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
       VALUES (4, 'espn', 'fx-4', 2026, 'Fixture league', '1', 10, 1, '{}', '2026-09-20 00:00:00')`);
  run(`INSERT INTO manager_profiles (league_id, roster_id, tradeability) VALUES (4, '3', 'hard')`);
  const insert = (o) => run(`INSERT INTO trade_outcomes
      (league_id, season, source, proposer_team_id, counterparty_team_id, proposed_at,
       model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, model_version,
       status, resolved_at, espn_tx_id, created_at, sent_at)
      VALUES (4, 2026, @source, @proposer, @cp, @at, 0.1, 0.05, 0.15, 'heuristic_unanchored', 'v0',
       @status, @resolved, @tx, @at, @sent)`, { sent: null, ...o });
  // Two offers Nick sent ("I sent it": sent_at stamped).
  insert({ source: 'app_proposed', proposer: '1', cp: '3', at: ago(3), status: 'countered', resolved: ago(2.5), tx: null, sent: ago(3) });
  insert({ source: 'app_proposed', proposer: '1', cp: '3', at: ago(2), status: 'countered', resolved: ago(1.5), tx: null, sent: ago(2) });
  // Someone else's offer to the same manager: not ours, never counted.
  insert({ source: 'observed', proposer: '7', cp: '3', at: ago(1), status: 'declined', resolved: ago(0.5), tx: 'x1' });

  const r = offerGateFor({ leagueId: 4, season: 2026, offer: FAIR_OFFER, now: NOW });
  assert.equal(r.tier, 'hard');
  assert.equal(r.tier_source, 'profile');
  assert.equal(r.ledger.offers_7d, 2);
  assert.equal(r.ledger.offers_7d_source, 'sentThisWeek');
  assert.equal(r.ledger.decline_streak, 0);
  assert.equal(r.decision, 'delay');
  assert.equal(r.code, 'weekly_cap');
  // Both logged offers sat under the lowball line on the band.
  assert.equal(r.ledger.lopsided_offers_14d, 2);
});

test('R9 the adapter refuses a league it cannot read rather than allowing blind', () => {
  assert.throws(() => offerGateFor({ leagueId: 999, season: 2026, offer: FAIR_OFFER, now: NOW }), /league 999/);
});

test('R9 gateDeals stamps each finder deal with its verdict and leaves the cached result untouched', () => {
  const result = { mode: 'league', deals: [
    { partner_id: '3', acceptance: { band: { low: 0.4, mid: 0.5, high: 0.6 } } },
    { partner_id: '5', acceptance: { band: null } },
  ] };
  const frozen = JSON.stringify(result);
  const out = gateDeals({ id: 4, season: 2026 }, result, { now: NOW });
  assert.equal(JSON.stringify(result), frozen, 'input not mutated');
  assert.equal(out.deals[0].reputation.decision, 'delay');
  assert.equal(out.deals[0].reputation.code, 'weekly_cap');
  assert.equal(out.deals[0].reputation.offer_cost_basis, 'p_accept_proxy', 'the band top reaches the gate');
  assert.equal(out.deals[1].reputation.decision, 'allow');
  assert.equal(out.deals[1].reputation.offer_cost_basis, 'unpriced');

  const blind = gateDeals({ id: 999, season: 2026 }, result, { now: NOW });
  assert.equal(blind.deals[0].reputation.decision, null);
  assert.match(blind.deals[0].reputation.reason, /league 999/);
  assert.equal(gateDeals({ id: 4 }, { error: 'x' }).error, 'x');
});

/* ----------------------------------------------------------------- R10 */

test('R10 sentCount (the one fatigue counter) replaces the history\'s own 7-day count', () => {
  const history = [sent(3, 6, 'countered')];
  const own = offerGate({ offer: FAIR_OFFER, history, now: NOW });
  assert.equal(own.ledger.offers_7d, 1);
  assert.equal(own.ledger.offers_7d_source, 'history');
  const capped = offerGate({ offer: FAIR_OFFER, history, now: NOW, sentCount: REPUTATION_DEFAULTS.fair.max_offers_7d });
  assert.equal(capped.ledger.offers_7d_source, 'sentThisWeek');
  assert.equal(capped.code, 'weekly_cap');
  assert.equal(capped.retry_at, plus(ago(6), 7), 'retry from the oldest offer the app logged');
  // An ESPN-only count with nothing in the log: still delayed, retry unknown and said so.
  const blind = offerGate({ offer: FAIR_OFFER, history: [], now: NOW, sentCount: 3 });
  assert.equal(blind.code, 'weekly_cap');
  assert.equal(blind.retry_at, null);
  assert.match(blind.reason, /retry time is unknown/);
  assert.throws(() => offerGate({ offer: FAIR_OFFER, history: [], now: NOW, sentCount: -1 }), /sentCount/);
});

test('R10 an unsent app_proposed row (a suggestion) is not an offer: no fatigue, no open offer', () => {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
       VALUES (5, 'espn', 'fx-5', 2026, 'Fixture league 5', '1', 10, 1, '{}', '2026-09-20 00:00:00')`);
  for (let i = 0; i < 5; i++) {
    run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, proposed_at,
           model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, model_version, status, created_at)
         VALUES (5, 2026, 'app_proposed', '1', '3', ?, 0.5, 0.4, 0.6, 'heuristic_unanchored', 'v0', 'proposed', ?)`,
    ago(1 + i * 0.1), ago(1 + i * 0.1));
  }
  const r = offerGateFor({ leagueId: 5, season: 2026, offer: FAIR_OFFER, now: NOW });
  assert.equal(r.ledger.offers_7d, 0);
  assert.equal(r.ledger.open_offer_at, null);
  assert.equal(r.decision, 'allow');
  // Once one of them is marked sent, it counts once.
  run(`UPDATE trade_outcomes SET sent_at = ? WHERE id = (SELECT MIN(id) FROM trade_outcomes WHERE league_id = 5)`, ago(1));
  const after = offerGateFor({ leagueId: 5, season: 2026, offer: FAIR_OFFER, now: NOW });
  assert.equal(after.ledger.offers_7d, 1);
  assert.ok(after.ledger.open_offer_at, 'the sent one is the open offer');
  // An offer ESPN shows (not tapped in the app) counts too: the one counter, both sources.
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, execution_type, proposed_at, team_id, items_json, first_seen_at, last_seen_at)
       VALUES (5, 2026, 'espn-1', 'TRADE_PROPOSAL', NULL, ?, 1, ?, ?, ?)`,
  ago(2), JSON.stringify([{ fromTeamId: 1, toTeamId: 3 }, { fromTeamId: 3, toTeamId: 1 }]), ago(2), ago(2));
  assert.equal(offerGateFor({ leagueId: 5, season: 2026, offer: FAIR_OFFER, now: NOW }).ledger.offers_7d, 2);
});

test('R10 no collector table: the league reader refuses rather than counting blind', () => {
  db.exec('ALTER TABLE league_transactions_raw RENAME TO ltr_hidden');
  try {
    assert.throws(() => offerGateFor({ leagueId: 5, season: 2026, offer: FAIR_OFFER, now: NOW }), /league_transactions_raw/);
  } finally { db.exec('ALTER TABLE ltr_hidden RENAME TO league_transactions_raw'); }
});

/* ----------------------------------------------------------------- R11 */

test('R11 GRIDIRON_REPUTATION off: finder deals come back untouched; preview labels each verdict', () => {
  const result = { mode: 'league', deals: [{ partner_id: '3', acceptance: { band: { low: 0.4, mid: 0.5, high: 0.6 } } }] };
  try {
    delete process.env.GRIDIRON_REPUTATION;
    const off = gateDeals({ id: 4, season: 2026 }, result, { now: NOW });
    assert.equal(off, result, 'off: the same object, no reputation field');
    assert.equal(off.deals[0].reputation, undefined);

    process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
    const p = gateDeals({ id: 4, season: 2026 }, result, { now: NOW });
    assert.equal(p.deals[0].reputation.preview, true);
    assert.match(p.deals[0].reputation.preview_reason, /GRIDIRON_REPUTATION=1/);
    assert.ok(['allow', 'deny', 'delay'].includes(p.deals[0].reputation.decision));
  } finally {
    process.env.GRIDIRON_REPUTATION = '1';
    delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  }
  const on = gateDeals({ id: 4, season: 2026 }, result, { now: NOW });
  assert.equal(on.deals[0].reputation.preview, undefined, 'flag on: no preview label');
});


/* ----------------------------------------------------------------- R12 */

test('R12 one fatigue number: the War Room adapter\'s sentThisWeek is this module\'s countSentThisWeek', async () => {
  const { countSentThisWeek } = reputationModule;
  assert.equal(typeof countSentThisWeek, 'function', 'the one counter lives in offer-reputation.js');
  const { sentThisWeek } = await import('../scripts/campaign/league-adapter.mjs');
  const { rows } = await import('../server/db/index.js');
  const nowMs = Date.parse(NOW);
  // League 5 by now: one tapped-and-sent offer to 3 plus one ESPN-only proposal (R10).
  const mine = countSentThisWeek({ rows, toTime: t => Date.parse(t) }, 5, 2026, '1', nowMs);
  const adapter = sentThisWeek({ db: { rows }, tactics: { toTime: t => Date.parse(t) } }, 5, 2026, '1', nowMs);
  assert.deepEqual([...adapter], [...mine]);
  assert.equal(mine.get('3'), offerGateFor({ leagueId: 5, season: 2026, offer: FAIR_OFFER, now: NOW }).ledger.offers_7d,
    'the finder gate and the War Room cap read the same number');
  const adapterSrc = fs.readFileSync(new URL('../scripts/campaign/league-adapter.mjs', import.meta.url), 'utf8');
  const gateSrc = fs.readFileSync(new URL('../server/services/offer-reputation.js', import.meta.url), 'utf8');
  assert.match(adapterSrc, /countSentThisWeek\(/, 'the adapter delegates');
  assert.doesNotMatch(gateSrc, /from '\.\.\/\.\.\/scripts\//, 'the server service does not import a script');
});

test('R12 an unsent app_proposed row and a tapped offer ESPN also shows each count correctly', () => {
  const { countSentThisWeek } = reputationModule;
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
       VALUES (8, 'espn', 'fx-8', 2026, 'Fixture league 8', '1', 10, 1, '{}', '2026-09-20 00:00:00')`);
  const ins = (cp, sentAt, tx = null) => run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id,
      counterparty_team_id, proposed_at, model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, model_version,
      status, created_at, sent_at, matched_tx_id)
    VALUES (8, 2026, 'app_proposed', '1', ?, ?, 0.5, 0.4, 0.6, 'heuristic_unanchored', 'v0', 'proposed', ?, ?, ?)`,
  cp, ago(1), ago(1), sentAt, tx);
  ins('3', null);            // a suggestion, never sent
  ins('3', ago(1));          // sent
  ins('4', ago(1), 'e-8');   // sent, and ESPN shows it as e-8
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, execution_type, proposed_at, team_id, items_json, first_seen_at, last_seen_at)
       VALUES (8, 2026, 'e-8', 'TRADE_PROPOSAL', 'EXECUTE', ?, 1, ?, ?, ?)`,
  ago(1), JSON.stringify([{ fromTeamId: 1, toTeamId: 4 }, { fromTeamId: 4, toTeamId: 1 }]), ago(1), ago(1));
  const rows = (sql, ...a) => db.prepare(sql).all(...a);
  const n = countSentThisWeek({ rows, toTime: t => Date.parse(t) }, 8, 2026, '1', Date.parse(NOW));
  assert.equal(n.get('3'), 1, 'only the sent one');
  assert.equal(n.get('4'), 1, 'the tapped offer ESPN also shows counts once');
});

/* ----------------------------------------------------------------- R13 */

test('R13 GET /find serves each seeded deal with its reputation verdict (flag on), and untouched (flag off)', async () => {
  const realEngine = await import('../server/services/trade-engine.js');
  mock.module('../server/services/trade-engine.js', {
    namedExports: { ...realEngine, findTrades: () => ({ mode: 'league', me: { roster_id: '1' },
      deals: [{ partner_id: '3', i_give: [{ id: 11 }], i_get: [{ id: 12 }],
        acceptance: { band: { low: 0.4, mid: 0.5, high: 0.6 } } }] }) },
  });
  const { hashSessionToken } = await import('../server/platform/auth.js');
  const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
  const { default: tradesRouter } = await import('../server/routes/trades.js');
  run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (9911, 'rep-user', 'Reader')`);
  run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at) VALUES (9911, ?, datetime('now','+1 day'))`,
    hashSessionToken('rep-token'));
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (4, 9911, 'member')`);
  const app = express();
  app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
  const server = app.listen(0);
  const get = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/trades/4/find?team_id=1`,
    { headers: { authorization: 'Bearer rep-token' } })).json();
  try {
    const on = await get();
    assert.equal(on.deals.length, 1);
    assert.ok(on.deals[0].reputation, 'the route wraps findTrades in gateDeals');
    assert.equal(on.deals[0].reputation.decision, 'delay', 'league 4: two sent offers to a hard manager (R9)');
    assert.equal(on.deals[0].reputation.code, 'weekly_cap');
    delete process.env.GRIDIRON_REPUTATION;
    const off = await get();
    assert.equal(off.deals[0].reputation, undefined, 'flag off: no reputation on the deal');
  } finally {
    process.env.GRIDIRON_REPUTATION = '1';
    server.close();
    mock.restoreAll();
  }
});

/* ----------------------------------------------------------------- R14 */

const { selfRead } = await import('../server/services/counterparty-pricing.js');
const { acceptanceBand, ACCEPTANCE_SOURCES } = await import('../server/services/trade-acceptance.js');
const BAND_IN = { counterparty: { counterparty_data: true, receptiveness: 1 }, edge: { passes: true } };
const factorOf = b => b.factors.find(f => f.source === 'reputation') ?? null;
const inertOf = b => b.inert.find(f => f.source === 'reputation') ?? null;

test('R14 three logged lopsided offers lower that manager\'s P(accept) for a fourth, and no one else\'s', () => {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
       VALUES (6, 'espn', 'fx-6', 2026, 'Fixture league 6', '1', 10, 1, '{}', '2026-09-20 00:00:00')`);
  for (const d of [3, 2, 1]) {
    // Sent lowballs: the band top under the lowball line costs 1 each (p_accept_proxy).
    run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, proposed_at,
           model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, model_version, status, resolved_at, created_at, sent_at)
         VALUES (6, 2026, 'app_proposed', '1', '3', ?, 0.1, 0.05, 0.15, 'heuristic_unanchored', 'v0', 'countered', ?, ?, ?)`,
    ago(d), ago(d - 0.5), ago(d), ago(d));
  }
  const me = selfRead(6, { season: 2026, now: NOW });
  const lop = me.lopsidedness;
  assert.ok(lop, 'selfRead carries lopsidedness');
  assert.equal(lop.half_life_days, REPUTATION_HALF_LIFE_DAYS);
  const his = lop.per_manager.get('3');
  assert.equal(his.offers, 3);
  assert.ok(his.spent > 2.5 && his.spent < 3, `decayed spend ${his.spent}`);
  assert.ok(Math.abs(lop.league.spent - his.spent) < 1e-9, 'league spend is the sum over managers');

  const base = acceptanceBand(BAND_IN);
  const hit = acceptanceBand({ ...BAND_IN, reputation: his });
  assert.ok(hit.band.mid < base.band.mid, `${hit.band.mid} < ${base.band.mid}`);
  const f = factorOf(hit);
  assert.ok(f && f.effect < 0 && Math.abs(f.effect) <= ACCEPTANCE_SOURCES.reputation.cap);
  assert.equal(ACCEPTANCE_SOURCES.reputation.default_off, true);

  // Manager 5: nothing logged. His band is unchanged and the factor says why.
  const other = acceptanceBand({ ...BAND_IN, reputation: lop.per_manager.get('5') ?? lop.none });
  assert.deepEqual(other.band, base.band);
  assert.match(inertOf(other).reason, /no logged offers/);
});

test('R14 the factor is capped: a flood of lowballs cannot move the band past the cap', () => {
  const hit = acceptanceBand({ ...BAND_IN, reputation: { spent: 1000, offers: 1000, half_life_days: REPUTATION_HALF_LIFE_DAYS } });
  assert.equal(factorOf(hit).effect, -ACCEPTANCE_SOURCES.reputation.cap);
});

test('R14 the factor halves over one half-life and decays to nothing', () => {
  const at = days => selfRead(6, { season: 2026, now: plus(NOW, days) }).lopsidedness.per_manager.get('3');
  const now0 = factorOf(acceptanceBand({ ...BAND_IN, reputation: at(0) })).effect;
  const half = factorOf(acceptanceBand({ ...BAND_IN, reputation: at(REPUTATION_HALF_LIFE_DAYS) })).effect;
  assert.ok(Math.abs(half - now0 / 2) <= 0.002, `${half} is about half of ${now0}`);
  const gone = acceptanceBand({ ...BAND_IN, reputation: at(REPUTATION_HALF_LIFE_DAYS * 8) });
  assert.equal(factorOf(gone), null, 'decayed to 0');
  assert.deepEqual(gone.band, acceptanceBand(BAND_IN).band);
});

test('R14 no logged offers: inert with a reason; not supplied (flag off): the band is byte-identical', () => {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
       VALUES (7, 'espn', 'fx-7', 2026, 'Fixture league 7', '1', 10, 1, '{}', '2026-09-20 00:00:00')`);
  const lop = selfRead(7, { season: 2026, now: NOW }).lopsidedness;
  assert.equal(lop.per_manager.size, 0);
  assert.equal(lop.league.spent, 0);
  assert.match(lop.reason, /no logged offers/);
  const empty = acceptanceBand({ ...BAND_IN, reputation: lop.none });
  assert.equal(factorOf(empty), null);
  assert.match(inertOf(empty).reason, /no logged offers/);
  assert.equal(JSON.stringify(acceptanceBand({ ...BAND_IN, reputation: null })), JSON.stringify(acceptanceBand(BAND_IN)),
    'default-off: without a ledger the band is exactly today\'s');
});

test('R14 the War Room producer passes the ledger only when GRIDIRON_REPUTATION is on', () => {
  const src = fs.readFileSync(new URL('../scripts/campaign/league-adapter.mjs', import.meta.url), 'utf8');
  assert.match(src, /reputationFields\(\)\.enabled/);
  assert.match(src, /reputation:/);
});

/* ----------------------------------------------------------------- R15 */
// FIX-264-2: the one planner (campaign producer) asks the gate about every partner in
// next_move and the alternatives. Fixture league only (campaign-league.mjs: teams 1-4, Nick = 1).

const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const { gatePlans, excluded } = await import('../server/services/campaign/partners.js');
const { planGate } = reputationModule;

/** A fixture league for the planner gate: `sends` offers Nick tapped as sent to each manager, fair-priced. */
function seedPlannerLeague(id, { sends = {}, tiers = {} } = {}) {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
       VALUES (?, 'espn', ?, 2026, 'Fixture league', '1', 4, 1, '{}', '2026-09-20 00:00:00')`, id, `fx-${id}`);
  for (const [t, tier] of Object.entries(tiers)) {
    run(`INSERT INTO manager_profiles (league_id, roster_id, tradeability) VALUES (?, ?, ?)`, id, t, tier);
  }
  for (const [t, days] of Object.entries(sends)) {
    for (const d of days) {
      run(`INSERT INTO trade_outcomes
          (league_id, season, source, proposer_team_id, counterparty_team_id, proposed_at,
           model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, model_version,
           status, resolved_at, created_at, sent_at)
          VALUES (?, 2026, 'app_proposed', '1', ?, ?, 0.5, 0.4, 0.6, 'heuristic_unanchored', 'v0',
           'countered', ?, ?, ?)`, id, t, ago(d), ago(d - 0.5), ago(d), ago(d));
    }
  }
}

/** The fixture adapter with the producer's two gate hooks, exactly as league-adapter.mjs wires them. */
function gatedAdapter(leagueId) {
  const a = makeAdapter();
  const gateStep = planGate({ leagueId, season: 2026, now: NOW });
  const managers = new Map([...a.managers].map(([t, m]) => [t, { ...m, rep_gate: gateStep(t) }]));
  return { ...a, managers, gateStep };
}
const OBJ = () => normaliseObjective({ risk_mode: 'balanced' });
const partnersOf = res => [res.best, ...res.deck.map(c => c.plan)].filter(Boolean).flatMap(p => p.steps.map(s => String(s.team)));

test('R15 gatePlans: deny drops the plan, delay is carried with retry_at, unread is never an allow, no gate is identity', () => {
  const plans = [
    { id: 'a', steps: [{ team: '3' }, { team: '2' }] },
    { id: 'b', steps: [{ team: '4' }] },
    { id: 'c', steps: [{ team: '3' }] },
    { id: 'd', steps: [{ team: '5' }] },
  ];
  const V = { 2: { decision: 'deny', code: 'tier_never', reason: 'never' },
    3: { decision: 'delay', code: 'weekly_cap', reason: '3 offers', retry_at: '2026-09-28T12:00:00.000Z' },
    4: { decision: 'allow', code: 'ok', reason: 'fine' },
    5: { decision: null, code: 'unavailable', reason: 'reputation gate not run: no table', retry_at: null } };
  const out = gatePlans(plans, t => V[t]);
  assert.deepEqual(out.plans.map(p => p.id), ['b', 'c', 'd']);
  assert.equal(out.dropped[0].plan.id, 'a');
  assert.equal(out.dropped[0].step, 1);
  assert.equal(out.plans[0].reputation_gate, undefined, 'allowed: no gate field');
  assert.deepEqual(out.plans[1].reputation_gate, { decision: 'delay', code: 'weekly_cap', reason: '3 offers',
    retry_at: '2026-09-28T12:00:00.000Z', partner: '3', step: 0 });
  assert.equal(out.plans[2].reputation_gate.decision, null);
  assert.equal(gatePlans(plans, null).plans, plans, 'flag off: the plans as they came');
  assert.equal(excluded({ rep_gate: { decision: 'deny' } }), true);
  assert.equal(excluded({ rep_gate: { decision: 'delay' } }), false);
});

test('R15 planner: a partner at the weekly cap is still planned but every move through him carries retry_at + reason', () => {
  const base = planLeague(makeAdapter(), { objective: OBJ(), env: {} });
  assert.ok(partnersOf(base).includes('3'), 'the fixture deck goes through team 3 ungated');
  seedPlannerLeague(15, { sends: { 3: [1, 2, 3] } });
  const a = gatedAdapter(15);
  assert.equal(a.managers.get('3').rep_gate.code, 'weekly_cap');
  const res = planLeague(a, { objective: OBJ(), env: {} });
  assert.ok(res.deck.length > 0);
  let held = 0;
  for (const c of res.deck) {
    const first3 = c.plan.steps.findIndex(s => String(s.team) === '3');
    const g = c.plan.reputation_gate;
    if (first3 < 0) { assert.equal(g, undefined); continue; }
    held++;
    assert.equal(g.decision, 'delay');
    assert.equal(g.code, 'weekly_cap');
    assert.equal(g.partner, '3');
    assert.equal(g.step, first3);
    assert.equal(g.retry_at, plus(ago(3), 7), 'retry when the oldest of the three leaves the 7-day window');
    assert.match(g.reason, /3 offers in the last 7 days/);
  }
  assert.ok(held > 0, 'at least one move goes through the capped partner');
  const entry = toEntry(res, { names: a.names(), as_of: NOW });
  assert.deepEqual(validateLeague(entry).errors, []);
  const moves = [entry.next_move.value, ...entry.alternatives.value];
  const typed = moves.filter(m => m.reputation_gate);
  assert.ok(typed.length > 0);
  for (const m of typed) {
    assert.equal(m.reputation_gate.status, 'ok');
    assert.equal(m.reputation_gate.value.retry_at, plus(ago(3), 7));
    assert.equal(m.reputation_gate.value.partner, '3');
  }
});

test('R15 planner: a denied partner is never a step in next_move or the alternatives', () => {
  const base = planLeague(makeAdapter(), { objective: OBJ(), env: {} });
  assert.ok(partnersOf(base).includes('2'), 'the fixture deck uses team 2 ungated');
  seedPlannerLeague(16, { tiers: { 2: 'never' } });
  const a = gatedAdapter(16);
  assert.equal(a.managers.get('2').rep_gate.decision, 'deny');
  const res = planLeague(a, { objective: OBJ(), env: {} });
  assert.ok(!partnersOf(res).includes('2'), 'no step to the denied partner');
  const entry = toEntry(res, { names: a.names(), as_of: NOW });
  assert.deepEqual(validateLeague(entry).errors, []);
  const moves = entry.next_move.status === 'ok' ? [entry.next_move.value, ...entry.alternatives.value] : entry.alternatives.value;
  assert.ok(moves.every(m => m.steps.every(s => s.partner !== '2')));
});

test('R15 planner: a denied step price (too lopsided alone) drops that plan even when the partner is allowed', () => {
  seedPlannerLeague(17);
  const a = gatedAdapter(17);
  // Budget 0 for this one partner: any lowball-priced step to him is denied outright; fair ones pass.
  const strict = planGate({ leagueId: 17, season: 2026, now: NOW });
  const gateStep = (team, st) => (String(team) === '2' && st?.band?.high < 0.2
    ? { decision: 'deny', code: 'offer_too_lopsided', reason: 'test' } : strict(team, st));
  const res = planLeague({ ...a, gateStep }, { objective: OBJ(), env: {} });
  for (const p of [res.best, ...res.deck.map(c => c.plan)].filter(Boolean)) {
    assert.ok(p.steps.every(s => !(String(s.team) === '2' && s.band?.high < 0.2)));
  }
  assert.ok(res.reputation_dropped.length > 0);
});

test('R15 the War Room adapter builds the planner gate only when GRIDIRON_REPUTATION is on', () => {
  const src = fs.readFileSync(new URL('../scripts/campaign/league-adapter.mjs', import.meta.url), 'utf8');
  assert.match(src, /const gateStep = reputation \? planGate\(/);
  assert.match(src, /rep_gate: gateStep\(t\)/);
  const planner = fs.readFileSync(new URL('../server/services/campaign/planner.js', import.meta.url), 'utf8');
  assert.match(planner, /gatePlans\(plans, adapter\.gateStep\)/);
});

test('R15 planGate prices each step on its band: a lowball step is charged, an unpriced partner read is not', () => {
  seedPlannerLeague(18);
  const g = planGate({ leagueId: 18, season: 2026, now: NOW });
  const low = g('3', { band: { low: 0.05, high: 0.1 } });
  assert.equal(low.offer_cost, 1);
  assert.equal(low.offer_cost_basis, 'p_accept_proxy');
  assert.equal(g('3', { band: { low: 0.4, high: 0.6 } }).offer_cost, 0);
  assert.equal(g('3').offer_cost_basis, 'unpriced');
  assert.equal(g('3', { band: { high: 0.12 } }), low, 'memoised per partner + lowball bucket');
  const none = planGate({ leagueId: 999, season: 2026, now: NOW })('3');
  assert.equal(none.decision, null, 'a league the gate cannot read is never an allow');
  assert.match(none.reason, /league 999/);
});
