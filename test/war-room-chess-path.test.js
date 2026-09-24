/**
 * UI-ENG-5: the planner's chess path (trade -> claim -> flip, CHESS-01a) as a stepper
 * in the War Room, on FIX-04's contract (#287): the campaign producer writes a `chess`
 * section into each league entry (plans-schema.js), the view passes it through, and
 * ChessPath.tsx draws it. Nothing on the request thread computes a path.
 *
 * Producer (server/services/campaign/chess.js#chessSection, from titleChess() output):
 *  - paths in the search's order, each step with its kind, ids, P(yes) and the title-odds
 *    change after it, with `clears_2se` on every change (FIX-290-1);
 *  - one step per week from the current week; no trade or flip step after the trade
 *    deadline is written, the path is cut there and its totals are the kept steps' (FIX-290-1);
 *  - a claim priced `not_modelled` has an unknown chance, never 100%;
 *  - every step names its backup branch (same steps before it, a different move here) or
 *    says there is none; every path has a typed `argument` slot, unknown until its writer
 *    exists (FIX-290-1);
 *  - `replay_passed` is CHESS-01-b's pass flag (GRIDIRON_CHESS_REPLAY_PASSED), which
 *    preview mode does not set;
 *  - module not merged / flag off / not run / failed / empty are typed states, no digits.
 * Contract (FIX-290-2): `chess` is a contract section; buildPlansFile writes it for every
 * league and validatePlans stays empty.
 * Client (FIX-290-1): steps that do not clear 2 SE are greyed, the deadline week is shown,
 * the "path search is off" fallback shows until the pass flag is set, the argument slot
 * shows its reason while the steps still draw.
 * Grid (FIX-290-3): one grid with both `path` and `clones` areas, and `path` is a Coach
 * focus_panel id (#230).
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
const studyNames = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'war-room-plans.json'), 'utf8'))[0].names;
const CHESS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'war-room-chess.json'), 'utf8'));
const REAL = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'warroom-contract', 'producer-plans.json'), 'utf8'));
const { chessSection, chessReplayPassed, CHESS_REPLAY_ENV, CHESS_FALLBACK } = await import('../server/services/campaign/chess.js');
const { SECTIONS, validateLeague, validatePlans } = await import('../server/services/campaign/plans-schema.js');
const { buildWarRoomView } = await import('../server/services/war-room-view.js');
const { buildPlansFile } = await import('../scripts/campaign/produce-plans.mjs');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const actions = await import('../server/services/warroom-actions/schema.js');

const wr = await loadWarRoom();
test.after(() => wr.cleanup());

const ON = { state: 'on', block: CHESS };
/** The producer's section for the fixture search, week 10, deadline week 13 unless given. */
function section(input = ON, opts = {}) {
  return chessSection(structuredClone(input), { names: studyNames, week: 10, deadline_week: 13, replayPassed: true, ...opts });
}
/** The real producer entry (FIX-03 fixture league 1) carrying a chess section. */
function entryWith(sec) {
  const e = structuredClone(REAL.leagues[0]);
  e.names = { ...e.names, ...sec.names };
  e.chess = sec.field;
  return e;
}
function viewOf(entry, { preview = false } = {}) {
  return buildWarRoomView(entry.league, { status: 'ok', entries: [entry], as_of: '2026-09-24T00:00:00.000Z', id: 'plans@1' },
    { enabled: true, preview });
}
const values = node => JSON.stringify(node).match(/"value":/g)?.length ?? 0;

/* ------------------------------------------------------------ producer */

test('producer: paths in search order; each step has its kind, ids, P(yes) and change after it with clears_2se', () => {
  const f = section().field;
  assert.equal(f.status, 'ok');
  assert.equal(f.source, 'plan.path');
  const [p1, , p3, p4] = f.value.paths;
  assert.deepEqual(f.value.paths.map(p => p.rank), [1, 2, 3, 4]);
  assert.deepEqual(p1.steps.map(s => s.kind), ['trade', 'claim', 'flip']);
  assert.deepEqual(p1.steps.map(s => s.n), [1, 2, 3]);
  assert.deepEqual(p1.steps[0], { ...p1.steps[0], partner: '7', give: ['601'], get: ['502'] });
  assert.deepEqual([p1.steps[1].partner, p1.steps[1].give, p1.steps[1].get], [null, ['606'], ['703']]);
  assert.equal(p1.steps[0].p_yes.value, 0.38);
  assert.equal(p1.steps[0].p_yes.source, 'clone.accept');
  assert.deepEqual(p1.steps.map(s => s.change_after.value), [0.012, 0.019, 0.027]);
  assert.deepEqual(p1.steps.map(s => s.change_after.clears_2se), [true, true, true]);
  assert.equal(p1.steps[2].change_after.se, 0.006);
  assert.equal(p1.p_complete.value, 0.1178);
  assert.equal(p1.expected.value, 0.0133);
  assert.equal(p1.full.clears_2se, true);
  assert.equal(p1.vs_single.full.value, 0.018);
  assert.equal(p3.full.clears_2se, false);
  assert.equal(p4.vs_single, null, 'the best single offer is not compared with itself');
});

