/**
 * COUNTERPART-01 (server/services/people/counterpart.js) and its use in the campaign planner, on the
 * made-up four-team league (test/fixtures/campaign-league.mjs) and a fixture chat DB. No real data.
 * Nick is team 1; chat people B2 / B3 / B4 are teams 2 / 3 / 4.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { makeChatDb, richProfile, DAY, T0 } = await import('./fixtures/people-chat.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry, validateEntry } = await import('../server/services/campaign/view.js');
const { readProfiles } = await import('../server/services/people/profile-reader.js');
const cpm = await import('../server/services/people/counterpart.js');
const { buildCounterparts, withCounterparts, wantsLift, wantsDecay, credibility, tradeEvents, stepAdjust,
  WANTS_PRIOR_LOG_LIFT, WANTS_SHRINK_K, M6_REPLY_PRIOR } = cpm;

const NOW = T0 + 2 * DAY;
const IDS = new Map([['2', { chat_name: 'B2' }], ['3', { chat_name: 'B3' }], ['4', { chat_name: 'B4' }]]);
const obj = normaliseObjective({ risk_mode: 'balanced' });
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

/** counterparts for the fixture league from a fixture chat DB. */
function models({ negotiation = [], notes = [], events = [], adapter = makeAdapter() } = {}) {
  const chat = makeChatDb({ negotiation, notes });
  const profiles = readProfiles({ chat, ids: IDS, asOf: NOW, myTeam: '1' });
  chat.close();
  return buildCounterparts({ profiles: profiles.byRoster, players: adapter.players, events, now: NOW });
}
const plan = cps => { const a = makeAdapter(); if (cps) a.counterparts = cps; return planLeague(a, { objective: obj }); };
const stepsOf = res => [res.best, ...res.deck.map(c => c.plan)].filter(Boolean).flatMap(p => p.steps);
const strip = res => JSON.parse(JSON.stringify({ ...res, runtime_ms: 0 }));

test('flag off: no counterparts on the adapter gives today\'s plan, byte for byte', () => {
  assert.deepEqual(strip(plan(null)), strip(plan(undefined)));
  assert.equal('counterpart' in plan(null), false);
});

test('all quiet managers: no chat feature fires; the plan is today\'s, only the M6 anchor moves P(responds)', () => {
  const cps = models({ negotiation: [{ name: 'B2', profile: richProfile(), messages_read: 3 }] });
  assert.ok([...cps.values()].every(c => c.status === 'unknown'));
  const off = plan(null), on = plan(cps);
  assert.deepEqual(on.best.steps.map(({ reason_chain, ...s }) => s), off.best.steps);
  assert.ok(on.best.steps.every(s => s.reason_chain.length === 0));
  for (const p of on.partners) {
    const was = off.partners.find(x => x.team === p.team);
    close(p.p_responds, Math.min(0.95, was.p_responds * (1 - M6_REPLY_PRIOR.ignore) / 0.5));
    assert.deepEqual(p.reason_chain.map(f => f.feature), ['reply_prior']);
  }
  assert.deepEqual(on.playbook[0].reply_prior.ignore, 0.45);
  assert.equal(on.counterpart.models.length, 3);
});

test('wants_player: prior log-lift 2.0, shrunk by n and decayed 7 d -> 21 d', () => {
  close(wantsDecay(0), 1); close(wantsDecay(7), 1); close(wantsDecay(14), 0.5); close(wantsDecay(21), 0); close(wantsDecay(40), 0);
  close(wantsLift(4, 3).lift, WANTS_PRIOR_LOG_LIFT * 4 / (4 + WANTS_SHRINK_K));
  close(wantsLift(1, 14).lift, WANTS_PRIOR_LOG_LIFT * (1 / (1 + WANTS_SHRINK_K)) * 0.5);
  assert.ok(wantsLift(9, 0).lift < WANTS_PRIOR_LOG_LIFT, 'shrunk: never the full prior');
});

