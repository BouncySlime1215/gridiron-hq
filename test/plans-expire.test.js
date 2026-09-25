/**
 * PLANS-EXPIRE: a War Room plan more than 24 h old is served "plan out of date", not actionable.
 *
 * A --leagues 4 run keeps leagues 1, 2, 3, 5's previous entries (produce-plans.mjs#mergeKept).
 * The producer now stamps each entry it plans with `planned_at` (plan-age.js#stampPlannedAt),
 * kept entries carry theirs, and the view (war-room-view.js#buildWarRoomView) hides every
 * section of an entry older than PLAN_MAX_AGE_HOURS, or kept with no plan time, with the reason,
 * plus a `plan_out_of_date` block the UI draws. Files with no plan times at all (every committed
 * fixture, a file from before this unit) are served as before.
 *
 * Also: GRIDIRON_WARROOM_NIGHTLY_ALL=1 makes the refresh loop's first tick at or after 03:00
 * local each day plan every league, even when GRIDIRON_WARROOM_LEAGUES limits the others.
 *
 * Pre-registration: docs/tdd/2026-09-25-plans-expire.tdd.md. Made-up leagues only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadWarRoom, textOf } from './helpers/warroom-tsx.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-plans-expire-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const AGE = await import('../server/services/campaign/plan-age.js');
const { buildWarRoomView } = await import('../server/services/war-room-view.js');
const { validatePlans } = await import('../server/services/campaign/plans-schema.js');
const { mergeKept } = await import('../scripts/campaign/produce-plans.mjs');
const LOOP = await import('../scripts/refresh-live-data.mjs');

const wr = await loadWarRoom();
test.after(() => { wr.cleanup(); fs.rmSync(temp, { recursive: true, force: true }); });

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'warroom-contract', 'producer-plans.json'), 'utf8'));
const FLAG = { enabled: true, preview: false };
const H = 3_600_000;
const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const ON = {};
const OFF = { [AGE.PLANS_EXPIRE_ENV]: '0' };

/** A plans file (loadPlans's result) from the fixture's entries, with per-league plan times. */
function plansWith(times, { generated_at = iso(NOW) } = {}) {
  const entries = structuredClone(FIXTURE.leagues).map(e => {
    const k = String(e.league);
    if (k in times && times[k] !== undefined) e.planned_at = times[k];
    return e;
  });
  return { status: 'ok', entries, as_of: generated_at, id: 'plans@1' };
}
const view = (league, plans, env = ON, now = NOW) => buildWarRoomView(league, plans, FLAG, { now, env });
/** Every contract section with status ok (the actionable parts of a view). */
const okSections = v => Object.entries(v).filter(([, f]) => f && typeof f === 'object' && f.status === 'ok').map(([k]) => k);
const withoutPlannedAt = v => { const c = structuredClone(v); delete c.planned_at; return c; };

/* ------------------------------------------------------------------ the flag and the rule */

test('the flag: on by default; only an explicit 0 turns it off, with a loud warning', () => {
  assert.equal(AGE.PLANS_EXPIRE_ENV, 'GRIDIRON_PLANS_EXPIRE');
  assert.equal(AGE.plansExpireFlag({}), 'on');
  assert.equal(AGE.plansExpireFlag({ GRIDIRON_PLANS_EXPIRE: '1' }), 'on');
  assert.equal(AGE.plansExpireFlag({ GRIDIRON_PLANS_EXPIRE: 'yes' }), 'on');
  assert.equal(AGE.plansExpireFlag({ GRIDIRON_PLANS_EXPIRE: '0' }), 'off');
  assert.equal(AGE.plansExpireFlag({ GRIDIRON_PREVIEW_UNCONFIRMED: '1', GRIDIRON_PLANS_EXPIRE: '0' }), 'off', 'preview never decides it');
  assert.match(AGE.PLANS_EXPIRE_OFF_WARNING, /GRIDIRON_PLANS_EXPIRE=0/);
  assert.equal(AGE.PLAN_MAX_AGE_HOURS, 24);
});