test('producer: a step whose change sits inside 2 SE says clears_2se false', () => {
  const f = section({ state: 'on', block: (c => { c.paths[0].steps[0].title_delta_after = 0.006; return c; })(structuredClone(CHESS)) }).field;
  const s = f.value.paths[0].steps[0].change_after;
  assert.equal(s.value, 0.006);
  assert.equal(s.clears_2se, false, '0.006 is inside 2 x 0.004');
});

test('producer: a claim the search does not price is unknown, never 100%; the odds level is unknown with its reason', () => {
  const claim = section().field.value.paths[0].steps[1];
  assert.equal(claim.p_yes.status, 'unknown');
  assert.equal('value' in claim.p_yes, false);
  assert.match(claim.p_yes.reason, /rival claims are not modelled/i);
  assert.equal(claim.title_after.status, 'unknown');
  assert.match(claim.title_after.reason, /change against today, not the level/);
});

test('producer: one step per week from now; nothing after the trade deadline, and the cut path carries its kept totals', () => {
  const f = section(ON, { week: 10, deadline_week: 11 }).field;
  assert.equal(f.value.deadline_week, 11);
  assert.equal(f.value.week, 10);
  const p1 = f.value.paths[0];
  assert.deepEqual(p1.steps.map(s => s.week), [10, 11], 'the week-12 flip is past the deadline');
  assert.equal(p1.cut_at_deadline, 1);
  assert.equal(p1.full.value, 0.019, 'the last kept step');
  assert.equal(p1.p_complete.value, 0.38, 'trade 0.38 x claim assumed to clear');
  assert.equal(p1.expected.value, +(0.38 * 0.012 + 0.38 * 0.007).toFixed(4));
  assert.equal(p1.vs_single, null, 'the paired comparison was for the whole path');
  for (const p of f.value.paths) for (const s of p.steps) assert.ok(s.kind === 'claim' || s.week <= 11, `${p.rank}.${s.n}`);
  // A deadline already passed: no trade path survives.
  const gone = section(ON, { week: 12, deadline_week: 11 }).field;
  assert.equal(gone.status, 'unknown');
  assert.match(gone.reason, /trade deadline/);
  // An unknown deadline drops nothing and says so.
  const open = section(ON, { deadline_week: null }).field;
  assert.equal(open.value.deadline_week, null);
  assert.equal(open.value.paths[0].steps.length, 3);
});

test('producer: each step names its backup branch, or says none was searched', () => {
  const [s1, s2, s3] = section().field.value.paths[0].steps;
  assert.equal(s1.backup.status, 'ok');
  assert.deepEqual([s1.backup.value.path_rank, s1.backup.value.partner, s1.backup.value.give, s1.backup.value.get], [4, '5', ['602'], ['501']]);
  assert.equal(s1.backup.value.p_yes.value, 0.41);
  assert.equal(s2.backup.value.path_rank, 3);
  assert.equal(s3.backup.value.path_rank, 2);
  assert.equal(s3.backup.value.change_after.value, 0.021);
  const only = section({ state: 'on', block: { ...structuredClone(CHESS), paths: [structuredClone(CHESS.paths[0])] } }).field.value.paths[0].steps;
  for (const s of only) {
    assert.equal(s.backup.status, 'unknown');
    assert.match(s.backup.reason, /No backup searched/);
  }
});

test('producer: every path has a typed argument slot, unknown with its reason until the writer exists', () => {
  for (const p of section().field.value.paths) {
    assert.equal(p.argument.status, 'unknown');
    assert.match(p.argument.reason, /JEV-01c/);
    assert.equal('value' in p.argument, false);
  }
});

