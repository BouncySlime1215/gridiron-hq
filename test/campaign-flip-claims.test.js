/**
 * FLIP-CLAIMS (Nick 2026-09-25): in SEARCH-WIDE a free-agent waiver claim is a step only as a flip
 * piece. Pre-registration: docs/tdd/2026-09-25-flip-claims.tdd.md (F1-F9; F1 and F8 live in
 * test/campaign-search-wide.test.js W5 / W8, F9 in test/rule-fuzz.test.js).
 * Made-up four-team league (test/fixtures/campaign-league.mjs); no DB, no simulation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { makeAdapter, makePlayers } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { makeScorer, playerValues, searchTarget, overpayPct } = await import('../server/services/campaign/search.js');
const { pathExpectation } = await import('../server/services/campaign/paths.js');
const wide = await import('../server/services/campaign/search-wide.js');

const { SEARCH_WIDE_ENV, FREE_AGENT, makeDropOk, pickDrop, claimRule, strandedBranch, claimPoolOf, newWideSink,
  WIDE_DEFAULTS, CLAIM_DROP_REASONS } = wide;
const ON = { [SEARCH_WIDE_ENV]: '1' };
const OBJ = normaliseObjective({ risk_mode: 'balanced' });
const WAIVERS = { won: 22, lost: 7 };
const CLAIM_P = +(23 / 31).toFixed(4);

/** Depth pieces (scored below 83); everyone else is a Blue chip (90). */
const DEPTH = new Set(['4', '6', '7', '14', '15', '24', '25', '34', '35', '41', '45']);
const scoreFrom = (depth = DEPTH) => id => ({ score: depth.has(String(id)) ? 70 : 90, label: 'fixture' });
const FA = (id, value, power, position = 'WR') => ({ id, name: `P${id}`, position, value, power, ros_ppg: power, injury: 0, bye: null, trend_kind: null });

/** Nick's bench is 6 (RB, FC 1500) and 7 (WR, FC 1300); free agent 45 (WR, FC 2500) can be flipped for P21 (FC 2600). */
const flipLeague = ({ pool = ['45'], extra = [FA(45, 2500, 7)], scoreOf = scoreFrom(), maxOverpay = Infinity } = {}) => {
  const players = makePlayers();
  for (const p of extra) players.set(p.id, p);
  const a = makeAdapter({ players });
  a.freeAgents = extra.map(p => ({ id: p.id, name: p.name, position: p.position, ros_ppg: p.ros_ppg }));
  a.claimUniverse = new Set(pool);
  a.scoreOf = scoreOf;
  a.waiverRecord = WAIVERS;
  a.maxOverpay = maxOverpay;
  return a;
};
const val = a => id => a.players.get(Number(id))?.value ?? a.players.get(id)?.value ?? null;
const claimsOf = plans => plans.filter(p => p.steps.some(st => st.claim));
const searchAll = (a, { maxOverpay = Infinity, targets = [11, 21, 31] } = {}) => {
  const S = makeScorer(a.world(a.seed), a);
  const vals = playerValues(S, a, OBJ);
  const sink = newWideSink(WIDE_DEFAULTS);
  const w = { candidates: 100000, rescoresLeft: () => Infinity, beam: WIDE_DEFAULTS.beam, tierOk: id => (a.scoreOf(id)?.score ?? 0) >= 83,
    dropOk: makeDropOk({ scoreOf: a.scoreOf, floor: 83 }), claimPool: claimPoolOf(a), claimP: CLAIM_P, sink };
  return targets.flatMap(t => searchTarget(S, a, vals, OBJ, t, { maxOverpay, wide: w }));
};
const ctxOf = (a, over = {}) => ({ dropOk: makeDropOk({ scoreOf: a.scoreOf, floor: 83 }), valueOf: val(a), maxOverpay: 0, sold: new Set(), ...over });
const claim = (drop, add) => ({ team: FREE_AGENT, claim: true, give: [drop], get: [add], p: CLAIM_P });
const trade = (team, give, get) => ({ team, give, get, p: 0.5 });

/* --------------------------------------------------- F2: claim_not_flipped */