test('stampPlannedAt: every entry without a plan time gets the run time; a stamp already there is kept; input untouched', () => {
  const file = { generated_at: iso(NOW), leagues: [{ league: 4 }, { league: 1, planned_at: iso(NOW - 30 * H) }] };
  const before = JSON.stringify(file);
  const out = AGE.stampPlannedAt(file);
  assert.equal(JSON.stringify(file), before, 'the input file is not mutated');
  assert.equal(out.leagues[0].planned_at, iso(NOW));
  assert.equal(out.leagues[1].planned_at, iso(NOW - 30 * H));
  assert.equal(out.generated_at, file.generated_at);
});

test('planAge: 24 h is the edge; kept with no time in a dated file is out of date; an undated file is not judged', () => {
  const entries = [{ league: 4, planned_at: iso(NOW) }, { league: 1 }];
  assert.equal(AGE.planAge({ planned_at: iso(NOW - 24 * H) }, { entries, now: NOW }).status, 'fresh');
  const old = AGE.planAge({ planned_at: iso(NOW - 24 * H - 60_000) }, { entries, now: NOW });
  assert.equal(old.status, 'out_of_date');
  assert.equal(old.age_hours, 24);
  assert.match(old.reason, /24 h/);
  const lost = AGE.planAge({ league: 1 }, { entries, now: NOW });
  assert.equal(lost.status, 'out_of_date');
  assert.equal(lost.planned_at, null);
  assert.equal(lost.age_hours, null);
  assert.match(lost.reason, /age is unknown/);
  assert.equal(AGE.planAge({ league: 1 }, { entries: [{ league: 1 }, { league: 4 }], now: NOW }).status, 'undated');
  assert.equal(AGE.planAge({ planned_at: 'not a date' }, { entries, now: NOW }).status, 'out_of_date', 'an unreadable time is not trusted');
  assert.equal(AGE.planAge({ planned_at: iso(NOW + 2 * H) }, { entries, now: NOW }).status, 'fresh', 'clock skew reads as fresh');
});

test('the contract takes an optional ISO planned_at on an entry, and rejects a bad one', () => {
  const doc = structuredClone(FIXTURE);
  doc.leagues[0].planned_at = iso(NOW);
  assert.equal(validatePlans(doc).ok, true, JSON.stringify(validatePlans(doc).errors?.slice(0, 2)));
  doc.leagues[0].planned_at = 'yesterday-ish';
  assert.equal(validatePlans(doc).ok, false);
});

/* ------------------------------------------------------------------ the view */

test('metric 1: an entry planned more than 24 h ago is served out of date, every section hidden, no digit leaks', () => {
  const plans = plansWith({ 4: iso(NOW), 1: iso(NOW - 30 * H) });
  const v = view(1, plans);
  assert.deepEqual(okSections(v), [], 'nothing actionable');
  assert.equal(v.next_move.status, 'unknown');
  assert.equal('value' in v.next_move, false);
  assert.match(v.next_move.reason, /out of date/);
  assert.deepEqual(v.plan_out_of_date, { planned_at: iso(NOW - 30 * H), age_hours: 30, max_hours: 24, reason: v.next_move.reason });
  assert.equal(v.planned_at, iso(NOW - 30 * H));
});

test('metric 1: a kept entry with no plan time in a dated file is out of date with its age unknown', () => {
  const v = view(2, plansWith({ 4: iso(NOW) }));
  assert.deepEqual(okSections(v), []);
  assert.equal(v.plan_out_of_date.planned_at, null);
  assert.equal(v.plan_out_of_date.age_hours, null);
  assert.match(v.plan_out_of_date.reason, /age is unknown/);
});

test('metric 2: a plan 24 h old or less is served exactly as before (bar the planned_at head key)', () => {
  for (const age of [0, 1, 23.5, 24]) {
    const t = iso(NOW - age * H);
    const v = view(4, plansWith({ 4: t, 1: t }));
    const legacy = view(4, plansWith({}), OFF);
    assert.equal(v.plan_out_of_date, undefined, `age ${age}`);
    assert.equal(v.planned_at, t);
    assert.deepEqual(withoutPlannedAt(v), legacy, `age ${age} h: the view is unchanged`);
  }
});

