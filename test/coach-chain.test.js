/**
 * COACH-CHAIN: "after this move, what's the next move to fill the hole".
 *
 *   1. the chain applies moves in sequence, on a roster copy, and every number is the world's own rescore
 *      of that state (the War Room's producer), never a second computation;
 *   2. a hole is detected (Nick's weakest starting slot against the same slot on every team), and the
 *      slot lineup picks the same starters as the sim (season-sim.js#lineupStarters);
 *   3. RULE-FUZZ: every fill candidate and every suggested step, over made-up leagues whose rules come
 *      from the ONE gate (never-give.js#ruleGate on a throwaway DB), breaks none of Nick's rules;
 *   4. a step that gives a protected player (160 / 80) needs Nick's OK, or is blocked; never plain;
 *   5. the Coach answer cites only the chain producer's numbers (verify.js), the $0 lines and a recorded
 *      model narration alike; a narration with an invented number never ships.
 * Made-up leagues only (test/fixtures); no paid calls (callClaude is a recorded stand-in).
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-chain-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_WARROOM_PLANS = path.join(temp, 'plans.json');
delete process.env.GRIDIRON_WARROOM_OBJECTIVES;

// Recorded model replies: the test sets `reply` before a narrated turn; nothing goes out.
let reply = null;
let calls = 0;
const realClaude = await import('../server/services/claude.js?real');
mock.module('../server/services/claude.js', {
  namedExports: { ...realClaude, callClaude: async () => { calls++; return { content: [{ type: 'text', text: JSON.stringify(reply) }], cost_usd: 0 }; } } });

const { db, row, rows, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const NG = await import('../server/services/campaign/never-give.js');
const { FLEX_ELIGIBLE } = await import('../server/services/trade-engine.js');
const { lineupStarters } = await import('../server/services/season-sim.js');
const { chain, findHole, slotLineup, CHAIN_MAX_STEPS } = await import('../server/services/campaign/chain.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { chainView } = await import('../server/services/coach/chain-view.js');
const CI = await import('../server/services/coach/chain-intent.js');
const { newLedger } = await import('../server/services/coach/ledger.js');
const { verifyAnswer } = await import('../server/services/coach/verify.js');
const { resolveMoves, matchPlayers } = await import('../server/services/coach/chain-engine.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { makeFuzzLeague, rng, NICO_COLLINS, CHASE_BROWN } = await import('./fixtures/rule-fuzz-league.mjs');
const { ruleViolations } = await import('./fixtures/nick-rules.mjs');
const { scoreForRules } = await import('./fixtures/rule-gate.mjs');

const S = String;
const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
const PLAYOFFS = normaliseObjective({ goal: 'playoffs' });

/** Rules for the four-team fixture: every player priced at his value and scored a Blue chip. */
const fixtureRules = (a, { protectUpgrade = new Set(), scores = () => 90 } = {}) => ({
  neverGive: new Set(NG.PINNED_NEVER_GIVE), protectUpgrade, neverGet: new Set(NG.PINNED_NEVER_GET), sold: new Set(),
  fc: new Map([...a.players.values()].map(p => [S(p.id), p.value])), scoreOf: id => scores(id), closed: null, ajAllow: new Set(),
});

test('the chain applies moves in sequence on a copy; every number is the world rescore of that state', () => {
  const a = makeAdapter();
  const before = new Map([...a.rosters].map(([t, ids]) => [t, [...ids]]));
  const moves = [{ team: '3', give: [4], get: [21] }, { team: '2', give: [7], get: [15] }];
  const res = chain(a, moves, { rules: fixtureRules(a), slots: SLOTS, flex: FLEX_ELIGIBLE, objective: PLAYOFFS, extend: false });
  assert.equal(res.steps.length, 2);
  assert.deepEqual([...a.rosters], [...before], 'the adapter rosters are never touched');
  // The expected state after each step, built by hand; the chain's numbers are the world's rescore of it.
  const W = a.world(a.seed);
  const s1 = new Map([['1', [1, 2, 3, 5, 6, 7, 21]], ['3', [22, 23, 24, 25, 4]]]);
  const s2 = new Map([...s1, ['1', [1, 2, 3, 5, 6, 21, 15]], ['2', [11, 12, 13, 14, 7]]]);
  const nothing = W.rescore(new Map(), '1').me;
  for (const [k, st] of [[0, s1], [1, s2]]) {
    const me = W.rescore(st, '1').me;
    const step = res.steps[k];
    assert.equal(step.lineup.after, me.points_before + me.points_delta);
    assert.equal(step.playoff.after, me.playoff_after);
    assert.equal(step.playoff.total_delta, me.playoff_after - nothing.playoff_before);
  }
  assert.equal(res.steps[1].playoff.step_delta, res.steps[1].playoff.after - res.steps[0].playoff.after);
  assert.equal(res.totals.playoff.delta, res.steps[1].playoff.total_delta);
  assert.equal(res.nothing.playoff, nothing.playoff_before);
  // A give Nick no longer holds at that step stops the chain with the reason.
  const bad = chain(a, [{ team: '3', give: [4], get: [21] }, { team: '2', give: [4], get: [15] }],
    { rules: fixtureRules(a), slots: SLOTS, flex: FLEX_ELIGIBLE, objective: PLAYOFFS, extend: false });
  assert.match(bad.steps[1].error, /no longer have/);
  assert.equal(bad.totals.steps, 1);
});