test('F2: a claimed player never given on drops the path (claim_not_flipped); flipped passes', () => {
  const a = flipLeague();
  const ctx = ctxOf(a);
  assert.equal(claimRule([claim(7, 45), trade('3', [45], [21])], ctx), null, 'flipped straight for the target');
  assert.equal(claimRule([claim(7, 45), trade('2', [45], [13]), trade('3', [13, 4], [21])], ctx), null, 'flipped as a chip');
  assert.equal(claimRule([trade('3', [3], [21]), claim(7, 45)], ctx), 'claim_not_flipped', 'a claim ending the path');
  assert.equal(claimRule([claim(7, 45), trade('3', [3], [21])], ctx), 'claim_not_flipped', 'claimed, then kept');
  assert.equal(claimRule([trade('3', [3], [21])], ctx), null, 'no claim, nothing to check');
  const res = planLeague(flipLeague(), { objective: OBJ, env: ON });
  assert.deepEqual(Object.keys(res.search_wide.claims.dropped_by_reason), [...CLAIM_DROP_REASONS]);
  assert.equal(res.search_wide.claims.dropped_by_reason.claim_not_flipped, 0, 'the search builds only flipped claims');
});

test('F2: gets-floor.js#isFlipPieceClaim is the one flip-piece rule (shared with FLIP-STRANDED #432)', async () => {
  const { isFlipPieceClaim } = await import('../server/services/campaign/gets-floor.js');
  const c = claim(7, 45);
  const direct = [c, trade('3', [45], [21])];
  assert.equal(isFlipPieceClaim(c, direct), true);
  assert.equal(isFlipPieceClaim(c, { steps: direct }), true, 'a plan carrying steps');
  assert.equal(isFlipPieceClaim(c, [c, trade('2', [45], [13]), trade('3', [13], [21])]), true, 'flipped as a chip');
  assert.equal(isFlipPieceClaim(c, [c, trade('3', [3], [21])]), false, 'claimed and kept');
  assert.equal(isFlipPieceClaim(c, [trade('3', [45], [21]), c]), false, 'given before it was claimed');
  assert.equal(isFlipPieceClaim(c, [c, { ...claim(45, 41) }]), false, 'a later claim\'s drop is not a flip');
  assert.equal(isFlipPieceClaim(trade('3', [45], [21]), direct), false, 'not a claim');
  assert.equal(isFlipPieceClaim({ ...c }, direct), false, 'a step not in the path fails closed');
  assert.equal(isFlipPieceClaim(c, null), false);
});

/* ----------------------------------------------------- F3: protected drop */

test('F3: the drop is never 160 / 80 / 277, an untouchable, a Blue chip or unscored (protected_drop)', () => {
  const a = flipLeague({ scoreOf: id => (String(id) === '8' ? null : { score: new Set(['7', '160', '80', '277', '9', '19']).has(String(id)) ? 70 : 90 }) });
  for (const id of [160, 80, 277]) a.players.set(id, FA(id, 100, 1));
  const ctx = ctxOf(a, { dropOk: makeDropOk({ scoreOf: a.scoreOf, floor: 83, untouchable: new Set(['9', '19']) }), maxOverpay: Infinity });
  const path = d => [claim(d, 45), trade('3', [45], [21])];
  assert.equal(claimRule(path(7), ctx), null);
  for (const d of [160, 80, 277]) assert.equal(claimRule(path(d), ctx), 'protected_drop', `${d} pinned`);
  assert.equal(claimRule(path(9), ctx), 'protected_drop', 'an untouchable (notes)');
  assert.equal(claimRule(path(19), ctx), 'protected_drop', 'an objectives-file untouchable');
  assert.equal(claimRule(path(1), ctx), 'protected_drop', 'a Blue chip (90)');
  assert.equal(claimRule(path(8), ctx), 'protected_drop', 'unscored fails closed');
  // The planner: an objectives-file untouchable on the bench is never the drop.
  const b = flipLeague();
  const res = planLeague(b, { objective: normaliseObjective({ risk_mode: 'balanced', untouchables: ['7', '6'] }), env: ON });
  const drops = (res.search_wide.claims.paths ?? []).map(p => p.steps.find(st => st.claim).give[0]);
  assert.ok(!drops.some(d => d === '7' || d === '6'), `dropped an untouchable: ${drops}`);
});

/* ------------------------------------------------ F4: lowest-value bench drop */

