/**
 * CAMPAIGN-PEOPLE: the counterpart model at every campaign step (PEOPLE-WIRING.md,
 * section CAMPAIGN-PEOPLE, steps 1-10) + Nick's override precedence + the flag.
 * Made-up four-team league (test/fixtures/campaign-league.mjs); invented profiles;
 * no DB, no chat text, no real league data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { rankPartners } = await import('../server/services/campaign/partners.js');
const { replyTable } = await import('../server/services/campaign/playbook.js');
const { diffNextMove } = await import('../server/services/campaign/replan.js');
const { toEntry, validateEntry } = await import('../server/services/campaign/view.js');
const { readProfile } = await import('../server/services/people/profile-adapter.js');
const { campaignPeople, PEOPLE_ENV } = await import('../server/services/campaign/people-flag.js');
const C = await import('../server/services/campaign/counterpart.js');

const cp = (raw, team = '2') => C.buildCounterpart(team, readProfile(raw));
const plan = (people, opts = {}, enabled = true, extra = {}) => {
  const managerExtra = Object.fromEntries(Object.entries(people).map(([t, raw]) => [t, { people: raw }]));
  const a = makeAdapter({ managerExtra, ...opts });
  return { a, res: planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }), people: { enabled, now: Date.parse('2026-10-01T12:00:00Z') }, ...extra }) };
};
const teamsIn = res => new Set([res.best, ...res.deck.map(c => c.plan)].filter(Boolean).flatMap(p => p.steps.map(s => String(s.team))));

/* ---------------------------------------------------------- 1 targets */

test('1 targets: an untouchable is never suggested; a frustrated owner ranks his player up', () => {
  const off = plan({}, {}, false).res;
  assert.ok(off.suggestions.some(s => String(s.player) === '11'), 'fixture: P11 is a suggestion without people');
  assert.ok(off.targets.some(t => String(t) === '11'));
  const on = plan({ 2: { values_talk: { untouchable: [11] } } }).res;
  assert.ok(!on.suggestions.some(s => String(s.player) === '11'), 'untouchable skipped');
  assert.ok(!on.targets.some(t => String(t) === '11'));
  // Only team 2 left to ask: the untouchable must be filtered, not merely ranked last (call-site mutant).
  const solo = plan({ 2: { values_talk: { untouchable: [11] } }, 3: { contactable: false }, 4: { contactable: false } }).res;
  assert.ok(solo.suggestions.length > 0, 'fixture: team 2 still has suggestions');
  assert.ok(!solo.suggestions.some(s => String(s.player) === '11'), 'untouchable filtered even when the list has room');
  const w = C.targetWeight(cp({ deal_feelings: { frustrated_with: [11], urgency: 'high' }, values_talk: { wants: ['RB'] } }), 11, { nickPositions: ['RB'] });
  assert.ok(w.w > 1.5 && !w.skip);
  assert.deepEqual(w.features.map(f => f.feature), ['people.frustrated_with', 'people.urgency', 'people.wants']);
});

/* ---------------------------------------------------------- 2 partners */

test('2 partners: contactable:false is EXCLUDED everywhere; buyer:false and hard sink P(responds)', () => {
  const { res } = plan({ 3: { contactable: false } });
  assert.ok(!teamsIn(res).has('3'), 'no plan routes through a manager who cannot be contacted');
  assert.ok(!res.suggestions.some(s => String(s.owner) === '3'), 'none of his players is suggested as a target');
  const row = res.partners.find(p => p.team === '3');
  assert.equal(row.excluded, true); assert.equal(row.score, 0);
  assert.equal(res.partners[res.partners.length - 1].team, '3', 'excluded partner listed last');
  const base = { receptiveness: 1 };
  const people = new Map([['2', cp({ buyer: false })], ['4', cp({ hard_to_deal_with: true }, '4')], ['3', cp(null, '3')]]);
  const ranked = rankPartners(new Map([['2', base], ['3', base], ['4', base]]), new Map([['2', 1], ['3', 1], ['4', 1]]), { people });
  const by = t => ranked.find(r => r.team === t);
  assert.ok(by('2').p_responds < by('4').p_responds && by('4').p_responds < by('3').p_responds);
  assert.ok(by('2').people.some(f => f.feature === 'people.buyer'));
});

/* ---------------------------------------------------------- 3 price */

test('3 price: yes-point shifted by values_talk; hard -> lower P(accept) and a stricter walk-away', () => {
  const c = cp({ values_talk: { talks_up: [11, 4] } });
  assert.equal(C.yesShift(c, { give: [11], get: [] }).shift, C.WEIGHTS.shift_get_talked_up, 'asking for his hyped player costs more');
  assert.equal(C.yesShift(c, { give: [], get: [4] }).shift, C.WEIGHTS.shift_give_talked_up, 'offering his hyped player costs less');
  const curve = [{ give: [4], his_pct: 5, p: 0.3, nick_gain: 1 }];
  const sh = C.shiftCurve(c, curve, [11]);
  assert.equal(sh.curve[0].his_pct_market, 5);
  assert.equal(sh.curve[0].his_pct, 5 - (C.WEIGHTS.shift_get_talked_up + C.WEIGHTS.shift_give_talked_up));
  const hard = cp({ hard_to_deal_with: true });
  assert.ok(C.acceptModel(hard, 0.4, { give: [11], get: [4] }).p < 0.4 * C.WEIGHTS.accept_hard + 1e-9);
  assert.ok(C.strictBatna(hard, 0.02).batna > 0.02);
  assert.equal(C.strictBatna(cp({ urgency: 'low' }), 0.02).batna, 0.02);
});