test('the chain stops at 3 steps, and fills never trade away a player the chain brought in', () => {
  const a = makeAdapter();
  const res = chain(a, [{ team: '3', give: [4], get: [21] }], { rules: fixtureRules(a), slots: SLOTS, flex: FLEX_ELIGIBLE, objective: PLAYOFFS });
  assert.ok(res.steps.length <= CHAIN_MAX_STEPS);
  const got = new Set(res.steps.flatMap(s => s.move.get));
  for (const s of res.steps.slice(1)) assert.ok(!s.move.give.some(id => got.has(id) && res.steps.find(x => x.move.get.includes(id)).index < s.index), 'a chain get is kept');
  for (const s of res.steps) for (const f of s.fills ?? []) assert.ok(!f.give.some(id => res.steps.filter(x => x.index <= s.index).some(x => x.move.get.includes(id))));
  const last = res.steps.at(-1);
  if (res.steps.length === CHAIN_MAX_STEPS) assert.match(last.fills_status, /stops at 3/);
});

test('a hole is detected: the slot Nick ranks lowest in against the league, with its gaps', () => {
  const a = makeAdapter();
  const fa = [{ id: 41, name: 'P41', position: 'WR', ros_ppg: 9.5 }, { id: 42, name: 'P42', position: 'RB', ros_ppg: 4 }];
  const h = findHole({ rosters: a.rosters, players: a.players, me: '1', slots: SLOTS, flex: FLEX_ELIGIBLE, freeAgents: fa });
  // Nick's WRs (8 and 7) are the league's weakest starters there: his WR is the hole.
  assert.equal(h.slot, 'WR');
  assert.equal(h.rank, 4);
  assert.equal(h.of, 4);
  assert.ok(h.gap_to_median < 0);
  assert.deepEqual(h.replacement, { player: '41', ppg: 9.5 });
  assert.equal(h.gap_to_replacement, h.ppg - 9.5);
  // Nick names a position: the hole is read there.
  assert.equal(findHole({ rosters: a.rosters, players: a.players, me: '1', slots: SLOTS, flex: FLEX_ELIGIBLE, prefer: 'TE' }).slot, 'TE');
  // One lineup rule: the slot lineup starts exactly who the sim starts (season-sim.js#lineupStarters).
  for (const [, ids] of a.rosters) {
    const ps = ids.map(id => a.players.get(id));
    const sim = lineupStarters(ps, SLOTS, new Map(ps.map(p => [p.id, p.ros_ppg])));
    assert.deepEqual(slotLineup(ps, SLOTS, FLEX_ELIGIBLE).map(s => s.id).filter(x => x != null).sort(), sim.map(p => p.id).sort());
  }
});

