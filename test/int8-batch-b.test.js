/**
 * integration-8 (Batch B) combined review: properties that only show up when the Batch B units run
 * together (RISK-RULE #389, NEGOTIATOR-DEFAULTS #386, LADDER-01 #394, LIVE-BLEND #404 on PYES-ONE #384).
 * Made-up leagues only (test/fixtures/rule-fuzz-league.mjs); the oracle is RULE-FUZZ's
 * (test/fixtures/nick-rules.mjs), which reads only what the planner returns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { BLEND_BASIS } = await import('../server/services/p-yes.js');
const { makeFuzzLeague } = await import('./fixtures/rule-fuzz-league.mjs');

/** Every Batch B planner flag on (LIVE-BLEND is default on and lives in the adapter's priceStep). */
const BATCH_B_ENV = Object.freeze({ GRIDIRON_RISK_RULE: '1', GRIDIRON_LADDER: '1', GRIDIRON_NEGOTIATOR_DEFAULTS: '1',
  GRIDIRON_PYES_PROBES: '1', GRIDIRON_GETS_FLOOR: '1' });
const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
const plan = (a, mode, env = BATCH_B_ENV) => planLeague(a, { objective: normaliseObjective({ risk_mode: mode }), env });
const S = x => String(x);

/** Every served second package ("Or X for Y"), with the card's planned give at that step. */
function altsOf(res) {
  const out = [];
  for (const c of res.deck ?? []) {
    for (const pb of [c.playbook, ...(c.playbooks ?? [])].filter(Boolean)) {
      const alt = pb.negotiation?.alt_package;
      if (!alt) continue;
      const planned = c.plan.steps[pb.step_index ?? 0]?.give ?? [];
      out.push({ give: alt.give.map(S), planned: planned.map(S) });
    }
  }
  return out;
}

test('LIVE-BLEND x NEGOTIATOR: the second package is gated on its OWN baseline p, not the planned give\'s', () => {
  // Control: the gate p equals the served p (what GRIDIRON_PYES_BLEND=0 serves). Find, per league, a player
  // Nick offers only in a second package (never in that card's planned give).
  const poisonOf = new Map();
  for (const seed of SEEDS) {
    const a = makeFuzzLeague(seed);
    const base = a.priceStep;
    a.priceStep = (t, g, h) => { const r = base(t, g, h); return { ...r, basis: BLEND_BASIS, p_gate: r.p }; };
    for (const alt of altsOf(plan(a, 'balanced'))) {
      const x = alt.give.find(id => !alt.planned.includes(id));
      if (x != null && !poisonOf.has(seed)) poisonOf.set(seed, x);
    }
  }
  assert.ok(poisonOf.size >= 5, `non-vacuous: ${poisonOf.size} leagues serve a second package with a new player`);
  // Poisoned: the baseline says no manager takes any package that holds X (gate p 0); the served p is unchanged.
  // Nick's "beats doing nothing" rule reads the gate p, so no package holding X may be served, second or not.
  let served = 0;
  for (const [seed, x] of poisonOf) {
    const a = makeFuzzLeague(seed);
    const base = a.priceStep;
    // theyGet is what Nick gives (priceStep(team, theyGive, theyGet)).
    a.priceStep = (t, g, h) => { const r = base(t, g, h); return { ...r, basis: BLEND_BASIS, p_gate: h.map(S).includes(x) ? 0 : r.p }; };
    const res = plan(a, 'balanced');
    const bad = altsOf(res).filter(alt => alt.give.includes(x));
    assert.deepEqual(bad, [], `seed ${seed}: a second package giving ${x} was served though its baseline p is 0`);
    served += altsOf(res).length;
  }
  assert.ok(served > 0, 'second packages are still served without X');
});
