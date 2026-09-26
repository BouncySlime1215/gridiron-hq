/**
 * PER-LEAGUE RULES (plan item 36): Nick's rules per league from the objectives file's `rules` block,
 * through the one rules module (server/services/campaign/never-give.js), tighten-only, behind
 * GRIDIRON_PER_LEAGUE_RULES=1. Made-up leagues, ids and values only; no real data.
 *
 * Pre-registered pass bar (PR body): with the flag on and no block, league 4's gate verdicts and plan are
 * identical to the flag off; a block's own ids are never given / never got; a floor or cap may only
 * tighten; a block that would loosen anything, or does not read, fails closed; the pins hold everywhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NG = await import('../server/services/campaign/never-give.js');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-per-league-rules-'));
const plansPath = path.join(temp, 'plans.json');
const objectivesPath = path.join(temp, 'objectives.json');
const ON = { GRIDIRON_PER_LEAGUE_RULES: '1', GRIDIRON_WARROOM_OBJECTIVES: objectivesPath };
const OFF = { GRIDIRON_WARROOM_OBJECTIVES: objectivesPath };

/* ------------------------------------------------------------ fixture: two leagues, a fake db */
// League 4: Nick is team 5. League 1: Nick is team 3. Same player ids in both (players.id is global).
const LEAGUES = { 4: { id: 4, season: 2026, my_team_id: '5' }, 1: { id: 1, season: 2026, my_team_id: '3' } };
// FantasyCalc values. 501-507 are "his" players (cheap); 601-606 theirs.
const FC = { 80: 5000, 160: 5000, 277: 3000, 290: 5000, 501: 2000, 502: 1000, 503: 1100, 504: 2000, 601: 4000, 602: 3800,
  603: 3000, 604: 2100, 605: 1900, 606: 2000 };
// The served blue-chip board: 601 90, 602 86, 603 70, 604 85, 605 88, 606 84; 502 / 503 depth.
const BOARD = [[601, 90], [602, 86], [603, 70], [604, 85], [605, 88], [606, 84], [502, 50], [503, 45], [501, 85], [504, 85]];
fs.writeFileSync(plansPath, JSON.stringify({ schema: 'warroom-plans/1', leagues: [4, 1].map(league => ({ league,
  blue_chips: { status: 'ok', value: { rows: BOARD.map(([player, score]) => ({ player: String(player), score })) } } })) }));
const DB = {
  row(sql, ...a) {
    if (/FROM leagues/.test(sql)) return LEAGUES[a[0]] ?? null;
    if (/sqlite_master/.test(sql)) return null; // no trade ledger table: nothing sold
    throw new Error(`fake db: unexpected row ${sql}`);
  },
  rows(sql) {
    if (/sqlite_master/.test(sql)) return [{ name: 'player_metrics' }];
    if (/player_metrics/.test(sql)) return Object.entries(FC).map(([player_id, value]) => ({ player_id: Number(player_id), value, fetched_at: '2026-09-25' }));
    throw new Error(`fake db: unexpected rows ${sql}`);
  },
};
const writeObjectives = doc => fs.writeFileSync(objectivesPath, JSON.stringify(doc));
const gate = (leagueId, env) => NG.ruleGate(DB, { leagueId, plansPath, env });

/** Every shape of idea the gate judges: pins, the floor, the cap, the +12% exception. */
const CASES = [
  { give: [80], get: [601] }, { give: [160], get: [602] }, { give: [277], get: [601] }, { give: [501], get: [290] },
  { give: [501], get: [603] }, { give: [501], get: [604] }, { give: [501], get: [606] }, { give: [504], get: [601] },
  { give: [501], get: [602] }, { give: [502, 503], get: [604] }, { give: [502, 503], get: [604], premium: { points_delta: 1, title_delta: 0.01 } },
  { give: [502, 503], get: [605], premium: { points_delta: 1, title_delta: 0.01 } }, { give: [504], get: [606] }, { give: [501], get: [605] },
];
const verdicts = g => CASES.map(t => g.check(t));

/* ------------------------------------------------------------ resolveLeagueRules */
test('resolveLeagueRules: no block is league 4\'s rules exactly (83, cap 0, +12%)', () => {
  assert.deepEqual(NG.leagueRuleDefaults(), { floor: 83, overpay_cap: 0, depth_premium_max: 0.12 });
  for (const b of [undefined, null]) {
    const r = NG.resolveLeagueRules(b);
    assert.deepEqual(r, { never_give: [], never_get: [], floor: 83, overpay_cap: 0, depth_premium_max: 0.12, source: 'default', errors: [] });
  }
});

