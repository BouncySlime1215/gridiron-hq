/**
 * UI-ENG-5: the planner's chess path (trade -> claim -> flip, CHESS-01a) as a stepper
 * in the War Room (WAR-ROOM-UI.md v2: one-dashboard grid, phone deck).
 *
 * View (server/services/war-room-view.js `chess_path`):
 *  - each path keeps the producer's order and its steps in order, each with its kind,
 *    its own P(yes) and the title-odds change after that step (producer numbers only);
 *  - a claim priced `not_modelled` shows its chance as unknown with the reason, never 100%;
 *  - every step says what happens when it fails: you keep the steps before it, and the
 *    backup branch is the best other searched path that shares those steps and differs here;
 *    a step with no such path says so (unknown), it is never left blank;
 *  - a failed search is hidden with its reason and no digits; no search is unknown.
 * Client (ChessPath.tsx):
 *  - the stepper renders every step, P(yes) per step, odds after each step and the backup;
 *  - the Chess path panel sits in the one grid and in the phone deck.
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
const plans = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'war-room-plans.json'), 'utf8'));
const chess = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'war-room-chess.json'), 'utf8'));
const { buildWarRoomView } = await import('../server/services/war-room-view.js');

const wr = await loadWarRoom();
test.after(() => wr.cleanup());

function viewWith(mutateChess, { preview = false } = {}) {
  const entries = structuredClone(plans);
  const c = structuredClone(chess);
  entries[0].chess = mutateChess ? mutateChess(c) ?? c : c;
  return buildWarRoomView(1, { status: 'ok', entries, as_of: '2026-09-24T00:00:00.000Z', id: 'plans@1' }, { enabled: true, preview });
}

/** Every `value` key anywhere under a node. */
const values = node => JSON.stringify(node).match(/"value":/g)?.length ?? 0;

test('view: paths in producer order, each step with its kind, P(yes) and odds change after it', () => {
  const f = viewWith().chess_path;
  assert.equal(f.status, 'ok');
  const [p1, p2, p3, p4] = f.value.paths;
  assert.deepEqual(f.value.paths.map(p => p.rank), [1, 2, 3, 4]);
  assert.deepEqual(p1.steps.map(s => s.kind), ['trade', 'claim', 'flip']);
  assert.deepEqual(p1.steps.map(s => s.n), [1, 2, 3]);
  assert.equal(p1.steps[0].line, 'Team 7: give M. Oduya (WR) for C. Ruiz (RB)');
  assert.equal(p1.steps[1].line, 'Claim S. Achebe (RB), drop Y. Banks (TE)');
  assert.equal(p1.steps[2].line, 'Team 2: pass on C. Ruiz (RB) for D. Harlow (WR)');
  assert.equal(p1.steps[0].p_yes.value, 0.38);
  assert.equal(p1.steps[0].p_yes.source, 'clone.accept');
  assert.equal(p1.steps[2].p_yes.value, 0.31);
  assert.deepEqual(p1.steps.map(s => s.change_after.value), [0.012, 0.019, 0.027]);
  assert.equal(p1.steps[2].change_after.se, 0.006);
  assert.equal(p1.steps[0].change_after.source, 'sim.title');
  assert.equal(p1.p_complete.value, 0.1178);
  assert.equal(p1.expected.value, 0.0133);
  assert.equal(p1.full.value, 0.027);
  assert.equal(p1.full.clears_2se, true);
  assert.equal(p1.vs_single.full.value, 0.018);
  assert.equal(p1.vs_single.full.se, 0.005);
  assert.equal(p3.full.clears_2se, false);
  assert.equal(p4.vs_single, null, 'the best single offer is not compared with itself');
  assert.equal(p2.steps.length, 3);
});

test('view: a claim the search does not price shows its chance as unknown, never 100%', () => {
  const claim = viewWith().chess_path.value.paths[0].steps[1];
  assert.equal(claim.p_yes.status, 'unknown');
  assert.equal('value' in claim.p_yes, false);
  assert.match(claim.p_yes.reason, /rival claims are not modelled/i);
  assert.equal(claim.fail_label, 'If the claim fails');
});

