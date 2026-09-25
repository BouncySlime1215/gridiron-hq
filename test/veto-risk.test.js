/**
 * VETO-RISK (batch D item 24): P(veto) for an accepted deal from the league's own
 * review history, folded into P(complete) in SHADOW only.
 *
 * Fixtures only: made-up teams, ESPN-style ids and numbers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const V = await import('../server/services/veto-risk.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { buildPlansFile } = await import('../scripts/campaign/produce-plans.mjs');

const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T12:00:00Z');
let seq = 0;
const trade = (from, to, ids) => ids.map(playerId => ({ type: 'TRADE', playerId, fromTeamId: from, toTeamId: to }));

/**
 * One offer's rows as ESPN writes them: the proposal, the partner's answer (EXECUTE), then on an
 * accepted deal the league's PROCESS row under the proposer (EXECUTED landed, CANCELED killed),
 * with the review votes in between.
 */
function offer({ from = 1, to = 2, give = [101], get = [201], day = 0, answer = 'accept', settle = 'landed', vetoes = 0, upholds = 0 } = {}) {
  const id = `p${++seq}`;
  const at = T0 + day * DAY;
  const items = JSON.stringify([...trade(from, to, give), ...trade(to, from, get)]);
  const r = [{ tx_id: id, type: 'TRADE_PROPOSAL', execution_type: 'EXECUTE', status: 'PENDING', team_id: from,
    related_tx_id: null, proposed_at: at, processed_at: null, items_json: items }];
  if (answer === 'decline') {
    r.push({ tx_id: `${id}d`, type: 'TRADE_DECLINE', execution_type: 'EXECUTE', status: 'EXECUTED', team_id: to,
      related_tx_id: id, proposed_at: at + 3600e3, processed_at: null, items_json: '[]' });
    return r;
  }
  r.push({ tx_id: `${id}a`, type: 'TRADE_ACCEPT', execution_type: 'EXECUTE', status: 'EXECUTED', team_id: to,
    related_tx_id: id, proposed_at: at + 3600e3, processed_at: null, items_json: '[]' });
  for (let i = 0; i < vetoes; i++) r.push({ tx_id: `${id}v${i}`, type: 'TRADE_VETO', execution_type: 'EXECUTE', status: 'EXECUTED',
    team_id: 3 + i, related_tx_id: id, proposed_at: at + 7200e3, processed_at: null, items_json: '[]' });
  for (let i = 0; i < upholds; i++) r.push({ tx_id: `${id}u${i}`, type: 'TRADE_UPHOLD', execution_type: 'EXECUTE', status: 'EXECUTED',
    team_id: 7 + i, related_tx_id: id, proposed_at: at + 7200e3, processed_at: null, items_json: '[]' });
  if (settle === 'landed' || settle === 'killed') {
    r.push({ tx_id: `${id}p`, type: 'TRADE_ACCEPT', execution_type: 'PROCESS', status: settle === 'landed' ? 'EXECUTED' : 'CANCELED',
      team_id: from, related_tx_id: id, proposed_at: at + 3600e3, processed_at: at + DAY + 3600e3, items_json: items });
  }
  return r;
}

test('flag: off by default; "shadow" or "1" is shadow; "on" is refused down to shadow until graded', () => {
  assert.equal(V.vetoRiskFlag({}).mode, 'off');
  assert.equal(V.vetoRiskFlag({ GRIDIRON_VETO_RISK: '0' }).mode, 'off');
  assert.equal(V.vetoRiskFlag({ GRIDIRON_VETO_RISK: '1' }).mode, 'shadow');
  assert.equal(V.vetoRiskFlag({ GRIDIRON_VETO_RISK: 'shadow' }).mode, 'shadow');
  const on = V.vetoRiskFlag({ GRIDIRON_VETO_RISK: 'on' });
  assert.equal(on.mode, 'shadow');
  assert.match(on.note, /not graded/);
  // The preview switch never turns it on (plan rule: only its own flag).
  assert.equal(V.vetoRiskFlag({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }).mode, 'off');
});

test('history: an accepted offer settles landed or vetoed; declines, open reviews and non-veto cancels are not labels', () => {
  const rows = [
    ...offer({ settle: 'landed', upholds: 2 }),
    ...offer({ settle: 'killed', vetoes: 5 }),
    ...offer({ settle: 'open' }),
    ...offer({ answer: 'decline' }),
    ...offer({ settle: 'killed', vetoes: 0 }),
  ];
  const h = V.decidedDeals(rows);
  assert.deepEqual(h.counts, { accepted: 4, landed: 1, vetoed: 1, in_review: 1, canceled_other: 1 });
  assert.deepEqual(h.deals.map(d => d.outcome), ['landed', 'vetoed']);
  assert.equal(h.deals[1].veto_votes, 5);
  assert.equal(h.deals[0].uphold_votes, 2);
  assert.equal(h.deals[0].proposer, '1');
});

