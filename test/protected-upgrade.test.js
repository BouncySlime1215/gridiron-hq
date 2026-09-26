/**
 * PROTECTED-UPGRADE (Nick 2026-09-26, approved hard-rule change): Nico Collins (160) and Chase Brown
 * (80) are no longer untouchable outright. A per-league setting per protected player:
 *   'locked'           never given (the old rule, exactly);
 *   'blue_chips_only'  (the new default) given only for a true tier up: a Blue chip whose score AND
 *                      FantasyCalc value both beat his, in a step at cap 0 that raises playoff odds
 *                      and lineup points, and every such card needs Nick's OK (AJ-PICK's pattern).
 *
 *  1. the setting: fold (defaults, Nick-only, retract), schema (Nick-only, protected ids only), the route;
 *  2. the rule (never-give.js#ruleVerdict), regression fixtures: a sideways trade is refused, a tier up
 *     is allowed (and needs Nick's OK), a tier up that overpays is refused, no rise is refused, Locked
 *     is the old rule, 290 and the floor still hold;
 *  3. the gate (ruleGate): the setting row flips it; outside surfaces never carry a rise;
 *  4. the served plan (gateServedSteps): a step no longer a tier up at today's prices, or Locked since
 *     the plan, withdraws the move;
 *  5. the planner + view + contract: "Uses Nico Collins, Blue chips only" cards, never the next move
 *     until OK'd, plans file valid; no setting -> exactly the old plan;
 *  6. the store: aj.confirm accepts a protected card; the UI: the Settings card and the card label.
 * Made-up ids and values only; no names from a real league.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-protected-upgrade-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_WARROOM_PLANS = path.join(temp, 'plans.json');
delete process.env.GRIDIRON_WARROOM_OBJECTIVES;
delete process.env.GRIDIRON_PROTECTED_UPGRADE;
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { row, rows, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { validateRequest } = await import('../server/services/warroom-actions/schema.js');
const { recordRequest } = await import('../server/services/warroom-actions/store.js');
const PU = await import('../server/services/campaign/protected-upgrade.js');
const NG = await import('../server/services/campaign/never-give.js');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry, plansFile, moveId } = await import('../server/services/campaign/view.js');
const { validatePlans } = await import('../server/services/campaign/plans-schema.js');
const { makeFuzzLeague } = await import('./fixtures/rule-fuzz-league.mjs');
const { ruleViolations, pathKey } = await import('./fixtures/nick-rules.mjs');
const { scoreForRules } = await import('./fixtures/rule-gate.mjs');
const { loadWarRoom, textOf } = await import('./helpers/warroom-tsx.mjs');
const wr = await loadWarRoom();
const { AjOkBanner } = await wr.mod('AjPick');
const { protectMode } = await wr.mod('requests');
test.after(() => wr.cleanup());

const L = 4;
const ME = '1';
run(`INSERT OR IGNORE INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at, current_week)
     VALUES (?, 'espn', 'fx-pu', 2026, 'Fixture', ?, 4, 1, '{}', '2026-09-26 01:00:00', 3)`, L, ME);
// 160: score 88, value 6000. 501: a true tier up (92, 7000). 502: sideways (95 but value 5500).
// 503: higher value but lower score (86, 8000). 504: a sub-83 filler (70, 500).
const FC = { 160: 6000, 80: 5000, 501: 7000, 502: 5500, 503: 8000, 504: 500, 505: 900, 290: 9000 };
for (const [id, v] of Object.entries(FC)) {
  run('INSERT OR IGNORE INTO players (id, name, position) VALUES (?, ?, ?)', Number(id), `Player ${id}`, 'WR');
  run(`INSERT INTO player_metrics (player_id, source, value) VALUES (?, 'fc_value', ?)`, Number(id), v);
}
run(`UPDATE players SET name = 'Nico Collins' WHERE id = 160`);
scoreForRules(L, new Map([['160', 88], ['80', 85], ['501', 92], ['502', 95], ['503', 86], ['504', 70], ['505', 90], ['290', 96]]));

const rulesBase = () => ({
  neverGive: new Set(NG.PINNED_NEVER_GIVE), neverGet: new Set(NG.PINNED_NEVER_GET), sold: new Set(), closed: null,
  fc: new Map(Object.entries(FC).map(([k, v]) => [k, v])),
  scoreOf: id => ({ 160: 88, 80: 85, 501: 92, 502: 95, 503: 86, 504: 70, 505: 90, 290: 96 })[id] ?? null,
  protectUpgrade: new Set(['160', '80']),
});
const RISE = { points_delta: 2.5, playoff_delta: 0.03 };

/* ---------------------------------------------------------------- 1. the setting */