/* ---------------------------------------------------------- 4 package */

test('4 package: his wants raise P(accept), his dislikes lower it, an untouchable prices at 0', () => {
  const players = makeAdapter().players;
  const c = cp({ values_talk: { wants: ['RB'], talks_down: [7], untouchable: [12] } });
  assert.ok(C.packageWeight(c, { give: [11], get: [2] }, players).w > 1, 'RB he wants');
  assert.ok(C.packageWeight(c, { give: [11], get: [7] }, players).w < 1, 'P7 he talks down');
  const priced = C.withOpponentModel(() => ({ p: 0.5, basis: 'x' }), new Map([['2', c]]), players);
  assert.equal(priced('2', [12], [2]).p, 0, 'never ask for an untouchable');
  assert.ok(priced('2', [11], [2]).p > 0.5);
});

/* ---------------------------------------------------------- 5 message */

test('5 message: opener from how_to_approach, bait line from what he wants, face-safe', () => {
  const players = makeAdapter().players;
  const c = cp({ how_to_approach: 'Show him the projections', values_talk: { wants: ['RB'] }, deal_feelings: { face: 'high' } });
  const fr = C.framing(c, { give: [2], get: [11] }, players);
  const msg = C.frameMessage({ text: 'Would you do P2 for P11?', facts: [] }, fr);
  assert.match(msg.text, /^Ran the numbers/);
  assert.match(msg.text, /P2 is in it\./);
  assert.ok(msg.framing.face_safe && C.faceSafe(msg.text));
  assert.ok(!C.faceSafe('You lost this trade'), 'public-loss framing is caught');
  const unsafe = C.frameMessage({ text: 'Last chance on this one.' }, { opener: null, bait: null, avoid: [], techniques: [] });
  assert.equal(unsafe.text, '', 'an unsafe line is dropped, not sent');
  assert.ok(!JSON.stringify(fr).includes('projections'), 'no profile text leaks into the framing');
});

/* ---------------------------------------------------------- 6 reply tree */

test('6 reply tree: his no style, what shuts him down, haggler counter, patient when hard', () => {
  const rows = replyTable({ team: '2', give: [4], get: [11] }, { next: null, backup: null, ladder: { walk_away: { his_pct: 3, give: [4] }, opening: { his_pct: -2 }, ladder: [] } });
  const c = cp({ says_no: { does_his_no_hold: 'rarely' }, what_shuts_him_down: ['lowball offers'], posture: 'haggler', hard_to_deal_with: true });
  const { rows: out, features } = C.replyNotes(c, rows);
  const k = kind => out.find(r => r.kind === kind);
  assert.match(k('decline').people_note, /rarely holds/);
  assert.match(k('counter').people_note, /next rung/);
  assert.deepEqual(k('counter').avoid, ['lowball']);
  assert.equal(k('silence').nudge_hours, 48); assert.equal(k('silence').switch_hours, 96);
  assert.ok(features.length >= 3 && features.every(f => Number.isFinite(f.weight)));
});

/* ---------------------------------------------------------- 7 timing */

test('7 timing: send in his urgency window; wait while attached or after a won trade', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  assert.equal(C.timing(cp({ urgency_windows: [{ from: '2026-09-30', to: '2026-10-02', why: 'injury' }] }), now).when, 'now');
  assert.equal(C.timing(cp({ deal_feelings: { attached: true } }), now).when, 'wait');
  assert.equal(C.timing(cp({ just_won_trade: true }), now).when, 'wait');
  const { res } = plan({ 2: { just_won_trade: true }, 3: { just_won_trade: true }, 4: { just_won_trade: true } });
  assert.ok(res.playbook.length, 'fixture has a plan');
  assert.equal(res.playbook[0].send_when.when, 'wait');
  assert.match(res.playbook[0].send_when.why, /won a trade/);
});

/* ---------------------------------------------------------- 8 simulation */

test('8 simulation: the planner prices every step with the opponent model, so paths route to likely dealers', () => {
  const people = { 3: { hard_to_deal_with: true, posture: 'ghoster' } };
  const { a, res } = plan(people);
  const cps = C.buildCounterparts(a.managers);
  const priced = C.withOpponentModel(a.priceStep, cps, a.players);
  for (const s of res.best.steps) assert.equal(s.p, priced(s.team, s.get, s.give).p);
  const off = plan(people, {}, false).res;
  const p3 = r => r.partners.find(p => p.team === '3').p_responds;
  assert.ok(p3(res) < p3(off));
  const m = C.acceptModel(cp({ posture: 'haggler' }), 0.3, { give: [], get: [] });
  close(m.p + m.p_counter + m.p_decline, 1);
  assert.ok(m.p_counter > C.acceptModel(cp({ urgency: 'low' }), 0.3, { give: [], get: [] }).p_counter);
});