test('flip claims fill a hole only when the world simulates free agents: claim, then flip him on (never kept)', () => {
  const a = makeAdapter();
  a.players.set(41, { id: 41, name: 'P41', position: 'WR', value: 1600, power: 9.5, ros_ppg: 9.5, injury: 0, bye: null, trend_kind: null });
  const scores = id => ([6, 7].includes(Number(id)) ? 50 : 90);
  const rules = fixtureRules(a, { scores });
  const off = chain(a, [], { rules, slots: SLOTS, flex: FLEX_ELIGIBLE, objective: PLAYOFFS, extend: false });
  assert.equal(off.steps.length, 0, 'no moves, no steps');
  const res = chain(a, [{ team: '4', give: [5], get: [34] }], { rules, slots: SLOTS, flex: FLEX_ELIGIBLE, objective: PLAYOFFS, extend: false });
  assert.match(res.steps[0].claims, /^off/, 'no claim universe: flip claims are off, with the reason');
  const wide = { ...a, claimUniverse: new Set(['41']), waiverRecord: { won: 6, lost: 4 } };
  const on = chain(wide, [{ team: '4', give: [5], get: [34] }], { rules, slots: SLOTS, flex: FLEX_ELIGIBLE, objective: PLAYOFFS, extend: false,
    prefer: 'WR', fills: 20 });
  assert.equal(on.steps[0].claims, 'on');
  assert.ok(on.steps[0].fills.some(x => x.kind === 'flip_claim'), 'a flip claim is among the fills');
  for (const f of on.steps[0].fills.filter(x => x.kind === 'flip_claim')) {
    assert.equal(f.steps[0].claim, true);
    assert.ok(f.steps[1].give.includes(f.steps[0].get[0]), 'the claimed player is flipped on');
    assert.ok(f.steps[0].give.every(id => scores(id) < 83), 'the drop is never a Blue chip');
  }
});

/* ------------------------------------------------------------------ RULE-FUZZ */