test('setting: 160 and 80 default to Blue chips only; A.J. is not settable; Nick\'s latest row wins; Coach and retracted rows never count', () => {
  assert.deepEqual({ ...PU.PROTECTED_DEFAULTS }, { 160: 'blue_chips_only', 80: 'blue_chips_only' });
  assert.ok(!PU.PROTECTED_IDS.includes('277'));
  const f0 = PU.foldProtect([]);
  assert.deepEqual([...f0.modes], [['80', 'blue_chips_only'], ['160', 'blue_chips_only']]);
  const r = (id, kind, payload, source = 'nick') => ({ id, kind, payload: JSON.stringify(payload), source });
  const f = PU.foldProtect([
    r(1, 'protect.mode', { player_id: '160', mode: 'locked' }),
    r(2, 'protect.mode', { player_id: '80', mode: 'locked' }, 'coach'),
    r(3, 'protect.mode', { player_id: '160', mode: 'blue_chips_only' }),
    r(4, 'retract', { request_id: 3 }),
    r(5, 'protect.mode', { player_id: '277', mode: 'blue_chips_only' }),
  ]);
  assert.equal(f.modes.get('160'), 'locked', 'the retracted row does not count; the earlier one stands');
  assert.equal(f.modes.get('80'), 'blue_chips_only', 'a Coach row never counts');
  assert.ok(!f.modes.has('277'));
  assert.equal(PU.protectState({ rows: () => [] }, L, { env: { GRIDIRON_PROTECTED_UPGRADE: '0' } }).upgrade.size, 0, 'kill switch: all locked');
});

test('schema: protect.mode is Nick\'s alone and names a protected player and a mode', () => {
  assert.deepEqual(validateRequest('protect.mode', { player_id: '160', mode: 'locked' }), { ok: true, kind: 'protect.mode', payload: { player_id: '160', mode: 'locked' } });
  assert.equal(validateRequest('protect.mode', { player_id: '160', mode: 'locked' }, { source: 'coach', confirmed: true }).ok, false);
  assert.equal(validateRequest('protect.mode', { player_id: '277', mode: 'blue_chips_only' }).ok, false);
  assert.equal(validateRequest('protect.mode', { player_id: '999', mode: 'locked' }).ok, false);
  assert.equal(validateRequest('protect.mode', { player_id: '80', mode: 'sometimes' }).ok, false);
  assert.deepEqual(protectMode('80', 'locked'), { kind: 'protect.mode', payload: { player_id: '80', mode: 'locked' } });
});

/* ---------------------------------------------------------------- 2. the rule: regression fixtures */

test('rule: a sideways trade is refused (a Blue chip that out-scores him but is worth less, or worth more but scores lower)', () => {
  const R = rulesBase();
  for (const get of [['502'], ['503']]) {
    const v = NG.ruleVerdict(R, { give: ['160'], get, rises: RISE });
    assert.equal(v.ok, false, `160 for ${get}`);
    assert.ok(v.reasons.includes('never_give'), JSON.stringify(v));
    assert.deepEqual(v.protected, { 160: 'protected_not_tier_up' });
  }
});

test('rule: a tier up is allowed, and needs Nick\'s OK', () => {
  const v = NG.ruleVerdict(rulesBase(), { give: ['160'], get: ['501'], rises: RISE });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.requires_nick_confirm, true);
});

