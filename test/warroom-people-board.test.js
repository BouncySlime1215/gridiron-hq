/**
 * PEOPLE-BOARD: the War Room's right rail (WAR-ROOM-UI.md v3, "RIGHT, THE PEOPLE BOARD").
 * server/services/war-room-view.js#buildPeopleBoard / peopleInputs. The client PeopleBoard.tsx retired
 * with the War Room shell (Trades cleanup part 2); People is Trades -> People (ManagerCard) now.
 *
 *  - one tile per league-mate (Nick's own roster left out), served whole in `view.people`:
 *    a join by roster id of reads only, each from its ONE producer (FIELD-REGISTRY.md):
 *    P(responds) + fatigue from the plan's partners, Nick's word from people.counterpart
 *    (people.profile as fallback) off the hub, mood + in-market from people_pulse, his
 *    word from people_credibility, the approach from people.profile labels;
 *  - Nick's notes override the models: can't reach him = never a partner, sorted last; not
 *    a buyer = goes last (before him); hard negotiator flagged;
 *  - a slot whose producer has no row is typed unknown with its reason, never 0;
 *  - behind peopleBoardFlag (GRIDIRON_WARROOM_PEOPLE_ENABLED, on under preview mode, never
 *    without the War Room); off leaves the view and the grid exactly as they were;
 *  - one reader: no War Room file parses a profile or opens the chat DB.
 * Fixtures are invented (Team N / Player N). Labels only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WARROOM_DIR } from './helpers/warroom-tsx.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const producer = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'warroom-contract', 'ui-contract-plans.json'), 'utf8'));
const wv = await import('../server/services/war-room-view.js');
const { buildWarRoomView, buildPeopleBoard, peopleInputs, cachedPeopleInputs, __resetPeopleCache, PEOPLE_TTL_MS, warRoomView,
  LAST_CONTACT_REASON, PEOPLE_SOURCES } = wv;
const { peopleBoardFlag, PEOPLE_BOARD_ENV, WARROOM_ENV, WARROOM_PLANS_ENV } = await import('../server/services/warroom-flag.js');
const { PREVIEW_ENV, PREVIEW_PREFIX } = await import('../server/services/preview-mode.js');


async function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
}

/* ------------------------------------------------------------ fixtures */

// League 1 of the UI contract fixture: Nick is roster '3'; its moves have steps with Teams 7 and 2.
const ME = '3';
const NOW = '2026-09-24T12:00:00.000Z';
const at = days => new Date(Date.parse(NOW) - days * 864e5).toISOString();
const edge = v => ({ status: 'ok', value: v, source: 'plan.path', unit: 'title_odds' });
const PARTNERS = { status: 'ok', source: 'campaign.plan', value: [
  { team: '7', p_responds: 0.53, basis: 'activity read (receptiveness 1.05)', edge: edge(0.004),
    chat_labels: ['tone:friendly'], offers_logged: 1, checked_out: false, blocked: false },
  { team: '4', p_responds: 0, basis: 'Nick: not contactable', edge: edge(0), offers_logged: 0, checked_out: false, blocked: true },
  { team: '2', p_responds: 0.5, basis: 'activity read (receptiveness 1.00)', edge: edge(0.003), offers_logged: 2, checked_out: false, blocked: false },
  { team: '12', p_responds: 0.05, basis: 'Nick: not a buyer', edge: edge(0.001), offers_logged: 1, checked_out: false, blocked: false },
  { team: '1', p_responds: 0.54, basis: 'activity read (receptiveness 1.10)', edge: edge(0.002), checked_out: true, blocked: false },
] };

function view(partners = PARTNERS) {
  const leagues = structuredClone(producer.leagues);
  leagues[0].partners = partners;
  return buildWarRoomView(1, { status: 'ok', entries: leagues, as_of: producer.generated_at, id: 'plans@t' }, { enabled: true, preview: false });
}

const override = (o = {}) => ({ status: 'ok', exclude: false, deprioritize: false, toughen: false, basis: "Nick's read", nick: null, ...o });
const cpRow = (value) => ({ value, absence: null, as_of: NOW, producer: 'people-counterpart', producer_version: 'x', state_id: 1, health: 'ok' });
const profRow = (value) => ({ value, absence: null, as_of: NOW, producer: 'people-profile', producer_version: 'x', state_id: 2, health: 'ok' });
const labels = (l = {}) => ({ status: 'ok', reason: null, labels: { does_his_no_hold: 'rarely', praise_reading: 'belief',
  hypes_before_selling: false, inflation: 'mild', confidence: 'medium', techniques_how_often: [], ...l }, nick: null });

