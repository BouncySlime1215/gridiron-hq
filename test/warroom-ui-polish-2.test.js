/**
 * UI-POLISH-2: four defects from the 08:14 War Room screenshots (main d8f7fa3b).
 *
 *  1. Coach's brief says who a roster is by the plans entry's `teams` map ('Manager (Team
 *     name)', 'Team N' only when the map has no name), in its own lines and in the planner
 *     prose it quotes ("better partner now: Team 1"), and every such claim still grounds;
 *  2. the next-move card has no "Walk away if" tile; the ladder's "Walk away at" rung stays;
 *  3. a tile's source chip wraps instead of ending in an ellipsis;
 *  4. on a phone the panel tab strip ends left of the app's floating assistant button
 *     (PageExplainAssistant: 56px wide, 20px from the right edge).
 *
 * The layout checks (3, 4) were measured in a browser at 1440x900 and 375x812 (PR body);
 * here they are pinned on the stylesheet rules that produce them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadWarRoom, textOf, WARROOM_DIR } from './helpers/warroom-tsx.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ui-polish-2-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const producer = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'warroom-contract', 'ui-contract-plans.json'), 'utf8'));
const { claimsFor, answerClaimsFor, teamOf } = await import('../server/services/coach/brief-claims.js');
const { checkClaim } = await import('../server/services/coach/brief.js');
const { newLedger } = await import('../server/services/coach/ledger.js');
const { buildWarRoomView } = await import('../server/services/war-room-view.js');

const wr = await loadWarRoom();
test.after(() => { wr.cleanup(); fs.rmSync(temp, { recursive: true, force: true }); });
const { default: NextMoveDeck } = await wr.mod('NextMoveDeck');

const UNREAD = { status: 'unknown', reason: 'not read in this test', rows: [] };
const INPUTS = { statements: UNREAD, credibility: UNREAD, replies: UNREAD, injuries: UNREAD };

/** League 1 with made-up manager names on every roster, and planner prose that names a team. */
function namedEntry() {
  const e = structuredClone(producer.leagues[0]);
  e.teams = { status: 'ok', source: 'campaign.plan',
    value: Object.fromEntries(Object.keys(e.teams.value).map((id, i) => [id, { manager: `Manager ${String.fromCharCode(65 + i)}`, name: `Squad ${id}` }])) };
  const partner = e.next_move.value.steps[0].partner;
  e._run = { ...(e._run ?? {}), changed: { changed: true, reason: `better partner now: Team ${partner}` } };
  return e;
}

const drafts = (entry, kind) => {
  const ledger = newLedger();
  return { ledger, claims: claimsFor(kind, { entry, inputs: INPUTS, ledger }) };
};

test('teamOf follows the client rule: manager (name), else either, else Team N', () => {
  const entry = { teams: { status: 'ok', value: { 1: { manager: 'Manager A', name: 'Squad 1' }, 2: { name: 'Squad 2' }, 3: { manager: ' ' } } } };
  assert.equal(teamOf(entry, '1'), 'Manager A (Squad 1)');
  assert.equal(teamOf(entry, 2), 'Squad 2');
  assert.equal(teamOf(entry, '3'), 'Team 3');
  assert.equal(teamOf({}, '9'), 'Team 9');
  assert.equal(teamOf({ teams: { status: 'unknown', reason: 'x' } }, '4'), 'Team 4');
});

test('(1) the brief names every mapped roster, in its own lines and the planner prose, and every claim grounds', () => {
  const entry = namedEntry();
  const partner = entry.next_move.value.steps[0].partner;
  for (const kind of ['morning', 'weekly']) {
    const { ledger, claims } = drafts(entry, kind);
    const text = claims.map(c => c.text).join('\n');
    for (const m of text.matchAll(/\bTeam (\d+)\b/g)) {
      assert.equal(teamOf(entry, m[1]), `Team ${m[1]}`, `${kind}: "Team ${m[1]}" only when the map has no name`);
    }
    for (const c of claims) assert.ok(checkClaim(c, ledger).ok, `${kind}: grounds: ${c.text}`);
    assert.ok(claims.some(c => c.text.startsWith(`Offer ${teamOf(entry, partner)} `)), `${kind}: the offer line names the partner`);
  }
  const { claims } = drafts(entry, 'morning');
  assert.ok(claims.some(c => c.text === `What changed: better partner now: ${teamOf(entry, partner)}`), 'the replan reason names him too');
});

test('(1) with no teams map the brief still says Team N (the public fixture shape)', () => {
  const entry = structuredClone(producer.leagues[0]);
  delete entry.teams;
  const partner = entry.next_move.value.steps[0].partner;
  const { claims } = drafts(entry, 'morning');
  assert.ok(claims.some(c => c.text.startsWith(`Offer Team ${partner} `)));
});

test('(1) Coach answers that quote a deal name the partner the same way', () => {
  const entry = namedEntry();
  const ledger = newLedger();
  const claims = answerClaimsFor('why_nothing', { entry, ledger });
  const offer = claims.find(c => /^A move does clear: offer /.test(c.text));
  assert.ok(offer, 'the clearing move is quoted');
  assert.ok(offer.text.includes(teamOf(entry, entry.next_move.value.steps[0].partner)));
  assert.ok(checkClaim(offer, ledger).ok, offer.text);
});

test('(2) the next-move card has no "Walk away if" tile; the ladder rung carries the walk-away', () => {
  const plans = { status: 'ok', entries: structuredClone(producer.leagues), as_of: '2026-09-24T06:00:00.000Z', id: 'plans@1',
    head: { schema: producer.schema, producer: producer.producer, producer_version: producer.producer_version } };
  const view = buildWarRoomView(1, plans, { enabled: true, preview: false });
  const html = renderToStaticMarkup(React.createElement(NextMoveDeck, { view, big: true }));
  assert.ok(!/walk away if/i.test(textOf(html)), 'no tile');
  const rung = html.match(/<li data-rung="walk">[\s\S]*?<\/li>/)?.[0];
  assert.ok(rung, 'the ladder has its walk-away rung');
  assert.match(textOf(rung), /Walk away at/);
  assert.equal((html.match(/class="wr-tile"/g) ?? []).length, 2, 'two tiles left: chance he says yes, title odds');
  assert.match(html, /class="wr-tiles wr-tiles-2"/, 'laid out two across');
});

const css = fs.readFileSync(path.join(WARROOM_DIR, 'warroom.css'), 'utf8');
const rule = sel => [...css.matchAll(new RegExp(`(?:^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))].map(m => m[1]);

test('(3) a tile source chip wraps: no nowrap/ellipsis on the tile foot, and its tags may wrap', () => {
  const foot = rule('.wr-tile .wr-s').join(';');
  assert.ok(foot, 'the tile foot rule exists');
  assert.doesNotMatch(foot, /nowrap|ellipsis|overflow:\s*hidden/);
  assert.match(rule('.wr-tile .wr-s .wr-tag').join(';'), /white-space:\s*normal/);
});

test('(4) on a phone the tab strip ends left of the floating assistant button (56px + 20px from the edge)', () => {
  const phone = css.slice(css.indexOf('@media (max-width: 699px)'));
  const dots = [...phone.matchAll(/\.wr-dots\s*\{([^}]*)\}/g)].map(m => m[1]).join(';');
  const margin = Number(dots.match(/margin-right:\s*(\d+)px/)?.[1] ?? 0);
  const appPad = 6; // .wr-app's phone padding, which the strip already sits inside
  assert.ok(margin + appPad >= 56 + 20, `strip margin ${margin}px + ${appPad}px clears the 76px the button takes`);
});