const ESPN = id => 50000 + Number(id);
const GATE_RULES = new Set(['never_give', 'aj_brown', 'final_get', 'overpay', 'no_olave', 'no_buyback', 'no_undo']);
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (league_id, season, tx_id))`);

/** One fuzz league where the gate reads it (the pattern of test/rule-fuzz-surfaces.test.js). */
function install(a) {
  const L = a.league.id;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    run('DELETE FROM player_metrics'); run('DELETE FROM players'); run('DELETE FROM league_transactions_raw');
    run('DELETE FROM leagues WHERE id = ?', L);
    for (const p of a.players.values()) {
      run('INSERT INTO players (id, name, position, espn_id) VALUES (?, ?, ?, ?)', p.id, p.name, p.position, ESPN(p.id));
      run(`INSERT INTO player_metrics (player_id, source, value) VALUES (?, 'fc_value', ?)`, p.id, Math.max(0, p.value));
    }
    run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id, connection_status)
         VALUES (?, 'espn', ?, 2026, 'Fuzz', '{"teams":[]}', ?, ?, 'connected')`, L, `fuzz-${L}`, a.league.team_count, a.league.me);
    for (const t of a.tradeLedger?.trades ?? []) {
      run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, processed_at, items_json, first_seen_at, last_seen_at)
           VALUES (?, 2026, ?, 'TRADE_ACCEPT', 'EXECUTED', 'PROCESS', ?, ?, 'now', 'now')`, L, t.tx_id, new Date(t.at).toISOString(),
      JSON.stringify(t.moves.map(m => ({ playerId: ESPN(m.player), fromTeamId: Number(m.from), toTeamId: Number(m.to), type: 'TRADE' }))));
    }
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
  scoreForRules(L, new Map([...a.players.values()].map(p => [S(p.id), a.scoreOf(p.id).score])));
}

const SEEDS = Number(process.env.COACH_CHAIN_FUZZ_SEEDS ?? 40);

test(`RULE-FUZZ, ${SEEDS} made-up leagues: every fill and every suggested step passes every rule the gate enforces`, () => {
  let fills = 0, suggested = 0, hidden = 0, needsOk = 0, protectedSteps = 0, lookahead = 0;
  const fails = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const a = makeFuzzLeague(seed);
    install(a);
    const gate = NG.ruleGate({ row, rows }, { leagueId: a.league.id });
    const me = a.league.me;
    const r = rng(seed * 7 + 3);
    const others = [...a.rosters.keys()].filter(t => t !== me);
    const team = others[Math.floor(r() * others.length)];
    // Nick's hypothetical first move: a random piece of his (the protected players included on purpose) for a random player of theirs.
    const mine = a.rosters.get(me);
    const give = [mine[Math.floor(r() * mine.length)]];
    const get = [a.rosters.get(team)[Math.floor(r() * a.rosters.get(team).length)]];
    const res = chain(a, [{ team, give, get }], { rules: gate.rules, slots: SLOTS, flex: FLEX_ELIGIBLE, objective: PLAYOFFS });
    assert.ok(!res.error, res.error);
    for (const s of res.steps) {
      if (s.error) continue;
      hidden += s.reach?.hidden_by_rules ?? 0;
      if (s.move.give.some(id => [S(NICO_COLLINS), S(CHASE_BROWN)].includes(id))) {
        protectedSteps++;
        // A protected player moves only as a Needs-your-OK step, or the step is blocked.
        assert.ok(s.rules.needs_ok || (!s.rules.ok && s.rules.reasons.includes('never_give')), `seed ${seed}: protected step is plain`);
        if (s.rules.needs_ok) needsOk++;
      }
      // Each offer as the oracle reads a planned step: a protected player's step carries its own rise (the chain's paired dice).
      const asStep = (st, d) => ({ team: st.team, give: st.give, get: st.get,
        ...(d ? { protected_upgrade: { confirmed: { points_delta: d.lineup, playoff_delta: d.playoff } } } : {}) });
      const offers = [...(s.source === 'suggested' ? [asStep(s.move, { lineup: s.lineup.step_delta, playoff: s.playoff.step_delta })] : []),
        ...(s.fills ?? []).map(f => asStep(f.steps.at(-1), { lineup: f.lineup.step_delta, playoff: f.playoff.step_delta }))];
      if (s.source === 'suggested') suggested++;
      fills += (s.fills ?? []).length;
      for (const st of offers) {
        for (const v of ruleViolations(a, { best: { steps: [st] } }, { protectUpgrade: gate.rules.protectUpgrade }).filter(x => GATE_RULES.has(x.rule))) {
          if (fails.length < 5) fails.push(`seed ${seed} step ${s.index}: ${v.rule} ${v.detail}`);
        }
      }
      for (const f of s.fills ?? []) {
        assert.equal(f.rules.ok, true);
        assert.ok(f.metric_gain > 0, 'every fill beats doing nothing given the chain before it');
      }
    }
    // LOOKAHEAD: every ranked first move and every move of its line is an offer Nick could see.
    for (const f of res.lookahead?.first_moves ?? []) {
      lookahead += f.line.length;
      // Nick's own hypothetical is ranked with the rest but is his move, not an offer the search made: its later moves are checked.
      for (const m of f.yours ? f.line.slice(1) : f.line) {
        assert.equal(typeof m.p, 'number');
        for (const v of ruleViolations(a, { best: { steps: [{ team: m.team, give: m.give, get: m.get }] } }, { protectUpgrade: gate.rules.protectUpgrade })
          .filter(x => GATE_RULES.has(x.rule) && !(x.rule === 'never_give' && m.needs_ok))) {
          if (fails.length < 5) fails.push(`seed ${seed} lookahead: ${v.rule} ${v.detail}`);
        }
        if (m.give.some(id => [S(NICO_COLLINS), S(CHASE_BROWN)].includes(id))) assert.equal(m.needs_ok, true, 'a protected player in a ranked move needs OK');
      }
    }
  }
  console.log(`# COACH-CHAIN rule-fuzz: ${lookahead} lookahead moves;`);
  console.log(`# COACH-CHAIN rule-fuzz: ${SEEDS} leagues, ${fills} fills, ${suggested} suggested steps, ${hidden} fits hidden by rules, ${protectedSteps} protected first moves (${needsOk} needs-OK)`);
  assert.deepEqual(fails, []);
  assert.ok(fills > 0 && hidden > 0, `not vacuous: ${fills} fills, ${hidden} hidden`);
});

