/**
 * integration-7 review: property test of Nick's hard rules on every served surface, all flags on,
 * every risk mode, random made-up leagues (test/fixtures/campaign-league.mjs, fixed seed loop).
 * Ids only; no real data. Each rule is its own test so a failure names the rule and the surface.
 *
 * Rules: 1 never give 160 / 80 / 277; 2 every final get scores 83+; 3 overpay cap 0 except a
 * depth-only 2-for-1 up to +12% confirmed on fresh dice; 4 no buy-back of a player sold THIS SEASON (any team, any price);
 * 5 no reversal;
 * 6 a served move beats doing nothing on the confirm dice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GRIDIRON_FLIP_LEGS = '1';
process.env.GRIDIRON_COACH_MESSAGES = '1';
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { makeAdapter, makePlayers } = await import('./fixtures/campaign-league.mjs');

const ENV = { GRIDIRON_GETS_FLOOR: '1', GRIDIRON_REACH: '1', GRIDIRON_TRADE_MEMORY_FLOOR: '1' };
const PINNED = new Set(['160', '80', '277']);
const MODES = ['safe', 'balanced', 'all_in'];
const SEEDS = Number(process.env.INT7_SEEDS ?? 25);
const DAY = 864e5;
const NOW = Date.parse('2026-09-24T12:00:00Z');

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; s ^= s >>> 13; return (s >>> 0) / 4294967296; };
}

function league(seed) {
  const r = rng(seed * 7919 + 1);
  const players = makePlayers();
  for (const id of [160, 80, 277]) players.set(id, { id, name: `P${id}`, position: id === 80 ? 'RB' : 'WR', value: 0, power: 0, ros_ppg: 0, injury: 0, bye: null, trend_kind: null });
  for (const p of players.values()) { p.value = Math.round(600 + r() * 4400); p.power = Math.round(4 + r() * 20); p.ros_ppg = p.power; }
  // The pinned three are Nick's best players, so every search wants to spend them.
  for (const id of [160, 80, 277]) { const p = players.get(id); p.value = 4000 + Math.round(r() * 2000); p.power = 22 + Math.round(r() * 5); }
  const a = makeAdapter({ seed: 1000 + seed, players });
  a.rosters.get('1').push(160, 80, 277); // in place: the fixture world reads this Map
  a.maxOverpay = 0;
  const scores = new Map([...players.keys()].map(id => [String(id), Math.round(50 + r() * 49)]));
  a.board = Object.fromEntries(scores);
  a.scoreOf = id => (scores.has(String(id)) ? { score: scores.get(String(id)), label: 'x' } : null);
  a.searchOpts = { twoForOne: r() < 0.7, flipLegs: true, fillers: 4, pairLimit: 60 };
  a.now = () => 0;
  // Trade ledger: Nick sold X (now on T) for Y (now on Nick), 1..60 days ago; the price then is 0.8..1.4x today's.
  const trades = [], then = new Map();
  const n = Math.floor(r() * 4);
  for (let k = 0; k < n; k++) {
    const T = String(2 + Math.floor(r() * 3));
    const theirs = a.rosters.get(T), mine = a.rosters.get('1').filter(id => !PINNED.has(String(id)));
    const X = theirs[Math.floor(r() * theirs.length)], Y = mine[Math.floor(r() * mine.length)];
    if (trades.some(t => t.moves.some(m => m.player === X || m.player === Y))) continue;
    const at = NOW - Math.round((1 + r() * 59) * DAY);
    trades.push({ tx_id: `t${k}`, at, moves: [{ player: X, from: '1', to: T }, { player: Y, from: T, to: '1' }] });
    then.set(X, Math.round(players.get(X).value * (0.8 + r() * 0.6)));
  }
  a.tradeLedger = { now: NOW, trades, unmapped: 0, valueAt: id => then.get(id) ?? null, history: true };
  return { a, scores, trades, then, players };
}

const runs = [];
for (let seed = 1; seed <= SEEDS; seed++) {
  for (const mode of MODES) {
    const L = league(seed);
    const res = planLeague(L.a, { objective: normaliseObjective({ risk_mode: mode }), env: ENV, budget: { targets: 8 } });
    runs.push({ seed, mode, L, res });
  }
}

const S = x => String(x);
const val = (L, id) => L.players.get(Number(id))?.value ?? 0;
const sum = (L, ids) => ids.reduce((s, id) => s + val(L, id), 0);
const sameIds = (x, y) => x.length === y.length && x.map(S).sort().join() === y.map(S).sort().join();

/** Every served step (with where it came from), every ladder package, every flip leg. */
function surfaces(res) {
  const steps = [], ladders = [], flips = [];
  const plans = [['best', res.best], ...res.deck.map((c, j) => [`deck[${j}]`, c.plan])].filter(([, p]) => p);
  for (const [w, p] of plans) p.steps.forEach((st, i) => steps.push({ where: `${w}.step${i}`, st, plan: p, i }));
  res.backups.forEach((b, i) => b && steps.push({ where: `backups[${i}]`, st: b.step, backup: b }));
  res.risk_modes.forEach(m => m.first_step && steps.push({ where: `risk_modes.${m.mode}.first_step`, st: m.first_step, rm: m }));
  const pbs = [['playbook', res.playbook, res.best], ...res.deck.map((c, j) => [`deck[${j}].playbooks`, c.playbooks ?? [c.playbook], c.plan])];
  for (const [w, list, plan] of pbs) (list ?? []).forEach((pb, i) => {
    if (!pb || !plan) return;
    const st = plan.steps[pb.step_index ?? i];
    const pkg = [['opening', pb.opening?.give], ['walk_away', pb.walk_away?.give], ...(pb.ladder?.ladder ?? []).map((c, k) => [`ladder${k}`, c.give]),
      ...(pb.replies ?? []).flatMap(rw => [['reply.walk_away_give', rw.walk_away_give], ['reply.next_rung_give', rw.next_rung_give]])];
    for (const [k, give] of pkg) if (give) ladders.push({ where: `${w}[${i}].${k}`, give, st });
    for (const rw of pb.replies ?? []) if (rw.next) steps.push({ where: `${w}[${i}].reply.${rw.kind}.next`, st: { team: rw.next.partner, give: rw.next.give, get: rw.next.get } });
  });
  for (const f of res.flip.realised) if (f.legs) flips.push(f);
  return { steps, ladders, flips };
}