/** The hub, pulse and credibility reads as peopleInputs returns them. */
function inputs(over = {}) {
  return {
    now: NOW,
    counterpart: { available: true, byRoster: new Map([
      ['7', cpRow({ team: '7', status: 'ok', wants: [{ player: '101', n: 2, lift: 1.4 }], override: override() })],
      ['4', cpRow({ team: '4', status: 'ok', wants: [], override: override({ exclude: true }) })],
      ['2', cpRow({ team: '2', status: 'ok', wants: [], override: override({ toughen: true }) })],
      ['12', cpRow({ team: '12', status: 'unknown', wants: [], override: override({ deprioritize: true }) })],
      ['1', cpRow({ team: '1', status: 'ok', wants: [], override: override({ status: 'none' }) })],
      ['3', cpRow(null)],
    ]) },
    profile: { available: true, byRoster: new Map([
      ['7', profRow(labels())],
      ['2', profRow(labels({ does_his_no_hold: 'yes', inflation: 'heavy' }))],
      ['12', profRow({ status: 'unknown', reason: 'quiet in chat (fewer than 30 messages read)', labels: null, nick: null })],
      ['1', profRow(labels({ does_his_no_hold: 'unknown', inflation: 'none', praise_reading: 'belief' }))],
    ]) },
    pulse: { status: 'ok', items: [
      { roster_id: 7, type: 'WANT_PLAYER', phrase: 'in-market for Player 101', ago: '1d ago', credible: true, as_of: at(1) },
      { roster_id: 7, type: 'HYPE', phrase: 'talking up Player 102', ago: '2d ago', credible: false, as_of: at(2) },
      { roster_id: 2, type: 'SHOP', phrase: 'shopping Player 103', ago: '12d ago', credible: false, as_of: at(12) },
      { roster_id: 2, type: 'FRUSTRATED', phrase: 'down on Player 103', ago: '3d ago', credible: false, as_of: at(3) },
    ] },
    credibility: { as_of: NOW, rosters: {
      7: { WANT_PLAYER: { 7: { status: 'proven', n_statements: 6, weight: 11.2 } }, SHOP: { 7: { status: 'noise', n_statements: 5, weight: 1 } } },
      2: { WANT_PLAYER: { 7: { status: 'unknown', n_statements: 0, weight: null } } },
    } },
    ...over,
  };
}
const byTeam = f => Object.fromEntries(f.value.map(t => [t.team, t]));

/* ---------------------------------------------------------------- flag */

