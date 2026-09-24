/**
 * WR-L4: the War Room opens on the target league (leagues.id 4), the league rail lists
 * it first and folds the other leagues under "training leagues", and the top strip
 * (destination, ETA vs plan, title odds now -> planned, risk mode, brain dot,
 * number-health dot) shows every field the producer computed: zero "not computed yet"
 * where the plans file has the field ok.
 *
 * WR_L4_SERVED_VIEW=<file> also renders a SERVED view (the JSON body of
 * GET /api/trades/4/war-room from a running server) and prints the metric line
 * `WR-L4 served: opens_on=<id> wrongly_not_computed=<n> of <m>`.
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
const producer = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'warroom-contract', 'ui-contract-plans.json'), 'utf8'));
const { buildWarRoomView } = await import('../server/services/war-room-view.js');

const wr = await loadWarRoom();
test.after(() => wr.cleanup());
const { default: WarRoom } = await wr.mod('WarRoom');
const { openingLeague, railOrder, TARGET_LEAGUE_ID } = await wr.mod('LeagueRail');

const LEAGUES = [1, 2, 3, 4, 5].map(id => ({ id, name: `League ${id}` }));
const NOT_COMPUTED = 'not computed yet';

/** The fixture's first entry, moved to league 4, with a computed number audit. */
function plansFor4() {
  const entry = structuredClone(producer.leagues[0]);
  entry.league = 4;
  entry.number_health = {
    status: 'ok', source: 'audit.numbers',
    value: { overall: 'warn', broken: 0, warn: 1, ok: 3, checks: [
      { check_id: 'a', status: 'ok', title: 'A' }, { check_id: 'b', status: 'warn', title: 'B', detail: 'b is off' }] }
  };
  return { status: 'ok', entries: [entry], as_of: producer.generated_at, id: 'wr-l4' };
}

const render = (view, activeId) => renderToStaticMarkup(React.createElement(WarRoom, {
  view, leagues: LEAGUES, activeId, onLeague() {}, onExit() {}
}));

/** Top-strip facts by label -> their markup. */
function facts(html) {
  const top = html.slice(html.indexOf('<header class="wr-top"'), html.indexOf('</header>'));
  const out = {};
  for (const chunk of top.split(/<div class="wr-fact"[^>]*>/).slice(1)) {
    const label = chunk.match(/<span class="wr-l">([^<]+)<\/span>/)?.[1];
    if (label) out[label] = chunk;
  }
  return out;
}

/**
 * The metric: top-strip fields the view has ok (so the plans file had them ok: the view
 * passes sections through) but the strip shows as not computed. Returns { wrong, of, list }.
 */
export function wronglyNotComputed(view, html) {
  const f = facts(html);
  const d = view.destination?.status === 'ok' ? view.destination.value : null;
  const ok = x => x?.status === 'ok' && x.value !== undefined;
  const checks = [
    ['goal', ok(d?.goal), () => !f.Destination?.includes(NOT_COMPUTED)],
    ['eta_week', ok(d?.eta_week), () => !f['ETA vs plan']?.split('wr-muted')[0].includes(NOT_COMPUTED)],
    ['arrive_by', ok(d?.arrive_by), () => /plan wk/.test(f['ETA vs plan'] ?? '')],
    ['title_now', ok(d?.title_now), () => !(f['Title odds'] ?? '').split('wr-muted')[0].includes(NOT_COMPUTED)],
    ['title_planned_now', ok(d?.title_planned_now), () => / plan /.test(textOf(f['Title odds'] ?? ''))],
    ['risk_mode', ok(d?.risk_mode), () => !f['Risk mode']?.includes(NOT_COMPUTED)],
    ['brain_report', ok(view.brain_report), () => (f.Checks ?? '').match(/data-brain="(\w+)"/)?.[1] === view.brain_report.value.overall],
    ['number_health', ok(view.number_health), () => !/data-health="grey"/.test(f.Checks ?? '')]
  ];
  const list = checks.filter(([, isOk, shown]) => isOk && !shown()).map(([k]) => k);
  return { wrong: list.length, of: checks.filter(([, isOk]) => isOk).length, list };
}