test('resolveLeagueRules: tighten-only; anything that would loosen or does not read is an error', () => {
  const ok = NG.resolveLeagueRules({ never_give: [501, '502'], never_get: ['606'], floor: 88, overpay_cap: -0.05, depth_premium_max: 0.05 });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual([ok.never_give, ok.never_get, ok.floor, ok.overpay_cap, ok.depth_premium_max, ok.source],
    [['501', '502'], ['606'], 88, -0.05, 0.05, 'objectives']);
  const bad = [
    { floor: 82 }, { floor: 101 }, { floor: '90' }, { overpay_cap: 0.01 }, { overpay_cap: Infinity }, { depth_premium_max: 0.13 },
    { depth_premium_max: -0.01 }, { never_give: '501' }, { never_give: ['Some Name'] }, { never_get: [0] }, { untouchable: [1] },
    [], 'rules',
  ];
  for (const b of bad) assert.ok(NG.resolveLeagueRules(b).errors.length > 0, `accepted ${JSON.stringify(b)}`);
});

/* ------------------------------------------------------------ the gate */
test('gate: flag on with no block (or no file) gives league 4 exactly today\'s verdicts', () => {
  fs.rmSync(objectivesPath, { force: true });
  const today = verdicts(gate(4, OFF));
  assert.deepEqual(verdicts(gate(4, ON)), today);
  writeObjectives({ 4: { risk_mode: 'balanced', untouchables: ['501'] } });
  assert.deepEqual(verdicts(gate(4, ON)), verdicts(gate(4, OFF)), 'row without a rules block');
  // Teeth: the fixture exercises every rule.
  const reasons = new Set(verdicts(gate(4, ON)).flatMap(v => v.reasons));
  for (const r of ['never_give', 'never_get', 'below_blue_chip', 'overpay']) assert.ok(reasons.has(r), `no case hits ${r}`);
  assert.ok(verdicts(gate(4, ON)).some(v => v.ok), 'some idea passes');
});

test('gate: flag off ignores a rules block entirely (today\'s behaviour, untouchables still read)', () => {
  fs.rmSync(objectivesPath, { force: true });
  const bare = verdicts(gate(4, OFF));
  writeObjectives({ 4: { rules: { never_get: ['601'], floor: 95, overpay_cap: -0.5 } } });
  assert.deepEqual(verdicts(gate(4, OFF)), bare);
  assert.equal(gate(4, OFF).rules.league_rules, undefined);
  writeObjectives({ 4: { rules: { floor: 10 } } });
  assert.deepEqual(verdicts(gate(4, OFF)), bare, 'an invalid block is not read with the flag off');
});

test('gate: league 1 gets its own ids, floor and caps; league 4 is untouched by league 1\'s block', () => {
  writeObjectives({ 1: { rules: { never_give: ['504'], never_get: ['606'], floor: 88, overpay_cap: -0.1, depth_premium_max: 0.05 } } });
  const l4 = verdicts(gate(4, ON));
  fs.rmSync(objectivesPath, { force: true });
  assert.deepEqual(verdicts(gate(4, OFF)), l4, 'league 4 unchanged by another league\'s block');
  writeObjectives({ 1: { rules: { never_give: ['504'], never_get: ['606'], floor: 88, overpay_cap: -0.1, depth_premium_max: 0.05 } } });
  const g = gate(1, ON);
  assert.deepEqual(g.rules.league_rules, { source: 'objectives' });
  const r = t => g.check(t).reasons;
  assert.deepEqual(r({ give: [504], get: [601] }), ['never_give'], 'the block\'s own never-give');
  assert.ok(r({ give: [501], get: [606] }).includes('never_get'), 'the block\'s own never-get');
  assert.ok(r({ give: [502], get: [604] }).includes('below_blue_chip'), '85 is under league 1\'s 88 floor');
  assert.deepEqual(gate(4, ON).check({ give: [502], get: [604] }).reasons, [], '85 clears league 4\'s 83');
  assert.deepEqual(r({ give: [501], get: [601] }), [], '90 clears 88; 2000 for 4000 clears cap -10%');
  // 1900 given for 2000 (-5%) passes cap 0 in league 4 but not league 1's -10%.
  assert.ok(r({ give: [605], get: [501] }).includes('overpay'));
  assert.ok(!gate(4, ON).check({ give: [605], get: [501] }).reasons.includes('overpay'));
  // +12% exception narrowed to +5%: 2100 given for 1900 is +10.5%.
  assert.deepEqual(r({ give: [502, 503], get: [605], premium: { points_delta: 1, title_delta: 0.01 } }), ['overpay']);
  const l4g = gate(4, ON);
  assert.deepEqual(l4g.check({ give: [502, 503], get: [605], premium: { points_delta: 1, title_delta: 0.01 } }).reasons, [], 'league 4 keeps +12%');
});