test('F4: pickDrop takes the lowest-value droppable bench player; a starter only when no bench player is droppable', () => {
  const a = flipLeague();
  const roster = a.rosters.get('1');
  const base = { roster, add: 45, valueOf: val(a), starters: a.starters, maxOverpay: Infinity };
  const dropOk = makeDropOk({ scoreOf: a.scoreOf, floor: 83 });
  assert.equal(pickDrop({ ...base, dropOk }), 7, 'bench 7 (1300) before bench 6 (1500), starter 4 never while bench is droppable');
  assert.equal(pickDrop({ ...base, dropOk: id => id === 6 || id === 4 }), 6, 'bench 6 over the cheaper starter 4');
  assert.equal(pickDrop({ ...base, dropOk: id => id === 4 }), 4, 'no bench piece droppable: the starter');
  assert.equal(pickDrop({ ...base, dropOk, acquired: new Set(['7']) }), 6, 'never a player acquired on the path');
  assert.equal(pickDrop({ ...base, dropOk: () => false }), null);
  assert.equal(pickDrop({ ...base, dropOk, maxOverpay: 0, add: 41 }), null, 'cap 0: no drop worth <= a 500 free agent');
  // The search uses it: every built claim drops 7 here.
  const plans = claimsOf(searchAll(flipLeague()));
  assert.ok(plans.length > 0);
  for (const p of plans) assert.equal(p.steps[0].give[0], 7);
});

/* --------------------------------------------------------- F5: overpay */

test('F5: cap 0: the drop is counted against the claimed player, the flipped player against what comes back', () => {
  const a = flipLeague({ extra: [FA(45, 2500, 7), FA(41, 500, 9.5)], pool: ['45', '41'] });
  const ctx = ctxOf(a);
  assert.equal(claimRule([claim(7, 41), trade('3', [41, 3], [21])], ctx), 'claim_overpay', 'drop 1300 for a 500 claim');
  assert.equal(claimRule([claim(7, 45), trade('3', [45], [21])], ctx), null, 'drop 1300 for a 2500 claim');
  const noFc = flipLeague({ extra: [FA(45, null, 7)] });
  assert.equal(claimRule([claim(7, 45), trade('3', [45], [21])], ctxOf(noFc)), 'no_fc_value', 'unpriced claim fails closed');
  // The search at cap 0 builds neither an overpaying claim nor an overpaying flip.
  const plans = claimsOf(searchAll(a, { maxOverpay: 0 }));
  assert.ok(plans.length > 0, 'claims still found at cap 0');
  const v = val(a);
  const sum = ids => ids.reduce((s, id) => s + v(id), 0);
  for (const p of plans) {
    for (const st of p.steps) {
      if (st.depth_premium) continue;
      assert.ok(overpayPct(sum(st.give), sum(st.get)) <= 1e-9, `${st.claim ? 'claim' : 'flip'} step overpays: ${st.give} for ${st.get}`);
    }
    assert.notEqual(String(p.steps[0].get[0]), '41', 'the 500 free agent is never claimed for a 1300 drop');
  }
});

/* --------------------------------------------------------- F6: stranded */

test('F6: kept claim paths beat doing nothing on the confirm dice with the stranded branch priced in', () => {
  const res = planLeague(flipLeague(), { objective: OBJ, env: ON });
  const c = res.search_wide.claims;
  assert.ok(c.kept > 0, `a flip claim survives: ${JSON.stringify(c.dropped_by_reason)}`);
  for (const p of c.paths) {
    assert.equal(p.dice, 'confirm');
    assert.ok(p.expected > 0);
    assert.ok(Math.abs(pathExpectation(p.steps).expected - p.expected) < 1e-12, 'the expected is the steps\' own (stranded branch included)');
    assert.ok(p.stranded_branch && p.stranded_branch.prob > 0, 'the stranded branch is reported');
  }
  // Drop a player who starts (RB 2, power 15): if the flip fails Nick is worse off, and the path goes.
  const hurt = flipLeague({ scoreOf: scoreFrom(new Set(['2'])) });
  const r2 = planLeague(hurt, { objective: OBJ, env: ON });
  const c2 = r2.search_wide.claims;
  assert.equal(c2.kept, 0, `no claim path kept: ${JSON.stringify(c2.paths)}`);
  assert.ok(c2.dropped_by_reason.claim_stranded + c2.dropped_by_reason.mode_tolerance > 0, JSON.stringify(c2.dropped_by_reason));
  if (c2.dropped_by_reason.claim_stranded) {
    assert.equal(c2.best_stranded.why, 'claim_stranded', 'the closest loser is reported (shadow)');
    assert.ok(!(c2.best_stranded.expected > 0) || c2.best_stranded.dice === 'confirm');
  }
});