test('view: title odds after a step as a level only when the producer writes it', () => {
  const plain = viewWith().chess_path.value.paths[0].steps[0];
  assert.equal(plain.title_after.status, 'unknown');
  assert.match(plain.title_after.reason, /keeps the change against today, not the level/);
  const lv = viewWith(c => { c.paths[0].steps[0].title_after = 0.142; }).chess_path.value.paths[0].steps[0];
  assert.equal(lv.title_after.value, 0.142);
});

test('view: each step names the backup branch when it fails', () => {
  const [s1, s2, s3] = viewWith().chess_path.value.paths[0].steps;
  // Step 1 fails: nothing done yet, so you keep today's odds; backup = best path with a different first move.
  assert.equal(s1.if_fails.keep_text, 'You keep today\'s roster and odds.');
  assert.equal(s1.if_fails.keep.status, 'unknown');
  assert.equal(s1.if_fails.backup.status, 'ok');
  assert.equal(s1.if_fails.backup.value.line, 'Team 5: give A. Brandt (WR) for K. Bell (RB)');
  assert.equal(s1.if_fails.backup.value.path_rank, 4);
  assert.equal(s1.if_fails.backup.value.p_yes.value, 0.41);
  assert.equal(s1.if_fails.backup.value.change_after.value, 0.009);
  // Step 2 fails: you keep step 1's odds change; backup shares step 1 and differs at step 2.
  assert.equal(s2.if_fails.keep_text, 'You keep step 1.');
  assert.equal(s2.if_fails.keep.value, 0.012);
  assert.equal(s2.if_fails.backup.value.line, 'Team 9: give T. Kline (TE) for E. Park (RB)');
  assert.equal(s2.if_fails.backup.value.path_rank, 3);
  // Step 3 fails: keep steps 1-2; backup = path 2's third move (same first two moves).
  assert.equal(s3.if_fails.keep_text, 'You keep steps 1-2.');
  assert.equal(s3.if_fails.keep.value, 0.019);
  assert.equal(s3.if_fails.backup.value.line, 'Team 4: give I. Rourke (WR) for W. Tran (WR)');
  assert.equal(s3.if_fails.backup.value.path_rank, 2);
  assert.equal(s3.fail_label, 'If he says no');
});

test('view: a backup must share the steps before it, even when a different path ranks higher', () => {
  const s2 = viewWith(c => {
    // Ranked 2nd, different first move (Team 5), and a different second move: not a branch of path 1's step 2.
    c.paths.splice(1, 0, { ...structuredClone(c.paths[2]), steps: [structuredClone(c.paths[3].steps[0]), structuredClone(c.paths[2].steps[1])] });
    c.paths[1].steps[1].partner_id = 8;
  }).chess_path.value.paths[0].steps[1];
  assert.equal(s2.if_fails.backup.value.line, 'Team 9: give T. Kline (TE) for E. Park (RB)');
  assert.equal(s2.if_fails.backup.value.path_rank, 4);
});

test('view: a failed league run or a failed sanity check hides the chess path too', () => {
  for (const mutate of [e => { e.error = 'world build failed'; }, e => { e.sanity_composed_equals_direct = false; }]) {
    const entries = structuredClone(plans);
    entries[0].chess = structuredClone(chess);
    mutate(entries[0]);
    const f = buildWarRoomView(1, { status: 'ok', entries, as_of: 'x', id: 'y' }, { enabled: true, preview: false }).chess_path;
    assert.equal(f.status, 'failed');
    assert.equal(values(f), 0);
  }
});

test('view: a step no other searched path branches from says so', () => {
  const only = viewWith(c => { c.paths = [c.paths[0]]; }).chess_path.value.paths[0].steps;
  for (const s of only) {
    assert.equal(s.if_fails.backup.status, 'unknown');
    assert.match(s.if_fails.backup.reason, /No backup searched/);
  }
});

