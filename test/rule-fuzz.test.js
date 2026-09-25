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
 * Every rule is a hard test and this file is a required CI test (npm test runs test/*.test.js in
 * .github/workflows/ci.yml). Batch A (main decf7ebf, integration-7) enforces all of them on the served
 * path, measured at 0 violations in every mode before the `todo`s were removed. A PR that breaks one of
 * Nick's rules on any seed now turns CI red. A new rule whose enforcement is not on main yet goes in
 * PENDING (node:test `todo`, runs in full, prints its count) until its PR merges.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { rankPlans, tolerancesFor, MODES } = await import('../server/services/campaign/modes.js');
const { nickOverpays } = await import('../server/services/campaign/search.js');
const { makeFuzzLeague, rng, NICO_COLLINS, CHASE_BROWN, AJ_BROWN, OLAVE_ID } = await import('./fixtures/rule-fuzz-league.mjs');
const { ruleViolations, countByRule, finalGets, dealOfKey, RULES, ownExpected } = await import('./fixtures/nick-rules.mjs');

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
  // Without Nick's notes only main's never-give.js id pins protect them.
  { rule: 'never_give', name: '160 and 80 never given (notes missing)', when: a => !a.draw.notes },
  { rule: 'overpay', name: 'no overpay beyond the 1c exception' },
  { rule: 'aj_brown', name: 'A.J. Brown only for a consistent Blue chip' },
  { rule: 'final_get', name: 'every final get scores 83+' },
  { rule: 'no_olave', name: 'Chris Olave never offered or targeted' },
  { rule: 'no_buyback', name: 'no buy-back, from any team, of a player sold this season' },
  { rule: 'no_undo', name: 'no trade made this season is undone' },
  { rule: 'stranded_hold', name: 'every holding between legs scores 83+ (FLIP-STRANDED)' },
  { rule: 'beats_no_trade', name: 'every served card, backup, catch-up deal, ladder and second package beats doing nothing on the confirm dice' },
];
/** Rules whose enforcement is not on main yet: { rule, name, todo: 'the PR that enforces it' }. None today. */
const PENDING = [];

/**
 * Non-vacuity floor: the share of leagues each mode must serve a deck in. Measured on main decf7ebf,
 * seeds 1..300: safe 145, balanced 296, all_in 296 (Nick's own measurement of Safe was 142/300).
 * Safe is low by design, not by fault: since integration-7 a Safe card is served only when it beats
 * doing nothing on the confirm dice under Safe's tolerances, and in about half the random leagues no
 * Safe move does, so Safe explicitly picks no trade there. The old bar (a deck OR a no-trade pick in
 * half the leagues) passed Safe even at 0 decks, which is how #398's pre-merge Safe collapse (0 of 80)
 * went through. The floors sit about 15% under the measurement: a regression back toward
 * "Safe serves nothing" fails, fixture noise from a changed seed range does not. Raise them when a PR
 * deliberately serves more; lowering one needs a written reason in that PR.
 */
const MIN_DECK_SHARE = { safe: 0.40, balanced: 0.85, all_in: 0.85 };

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
  const moves = a.tradeLedger.trades.flatMap(t => t.moves);
  const sold = moves.find(m => m.from === me && m.player !== OLAVE_ID) ?? moves.find(m => m.from === me);
  const elsewhere = [...a.rosters.keys()].find(t => t !== me && t !== sold.to);
  const twoWay = a.tradeLedger.trades.find(t => t.moves.some(m => m.from === me) && t.moves.some(m => m.to === me));
  const step = (team, give, get) => ({ team, give, get, p: 0.5, delta: 0.01 });
  const plan = steps => ({ steps, target: steps.at(-1).get[0], expected: 0.01 });
  const res = { deck: [], suggestions: [], targets: [], flip: { realised: [] }, best: null };
  const cases = [
    ['never_give', plan([step(other, [NICO_COLLINS], [cheap])])],
    ['aj_brown', plan([step(other, [AJ_BROWN], [cheap])])],
    ['final_get', plan([step(other, [mine.find(id => id > 999)], [cheap])])],
    ['overpay', plan([step(other, [CHASE_BROWN], [cheap])])],
    ['no_olave', plan([step(a.draw.olave_team, [mine[0]], [OLAVE_ID])])],
    // Sold to one team, now bought from another: still a buy-back.
    ['no_buyback', plan([step(elsewhere, [mine[0]], [sold.player])])],
    // Leg 1 picks up a sub-83 piece that leg 2 spends: Nick is stranded with it if leg 2 is turned down.
    ['stranded_hold', plan([step(other, [mine.find(id => id > 999)], [cheap]),
      step(other, [cheap, mine.filter(id => id > 999)[1]], [a.rosters.get(other).find(id => id !== cheap && a.scoreOf(id).score >= 83) ?? cheap])])],
    ['no_undo', plan([step(twoWay.moves.find(m => m.from === me).to, [twoWay.moves.find(m => m.to === me).player],
      [twoWay.moves.find(m => m.from === me).player])])],
  ];
  for (const [rule, p] of cases) {
    if (rule === 'aj_brown' && !mine.includes(AJ_BROWN)) continue;
    const got = countByRule(ruleViolations(a, { ...res, best: p }));
    assert.ok(got[rule] > 0, `${rule} not caught: ${JSON.stringify(got)}`);
  }
  // Flip claims (Nick 2026-09-25): a claimed free agent traded away later passes between legs; claimed and
  // kept, or got by trade, a sub-83 piece between legs fails.
  const blueThere = a.rosters.get(other).find(id => id !== cheap && id !== OLAVE_ID && a.scoreOf(id).score >= 83);
  const fa = 7777;
  const faClaim = step('free_agent', [mine.filter(id => id > 999)[2]], [fa]);
  const stranded = steps => countByRule(ruleViolations(a, { ...res, best: plan(steps) })).stranded_hold;
  if (blueThere) {
    assert.equal(stranded([{ ...faClaim, claim: true }, step(other, [fa, mine.filter(id => id > 999)[1]], [blueThere])]), 0, 'a claim flipped later passes');
    assert.equal(stranded([{ ...faClaim, claim: true }, step(other, [mine.filter(id => id > 999)[1]], [blueThere])]), 1, 'a claim held at the end fails');
    assert.equal(stranded([step(other, [mine.filter(id => id > 999)[2]], [cheap]), step(other, [cheap, mine.filter(id => id > 999)[1]], [blueThere])]), 1, 'a traded-for sub-83 intermediate fails');
  }
  // Sending back a player Nick got is not itself a rule break (only the two-way undo is).
  const gotBack = moves.find(m => m.to === me);
  const oneWay = countByRule(ruleViolations(a, { ...res, best: plan([step(gotBack.from, [gotBack.player], [cheap])]) }));
  assert.equal(oneWay.no_undo, 0);
  assert.equal(oneWay.no_buyback, 0);
  // beats_no_trade: a failed confirm verdict, and a card that does not gain on the confirm dice.
  const card = (verdict, expected) => ({ plan: { ...plan([step(other, [mine[0]], [cheap])]), expected }, confirm: { verdict } });
  assert.equal(countByRule(ruleViolations(a, { ...res, deck: [card('failed', 0.01)] })).beats_no_trade, 1);
  assert.equal(countByRule(ruleViolations(a, { ...res, deck: [card('holds', 0)] })).beats_no_trade, 1);
  assert.equal(countByRule(ruleViolations(a, { ...res, deck: [card('holds', 0.01)] })).beats_no_trade, 0);
  assert.equal(countByRule(ruleViolations(a, { ...res, backups: [{ step: step(other, [mine[0]], [cheap]), expected: -0.001 }] })).beats_no_trade, 1);
  assert.equal(countByRule(ruleViolations(a, { ...res, deck: [{ ...card('holds', 0.01), beats_no_trade: false }] })).beats_no_trade, 1);
  // Catch-up deals, ladder cards and on_no backups, and the second package all need a confirm-dice gain > 0.
  const beats = r => countByRule(ruleViolations(a, { ...res, ...r })).beats_no_trade;
  const key = `${other}|${mine[0]}|${cheap}`;
  assert.equal(beats({ catch_up: [{ kind: 'desperate', gain: 0, plan_key: key }] }), 1, 'desperate at 0');
  assert.equal(beats({ catch_up: [{ kind: 'swing', gain: -0.01, plan_key: key }] }), 1, 'swing below 0');
  assert.equal(beats({ catch_up: [{ kind: 'flip', gain: null, player: cheap }] }), 1, 'flip not priced');
  assert.equal(beats({ catch_up: [{ kind: 'desperate', gain: null, team: other }, { kind: 'timing', gain: null }] }), 0, 'no deal named: nothing to beat');
  assert.equal(beats({ catch_up: [{ kind: 'desperate', gain: 0.01, plan_key: key }] }), 0);
  const rung = (extra = {}) => ({ partner: other, give: [String(mine[0])], get: [String(cheap)], ...extra });
  assert.equal(beats({ ladders: { dice: 'planning', cards: [{ expected: 0.02, rungs: [rung()] }] } }), 1, 'ladder on the planning dice');
  assert.equal(beats({ ladders: { cards: [{ dice: 'confirm', expected: 0, rungs: [rung()] }] } }), 1, 'ladder at 0 on the confirm dice');
  assert.equal(beats({ ladders: { cards: [{ dice: 'confirm', expected: 0.02, rungs: [rung({ on_no: { kind: 'backup', ...rung(), expected: 0.01, dice: 'planning' } })] }] } }), 1, 'on_no backup on the planning dice');
  assert.equal(beats({ ladders: { cards: [{ dice: 'confirm', expected: 0.02, rungs: [rung({ on_no: { kind: 'stop', keep: 0 } }), rung({ on_no: { kind: 'backup', ...rung(), expected: 0.01, dice: 'confirm' } })] }] } }), 0);
  const alt = x => ({ deck: [{ ...card('holds', 0.01), playbook: { step_index: 0, ladder: {}, negotiation: { alt_package: { give: [String(mine[0])], get: [String(cheap)], ...x } } } }] });
  assert.equal(beats(alt({})), 1, 'second package with no confirm-dice gain');
  assert.equal(beats(alt({ dice: 'confirm', expected: -0.01 })), 1, 'second package loses on the confirm dice');
  assert.equal(beats(alt({ dice: 'confirm', expected: 0.01 })), 0);
  // A clean even 1-for-1 for a Blue chip, not Olave, not a move-back, breaks nothing.
  const moved = new Set(moves.map(m => m.player));
  const blueOut = a.rosters.get(other).find(id => a.scoreOf(id).score >= 83 && id !== OLAVE_ID && !moved.has(id));
  const giveIt = blueOut && mine.find(id => id > 999 && !moved.has(id) && a.players.get(id).value >= a.players.get(blueOut).value && a.scoreOf(id).score < 83);
  if (blueOut && giveIt) assert.deepEqual(ruleViolations(a, { ...res, best: plan([step(other, [giveIt], [blueOut])]) }), []);
});