test('the target league is leagues.id 4', () => {
  assert.equal(TARGET_LEAGUE_ID, 4);
});

test('the War Room opens on the target league once per page load, then Nick\'s pick stands', () => {
  assert.equal(openingLeague(LEAGUES, 1, 4, false), 4, 'opens on league 4 from the app default (league 1)');
  assert.equal(openingLeague(LEAGUES, null, 4, false), 4);
  assert.equal(openingLeague(LEAGUES, 4, 4, false), null, 'already there');
  assert.equal(openingLeague(LEAGUES, 2, 4, true), null, 'after the first open, a pick stands');
  assert.equal(openingLeague(LEAGUES.filter(l => l.id !== 4), 1, 4, false), null, 'target not connected: stay');
  assert.equal(openingLeague(LEAGUES, 1, null, false), null, 'no target served: stay');
});

test('the league rail shows the target first and folds the other 4 under training leagues', () => {
  const { target, training } = railOrder(LEAGUES, 4);
  assert.equal(target.id, 4);
  assert.deepEqual(training.map(l => l.id), [1, 2, 3, 5]);

  const view = buildWarRoomView(4, plansFor4(), { enabled: true, preview: false });
  const html = render(view, 4);
  const ids = [...html.matchAll(/data-league="(\d+)"/g)].map(m => Number(m[1]));
  assert.equal(ids[0], 4, 'target league first');
  assert.match(html, /data-league="4" data-target="true"/);
  const fold = html.slice(html.indexOf('data-testid="training-leagues"'));
  assert.ok(fold.length < html.length, 'the training fold exists');
  assert.match(textOf(fold.slice(0, fold.indexOf('</details>'))), /training leagues 4 more/);
  assert.deepEqual([...fold.slice(0, fold.indexOf('</details>')).matchAll(/data-league="(\d+)"/g)].map(m => Number(m[1])), [1, 2, 3, 5]);
  assert.doesNotMatch(html.match(/<details[^>]*>/)[0], /open/, 'folded while the target is open');
  assert.match(html.match(/<button[^>]*data-league="4"[^>]*>/)[0], /aria-selected="true"/);

  // A training league on screen opens the fold.
  const html2 = render(buildWarRoomView(2, plansFor4(), { enabled: true, preview: false }), 2);
  assert.match(html2.match(/<details[^>]*>/)[0], /open/);
});

test('no target connected: the rail is the flat list it was', () => {
  const view = buildWarRoomView(1, plansFor4(), { enabled: true, preview: false });
  const html = renderToStaticMarkup(React.createElement(WarRoom, {
    view, leagues: [{ id: 1, name: 'League 1' }, { id: 2, name: 'League 2' }], activeId: 1, onLeague() {}, onExit() {}
  }));
  assert.doesNotMatch(html, /training leagues/);
  assert.deepEqual([...html.matchAll(/data-league="(\d+)"/g)].map(m => Number(m[1])), [1, 2]);
});

test('top strip: 0 fields show "not computed yet" when the plans file has them ok', () => {
  const view = buildWarRoomView(4, plansFor4(), { enabled: true, preview: false });
  assert.equal(view.number_health.value.overall, 'warn', 'the contract writes overall, not status');
  const html = render(view, 4);
  const m = wronglyNotComputed(view, html);
  assert.ok(m.of >= 7, `the fixture computes most strip fields (${m.of})`);
  assert.deepEqual(m.list, [], `wrongly not computed: ${m.list.join(', ')}`);
  assert.match(facts(html).Checks, /data-health="amber"/);
});

test('a failed destination says failed in the strip, not "not computed"', () => {
  const plans = plansFor4();
  plans.entries[0].destination = { status: 'failed', source: 'campaign.plan', reason: 'x broke' };
  const view = buildWarRoomView(4, plans, { enabled: true, preview: false });
  const f = facts(render(view, 4));
  assert.match(f.Destination, /hidden: failed its check/);
  assert.match(f['Risk mode'], /hidden: failed its check/);
});

