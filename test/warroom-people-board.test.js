/**
 * PEOPLE-BOARD: the War Room's right rail (WAR-ROOM-UI.md v3, "RIGHT, THE PEOPLE BOARD").
 * client/src/components/warroom/PeopleBoard.tsx + PeopleTile.tsx.
 *
 *  - one tile per league-mate (Nick's own roster left out): the plans contract's
 *    `partners` section joined to the clone rows (people/profile-reader.js via
 *    warroom-clones.js), keyed by roster id;
 *  - each tile: mood, in-market (wants_player with its age + his credibility),
 *    P(responds), fatigue budget (offers this week of the mode's limit), last contact,
 *    approach; a slot with no producer is 'unknown' with its reason, never 0;
 *  - unreachable / non-buyer managers are greyed with Nick's reason and sorted last;
 *  - tapping a tile opens that manager's clone panel (UI-ENG-4) in the big slot;
 *  - behind its own flag (GRIDIRON_WARROOM_PEOPLE_ENABLED), on under preview mode,
 *    never on without the War Room; off leaves the grid exactly as it was.
 * Rows come from the real server builders over invented shapes. Labels only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadWarRoom, textOf } from './helpers/warroom-tsx.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const plans = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'warroom-contract', 'view-plans.json'), 'utf8'));
const { buildWarRoomView } = await import('../server/services/war-room-view.js');
const { buildCloneRows, CLONE_SOURCES } = await import('../server/services/warroom-clones.js');
const { normaliseProfile } = await import('../server/services/people/profile-reader.js');
const { peopleBoardFlag, PEOPLE_BOARD_ENV, WARROOM_ENV } = await import('../server/services/warroom-flag.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');

const wr = await loadWarRoom();
test.after(() => wr.cleanup());
const { default: WarRoom, PANELS, panelsFor, ROOT_STYLE, rootStyle } = await wr.mod('WarRoom');
const { default: PeopleBoard, peopleTiles } = await wr.mod('PeopleBoard');
const { default: PeopleTile } = await wr.mod('PeopleTile');

function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
}

/* ------------------------------------------------------------ fixtures */

const NOW = Date.parse('2026-09-24T12:00:00Z');
const ago = d => new Date(NOW - d * 86400000).toISOString();
// League 1 of the contract fixture: Nick is roster '3'.
const ME = '3';
const players = new Map([
  ['alpha runner', { id: '101', name: 'Alpha Runner', pos: 'RB', owner: '1' }],
  ['bravo catcher', { id: '102', name: 'Bravo Catcher', pos: 'WR', owner: '3' }],
]);
const prof = over => normaliseProfile({ as_of: ago(2), messages_read: 90, how_to_approach: 'lead with the numbers',
  says_no: { does_his_no_hold: 'rarely' },
  values_talk: { wants: { players: [{ player: 'Alpha Runner', at: ago(2) }] } }, ...over });
const rows = buildCloneRows({
  teams: ['1', '2', '3', '4', '5', '6'], me: ME,
  profiles: { available: true, byRoster: new Map([
    ['2', prof({ nick_override: { active: true } })],
    ['4', prof({ messages_read: 3 })],                              // quiet: no read
    ['5', prof({ nick_override: { contactable: false } })],          // unreachable
    ['6', prof({ nick_override: { buyer: false } })],                // not a buyer
  ]) },
  records: new Map([['2', { declarations: 4, held: 3, hard_reversals: 1, hedged: 0, credibility: 0.72, confidence: 'thin' }]]),
  players, now: NOW,
});
const clones = (over = {}) => ({ enabled: true, league_id: 1, sources: CLONE_SOURCES, people_board: { enabled: true, preview: false },
  clones: { status: 'ok', value: rows, source: 'people.profile', producer: 'warroom-clones', producer_version: 'x' }, ...over });

