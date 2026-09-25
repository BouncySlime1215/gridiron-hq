/**
 * RULE-FUZZ (unit 18): Nick's hard rules as properties, checked on the one planner
 * (server/services/campaign/planner.js#planLeague) over hundreds of seeded made-up leagues
 * (test/fixtures/rule-fuzz-league.mjs), in every risk mode, and over thousands of random offers at
 * the planner's own gates. The oracle (test/fixtures/nick-rules.mjs) reads only what the planner
 * returns; it does not share code with the enforcement it checks.
 *
 * Seeds are recorded: the sweep is seeds RULE_FUZZ_BASE .. RULE_FUZZ_BASE + RULE_FUZZ_N - 1 (defaults
 * below, overridable for a wider local run), plus every seed in test/fixtures/rule-fuzz-seeds.json.
 * A failure names its seed and mode; makeFuzzLeague(seed) rebuilds the league exactly.
 *
 * Rules the planner on main enforces are hard tests. Rules whose enforcement is still in an open PR
 * (or in none) run as `todo`: they run in full and print their violation count, but do not fail CI
 * until that enforcement lands on main. Moving a rule from PENDING to ENFORCED is the check that the
 * merged PR really holds over random leagues.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { rankPlans, tolerancesFor, MODES } = await import('../server/services/campaign/modes.js');
const { nickOverpays } = await import('../server/services/campaign/search.js');
const { makeFuzzLeague, rng, NICO_COLLINS, CHASE_BROWN, AJ_BROWN, OLAVE_ID } = await import('./fixtures/rule-fuzz-league.mjs');
const { ruleViolations, countByRule, finalGets, RULES } = await import('./fixtures/nick-rules.mjs');

const CORPUS = JSON.parse(readFileSync(new URL('./fixtures/rule-fuzz-seeds.json', import.meta.url), 'utf8'));
const envInt = (k, d) => (Number.isInteger(Number(process.env[k])) && process.env[k] !== '' && process.env[k] != null ? Number(process.env[k]) : d);
const BASE = envInt('RULE_FUZZ_BASE', CORPUS.sweep.base);
const N = envInt('RULE_FUZZ_N', CORPUS.sweep.count);
const SEEDS = [...new Set([...Array.from({ length: N }, (_, i) => BASE + i), ...CORPUS.recorded.map(r => r.seed)])];
/** The served configuration: the producer's env with no rule flag set (what Nick sees today). */
const SERVED_ENV = {};

/**
 * Where each rule is enforced. `split` narrows a rule to the leagues it is enforced on (never_give
 * holds on main only while Nick's 'untouchable:' notes are read; pinning by id is #381).
 */
const ENFORCED = [
  { rule: 'never_give', name: '160 and 80 never given (notes read)', when: a => a.draw.notes },
  { rule: 'overpay', name: 'no overpay beyond the 1c exception' },
];
const PENDING = [
  { rule: 'never_give', name: '160 and 80 never given (notes missing)', when: a => !a.draw.notes, todo: 'pinned by id in #381 (never-give.js)' },
  { rule: 'aj_brown', name: 'A.J. Brown only for a consistent Blue chip', todo: '#381 pins 277 as never-give until a consistency read exists' },
  { rule: 'final_get', name: 'every final get scores 83+', todo: '#381 GETS-FLOOR, and only once GRIDIRON_GETS_FLOOR=1 is served' },
  { rule: 'no_olave', name: 'Chris Olave never offered or targeted', todo: '#379 excludes him only inside its 28-day sold window; no PR pins him by id' },
  { rule: 'no_reversal', name: 'no trade made this season is reversed', todo: '#379 blocks two-way undo and recent sells only; one-way move-backs are open' },
];

/* One planner run per (seed, mode), shared by every test below. */
const runs = new Map();
function runMode(mode) {
  if (runs.has(mode)) return runs.get(mode);
  const out = [];
  for (const seed of SEEDS) {
    const a = makeFuzzLeague(seed);
    const res = planLeague(a, { objective: normaliseObjective({ risk_mode: mode }), env: SERVED_ENV });
    assert.equal(res.error, undefined, `seed ${seed} ${mode}: ${res.error}`);
    out.push({ seed, a, res, v: ruleViolations(a, res) });
  }
  runs.set(mode, out);
  return out;
}

function failures(mode, { rule, when }) {
  return runMode(mode).filter(r => !when || when(r.a)).flatMap(r => r.v.filter(v => v.rule === rule).map(v => ({ seed: r.seed, ...v })));
}
const report = (mode, bad) => `${mode}: ${bad.length} violations over ${SEEDS.length} seeds; first: `
  + bad.slice(0, 5).map(b => `seed ${b.seed} ${b.surface} ${b.detail}`).join(' | ');