test('every listed surface is read: catch-up, playbooks, replies, alt_package, ladders', () => {
  const a = makeFuzzLeague(7, { notes: false, ledger: true });
  const other = [...a.rosters.keys()].find(t => t !== a.league.me);
  const theirs = a.rosters.get(other).find(id => id !== OLAVE_ID);
  const base = { deck: [], suggestions: [], targets: [], flip: { realised: [] }, best: null };
  const st = { team: other, give: [1001], get: [theirs], p: 0.5, delta: 0.01 };
  const bad = { partner: other, give: [NICO_COLLINS], get: [theirs] };
  const pb = extra => ({ step_index: 0, ladder: { opening: null, walk_away: null, ladder: [] }, ...extra });
  const surfaces = {
    'catch_up desperate': { ...base, catch_up: [{ kind: 'desperate', plan_key: `${other}|${NICO_COLLINS}|${theirs}` }] },
    'catch_up swing': { ...base, catch_up: [{ kind: 'swing', plan_key: `${other}|${CHASE_BROWN}+1001|${theirs}` }] },
    'reply table': { ...base, deck: [{ plan: { steps: [st], expected: 0.01 }, playbook: pb({ replies: [{ kind: 'decline', next: bad }] }) }] },
    'deck playbooks': { ...base, deck: [{ plan: { steps: [st, { ...st, give: [1002] }], expected: 0.01 },
      playbooks: [pb({}), pb({ step_index: 1, ladder: { walk_away: { give: [NICO_COLLINS] }, ladder: [] } })] }] },
    'negotiation.alt_package': { ...base, deck: [{ plan: { steps: [st], expected: 0.01 },
      playbook: pb({ negotiation: { alt_package: { give: [CHASE_BROWN], get: [theirs] } } }) }] },
    'ladder rung': { ...base, ladders: { cards: [{ rungs: [{ ...bad }, { partner: other, give: [1001], get: [theirs] }] }] } },
    'ladder on_no': { ...base, ladders: { cards: [{ rungs: [{ partner: other, give: [1001], get: [theirs], on_no: { kind: 'backup', ...bad } }] }] } },
  };
  for (const [name, res] of Object.entries(surfaces)) {
    assert.ok(countByRule(ruleViolations(a, res)).never_give > 0, `${name} not read`);
  }
  assert.deepEqual(dealOfKey(`3|160+80|1004`), { team: '3', give: ['160', '80'], get: ['1004'] });
  assert.equal(dealOfKey('none'), null);
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

test("the oracle's pinned ids are main's never-give.js ids (no 9001-style stand-ins)", async () => {
  // The oracle keeps its own copy of Nick's rule text on purpose (it must not share code with what it
  // checks); this pins the two together so neither can drift.
  const { PINNED_NEVER_GIVE, PINNED_NEVER_GET } = await import('../server/services/campaign/never-give.js');
  for (const id of [NICO_COLLINS, CHASE_BROWN, AJ_BROWN]) assert.ok(PINNED_NEVER_GIVE.includes(String(id)), `${id} not in PINNED_NEVER_GIVE`);
  assert.ok(PINNED_NEVER_GET.includes(String(OLAVE_ID)), `${OLAVE_ID} not in PINNED_NEVER_GET`);
  assert.deepEqual([NICO_COLLINS, CHASE_BROWN, AJ_BROWN, OLAVE_ID], [160, 80, 277, 290]);
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
    const keep = rs.filter(r => r.res.deck.length === 0 && noTradePick(r.res, mode)).length;
    t.diagnostic(`${rs.length} leagues, ${rs.reduce((s, r) => s + r.a.rosters.size, 0)} rosters, ${offers} candidate plans, ${withDeck} with a deck, ${keep} with an explicit no-trade pick`);
    // A league counts as searched when it serves a deck or explicitly picks keeping the roster on the
    // confirm dice (#398); a sweep with neither would pass every rule vacuously.
    assert.ok(withDeck + keep >= rs.length / 2, `${mode}: only ${withDeck} decks and ${keep} explicit no-trade picks in ${rs.length} leagues`);
    const floor = Math.ceil(MIN_DECK_SHARE[mode] * rs.length);
    assert.ok(withDeck >= floor, `${mode}: decks in ${withDeck} of ${rs.length} leagues, under the floor of ${floor} (MIN_DECK_SHARE ${MIN_DECK_SHARE[mode]})`);
  });
}

/** The mode's own row on the risk-mode sheet picks keeping the roster (#398 NO-TRADE-SHRINK's no_trade row). */
function noTradePick(res, mode) {
  return (res.risk_modes ?? []).find(m => m.mode === mode)?.no_trade?.pick === 'no_trade';
}

test('fuzz: at least one risk mode serves decks in half the leagues', t => {
  const decks = Object.fromEntries(MODES.map(mode => [mode, runMode(mode).filter(r => r.res.deck.length > 0).length]));
  t.diagnostic(`leagues with a deck: ${JSON.stringify(decks)} of ${SEEDS.length}`);
  assert.ok(Object.values(decks).some(n => n >= SEEDS.length / 2), `no mode serves decks: ${JSON.stringify(decks)}`);
});

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
  assert.deepEqual(RULES, ['never_give', 'aj_brown', 'final_get', 'overpay', 'no_olave', 'no_buyback', 'no_undo', 'beats_no_trade',
    'claim_not_flipped', 'claim_protected_drop', 'claim_stranded', 'stranded_hold']);
});

