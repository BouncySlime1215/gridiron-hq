/**
 * E1-DATA: decided-offers.js is the one producer of "decided offers". The
 * fixture is the 2026 ESPN trade rows as of 2026-09-24 (ids renumbered, no
 * names). These counts are pinned so any change to a rule shows up here with
 * the rule's name, instead of as a new unexplained n in a grader or a study.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decidedOffers, EXCLUSION_RULES } from '../server/services/eval/decided-offers.js';
import * as E1 from '../server/services/eval/e1.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/decided-offers-2026-09-24.json', import.meta.url)));
const iso = (day, hour = 0) => new Date(Date.UTC(2026, 8, 1 + day, hour)).toISOString();
const sum = xs => xs.reduce((a, b) => a + b, 0);

test('fixture: today\'s decided offers, per league, with every exclusion rule counted', () => {
  const r = decidedOffers(fixture);
  assert.equal(r.offers.length, 37, 'decided and placed in time: the set E1 grades');
  assert.equal(sum(r.offers.map(o => o.y)), 7);
  assert.equal(r.orphans.length, 39, 'answered, proposal never collected');
  assert.equal(sum(r.orphans.map(o => o.y)), 8);
  assert.deepEqual(r.excluded, {
    not_an_offer: 12, unsent_app_offer: 2, unlinked_answer: 0, answer_to_non_proposal: 2, withdrawn: 58, expired: 7,
    unanswered: 11, unreadable: 0, missing_proposal: 39, no_proposal_time: 0, duplicate_outcome_row: 0, espn_copy_of_app_offer: 0,
  });
  const per = Object.fromEntries(Object.entries(r.by_league).map(([l, v]) => [l, [v.offers, v.accepted, v.orphans]]));
  assert.deepEqual(per, { 1: [0, 0, 0], 2: [9, 0, 4], 3: [7, 1, 15], 4: [21, 6, 20], 5: [0, 0, 0] });
  assert.equal(r.by_league[4].excluded.withdrawn, 43);
  assert.equal(r.by_league[4].excluded.answer_to_non_proposal, 2);
  assert.equal(sum(Object.values(r.by_league).map(v => v.stale_outcome_row)), 0);
  assert.deepEqual(Object.keys(r.excluded), [...EXCLUSION_RULES]);
});

test('fixture: every graded offer carries its terms and both as-of timestamps', () => {
  const { offers } = decidedOffers(fixture);
  for (const o of offers) {
    assert.ok(o.terms, `offer ${o.offer_id} has terms`);
    assert.ok(Date.parse(o.proposed_at) <= Date.parse(o.decided_at), `offer ${o.offer_id} decided after it was proposed`);
    assert.equal(o.proposal_basis, 'proposal_row');
  }
  assert.equal(offers.filter(o => o.vetoed).length, 2, 'vetoed after a yes still counts as a yes');
});

test('E1 grades exactly the producer\'s set', () => {
  const { offers, excluded } = decidedOffers(fixture);
  const r = E1.grade(offers, { alreadyMerged: true, excluded });
  assert.equal(r.n, 37);
  assert.equal(r.detail.accepted, 7);
  assert.equal(r.detail.excluded.missing_proposal, 39);
});

// ------------------------------------------------------------ the rules
const P = (tx, team, at, to, extra = {}) => ({ league_id: 9, season: 2026, tx_id: tx, type: 'TRADE_PROPOSAL', execution_type: 'EXECUTE',
  team_id: team, related_tx_id: null, proposed_at: at, items_json: JSON.stringify([{ fromTeamId: team, toTeamId: to }, { fromTeamId: to, toTeamId: team }]), ...extra });
const A = (tx, type, team, rel, at, extra = {}) => ({ league_id: 9, season: 2026, tx_id: tx, type, execution_type: 'EXECUTE',
  team_id: team, related_tx_id: rel, proposed_at: at, items_json: null, ...extra });

test('rules: withdrawn, expired, unanswered, orphan, unlinked, answer-to-non-proposal', () => {
  const raw = [
    P('1', 1, iso(0), 2), A('1a', 'TRADE_ACCEPT', 2, '1', iso(0, 3)), A('1v', 'TRADE_VETO', 3, '1', iso(0, 4)),
    P('2', 1, iso(1), 3), { ...A('2c', 'TRADE_PROPOSAL', 1, '2', iso(1, 1)), execution_type: 'CANCEL' },
    P('3', 1, iso(2), 3), { ...A('3c', 'TRADE_PROPOSAL', 1, '3', iso(4)), execution_type: 'CANCEL', member_id: 'TradeTaskProcessor' },
    P('4', 2, iso(3), 3),
    A('5d', 'TRADE_DECLINE', 3, '5', iso(5)), { ...A('5c', 'TRADE_PROPOSAL', 2, '5', iso(5)), execution_type: 'CANCEL' },
    A('6', 'TRADE_ACCEPT', 4, null, iso(6)),
    A('7p', 'TRADE_ACCEPT', 4, null, iso(7)), A('7a', 'TRADE_ACCEPT', 5, '7p', iso(7, 1)),
  ];
  const r = decidedOffers({ raw });
  assert.deepEqual(r.offers.map(o => [o.offer_id, o.status, o.vetoed]), [['1', 'accepted', true]]);
  assert.deepEqual(r.orphans.map(o => [o.offer_id, o.status, o.proposer_team_id, o.proposed_before]), [['5', 'declined', '2', iso(5)]]);
  const x = r.excluded;
  assert.deepEqual([x.withdrawn, x.expired, x.unanswered, x.missing_proposal, x.unlinked_answer, x.answer_to_non_proposal], [1, 1, 1, 1, 1, 1]);
});

test('rules: raw answer overrides a stale observed row; duplicates and considered-only rows are counted', () => {
  const raw = [P('1', 1, iso(0), 2), A('1d', 'TRADE_DECLINE', 2, '1', iso(1))];
  const row = { league_id: 9, season: 2026, source: 'observed', proposer_team_id: '1', counterparty_team_id: '2', proposed_at: iso(0),
    model_p_accept: 0.3, status: 'proposed', espn_tx_id: '1', idea_id: null, resolved_at: null };
  const considered = { ...row, source: 'considered_only', status: 'not_proposed', espn_tx_id: null };
  const r = decidedOffers({ raw, outcomes: [row, { ...row }, considered] });
  assert.equal(r.offers.length, 1);
  assert.equal(r.offers[0].status, 'declined');
  assert.equal(r.offers[0].model_p_accept, 0.3, 'the recorded prediction is kept');
  assert.equal(r.by_league[9].stale_outcome_row, 1);
  assert.equal(r.excluded.duplicate_outcome_row, 1);
  assert.equal(r.excluded.not_an_offer, 1);
});

test('rules: a snapshot supplies the proposal an orphan lacks', () => {
  const raw = [A('5d', 'TRADE_DECLINE', 3, '5', iso(5))];
  const snapshots = [{ league_id: 9, season: 2026, proposal_tx_id: '5', proposer_team_id: 2, proposed_at: iso(4),
    items_json: JSON.stringify([{ fromTeamId: 2, toTeamId: 3 }]) }];
  const r = decidedOffers({ raw, snapshots });
  assert.equal(r.orphans.length, 0);
  assert.deepEqual(r.offers.map(o => [o.proposal_basis, o.terms_source, o.proposed_at]), [['snapshot', 'snapshot', iso(4)]]);
});