test('a step that gives a protected player needs Nick\'s OK: never a plain Send, and Coach says so', async () => {
  // Find a fuzz league with a true tier up for Nico (a Blue chip scoring AND valued above him) whose step raises both numbers.
  let found = null;
  for (let seed = 1; seed <= 80 && !found; seed++) {
    const a = makeFuzzLeague(seed);
    const me = a.league.me;
    const nico = a.players.get(NICO_COLLINS);
    for (const [t, ids] of a.rosters) {
      if (t === me || found) continue;
      for (const x of ids) {
        const p = a.players.get(x);
        if (!(p.score >= 83 && p.score > nico.score && p.value > nico.value) || x === 290) continue;
        install(a);
        const rules = NG.ruleGate({ row, rows }, { leagueId: a.league.id }).rules;
        const res = chain(a, [{ team: t, give: [NICO_COLLINS], get: [x] }], { rules, slots: SLOTS, flex: FLEX_ELIGIBLE, objective: PLAYOFFS, extend: false });
        if (res.steps[0].rules.needs_ok) { found = { a, res }; break; }
      }
    }
  }
  assert.ok(found, 'a fuzz league holds a tier up for Nico that raises both numbers');
  const { a, res } = found;
  assert.equal(res.steps[0].rules.ok, true);
  const view = chainView({ ...res, names: Object.fromEntries([...a.players.values()].map(p => [S(p.id), p.name])), teams: {} });
  assert.equal(view.steps[0].needs_ok, true);
  assert.equal(view.steps[0].send.enabled, false, 'no Send on a step that needs Nick\'s OK');
  assert.equal(view.totals.needs_ok, true);
  CI.setChainEngine(async () => ({ ...res, names: Object.fromEntries([...a.players.values()].map(p => [S(p.id), p.name])), teams: {} }));
  const out = await CI.chainAnswer({ question: 'what if I trade Nico Collins for someone', leagueId: a.league.id, parsed: { kind: 'new', moves: [] } });
  assert.ok(out.answer.shape.risks.some(r => /^Needs your OK/.test(r.text)), 'the answer says Needs your OK');
  CI.setChainEngine(null);
});

/* ------------------------------------------------------------------ Coach */

function recorded() {
  const a = makeAdapter();
  const res = chain(a, [{ team: '3', give: [4], get: [21] }], { rules: fixtureRules(a), slots: SLOTS, flex: FLEX_ELIGIBLE, objective: PLAYOFFS });
  return { ...res, as_of: 'fixture', names: Object.fromEntries([...a.players.values()].map(p => [S(p.id), p.name])),
    teams: Object.fromEntries([...a.rosters.keys()].map(t => [t, `Team ${t}`])) };
}

test('Coach reads a chain question into moves (words only), and after that re-reads the chain in focus', () => {
  assert.deepEqual(CI.parseChainQuestion('what if I get Amon-Ra for Nico, Etienne and Price'),
    { kind: 'new', moves: [{ get: ['Amon-Ra'], give: ['Nico', 'Etienne', 'Price'] }] });
  assert.deepEqual(CI.parseChainQuestion('What if I trade Nico, Kelce and Price for Amon-Ra with team 10?'),
    { kind: 'new', moves: [{ give: ['Nico', 'Kelce', 'Price'], get: ['Amon-Ra'], team: '10' }] });
  const focus = { chain: [{ team: '10', give: ['160'], get: ['134'] }] };
  assert.deepEqual(CI.parseChainQuestion('after that, who fills RB?', { focus }), { kind: 'after', prefer: 'RB' });
  assert.equal(CI.parseChainQuestion('after that, who fills RB?'), null, 'no chain in focus: not a chain question');
  assert.equal(CI.parseChainQuestion("what's my next move?"), null);
  assert.equal(CI.parseChainQuestion('what if he says no'), null);
  // Names resolve against the rosters; an ambiguous one is asked about, never guessed.
  const a = makeAdapter();
  assert.deepEqual(matchPlayers('p21', [{ id: 21, name: 'P21' }, { id: 22, name: 'P22' }]).map(p => p.id), [21]);
  assert.deepEqual(resolveMoves(a, [{ give: ['P4'], get: ['P21'] }]), { moves: [{ team: '3', give: ['4'], get: ['21'] }] });
  assert.match(resolveMoves(a, [{ give: ['P99'], get: ['P21'] }]).error, /not on your roster/);
});

