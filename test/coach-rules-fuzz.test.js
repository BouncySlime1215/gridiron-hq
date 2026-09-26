/**
 * COACH-V2 unit 2: RULES-CHECK fuzz. 500 seeded cases against an independent oracle
 * of Nick's rules; pass bar: 0 rule-violating suggestions reach Nick, and every drop
 * is logged with its rule.
 *
 * Each case is a suggestion Coach could put in front of Nick (a claim about a move, or
 * an action card), drawn from a synthetic served plan and then, most of the time,
 * mutated to break a rule: a never-give player (160, 80, an objectives untouchable),
 * A.J. (277) outside a Needs-your-OK card or for a sub-83 pick, a never-get (290) or a
 * player sold this season, a get under the 83 floor or unscored, a side with no
 * FantasyCalc value, an overpay over the cap (and the +12% depth-only 2-for-1 exception
 * at, under and over its edge), a step that does not beat doing nothing, and a package
 * the planner never served. Ids and scores are made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-rules-fuzz-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const { checkSuggestion, holdToRules, servedSteps, COACH_RULES } = await import('../server/services/coach/rules-check.js');
const { newLedger } = await import('../server/services/coach/ledger.js');

const CASES = 500;
const SEED = 20260926;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(SEED);
const pick = xs => xs[Math.floor(rand() * xs.length)];

/* ------------------------------------------------ the synthetic league */
const PINNED_GIVE = ['160', '80'];
const AJ = '277';
const OBJECTIVE = '501';           // an untouchable from Nick's objectives file
const NEVER_GET = '290';
const SOLD = '502';
const mine = ['160', '80', AJ, OBJECTIVE, '511', '512', '513', '514', '515', '516'];
const theirs = ['601', '602', '603', '604', '605', '606', NEVER_GET, SOLD, '607', '608', '609'];
const score = new Map();
const fc = new Map();
for (const id of [...mine, ...theirs]) { score.set(id, 60 + Math.floor(rand() * 40)); fc.set(id, 1000 + Math.floor(rand() * 9000)); }
for (const id of ['601', '602', '603', '604']) score.set(id, 85 + Math.floor(rand() * 10)); // blue chips
for (const id of ['605', '606']) score.set(id, 70);                                         // under the floor
score.delete('607');                                                                          // unscored
fc.delete('608');                                                                             // no FantasyCalc value
for (const id of ['511', '512', '513']) score.set(id, 70);                                  // depth

const rules = {
  neverGive: new Set([...PINNED_GIVE, AJ, OBJECTIVE]), neverGet: new Set([NEVER_GET]), sold: new Set([SOLD]),
  fc, scoreOf: id => score.get(String(id)) ?? null, closed: null
};

/* ------------------------------------------------ the oracle (independent of rules-check.js) */
function oracle(s, served) {
  const why = new Set();
  const give = s.give.map(String);
  const get = s.get.map(String);
  const key = xs => [...xs].sort().join(',');
  const step = served.find(x => key(x.give) === key(give) && key(x.get) === key(get) && x.partner === String(s.partner) && x.move_id === String(s.move_id));
  if (!step) why.add('not_served');
  if (give.some(id => PINNED_GIVE.includes(id) || id === OBJECTIVE)) why.add('never_give');
  if (give.includes(AJ) && !(s.kind === 'needs_ok' && get.length && get.every(id => (score.get(id) ?? -1) >= 83))) why.add('aj_needs_ok');
  if (get.includes(NEVER_GET)) why.add('never_get');
  if (get.includes(SOLD)) why.add('sold_this_season');
  for (const id of get) { const sc = score.get(id); if (sc == null) why.add('unscored'); else if (sc < 83) why.add('below_blue_chip'); }
  if (![...give, ...get].every(id => fc.has(id))) why.add('no_fc_value');
  else {
    const gv = give.reduce((n, id) => n + fc.get(id), 0);
    const rv = get.reduce((n, id) => n + fc.get(id), 0);
    const over = (gv - rv) / rv;
    if (over > 1e-9) {
      const depth = give.length === 2 && get.length === 1 && give.every(id => (score.get(id) ?? 99) < 83 && !['160', '80', AJ].includes(id) && !rules.neverGive.has(id));
      const rises = (s.premium?.points_delta ?? 0) > 0 && (s.premium?.title_delta ?? 0) > 0;
      if (!(depth && rises && over <= 0.12 + 1e-9)) why.add('overpay');
    }
  }
  if (step && !(step.delta > 0)) why.add('loses_to_nothing');
  return why;
}

/* ------------------------------------------------ cases */
const ok = value => ({ status: 'ok', value });
function randomMove(i) {
  const give = [pick(mine)];
  if (rand() < 0.4) { const b = pick(mine); if (!give.includes(b)) give.push(b); }
  const get = [pick(theirs)];
  if (rand() < 0.15) { const b = pick(theirs); if (!get.includes(b)) get.push(b); }
  const delta = rand() < 0.15 ? -0.01 * rand() : (rand() < 0.05 ? 0 : 0.2 * rand() + 0.001);
  return { move_id: `M${i}`, steps: [{ partner: String(2 + (i % 5)), give, get, title_odds_delta: ok(delta) }] };
}
const moves = Array.from({ length: 60 }, (_, i) => randomMove(i));
// Balanced 2-for-1 depth moves near the +12% edge, so the exception is exercised on both sides.
for (let i = 0; i < 12; i++) {
  const get = pick(['601', '602', '603', '604']);
  const give = ['511', '512'];
  const target = fc.get(get) * (1 + [0.05, 0.12, 0.13, 0.2][i % 4]);
  fc.set('511', Math.round(target / 2)); fc.set('512', Math.round(target / 2));
  moves.push({ move_id: `D${i}`, steps: [{ partner: '3', give, get: [get], title_odds_delta: ok(0.02) }] });
}
const entry = { next_move: ok(moves[0]), alternatives: ok(moves.slice(1)), flip_map: ok([]) };
const served = servedSteps(entry);