test('served view (WR_L4_SERVED_VIEW): opens on the target, strip filled', { skip: !process.env.WR_L4_SERVED_VIEW }, () => {
  const view = JSON.parse(fs.readFileSync(process.env.WR_L4_SERVED_VIEW, 'utf8'));
  const opensOn = openingLeague(LEAGUES, 1, TARGET_LEAGUE_ID, false) ?? 1;
  const m = wronglyNotComputed(view, render(view, view.league_id));
  const nm = noMove(view, render(view, view.league_id));
  console.log(`WR-L4 served: opens_on=${opensOn} wrongly_not_computed=${m.wrong} of ${m.of} ok fields [${m.list.join(',')}] next_move=${view.next_move?.status} no_move_reason_rendered=${nm.reasonShown}`);
  assert.equal(opensOn, 4);
  assert.equal(m.wrong, 0);
  if (view.next_move?.status === 'unknown' && view.destination?.status === 'ok') assert.ok(nm.reasonShown, 'no-move reason renders');
});

/** Whether the strip says "No move clears this week" and shows next_move's reason. */
function noMove(view, html) {
  const top = html.slice(html.indexOf('<header class="wr-top"'), html.indexOf('</header>'));
  const said = top.includes('No move clears this week');
  const reason = view.next_move?.reason;
  const reasonShown = said && !!reason && textOf(top).includes(reason);
  return { said, reasonShown };
}

/** plansFor4 with the producer's "searched, nothing clears" next move (as the live league-4 entry has it). */
function plansNoMove() {
  const plans = plansFor4();
  plans.entries[0].next_move = { status: 'unknown', source: 'plan.path',
    reason: 'None of the 116 paths searched clears the sliders and the fresh-dice check this week. Try another target or risk mode.' };
  return plans;
}

test('next_move unknown: the strip says "No move clears this week" with the reason', () => {
  const view = buildWarRoomView(4, plansNoMove(), { enabled: true, preview: false });
  assert.equal(view.next_move.status, 'unknown');
  const html = render(view, 4);
  const nm = noMove(view, html);
  assert.ok(nm.said, 'says no move clears');
  assert.ok(nm.reasonShown, 'shows the reason');
  assert.deepEqual(wronglyNotComputed(view, html).list, []);
});

test('a computed next move, or no plan at all, adds no no-move fact', () => {
  const ok = buildWarRoomView(4, plansFor4(), { enabled: true, preview: false });
  if (ok.next_move?.status === 'ok') assert.equal(noMove(ok, render(ok, 4)).said, false);
  const none = buildWarRoomView(4, { status: 'ok', entries: [], as_of: 'x', id: 'x' }, { enabled: true, preview: false });
  assert.equal(noMove(none, render(none, 4)).said, false, 'no plan run: not "no move clears"');
});

test('next_move failed: the strip says hidden, not "no move clears"', () => {
  const plans = plansFor4();
  plans.entries[0].next_move = { status: 'failed', source: 'plan.path', reason: 'x broke' };
  const view = buildWarRoomView(4, plans, { enabled: true, preview: false });
  const f = facts(render(view, 4));
  assert.match(f['This week'] ?? '', /failed its check/);
  assert.doesNotMatch(f['This week'] ?? '', /No move clears/);
});

test('live plans file (WR_L4_PLANS): the league-4 entry renders the strip filled', { skip: !process.env.WR_L4_PLANS }, () => {
  const raw = JSON.parse(fs.readFileSync(process.env.WR_L4_PLANS, 'utf8'));
  const plans = { status: 'ok', entries: raw.leagues, as_of: raw.generated_at, id: 'live' };
  const view = buildWarRoomView(4, plans, { enabled: true, preview: false });
  const html = render(view, 4);
  const m = wronglyNotComputed(view, html);
  const nm = noMove(view, html);
  console.log(`WR-L4 live-plans: wrongly_not_computed=${m.wrong} of ${m.of} [${m.list.join(',')}] next_move=${view.next_move?.status} no_move_reason_rendered=${nm.reasonShown}`);
  assert.equal(m.wrong, 0);
  if (view.next_move?.status === 'unknown') assert.ok(nm.reasonShown);
});