test('metric 2: a file with no plan times (every committed fixture) is served exactly as before, however old', () => {
  for (const lg of [1, 2, 3, 4, 5]) {
    const years = NOW + 400 * 24 * H;
    assert.deepEqual(view(lg, plansWith({}), ON, years), view(lg, plansWith({}), OFF, years), `league ${lg}`);
  }
});

test('metric 2: GRIDIRON_PLANS_EXPIRE=0 serves an old plan as before', () => {
  const plans = plansWith({ 4: iso(NOW), 1: iso(NOW - 30 * H) });
  const v = view(1, plans, OFF);
  assert.equal(v.plan_out_of_date, undefined);
  assert.deepEqual(withoutPlannedAt(v), view(1, plansWith({}), OFF));
});

test('a failed planner entry keeps its own failure reason (out of date never masks a failure)', () => {
  const plans = plansWith({ 4: iso(NOW), 1: iso(NOW - 30 * H) });
  plans.entries[0].error = 'world failed: made-up';
  const v = view(1, plans);
  assert.equal(v.next_move.status, 'failed');
  assert.match(v.next_move.reason, /planner run failed/);
});

test('end to end: a --leagues 4 run over a stamped previous file and a legacy one', () => {
  const ran = AGE.stampPlannedAt({ schema: FIXTURE.schema, generated_at: iso(NOW), producer: FIXTURE.producer,
    producer_version: FIXTURE.producer_version, leagues: structuredClone(FIXTURE.leagues.filter(e => e.league === 4)) });
  // A previous file stamped 30 h ago for 1, 2, 3, 5, and a legacy previous file with no stamps.
  const stamped = new Map(structuredClone(FIXTURE.leagues).map(e => [String(e.league), { ...e, planned_at: iso(NOW - 30 * H) }]));
  const legacy = new Map(structuredClone(FIXTURE.leagues).map(e => [String(e.league), e]));
  for (const previous of [stamped, legacy]) {
    const merged = mergeKept(ran, previous, { order: [1, 2, 3, 4, 5], ran: [4] });
    assert.equal(validatePlans(merged).ok, true);
    const plans = { status: 'ok', entries: merged.leagues, as_of: merged.generated_at, id: 'm' };
    assert.equal(view(4, plans).plan_out_of_date, undefined, 'the league that ran is fresh');
    assert.ok(okSections(view(4, plans)).includes('next_move'));
    for (const lg of [1, 2, 3, 5]) {
      const v = view(lg, plans);
      assert.ok(v.plan_out_of_date, `league ${lg} kept -> out of date`);
      assert.deepEqual(okSections(v), [], `league ${lg}: nothing actionable`);
    }
  }
});

/* ------------------------------------------------------------------ metric 3: the UI */

const LEAGUES = [1, 2, 3, 4, 5].map(id => ({ id, name: `League ${id}` }));
const { default: WarRoom } = await wr.mod('WarRoom');
const { default: WarRoomV2 } = await wr.mod('WarRoomV2');
const draw = (C, v) => textOf(renderToStaticMarkup(React.createElement(C, { view: v, leagues: LEAGUES, activeId: v.league_id,
  onLeague() {}, onExit() {} })));

test('metric 3: both layouts say "Plan out of date" with the reason, and offer no send action', () => {
  const stale = view(1, plansWith({ 4: iso(NOW), 1: iso(NOW - 30 * H) }));
  for (const [name, C] of [['classic', WarRoom], ['v2', WarRoomV2]]) {
    const text = draw(C, stale);
    assert.match(text, /Plan out of date/, name);
    assert.match(text, /last planned 30 h ago/, name);
    assert.doesNotMatch(text, /I sent it|Copy message/, name);
  }
});

test('metric 3: a fresh view shows no out-of-date notice', () => {
  const fresh = view(4, plansWith({ 4: iso(NOW) }));
  for (const C of [WarRoom, WarRoomV2]) assert.doesNotMatch(draw(C, fresh), /Plan out of date/);
});

/* ------------------------------------------------------------------ metric 4: nightly all-league replan */