function mutate(s) {
  const r = rand();
  const c = { ...s, give: [...s.give], get: [...s.get] };
  if (r < 0.1) c.give[0] = pick(PINNED_GIVE);
  else if (r < 0.2) { c.give[0] = AJ; c.kind = rand() < 0.5 ? 'needs_ok' : null; }
  else if (r < 0.27) c.give[0] = OBJECTIVE;
  else if (r < 0.34) c.get[0] = NEVER_GET;
  else if (r < 0.4) c.get[0] = SOLD;
  else if (r < 0.48) c.get[0] = pick(['605', '606', '607']);
  else if (r < 0.54) c.get[0] = '608';
  else if (r < 0.62) c.move_id = 'NOT-SERVED';
  else if (r < 0.7) c.partner = '99';
  return c;
}

const cases = [];
for (let i = 0; i < CASES; i++) {
  const st = pick(served);
  const base = { give: st.give, get: st.get, partner: st.partner, move_id: st.move_id, kind: rand() < 0.2 ? 'needs_ok' : null,
    premium: rand() < 0.5 ? { points_delta: rand() - 0.2, title_delta: rand() - 0.2 } : null };
  cases.push(rand() < 0.75 ? mutate(base) : base);
}

test(`${CASES} fuzz cases: 0 rule-violating suggestions pass, and the checker agrees with the oracle`, () => {
  let violatingPassed = 0;
  let disagreements = 0;
  const perRule = Object.fromEntries(COACH_RULES.map(r => [r, 0]));
  let violating = 0;
  for (const c of cases) {
    // A mutated case keeps the served step's own served-ness only when its packages still match.
    const expected = oracle(c, served);
    const got = checkSuggestion(c, { rules, served });
    if (expected.size) violating++;
    if (expected.size && got.ok) violatingPassed++;
    if (got.ok !== (expected.size === 0)) disagreements++;
    for (const r of got.reasons) perRule[r] += 1;
    for (const r of expected) assert.ok(got.reasons.includes(r), `rule ${r} missing for ${JSON.stringify(c)} (got ${got.reasons})`);
  }
  assert.equal(violatingPassed, 0, 'no rule-violating suggestion passes');
  assert.equal(disagreements, 0);
  assert.ok(violating > CASES * 0.5, `the fuzz exercises the rules (${violating} violating cases)`);
  for (const r of COACH_RULES.filter(x => x !== 'rules_unreadable')) assert.ok(perRule[r] > 0, `rule ${r} was exercised`);
  console.log(`[fuzz] ${CASES} cases, ${violating} violating, 0 passed; drops by rule ${JSON.stringify(perRule)}`);
});

test('the same cases as answers and cards: every violating line or card is dropped and logged with its rule', () => {
  const ledger = newLedger();
  const rowsIn = served.map(s => ({ move_id: s.move_id, partner: s.partner, step: s.step + 1, steps: 1 }));
  const e = ledger.record({ tool: 'plan_read', tables: ['plan_read'], columns: Object.keys(rowsIn[0]), rows: rowsIn });
  const claims = served.map((s, i) => ({ text: `Offer move ${s.move_id}.`, cites: [`${e.id}#${i}.move_id`] }));
  const proposals = served.map(s => ({ kind: 'offer.sent', payload: { move_id: s.move_id, step_index: s.step } }));
  const held = holdToRules({ answer: { claims, refusals: [] }, proposals, ledger: ledger.toJson(), entry, rules });
  const bad = served.filter(s => oracle({ ...s, kind: null }, served).size > 0).map(s => s.move_id);
  assert.equal(held.answer.claims.length, served.length - bad.length);
  assert.ok(held.answer.claims.every(c => !bad.includes(c.text.match(/move (\S+)\./)[1])), 'no violating line kept');
  assert.equal(held.proposals.length, served.length - bad.length, 'no violating card kept');
  assert.equal(held.drops.length, bad.length * 2, 'one drop per line and per card');
  assert.ok(held.drops.every(d => d.rules.length && d.rules.every(r => COACH_RULES.includes(r))), 'every drop names its rule');
});

test('a closed rule source drops everything, and A.J. only ever shows as a Needs-your-OK card', () => {
  const closed = { ...rules, closed: 'the sold-this-season ledger could not be read' };
  for (const s of served.slice(0, 20)) assert.equal(checkSuggestion(s, { rules: closed, served }).ok, false);
  const aj = { move_id: 'AJ1', steps: [{ partner: '4', give: [AJ], get: ['601'], title_odds_delta: ok(0.05) }] };
  const e2 = { next_move: ok(aj), alternatives: ok([]), flip_map: ok([]) };
  const s2 = servedSteps(e2);
  assert.deepEqual(checkSuggestion({ ...s2[0], kind: null }, { rules, served: s2 }).reasons, ['aj_needs_ok']);
  assert.equal(checkSuggestion({ ...s2[0], kind: 'needs_ok' }, { rules, served: s2 }).ok, true, 'an approved 83+ pick as a Needs-your-OK card');
});
