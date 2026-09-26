/**
 * DAILY DIGEST (Batch D item 34): server/services/campaign/daily-digest.js and its runner
 * scripts/campaign/daily-digest.mjs. Pre-registered bar B1-B8 (PR body):
 *   B1 quiet: nothing changed and no replies -> no digest, nothing appended to the outbox.
 *   B2 changes: next move, goal status, and a title-odds move beyond max(1 pt, 2 SE) are listed;
 *      a move inside the noise is not.
 *   B3 replies: answers to Nick's own offers in the window, by roster id; nobody else's; none twice.
 *   B4 schedule: only inside 9 AM Eastern (EDT and EST), once per Eastern day.
 *   B5 rules: a next move that fails the ONE rule gate (160 / 80, 277 without OK, a final get below
 *      83, no gate, a gate that throws, no edge) is never written out; the text names none of it.
 *   B6 privacy: team and manager names in plans.json never appear; partners are "Team N".
 *   B7 flag: off -> nothing read or written; dry run writes nothing; --apply writes row + state.
 *   B8 served fields only: a change to `_run` alone produces no digest.
 * Fixture plans only; no database, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  buildDigest, changesOf, digestWindow, moveVerdict, repliesOf, snapshotOf,
} from '../server/services/campaign/daily-digest.js';
import { ruleVerdict, PINNED_NEVER_GIVE, PINNED_NEVER_GET } from '../server/services/campaign/never-give.js';
import { runDigest } from '../scripts/campaign/daily-digest.mjs';

const require = createRequire(import.meta.url);
const FIXTURE = require('./fixtures/warroom-contract/producer-plans.json');
const clone = x => JSON.parse(JSON.stringify(x));

const AT_9_EDT = new Date('2026-09-27T13:05:00Z');   // Sun 9:05 AM EDT
const NEXT_9_EDT = new Date('2026-09-28T13:10:00Z');
const AT_8_EDT = new Date('2026-09-27T12:59:00Z');   // 8:59 AM EDT
const AT_10_EDT = new Date('2026-09-27T14:00:00Z');  // 10:00 AM EDT
const AT_9_EST = new Date('2026-12-01T14:05:00Z');   // 9:05 AM EST
const AT_8_EST = new Date('2026-12-01T13:05:00Z');   // 8:05 AM EST

/** League 1 of the contract fixture: a one-step move, Team 3 gets P4 + P7 for P22. With a secret team name. */
function plans({ title = 0.43, se = 0.003, next = null, goal = 'out_of_reach', run = null } = {}) {
  const e = clone(FIXTURE.leagues.find(x => x.league === 1));
  e.destination.value.title_now = { status: 'ok', value: title, source: 'sim.title', unit: 'title_odds', se };
  if (next) e.next_move.value.move_id = next;
  e.feasibility_points.value.outlook = goal;
  e.teams = { status: 'ok', value: { 3: { name: 'Zorblat Secret Squad', manager: 'Quennimore Vex' } }, source: 'league' };
  if (run) e._run = { ...(e._run ?? {}), ...run };
  return { ...clone({ ...FIXTURE, leagues: [] }), leagues: [e] };
}

/** A gate built on the real ruleVerdict (Nick's pinned ids): gets 22 / 50 / 290 worth 200, the rest 100; every player scored 90. */
function gate({ score = () => 90, confirmed = [] } = {}) {
  const rules = {
    neverGive: new Set(PINNED_NEVER_GIVE), neverGet: new Set(PINNED_NEVER_GET), sold: new Set(), closed: null,
    fc: { has: () => true, get: id => (['22', '50', '290'].includes(id) ? 200 : 100) }, scoreOf: score, ajAllow: new Set(['22']),
  };
  return { applies: true, check: t => ruleVerdict(rules, t), aj: { confirmed: new Set(confirmed) } };
}

const baseline = (p, now = AT_9_EDT) => buildDigest({ plans: p, now: new Date(now.getTime() - 86_400_000) }).state;

