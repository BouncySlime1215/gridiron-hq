/**
 * E1-FIX: E1 grades every resolved offer in the league (all managers), each
 * scored as of its proposal time, judged by a pooled hierarchical calibration
 * and an anytime-valid confidence sequence instead of a fixed n = 50.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rng } from '../server/services/eval/stats.js';
import { confidenceSequence, minDecisiveN } from '../server/services/eval/sequential.js';
import { hierCalibration } from '../server/services/eval/hier-calibration.js';
import * as L from '../server/services/eval/e1-league.js';
import * as E1 from '../server/services/eval/e1.js';

const iso = (day, hour = 0) => new Date(Date.UTC(2026, 8, 1 + day, hour)).toISOString();

// ------------------------------------------------------ league-wide sources
function rawLeague() {
  const rows = [];
  let tx = 100;
  const items = (from, to) => JSON.stringify([{ fromTeamId: from, toTeamId: to, playerId: tx }, { fromTeamId: to, toTeamId: from, playerId: tx + 1 }]);
  // Four different proposers (teams 2, 3, 4, 5), none of them the app.
  const plan = [[2, 3, 'TRADE_ACCEPT'], [3, 4, 'TRADE_DECLINE'], [4, 5, 'TRADE_DECLINE'], [5, 2, 'TRADE_ACCEPT'], [2, 4, 'TRADE_DECLINE']];
  plan.forEach(([from, to, answer], k) => {
    const id = String(tx += 10);
    rows.push({ league_id: 7, season: 2026, tx_id: id, type: 'TRADE_PROPOSAL', execution_type: 'EXECUTE', team_id: from, related_tx_id: null, proposed_at: iso(k), items_json: items(from, to) });
    rows.push({ league_id: 7, season: 2026, tx_id: `${id}a`, type: answer, execution_type: 'EXECUTE', team_id: to, related_tx_id: id, proposed_at: iso(k, 5), items_json: null });
  });
  // Withdrawn by the proposer: CANCEL, no answer -> excluded.
  rows.push({ league_id: 7, season: 2026, tx_id: '900', type: 'TRADE_PROPOSAL', execution_type: 'EXECUTE', team_id: 3, related_tx_id: null, proposed_at: iso(9), items_json: items(3, 5) });
  rows.push({ league_id: 7, season: 2026, tx_id: '900c', type: 'TRADE_PROPOSAL', execution_type: 'CANCEL', team_id: 3, related_tx_id: '900', proposed_at: iso(9, 2), items_json: null });
  // Unanswered -> excluded.
  rows.push({ league_id: 7, season: 2026, tx_id: '901', type: 'TRADE_PROPOSAL', execution_type: 'EXECUTE', team_id: 4, related_tx_id: null, proposed_at: iso(10), items_json: items(4, 2) });
  return rows;
}

test('league offers from other managers count; withdrawn and unanswered do not', () => {
  const { offers, excluded } = L.mergeOffers({ raw: rawLeague() });
  assert.equal(offers.length, 5);
  assert.equal(new Set(offers.map(o => o.proposer_team_id)).size, 4, 'four different proposers');
  assert.equal(excluded.withdrawn, 1);
  assert.equal(excluded.unanswered, 1);
  const r = E1.grade(offers, { alreadyMerged: true, excluded });
  assert.equal(r.n, 5);
  assert.equal(r.detail.offers_by_basis.replay_anchor_only, 5, 'none carried a recorded prediction; all were replayed');
  assert.equal(r.detail.proposers, 4);
  assert.equal(r.detail.excluded.withdrawn, 1);
});

test('FIX-268-4: a proposal\'s terms come from its snapshot first; raw items_json only when no snapshot exists', () => {
  const raw = rawLeague();
  // 110: the raw upsert overwrote the items with nothing; 120: the raw proposal row was never
  // stored, only its answer. Both have a snapshot. 130 keeps its raw items (no snapshot).
  raw.find(r => r.tx_id === '110').items_json = '[]';
  const gone = raw.findIndex(r => r.tx_id === '120');
  raw.splice(gone, 1);
  const snapshots = [
    { league_id: 7, season: 2026, proposal_tx_id: '110', proposer_team_id: 2, proposed_at: iso(0), items_json: JSON.stringify([{ fromTeamId: 2, toTeamId: 3, playerId: 1 }]) },
    { league_id: 7, season: 2026, proposal_tx_id: '120', proposer_team_id: 3, proposed_at: iso(1), items_json: JSON.stringify([{ fromTeamId: 3, toTeamId: 4, playerId: 2 }]) },
    // 140: raw items still there (5 <-> 2) but the snapshot, first seen, says 5 <-> 3: the snapshot wins.
    { league_id: 7, season: 2026, proposal_tx_id: '140', proposer_team_id: 5, proposed_at: iso(3), items_json: JSON.stringify([{ fromTeamId: 5, toTeamId: 3, playerId: 4 }]) },
  ];
  const without = L.mergeOffers({ raw });
  assert.equal(without.offers.length, 3, 'no snapshot: 110 is unreadable and 120 has no proposal');
  const { offers, excluded } = L.mergeOffers({ raw, snapshots });
  assert.equal(offers.length, 5);
  assert.equal(excluded.unreadable, 0);
  const by = Object.fromEntries(offers.map(o => [o.espn_tx_id, o]));
  assert.equal(by['110'].terms_source, 'trade_proposal_snapshots');
  assert.equal(by['120'].terms_source, 'trade_proposal_snapshots');
  assert.equal(by['120'].proposed_at, iso(1), 'a snapshot-only proposal is timed by its snapshot');
  assert.deepEqual([by['120'].proposer_team_id, by['120'].counterparty_team_id], ['3', '4']);
  assert.equal(by['130'].terms_source, 'league_transactions_raw');
  assert.equal(by['140'].terms_source, 'trade_proposal_snapshots');
  assert.equal(by['140'].counterparty_team_id, '3', 'both present: the snapshot\'s terms, not the raw row\'s');
});

test('a raw proposal already settled into trade_outcomes is counted once', () => {
  const raw = rawLeague();
  const settled = { league_id: 7, season: 2026, source: 'observed', proposer_team_id: '2', counterparty_team_id: '3', proposed_at: iso(0), resolved_at: iso(0, 5), model_p_accept: null, status: 'accepted', espn_tx_id: '110' };
  const { offers } = L.mergeOffers({ rows: [settled], raw });
  assert.equal(offers.length, 5);
});

test('the ESPN copy of an app-proposed offer is dropped; the app row keeps its recorded prediction', () => {
  const app = { league_id: 7, season: 2026, source: 'app_proposed', proposer_team_id: '1', counterparty_team_id: '3', proposed_at: iso(3), model_p_accept: 0.4, status: 'declined' };
  const copy = { ...app, source: 'observed', proposed_at: iso(3, 1), model_p_accept: null, espn_tx_id: '555' };
  const { offers, excluded } = L.mergeOffers({ rows: [app, copy] });
  assert.equal(offers.length, 1);
  assert.equal(offers[0].source, 'app_proposed');
  assert.equal(excluded.espn_copy_of_app_offer, 1);
});

test('as-of scoring: an offer sees only offers RESOLVED before it was proposed', () => {
  // Responder 'r' decides 6 offers; offer 7 is proposed after all six resolved.
  const mk = (day, y, resolvedDay = day) => ({ league_id: 1, counterparty_team_id: 'r', proposed_at: iso(day), resolved_at: iso(resolvedDay, 1), status: y ? 'accepted' : 'declined' });
  const base = [mk(0, 1), mk(1, 1), mk(2, 1), mk(3, 1), mk(4, 1), mk(5, 0)];
  const late = mk(10, 0);
  const a = L.scoreAsOf(L.mergeOffers({ rows: [...base, late] }).offers);
  // Offer at day 10 is anchored on 5/6 accepted.
  assert.equal(a[6].prior.n, 6);
  assert.ok(a[6].p > 0.6, `anchored high on 5 of 6 accepts, got ${a[6].p}`);
  // The first five have fewer than 5 prior decisions: the unanchored centre.
  assert.equal(a[0].prior.n, 0);
  assert.equal(a[0].p, a[4].p);
  // Flipping a LATER outcome never changes an earlier offer's score.
  const b = L.scoreAsOf(L.mergeOffers({ rows: [...base, { ...late, status: 'accepted' }] }).offers);
  assert.deepEqual(b.slice(0, 6).map(o => o.p), a.slice(0, 6).map(o => o.p));
  // An earlier-proposed offer answered AFTER this one was proposed does not count.
  const slow = mk(9, 1, 11);
  const c = L.scoreAsOf(L.mergeOffers({ rows: [...base, slow, late] }).offers);
  assert.equal(c[7].prior.n, 6, 'the day-9 offer was only answered on day 11');
});

// -------------------------------------------------------- sequential rule
function offers(n, { truth, model, seed = 5, managers = 8 }) {
  const rand = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const t = truth(i, rand);
    return { league_id: 1, counterparty_team_id: String(i % managers), proposed_at: iso(Math.floor(i / 4), i % 4),
      model_p_accept: model(t, i, rand), status: rand() < t ? 'accepted' : 'declined' };
  });
}

test('a clearly overconfident model is flagged failing at small n when the evidence is strong', () => {
  // Says 95% on every offer; about 20% are accepted.
  const r = E1.grade(offers(24, { truth: () => 0.2, model: () => 0.95 }));
  assert.equal(r.status, 'failing', JSON.stringify(r.detail.why ?? r.needs_text));
  assert.ok(r.n < 50, 'decided well before the old fixed n = 50');
  assert.ok(r.ci_high < 0);
  assert.ok(r.detail.e_value_model_worse > 20, 'e-value against the model exceeds 1/alpha');
  assert.ok(r.detail.why.some(w => /log loss/.test(w)));
});

test('a coin-flip-level difference stays not_enough_data, with its evidence', () => {
  const r = E1.grade(offers(400, { truth: () => 0.5, model: (t, i, rand) => 0.5 + (rand() - 0.5) * 0.04 }));
  assert.equal(r.status, 'not_enough_data', JSON.stringify(r.detail.why));
  assert.ok(r.ci_low < 0 && r.ci_high > 0, 'the CS covers 0');
  assert.ok(r.needs_n >= 1 && /^needs \d+ more offers/.test(r.needs_text));
  assert.ok(Number.isFinite(r.detail.e_value_model_better) && Number.isFinite(r.detail.e_value_model_worse));
});

test('no offers at all: says how many offers the rule needs before anything can be decided', () => {
  const r = E1.grade([], { reason: 'source table trade_outcomes is not built yet' });
  assert.equal(r.status, 'not_enough_data');
  const floor = E1.minOffersToDecide();
  assert.ok(floor > 1 && floor < 50, `floor ${floor}`);
  assert.equal(r.needs_n, floor);
  assert.match(r.needs_text, new RegExp(`^needs ${floor} more offers \\(source table trade_outcomes`));
});

// ------------------------------------------------------ the instruments
test('confidence sequence: covers the mean, narrows with n, and is valid at every n', () => {
  const rand = rng(9);
  const xs = Array.from({ length: 2000 }, () => (rand() < 0.3 ? 1 : 0));
  const small = confidenceSequence(xs.slice(0, 100), { lo: 0, hi: 1, ref: 0.5 });
  const big = confidenceSequence(xs, { lo: 0, hi: 1, ref: 0.5 });
  assert.ok(small.lower < 0.3 && small.upper > 0.3);
  assert.ok(big.lower < 0.3 && big.upper > 0.3);
  assert.ok(big.upper - big.lower < small.upper - small.lower);
  assert.ok(big.e_below > 20, 'strong evidence the mean is below 0.5');
  assert.throws(() => confidenceSequence([2], { lo: 0, hi: 1 }), /outside the declared range/);
  assert.equal(minDecisiveN({ lo: 0, hi: 1, ref: 0.5 }) < 20, true);
});

test('confidence sequence: repeated peeking at a true null rarely excludes it (Ville)', () => {
  let excluded = 0;
  for (let s = 0; s < 40; s += 1) {
    const rand = rng(1000 + s);
    const xs = Array.from({ length: 300 }, () => (rand() < 0.5 ? 1 : 0));
    const cs = confidenceSequence(xs, { lo: 0, hi: 1, ref: 0.5 });
    if (cs.lower > 0.5 || cs.upper < 0.5) excluded += 1;
  }
  assert.ok(excluded <= 4, `excluded the true mean on ${excluded} of 40 runs`);
});

test('hierarchical calibration: slope ~1 on honest p; a 3-offer manager is shrunk toward 0', () => {
  const rand = rng(17);
  const p = []; const y = []; const g = [];
  for (let i = 0; i < 600; i += 1) {
    const q = 0.05 + 0.9 * rand();
    p.push(q); y.push(rand() < q ? 1 : 0); g.push(`m${i % 10}`);
  }
  // A small manager whose 3 offers all went against the model.
  for (let i = 0; i < 3; i += 1) { p.push(0.9); y.push(0); g.push('tiny'); }
  const h = hierCalibration(p, y, g);
  assert.ok(h.slope > 0.8 && h.slope < 1.2, `slope ${h.slope}`);
  assert.ok(h.slope_se > 0 && h.slope_se < 0.25);
  const tiny = h.managers.find(m => m.key === 'tiny');
  assert.equal(tiny.n, 3);
  assert.ok(Math.abs(tiny.offset) < 1.5, `unpooled this would be about -4 on the logit scale; got ${tiny.offset}`);
  assert.equal(hierCalibration([0.3, 0.4], [0, 0], ['a', 'b']), null, 'all one class: no curve, not a slope of 1');
});

test('only the anytime-valid rule can fail E1: an inverted model at n = 12 warns on slope but is not yet failing', () => {
  const rows = offers(12, { truth: (i, rand) => 0.05 + 0.9 * rand(), model: t => 1 - t });
  const r = E1.grade(rows);
  assert.equal(r.status, 'not_enough_data');
  assert.match(r.detail.slope_warning, /not anytime-valid/);
});