/* ------------------------------ FLIP-CLAIMS: claims as flip pieces, SEARCH-WIDE on */

/**
 * Nick 2026-09-25: a waiver claim is a step only as a flip piece. The sweep plans made-up leagues that carry a
 * free-agent pool (makeFuzzLeague(seed, { claims: true })) with SEARCH-WIDE on, and the oracle reads every claim
 * path the planner reports (search_wide.claims.paths, shadow) against every rule, the three claim rules included.
 * Budgets are cut so the sweep stays in CI time; the rules do not depend on the budget.
 */
const CLAIM_N = envInt('RULE_FUZZ_CLAIMS_N', CORPUS.claims_sweep?.count ?? 40);
const CLAIM_BASE = envInt('RULE_FUZZ_CLAIMS_BASE', CORPUS.claims_sweep?.base ?? 1);
const CLAIM_SEEDS = Array.from({ length: CLAIM_N }, (_, i) => CLAIM_BASE + i);
const WIDE_ENV = { GRIDIRON_SEARCH_WIDE: '1', GRIDIRON_SEARCH_WIDE_CANDIDATES: '300', GRIDIRON_SEARCH_WIDE_RESCORES: '600' };
const claimRuns = new Map();
function runClaims(mode) {
  if (claimRuns.has(mode)) return claimRuns.get(mode);
  const out = [];
  for (const seed of CLAIM_SEEDS) {
    const a = makeFuzzLeague(seed, { claims: true });
    const res = planLeague(a, { objective: normaliseObjective({ risk_mode: mode }), env: WIDE_ENV });
    assert.equal(res.error, undefined, `claims seed ${seed} ${mode}: ${res.error}`);
    out.push({ seed, a, res, v: ruleViolations(a, res) });
  }
  claimRuns.set(mode, out);
  return out;
}