const edge = v => ({ status: 'ok', value: v, source: 'plan.path', unit: 'title_odds' });
const PARTNERS = { status: 'ok', source: 'campaign.plan', value: [
  { team: '2', p_responds: 0.65, basis: 'activity read (receptiveness 1.30)', edge: edge(0.06),
    chat_labels: ['engagement:high', 'tone:friendly'], roster_holes: ['RB'], offers_logged: 1, checked_out: false, blocked: false },
  { team: '5', p_responds: 0.5, basis: 'activity read (receptiveness 1.00)', edge: edge(0.05), offers_logged: 0, checked_out: false, blocked: false },
  { team: '1', p_responds: 0.15, basis: 'checked out (no recent activity)', edge: edge(0.03), checked_out: true, blocked: false },
  { team: '4', p_responds: 0, basis: 'marked as never trading', edge: edge(0.02), offers_logged: 0, checked_out: false, blocked: true },
] };
function view(partners = PARTNERS) {
  const doc = structuredClone(plans);
  doc.leagues[0].partners = partners;
  return buildWarRoomView(1, { status: 'ok', entries: doc.leagues, as_of: doc.generated_at, id: 'plans@t' }, { enabled: true, preview: false });
}
const byTeam = tiles => Object.fromEntries(tiles.map(t => [t.team, t]));
const markup = el => renderToStaticMarkup(el);

/* ---------------------------------------------------------------- flag */

test('flag: off by default, on with its own switch, on under preview, never without the War Room', () => {
  withEnv({ [WARROOM_ENV]: null, [PEOPLE_BOARD_ENV]: null, [PREVIEW_ENV]: null },
    () => assert.deepEqual(peopleBoardFlag(), { enabled: false, preview: false }));
  withEnv({ [WARROOM_ENV]: null, [PEOPLE_BOARD_ENV]: '1', [PREVIEW_ENV]: null },
    () => assert.deepEqual(peopleBoardFlag(), { enabled: false, preview: false }, 'needs the War Room'));
  withEnv({ [WARROOM_ENV]: '1', [PEOPLE_BOARD_ENV]: null, [PREVIEW_ENV]: null },
    () => assert.deepEqual(peopleBoardFlag(), { enabled: false, preview: false }, 'War Room alone does not turn it on'));
  withEnv({ [WARROOM_ENV]: '1', [PEOPLE_BOARD_ENV]: '1', [PREVIEW_ENV]: null },
    () => assert.deepEqual(peopleBoardFlag(), { enabled: true, preview: false }));
  withEnv({ [WARROOM_ENV]: '1', [PEOPLE_BOARD_ENV]: 'true', [PREVIEW_ENV]: null },
    () => assert.equal(peopleBoardFlag().enabled, false, 'exactly "1"'));
  withEnv({ [WARROOM_ENV]: null, [PEOPLE_BOARD_ENV]: null, [PREVIEW_ENV]: '1' },
    () => assert.deepEqual(peopleBoardFlag(), { enabled: true, preview: true }));
});