test('history: an accepted offer with no PROCESS row but veto votes at the threshold counts as vetoed', () => {
  const rows = offer({ settle: 'open', vetoes: 4 });
  assert.equal(V.decidedDeals(rows, { votesRequired: 4 }).counts.vetoed, 1);
  assert.equal(V.decidedDeals(rows, { votesRequired: 5 }).counts.in_review, 1);
});

test('skew: market value the proposer sends over what comes back, absolute percent; unpriced -> null', () => {
  const [p] = offer({ give: [101, 102], get: [201] });
  const price = new Map([[101, 30], [102, 10], [201, 32]]);
  assert.equal(V.dealSkewPct(JSON.parse(p.items_json), 1, id => price.get(id)), 25);
  assert.equal(V.dealSkewPct(JSON.parse(p.items_json), 1, () => undefined), null);
  assert.equal(V.dealSkewPct([], 1, id => price.get(id)), null);
});

test('fit: base rate is the Beta(1,1)-smoothed veto share; skew buckets shrink to it with k pseudo-counts', () => {
  const deals = [
    ...Array.from({ length: 6 }, () => ({ outcome: 'landed', skew_pct: 5 })),
    ...Array.from({ length: 2 }, () => ({ outcome: 'vetoed', skew_pct: 40 })),
    { outcome: 'vetoed', skew_pct: 3 }, { outcome: 'landed', skew_pct: null },
  ];
  const t = V.fitVeto(deals, { votesRequired: 5, otherOwners: 8 });
  assert.equal(t.n, 10);
  assert.equal(t.vetoed, 3);
  assert.equal(t.fitted, false);
  assert.ok(Math.abs(t.base.p - (3 + 1) / (10 + 2)) < 1e-12);
  // high bucket: 2 of 2 vetoed, shrunk toward the base with k = 4
  const k = V.VETO_MODEL.bucket_k;
  assert.ok(Math.abs(t.high.p - (2 + k * t.base.p) / (2 + k)) < 1e-12);
  assert.ok(Math.abs(t.low.p - (1 + k * t.base.p) / (7 + k)) < 1e-12);
  assert.equal(V.pVeto(t, { skewPct: 50 }).basis, 'skew_high');
  assert.equal(V.pVeto(t, { skewPct: 2 }).basis, 'skew_low');
  assert.equal(V.pVeto(t, { skewPct: null }).basis, 'base');
  assert.ok(V.pVeto(t, { skewPct: 50 }).p > V.pVeto(t, { skewPct: 2 }).p);
});

test('fit: a threshold the other owners cannot reach makes a veto impossible (p = 0), and says so', () => {
  const t = V.fitVeto([{ outcome: 'vetoed', skew_pct: 50 }], { votesRequired: 9, otherOwners: 8 });
  const r = V.pVeto(t, { skewPct: 50 });
  assert.equal(r.p, 0);
  assert.equal(r.basis, 'unreachable');
});

test('fit: no history -> the prior mean, with n 0 printed (a guess says it is a guess)', () => {
  const t = V.fitVeto([], { votesRequired: 5, otherOwners: 8 });
  assert.equal(t.n, 0);
  assert.equal(V.pVeto(t, { skewPct: 10 }).p, 0.5);
  assert.match(t.label, /guess/i);
});

test('grade: forward-only; each deal is scored only on deals decided before it; verdict follows the pre-registered bar', () => {
  // 30 deals: lopsided ones get vetoed, fair ones land. The skew arm should beat the base arm; both beat p = 0.
  const deals = Array.from({ length: 30 }, (_, i) => {
    const lopsided = i % 3 === 0;
    return { decided_at: T0 + i * DAY, outcome: lopsided ? 'vetoed' : 'landed', skew_pct: lopsided ? 45 : 4 };
  });
  const g = V.gradeVeto(deals, { votesRequired: 5, otherOwners: 8 });
  assert.equal(g.n_scored, 30 - V.VETO_MODEL.min_prior);
  assert.ok(g.arms.base.brier < g.arms.none.brier);
  assert.ok(g.arms.skew.brier < g.arms.base.brier);
  assert.equal(g.verdict, 'passing');
  assert.equal(g.pick, 'skew');
  // The first scored deal saw only min_prior deals: forward-only, never the future.
  assert.equal(g.rows[0].prior_n, V.VETO_MODEL.min_prior);
});