const byWhere = bad => Object.entries(bad.reduce((m, b) => {
  const k = String(b.where).replace(/\[\d+\]/g, '[]').replace(/step\d+/, 'stepN');
  m[k] = (m[k] ?? 0) + 1; return m;
}, {})).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} x${n}`).join(', ');
const report = bad => (bad.length ? `${bad.length} violation(s) [${byWhere(bad)}], first: ${JSON.stringify(process.env.INT7_ALL ? bad : bad.slice(0, 4))}` : '');

test('rule 1: 160 / 80 / 277 are never given on any surface', () => {
  const bad = [];
  for (const { seed, mode, res } of runs) {
    const { steps, ladders, flips } = surfaces(res);
    for (const s of steps) if (s.st.give.some(id => PINNED.has(S(id)))) bad.push({ seed, mode, where: s.where, give: s.st.give });
    for (const l of ladders) if (l.give.some(id => PINNED.has(S(id)))) bad.push({ seed, mode, where: l.where, give: l.give });
    for (const f of flips) if ((f.legs.give_a_ids ?? [f.legs.give_a]).some(id => PINNED.has(S(id)))) bad.push({ seed, mode, where: 'flip.leg1', f: f.player });
  }
  assert.deepEqual(bad, [], report(bad));
});

test('rule 2: everything Nick holds at the end of a served plan scores 83+ (deck, best, flip leg 2)', () => {
  const bad = [];
  for (const { seed, mode, L, res } of runs) {
    for (const [w, p] of [['best', res.best], ...res.deck.map((c, j) => [`deck[${j}]`, c.plan])]) {
      if (!p) continue;
      const held = new Set();
      for (const st of p.steps) { for (const id of st.give) held.delete(S(id)); for (const id of st.get) held.add(S(id)); }
      for (const id of held) if (!((L.scores.get(id) ?? 0) >= 83)) bad.push({ seed, mode, where: w, held: id, score: L.scores.get(id), steps: p.steps.map(s => `${s.give}>${s.get}`) });
    }
    for (const f of surfaces(res).flips) for (const id of f.legs.get_b_ids ?? [f.legs.get_b]) if (!((L.scores.get(S(id)) ?? 0) >= 83)) bad.push({ seed, mode, where: 'flip.leg2', id });
  }
  assert.deepEqual(bad, [], report(bad));
});

test('rule 3: no overpay on any served step or ladder package, except a confirmed depth-only 2-for-1 up to +12%', () => {
  const bad = [];
  for (const { seed, mode, L, res } of runs) {
    const { steps, ladders, flips } = surfaces(res);
    const premiumOk = (st, needConfirm) => st.depth_premium && st.give.length === 2 && st.get.length === 1
      && st.give.every(id => (L.scores.get(S(id)) ?? 99) < 83) && sum(L, st.give) <= sum(L, st.get) * 1.12 + 1e-6
      && (!needConfirm || (st.depth_premium.confirmed && st.depth_premium.confirmed.points_delta > 0 && st.depth_premium.confirmed.title_delta > 0));
    const key = st => `${st.team ?? st.partner}|${st.give.map(S).sort()}|${st.get.map(S).sort()}`;
    // Premium steps that passed the fresh-dice re-check on a deck card; any other surface may repeat only these.
    const confirmedPremium = new Set(res.deck.flatMap(c => c.plan.steps.filter(st => premiumOk(st, true)).map(key)));
    for (const s of steps) {
      const st = s.st;
      if (sum(L, st.give) <= sum(L, st.get) + 1e-6) continue;
      if (premiumOk(st, true) || confirmedPremium.has(key(st))) continue;
      bad.push({ seed, mode, where: s.where, give: st.give, get: st.get, pct: +(sum(L, st.give) / sum(L, st.get) - 1).toFixed(3) });
    }
    for (const l of ladders) {
      if (sum(L, l.give) <= sum(L, l.st.get) + 1e-6) continue;
      if (l.st.depth_premium && sameIds(l.give, l.st.give)) continue;
      bad.push({ seed, mode, where: l.where, give: l.give, get: l.st.get });
    }
    for (const f of flips) {
      const gx = f.legs.give_a_ids ?? [f.legs.give_a], gy = f.legs.get_b_ids ?? [f.legs.get_b];
      if (sum(L, gx) > val(L, f.player) + 1e-6) bad.push({ seed, mode, where: 'flip.leg1', gx, p: f.player });
      if (val(L, f.player) > sum(L, gy) + 1e-6) bad.push({ seed, mode, where: 'flip.leg2', gy, p: f.player });
    }
  }
  assert.deepEqual(bad, [], report(bad));
});

/** Gets on every surface: deck/best/backup/first_step/reply steps, flip buys and leg 2. */
const allGets = res => {
  const { steps, flips } = surfaces(res);
  return [...steps.map(s => ({ where: s.where, team: S(s.st.team ?? s.st.partner), give: s.st.give.map(S), get: s.st.get.map(S) })),
    ...flips.flatMap(f => [{ where: 'flip.leg1', team: S(f.a), give: (f.legs.give_a_ids ?? [f.legs.give_a]).map(S), get: [S(f.player)] },
      { where: 'flip.leg2', team: S(f.b), give: [S(f.player)], get: (f.legs.get_b_ids ?? [f.legs.get_b]).map(S) }])];
};
// Nick 9/24 (integration-7): no buy-backs this season, no exceptions (a price fall does not count), from any team.
const soldNoFall = (L, id) => L.trades.find(t => t.moves.some(m => S(m.player) === id && m.from === '1'));

test('rule 4 (last 28 days): no buy-back', () => {
  const bad = [];
  for (const { seed, mode, L, res } of runs) for (const g of allGets(res)) for (const id of g.get) {
    const t = soldNoFall(L, id);
    if (t && NOW - t.at <= 28 * DAY) bad.push({ seed, mode, where: g.where, id, days: Math.round((NOW - t.at) / DAY) });
  }
  assert.deepEqual(bad, [], report(bad));
});

test('rule 4 (the whole season, any team, any price fall): no buy-back', () => {
  const bad = [];
  for (const { seed, mode, L, res } of runs) for (const g of allGets(res)) for (const id of g.get) {
    const t = soldNoFall(L, id);
    if (t) bad.push({ seed, mode, where: g.where, id, days: Math.round((NOW - t.at) / DAY) });
  }
  assert.deepEqual(bad, [], report(bad));
});

test('rule 5: no step reverses a trade with the same counterparty', () => {
  const bad = [];
  for (const { seed, mode, L, res } of runs) for (const g of allGets(res)) {
    for (const t of L.trades) {
      const sent = t.moves.filter(m => m.from === '1' && m.to === g.team).map(m => S(m.player));
      const got = t.moves.filter(m => m.to === '1' && m.from === g.team).map(m => S(m.player));
      if (sent.length && got.length && g.get.some(id => sent.includes(id)) && g.give.some(id => got.includes(id))) bad.push({ seed, mode, where: g.where, g });
    }
  }
  assert.deepEqual(bad, [], report(bad));
});

test('rule 6: every served move beats doing nothing on the confirm dice', () => {
  const bad = [];
  for (const { seed, mode, res } of runs) {
    for (const [j, c] of res.deck.entries()) if (!(c.plan.score > 0) || c.confirm?.verdict === 'failed') bad.push({ seed, mode, where: `deck[${j}]`, score: c.plan.score });
    res.backups.forEach((b, i) => { if (b && !(b.expected > 0)) bad.push({ seed, mode, where: `backups[${i}]`, expected: b.expected }); });
    for (const m of res.risk_modes) if (m.first_step && m.no_trade?.pick === 'no_trade') bad.push({ seed, mode, where: `risk_modes.${m.mode}`, why: 'first_step shown while no_trade is the pick', expected: m.expected });
    for (const c of res.catch_up) if (['swing', 'desperate', 'flip'].includes(c.kind) && c.gain != null && !(c.gain > 0)) bad.push({ seed, mode, where: `catch_up.${c.kind}`, gain: c.gain });
  }
  assert.deepEqual(bad, [], report(bad));
});

test('rule 6: risk_modes first_step is the confirm-dice pick (the mode deck card), not a planning-dice plan', () => {
  const bad = [];
  for (const { seed, mode, res } of runs) {
    const m = res.risk_modes.find(x => x.mode === mode);
    const d = res.deck[0]?.plan.steps[0] ?? null;
    const k = s => (s ? `${s.team}|${s.give.map(S).sort()}|${s.get.map(S).sort()}` : null);
    if (k(m.first_step) !== k(d)) bad.push({ seed, mode, first_step: k(m.first_step), deck0: k(d) });
  }
  assert.deepEqual(bad, [], report(bad));
});

test('the property runs are not vacuous: moves, backups and risk-mode picks are served', () => {
  const deck = runs.reduce((n, r) => n + r.res.deck.length, 0);
  const backups = runs.reduce((n, r) => n + r.res.backups.filter(Boolean).length, 0);
  const picks = runs.reduce((n, r) => n + r.res.risk_modes.filter(m => m.first_step).length, 0);
  console.log(`int7 property: ${runs.length} runs, ${deck} deck cards, ${backups} backups, ${picks} risk-mode picks`);
  assert.ok(deck >= runs.length, `deck cards ${deck}`);
  assert.ok(picks > 0, `risk-mode picks ${picks}`);
});

if (process.env.INT7_DEBUG) test('debug dump', () => {
  const r = runs.find(x => x.seed === Number(process.env.INT7_DEBUG) && x.mode === (process.env.INT7_MODE ?? 'all_in'));
  const k = s => `${s.team ?? s.partner}|${s.give}>${s.get}${s.depth_premium ? ` PREM ${JSON.stringify(s.depth_premium)}` : ''}`;
  console.log('deck', JSON.stringify(r.res.deck.map(c => ({ steps: c.plan.steps.map(k), score: c.plan.score, target: c.plan.target }))));
  console.log('pb', JSON.stringify(r.res.deck.map(c => (c.playbooks ?? [c.playbook]).map(pb => pb.replies.filter(x => x.next).map(x => `${x.kind}:${x.next.partner}|${x.next.give}>${x.next.get}`)))));
  console.log('backups', JSON.stringify(r.res.backups));
  console.log('risk', JSON.stringify(r.res.risk_modes.map(m => ({ mode: m.mode, fs: m.first_step && k(m.first_step), exp: m.expected, nt: m.no_trade.pick }))));
  console.log('catch', JSON.stringify(r.res.catch_up.map(c => [c.kind, c.gain])));
  console.log('tm', JSON.stringify(r.res.trade_memory), JSON.stringify(r.L.trades));
});
