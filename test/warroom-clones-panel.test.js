/**
 * UI-ENG-4: the clone panel in the one-dashboard grid (client/src/components/warroom/CloneBoard.tsx).
 *
 *  - it is a panel in the grid (its own area), and a page on the phone deck;
 *  - it renders the server's rows: band, basis note, Nick's labels, wants (fresh / fading),
 *    shop-talk credibility, top reasons when expanded;
 *  - unknown renders "not computed yet" / the reason, never 0; failed shows no digits;
 *  - the fetch lives in useWarRoom.ts and asks for /trades/:id/war-room/clones.
 * Rows are built by the real server builder from invented shapes.
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
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'war-room-plans.json'), 'utf8'));
const { buildWarRoomView } = await import('../server/services/war-room-view.js');
const { buildCloneRows, CLONE_SOURCES } = await import('../server/services/warroom-clones.js');
const { cloneProfile } = await import('../server/services/warroom-clones.js');
const { peopleProfileEntry } = await import('../server/services/people/profile-reader.js');

const wr = await loadWarRoom();
test.after(() => wr.cleanup());
const { default: WarRoom, PANELS, ROOT_STYLE } = await wr.mod('WarRoom');
const { default: CloneBoard } = await wr.mod('CloneBoard');
const { useWarRoomClones } = await wr.mod('useWarRoom');

const NOW = Date.parse('2026-09-24T12:00:00Z');
const ago = d => new Date(NOW - d * 86400000).toISOString();
const players = new Map([
  ['alpha runner', { id: '101', name: 'Alpha Runner', pos: 'RB', owner: '1' }],
  ['bravo catcher', { id: '102', name: 'Bravo Catcher', pos: 'WR', owner: '5' }],
]);
/** A schema-v2 row through THE reader (profile-reader.js), then the panel's labels. */
const prof = over => {
  const raw = { headline: 'h', what_moves_him: [], caveats: [], confidence: 'medium', how_to_approach: 'x',
    praise_means: { reading: 'mixed', why: 'x', evidence: [] }, techniques: [],
    calibration: { enthusiasm_scale: 'x', inflation: 'none' },
    as_of: ago(2), messages_read: 90, says_no: { how: 'x', evidence: [], does_his_no_hold: 'rarely' },
    values_talk: { wants: { players: [{ player: 'Alpha Runner', at: ago(2) }, { player: 'Bravo Catcher', at: ago(12) }] } }, ...over };
  return cloneProfile(peopleProfileEntry({ name: 'x', row: { profile_json: JSON.stringify(raw), messages_read: raw.messages_read } }));
};
const rows = buildCloneRows({
  teams: ['1', '2', '3', '4'], me: '1',
  profiles: { available: true, byRoster: new Map([
    ['2', prof({ nick_override: { active: true } })],
    ['3', prof({ messages_read: 2 })],
    ['4', prof({ nick_override: { contactable: false } })],
  ]) },
  counterparties: new Map([['2', { accept_rate: 0.4, accept_rate_n: 3, receptiveness: 1 }]]),
  records: new Map([['2', { declarations: 4, held: 3, hard_reversals: 1, hedged: 0, credibility: 0.72, confidence: 'thin' }]]),
  players, now: NOW,
});
const clones = { enabled: true, league_id: 1, sources: CLONE_SOURCES, clones: { status: 'ok', value: rows, source: 'people.profile', producer: 'warroom-clones', producer_version: 'x' } };
const render = (view, big) => textOf(renderToStaticMarkup(React.createElement(CloneBoard, { view, big })));

test('the clone panel sits in the one grid and on the phone deck', () => {
  assert.ok(PANELS.some(p => p.id === 'clones'));
  assert.ok(ROOT_STYLE.gridTemplateAreas.includes('clones'));
  const view = buildWarRoomView(1, { status: 'ok', entries: structuredClone(fixture), as_of: 'x', id: 'y' }, { enabled: true, preview: false });
  const html = renderToStaticMarkup(React.createElement(WarRoom, { view, clones, leagues: [{ id: 1, name: 'L1' }], activeId: 1, onLeague() {}, onExit() {} }));
  assert.match(html, /data-panel="clones"[^>]*style="grid-area:clones"/);
  assert.match(textOf(html), /How each manager reads/);
  assert.match(html, /<button[^>]*>Clones<\/button>/, 'a dot for the phone deck');
});

test('compact rows: band with its basis, Nick\'s word, wants, and whether his shop talk holds', () => {
  const t = render(clones, false);
  assert.match(t, /Team 2 active \d+%–\d+% · thin \(n=3\)/);
  assert.match(t, /Nick: active trader/);
  assert.match(t, /wants Alpha Runner · you have him/);
  assert.match(t, /His shop talk holds \(3 of 4 held\)/);
  assert.match(t, /Team 3 [^T]*not computed yet/, 'a quiet manager\'s shop-talk read is unknown');
  assert.doesNotMatch(t, /Team 4/, 'the unreachable manager pages after the first two');
});

test('expanded rows: traits, top reasons, fading wants, and the unreachable manager with no band', () => {
  const t = render(clones, true);
  assert.match(t, /his no is an opening price/);
  assert.match(t, /Top reasons his profile says his no rarely holds \+8\.0 pts/);
  assert.match(t, /Trade model: chance he says yes guess/, 'source pill uses the label, amber guess');
  assert.match(t, /wants Bravo Catcher · fading/);
  assert.match(t, /population, not him/);
  assert.match(t, /Chance he says yes · why · what he wants · does his talk hold/);
  assert.match(t, /quiet in chat/);
});

test('the unreachable manager shows no band and says why; nothing reads as 0', () => {
  const only4 = { ...clones, clones: { ...clones.clones, value: rows.filter(r => r.team === '4') } };
  const t = render(only4, true);
  assert.match(t, /Team 4 left out/);
  assert.match(t, /Nick: not reachable/);
  assert.doesNotMatch(t, /\d+%–\d+%/);
  assert.doesNotMatch(render(clones, true), /\b0%|NaN|undefined/);
});

test('whole-panel states: loading, unknown with its reason, failed without digits', () => {
  assert.match(render(null, false), /Clone reads loading/);
  assert.match(render({ enabled: true, clones: { status: 'unknown', reason: 'This league has not synced its rosters yet.', source: 's', producer: 'p', producer_version: 'v' } }, false),
    /has not synced its rosters yet/);
  const failed = render({ enabled: true, clones: { status: 'failed', reason: 'The counterparty layer failed.', source: 's', producer: 'p', producer_version: 'v' } }, false);
  assert.match(failed, /failed its check, so it is hidden/);
  assert.doesNotMatch(failed, /\d/);
});

test('the clone read goes through useWarRoom.ts to the clones route', () => {
  globalThis.__warRoomPaths = [];
  const Probe = () => { useWarRoomClones(4); useWarRoomClones(null); return null; };
  renderToStaticMarkup(React.createElement(Probe));
  assert.deepEqual(globalThis.__warRoomPaths, ['/trades/4/war-room/clones', null]);
});