/* ------------------------------------------------ the oracle is not vacuous */

test('the oracle catches each rule on a hand-built result', () => {
  const a = makeFuzzLeague(7, { notes: false, ledger: true });
  const me = a.league.me;
  const mine = a.rosters.get(me);
  const other = [...a.rosters.keys()].find(t => t !== me);
  const cheap = a.rosters.get(other).filter(id => id !== OLAVE_ID && a.scoreOf(id).score < 83)
    .sort((x, y) => a.players.get(x).value - a.players.get(y).value)[0];
  const sold = a.tradeLedger.trades.flatMap(t => t.moves).find(m => m.from === me && m.player !== OLAVE_ID)
    ?? a.tradeLedger.trades.flatMap(t => t.moves).find(m => m.from === me);
  const step = (team, give, get) => ({ team, give, get, p: 0.5, delta: 0.01 });
  const plan = steps => ({ steps, target: steps.at(-1).get[0] });
  const res = { deck: [], suggestions: [], targets: [], flip: { realised: [] }, best: null };
  const cases = [
    ['never_give', plan([step(other, [NICO_COLLINS], [cheap])])],
    ['aj_brown', plan([step(other, [AJ_BROWN], [cheap])])],
    ['final_get', plan([step(other, [mine.find(id => id > 999)], [cheap])])],
    ['overpay', plan([step(other, [CHASE_BROWN], [cheap])])],
    ['no_olave', plan([step(a.draw.olave_team, [mine[0]], [OLAVE_ID])])],
    ['no_reversal', plan([step(sold.to, [mine[0]], [sold.player])])],
  ];
  for (const [rule, p] of cases) {
    if (rule === 'aj_brown' && !mine.includes(AJ_BROWN)) continue;
    const got = countByRule(ruleViolations(a, { ...res, best: p }));
    assert.ok(got[rule] > 0, `${rule} not caught: ${JSON.stringify(got)}`);
  }
  // A clean even 1-for-1 for a Blue chip, not Olave, not a move-back, breaks nothing.
  const blueOut = a.rosters.get(other).find(id => a.scoreOf(id).score >= 83 && id !== OLAVE_ID);
  const moved = new Set(a.tradeLedger.trades.flatMap(t => t.moves.map(m => m.player)));
  const giveIt = blueOut && mine.find(id => id > 999 && !moved.has(id) && a.players.get(id).value >= a.players.get(blueOut).value && a.scoreOf(id).score < 83);
  if (blueOut && giveIt) assert.deepEqual(ruleViolations(a, { ...res, best: plan([step(other, [giveIt], [blueOut])]) }), []);
});

test('the 1c exception: only a confirmed depth-only 2-for-1 up to +12% passes', () => {
  const a = makeFuzzLeague(11);
  const me = a.league.me, other = [...a.rosters.keys()].find(t => t !== me);
  const P = a.players;
  // Made-up values for the exception's edges: two depth pieces (60 + 52 = 112) for one (100) is +12%.
  P.set(501, { id: 501, name: 'P501', position: 'RB', value: 60, score: 60 });
  P.set(502, { id: 502, name: 'P502', position: 'WR', value: 52, score: 60 });
  P.set(503, { id: 503, name: 'P503', position: 'WR', value: 100, score: 90 });
  P.set(504, { id: 504, name: 'P504', position: 'WR', value: 60, score: 88 });
  P.set(505, { id: 505, name: 'P505', position: 'WR', value: 53, score: 60 });
  const ok = { points_delta: 1, title_delta: 0.01 };
  const one = (give, confirmed) => ({ deck: [], suggestions: [], targets: [], flip: { realised: [] },
    best: { steps: [{ team: other, give, get: [503], depth_premium: confirmed === undefined ? undefined : { pct: 0.12, confirmed } }] } });
  const overpay = r => countByRule(ruleViolations(a, r)).overpay;
  assert.equal(overpay(one([501, 502], ok)), 0, '+12% depth-only, confirmed: allowed');
  assert.equal(overpay(one([501, 505], ok)), 1, '+13%: over the exception');
  assert.equal(overpay(one([501, 502], null)), 1, 'not confirmed on fresh dice');
  assert.equal(overpay(one([501, 502], { points_delta: 1, title_delta: -0.001 })), 1, 'title odds fell');
  assert.equal(overpay(one([501, 502], { points_delta: 0, title_delta: 0.01 })), 1, 'lineup points flat');
  assert.equal(overpay(one([504, 502], ok)), 1, 'a Blue chip in the give is not depth');
  assert.equal(overpay(one([501, 502])), 1, 'no premium on the step at all');
});