test('rule: a tier up that overpays is refused (cap 0; a protected star is never depth, so no +12%)', () => {
  // 160 + 505 (6900) for 501 (7000) is fine; 160 + 80 (11000) for 501 (7000) overpays.
  assert.equal(NG.ruleVerdict(rulesBase(), { give: ['160', '505'], get: ['501'], rises: RISE }).ok, true);
  const v = NG.ruleVerdict(rulesBase(), { give: ['160', '80'], get: ['501'], rises: RISE,
    premium: { points_delta: 5, title_delta: 0.05 } });
  assert.equal(v.ok, false);
  assert.ok(v.reasons.includes('overpay'), JSON.stringify(v));
  // A two-for-one of 160 + a depth piece a few % over 0 is still refused: 160 is not depth.
  const R = { ...rulesBase(), fc: new Map([...rulesBase().fc, ['501', 6400]]) };
  const w = NG.ruleVerdict(R, { give: ['160', '505'], get: ['501'], rises: RISE, premium: { points_delta: 5, title_delta: 0.05 } });
  assert.ok(w.reasons.includes('overpay'), 'the depth-only 2-for-1 exception never applies to a protected player');
});

test('rule: no rise in playoff odds AND lineup points, no move; Locked is the old rule; 290 and the floor still hold', () => {
  const R = rulesBase();
  for (const rises of [null, { points_delta: 2, playoff_delta: 0 }, { points_delta: -1, playoff_delta: 0.02 }]) {
    const v = NG.ruleVerdict(R, { give: ['160'], get: ['501'], rises });
    assert.equal(v.ok, false);
    assert.deepEqual(v.protected, { 160: 'protected_no_rise' });
  }
  const locked = NG.ruleVerdict({ ...R, protectUpgrade: new Set(['80']) }, { give: ['160'], get: ['501'], rises: RISE });
  assert.deepEqual([locked.ok, locked.reasons, locked.protected], [false, ['never_give'], { 160: 'never_give' }]);
  assert.ok(NG.ruleVerdict(R, { give: ['160'], get: ['501', '504'], rises: RISE }).reasons.includes('below_blue_chip'));
  assert.ok(NG.ruleVerdict(R, { give: ['160'], get: ['290'], rises: RISE }).reasons.includes('never_get'));
  const sold = NG.ruleVerdict({ ...R, sold: new Set(['501']) }, { give: ['160'], get: ['501'], rises: RISE });
  assert.ok(sold.reasons.includes('sold_this_season'), 'no buy-backs');
  // Unread numbers fail closed.
  assert.equal(NG.ruleVerdict({ ...R, scoreOf: id => (id === '160' ? null : R.scoreOf(id)) }, { give: ['160'], get: ['501'], rises: RISE }).ok, false);
});

/* ---------------------------------------------------------------- 3. the gate + the store */

test('gate: the default is Blue chips only; Nick\'s Locked row locks it; a surface without a rise never serves 160', () => {
  let g = NG.ruleGate({ row, rows }, { leagueId: L });
  assert.deepEqual([...g.rules.protectUpgrade].sort(), ['160', '80']);
  assert.equal(g.rules.sources.protected_upgrade, 'ok');
  assert.equal(g.check({ give: ['160'], get: ['501'], rises: RISE }).requires_nick_confirm, true);
  assert.equal(g.ok(['160'], ['501']), false, 'no rise: dropped');
  // Kept through the filter only when Nick OK'd that exact card.
  assert.equal(g.filter([0], () => ({ give: ['160'], get: ['501'], rises: RISE, move_id: 'L4-x' })).needs_nick_ok, 1);
  recordRequest({ userId: 1, leagueId: L, kind: 'protect.mode', payload: { player_id: '160', mode: 'locked' } });
  g = NG.ruleGate({ row, rows }, { leagueId: L });
  assert.deepEqual([...g.rules.protectUpgrade], ['80']);
  assert.equal(g.check({ give: ['160'], get: ['501'], rises: RISE }).ok, false);
  recordRequest({ userId: 1, leagueId: L, kind: 'protect.mode', payload: { player_id: '160', mode: 'blue_chips_only' } });
  assert.throws(() => recordRequest({ userId: 1, leagueId: L, kind: 'protect.mode', payload: { player_id: '160', mode: 'locked' }, source: 'coach', confirmed: true }), /only Nick/i);
});