test('wants_player feeds package, price, partner order and targets, and is named in the reason chain', () => {
  const at = new Date(NOW - 2 * DAY).toISOString();
  const cps = models({ negotiation: [{ name: 'B4', profile: richProfile({ values_talk: { wants: [{ player: 'P5', at, n: 4 }] } }) }] });
  const a = makeAdapter();
  const A = withCounterparts(a, cps);
  const lift = wantsLift(4, 2).lift;
  const before = a.priceStep('4', [33], [5]).p, after = A.priceStep('4', [33], [5]);
  close(Math.log(after.p / (1 - after.p)) - Math.log(before / (1 - before)), lift, 1e-6);
  assert.equal(after.features[0].feature, 'wants_player');
  assert.equal(after.features[0].fitted, false);
  close(A.priceStep('4', [33], [6]).p, a.priceStep('4', [33], [6]).p);
  // Stale talk (22 days) does nothing.
  const stale = models({ negotiation: [{ name: 'B4', profile: richProfile({ values_talk: { wants: [{ player: 'P5', at: new Date(NOW - 22 * DAY).toISOString(), n: 4 }] } }) }] });
  assert.equal(stale.get('4').wants.size, 0);
  const off = plan(null), on = plan(cps);
  const p4 = res => res.partners.find(p => p.team === '4');
  assert.ok(p4(on).p_responds > p4(off).p_responds * (0.55 / 0.5), 'he wants a player you have: P(responds) up beyond the anchor');
  assert.ok(p4(on).reason_chain.some(f => f.feature === 'wants_player'));
  const s4 = res => res.suggestions.filter(s => s.owner === '4');
  for (const s of s4(on)) assert.ok(s.reason_chain.some(f => f.feature === 'wants_player' && f.effect === 'multiplier'));
  for (const st of stepsOf(on).filter(s => s.team === '4' && s.give.includes(5))) {
    assert.ok(st.reason_chain.some(f => f.feature === 'wants_player'), 'a written step names the feature');
  }
});

test('untouchable talk: credible -> never asked for (target skipped); broken before -> asked, scaled down', () => {
  const profile = richProfile({ values_talk: { untouchable: [{ player: 'P11', at: new Date(T0 - 30 * DAY).toISOString() }] } });
  const off = plan(null);
  assert.ok(off.targets.includes(11) && off.suggestions.some(s => s.player === 11), 'today the star is a target');
  const kept = models({ negotiation: [{ name: 'B2', profile }] });
  // The claim is 30 days old and he still has the player: one kept claim -> credibility 2/3.
  close(kept.get('2').credibility.untouchable.value, 2 / 3);
  const on = plan(kept);
  assert.ok(!on.targets.includes(11));
  // Every upgrade searched (wide budget): the call-site filter, not the top-3 slice, keeps him out.
  const wide = makeAdapter(); wide.counterparts = kept;
  const all = planLeague(wide, { objective: obj, budget: { targets: 50 } });
  assert.ok(!all.targets.includes(11), 'a credible untouchable is never a searched target');
  assert.ok(!stepsOf(all).some(s => s.get.includes(11)));
  close(stepAdjust(kept.get('2'), { team: '2', get: [11], give: [2] }).mult, 0);
  assert.ok(!on.suggestions.some(s => s.player === 11));
  assert.ok(!stepsOf(on).some(s => s.get.includes(11)), 'no written plan asks for an untouchable');
  // He called him untouchable, then traded him away once: broken -> credibility 1/3, asked but scaled.
  const events = tradeEvents([{ tx_id: 't1', type: 'TRADE_ACCEPT', execution_type: 'PROCESS', status: 'EXECUTED',
    processed_at: new Date(T0 - 20 * DAY).toISOString(), items_json: JSON.stringify([{ playerId: 11, fromTeamId: 2, toTeamId: 3 }]) }], Date.parse);
  const broken = models({ negotiation: [{ name: 'B2', profile }], events });
  close(broken.get('2').credibility.untouchable.value, 1 / 3);
  const on2 = plan(broken);
  assert.ok(on2.targets.includes(11));
  const s = on2.suggestions.find(x => x.player === 11);
  assert.ok(s.reason_chain.some(f => f.feature === 'untouchable_talk' && f.effect === 'multiplier'));
  const adj = stepAdjust(broken.get('2'), { team: '2', get: [11], give: [2] });
  close(adj.mult, 2 / 3);
});