test('same seed, same league and the same violations (recorded seeds replay)', () => {
  const x = makeFuzzLeague(42), y = makeFuzzLeague(42);
  assert.deepEqual([...x.rosters], [...y.rosters]);
  assert.deepEqual([...x.players.values()], [...y.players.values()]);
  assert.deepEqual(x.draw, y.draw);
  const obj = normaliseObjective({ risk_mode: 'balanced' });
  assert.deepEqual(ruleViolations(x, planLeague(x, { objective: obj })), ruleViolations(y, planLeague(y, { objective: obj })));
  assert.notDeepEqual([...makeFuzzLeague(43).rosters], [...x.rosters]);
});

/* ------------------------------------------- the planner, every risk mode */

for (const mode of MODES) {
  for (const r of ENFORCED) {
    test(`fuzz ${mode}: ${r.name}`, t => {
      const bad = failures(mode, r);
      t.diagnostic(`seeds ${BASE}..${BASE + N - 1} + ${CORPUS.recorded.length} recorded; ${bad.length} violations`);
      assert.equal(bad.length, 0, report(mode, bad));
    });
  }
  for (const r of PENDING) {
    test(`fuzz ${mode}: ${r.name}`, { todo: r.todo }, t => {
      const bad = failures(mode, r);
      t.diagnostic(`${bad.length} violations in ${new Set(bad.map(b => b.seed)).size} of ${SEEDS.length} leagues`);
      assert.equal(bad.length, 0, report(mode, bad));
    });
  }
  test(`fuzz ${mode}: the sweep searched real offers`, t => {
    const rs = runMode(mode);
    const offers = rs.reduce((s, r) => s + r.res.candidates_scored, 0);
    const withDeck = rs.filter(r => r.res.deck.length > 0).length;
    t.diagnostic(`${rs.length} leagues, ${rs.reduce((s, r) => s + r.a.rosters.size, 0)} rosters, ${offers} candidate plans, ${withDeck} with a deck`);
    // A sweep where the planner found nothing would pass every rule vacuously.
    assert.ok(withDeck >= rs.length / 2, `${mode}: only ${withDeck} of ${rs.length} leagues produced a deck`);
  });
}

/* ------------------------------------- random offers at the planner's gates */

test('gate fuzz: 6,000 random offers, every mode; the tolerance gate never keeps a give of 160 or 80', () => {
  const r = rng(CORPUS.gate_seed);
  let kept = 0;
  for (let i = 0; i < 2000; i++) {
    const pool = [NICO_COLLINS, CHASE_BROWN, AJ_BROWN, ...Array.from({ length: 12 }, (_, k) => 1000 + k)];
    const give = [...new Set(Array.from({ length: 1 + Math.floor(r() * 3) }, () => pool[Math.floor(r() * pool.length)]))];
    const plan = { steps: [{ team: String(2 + Math.floor(r() * 6)), give, get: [2000 + i], p: 0.05 + r() * 0.9, delta: r() * 0.05 - 0.005, se: 0.003 }] };
    for (const mode of MODES) {
      const { ranked } = rankPlans([plan], mode, tolerancesFor(mode), { originalIds: pool, untouchables: [String(NICO_COLLINS), String(CHASE_BROWN)] });
      for (const p of ranked) {
        kept++;
        assert.ok(!p.steps.some(s => s.give.some(id => id === NICO_COLLINS || id === CHASE_BROWN)), `gate seed ${CORPUS.gate_seed} offer ${i} ${mode}: ${give}`);
      }
    }
  }
  assert.ok(kept > 1000, `only ${kept} offers passed the gate: the property was barely exercised`);
});

test('gate fuzz: 5,000 random packages; the cap at 0 never lets more value out than in', () => {
  const r = rng(CORPUS.gate_seed + 1);
  for (let i = 0; i < 5000; i++) {
    const give = Math.round(r() * 12000), get = Math.round(r() * 12000);
    assert.equal(nickOverpays(give, get, 0), give > get, `gate seed ${CORPUS.gate_seed + 1} package ${i}: ${give} for ${get}`);
  }
});

test('finalGets: a chip picked up and spent is not final; one kept is', () => {
  const steps = [{ give: [1], get: [50] }, { give: [50, 2], get: [99] }];
  assert.deepEqual(finalGets({ steps }, [1, 2, 3]), ['99']);
  assert.deepEqual(finalGets({ steps: [{ give: [1], get: [50] }, { give: [2], get: [99] }] }, [1, 2, 3]).sort(), ['50', '99']);
  assert.deepEqual(RULES, ['never_give', 'aj_brown', 'final_get', 'overpay', 'no_olave', 'no_reversal']);
});