test('B4: the window is the 9 AM Eastern hour, in EDT and in EST', () => {
  assert.equal(digestWindow(AT_9_EDT).open, true);
  assert.equal(digestWindow(AT_8_EDT).open, false);
  assert.equal(digestWindow(AT_10_EDT).open, false);
  assert.equal(digestWindow(AT_9_EST).open, true);
  assert.equal(digestWindow(AT_8_EST).open, false);
  assert.equal(digestWindow(AT_9_EDT).day, '2026-09-27');
});

test('B4: outside the window nothing is built; a second check the same day is done_today', () => {
  const p = plans();
  const st = baseline(p);
  assert.equal(buildDigest({ plans: plans({ next: 'X' }), state: st, now: AT_8_EDT }).status, 'closed');
  const d = buildDigest({ plans: plans({ next: 'X' }), state: st, now: AT_9_EDT, gateFor: () => gate() });
  assert.equal(d.status, 'send');
  const again = buildDigest({ plans: plans({ next: 'Y' }), state: d.state, now: new Date(AT_9_EDT.getTime() + 30 * 60_000) });
  assert.equal(again.status, 'done_today');
  assert.equal(again.state, null);
});

test('first check records a baseline and sends nothing', () => {
  const d = buildDigest({ plans: plans(), now: AT_9_EDT });
  assert.equal(d.status, 'baseline');
  assert.equal(d.text, null);
  assert.equal(d.state.day, '2026-09-27');
  assert.ok(d.state.leagues['1']);
});

test('B1: nothing changed and no replies -> quiet', () => {
  const p = plans();
  const d = buildDigest({ plans: p, state: baseline(p), now: AT_9_EDT, gateFor: () => gate() });
  assert.equal(d.status, 'quiet');
  assert.equal(d.text, null);
  assert.equal(d.state.day, '2026-09-27', 'the day is still marked done');
});

test('B2: next move, goal and a real title-odds move are listed', () => {
  const st = baseline(plans());
  const d = buildDigest({ plans: plans({ next: 'L1-new', title: 0.47, goal: 'reachable' }), state: st, now: AT_9_EDT, gateFor: () => gate() });
  assert.equal(d.status, 'send');
  assert.match(d.text, /League 1: the next move changed; title odds 43% -> 47%; goal now reachable with a trade \(was out of reach\)\./);
  assert.match(d.text, /Next move: offer Team 3 P4 \(WR\) \+ P7 \(WR\) for P22 \(QB\); chance of yes 59% \(a guess\); title odds \+17\.3 pts if it lands\./);
});

test('B2: a title-odds move inside max(1 pt, 2 SE) is noise', () => {
  assert.deepEqual(changesOf({ next: 'a', title: { value: 0.43, se: 0 }, goal: null }, { next: 'a', title: { value: 0.435, se: 0 }, goal: null }), []);
  // 3 pts, but the SE of the difference is 2.1 pts -> 2 SE is 4.2 pts: still noise.
  assert.deepEqual(changesOf({ next: 'a', title: { value: 0.43, se: 0.015 }, goal: null }, { next: 'a', title: { value: 0.46, se: 0.015 }, goal: null }), []);
  assert.equal(changesOf({ next: 'a', title: { value: 0.43, se: 0.003 }, goal: null }, { next: 'a', title: { value: 0.46, se: 0.003 }, goal: null }).length, 1);
});

test('B2: a failed league keeps its baseline and adds nothing', () => {
  const st = baseline(plans());
  const p = plans();
  p.leagues[0] = { league: 1, me: '1', names: {}, error: 'planner failed' };
  const d = buildDigest({ plans: p, state: st, now: AT_9_EDT });
  assert.equal(d.status, 'quiet');
  assert.deepEqual(d.state.leagues['1'], st.leagues['1']);
});

