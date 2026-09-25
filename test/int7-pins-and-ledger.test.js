/**
 * integration-7: Olave (290) is pinned never-get by id, and the planner fails closed when the league
 * has executed trades this season but its trade ledger is missing or empty. Made-up fixture league only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GRIDIRON_FLIP_LEGS = '1';
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { PINNED_NEVER_GET, PINNED_NEVER_GIVE } = await import('../server/services/campaign/never-give.js');
const { makeAdapter, makePlayers } = await import('./fixtures/campaign-league.mjs');

const MODES = ['safe', 'balanced', 'all_in'];
const S = String;

/** The fixture league with its star WR (11, the natural first target) renumbered as 290. */
function olaveLeague() {
  const players = makePlayers();
  const star = players.get(11);
  players.delete(11);
  players.set(290, { ...star, id: 290, name: 'P290' });
  const a = makeAdapter({ players });
  const r = a.rosters.get('2');
  r.splice(r.indexOf(11), 1, 290); // in place: the fixture world reads this Map
  a.searchOpts = { twoForOne: true, flipLegs: true, fillers: 4 };
  return a;
}

/** Every id Nick would get on any served surface. */
function gets(res) {
  const out = [];
  const plans = [res.best, ...res.deck.map(c => c.plan)].filter(Boolean);
  for (const p of plans) for (const st of p.steps) out.push(...st.get);
  for (const b of res.backups.filter(Boolean)) out.push(...b.step.get);
  for (const m of res.risk_modes) if (m.first_step) out.push(...m.first_step.get);
  for (const f of res.flip.realised) { out.push(f.player); if (f.legs) out.push(...(f.legs.get_b_ids ?? [f.legs.get_b])); }
  for (const f of res.flip.top ?? []) out.push(f.player);
  out.push(...res.targets, ...res.suggestions.map(s => s.player ?? s.target).filter(x => x != null));
  for (const c of res.catch_up) if (c.player != null) out.push(c.player);
  return out.map(S);
}

test('Olave (290) is pinned never-get: never a target, get, filler, flip leg, backup or pick, with no ledger at all', () => {
  assert.deepEqual([...PINNED_NEVER_GET], ['290']);
  assert.ok(!PINNED_NEVER_GIVE.includes('290'));
  let served = 0;
  for (const mode of MODES) {
    const a = olaveLeague();
    const res = planLeague(a, { objective: normaliseObjective({ risk_mode: mode }) });
    served += res.deck.length;
    assert.ok(!gets(res).includes('290'), `${mode}: 290 served as a get`);
    // Asked for by name, he is refused.
    const named = planLeague(olaveLeague(), { objective: normaliseObjective({ risk_mode: mode, target: 290 }) });
    assert.ok(!gets(named).includes('290'), `${mode}: 290 served when named`);
  }
  assert.ok(served > 0, 'the league still plans moves');
  // Teeth: the same player under another id (the fixture's 11) is a target.
  const plain = planLeague(makeAdapter(), { objective: normaliseObjective({ risk_mode: 'balanced' }) });
  assert.ok(plain.targets.map(S).includes('11'));
});

test('fail closed: executed trades this season but no ledger (or an empty one) -> no move, and the reason says so', () => {
  for (const ledger of [null, { now: 0, trades: [], unmapped: 2, valueAt: () => null }]) {
    for (const mode of MODES) {
      const a = Object.assign(makeAdapter(), { executedTradeRows: 3, tradeLedger: ledger });
      const res = planLeague(a, { objective: normaliseObjective({ risk_mode: mode }) });
      assert.equal(res.best, null, `${mode}: a move served without trade memory`);
      assert.equal(res.deck.length, 0);
      assert.equal(res.flip.realised.length, 0);
      assert.equal(res.trade_memory.status, 'ledger_missing');
      assert.ok(res.trade_ledger_missing.targets >= 1);
      const entry = toEntry(res, { names: a.names(), as_of: '2026-09-24T00:00:00Z' });
      assert.ok(entry._run.dropped_by_reason.trade_ledger_missing >= 1);
      assert.match(entry.next_move.reason, /trade ledger could not be read/);
    }
  }
  // No executed trades (or GRIDIRON_TRADE_MEMORY=0, loudly): the planner plans as before.
  const none = planLeague(Object.assign(makeAdapter(), { executedTradeRows: 0, tradeLedger: null }), { objective: normaliseObjective({ risk_mode: 'balanced' }) });
  assert.ok(none.best, 'no trades this season: moves are served');
  assert.equal(none.trade_ledger_missing, undefined);
  const off = planLeague(Object.assign(makeAdapter(), { executedTradeRows: 3, tradeLedger: null }),
    { objective: normaliseObjective({ risk_mode: 'balanced' }), env: { GRIDIRON_TRADE_MEMORY: '0' } });
  assert.ok(off.best);
  assert.equal(off.trade_memory.status, 'off');
});