test('credibility of shop talk comes from his own follow-through, graded forward only', () => {
  const claim = [{ player: 21, at: T0 - 30 * DAY }];
  const proposed = [{ at: T0 - 25 * DAY, player: '21', from_team: '3', kind: 'proposed' }];
  const early = [{ at: T0 - 40 * DAY, player: '21', from_team: '3', kind: 'proposed' }];
  assert.deepEqual([credibility('shop', '3', claim, proposed, NOW).kept, credibility('shop', '3', claim, proposed, NOW).value], [1, 2 / 3]);
  const nothing = credibility('shop', '3', claim, early, NOW);
  assert.deepEqual([nothing.kept, nothing.broken], [0, 1], 'a proposal before the claim is not follow-through');
  const open = credibility('shop', '3', [{ player: 21, at: NOW - DAY }], [], NOW);
  assert.deepEqual([open.status, open.value, open.open], ['prior', 0.5, 1]);
});

test('nick_override: exclude removes the partner from every plan; deprioritize halves P(responds) and caps the price', () => {
  const ex = plan(models({ notes: [{ name: 'B3', override: 'never trade with him' }] }));
  assert.ok(!stepsOf(ex).some(s => s.team === '3'), 'an excluded partner is in no plan');
  const p3 = ex.partners.find(p => p.team === '3');
  assert.equal(p3.p_responds, 0);
  assert.ok(p3.reason_chain.some(f => f.feature === 'nick_override' && f.effect === 'exclude'));
  assert.ok(!ex.suggestions.some(s => s.owner === '3'));

  const off = plan(null);
  const de = plan(models({ notes: [{ name: 'B3', override: 'careful with this one' }] }));
  const d3 = de.partners.find(p => p.team === '3');
  close(d3.p_responds, off.partners.find(p => p.team === '3').p_responds * (0.55 / 0.5) * 0.5);
  for (const pb of de.playbook) {
    const step = de.best.steps[pb.step_index];
    if (step.team !== '3') continue;
    assert.ok(pb.reason_chain.some(f => f.feature === 'nick_override' && f.effect === 'price_cap'));
    assert.ok(pb.walk_away == null || pb.walk_away.his_pct <= 0, 'never above fair on his screen');
    assert.ok(pb.opening == null || pb.opening.his_pct <= 0);
  }
  assert.ok(off.playbook.some((pb, i) => off.best.steps[i].team === '3' && pb.walk_away.his_pct > 0), 'today the ladder goes above fair');
});

test('the War Room entry with the model on still passes its contract and carries the reason chains', () => {
  const at = new Date(NOW - DAY).toISOString();
  const cps = models({ negotiation: [{ name: 'B4', profile: richProfile({ values_talk: { wants: [{ player: 'P5', at, n: 2 }] } }) }],
    notes: [{ name: 'B2', override: '{"deprioritize":true}' }] });
  const a = makeAdapter();
  a.counterparts = cps;
  const res = planLeague(a, { objective: obj });
  const entry = toEntry(res, { names: a.names(), as_of: 'fixture', changed: { changed: false, reason: 'first plan' } });
  assert.deepEqual(validateEntry(entry), []);
  assert.ok(entry.view.partners.value.every(p => Array.isArray(p.reason_chain)));
  assert.equal(entry.counterpart.status, 'on');
  assert.ok(JSON.stringify(entry.counterpart).length > 0, 'the model summary is JSON-safe');
});

test('a counterparty with no chat identity still gets a typed-unknown model, so the reply prior is league-wide', () => {
  const a = makeAdapter();
  const cps = buildCounterparts({ profiles: new Map(), players: a.players, now: NOW, teams: [...a.managers.keys()] });
  assert.deepEqual([...cps.keys()], ['2', '3', '4']);
  assert.ok([...cps.values()].every(c => c.status === 'unknown' && c.reason === 'no confirmed chat identity'));
  a.counterparts = cps;
  const res = planLeague(a, { objective: obj });
  assert.ok(res.partners.every(p => p.reason_chain.some(f => f.feature === 'reply_prior')));
});