test('producer: not merged, flag off, not run, failed and empty are typed states with no digits', () => {
  const absent = section({ state: 'absent' }).field;
  assert.equal(absent.status, 'unknown');
  assert.match(absent.reason, /#258/);
  const off = section({ state: 'off', reason: 'Title-odds chess (CHESS-01a) is default-off.' }).field;
  assert.equal(off.status, 'unknown');
  assert.match(off.reason, /default-off/);
  const notRun = chessSection(null, { names: {}, week: 10, deadline_week: 13, replayPassed: false }).field;
  assert.equal(notRun.status, 'unknown');
  const failed = section({ state: 'on', block: { status: 'failed', error: 'season sim unavailable', paths: [] } }).field;
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason, /season sim unavailable/);
  const empty = section({ state: 'on', block: { ...structuredClone(CHESS), paths: [] } }).field;
  assert.equal(empty.status, 'unknown');
  assert.match(empty.reason, /no path/i);
  for (const f of [absent, off, notRun, failed, empty]) assert.equal(values(f), 0);
});

test('producer: replay_passed is CHESS-01-b\'s pass flag, and preview mode does not set it', () => {
  assert.equal(section(ON, { replayPassed: false }).field.value.replay_passed, false);
  assert.equal(section(ON, { replayPassed: true }).field.value.replay_passed, true);
  assert.equal(chessReplayPassed({}), false);
  assert.equal(chessReplayPassed({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), false, 'preview is not a replay result');
  assert.equal(chessReplayPassed({ [CHESS_REPLAY_ENV]: '1' }), true);
});

test('producer: step players missing from the league names are added with the search\'s own names', () => {
  const block = structuredClone(CHESS);
  block.paths[0].steps[0].get_names = ['C. Ruiz (RB)'];
  const out = chessSection({ state: 'on', block }, { names: {}, week: 10, deadline_week: 13, replayPassed: true });
  assert.equal(out.names['502'], 'C. Ruiz (RB)');
  assert.equal(out.names['601'], 'Player 601', 'no name anywhere: the id label the client would print');
});

/* ------------------------------------------------------------ contract */

test('contract: chess is a section; an entry carrying it validates with no errors', () => {
  assert.ok('chess' in SECTIONS);
  const e = entryWith(section());
  assert.deepEqual(validateLeague(e).errors, []);
  const bad = structuredClone(e);
  bad.chess.value.paths[0].steps[0].change_after.clears_2se = 'yes';
  assert.ok(validateLeague(bad).errors.some(x => /clears_2se/.test(x.message)));
});

test('contract: buildPlansFile writes chess into every league entry, and validatePlans stays empty', async () => {
  const leagues = [1, 3].map(id => ({ id, load: async () => {
    const adapter = makeAdapter();
    adapter.league = { ...adapter.league, id };
    return { adapter };
  } }));
  const chess = { replayPassed: false, forLeague: async id => (id === 1 ? ON : { state: 'off', reason: 'Title-odds chess is default-off.' }) };
  const file = await buildPlansFile(leagues, { generated_at: '2026-09-24T06:00:00.000Z', chess });
  assert.deepEqual(validatePlans(file).errors, []);
  const [l1, l3] = file.leagues;
  assert.equal(l1.chess.status, 'ok');
  assert.equal(l1.chess.value.replay_passed, false);
  assert.equal(l3.chess.status, 'unknown');
  const none = await buildPlansFile(leagues.slice(0, 1), { generated_at: '2026-09-24T06:00:00.000Z' });
  assert.equal(none.leagues[0].chess.status, 'unknown', 'no chess loader: written as not run');
  assert.deepEqual(validatePlans(none).errors, []);
});

/* ------------------------------------------------------------ view */

test('view: the chess section is served as the producer wrote it; a failed run hides it', () => {
  const e = entryWith(section());
  const v = viewOf(e);
  assert.equal(v.chess.status, 'ok');
  assert.deepEqual(v.chess.value.paths[0].steps.map(s => s.change_after.value), [0.012, 0.019, 0.027]);
  for (const mutate of [x => { x.error = 'world build failed'; }, x => { x.sanity_composed_equals_direct = false; }]) {
    const bad = structuredClone(e);
    mutate(bad);
    const f = viewOf(bad).chess;
    assert.equal(f.status, 'failed');
    assert.equal(values(f), 0);
  }
  const old = structuredClone(REAL.leagues[0]);
  delete old.chess;
  assert.equal(viewOf(old).chess.status, 'unknown', 'an older plans file without the section');
});

/* ------------------------------------------------------------ client */

async function render(field, big = true, names = { ...REAL.leagues[0].names, ...section().names }) {
  const { default: ChessPath } = await wr.mod('ChessPath');
  return renderToStaticMarkup(React.createElement(ChessPath, { field, names, big }));
}

test('stepper: every step, P(yes), odds after each step, deadline week and the backup', async () => {
  const html = await render(section().field);
  const text = textOf(html);
  for (const s of ['Path 1 of 4', 'Trade', 'Claim', 'Flip', 'Team 7: give M. Oduya (WR) for C. Ruiz (RB)',
    'Claim S. Achebe (RB), drop Y. Banks (TE)', '38%', '31%', '+1.2 pts', '+1.9 pts', '+2.7 pts', 'If he says no',
    'If the claim fails', 'Backup', 'You keep steps 1-2.', 'P(all land)', 'not modelled (rival claims)',
    'Trade deadline: week 13', 'Week 10']) {
    assert.ok(text.includes(s), s);
  }
  assert.equal((html.match(/data-step=/g) ?? []).length, 3);
  assert.doesNotMatch(text, /NaN|undefined|100%/);
});

test('stepper: a step that does not clear 2 SE is greyed; one that does is not', async () => {
  const f = section({ state: 'on', block: (c => { c.paths[0].steps[0].title_delta_after = 0.006; return c; })(structuredClone(CHESS)) }).field;
  const html = await render(f);
  assert.match(html, /data-step="1"[^>]*class="[^"]*wr-grey/);
  assert.doesNotMatch(html, /data-step="2"[^>]*class="[^"]*wr-grey/);
  assert.match(textOf(html), /inside the noise/);
});