test('gate: the pins hold in every league whatever the block says', () => {
  writeObjectives({ 1: { rules: { never_give: [], never_get: [] } } });
  const g = gate(1, ON);
  for (const id of NG.PINNED_NEVER_GIVE) assert.ok(g.rules.neverGive.has(id), `${id} not pinned in league 1`);
  for (const id of NG.PINNED_NEVER_GET) assert.ok(g.rules.neverGet.has(id), `${id} not pinned in league 1`);
  assert.ok(g.check({ give: [160], get: [601] }).reasons.includes('never_give'));
  assert.ok(g.check({ give: [501], get: [290] }).reasons.includes('never_get'));
});

test('gate: a block that would loosen a rule, or a file that does not parse, drops everything (fails closed)', () => {
  for (const rules of [{ floor: 80 }, { overpay_cap: 0.2 }, { depth_premium_max: 0.5 }, { never_give: 'x' }, { floor: 90, extra: 1 }]) {
    writeObjectives({ 1: { rules } });
    const g = gate(1, ON);
    assert.match(g.rules.closed, /league 1 rules block invalid/);
    assert.deepEqual(g.rules.league_rules, { source: 'invalid' });
    assert.ok(verdicts(g).every(v => !v.ok && v.reasons.includes('rules_unreadable')), JSON.stringify(rules));
  }
  fs.writeFileSync(objectivesPath, '{ not json');
  assert.match(gate(1, ON).rules.closed, /objectives file unreadable/);
  assert.ok(verdicts(gate(1, ON)).every(v => !v.ok));
});

/* ------------------------------------------------------------ the planner */
const S = String;
const plan = (rules, env) => planLeague(makeAdapter(), { objective: normaliseObjective({ risk_mode: 'balanced', ...(rules !== undefined ? { rules } : {}) }), env });
/** Every id Nick gives / gets on the served deck, backups and first steps. */
function sides(res) {
  const give = [], get = [];
  const plans = [res.best, ...res.deck.map(c => c.plan)].filter(Boolean);
  for (const p of plans) for (const st of p.steps) { give.push(...st.give); get.push(...st.get); }
  for (const b of res.backups.filter(Boolean)) { give.push(...b.step.give); get.push(...b.step.get); }
  for (const m of res.risk_modes) if (m.first_step) { give.push(...m.first_step.give); get.push(...m.first_step.get); }
  return { give: give.map(S), get: get.map(S) };
}
const stable = res => JSON.parse(JSON.stringify({ ...res, phases: undefined, timing: undefined }));

test('planner: flag on with no block is today\'s plan exactly; flag off ignores a block', () => {
  const today = stable(plan(undefined, {}));
  assert.ok(today.deck.length > 0, 'the fixture plans moves');
  assert.deepEqual(stable(plan(undefined, { GRIDIRON_PER_LEAGUE_RULES: '1' })), today);
  const off = stable(plan({ never_give: ['2'], floor: 95 }, {}));
  delete off.objective.rules;
  assert.deepEqual(off, today);
});

test('planner: the block\'s never-give and never-get ids are never served; an invalid block plans nothing', () => {
  const base = sides(plan(undefined, {}));
  assert.ok(base.give.length > 0 && base.get.length > 0);
  const give = base.give[0], get = base.get[0];
  const res = plan({ never_give: [give], never_get: [get] }, { GRIDIRON_PER_LEAGUE_RULES: '1' });
  const s = sides(res);
  assert.ok(!s.give.includes(give), `${give} still given`);
  assert.ok(!s.get.includes(get), `${get} still got`);
  assert.ok(!res.targets.map(S).includes(get), `${get} still a target`);
  const bad = plan({ overpay_cap: 0.3 }, { GRIDIRON_PER_LEAGUE_RULES: '1' });
  assert.match(bad.error, /league rules block invalid/);
});

test('planner: a tighter cap or floor never serves more than the default', () => {
  const tight = plan({ overpay_cap: -0.5, depth_premium_max: 0 }, { GRIDIRON_PER_LEAGUE_RULES: '1' });
  assert.equal(tight.tolerances.max_overpay, -0.5);
  assert.equal(tight.tolerances.depth_premium, 0);
  const vals = new Map([...makeAdapter().players].map(([k, v]) => [S(k), v.value]));
  for (const p of [tight.best, ...tight.deck.map(c => c.plan)].filter(Boolean)) {
    for (const st of p.steps) {
      const gv = st.give.reduce((a, id) => a + vals.get(S(id)), 0), rv = st.get.reduce((a, id) => a + vals.get(S(id)), 0);
      assert.ok((gv - rv) / rv <= -0.5 + 1e-9, `step gives ${gv} for ${rv}`);
    }
  }
});