test('flag: off by default, on with its own switch, on under preview, never without the War Room', async () => {
  await withEnv({ [WARROOM_ENV]: null, [PEOPLE_BOARD_ENV]: null, [PREVIEW_ENV]: null },
    () => assert.deepEqual(peopleBoardFlag(), { enabled: false, preview: false }));
  await withEnv({ [WARROOM_ENV]: null, [PEOPLE_BOARD_ENV]: '1', [PREVIEW_ENV]: null },
    () => assert.deepEqual(peopleBoardFlag(), { enabled: false, preview: false }, 'needs the War Room'));
  await withEnv({ [WARROOM_ENV]: '1', [PEOPLE_BOARD_ENV]: null, [PREVIEW_ENV]: null },
    () => assert.deepEqual(peopleBoardFlag(), { enabled: false, preview: false }, 'War Room alone does not turn it on'));
  await withEnv({ [WARROOM_ENV]: '1', [PEOPLE_BOARD_ENV]: '1', [PREVIEW_ENV]: null },
    () => assert.deepEqual(peopleBoardFlag(), { enabled: true, preview: false }));
  await withEnv({ [WARROOM_ENV]: null, [PEOPLE_BOARD_ENV]: null, [PREVIEW_ENV]: '1' },
    () => assert.deepEqual(peopleBoardFlag(), { enabled: true, preview: true }));
  const pm = fs.readFileSync(path.join(REPO, 'server', 'services', 'preview-mode.js'), 'utf8');
  assert.match(pm, /warroom-flag\.js#peopleBoardFlag/, 'preview-mode.js lists the site');
});

/* ---------------------------------------------------------------- join */

test('one tile per league-mate, Nick left out, labels only', () => {
  const f = buildPeopleBoard(view(), inputs());
  assert.equal(f.status, 'ok');
  assert.deepEqual(f.value.map(t => t.team).sort(), ['1', '12', '2', '4', '7']);
  for (const t of f.value) assert.equal(t.label, `Team ${t.team}`);
  const withMe = { ...PARTNERS, value: [...PARTNERS.value, { team: ME, p_responds: 1, basis: 'x', edge: edge(0), checked_out: false, blocked: false }] };
  assert.ok(!buildPeopleBoard(view(withMe), inputs()).value.some(t => t.team === ME));
});

test('a tile names the manager from the entry\'s teams map (TEAM-NAMES x PEOPLE-BOARD, INT6); no name -> Team N', () => {
  const teams = { status: 'ok', value: { 7: { manager: 'Manager A', name: 'Team Seven' }, 2: { name: 'Team Two' } }, source: 'campaign.plan' };
  const t = byTeam(buildPeopleBoard({ ...view(), teams }, inputs()));
  assert.equal(t['7'].label, 'Manager A (Team Seven)');
  assert.equal(t['2'].label, 'Team Two');
  assert.equal(t['1'].label, 'Team 1');
  const unknownTeams = { status: 'unknown', reason: 'The league adapter read no team or manager names.', source: 'campaign.plan' };
  assert.equal(byTeam(buildPeopleBoard({ ...view(), teams: unknownTeams }, inputs()))['7'].label, 'Team 7');
});

test("Nick's notes override the models: never a partner last, the non-buyer before him, hard negotiators flagged", () => {
  const f = buildPeopleBoard(view(), inputs());
  assert.deepEqual(f.value.map(t => [t.team, t.standing]),
    [['7', 'live'], ['2', 'live'], ['1', 'live'], ['12', 'last'], ['4', 'never']], 'plan order for the live tiles, then Nick\'s order');
  const t = byTeam(f);
  assert.equal(t['4'].nick.never, true);
  assert.match(t['4'].nick.said.join(), /never a partner/);
  assert.match(t['12'].nick.said.join(), /not a buyer, goes last/);
  assert.equal(t['2'].nick.hard, true);
  assert.match(t['2'].nick.said.join(), /hard negotiator/);
  assert.equal(t['7'].nick.said.length, 0);
});

test("Nick's block from people.profile stands in when the counterpart hub has no row", () => {
  const f = buildPeopleBoard(view(), inputs({
    counterpart: { available: false, reason: 'no people.counterpart rows on the hub for this league' },
    profile: { available: true, byRoster: new Map([['4', profRow({ ...labels(), nick: { unreachable: true } })],
      ['1', profRow({ ...labels(), nick: { hard: true } })]]) },
  }));
  const t = byTeam(f);
  assert.equal(t['4'].standing, 'never');
  assert.equal(t['4'].nick.source, 'people.profile');
  assert.equal(t['1'].nick.hard, true);
});

test("with no hub people rows, the plan partner's own blocked still makes roster 4 never a partner", () => {
  const noHub = { counterpart: { available: false, reason: 'no people.counterpart rows on the hub for this league' },
    profile: { available: false, reason: 'no people.profile rows on the hub for this league' } };
  const f = buildPeopleBoard(view(), inputs(noHub));
  assert.equal(f.status, 'ok');
  const t = byTeam(f);
  assert.equal(t['4'].standing, 'never');
  assert.equal(t['4'].nick.never, true);
  assert.equal(t['4'].nick.source, 'campaign.plan');
  assert.match(t['4'].nick.said.join(), /never a partner/);
  assert.equal(f.value.at(-1).team, '4', 'sorted last');
  assert.equal(t['7'].standing, 'live');
  // stale hub row (no exclude) for him: the plan's blocked still stands
  const stale = buildPeopleBoard(view(), inputs({ counterpart: { available: true, byRoster: new Map([
    ['4', cpRow({ team: '4', status: 'ok', wants: [], override: override() })]]) } }));
  assert.equal(byTeam(stale)['4'].standing, 'never');
});

test('P(responds) and fatigue come from the plan partners and the weekly limit, never invented', () => {
  const v = view();
  const t = byTeam(buildPeopleBoard(v, inputs()));
  assert.deepEqual([t['7'].p_responds.status, t['7'].p_responds.source], ['ok', 'campaign.plan']);
  assert.deepEqual(t['7'].p_responds.value, { p: 0.53, basis: 'activity read (receptiveness 1.05)' });
  const limit = v.destination.value.tolerances.value.max_offers_per_manager_week;
  assert.deepEqual(t['2'].fatigue.value, { used: 2, limit });
  // No offers count on his partner entry -> unknown with a reason, never "0 of N".
  assert.equal(t['1'].fatigue.status, 'unknown');
  assert.match(t['1'].fatigue.reason, /offers/);
  assert.equal(t['1'].checked_out, true);
});

test('a manager the plan did not score: P(responds) and fatigue unknown with the reason, other slots still read', () => {
  const noPartner = { ...PARTNERS, value: PARTNERS.value.filter(p => p.team !== '2') };
  const t = byTeam(buildPeopleBoard(view(noPartner), inputs()));
  assert.equal(t['2'].p_responds.status, 'unknown');
  assert.match(t['2'].p_responds.reason, /did not score him/);
  assert.ok(!('value' in t['2'].p_responds));
  assert.equal(t['2'].fatigue.status, 'unknown');
  assert.equal(t['2'].mood.status, 'ok');
  // The partners section missing entirely: its own reason on every tile.
  const none = buildPeopleBoard(view({ status: 'unknown', reason: 'the partner read did not run', source: 'campaign.plan' }), inputs());
  assert.equal(none.status, 'ok', 'the hub still knows the managers');
  for (const x of none.value) assert.match(x.p_responds.reason, /the partner read did not run/);
});

test('mood and in-market from the chat pulse; his word from the follow-through record; approach from profile labels', () => {
  const t = byTeam(buildPeopleBoard(view(), inputs()));
  assert.deepEqual([t['7'].mood.value, t['7'].mood.source], ['talking his players up (2d ago)', 'people.pulse']);
  assert.match(t['2'].mood.value, /^frustrated/);
  assert.deepEqual([t['1'].mood.status, t['1'].mood.source], ['unknown', 'people.pulse'], 'no statement and no tone: unknown');
  assert.deepEqual(t['7'].in_market.value.said.map(s => [s.text, s.credible, s.fading]), [['in-market for Player 101', true, false]]);
  assert.equal(t['7'].in_market.value.wants_n, 1);
  assert.equal(t['2'].in_market.value.said[0].fading, true, 'older than a week fades');
  assert.equal(t['1'].in_market.status, 'unknown');
  assert.deepEqual(t['7'].word.value.wants, { status: 'proven', n: 6, weight: 11.2 });
  assert.equal(t['7'].word.value.shop.status, 'noise');
  assert.equal(t['2'].word.status, 'unknown', 'only ungraded rows: unknown');
  assert.match(t['7'].approach.value, /his no rarely holds/);
  assert.match(t['2'].approach.value, /discount his hype.*hold your price/);
  assert.equal(t['12'].approach.status, 'unknown');
  assert.match(t['12'].approach.reason, /quiet in chat/);
});

test('last contact has no producer yet: unknown with the reason on every tile', () => {
  for (const t of buildPeopleBoard(view(), inputs()).value) {
    assert.deepEqual([t.last_contact.status, t.last_contact.reason], ['unknown', LAST_CONTACT_REASON]);
    assert.ok(!('value' in t.last_contact));
  }
});

test('no producer rows at all: every slot typed unknown or failed with its reason, never a digit', () => {
  const empty = {
    now: NOW,
    counterpart: { available: false, reason: 'no people.counterpart rows on the hub for this league' },
    profile: { available: false, failed: true, reason: 'the hub read failed (boom)' },
    pulse: { status: 'table_absent', items: [] },
    credibility: { absent: 'the follow-through table is missing (migration 099 not applied)' },
  };
  const t = byTeam(buildPeopleBoard(view(), empty));
  assert.deepEqual([t['7'].approach.status, t['7'].word.status, t['7'].in_market.status], ['failed', 'unknown', 'unknown']);
  assert.match(t['7'].approach.reason, /boom/);
  assert.match(t['7'].in_market.reason, /migration 098/);
  assert.match(t['7'].word.reason, /migration 099/);
  assert.equal(t['7'].mood.source, 'chat.labels', 'the plan tone label still reads');
  assert.equal(t['2'].mood.status, 'unknown');
  const bare = buildPeopleBoard(view({ status: 'unknown', reason: 'no partners', source: 'campaign.plan' }), empty);
  assert.equal(bare.status, 'unknown');
  assert.match(bare.reason, /no partners/);
});

test('peopleInputs on a database without the people tables: typed absences, no throw', async () => {
  const got = await peopleInputs(1, { now: NOW });
  assert.equal(got.counterpart.available, false);
  assert.ok(got.counterpart.reason);
  assert.equal(got.profile.available, false);
  assert.ok(['table_absent', 'failed', 'ok'].includes(got.pulse.status));
  const f = buildPeopleBoard(view(), got);
  for (const t of f.value) {
    for (const k of ['approach', 'word', 'in_market']) if (t[k].status !== 'ok') assert.ok(t[k].reason, `${k} says why`);
  }
});

/* ---------------------------------------------------------- the served view */

test('the route reads the people inputs once per league per TTL', async () => {
  __resetPeopleCache();
  const a = await cachedPeopleInputs(1, { nowMs: 1_000_000 });
  assert.equal(await cachedPeopleInputs(1, { nowMs: 1_000_000 + PEOPLE_TTL_MS - 1 }), a, 'inside the TTL: the same read');
  assert.notEqual(await cachedPeopleInputs(1, { nowMs: 1_000_000 + PEOPLE_TTL_MS }), a, 'after it: read again');
  assert.notEqual(await cachedPeopleInputs(2, { nowMs: 1_000_000 }), a, 'per league');
  __resetPeopleCache();
});

test('the served view carries people only with the flag on; preview prefixes its reasons', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-board-'));
  const file = path.join(dir, 'plans.json');
  const doc = structuredClone(producer);
  doc.leagues[0].partners = PARTNERS;
  fs.writeFileSync(file, JSON.stringify(doc));
  try {
    await withEnv({ [WARROOM_PLANS_ENV]: file, [WARROOM_ENV]: '1', [PEOPLE_BOARD_ENV]: null, [PREVIEW_ENV]: null }, async () => {
      const off = await warRoomView(1);
      assert.equal(off.people, undefined);
      assert.deepEqual(off.people_board, { enabled: false, preview: false });
    });
    await withEnv({ [WARROOM_PLANS_ENV]: file, [WARROOM_ENV]: '1', [PEOPLE_BOARD_ENV]: '1', [PREVIEW_ENV]: null }, async () => {
      const on = await warRoomView(1);
      assert.equal(on.people.status, 'ok');
      assert.equal(on.people.value.filter(t => t.p_responds.status === 'ok' && t.fatigue.status === 'ok').length, 4);
      for (const id of Object.keys(PEOPLE_SOURCES)) assert.ok(on.sources[id], `${id} has a source label`);
    });
    await withEnv({ [WARROOM_PLANS_ENV]: file, [WARROOM_ENV]: null, [PEOPLE_BOARD_ENV]: null, [PREVIEW_ENV]: '1' }, async () => {
      const pv = await warRoomView(1);
      const t = pv.people.value.find(x => x.last_contact);
      assert.ok(t.last_contact.reason.startsWith(PREVIEW_PREFIX));
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------ one reader */

test('one reader: the War Room reads people through the hub, pulse and credibility modules only', () => {
  const src = fs.readFileSync(path.join(REPO, 'server', 'services', 'war-room-view.js'), 'utf8');
  assert.doesNotMatch(src, /profile_json|negotiation_profiles|manager_notes|openChatDb|profile-reader\.js'|counterpart\.js'/);
  assert.match(src, /import\('\.\/people\/hub-read\.js'\)/);
  assert.ok(!fs.existsSync(path.join(REPO, 'server', 'services', 'warroom-clones.js')), 'no second reader behind a clone panel');
  for (const f of fs.readdirSync(WARROOM_DIR, { recursive: true }).filter(f => /\.tsx?$/.test(f))) {
    const s = fs.readFileSync(path.join(WARROOM_DIR, f), 'utf8');
    assert.doesNotMatch(s, /profile_json|manager_notes/, `${f} reads no profile store`);
  }
});