/* ---------------------------------------------------------- 9 replanning */

test('9 replanning: a changed profile version is an event that re-runs the plan and names the team', () => {
  assert.deepEqual(C.profileChanges({ 2: 'v1', 3: 'v1' }, { 2: 'v2', 3: 'v1' }), ['2']);
  const prev = { next_step: { team: '3', give: [4], get: [21] }, people_versions: { 3: 'v1' } };
  const next = { next_step: { team: '2', give: [4], get: [11] }, people_versions: { 3: 'v2' } };
  const d = diffNextMove(prev, next);
  assert.equal(d.changed, true);
  assert.deepEqual(d.profile_changed, ['3']);
  assert.match(d.reason, /profile changed: Team 3/);
  const same = diffNextMove({ ...prev, people_versions: { 3: 'v1' } }, { ...prev, people_versions: { 3: 'v2' } });
  assert.equal(same.changed, false);
  assert.deepEqual(same.profile_changed, ['3'], 'the event is recorded even when the move holds');
  const { res } = plan({ 2: { version: 'v7', posture: 'haggler' } });
  assert.equal(res.people.versions['2'], 'v7');
});

/* ---------------------------------------------------------- 10 reasoning */

test('10 reasoning: his side cites trait labels (no quotes) and every adjustment is a weighted feature', () => {
  const secret = 'He said something private in chat';
  const { res } = plan({ 2: { how_to_approach: secret, posture: 'haggler', deal_feelings: { urgency: 'high' } },
    3: { how_to_approach: secret, posture: 'haggler', deal_feelings: { urgency: 'high' } } });
  const entry = toEntry(res, { names: {}, as_of: 'fixture' });
  assert.deepEqual(validateEntry(entry), []);
  assert.ok(!JSON.stringify(entry).includes(secret), 'no chat text in the output');
  const card = entry.view.next_move.value;
  assert.ok(card.his_side.traits.some(t => t.label === 'haggler'));
  const peopleWhy = card.why.filter(w => w.source === 'people.profile');
  assert.ok(peopleWhy.length > 0, 'people adjustments are in the reason chain');
  for (const f of card.people_features) assert.ok(Number.isFinite(f.weight) && f.feature.startsWith('people.') && f.label === C.WEIGHTS_LABEL);
  assert.equal(C.hisSide(cp(null)).status, 'unknown', 'thin chat -> typed unknown, not neutral');
});

/* ---------------------------------------------------------- nick_override */

test('nick_override wins over the profile for every key it sets, and says so', () => {
  const p = readProfile({ contactable: true, deal_feelings: { urgency: 'low' }, posture: 'quick', values_talk: { untouchable: [11] },
    nick_override: { contactable: false, urgency: 'high', untouchable: [] } });
  assert.equal(p.contactable, false); assert.equal(p.urgency, 'high'); assert.deepEqual(p.untouchable, []);
  assert.equal(p.posture, 'quick');
  assert.equal(p.sources.contactable, 'nick_override'); assert.equal(p.sources.posture, 'profile');
  assert.deepEqual(p.override_fields.sort(), ['contactable', 'untouchable', 'urgency']);
  const w = C.respondsWeight(C.buildCounterpart('2', p));
  assert.equal(w.excluded, true);
  assert.equal(w.features[0].source, 'nick_override');
  // Override can also re-open a partner the profile shut.
  const { res } = plan({ 3: { contactable: false, nick_override: { contactable: true } } });
  assert.notEqual(res.partners.find(r => r.team === '3').excluded, true);
});

/* ---------------------------------------------------------- flag */

test('flag: GRIDIRON_CAMPAIGN_PEOPLE_ENABLED=1 on, 0 off, unset follows preview mode; off leaves the plan unchanged', () => {
  const pv = 'GRIDIRON_PREVIEW' + '_UNCONFIRMED';
  const saved = { a: process.env[PEOPLE_ENV], b: process.env[pv] };
  try {
    delete process.env[pv];
    assert.equal(campaignPeople({ [PEOPLE_ENV]: '1' }).enabled, true);
    assert.equal(campaignPeople({ [PEOPLE_ENV]: '0' }).enabled, false);
    assert.equal(campaignPeople({}).enabled, false);
    process.env[pv] = '1';
    const pr = campaignPeople({});
    assert.equal(pr.enabled, true); assert.equal(pr.preview, true);
    assert.equal(campaignPeople({ [PEOPLE_ENV]: '0' }).enabled, false, 'explicit off beats preview');
  } finally {
    for (const [k, v] of [[PEOPLE_ENV, saved.a], [pv, saved.b]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const people = { 3: { contactable: false } };
  const off = plan(people, {}, false).res, bare = plan({}, {}, false).res;
  assert.deepEqual(off.best, bare.best);
  assert.equal(off.people.enabled, false);
});

function close(a, b, eps = 1e-9) { assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`); }