test('F6: strandedBranch is the claim-done, flip-declined outcome', () => {
  const steps = [{ ...claim(7, 45), p: 0.8, delta: -0.01 }, { ...trade('3', [45], [21]), p: 0.25, delta: 0.05 }];
  const b = strandedBranch(steps);
  assert.ok(Math.abs(b.prob - 0.8 * 0.75) < 1e-12);
  assert.equal(b.delta, -0.01);
  const chip = [{ ...claim(7, 45), p: 0.8, delta: -0.01 }, { ...trade('2', [45], [13]), p: 0.5, delta: 0.0 }, { ...trade('3', [13], [21]), p: 0.5, delta: 0.05 }];
  assert.ok(Math.abs(strandedBranch(chip).prob - 0.8 * 0.5) < 1e-12, 'only until the claimed player is flipped');
  assert.equal(strandedBranch([trade('3', [3], [21])]), null);
});

/* ------------------------------------------------------------ F7: sold */

test('F7: a player Nick sold this season, and 290, are never claimed', () => {
  const a = flipLeague({ extra: [FA(45, 2500, 7), FA(290, 2500, 7)], pool: ['45', '290'] });
  assert.deepEqual(claimPoolOf(a, new Set(), new Set(['45'])).map(f => f.id), [], 'sold 45 and pinned 290 both out');
  const ctx = ctxOf(a, { sold: new Set(['45']) });
  assert.equal(claimRule([claim(7, 45), trade('3', [45], [21])], ctx), 'claim_sold');
  assert.equal(claimRule([claim(7, 290), trade('3', [290], [21])], ctxOf(a)), 'claim_sold');
  // The planner reads the season ledger: 45 sold by Nick earlier this season is out of the pool.
  const b = flipLeague();
  b.tradeLedger = { now: Date.parse('2026-09-25T00:00:00Z'), valueAt: () => 2500,
    trades: [{ tx_id: 't1', at: Date.parse('2026-09-10T00:00:00Z'), moves: [{ player: 45, from: '1', to: '2' }] }] };
  const res = planLeague(b, { objective: OBJ, env: ON });
  assert.equal(res.search_wide.claims.pool, 0);
  assert.equal(res.search_wide.claims.kept, 0);
});

/* ------------------------------------- #435 budget fix: rescores per target, no silent claim skip */

const sumReasons = c => Object.values(c.dropped_by_reason).reduce((s, n) => s + n, 0);

test('budget: the rescore budget is split per target like candidates, and each target reports what bound', () => {
  const a = flipLeague();
  const res = planLeague(a, { objective: OBJ, env: { ...ON, GRIDIRON_SEARCH_WIDE_RESCORES: '40' } });
  const sw = res.search_wide;
  assert.equal(sw.per_target.length, res.targets.length, 'one row per searched target');
  assert.ok(sw.per_target.length >= 2, 'the fixture searches several targets');
  // Shares: each target gets floor(what is left / targets left); none takes the whole budget.
  for (const r of sw.per_target) assert.ok(r.rescores < 40, JSON.stringify(r));
  assert.ok(sw.budget_hits.rescores > 0, `rescore hits counted: ${JSON.stringify(sw.budget_hits)}`);
  assert.equal(sw.budget_hits.rescores + sw.budget_hits.candidates, sw.per_target.filter(r => r.budget_hit).length);
  assert.ok(sw.per_target.some(r => r.budget_hit === 'rescores'));
  assert.equal(sw.budget_hit, sw.per_target.find(r => r.budget_hit)?.budget_hit, 'budget_hit stays the first that bound');
  assert.ok(sw.per_target.every(r => Number.isInteger(r.rescores_used) && Number.isInteger(r.extras)));
});

test('budget: every built claim path is scored or counted by reason (unscored ones under "budget")', () => {
  for (const rescores of ['1', '40', '100000']) {
    const res = planLeague(flipLeague(), { objective: OBJ, env: { ...ON, GRIDIRON_SEARCH_WIDE_RESCORES: rescores } });
    const c = res.search_wide.claims;
    assert.ok(c.built > 0, `claims built at rescores ${rescores}`);
    assert.equal(c.kept + sumReasons(c), c.built, `rescores ${rescores}: ${c.built} built, ${c.kept} kept, ${JSON.stringify(c.dropped_by_reason)}`);
    if (rescores === '1') assert.ok(c.dropped_by_reason.budget > 0, 'a spent budget leaves claims unscored, and says so');
    if (rescores === '100000') assert.equal(c.dropped_by_reason.budget, 0);
  }
});
