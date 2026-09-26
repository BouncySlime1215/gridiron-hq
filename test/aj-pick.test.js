/**
 * AJ-PICK (Nick 2026-09-25): A.J. Brown (277) may be traded only for a player Nick picks himself
 * (aj.allow), who is a Blue chip (83+) when the card is served, and every such card is a
 * "Needs your OK" card: never the next move until Nick taps OK on that exact card (aj.confirm).
 *
 *  1. requests: aj.allow / aj.revoke / aj.confirm are Nick's alone (Coach refused, even "confirmed");
 *  2. the fold: latest allow / revoke wins, retracted and Coach rows never count;
 *  3. never-give.js: ajMayMove / ruleVerdict / ruleGate (the rule, the OK gate, the other rules intact);
 *  4. the planner + view: no picks -> no 277 anywhere; picks -> flagged cards after the deck, never the
 *     hero; an OK'd card may be served; the plans file validates; the kill switch;
 *  5. the store: aj.confirm names a current card that gives 277;
 *  6. the UI: the banner + OK button on the deck card, the Go get toggle, the context-bar chip.
 * Made-up ids and values only; no names from a real league.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-aj-pick-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_WARROOM_PLANS = path.join(temp, 'plans.json');
delete process.env.GRIDIRON_WARROOM_OBJECTIVES;
delete process.env.GRIDIRON_AJ_PICK;
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { rows, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { validateRequest, NICK_ONLY_REQUESTS } = await import('../server/services/warroom-actions/schema.js');
const { recordRequest } = await import('../server/services/warroom-actions/store.js');
const { foldAj, ajState, AJ_CARDS_MAX } = await import('../server/services/campaign/aj-pick.js');
const NG = await import('../server/services/campaign/never-give.js');
const { planLeague, DECK_SIZE } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry, plansFile, moveId } = await import('../server/services/campaign/view.js');
const { validatePlans, MAX_ALTERNATIVES } = await import('../server/services/campaign/plans-schema.js');
const { makeFuzzLeague, AJ_BROWN, OLAVE_ID } = await import('./fixtures/rule-fuzz-league.mjs');
const { ruleViolations, countByRule, pathKey } = await import('./fixtures/nick-rules.mjs');
const { scoreForRules } = await import('./fixtures/rule-gate.mjs');

const AJ = '277';

// The UI harness and every module load BEFORE any test is registered: node:test starts running
// registered tests during a top-level await, and a root after() hook (the harness cleanup) could
// delete the compiled dir while a later import is still pending (CI, #487).
const { loadWarRoom, textOf } = await import('./helpers/warroom-tsx.mjs');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const producer = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'warroom-contract', 'ui-contract-plans.json'), 'utf8'));
const { buildWarRoomView } = await import('../server/services/war-room-view.js');
const wr = await loadWarRoom();
const { default: NextMoveDeck } = await wr.mod('NextMoveDeck');
const { AjAllowToggle, AjAllowedChip } = await wr.mod('AjPick');
const { default: ScreenGoGet } = await wr.mod('ScreenGoGet');
const { ajConfirm, postWarRoomRequest } = await wr.mod('requests');
test.after(() => wr.cleanup());

/* ------------------------------------------------------------ 1. requests */