test('view: failed search hidden with its reason and no digits; no search is unknown; empty search is unknown', () => {
  const failed = viewWith(() => ({ status: 'failed', error: 'season sim unavailable', paths: [] })).chess_path;
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason, /season sim unavailable/);
  assert.equal(values(failed), 0);
  const entries = structuredClone(plans);
  const none = buildWarRoomView(1, { status: 'ok', entries, as_of: 'x', id: 'y' }, { enabled: true, preview: false }).chess_path;
  assert.equal(none.status, 'unknown');
  assert.match(none.reason, /CHESS-01a/);
  const empty = viewWith(c => { c.paths = []; }).chess_path;
  assert.equal(empty.status, 'unknown');
  assert.match(empty.reason, /no path/i);
  const noLeague = buildWarRoomView(9, { status: 'ok', entries, as_of: 'x', id: 'y' }, { enabled: true, preview: false }).chess_path;
  assert.equal(noLeague.status, 'unknown');
});

test('view: preview marks every chess field and prefixes its sentences', () => {
  const f = viewWith(undefined, { preview: true }).chess_path;
  assert.equal(f.preview, true);
  assert.equal(f.value.paths[0].steps[0].p_yes.preview, true);
  assert.match(f.value.paths[0].steps[1].p_yes.reason, /^Preview/);
});

test('stepper: every step, P(yes) per step, odds after each step, and the backup branch', async () => {
  const { default: ChessPath } = await wr.mod('ChessPath');
  const html = renderToStaticMarkup(React.createElement(ChessPath, { field: viewWith().chess_path, big: true }));
  const text = textOf(html);
  for (const s of ['Path 1 of 4', 'Trade', 'Claim', 'Flip', 'Team 7: give M. Oduya (WR) for C. Ruiz (RB)',
    '38%', '31%', '+1.2 pts', '+1.9 pts', '+2.7 pts', 'If he says no', 'If the claim fails', 'Backup',
    'Team 4: give I. Rourke (WR) for W. Tran (WR)', 'You keep steps 1-2.', 'P(all land)', '12%', 'not modelled (rival claims)']) {
    assert.ok(text.includes(s), s);
  }
  assert.equal((html.match(/data-step=/g) ?? []).length, 3, 'three steps drawn');
  assert.doesNotMatch(text, /NaN|undefined|100%/);
});

test('stepper: compact panel shows the backup for the selected step only', async () => {
  const { default: ChessPath } = await wr.mod('ChessPath');
  const html = renderToStaticMarkup(React.createElement(ChessPath, { field: viewWith().chess_path, big: false }));
  assert.equal((html.match(/data-branch=/g) ?? []).length, 1);
  assert.ok(textOf(html).includes('Team 5: give A. Brandt (WR) for K. Bell (RB)'), 'step 1 is selected first');
});

test('stepper: failed and unknown render their designed states with no digits', async () => {
  const { default: ChessPath } = await wr.mod('ChessPath');
  const failed = viewWith(() => ({ status: 'failed', error: 'season sim unavailable', paths: [] })).chess_path;
  const t = textOf(renderToStaticMarkup(React.createElement(ChessPath, { field: failed, big: true })));
  assert.match(t, /failed its check/);
  assert.doesNotMatch(t, /\d+%|pts/);
  const u = textOf(renderToStaticMarkup(React.createElement(ChessPath, { field: undefined, big: false })));
  assert.match(u, /not computed yet/i);
});

test('grid + phone deck: the Chess path panel is one of the dashboard panels', async () => {
  const { default: WarRoom, PANELS, ROOT_STYLE } = await wr.mod('WarRoom');
  assert.ok(PANELS.some(p => p.id === 'path' && p.name === 'Chess path'));
  assert.ok(ROOT_STYLE.gridTemplateAreas.includes('path'));
  const html = renderToStaticMarkup(React.createElement(WarRoom, {
    view: viewWith(), leagues: [{ id: 1, name: 'League 1' }], activeId: 1, onLeague() {}, onExit() {},
  }));
  assert.match(html, /data-panel="path"[^>]*style="grid-area:path"/);
  assert.match(html, /<nav class="wr-dots"[^]*>Chess path</);
});