test('grade: too few decided deals -> not_enough_data, never a pass', () => {
  const deals = Array.from({ length: 8 }, (_, i) => ({ decided_at: T0 + i * DAY, outcome: i % 2 ? 'vetoed' : 'landed', skew_pct: 10 }));
  const g = V.gradeVeto(deals, { votesRequired: 5, otherOwners: 8 });
  assert.equal(g.verdict, 'not_enough_data');
  assert.equal(g.pick, null);
});

test('grade: a league that never vetoes -> modelling a veto does not beat p = 0 -> failing', () => {
  const deals = Array.from({ length: 20 }, (_, i) => ({ decided_at: T0 + i * DAY, outcome: 'landed', skew_pct: 10 }));
  const g = V.gradeVeto(deals, { votesRequired: 5, otherOwners: 8 });
  assert.equal(g.verdict, 'failing');
});

const table = V.fitVeto([
  ...Array.from({ length: 5 }, () => ({ outcome: 'landed', skew_pct: 4 })),
  ...Array.from({ length: 5 }, () => ({ outcome: 'vetoed', skew_pct: 40 })),
], { votesRequired: 5, otherOwners: 8 });

test('shadow: every plan gets p_complete x (1 - p_veto) per step beside the served p_complete, never replacing it', () => {
  const plan = { p_complete: 0.3 * 0.5, expected: 1, steps: [
    { team: 2, give: ['a'], get: ['b'], p: 0.3 }, { team: 3, give: ['c'], get: ['d'], p: 0.5 }] };
  const value = new Map([['a', 10], ['b', 10], ['c', 30], ['d', 10]]);
  const before = structuredClone(plan);
  const s = V.vetoShadow({ table, valueOf: id => value.get(id) }, { best: plan, deck: [{ plan }] });
  assert.deepEqual(plan, before, 'the served plan is not mutated');
  assert.equal(s.lane, 'shadow');
  assert.equal(s.fitted, false);
  const row = s.best;
  assert.equal(row.p_complete, plan.p_complete);
  assert.equal(row.steps[0].skew_pct, 0);
  assert.equal(row.steps[1].skew_pct, 200);
  const want = 0.3 * (1 - row.steps[0].p_veto) * 0.5 * (1 - row.steps[1].p_veto);
  assert.ok(Math.abs(row.p_complete_with_veto - want) < 1e-12);
  assert.ok(row.p_complete_with_veto < row.p_complete);
  assert.equal(s.deck.length, 1);
  assert.equal(s.history.n, 10);
});

test('shadow: no plan -> best null, deck empty; no table -> status not_read', () => {
  assert.equal(V.vetoShadow({ table, valueOf: () => 1 }, { best: null, deck: [] }).best, null);
  assert.equal(V.vetoShadow(null, { best: null }).status, 'not_read');
});

const AS_OF = '2026-09-28T12:00:00.000Z';
const produce = adapter => buildPlansFile([{ id: 99, load: async () => ({ adapter }) }], { generated_at: AS_OF, clock: () => 0 });

test('producer: flag off (no adapter.vetoRisk) -> no veto_risk key at all', async () => {
  const [l] = (await produce(makeAdapter())).leagues;
  assert.equal(l.error ?? null, null);
  assert.equal('veto_risk' in l._run.inputs, false);
  assert.doesNotMatch(JSON.stringify(l), /"veto_risk"/);
});

test('producer: shadow -> only _run.inputs.veto_risk is added; no served number moves', async () => {
  const off = (await produce(makeAdapter())).leagues[0];
  // A league that vetoes everything: if the shadow leaked, every p_complete would fall.
  const harsh = V.fitVeto(Array.from({ length: 20 }, () => ({ outcome: 'vetoed', skew_pct: 1 })), { votesRequired: 5, otherOwners: 8 });
  const on = (await produce(Object.assign(makeAdapter(), { vetoRisk: { table: harsh, valueOf: () => 10 } }))).leagues[0];
  assert.equal(on._run.inputs.veto_risk.lane, 'shadow');
  const strip = e => { const c = structuredClone(e); delete c._run; return c; };
  assert.deepEqual(strip(on), strip(off), 'shadow: no served number moves');
  delete on._run.inputs.veto_risk;
  assert.deepEqual(on._run, off._run);
});