test('the clones route carries the flag, and preview-mode.js lists the site', () => {
  const route = fs.readFileSync(path.join(REPO, 'server', 'routes', 'trades.js'), 'utf8');
  const at = route.indexOf("r.get('/:leagueId/war-room/clones'");
  assert.ok(at > 0);
  assert.match(route.slice(at, at + 700), /people_board: peopleBoardFlag\(\)/);
  const pm = fs.readFileSync(path.join(REPO, 'server', 'services', 'preview-mode.js'), 'utf8');
  assert.match(pm, /warroom-flag\.js#peopleBoardFlag/);
});

/* ---------------------------------------------------------------- join */

test('one tile per league-mate: partners joined to clone rows, Nick left out', () => {
  const tiles = peopleTiles(view(), clones());
  assert.deepEqual(tiles.map(t => t.team).sort(), ['1', '2', '4', '5', '6']);
  assert.ok(!tiles.some(t => t.team === ME));
  for (const t of tiles) assert.equal(t.label, `Team ${t.team}`);
});

test('order: live tiles in the producer partner order first, greyed tiles last', () => {
  const tiles = peopleTiles(view(), clones());
  assert.deepEqual(tiles.map(t => [t.team, !!t.grey]), [['2', false], ['1', false], ['5', true], ['4', true], ['6', true]]);
});

test('unreachable and non-buyer tiles are greyed with Nick\'s reason; a never-trading partner with the plan\'s', () => {
  const t = byTeam(peopleTiles(view(), clones()));
  assert.match(t['5'].grey, /Nick: not reachable/);
  assert.match(t['6'].grey, /Nick: not doing trades/);
  assert.equal(t['4'].grey, 'marked as never trading');
  assert.equal(t['2'].grey, null, 'an active trader is live');
  assert.equal(t['1'].grey, null, 'checked out is a pill, not grey');
  assert.equal(t['1'].checked_out, true);
});

test('P(responds) and fatigue come from the partner entry and the mode\'s weekly limit', () => {
  const v = view();
  const t = byTeam(peopleTiles(v, clones()));
  assert.deepEqual(t['2'].p_responds.value, { p: 0.65, basis: 'activity read (receptiveness 1.30)' });
  assert.equal(t['2'].p_responds.status, 'ok');
  const limit = v.destination.value.tolerances.value.max_offers_per_manager_week;
  assert.ok(Number.isInteger(limit));
  assert.deepEqual(t['2'].fatigue.value, { used: 1, limit });
  // No offers_logged on the partner -> unknown with a reason, never 0 of N.
  assert.equal(t['1'].fatigue.status, 'unknown');
  assert.match(t['1'].fatigue.reason, /offers/);
  // Not a partner this run -> unknown, never 0%.
  assert.equal(t['6'].p_responds.status, 'unknown');
  assert.match(t['6'].p_responds.reason, /partner/);
});

test('in market: wants_player with its age from the clone row, plus his credibility and roster holes', () => {
  const t = byTeam(peopleTiles(view(), clones()));
  assert.equal(t['2'].wants.status, 'ok');
  assert.deepEqual(t['2'].wants.value.map(w => [w.player.name, w.age_days, w.state]), [['Alpha Runner', 2, 'fresh']]);
  assert.equal(t['2'].credibility.value.label, 'credible');
  assert.deepEqual(t['2'].holes, ['RB']);
  // Quiet manager: no read, and the reason says so.
  assert.equal(t['4'].wants.status, 'unknown');
  assert.match(t['4'].wants.reason, /quiet/);
});

test('mood is the chat tone label when one exists; approach is his profile\'s pitch label', () => {
  const t = byTeam(peopleTiles(view(), clones()));
  assert.deepEqual([t['2'].mood.status, t['2'].mood.value, t['2'].mood.source], ['ok', 'friendly', 'chat.labels']);
  assert.equal(t['5'].mood.status, 'unknown');
  assert.match(t['5'].mood.reason, /mood/);
  assert.deepEqual([t['2'].approach.status, t['2'].approach.value], ['ok', 'pitch with numbers']);
  assert.equal(t['4'].approach.status, 'unknown');
});

test('last contact has no producer yet: unknown with the reason on every tile', () => {
  for (const t of peopleTiles(view(), clones())) {
    assert.equal(t.last_contact.status, 'unknown');
    assert.ok(t.last_contact.reason.length > 20);
    assert.ok(!('value' in t.last_contact));
  }
});

test('partners unknown or clones missing: tiles still build, every slot says why', () => {
  const noPartners = view({ status: 'unknown', reason: 'the partner read did not run', source: 'campaign.plan' });
  const tiles = peopleTiles(noPartners, clones());
  assert.deepEqual(tiles.map(t => t.team).sort(), ['1', '2', '4', '5', '6']);
  for (const t of tiles) assert.match(t.p_responds.reason, /the partner read did not run/);
  const noClones = peopleTiles(view(), null);
  assert.deepEqual(noClones.map(t => t.team), ['2', '5', '1', '4'], 'partners alone, producer order, blocked last');
  for (const t of noClones) { assert.equal(t.wants.status, 'unknown'); assert.equal(t.approach.status, 'unknown'); }
});

/* -------------------------------------------------------------- render */

test('tile render: every slot, P(responds) as a percent, wants with its age, unknowns never 0', () => {
  const t = byTeam(peopleTiles(view(), clones()));
  const live = textOf(markup(React.createElement(PeopleTile, { tile: t['2'], big: true, onOpen() {} })));
  for (const s of ['Team 2', '65%', 'friendly', 'wants Alpha Runner', '2 days ago', 'His shop talk holds', 'needs RB',
    '1 of', 'offers this week', 'pitch with numbers', 'Last contact', 'not computed yet']) assert.ok(live.includes(s), `${s} in: ${live}`);
  const quiet = textOf(markup(React.createElement(PeopleTile, { tile: t['1'], big: false, onOpen() {} })));
  assert.match(quiet, /checked out/);
  assert.doesNotMatch(quiet, /\b0 of\b|\b0%/);
});

test('greyed tile: class, data flag and Nick\'s reason on the face of it', () => {
  const t = byTeam(peopleTiles(view(), clones()));
  const html = markup(React.createElement(PeopleTile, { tile: t['5'], big: false, onOpen() {} }));
  assert.match(html, /class="wr-person wr-person-grey"/);
  assert.match(html, /data-grey="true"/);
  assert.match(textOf(html), /Nick: not reachable/);
});

test('tapping a tile opens that manager\'s clone panel', () => {
  const t = byTeam(peopleTiles(view(), clones()));
  const opened = [];
  const el = PeopleTile({ tile: t['5'], big: false, onOpen: team => opened.push(team) });
  const find = n => (n && typeof n === 'object' && n.props?.onClick ? n
    : [].concat(n?.props?.children ?? []).map(find).find(Boolean));
  find(el).props.onClick();
  assert.deepEqual(opened, ['5'], 'a greyed tile still opens');
});

test('board render: the rail lists every tile, pages inside the panel, loading and failed states say so', () => {
  const html = textOf(markup(React.createElement(PeopleBoard, { view: view(), clones: clones(), big: true, onOpen() {} })));
  for (const n of ['Team 2', 'Team 1', 'Team 5', 'Team 4', 'Team 6']) assert.ok(html.includes(n), n);
  const loading = textOf(markup(React.createElement(PeopleBoard, { view: view(), clones: undefined, big: false, onOpen() {} })));
  assert.match(loading, /Team 2/, 'partners render while clone reads load');
  assert.match(loading, /clone reads loading/i);
  const failed = clones({ clones: { status: 'failed', reason: 'profile read broke', source: 'people.profile' } });
  const f = textOf(markup(React.createElement(PeopleBoard, { view: view(), clones: failed, big: false, onOpen() {} })));
  assert.match(f, /profile read broke/);
});

/* ------------------------------------------------------------- the grid */

const renderRoom = props => markup(React.createElement(WarRoom, {
  view: view(), leagues: [{ id: 1, name: 'L1' }], activeId: 1, onLeague() {}, onExit() {}, ...props }));

test('flag on: the people rail sits right of the panels, left of Coach, and is a phone deck page', () => {
  const html = renderRoom({ clones: clones() });
  assert.match(html, /data-panel="people"[^>]*style="grid-area:people"/);
  assert.match(html, /class="wr-root wr-app wr-people-on"/);
  const style = rootStyle(true);
  assert.equal(style.height, '100vh');
  assert.equal(style.overflow, 'hidden');
  for (const row of style.gridTemplateAreas.match(/"[^"]+"/g).slice(1)) assert.match(row, /people coach"$/);
  assert.deepEqual(panelsFor(true).map(p => p.id).slice(0, 2), ['next', 'people'], 'people-first on the phone deck');
  const dots = html.slice(html.indexOf('aria-label="Panels"'));
  assert.match(textOf(dots), /People/);
});

test('flag off: no rail, and the grid is exactly the one before', () => {
  for (const c of [clones({ people_board: { enabled: false, preview: false } }), null]) {
    const html = renderRoom({ clones: c });
    assert.doesNotMatch(html, /data-panel="people"/);
    assert.doesNotMatch(html, /wr-people-on/);
  }
  assert.deepEqual(rootStyle(false), ROOT_STYLE);
  assert.deepEqual(panelsFor(false), PANELS);
});

test('a tapped manager opens in the big slot with only his clone row', () => {
  const html = renderRoom({ clones: clones(), initialFocus: '2' });
  assert.match(html, /data-panel="clones"[^>]*style="grid-area:next"/);
  const panel = html.slice(html.indexOf('data-panel="clones"'));
  const body = textOf(panel.slice(0, panel.indexOf('</section>')));
  assert.match(body, /Team 2/);
  assert.doesNotMatch(body, /Team 5|Team 6/);
  assert.match(body, /All managers/);
});

test('labels only: nothing from a profile sentence reaches a tile', () => {
  const html = markup(React.createElement(PeopleBoard, { view: view(), clones: clones(), big: true, onOpen() {} }));
  assert.doesNotMatch(html, /lead with the numbers/);
});