test('stepper: steps after the deadline are not drawn and the cut is said', async () => {
  const html = await render(section(ON, { week: 10, deadline_week: 11 }).field);
  assert.equal((html.match(/data-step=/g) ?? []).length, 2);
  assert.match(textOf(html), /1 step after the trade deadline dropped/);
  const open = textOf(await render(section(ON, { deadline_week: null }).field));
  assert.match(open, /Trade deadline: unknown/);
});

test('stepper: until CHESS-01-b passes, the fallback reads "path search is off", not a path', async () => {
  const html = await render(section(ON, { replayPassed: false }).field);
  const t = textOf(html);
  assert.ok(t.includes(CHESS_FALLBACK), t);
  assert.match(CHESS_FALLBACK, /^Path search is off: it has not beaten single trades in the replay test yet/);
  assert.equal((html.match(/data-step=/g) ?? []).length, 0);
  assert.doesNotMatch(t, /\d+%|pts/);
});

test('stepper: the argument slot shows its reason while the steps still draw', async () => {
  const html = await render(section().field);
  assert.match(textOf(html), /Argument: .*JEV-01c/);
  assert.equal((html.match(/data-step=/g) ?? []).length, 3);
});

test('stepper: compact panel shows the backup for the selected step only', async () => {
  const html = await render(section().field, false);
  assert.equal((html.match(/data-branch=/g) ?? []).length, 1);
});

test('stepper: failed and unknown render their designed states with no digits', async () => {
  const t = textOf(await render(section({ state: 'on', block: { status: 'failed', error: 'season sim unavailable', paths: [] } }).field));
  assert.match(t, /failed its check/);
  assert.doesNotMatch(t, /\d+%|pts/);
  assert.match(textOf(await render(undefined, false)), /not computed yet/i);
});

/* ------------------------------------------------------------ grid + coach */

test('grid + phone deck: one grid with both path and clones areas; Chess path is a panel and a Coach focus_panel id', async () => {
  const { default: WarRoom, PANELS, ROOT_STYLE, COACH_PANEL_AREA } = await wr.mod('WarRoom');
  assert.ok(PANELS.some(p => p.id === 'path' && p.name === 'Chess path'));
  for (const a of ['path', 'clones']) assert.ok(ROOT_STYLE.gridTemplateAreas.includes(`${a} `) || ROOT_STYLE.gridTemplateAreas.includes(` ${a}`), a);
  assert.equal(COACH_PANEL_AREA.path, 'path');
  assert.ok(actions.PANELS.includes('path'), 'server focus_panel ids (#230)');
  const coach = await wr.mod('coach/warroomCoach');
  assert.ok(coach.PANELS.includes('path'), 'client focus_panel ids (#230)');
  const html = renderToStaticMarkup(React.createElement(WarRoom, {
    view: viewOf(entryWith(section())), leagues: [{ id: 1, name: 'League 1' }], activeId: 1, onLeague() {}, onExit() {},
  }));
  assert.match(html, /data-panel="path"[^>]*style="grid-area:path"/);
  assert.match(html, /<nav class="wr-dots"[^]*>Chess path</);
});