test('B3: only answers to Nick\'s own offers inside the window, by roster id', () => {
  const since = '2026-09-26T13:05:00.000Z', until = '2026-09-27T13:05:00.000Z';
  const offers = [
    { league_id: 1, proposer_team_id: '1', counterparty_team_id: '3', status: 'accepted', decided_at: '2026-09-27T01:00:00Z' },
    { league_id: 1, proposer_team_id: '1', counterparty_team_id: '5', status: 'declined', decided_at: '2026-09-26T20:00:00Z' },
    { league_id: 1, proposer_team_id: '4', counterparty_team_id: '1', status: 'accepted', decided_at: '2026-09-27T02:00:00Z' }, // not Nick's offer
    { league_id: 1, proposer_team_id: '1', counterparty_team_id: '6', status: 'declined', decided_at: '2026-09-26T10:00:00Z' }, // before the window
    { league_id: 1, proposer_team_id: '1', counterparty_team_id: '7', status: 'accepted', decided_at: '2026-09-27T13:06:00Z' }, // after now
    { league_id: 9, proposer_team_id: '1', counterparty_team_id: '2', status: 'accepted', decided_at: '2026-09-27T01:00:00Z' }, // not a planned league
  ];
  const r = repliesOf(offers, { me: new Map([['1', '1']]), since, until });
  assert.deepEqual(r.get('1').map(x => `${x.team}:${x.status}`), ['5:declined', '3:accepted']);
  assert.equal(r.has('9'), false);

  const p = plans();
  const d = buildDigest({ plans: p, state: baseline(p), offers: { rows: offers, reason: null }, now: AT_9_EDT, gateFor: () => gate() });
  assert.equal(d.status, 'send');
  assert.match(d.text, /League 1: Team 5 declined your offer; Team 3 accepted your offer\./);
  // The next day the answers already sent are before the window; only the one after yesterday's check is new.
  const next = buildDigest({ plans: p, state: d.state, offers: { rows: offers, reason: null }, now: NEXT_9_EDT, gateFor: () => gate() });
  assert.match(next.text, /League 1: Team 7 accepted your offer\./);
  assert.doesNotMatch(next.text, /Team 5|Team 3 accepted/);
  const third = buildDigest({ plans: p, state: next.state, offers: { rows: offers, reason: null }, now: new Date(NEXT_9_EDT.getTime() + 86_400_000), gateFor: () => gate() });
  assert.equal(third.status, 'quiet');
});

test('B3: unreadable offers are said, never read as "nobody replied"', () => {
  const st = baseline(plans());
  const d = buildDigest({ plans: plans({ next: 'X' }), state: st, offers: { rows: [], reason: 'no offer tables' }, now: AT_9_EDT, gateFor: () => gate() });
  assert.match(d.text, /Replies could not be read today \(no offer tables\)\./);
});