test('requests: aj.allow / aj.revoke / aj.confirm are Nick\'s alone', () => {
  assert.deepEqual([...NICK_ONLY_REQUESTS], ['aj.allow', 'aj.revoke', 'aj.confirm']);
  assert.deepEqual(validateRequest('aj.allow', { player_id: '101' }), { ok: true, kind: 'aj.allow', payload: { player_id: '101' } });
  assert.equal(validateRequest('aj.revoke', { player_id: 101 }).ok, true);
  assert.equal(validateRequest('aj.confirm', { move_id: 'L4-abc' }).ok, true);
  for (const kind of NICK_ONLY_REQUESTS) {
    const payload = kind === 'aj.confirm' ? { move_id: 'L4-abc' } : { player_id: '101' };
    assert.equal(validateRequest(kind, payload, { source: 'coach' }).ok, false, `${kind} from Coach`);
    assert.equal(validateRequest(kind, payload, { source: 'coach', confirmed: true }).ok, false, `${kind} from Coach, even "confirmed"`);
  }
  assert.match(validateRequest('aj.allow', { player_id: AJ }).error, /A\.J\. Brown himself/);
  assert.equal(validateRequest('aj.allow', {}).ok, false, 'a player is required');
  assert.equal(validateRequest('aj.confirm', {}).ok, false, 'a move id is required');
});

/* ------------------------------------------------------------ 2. the fold */

test('fold: the latest allow / revoke wins; retracted and Coach rows never count', () => {
  const r = (id, kind, payload, source = 'nick') => ({ id, kind, payload: JSON.stringify(payload), source, confirmed: 0 });
  const f = foldAj([
    r(1, 'aj.allow', { player_id: '101' }), r(2, 'aj.allow', { player_id: '102' }), r(3, 'aj.revoke', { player_id: '101' }),
    r(4, 'aj.allow', { player_id: '103' }), r(5, 'retract', { request_id: 4 }),
    r(6, 'aj.allow', { player_id: '104' }, 'coach'), r(7, 'aj.confirm', { move_id: 'M1' }), r(8, 'aj.confirm', { move_id: 'M2' }, 'coach'),
    { id: 9, kind: 'aj.allow', payload: '{not json', source: 'nick' },
  ]);
  assert.deepEqual([...f.allow], ['102']);
  assert.deepEqual([...f.confirmed], ['M1']);
  assert.deepEqual(f.ignored.map(x => x.id).sort((a, b) => a - b), [4, 6, 8, 9]);
  assert.equal(foldAj([]).allow.size, 0);
});

/* ------------------------------------------------------------ 3. never-give.js */

const rules = (scores, allow = []) => ({
  neverGive: new Set(NG.PINNED_NEVER_GIVE), neverGet: new Set(NG.PINNED_NEVER_GET), sold: new Set(),
  fc: new Map([[AJ, 3000], ['160', 5000], ['101', 4000], ['102', 3200], ['103', 2000], ['104', 1000]]),
  scoreOf: id => scores[String(id)] ?? null, closed: null, ajAllow: new Set(allow),
});
const SC = { 101: 90, 102: 80, 103: 88, 104: 95 };

test('ajMayMove: only for a pick on the list who is 83+ now', () => {
  const R = rules(SC, ['101', '102']);
  assert.equal(NG.ajMayMove(['101'], R), true);
  assert.equal(NG.ajMayMove(['102'], R), false, 'a pick under 83');
  assert.equal(NG.ajMayMove(['103'], R), false, 'an 83+ player Nick did not pick');
  assert.equal(NG.ajMayMove(['101'], rules(SC)), false, 'no list: fail closed');
  assert.equal(NG.ajMayMove(['101'], { scoreOf: () => null, ajAllow: new Set(['101']) }), false, 'unscored: fail closed');
});

test('ruleVerdict: 277 passes only for an 83+ pick, needs Nick\'s OK, and every other rule still applies', () => {
  const R = rules(SC, ['101', '102', '104']);
  assert.deepEqual(NG.ruleVerdict(R, { give: [AJ], get: ['101'] }), { ok: true, reasons: [], overpay: -0.25, requires_nick_confirm: true });
  assert.deepEqual(NG.ruleVerdict(R, { give: [AJ], get: ['102'] }).reasons, ['never_give', 'below_blue_chip']);
  assert.deepEqual(NG.ruleVerdict(rules(SC), { give: [AJ], get: ['101'] }).reasons, ['never_give'], 'no picks: 277 stays pinned');
  // The overpay cap (FantasyCalc) still binds: 3000 out for 1000 in.
  assert.deepEqual(NG.ruleVerdict(R, { give: [AJ], get: ['104'] }).reasons, ['overpay']);
  // 160 stays never-give even alongside an allowed 277 step.
  assert.deepEqual(NG.ruleVerdict(R, { give: [AJ, '160'], get: ['101'] }).reasons, ['never_give', 'overpay']);
  // A step without 277 never needs Nick's OK.
  assert.equal(NG.ruleVerdict(R, { give: ['103'], get: ['101'] }).requires_nick_confirm, false);
});