test('store: aj.confirm accepts a card that uses a protected player', () => {
  const card = { move_id: 'L4-prot', steps: [{ partner: '2', give: ['160'], get: ['501'] }] };
  const plans = { status: 'ok', entries: [{ league: L, next_move: { status: 'unknown' }, alternatives: { status: 'ok', value: [card] } }] };
  const r = recordRequest({ userId: 1, leagueId: L, kind: 'aj.confirm', payload: { move_id: 'L4-prot' }, plans });
  assert.ok(r.id > 0);
});

/* ---------------------------------------------------------------- 4. the served plan at today's prices */

test('served plan: a step that is no longer a tier up at today\'s prices, or Locked since, withdraws the move', () => {
  const pu = { status: 'ok', value: { players: ['160'], for: ['501'], lineup_points_delta: 2, playoff_odds_delta: 0.02,
    confirmed_lineup_points_delta: 2, confirmed_playoff_odds_delta: 0.02, text: 't' }, source: 'plan.path' };
  const mv = (id, get) => ({ move_id: id, rank: 1, requires_nick_confirm: true, nick_confirmed: true, protected_uses: ['160'],
    steps: [{ partner: '2', give: ['160'], get, protected_upgrade: pu }] });
  const entry = { league: L, next_move: { status: 'ok', value: mv('a', ['501']) }, alternatives: { status: 'ok', value: [mv('a', ['501']), mv('b', ['502'])] } };
  const kept = NG.gateServedSteps(rulesBase(), entry);
  assert.equal(kept.entry.next_move.status, 'ok');
  assert.deepEqual(kept.entry.alternatives.value.map(m => m.move_id), ['a'], 'the sideways card goes');
  assert.ok(kept.drops.some(d => d.rule === 'protected_not_tier_up' && d.get[0] === '502'));
  // 501 is no longer above 160 on today's board (score 87 < 88; still no overpay at 7000 for 6000).
  const cheaper = { ...rulesBase(), scoreOf: id => (String(id) === '501' ? 87 : rulesBase().scoreOf(id)) };
  const gone = NG.gateServedSteps(cheaper, entry);
  assert.equal(gone.entry.next_move.status, 'unknown');
  assert.equal(gone.entry.next_move.reason, NG.PROTECTED_STEP_REASON);
  // Nick switched 160 to Locked after the plan was made.
  assert.equal(NG.gateServedSteps({ ...rulesBase(), protectUpgrade: new Set() }, entry).entry.next_move.status, 'unknown');
  // The tier up is a stepping stone traded on in a later step: withdrawn (the upgrade must be what Nick keeps).
  const flip = { ...entry, next_move: { status: 'ok', value: { ...mv('a', ['501']), steps: [mv('a', ['501']).steps[0], { partner: '3', give: ['501'], get: ['505'] }] } } };
  const flipped = NG.gateServedSteps(rulesBase(), flip);
  assert.equal(flipped.entry.next_move.status, 'unknown');
  assert.ok(flipped.drops.some(d => d.rule === 'protected_upgrade_not_kept'));
  // No confirmed rise on the served step: withdrawn.
  const noRise = { ...entry, next_move: { status: 'ok', value: { ...mv('a', ['501']), steps: [{ partner: '2', give: ['160'], get: ['501'] }] } } };
  assert.equal(NG.gateServedSteps(rulesBase(), noRise).entry.next_move.status, 'unknown');
});

/* ---------------------------------------------------------------- 5. the planner, the view, the contract */