test('the oracle catches each claim rule on a hand-built claim path', () => {
  const a = makeFuzzLeague(7, { claims: true });
  const me = a.league.me, mine = a.rosters.get(me);
  const other = [...a.rosters.keys()].find(t => t !== me);
  const depth = mine.find(id => id > 999 && a.scoreOf(id).score < 83);
  const blue = mine.find(id => id > 999 && a.scoreOf(id).score >= 83) ?? NICO_COLLINS;
  const fa = 3001;
  const theirs = a.rosters.get(other).find(id => id !== OLAVE_ID);
  const st = (partner, give, get, p, delta, claim = false) => ({ partner, give: give.map(String), get: get.map(String), p, delta, ...(claim ? { claim } : {}) });
  const path = (steps, dice = 'confirm') => ({ search_wide: { claims: { paths: [{ dice, expected: ownExpected(steps), steps }] } } });
  const base = { deck: [], suggestions: [], targets: [], flip: { realised: [] }, best: null };
  const got = r => countByRule(ruleViolations(a, { ...base, ...r }));
  const flipped = [st('free_agent', [depth], [fa], 0.7, 0), st(other, [fa], [theirs], 0.5, 0.02)];
  assert.equal(got(path(flipped)).claim_not_flipped, 0);
  assert.equal(got(path([st(other, [mine[0]], [theirs], 0.5, 0.02), st('free_agent', [depth], [fa], 0.7, 0.03, true)])).claim_not_flipped, 1, 'claim at the end');
  const withClaim = s => s.map((x, i) => (i === 0 ? { ...x, claim: true } : x));
  assert.equal(got(path(withClaim(flipped))).claim_not_flipped, 0);
  assert.equal(got(path(withClaim([st('free_agent', [depth], [fa], 0.7, 0), st(other, [mine[0]], [theirs], 0.5, 0.02)]))).claim_not_flipped, 1, 'claimed, then kept');
  for (const d of [NICO_COLLINS, CHASE_BROWN, blue]) {
    assert.ok(got(path(withClaim([st('free_agent', [d], [fa], 0.7, 0), st(other, [fa], [theirs], 0.5, 0.02)]))).claim_protected_drop > 0, `drop ${d}`);
  }
  assert.equal(got(path(withClaim(flipped))).claim_protected_drop, 0);
  const obj = got({ ...path(withClaim(flipped)), objective: { untouchables: [String(depth)] } });
  assert.equal(obj.claim_protected_drop, 1, 'an objectives-file untouchable');
  // Stranded: claim done, flip declined leaves -0.05; the finish gains 0.02 at p 0.1: EV < 0.
  assert.equal(got(path(withClaim([st('free_agent', [depth], [fa], 0.9, -0.05), st(other, [fa], [theirs], 0.1, 0.02)]))).claim_stranded, 1);
  assert.equal(got(path(withClaim(flipped), 'planning')).claim_stranded, 1, 'not priced on the confirm dice');
  assert.equal(got(path(withClaim(flipped))).claim_stranded, 0);
  assert.ok(Math.abs(ownExpected([{ p: 0.9, delta: -0.05 }, { p: 0.1, delta: 0.02 }]) - (0.9 * 0.9 * -0.05 + 0.9 * 0.1 * 0.02)) < 1e-12);
});