test('the Coach answer cites only the chain producer\'s numbers ($0 lines)', async () => {
  const res = recorded();
  CI.setChainEngine(async () => res);
  const out = await CI.chainAnswer({ question: 'what if I get P21 for P4', leagueId: 99, hasModel: false });
  CI.setChainEngine(null);
  assert.equal(out.model, 'none:chain');
  assert.equal(out.verification.ok, true, JSON.stringify(out.verification.violations));
  assert.deepEqual(out.dropped, [], 'every $0 line grounds');
  const s = out.answer.shape;
  assert.match(s.verdict.text, /^(Make|Weigh|Prefer|No)\b/, 'verb-first verdict');
  assert.ok(s.why.filter(w => /^Step \d/.test(w.text)).every(w => /vs doing nothing/.test(w.text)) && s.why.some(w => /^Step 1/.test(w.text)),
    'each step line says its change vs doing nothing');
  assert.ok(s.why.some(w => /^With the best follow-ups/.test(w.text)), 'now vs with the best follow-ups');
  assert.ok(s.more.some(m => /^#1 by what it sets up/.test(m.text)) && s.more.some(m => /^Doing nothing now, then the best moves/.test(m.text)), 'ranked first moves and the baseline');
  assert.ok(s.more.some(m => /^Hole after step/.test(m.text)), 'the hole');
  // Every number any line states is in a chain_read cell that line cites.
  const ledger = newLedger();
  for (const q of out.ledger.queries) ledger.record(q);
  for (const line of [s.verdict, ...s.why, ...s.risks, ...s.more]) {
    assert.ok(line.cites.every(c => c.startsWith('r1#')), 'cites the chain rows only');
    assert.equal(verifyAnswer({ answer: { claims: [line], as_of: 'x' }, ledger }).ok, true, line.text);
  }
  assert.equal(out.ledger.queries[0].tool, 'chain_read');
  assert.deepEqual(out.chain_moves, [{ team: '3', give: ['4'], get: ['21'] }]);
  assert.ok(out.view.steps.length >= 1 && out.view.totals, 'the Chain card rides with the answer');
  assert.ok(!JSON.stringify(out.view).match(/"(?:\d+)"|_delta|_after/), 'no ids or field names on screen');
});

test('a recorded narration ships only when every number is a cited producer cell; an invented number falls back to the $0 lines', async () => {
  const res = recorded();
  CI.setChainEngine(async () => res);
  const step = res.steps[0];
  const lineCite = 'r1#0.lineup_total_delta';
  reply = { verdict: { text: 'Weigh the P21 trade before sending it.', cites: ['r1#0.get_name'] }, stance: 'wait', basis: 'roster fit', basis_key: 'roster_fit',
    why: [{ text: `Step 1 moves your lineup ${step.lineup.total_delta >= 0 ? '+' : ''}${step.lineup.total_delta.toFixed(1)} pts/wk vs doing nothing.`, cites: [lineCite] }],
    risks: [], refusals: [], as_of: null };
  calls = 0;
  const good = await CI.chainAnswer({ question: 'what if I get P21 for P4', leagueId: 99, hasModel: true });
  assert.equal(calls, 1);
  assert.equal(good.model, CI.NARRATE_MODEL, 'the grounded narration ships');
  assert.equal(good.answer.shape.why[0].text, reply.why[0].text);
  // One grounded line and one invented: the invented line is dropped, the rest ships.
  const goodWhy = reply.why[0];
  reply = { ...reply, why: [goodWhy, { text: 'Step 1 also adds +9.9 pts of title odds.', cites: [lineCite] }] };
  const mixed = await CI.chainAnswer({ question: 'what if I get P21 for P4', leagueId: 99, hasModel: true });
  assert.equal(mixed.model, CI.NARRATE_MODEL);
  assert.deepEqual(mixed.answer.shape.why.map(w => w.text), [goodWhy.text]);
  assert.equal(mixed.narration.dropped, 1);
  reply = { ...reply, why: [{ text: 'Step 1 moves your lineup +42.7 pts/wk vs doing nothing.', cites: [lineCite] }] };
  const bad = await CI.chainAnswer({ question: 'what if I get P21 for P4', leagueId: 99, hasModel: true });
  CI.setChainEngine(null);
  assert.equal(bad.model, 'none:chain', 'an invented number never ships: the $0 lines do');
  assert.ok(!JSON.stringify(bad.answer).includes('42.7'));
});

test('flag: off by default, on with its own flag or preview, and its own 0 vetoes preview', () => {
  const PREVIEW = 'GRIDIRON_PREVIEW_' + 'UNCONFIRMED';
  const was = process.env[PREVIEW];
  try {
    delete process.env[PREVIEW];
    assert.equal(CI.chainOn({}), false);
    assert.equal(CI.chainOn({ GRIDIRON_COACH_CHAIN: '1' }), true);
    process.env[PREVIEW] = '1';
    assert.equal(CI.chainOn({}), true);
    assert.equal(CI.chainOn({ GRIDIRON_COACH_CHAIN: '0' }), false);
  } finally { if (was == null) delete process.env[PREVIEW]; else process.env[PREVIEW] = was; }
});

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