test('planner: no setting is exactly the old plan; Blue chips only builds labelled Needs-your-OK cards; OK\'d, one may be served', () => {
  let built = 0, served = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const a = makeFuzzLeague(seed);
    const objective = normaliseObjective({ risk_mode: 'all_in' });
    const off = planLeague(a, { objective, env: {} });
    const locked = planLeague(makeFuzzLeague(seed), { objective, env: {}, protect: { upgrade: new Set() } });
    const key = r => JSON.stringify([r.best?.steps.map(s => [s.team, s.give, s.get]), r.deck.map(c => c.plan.steps.map(s => [s.team, s.give, s.get]))]);
    assert.equal(key(locked), key(off), `seed ${seed}: Locked plans exactly as before`);
    const upgrade = new Set(['160', '80']);
    const res = planLeague(makeFuzzLeague(seed), { objective, env: {}, protect: { upgrade } });
    assert.deepEqual(ruleViolations(a, res, { protectUpgrade: upgrade }), []);
    const cards = res.deck.filter(c => c.aj?.uses);
    if (!cards.length) continue;
    built++;
    for (const c of cards) {
      assert.equal(c.aj.nick_confirmed, false);
      assert.match(c.aj.label, /^Uses (Nico Collins|Chase Brown)( and (Nico Collins|Chase Brown))?, Blue chips only$/);
    }
    const entry = toEntry(res, { names: a.names(), as_of: '2026-09-26T00:00:00Z' });
    const doc = plansFile([entry], { generated_at: '2026-09-26T00:00:00Z' });
    assert.equal(validatePlans(doc).ok, true, JSON.stringify(validatePlans(doc).errors.slice(0, 3)));
    const m = entry.alternatives.value.find(x => x.protected_uses);
    assert.equal(m.requires_nick_confirm, true);
    assert.equal(m.nick_confirmed, false);
    assert.match(m.protected_label, /Blue chips only$/);
    const st = m.steps.find(s => s.give.some(id => id === '160' || id === '80'));
    assert.equal(st.requires_nick_confirm, true);
    assert.equal(st.protected_upgrade.status, 'ok');
    assert.ok(st.protected_upgrade.value.confirmed_lineup_points_delta > 0 && st.protected_upgrade.value.confirmed_playoff_odds_delta > 0);
    if (entry.next_move.status === 'ok') assert.ok(!entry.next_move.value.protected_uses || entry.next_move.value.nick_confirmed);
    const okd = planLeague(makeFuzzLeague(seed), { objective, env: {}, protect: { upgrade },
      aj: { allow: new Set(), confirmed: new Set([moveId(a.league.id, cards[0].plan)]) } });
    assert.deepEqual(ruleViolations(a, okd, { protectUpgrade: upgrade, ajConfirmedPaths: new Set([pathKey(cards[0].plan.steps)]) }), []);
    if (okd.deck.some(c => c.aj?.uses && c.aj.nick_confirmed)) served++;
  }
  assert.ok(built > 0 && served > 0, `non-vacuous: ${built} leagues built a card, ${served} served one once OK'd`);
});

/* ---------------------------------------------------------------- 6. the UI */

test('UI: the card banner says "Needs your OK: Uses …, Blue chips only"; Settings has a Trade rules card with both modes', () => {
  const move = { move_id: 'm', requires_nick_confirm: true, nick_confirmed: false, protected_uses: ['160'], protected_label: 'Uses Nico Collins, Blue chips only' };
  const html = renderToStaticMarkup(React.createElement(AjOkBanner, { move, leagueId: L, forText: 'Player 501', post: async () => ({}) }));
  assert.match(textOf(html), /Needs your OK: Uses Nico Collins, Blue chips only, for Player 501/);
  const aj = renderToStaticMarkup(React.createElement(AjOkBanner, { move: { ...move, protected_label: undefined }, leagueId: L, forText: 'X', post: async () => ({}) }));
  assert.match(textOf(aj), /Needs your OK: gives A\.J\. Brown for X/, 'the A.J. card is unchanged');
  const src = f => fs.readFileSync(new URL(`../client/src/${f}`, import.meta.url), 'utf8');
  assert.match(src('pages/Settings.tsx'), /\{ id: 'trades', label: 'Trade rules' \}/);
  const card = src('components/settings/ProtectedPlayers.tsx');
  assert.match(card, /protectMode\(player, mode\)/);
  assert.doesNotMatch(card, /bg-(blue|gray|slate)-\d/, 'design-system tokens only');
  assert.match(src('components/warroom/HeroCard.tsx'), /data-testid="protected-label"/);
});