for (const mode of MODES) {
  test(`fuzz claims ${mode}: every rule holds on every claim path (SEARCH-WIDE on)`, t => {
    const rs = runClaims(mode);
    const bad = rs.flatMap(r => r.v.map(v => ({ seed: r.seed, ...v })));
    const paths = rs.reduce((s, r) => s + (r.res.search_wide?.claims?.paths?.length ?? 0), 0);
    const built = rs.reduce((s, r) => s + (r.res.search_wide?.claims?.built ?? 0), 0);
    const why = {};
    for (const r of rs) for (const [k, n] of Object.entries(r.res.search_wide?.claims?.dropped_by_reason ?? {})) why[k] = (why[k] ?? 0) + n;
    t.diagnostic(`claims seeds ${CLAIM_BASE}..${CLAIM_BASE + CLAIM_N - 1}: built ${built}, reported ${paths} in ${rs.filter(r => r.res.search_wide?.claims?.paths?.length).length} leagues; dropped ${JSON.stringify(why)}`);
    assert.equal(bad.length, 0, `${mode}: ${bad.length} violations; first: ${bad.slice(0, 5).map(b => `seed ${b.seed} ${b.rule} ${b.surface} ${b.detail}`).join(' | ')}`);
    // Not vacuous: claims were built and some reached the oracle.
    assert.ok(built > 0, `${mode}: no claim built in ${rs.length} leagues`);
    assert.ok(paths > 0, `${mode}: no claim path reported in ${rs.length} leagues`);
  });
}

test('fuzz claims: no served step is a claim, and the sold free agent is never claimed', () => {
  for (const mode of MODES) {
    for (const r of runClaims(mode)) {
      const served = JSON.stringify([r.res.deck, r.res.best, r.res.backups, r.res.risk_modes, r.res.catch_up]);
      assert.equal(served.includes('free_agent'), false, `claims seed ${r.seed} ${mode}: a claim reached a served surface`);
      const soldFa = (r.a.tradeLedger?.trades ?? []).some(t => t.tx_id === `tx-${r.seed}-fa`);
      const claimed = (r.res.search_wide?.claims?.paths ?? []).flatMap(p => p.steps.filter(st => st.claim).flatMap(st => st.get));
      if (soldFa) assert.ok(!claimed.includes('3000'), `claims seed ${r.seed} ${mode}: sold 3000 claimed`);
    }
  }
});
