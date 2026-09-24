/**
 * ONE-COUNTERPART (server/services/people/counterpart.js): the one counterpart model, built from
 * people.profile (server/services/people/profile-reader.js), on the made-up four-team league
 * (test/fixtures/campaign-league.mjs) and a fixture chat DB in the live table shapes. No real data.
 * Nick is team 1; chat people B2 / B3 / B4 are teams 2 / 3 / 4.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { richProfile, DAY, T0 } = await import('./fixtures/people-chat.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const { priceLadder } = await import('../server/services/campaign/playbook.js');
const { peopleProfileFromChat } = await import('../server/services/people/profile-reader.js');
const cpm = await import('../server/services/people/counterpart.js');
const { counterpartsFromPeople, buildCounterparts, withCounterparts, stepAdjust, adjustP, wantsLift, wantsDecay,
  credibility, tradeEvents, priceCap, respondsAdjust, peopleCounterpart, counterpartFlag,
  WANTS_PRIOR_LOG_LIFT, WANTS_SHRINK_K, M6_REPLY_PRIOR, OVERRIDE_TOUGH_CAP_PCT } = cpm;

const NOW = T0 + 2 * DAY;
const IDS = new Map([['2', { chat_name: 'B2' }], ['3', { chat_name: 'B3' }], ['4', { chat_name: 'B4' }]]);
const obj = normaliseObjective({ risk_mode: 'balanced' });
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const iso = ms => new Date(ms).toISOString();

/** A chat DB in the live shapes: negotiation_profiles (name PK) and manager_notes (name, note, source, noted_at). */
function chatDb({ negotiation = [], notes = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-counterpart-'));
  const file = path.join(dir, 'chat.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE negotiation_profiles (name TEXT PRIMARY KEY, profile_json TEXT NOT NULL, messages_read INTEGER,
             corpus_hash TEXT, model TEXT, built_at TEXT NOT NULL);
           CREATE TABLE manager_notes (name TEXT, note TEXT, source TEXT, noted_at TEXT);`);
  const ins = db.prepare('INSERT INTO negotiation_profiles VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of negotiation) ins.run(r.name, JSON.stringify(r.profile), r.messages_read ?? 400, 'h', 'fixture', iso(r.built_at ?? T0));
  const n = db.prepare('INSERT INTO manager_notes VALUES (?, ?, ?, ?)');
  for (const r of notes) n.run(r.name, r.note, r.source ?? 'nick-chat-2026-09-23', iso(r.at ?? T0));
  db.close();
  return new DatabaseSync(file, { readOnly: true });
}

function people(opts) {
  const chat = chatDb(opts);
  try { return peopleProfileFromChat(chat, { leagueId: 99, ids: IDS, myTeam: '1' }); } finally { chat.close(); }
}
function models(opts = {}, { events = [], adapter = makeAdapter() } = {}) {
  return counterpartsFromPeople(people(opts), { players: adapter.players, events, now: NOW, teams: [...adapter.managers.keys()] });
}
const plan = (cps, adapter = makeAdapter()) => { if (cps) adapter.counterparts = cps; return planLeague(adapter, { objective: obj }); };
const stepsOf = res => [res.best, ...res.deck.map(c => c.plan)].filter(Boolean).flatMap(p => p.steps);
const strip = res => JSON.parse(JSON.stringify({ ...res, runtime_ms: 0 }));

// Every chat label the model knows: wants (fresh, n=4), untouchable, shopping, for all three people.
const talk = () => richProfile({ values_talk: {
  wants: [{ player: 'P5', at: iso(NOW - 2 * DAY), n: 4 }, { player: 'P2', at: iso(NOW - DAY), n: 2 }],
  untouchable: [{ player: 'P11', at: iso(T0 - 30 * DAY) }, { player: 'P21', at: iso(T0 - 30 * DAY) }],
  shopping: [{ player: 'P13', at: iso(NOW - DAY) }, { player: 'P23', at: iso(NOW - DAY) }, { player: 'P33', at: iso(NOW - DAY) }],
} });
const LABELLED = { negotiation: ['B2', 'B3', 'B4'].map(name => ({ name, profile: talk() })) };

test('P(accept) is identical with and without chat labels, for every step on every p', () => {
  const on = models(LABELLED), off = models({});
  assert.ok([...on.values()].every(c => c.status === 'ok' && c.wants.size + c.untouchable.size + c.shopping.size > 0), 'labels were read');
  assert.ok([...off.values()].every(c => c.status === 'unknown'));
  const a = makeAdapter();
  const A = withCounterparts(a, on), B = withCounterparts(a, off);
  const mine = a.rosters.get('1');
  let n = 0;
  for (const t of ['2', '3', '4']) for (const his of a.rosters.get(t)) for (const give of [[mine[0]], [mine[4]], [mine[1], mine[4]]]) {
    const x = A.priceStep(t, [his], give), y = B.priceStep(t, [his], give);
    assert.equal(x.p, y.p, `team ${t} player ${his}`);
    assert.equal(x.p, a.priceStep(t, [his], give).p, 'the served P(accept) is the adapter price, untouched');
    assert.deepEqual(x.features, []);
    n++;
  }
  assert.ok(n >= 45);
  for (const t of ['2', '3', '4']) for (const p of [0, 0.01, 0.3, 0.5, 0.97, 1]) {
    assert.equal(adjustP(p, stepAdjust(on.get(t), { team: t, get: [11], give: [5] })), p);
  }
  // In a full plan: every written step's P(accept) is the adapter's price for that step.
  const res = plan(on);
  const base = makeAdapter();
  for (const st of stepsOf(res)) if (Number.isFinite(st.p)) close(st.p, base.priceStep(st.team, st.get, st.give).p);
});

test('wants_player still moves targets and partner order (not P(accept)); prior 2.0, shrunk by n, decayed 7 d -> 21 d', () => {
  close(wantsDecay(0), 1); close(wantsDecay(7), 1); close(wantsDecay(14), 0.5); close(wantsDecay(21), 0); close(wantsDecay(40), 0);
  close(wantsLift(4, 3).lift, WANTS_PRIOR_LOG_LIFT * 4 / (4 + WANTS_SHRINK_K));
  const cps = models({ negotiation: [{ name: 'B4', profile: richProfile({ values_talk: { wants: [{ player: 'P5', at: iso(NOW - 2 * DAY), n: 4 }] } }) }] });
  assert.equal(cps.get('4').wants.size, 1);
  const off = plan(null), on = plan(cps);
  const p4 = res => res.partners.find(p => p.team === '4');
  assert.ok(p4(on).p_responds > p4(off).p_responds * (0.55 / 0.5), 'P(responds) up beyond the anchor');
  assert.ok(p4(on).reason_chain.some(f => f.feature === 'wants_player'));
  for (const s of on.suggestions.filter(x => x.owner === '4')) {
    assert.ok(s.reason_chain.some(f => f.feature === 'wants_player' && f.effect === 'multiplier'));
  }
  for (const st of stepsOf(on)) assert.ok(!(st.reason_chain ?? []).some(f => f.effect === 'log_odds'), 'no chat log-odds on a step');
  // Stale talk (22 days) does nothing.
  const stale = models({ negotiation: [{ name: 'B4', profile: richProfile({ values_talk: { wants: [{ player: 'P5', at: iso(NOW - 22 * DAY), n: 4 }] } }) }] });
  assert.equal(stale.get('4').wants.size, 0);
});

test('untouchable talk acts on targets only: credible -> never a target; broken -> a target, scaled down', () => {
  const profile = richProfile({ values_talk: { untouchable: [{ player: 'P11', at: iso(T0 - 30 * DAY) }] } });
  assert.ok(plan(null).targets.includes(11), 'today the star is a target');
  const kept = models({ negotiation: [{ name: 'B2', profile }] });
  close(kept.get('2').credibility.untouchable.value, 2 / 3);
  const wide = makeAdapter(); wide.counterparts = kept;
  const all = planLeague(wide, { objective: obj, budget: { targets: 50 } });
  assert.ok(!all.targets.includes(11), 'a credible untouchable is never a searched target');
  assert.ok(!stepsOf(all).some(s => s.get.includes(11)));
  const events = tradeEvents([{ tx_id: 't1', type: 'TRADE_ACCEPT', execution_type: 'PROCESS', status: 'EXECUTED',
    processed_at: iso(T0 - 20 * DAY), items_json: JSON.stringify([{ playerId: 11, fromTeamId: 2, toTeamId: 3 }]) }], Date.parse);
  const broken = models({ negotiation: [{ name: 'B2', profile }] }, { events });
  close(broken.get('2').credibility.untouchable.value, 1 / 3);
  const on = plan(broken);
  assert.ok(on.targets.includes(11));
  assert.ok(on.suggestions.find(x => x.player === 11).reason_chain.some(f => f.feature === 'untouchable_talk' && f.effect === 'multiplier'));
});

test('credibility of shop talk comes from his own follow-through, graded forward only', () => {
  const claim = [{ player: 21, at: T0 - 30 * DAY }];
  const proposed = [{ at: T0 - 25 * DAY, player: '21', from_team: '3', kind: 'proposed' }];
  const early = [{ at: T0 - 40 * DAY, player: '21', from_team: '3', kind: 'proposed' }];
  assert.deepEqual([credibility('shop', '3', claim, proposed, NOW).kept, credibility('shop', '3', claim, proposed, NOW).value], [1, 2 / 3]);
  const nothing = credibility('shop', '3', claim, early, NOW);
  assert.deepEqual([nothing.kept, nothing.broken], [0, 1]);
});

test('Nick\'s read comes through the one reader: nick_override on the profile and nick-chat notes', () => {
  const cps = models({ negotiation: [{ name: 'B2', profile: richProfile({ nick_override: { difficulty: 'hard' } }) }],
    notes: [{ name: 'B3', note: 'traded with him twice, fine' }, { name: 'B4', note: '{"buyer": false}' }] });
  assert.deepEqual(['2', '3', '4'].map(t => cps.get(t).override.status), ['ok', 'ok', 'ok']);
  assert.equal(cps.get('2').override.toughen, true);
  assert.equal(cps.get('3').override.toughen, false, 'a free-text note is kept, never parsed for meaning');
  assert.equal(cps.get('4').override.deprioritize, true);
  const pub = peopleCounterpart(cps, { leagueId: 99, asOf: NOW });
  assert.equal(pub.field, 'people.counterpart');
  assert.equal(pub.counts.nick_read, 3);
  assert.ok(!JSON.stringify(pub).includes('traded with him'), 'no note text in the published field');
});

test('the unreachable manager (contactable=false) has p_responds 0 and is in no plan', () => {
  const cps = models({ notes: [{ name: 'B3', note: '{"contactable": false}' }] });
  assert.equal(cps.get('3').override.exclude, true);
  const res = plan(cps);
  const p3 = res.partners.find(p => p.team === '3');
  assert.equal(p3.p_responds, 0);
  assert.ok(p3.reason_chain.some(f => f.feature === 'nick_override' && f.effect === 'exclude'));
  assert.ok(!stepsOf(res).some(s => s.team === '3'));
  assert.ok(!res.suggestions.some(s => s.owner === '3'));
  const same = respondsAdjust({ p: 0.6, basis: 'x' }, cps.get('3'), [1], { baseAnchor: 0.5 });
  assert.equal(same.p, 0);
});

test('nick difficulty \'hard\' lowers the opening price (capped at fair on his screen)', () => {
  const hard = models({ negotiation: [{ name: 'B3', profile: richProfile({ nick_override: { difficulty: 'hard' } }) }] });
  const cap = priceCap(hard.get('3'));
  assert.equal(cap.max_his_pct, OVERRIDE_TOUGH_CAP_PCT);
  assert.ok(cap.feature.feature === 'nick_override' && cap.feature.effect === 'price_cap');
  assert.equal(priceCap(models({}).get('3')), null, 'no read -> no cap');
  assert.equal(priceCap(models({ notes: [{ name: 'B3', note: '{"difficulty": "easy"}' }] }).get('3')), null);
  // The planner applies the cap to the price curve before the ladder (planner.js#planLeague playbookFor).
  // Worth-it packages only above fair: uncapped he opens above fair; capped there is no opening.
  const ladder = c => priceLadder(c, { batna: 0 });
  const above = [2, 10, 20, 30].map(h => ({ give: [h], his_pct: h, p: 0.3, nick_gain: 6 - h / 10 }));
  assert.equal(ladder(above).opening.his_pct, 2, 'uncapped: opens above fair');
  assert.equal(ladder(above.filter(c => c.his_pct <= cap.max_his_pct)).opening, null, 'hard: never opens above fair');
  // In a full plan: every opening to him is at or below fair on his screen, and the cap is named.
  const off = plan(models({})), on = plan(hard);
  const pbs = res => res.playbook.filter(pb => res.best.steps[pb.step_index].team === '3');
  const top = res => Math.max(...pbs(res).map(pb => pb.opening?.his_pct ?? -Infinity));
  assert.ok(top(off) > 0, 'without the read the opening goes above fair');
  assert.ok(pbs(on).length > 0 && top(on) < top(off), 'the hard read lowers the opening (here: no above-fair opening at all)');
  for (const pb of pbs(on)) {
    assert.ok(pb.opening == null || pb.opening.his_pct <= OVERRIDE_TOUGH_CAP_PCT);
    assert.ok(pb.walk_away == null || pb.walk_away.his_pct <= OVERRIDE_TOUGH_CAP_PCT);
    assert.ok(pb.counterpart.reason_chain.some(f => f.feature === 'nick_override' && f.effect === 'price_cap'));
  }
});

test('flag: off by default; =1 on; preview turns it on; =0 vetoes preview', () => {
  const was = process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  try {
    delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
    assert.equal(counterpartFlag({}).on, false);
    assert.equal(counterpartFlag({ GRIDIRON_COUNTERPART: '1' }).on, true);
    process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
    assert.deepEqual([counterpartFlag({}).on, counterpartFlag({}).preview], [true, true]);
    assert.equal(counterpartFlag({ GRIDIRON_COUNTERPART: '0' }).on, false);
  } finally {
    if (was == null) delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED; else process.env.GRIDIRON_PREVIEW_UNCONFIRMED = was;
  }
  assert.deepEqual(strip(plan(null)), strip(plan(undefined)), 'no counterparts -> today\'s plan, byte for byte');
});

test('quiet or missing profiles: typed unknown, no chat feature; the reply prior still re-anchors P(responds)', () => {
  const cps = models({ negotiation: [{ name: 'B2', profile: talk(), messages_read: 3 }] });
  assert.ok([...cps.values()].every(c => c.status === 'unknown'));
  const res = plan(cps);
  assert.ok(res.partners.every(p => p.reason_chain.map(f => f.feature).join() === 'reply_prior'));
  assert.equal(res.playbook[0].counterpart.reply_mix.ignore, M6_REPLY_PRIOR.ignore);
  const none = buildCounterparts({ profiles: new Map(), players: makeAdapter().players, now: NOW, teams: ['2', '3', '4'] });
  assert.ok([...none.values()].every(c => c.status === 'unknown' && c.reason === 'no confirmed chat identity'));
});

test('the War Room entry with the model on passes its contract and carries the reason chains', () => {
  const a = makeAdapter();
  a.counterparts = models({ ...LABELLED, notes: [{ name: 'B2', note: '{"buyer": false}' }] });
  const res = planLeague(a, { objective: obj });
  const entry = toEntry(res, { names: a.names(), as_of: 'fixture', changed: { changed: false, reason: 'first plan' } });
  assert.deepEqual(validateLeague(entry).errors, []);
  assert.equal(res.counterpart.status, 'on');
  assert.ok(res.counterpart.models.every(m => m.p_accept_chat_weight === 0));
  // RULINGS 17: the served counterpart numbers are typed fields in the contract.
  const s0 = entry.next_move.value.steps[0];
  assert.equal(s0.counterpart.status, 'ok');
  assert.deepEqual(s0.counterpart.value.reply_mix, { ...M6_REPLY_PRIOR });
  assert.equal(s0.counterpart.value.p_accept_challenger, s0.p_yes.value, 'chat weight 0: the challenger equals the served p');
  assert.ok(entry.partners.value.every(p => Array.isArray(p.reason_chain) && p.reply_mix));
});