/* DB fixture: league 4, Nick's team 5; FantasyCalc values and a served board. */
const L = 4;
for (const [id, pos] of [[80, 'RB'], [160, 'WR'], [277, 'WR'], [290, 'WR'], [101, 'WR'], [102, 'RB'], [103, 'WR']]) {
  run('INSERT INTO players (id, name, position, espn_id) VALUES (?, ?, ?, ?)', id, `P${id}`, pos, 9000 + id);
}
for (const [id, v] of Object.entries({ 80: 5000, 160: 5000, 277: 3000, 290: 5000, 101: 4000, 102: 3200, 103: 3500 })) {
  run(`INSERT INTO player_metrics (player_id, source, value) VALUES (?, 'fc_value', ?)`, Number(id), v);
}
run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id, espn_s2, swid, connection_status)
     VALUES (?, 'espn', 'aj-4', 2026, 'AJ League', '{"teams":[]}', 10, '5', 'x', 'y', 'connected')`, L);
scoreForRules(L, new Map([['101', 90], ['102', 80], ['103', 88], ['277', 86]]));
const DB = { row: (sql, ...p) => rows(sql, ...p)[0], rows };

test('store + gate: Nick\'s pick opens 277 for him only; the card is kept only once Nick OK\'d it', () => {
  const gate0 = NG.ruleGate(DB, { leagueId: L });
  assert.deepEqual(gate0.check({ give: [AJ], get: ['101'] }).reasons, ['never_give'], 'no picks yet');
  assert.throws(() => recordRequest({ userId: 1, leagueId: L, kind: 'aj.allow', payload: { player_id: '101' }, source: 'coach', confirmed: true }),
    /only Nick/);
  recordRequest({ userId: 1, leagueId: L, kind: 'aj.allow', payload: { player_id: '101' } });
  recordRequest({ userId: 1, leagueId: L, kind: 'aj.allow', payload: { player_id: '102' } });
  assert.deepEqual([...ajState(DB, L).allow].sort(), ['101', '102']);
  assert.equal(ajState(DB, 9).allow.size, 0, 'per league');

  const gate = NG.ruleGate(DB, { leagueId: L });
  assert.equal(gate.rules.sources.aj_pick, 'ok');
  const v = gate.check({ give: [AJ], get: ['101'] });
  assert.equal(v.ok, true);
  assert.equal(v.requires_nick_confirm, true);
  assert.deepEqual(gate.check({ give: [AJ], get: ['102'] }).reasons, ['never_give', 'below_blue_chip'], 'the 80 pick is not a Blue chip');
  assert.deepEqual(gate.check({ give: [AJ], get: ['103'] }).reasons, ['never_give'], '83+ but not picked');
  // Every surface but the War Room deck drops it until Nick OKs that exact card.
  const list = [{ give: [AJ], get: ['101'], move_id: 'L4-card' }, { give: ['103'], get: ['101'] }];
  const f = gate.filter(list, x => x);
  assert.equal(f.kept.length, 1);
  assert.equal(f.needs_nick_ok, 1);
  assert.equal(f.dropped_by_rule, 1);
  assert.equal(gate.ok([AJ], ['101'], null, null, { moveId: 'L4-card' }), false);

  // aj.confirm names a current card that gives 277, or nothing is recorded.
  const plans = { entries: [{ league: L, alternatives: { status: 'ok', value: [
    { move_id: 'L4-card', steps: [{ partner: '3', give: [AJ], get: ['101'] }] },
    { move_id: 'L4-other', steps: [{ partner: '3', give: ['103'], get: ['101'] }] }] } }] };
  assert.throws(() => recordRequest({ userId: 1, leagueId: L, kind: 'aj.confirm', payload: { move_id: 'L4-gone' }, plans }), /nothing to OK/);
  assert.throws(() => recordRequest({ userId: 1, leagueId: L, kind: 'aj.confirm', payload: { move_id: 'L4-other' }, plans }), /nothing to OK/);
  assert.throws(() => recordRequest({ userId: 1, leagueId: L, kind: 'aj.confirm', payload: { move_id: 'L4-card' }, source: 'coach', confirmed: true, plans }), /only Nick/);
  recordRequest({ userId: 1, leagueId: L, kind: 'aj.confirm', payload: { move_id: 'L4-card' }, plans });
  const gate2 = NG.ruleGate(DB, { leagueId: L });
  assert.equal(gate2.ok([AJ], ['101'], null, null, { moveId: 'L4-card' }), true, 'the OK\'d card');
  assert.equal(gate2.ok([AJ], ['101'], null, null, { moveId: 'L4-else' }), false, 'only that exact card');

  // Revoke closes it again, OK or not.
  recordRequest({ userId: 1, leagueId: L, kind: 'aj.revoke', payload: { player_id: '101' } });
  assert.deepEqual(NG.ruleGate(DB, { leagueId: L }).check({ give: [AJ], get: ['101'] }).reasons, ['never_give']);
  // The kill switch: GRIDIRON_AJ_PICK=0 reads no picks.
  recordRequest({ userId: 1, leagueId: L, kind: 'aj.allow', payload: { player_id: '101' } });
  assert.deepEqual(NG.ruleGate(DB, { leagueId: L, env: { GRIDIRON_AJ_PICK: '0' } }).check({ give: [AJ], get: ['101'] }).reasons, ['never_give']);
});

/* ------------------------------------------------------------ 4. the planner + view */

/** An 83+ player on another roster near A.J.'s value (the test's pick; the planner does not choose it). */
function pickFor(a) {
  const me = a.league.me;
  const blues = [...a.rosters].filter(([t]) => t !== me).flatMap(([, ids]) => ids)
    .filter(id => id !== OLAVE_ID && a.scoreOf(id)?.score >= 83).sort((x, y) => a.players.get(y).value - a.players.get(x).value);
  return blues.find(id => Math.abs(a.players.get(id).value - a.players.get(AJ_BROWN).value) < 1500) ?? blues[0];
}
const plan = (a, aj, mode = 'all_in', env = {}) => planLeague(a, { objective: normaliseObjective({ risk_mode: mode }), env, ...(aj ? { aj } : {}) });
const givesAj = st => st.give.map(String).includes(AJ);
const SEEDS = [7, 11, 14];

test('planner: with no picks, 277 appears nowhere (same as before AJ-PICK)', () => {
  for (const seed of SEEDS) {
    const a = makeFuzzLeague(seed);
    const res = plan(a, null);
    assert.equal(res.aj_pick.status, 'no_picks');
    assert.ok(!res.deck.some(c => c.plan.steps.some(givesAj) || c.aj), `seed ${seed}`);
    assert.deepEqual(countByRule(ruleViolations(a, res)), countByRule([]), `seed ${seed}`);
  }
});

test('planner: a pick yields "Needs your OK" cards after the deck, never the next move, rules intact', () => {
  let cards = 0;
  for (const seed of SEEDS) {
    const a = makeFuzzLeague(seed);
    const pick = String(pickFor(a));
    const res = plan(a, { allow: new Set([pick]), confirmed: new Set() });
    assert.equal(res.aj_pick.status, 'on');
    assert.deepEqual(res.aj_pick.picks, [pick]);
    const waiting = res.deck.filter(c => c.aj);
    cards += waiting.length;
    assert.ok(waiting.length <= AJ_CARDS_MAX);
    assert.ok(res.deck.length <= MAX_ALTERNATIVES && res.deck.length <= DECK_SIZE);
    for (const c of waiting) {
      assert.equal(c.aj.requires_nick_confirm, true);
      assert.equal(c.aj.nick_confirmed, false);
      assert.deepEqual(c.aj.for, [pick]);
      for (const st of c.plan.steps.filter(givesAj)) assert.ok(st.get.map(String).includes(pick), 'every 277 step gets the pick');
    }
    // Waiting cards sit after every served card; the hero never gives 277.
    const firstWaiting = res.deck.findIndex(c => c.aj);
    if (firstWaiting >= 0) assert.ok(res.deck.slice(firstWaiting).every(c => c.aj));
    assert.ok(!(res.best?.steps ?? []).some(givesAj), `seed ${seed}: the hero gives 277 without an OK`);
    assert.ok(!(res.backups ?? []).some(b => b?.step && givesAj(b.step)));
    const v = countByRule(ruleViolations(a, res, { ajAllow: new Set([pick]) }));
    assert.deepEqual(v, countByRule([]), `seed ${seed}: ${JSON.stringify(v)}`);

    // The served file: the cards validate, carry the flag on the card and its 277 steps, and are never next_move.
    const entry = toEntry(res, { names: a.names(), as_of: '2026-09-25T00:00:00Z' });
    const doc = plansFile([entry], { generated_at: '2026-09-25T00:00:00Z' });
    assert.equal(validatePlans(doc).ok, true, JSON.stringify(validatePlans(doc).errors.slice(0, 3)));
    const moves = entry.alternatives.value;
    for (const m of moves.filter(x => x.requires_nick_confirm)) {
      assert.equal(m.nick_confirmed, false);
      assert.deepEqual(m.aj_for, [pick]);
      for (const st of m.steps) assert.equal(!!st.requires_nick_confirm, st.give.includes(AJ));
    }
    if (entry.next_move.status === 'ok') assert.ok(!entry.next_move.value.requires_nick_confirm);
    assert.deepEqual(entry._run.inputs.aj_pick.picks, [pick]);
  }
  assert.ok(cards > 0, 'at least one seed builds an A.J. card (non-vacuous)');
});

test('planner: an OK\'d card joins the deck as served (nick_confirmed); only that exact card', () => {
  let served = 0;
  for (const seed of SEEDS) {
    const a = makeFuzzLeague(seed);
    const pick = String(pickFor(a));
    const first = plan(a, { allow: new Set([pick]), confirmed: new Set() });
    const card = first.deck.find(c => c.aj);
    if (!card) continue;
    const id = moveId(a.league.id, card.plan);
    const res = plan(makeFuzzLeague(seed), { allow: new Set([pick]), confirmed: new Set([id]) });
    const okd = res.deck.find(c => moveId(a.league.id, c.plan) === id);
    if (okd) { served++; assert.equal(okd.aj.nick_confirmed, true); }
    for (const c of res.deck.filter(x => x.aj && moveId(a.league.id, x.plan) !== id)) assert.equal(c.aj.nick_confirmed, false);
    const v = countByRule(ruleViolations(a, res, { ajAllow: new Set([pick]), ajConfirmedPaths: new Set([pathKey(card.plan.steps)]) }));
    assert.deepEqual(v, countByRule([]), `seed ${seed}: ${JSON.stringify(v)}`);
    const entry = toEntry(res, { names: a.names(), as_of: '2026-09-25T00:00:00Z' });
    assert.equal(validatePlans(plansFile([entry], { generated_at: '2026-09-25T00:00:00Z' })).ok, true);
  }
  assert.ok(served > 0, 'an OK\'d card is served at least once (non-vacuous)');
});

test('planner: a sub-83 pick, the kill switch, or 277 in the objective\'s untouchables build nothing', () => {
  const a = makeFuzzLeague(11);
  const me = a.league.me;
  const low = [...a.rosters].filter(([t]) => t !== me).flatMap(([, ids]) => ids).find(id => id !== OLAVE_ID && a.scoreOf(id)?.score < 83);
  const r1 = plan(a, { allow: new Set([String(low)]), confirmed: new Set() });
  assert.equal(r1.aj_pick.picks.length, 0);
  assert.equal(r1.aj_pick.refused[0].why, 'below_floor');
  assert.ok(!r1.deck.some(c => c.aj));
  const pick = String(pickFor(a));
  const r2 = plan(makeFuzzLeague(11), { allow: new Set([pick]), confirmed: new Set() }, 'all_in', { GRIDIRON_AJ_PICK: '0' });
  assert.equal(r2.aj_pick.status, 'off');
  assert.ok(!r2.deck.some(c => c.aj));
  const r3 = planLeague(makeFuzzLeague(11), { objective: normaliseObjective({ risk_mode: 'all_in', untouchables: [AJ] }), env: {},
    aj: { allow: new Set([pick]), confirmed: new Set() } });
  assert.equal(r3.aj_pick.status, 'objective_untouchable');
});

test('plans schema: a waiting A.J. card is never next_move and never ahead of a served card', () => {
  const a = makeFuzzLeague(11);
  const res = plan(a, { allow: new Set([String(pickFor(a))]), confirmed: new Set() });
  const entry = toEntry(res, { names: a.names(), as_of: '2026-09-25T00:00:00Z' });
  const moves = entry.alternatives.value;
  const w = moves.findIndex(m => m.requires_nick_confirm);
  assert.ok(w > 0, 'seed 11 serves a deck and at least one waiting card');
  const bad = structuredClone(entry);
  const swapped = [bad.alternatives.value[w], ...bad.alternatives.value.filter((_, i) => i !== w)].map((m, i) => ({ ...m, rank: i + 1 }));
  bad.alternatives.value = swapped;
  bad.next_move = { ...bad.next_move, value: swapped[0] };
  const errs = validatePlans(plansFile([bad], { generated_at: '2026-09-25T00:00:00Z' })).errors.map(e => e.message).join(' | ');
  assert.match(errs, /without Nick's OK/);
  assert.match(errs, /must come after every other card/);
});

/* ------------------------------------------------------------ 6. the UI */


const viewWith = mutate => {
  const leagues = structuredClone(producer.leagues);
  mutate(leagues[0]);
  return buildWarRoomView(leagues[0].league, { status: 'ok', entries: leagues, as_of: '2026-09-25T06:00:00.000Z', id: 'plans@aj',
    head: { schema: producer.schema, producer: producer.producer, producer_version: producer.producer_version } }, { enabled: true, preview: false });
};

test('UI: a waiting A.J. card shows the banner and an OK button, and cannot be copied or sent; OK posts aj.confirm', async () => {
  const view = viewWith(e => {
    const card = structuredClone(e.alternatives.value[0]);
    card.move_id = 'L1-ajcard';
    card.steps[0].give = [AJ];
    card.steps[0].requires_nick_confirm = true;
    Object.assign(card, { requires_nick_confirm: true, nick_confirmed: false, aj_for: [card.steps[0].get[0]] });
    e.names[AJ] = 'Player Two Seventy Seven';
    e.alternatives.value = [card].map((m, i) => ({ ...m, rank: i + 1 }));
    e.next_move = { status: 'unknown', source: 'plan.path', reason: 'The only move this run gives A.J. Brown for a player you picked, so it needs your OK first (see the deck).' };
  });
  const posted = [];
  const post = async (p, init) => { posted.push([p, JSON.parse(init.body)]); return {}; };
  const html = renderToStaticMarkup(React.createElement(NextMoveDeck, { view, big: true, variant: 'hero', post }));
  const text = textOf(html);
  assert.match(text, /Needs your OK: gives A\.J\. Brown for /);
  assert.match(text, /Coach can explain it but not approve it/);
  assert.match(html, /data-testid="aj-ok-button"/);
  assert.match(html, /aria-label="Needs your OK"/, 'the card is not labelled as the next move');
  assert.match(html, /data-testid="aj-only-note"/, 'the no-next-move reason shows above the deck');
  assert.doesNotMatch(text, /I sent it/);
  assert.doesNotMatch(html, /data-testid="copy-button"|Copy message/);
  await postWarRoomRequest(1, ajConfirm('L1-ajcard'), post);
  assert.deepEqual(posted[0], ['/warroom/1/requests', { kind: 'aj.confirm', payload: { move_id: 'L1-ajcard' }, source: 'nick' }]);
});

test('UI: an ordinary head card has no banner', () => {
  const view = viewWith(() => {});
  const html = renderToStaticMarkup(React.createElement(NextMoveDeck, { view, big: true, variant: 'hero', post: async () => ({}) }));
  assert.doesNotMatch(html, /aj-ok-banner/);
  assert.match(html, /aria-label="Next move"/);
});

test('UI: Go get shows "Allow A.J. for him" only on Blue chip targets when A.J. is Nick\'s; the chip lists the picks', () => {
  const base = viewWith(() => {});
  const targets = base.targets?.status === 'ok' ? base.targets.value : [];
  assert.ok(targets.length >= 2, 'the contract fixture has targets');
  const [hi, lo] = targets;
  const board = { status: 'ok', source: 'people.score', value: { weights: { pick: 0.5, production: 0.5, basis: 'fixture' }, labels: [],
    coverage: { rostered: 3, board: 3, score: 1, model_value: 1 }, draft: { season: 2026, picks: 0 },
    rows: [[AJ, 88, true], [hi.player, 90, false], [lo.player, 70, false]].map(([player, score, mine]) => ({ player, name: `P${player}`, position: 'WR',
      mine, score, label: 'Blue chip', hurt: false, parts: { pick_pct: 1, prod_basis: 'season_ppg', prod_pct: 1, games: 1, team_games: 1, missed: 0 },
      model_value: { status: 'unknown', source: 'x' }, gaps: [], protected: false })) } };
  const view = { ...base, blue_chips: board };
  const picks = { enabled: true, allow: [String(hi.player)], busy: null, error: null, toggle: async () => {}, loading: false };
  const html = renderToStaticMarkup(React.createElement(ScreenGoGet, { view, leagueId: 1, current: null, aj: picks, compact: true }));
  const toggles = html.match(/data-testid="aj-allow-toggle"/g) ?? [];
  assert.equal(toggles.length, 1, 'only the 83+ target gets the toggle');
  assert.match(textOf(html), /A\.J\. allowed for him/, 'shows the current state');
  const notMine = { ...view, blue_chips: { ...board, value: { ...board.value, rows: board.value.rows.map(r => ({ ...r, mine: false })) } } };
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(ScreenGoGet, { view: notMine, leagueId: 1, current: null, aj: picks, compact: true })), /aj-allow-toggle/,
    'no toggle when A.J. is not on Nick\'s roster');
  assert.match(textOf(renderToStaticMarkup(React.createElement(AjAllowToggle, { player: '9', name: 'P9', picks }))), /Allow A\.J\. for him/);
  const chip = textOf(renderToStaticMarkup(React.createElement(AjAllowedChip, { picks, nameOf: id => `P${id}` })));
  assert.match(chip, /A\.J\. allowed for: 1 player$/);
  assert.equal(renderToStaticMarkup(React.createElement(AjAllowedChip, { picks: { ...picks, enabled: false }, nameOf: String })), '');
});