const local = (h, m = 0, day = 25) => new Date(2026, 8, day, h, m, 0);
const BASE = ['--env-file-if-exists=.env', 'scripts/campaign/produce-plans.mjs'];

test('nightlyAllDue: only with its own flag, at or after 03:00 local, once per local day', () => {
  assert.equal(LOOP.WARROOM_NIGHTLY_ALL_ENV, 'GRIDIRON_WARROOM_NIGHTLY_ALL');
  const env = { GRIDIRON_WARROOM_NIGHTLY_ALL: '1' };
  assert.equal(LOOP.nightlyAllDue({ env: {}, now: local(3, 5), last: null }), false, 'unset: never');
  assert.equal(LOOP.nightlyAllDue({ env: { GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, now: local(3, 5), last: null }), false, 'preview never turns it on');
  assert.equal(LOOP.nightlyAllDue({ env, now: local(2, 59), last: null }), false, 'before 03:00');
  assert.equal(LOOP.nightlyAllDue({ env, now: local(3, 0), last: null }), true);
  assert.equal(LOOP.nightlyAllDue({ env, now: local(3, 15), last: '2026-09-24' }), true);
  assert.equal(LOOP.nightlyAllDue({ env, now: local(9, 0), last: '2026-09-25' }), false, 'already ran today');
  assert.equal(LOOP.nightlyAllDue({ env, now: local(2, 0, 26), last: '2026-09-25' }), false, 'next day, before 03:00');
});

function tickAt(now, envExtra, dir) {
  const files = { plans: path.join(dir, 'plans.json'), lock: path.join(dir, 'plans.json.lock'), log: path.join(dir, 'producer.log') };
  const env = { ...process.env, GRIDIRON_WARROOM_LEAGUES: '4', ...envExtra };
  if (!envExtra.GRIDIRON_WARROOM_NIGHTLY_ALL) delete env.GRIDIRON_WARROOM_NIGHTLY_ALL;
  const launched = [], lines = [];
  LOOP.warRoomPlans({ launch: (cmd, args) => { launched.push(args); return 9; }, log: l => lines.push(l), record() {},
    env, files, flag: () => FLAG, now: () => now });
  return { args: launched[0], line: lines.at(-1) };
}

test('metric 4: the first tick at or after 03:00 plans every league; every other tick keeps --leagues 4', () => {
  const dir = fs.mkdtempSync(path.join(temp, 'nightly-'));
  const on = { GRIDIRON_WARROOM_NIGHTLY_ALL: '1' };
  assert.deepEqual(tickAt(local(2, 45), on, dir).args, [...BASE, '--leagues', '4']);
  const night = tickAt(local(3, 2), on, dir);
  assert.deepEqual(night.args, BASE, 'every league');
  assert.match(night.line, /nightly all-league replan/);
  assert.deepEqual(tickAt(local(3, 17), on, dir).args, [...BASE, '--leagues', '4'], 'once a day');
  assert.deepEqual(tickAt(local(23, 50), on, dir).args, [...BASE, '--leagues', '4']);
  assert.deepEqual(tickAt(local(3, 1, 26), on, dir).args, BASE, 'the next night again');
});

test('metric 4: unset, the launch is byte-identical to before at any hour, and no marker is written', () => {
  const dir = fs.mkdtempSync(path.join(temp, 'unset-'));
  for (const h of [0, 3, 12]) assert.deepEqual(tickAt(local(h, 5), {}, dir).args, [...BASE, '--leagues', '4']);
  assert.equal(fs.existsSync(path.join(dir, 'nightly-all.json')), false);
});

test('metric 4: an unreadable marker is reported, and the night runs (never silently skipped)', () => {
  const dir = fs.mkdtempSync(path.join(temp, 'bad-'));
  fs.writeFileSync(path.join(dir, 'nightly-all.json'), '{not json');
  const r = tickAt(local(4, 0), { GRIDIRON_WARROOM_NIGHTLY_ALL: '1' }, dir);
  assert.deepEqual(r.args, BASE);
  assert.match(r.line, /nightly marker unreadable/);
});