test('B5: rule-breaking or no-edge moves are withheld and name no players', () => {
  const ok = plans().leagues[0].next_move.value;
  assert.deepEqual(moveVerdict(ok, gate()), { ok: true, reasons: [] });
  const withGive = give => ({ ...clone(ok), steps: [{ ...clone(ok.steps[0]), give }] });
  assert.ok(moveVerdict(withGive(['160']), gate()).reasons.includes('never_give'), 'Nico Collins');
  assert.ok(moveVerdict(withGive(['80']), gate()).reasons.includes('never_give'), 'Chase Brown');
  assert.ok(moveVerdict(withGive(['277']), gate({ score: () => 70 })).reasons.includes('never_give'), 'A.J. Brown for a non-Blue chip');
  assert.ok(moveVerdict(withGive(['277']), gate()).reasons.includes('needs_your_ok'), 'A.J. Brown without Nick\'s OK');
  assert.equal(moveVerdict(withGive(['277']), gate({ confirmed: [ok.move_id] })).ok, true, 'A.J. Brown on a card Nick OK\'d');
  assert.ok(moveVerdict(ok, gate({ score: () => 80 })).reasons.includes('below_blue_chip'), 'final get below 83');
  assert.ok(moveVerdict({ ...clone(ok), steps: [{ ...clone(ok.steps[0]), get: ['290'] }] }, gate()).reasons.includes('never_get'), 'no buy-backs');
  assert.ok(moveVerdict(ok, null).reasons.includes('rules_unreadable'), 'no gate');
  assert.ok(moveVerdict(ok, { applies: false, check: () => ({ ok: true, reasons: [] }) }).reasons.includes('rules_unreadable'), 'gate does not apply');
  assert.ok(moveVerdict(ok, { applies: true, check: () => { throw new Error('boom'); } }).reasons.includes('rules_unreadable'), 'gate throws');
  assert.ok(moveVerdict({ ...clone(ok), delta_final: { status: 'ok', value: 0 } }, gate()).reasons.includes('no_edge'), 'does not beat doing nothing');
  const noise = clone(ok); noise.steps[0].title_odds_delta.clears_2se = false;
  assert.ok(moveVerdict(noise, gate()).reasons.includes('no_edge'), 'a step inside 2 SE');

  // Through the digest: the move gives Nico Collins -> "open the War Room", no player labels.
  const st = baseline(plans());
  const p = plans({ next: 'X' });
  p.leagues[0].next_move.value.steps[0].give = ['160'];
  p.leagues[0].names['160'] = 'Nico Collins (WR)';
  for (const gateFor of [() => gate(), () => null, () => { throw new Error('db gone'); }]) {
    const d = buildDigest({ plans: p, state: st, now: AT_9_EDT, gateFor });
    assert.equal(d.status, 'send');
    assert.match(d.text, /Next move: open the War Room \(held back by the digest's rules check\)\./);
    assert.doesNotMatch(d.text, /Nico|P22|P4/);
  }
  const threw = buildDigest({ plans: p, state: st, now: AT_9_EDT, gateFor: () => { throw new Error('db gone'); } });
  assert.match(threw.errors.join(), /league 1 rule gate: db gone/);
});

test('B5: a flip leg\'s get that a later step gives away is not held to the floor', () => {
  const ok = plans().leagues[0].next_move.value;
  const two = clone(ok);
  two.steps = [{ ...clone(ok.steps[0]), get: ['50'] }, { ...clone(ok.steps[0]), give: ['50'], get: ['22'] }];
  assert.equal(moveVerdict(two, gate({ score: id => (id === '50' ? 60 : 90) })).ok, true);
  two.steps[1].give = ['4'];
  assert.ok(moveVerdict(two, gate({ score: id => (id === '50' ? 60 : 90) })).reasons.includes('below_blue_chip'));
});

test('B6: team and manager names never appear; partners are Team N', () => {
  const st = baseline(plans());
  const d = buildDigest({ plans: plans({ next: 'X', title: 0.5 }), state: st, now: AT_9_EDT, gateFor: () => gate(),
    offers: { rows: [{ league_id: 1, proposer_team_id: '1', counterparty_team_id: '3', status: 'declined', decided_at: '2026-09-27T01:00:00Z' }], reason: null } });
  assert.doesNotMatch(d.text, /Zorblat|Quennimore|Vex|Secret/);
  assert.match(d.text, /Team 3 declined your offer/);
  assert.match(d.text, /offer Team 3 /);
});

test('B8: a change to _run alone is not news', () => {
  const st = baseline(plans({ run: { changed: { changed: false, reason: 'same' } } }));
  const p = plans({ run: { changed: { changed: true, reason: 'the run thinks so' }, week: 5 } });
  assert.equal(buildDigest({ plans: p, state: st, now: AT_9_EDT, gateFor: () => gate() }).status, 'quiet');
  assert.deepEqual(snapshotOf(p.leagues[0]), st.leagues['1']);
});

test('no move clears the bar is reported as such', () => {
  const st = baseline(plans());
  const p = plans();
  p.leagues[0].next_move = { status: 'unknown', source: 'plan.path', reason: 'nothing clears' };
  const d = buildDigest({ plans: p, state: st, now: AT_9_EDT, gateFor: () => gate() });
  assert.match(d.text, /League 1: no trade clears the bar now\.\nNext move: none clears the bar today\./);
});

test('B7: runner: off does nothing, dry run writes nothing, --apply writes the row and the state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-digest-'));
  const env = { GRIDIRON_WARROOM_PLANS: path.join(dir, 'plans.json') };
  const outbox = path.join(dir, 'pushes.jsonl');
  const stateFile = path.join(dir, 'digest-state.json');
  const deps = { loadOffers: () => ({ rows: [], reason: null }), gateFor: () => gate() };
  const logs = [];
  const log = l => logs.push(l);

  fs.writeFileSync(env.GRIDIRON_WARROOM_PLANS, JSON.stringify(plans()));
  const off = await runDigest({ argv: ['--apply', '--now', AT_9_EDT.toISOString()], env, deps, log });
  assert.equal(off.status, 'off');
  assert.equal(fs.existsSync(stateFile), false);

  const on = { ...env, GRIDIRON_DAILY_DIGEST: '1' };
  const dayBefore = new Date(AT_9_EDT.getTime() - 86_400_000).toISOString();
  assert.equal((await runDigest({ argv: ['--now', dayBefore], env: on, deps, log })).status, 'baseline');
  assert.equal(fs.existsSync(stateFile), false, 'dry run writes no state');
  assert.equal((await runDigest({ argv: ['--apply', '--now', dayBefore], env: on, deps, log })).status, 'baseline');
  assert.ok(fs.existsSync(stateFile));

  fs.writeFileSync(env.GRIDIRON_WARROOM_PLANS, JSON.stringify(plans({ next: 'X' })));
  const dry = await runDigest({ argv: ['--now', AT_9_EDT.toISOString()], env: on, deps, log });
  assert.equal(dry.status, 'send');
  assert.match(dry.line, /^daily_digest: send \(dry run\) lines 2$/);
  assert.equal(fs.existsSync(outbox), false, 'dry run appends nothing');

  const applied = await runDigest({ argv: ['--apply', '--now', AT_9_EDT.toISOString()], env: on, deps, log });
  assert.equal(applied.status, 'send');
  const rows = fs.readFileSync(outbox, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'daily_digest');
  assert.equal(rows[0].day, '2026-09-27');
  assert.match(rows[0].text, /League 1: the next move changed/);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).day, '2026-09-27');

  const again = await runDigest({ argv: ['--apply', '--now', new Date(AT_9_EDT.getTime() + 15 * 60_000).toISOString()], env: on, deps, log });
  assert.equal(again.status, 'done_today');
  assert.equal(fs.readFileSync(outbox, 'utf8').trim().split('\n').length, 1, 'once a day');

  let read = 0;
  const counting = { ...deps, loadOffers: () => { read++; return { rows: [], reason: null }; } };
  await runDigest({ argv: ['--apply', '--now', AT_10_EDT.toISOString()], env: on, deps: counting, log });
  assert.equal(read, 0, 'outside the window the offers are not read');

  fs.writeFileSync(stateFile, '{not json');
  await assert.rejects(runDigest({ argv: ['--apply', '--now', NEXT_9_EDT.toISOString()], env: on, deps, log }), /JSON/,
    'an unreadable state file stops the run; it is never read as a first run');
});

test('the refresh loop step: off starts nothing; on runs the script with --apply and records its line', async () => {
  const { dailyDigest } = await import('../scripts/refresh-live-data.mjs');
  const calls = [];
  const records = [];
  const spawn = (cmd, args) => { calls.push(args); return { status: 0, stdout: 'daily_digest: quiet (applied) lines 0\n', stderr: '' }; };
  dailyDigest({ spawn, log: () => {}, record: (...a) => records.push(a), env: {} });
  assert.equal(calls.length, 0);
  dailyDigest({ spawn, log: () => {}, record: (...a) => records.push(a), env: { GRIDIRON_DAILY_DIGEST: '1' } });
  assert.deepEqual(calls[0].slice(-2), ['scripts/campaign/daily-digest.mjs', '--apply']);
  assert.deepEqual(records[0].slice(0, 2), ['daily_digest', 'ok']);
  assert.match(records[0][2].summary, /^daily_digest: quiet/);
});
