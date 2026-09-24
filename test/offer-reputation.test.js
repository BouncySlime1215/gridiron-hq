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
 *  R11 (RULINGS 8) the finder hook is behind GRIDIRON_REP_GATE, read through
 *     preview-mode.js: off, deals are served untouched; preview labels verdicts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-offer-reputation-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
// The finder hook is flagged (R11 pins off / preview); every other test runs it on.
process.env.GRIDIRON_REP_GATE = '1';
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

test('R11 GRIDIRON_REP_GATE off: finder deals come back untouched; preview labels each verdict', () => {
  const result = { mode: 'league', deals: [{ partner_id: '3', acceptance: { band: { low: 0.4, mid: 0.5, high: 0.6 } } }] };
  try {
    delete process.env.GRIDIRON_REP_GATE;
    const off = gateDeals({ id: 4, season: 2026 }, result, { now: NOW });
    assert.equal(off, result, 'off: the same object, no reputation field');
    assert.equal(off.deals[0].reputation, undefined);

    process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
    const p = gateDeals({ id: 4, season: 2026 }, result, { now: NOW });
    assert.equal(p.deals[0].reputation.preview, true);
    assert.match(p.deals[0].reputation.preview_reason, /GRIDIRON_REP_GATE=1/);
    assert.ok(['allow', 'deny', 'delay'].includes(p.deals[0].reputation.decision));
  } finally {
    process.env.GRIDIRON_REP_GATE = '1';
    delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  }
  const on = gateDeals({ id: 4, season: 2026 }, result, { now: NOW });
  assert.equal(on.deals[0].reputation.preview, undefined, 'flag on: no preview label');
});
