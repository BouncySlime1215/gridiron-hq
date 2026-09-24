/**
 * COACH-BRIEF (COACH-ANCHOR.md job 6): Coach's morning brief and weekly
 * itinerary check-in for the target league (leagues.id 4).
 *
 * Pinned here:
 *   - off unless GRIDIRON_COACH_BRIEF_ENABLED=1 or preview mode; =0 vetoes preview
 *   - every shipped line is a claim that passes Coach's verify.js against the
 *     rows it cites; an invented number drops the claim and the brief says so
 *   - overnight = replies to Nick's offers and injuries on his roster or in the
 *     next move; statements and credibility only through their producers
 *     (PULSE-01, CRED-01), typed unknown with the reason until those are on main
 *   - cached per plan version and window: same plan + same night is a lookup
 *   - no push text: the one push is PUSH-01's (#293)
 * In-memory SQLite for the app DB; plans from main's regenerated producer
 * fixture (FIX-03). No network, no model call, no league or manager names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const brief = await import('../server/services/coach/brief.js');
const inputs = await import('../server/services/coach/brief-inputs.js');
const { claimsFor } = await import('../server/services/coach/brief-claims.js');
const { newLedger } = await import('../server/services/coach/ledger.js');
const mig101 = await import('../server/migrations/101_coach_briefs.js');
const mig058 = await import('../server/migrations/058_league_roster_snapshots.js');
const mig067 = await import('../server/migrations/067_outcome_ledgers.js');
const mig076 = await import('../server/migrations/076_warroom_requests.js');
const script = await import('../scripts/coach/morning-brief.mjs');

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const FIXTURE = path.join(ROOT, 'test/fixtures/warroom-contract/producer-plans.json');
const PLANS = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const plans = () => structuredClone(PLANS);
const l4 = file => file.leagues.find(e => e.league === 4);
// League 4's next move in main's regenerated fixture: one step, Team 3, P4 + P6 for P21.
const NEXT_MOVE = 'L4-1dhntz0';

const ON = { GRIDIRON_COACH_BRIEF_ENABLED: '1' };
// 2026-09-24 is EDT: 11:00Z = 7 AM ET. The default window is the 12 hours before.
const MORNING = new Date('2026-09-24T11:00:00.000Z');
const NIGHT = '2026-09-24T04:00:00.000Z';
const EARLIER = '2026-09-23T12:00:00.000Z';

function appDb({ cache = true } = {}) {
  const d = new DatabaseSync(':memory:');
  if (cache) mig101.up(d);
  mig058.up(d); mig067.up(d); mig076.up(d);
  return d;
}

/** A night in league 4: replies and injuries, plus rows that must be ignored. */
function night() {
  const db = appDb();
  const offer = db.prepare(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id,
    model_p_accept, model_basis, status, resolved_at, created_at) VALUES (4, 2026, 'app_proposed', ?, ?, 0.3, 'no_information', ?, ?, ?)`);
  offer.run('1', '3', 'declined', NIGHT, EARLIER);
  offer.run('1', '8', 'accepted', EARLIER, EARLIER);                           // resolved before the window
  offer.run('9', '1', 'declined', NIGHT, EARLIER);                             // not Nick's offer
  const req = db.prepare(`INSERT INTO warroom_requests (user_id, league_id, kind, payload, created_at) VALUES (1, 4, ?, ?, ?)`);
  req.run('offer.reply', JSON.stringify({ move_id: NEXT_MOVE, reply: 'counter', decline_reason: null }), NIGHT);
  const gone = req.run('offer.reply', JSON.stringify({ move_id: 'L4-qmj39s', reply: 'accept', decline_reason: null }), NIGHT);
  req.run('retract', JSON.stringify({ request_id: Number(gone.lastInsertRowid) }), NIGHT);
  const snap = db.prepare(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id,
    player_id, player_name, lineup_slot_id, is_starter, injury_status, source, first_seen_at, changed_at)
    VALUES (4, 2026, 4, ?, ?, ?, ?, 0, 1, ?, 'live', ?, ?)`);
  snap.run(1, 101, 3, 'Roster Back', 'QUESTIONABLE', EARLIER, NIGHT);           // mine
  snap.run(3, 121, 21, 'Target Wideout', 'OUT', EARLIER, NIGHT);               // in the next move (P21)
  snap.run(6, 150, 50, 'Other Guy', 'OUT', EARLIER, NIGHT);                    // neither
  snap.run(1, 102, 4, 'Healthy Guy', 'ACTIVE', EARLIER, NIGHT);                // healthy (and in the move)
  snap.run(1, 103, 6, 'Old News', 'OUT', EARLIER, EARLIER);                    // not changed overnight
  return { db };
}

const rows = (db, kind) => db.prepare('SELECT * FROM coach_briefs WHERE kind = ? ORDER BY id').all(kind);

/* ------------------------------------------------------------------ flag */

test('off by default: nothing read, nothing written', () => {
  const saved = process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  try {
    const db = appDb();
    assert.deepEqual(brief.coachBriefFlag({}), { on: false, preview: false });
    const r = brief.morningBrief({ db, file: plans(), env: {}, now: MORNING });
    assert.equal(r.status, 'off');
    assert.equal(r.text, undefined);
    assert.equal(rows(db, 'morning').length, 0);
  } finally { if (saved === undefined) delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED; else process.env.GRIDIRON_PREVIEW_UNCONFIRMED = saved; }
});

test('preview mode turns it on and labels it; =0 vetoes preview', () => {
  const saved = process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try {
    assert.deepEqual(brief.coachBriefFlag({}), { on: true, preview: true });
    assert.deepEqual(brief.coachBriefFlag({ GRIDIRON_COACH_BRIEF_ENABLED: '0' }), { on: false, preview: false });
    assert.deepEqual(brief.coachBriefFlag(ON), { on: true, preview: false });
    const r = brief.morningBrief({ db: appDb(), file: plans(), env: {}, now: MORNING });
    assert.equal(r.preview, true);
    assert.match(r.preview_reason, /not proven/);
    assert.match(r.text, /^Preview \(unconfirmed forward\): Morning brief, league 4/);
  } finally { if (saved === undefined) delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED; else process.env.GRIDIRON_PREVIEW_UNCONFIRMED = saved; }
});

/* ------------------------------------------------------------- migration */

test('migration 101 is additive: one table and its unique key, idempotent', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/migrations/101_coach_briefs.js'), 'utf8');
  assert.doesNotMatch(src.slice(src.indexOf('export function up'), src.indexOf('export function down')), /\b(DROP|ALTER|DELETE)\b/i);
  const d = new DatabaseSync(':memory:');
  mig101.up(d); mig101.up(d);
  assert.deepEqual(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name)
    .filter(n => n !== 'sqlite_sequence'), ['coach_briefs']);
  const ins = d.prepare(`INSERT INTO coach_briefs (league_id, kind, plan_version, window_key, body) VALUES (4, 'morning', 'v', 'w', '{}')`);
  ins.run();
  assert.throws(() => ins.run(), /UNIQUE/);
  assert.throws(() => d.prepare(`INSERT INTO coach_briefs (league_id, kind, plan_version, window_key, body) VALUES (4, 'daily', 'v', 'x', '{}')`).run(), /CHECK/);
});

/* ------------------------------------------------------------- grounding */

test('morning brief on the real producer plan: every line grounds, none dropped', () => {
  const r = brief.morningBrief({ db: appDb(), file: plans(), env: ON, now: MORNING });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.dropped, []);
  assert.ok(r.claims.length >= 10);
  assert.match(r.text, /Offer Team 3 P4 \(WR\) \+ P6 \(RB\) for P21 \(WR\)\./);
  assert.doesNotMatch(r.text, /It is the first of/, 'a one-step move says no step count');
  assert.match(r.text, /If he says yes, title odds move \+11\.6 pts to 54%\./);
  assert.match(r.text, /Chance he says yes: 53%, a guess until the yes-model is proven\./);
  assert.match(r.text, /Why: If all 1 step\(s\) land you gain 11\.6 pts of title odds; across yes and no outcomes that is 6\.1 pts/);
  assert.match(r.text, /When: Now: nothing argues for waiting\./);
  assert.match(r.text, /Brain check overall: failing\./);
  assert.match(r.text, /0 of 7 checks pass\./);
  assert.match(r.text, /The brain isn't proven here yet/);
  assert.match(r.text, /Number check not read: The number audit has not run for this league yet\./);
  assert.match(r.text, /Destination: Get P21 \(WR\) · where we are: title odds 43% in week 4 · next move: Get P21 from Team 3$/);
});

test('an invented number drops its claim, and the brief keeps the reason', () => {
  const file = plans();
  l4(file).next_move.value.reasoning.value.case_for = 'This deal adds 99.9 pts of title odds.';
  const r = brief.morningBrief({ db: appDb(), file, env: ON, now: MORNING });
  assert.doesNotMatch(r.text, /99\.9/);
  const d = r.dropped.find(x => x.text.includes('99.9'));
  assert.ok(d, 'dropped claim recorded');
  assert.match(d.violations[0], /99\.9 is in no cell/);
});

test('a quoted producer string is its own evidence, but not for a strict claim', () => {
  const ledger = newLedger();
  const e = ledger.record({ tool: 't', rows: [{ reason: 'Deadline is week 8', n: 3 }] });
  assert.equal(brief.checkClaim({ text: 'Note: Deadline is week 8.', cites: [`${e.id}#0.reason`] }, ledger).ok, true);
  assert.equal(brief.checkClaim({ text: 'Note: Deadline is week 8.', cites: [`${e.id}#0.reason`], strict: true }, ledger).ok, false);
  assert.equal(brief.checkClaim({ text: 'Deadline is week 8, 3 weeks away.', cites: [`${e.id}#0.reason`, `${e.id}#0.n`] }, ledger).ok, true);
  assert.equal(brief.checkClaim({ text: 'Deadline is week 8, 4 weeks away.', cites: [`${e.id}#0.reason`, `${e.id}#0.n`] }, ledger).ok, false);
});

/* ------------------------------------------------------------- overnight */

test('overnight: replies and injuries, each from its window', () => {
  const { db } = night();
  const r = brief.morningBrief({ db, file: plans(), env: ON, now: MORNING });
  assert.deepEqual(r.dropped, []);
  assert.match(r.text, /Team 3 declined your offer\./);
  assert.match(r.text, /Team 3 countered your offer\./, 'a logged reply on the next move names its partner');
  assert.doesNotMatch(r.text, /accepted/, 'a retracted reply and an out-of-window outcome are not news');
  assert.doesNotMatch(r.text, /Team 9|Team 6/);
  assert.match(r.text, /Roster Back \(your roster\) is listed QUESTIONABLE\./);
  assert.match(r.text, /Target Wideout \(in the next move\) is listed OUT\./);
  assert.doesNotMatch(r.text, /Other Guy|Healthy Guy|Old News/);
});

test('statements and credibility only through PULSE-01 and CRED-01: typed unknown until they are on main', () => {
  for (const [read, re] of [[inputs.readStatements, /PULSE-01 \(people_pulse\)/], [inputs.readCredibility, /CRED-01 \(people_credibility\)/]]) {
    const s = read();
    assert.equal(s.status, 'unknown');
    assert.match(s.reason, re);
    assert.deepEqual(s.rows, []);
  }
  const { db } = night();
  const r = brief.morningBrief({ db, file: plans(), env: ON, now: MORNING });
  assert.deepEqual(r.dropped, []);
  assert.match(r.text, /Statements not read: the brief does not read chat labels yet: their producer, PULSE-01 \(people_pulse\), is not wired into it\./);
  assert.match(r.text, /Follow-through not read: the brief does not read per-manager credibility yet: its producer, CRED-01 \(people_credibility\), is not wired into it\./);
  // No second labeller and no credibility bar of its own, and the chat DB is never opened.
  for (const rel of ['server/services/coach/brief-inputs.js', 'server/services/coach/brief.js',
    'server/services/coach/brief-claims.js', 'scripts/coach/morning-brief.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /jev_chat_signals|openChatDb|league_member_identity|SHOP_CREDIBLE_AT|open_to_trade/, rel);
  }
  // Rows arriving without a renderer fail loudly rather than vanish from the brief.
  assert.throws(() => claimsFor('morning', { entry: l4(plans()), ledger: newLedger(),
    inputs: { statements: { status: 'ok', rows: [{}] }, credibility: inputs.readCredibility(),
      replies: { status: 'ok', rows: [] }, injuries: { status: 'ok', rows: [] } } }), /no renderer/);
});

test('a missing source says it was not read; a quiet night says nothing happened', () => {
  const r = brief.morningBrief({ db: new DatabaseSync(':memory:'), file: plans(), env: ON, now: MORNING });
  assert.match(r.text, /Statements not read: the brief does not read chat labels yet/);
  assert.match(r.text, /Replies not read:/);
  assert.match(r.text, /Injuries not read:/);
  assert.match(r.cache, /^inert/);
  const quiet = brief.morningBrief({ db: appDb(), file: plans(), env: ON, now: MORNING });
  assert.match(quiet.text, /No replies to your offers in this window\./);
  assert.match(quiet.text, /Injuries not read: No ESPN roster snapshot for this league yet\./);
});

test('a failed plan run or a missing league is said plainly', () => {
  const file = plans();
  const i = file.leagues.findIndex(e => e.league === 4);
  file.leagues[i] = { league: 4, me: '1', names: {}, error: 'season sim timed out' };
  const r = brief.morningBrief({ db: appDb(), file, env: ON, now: MORNING });
  assert.match(r.text, /The last plan run failed: season sim timed out/);
  assert.match(r.text, /Brain check not read/);
  assert.equal(brief.morningBrief({ db: appDb(), file, env: ON, leagueId: 99 }).status, 'unknown');
  assert.equal(brief.morningBrief({ db: appDb(), file: null, env: ON }).status, 'unknown');
});

/* ----------------------------------------------------------------- cache */

test('cached per plan version and window', () => {
  const { db } = night();
  const a = brief.morningBrief({ db, file: plans(), env: ON, now: MORNING });
  const b = brief.morningBrief({ db, file: plans(), env: ON, now: new Date(MORNING.getTime() + 60e3) });
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(b.text, a.text);
  assert.equal(rows(db, 'morning').length, 1);
  const newer = plans(); newer.generated_at = '2026-09-24T10:30:00.000Z';
  assert.equal(brief.morningBrief({ db, file: newer, env: ON, now: MORNING }).cached, false, 'a new plan version builds fresh');
  db.prepare(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, model_p_accept,
    model_basis, status, resolved_at, created_at) VALUES (4, 2026, 'app_proposed', '1', '4', 0.3, 'no_information', 'declined', ?, ?)`)
    .run('2026-09-24T10:59:00.000Z', EARLIER);
  const later = brief.morningBrief({ db, file: newer, env: ON, now: new Date(MORNING.getTime() + 120e3) });
  assert.equal(later.cached, false, 'a new overnight row builds fresh');
  assert.equal(later.window.since, a.window.since, 'a re-read the same morning covers the same night');
  assert.match(later.text, /Team 4 declined your offer\./);
  assert.equal(rows(db, 'morning').length, 3);
});

test('the next morning starts just before where the last brief ended', () => {
  const db = appDb();
  const a = brief.morningBrief({ db, file: plans(), env: ON, now: MORNING });
  const next = brief.morningBrief({ db, file: plans(), env: ON, now: new Date(MORNING.getTime() + 24 * 3600e3) });
  assert.equal(Date.parse(a.window.until) - Date.parse(next.window.since), brief.LATE_ROWS_HOURS * 3600e3, 'reaches back for late rows');
  const late = brief.morningBrief({ db, file: plans(), env: ON, now: new Date(MORNING.getTime() + 72 * 3600e3) });
  assert.equal(Date.parse(late.window.until) - Date.parse(late.window.since), brief.DEFAULT_WINDOW_HOURS * 3600e3);
});

test('planVersion moves with the run, the objective, the itinerary and the next move', () => {
  const base = brief.planVersion(PLANS, l4(PLANS));
  const bump = f => { const p = plans(); f(p); return brief.planVersion(p, l4(p)); };
  assert.equal(bump(() => {}), base);
  assert.notEqual(bump(p => { p.generated_at = 'x'; }), base);
  assert.notEqual(bump(p => { l4(p)._run.objective_version += 1; }), base);
  assert.notEqual(bump(p => { l4(p).itinerary.value.version += 1; }), base);
  assert.notEqual(bump(p => { l4(p).next_move.value.move_id = 'L4-other'; }), base);
});

/* ---------------------------------------------------------------- weekly */

test('weekly check-in reads the itinerary and is cached per NFL week', () => {
  const db = appDb();
  const file = plans();
  const it = l4(file).itinerary.value;
  // main's fixture has one stop (the next move); a finished stop ahead of it is added here.
  it.stops.unshift({ id: 'plan-done', order: 0, kind: 'get', label: 'Get P41 off waivers', status: 'done', added_by: 'plan' });
  it.conflicts = [{ text: 'Selling P2 conflicts with untouchable.' }];
  it.untouchables = ['2'];
  l4(file)._run.behind = true;
  const w = brief.weeklyCheckIn({ db, file, env: ON });
  assert.deepEqual(w.dropped, []);
  assert.match(w.text, /^Weekly check-in, league 4/);
  assert.match(w.text, /Goal: Get P21 \(WR\)\./);
  assert.match(w.text, /It is week 4; the trade deadline is week 8\./);
  assert.equal(it.stops.length, 2);
  assert.match(w.text, /Stops: 1 of 2 done, 0 waiting, 0 blocked\./);
  assert.match(w.text, /Next stop: Get P21 from Team 3\./);
  assert.match(w.text, /Conflict: Selling P2 conflicts with untouchable\./);
  assert.match(w.text, /Untouchable players kept out of every deal: 1\./);
  assert.match(w.text, /Behind plan\. Cheapest way back: Claim P41: 9\.5 pts a game rest of season vs P4's 8\.0\./);
  assert.equal(w.week, 4);
  assert.equal(brief.weeklyCheckIn({ db, file, env: ON }).cached, true);
  l4(file)._run.week = 5;
  assert.equal(brief.weeklyCheckIn({ db, file, env: ON }).cached, false);
});

/* ------------------------------------------------------------------ push */

test('no push text here: the one push is PUSH-01\'s (#293)', () => {
  assert.equal(brief.nextMovePush, undefined);
  assert.equal(brief.PUSH_MAX_CHARS, undefined);
  assert.deepEqual(script.KINDS, ['morning', 'weekly']);
  assert.throws(() => script.parseArgs(['n', 's', '--kind', 'push']), /--kind/);
  assert.throws(() => script.parseArgs(['n', 's', '--previous', 'x.json']), /unknown argument/);
  const d = new DatabaseSync(':memory:');
  mig101.up(d);
  assert.throws(() => d.prepare(`INSERT INTO coach_briefs (league_id, kind, plan_version, window_key, body) VALUES (4, 'push', 'v', 'a->b', '{}')`).run(), /CHECK/);
});

/* ---------------------------------------------------------------- script */

test('script: args, summary line, and an end-to-end run on a DB copy', () => {
  assert.equal(script.parseArgs(['n', 's', '--kind', 'weekly', '--league', '4', '--json']).kind, 'weekly');
  assert.throws(() => script.parseArgs(['n', 's', '--kind', 'daily']), /--kind/);
  assert.throws(() => script.parseArgs(['n', 's', '--bogus']), /unknown argument/);
  assert.match(script.summaryLine('morning', { status: 'off', line: 'x' }), /morning: off: x/);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-brief-'));
  const env = { ...process.env, GRIDIRON_DB_PATH: path.join(tmp, 'app.sqlite'), GRIDIRON_WARROOM_PLANS: FIXTURE,
    SCHEDULER_DISABLED: '1' };
  delete env.GRIDIRON_PREVIEW_UNCONFIRMED;
  delete env.GRIDIRON_COACH_BRIEF_ENABLED;
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/coach/morning-brief.mjs'), ...args],
    { env, encoding: 'utf8', timeout: 120_000 });
  const off = run('--migrate');
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /\[coach-brief\] morning: off/);
  assert.equal(fs.existsSync(env.GRIDIRON_DB_PATH), false, 'off opens, creates and migrates nothing');
  env.GRIDIRON_COACH_BRIEF_ENABLED = '1';
  const on = run('--migrate', '--json');
  assert.equal(on.status, 0, on.stderr);
  const out = JSON.parse(on.stdout);
  assert.equal(out.status, 'ok');
  assert.equal(out.league, 4);
  assert.equal(out.cache, 'saved');
  assert.equal(out.ledger, undefined, 'ledger only with --ledger');
  assert.match(on.stderr, /morning league 4: \d+ claims kept, 0 dropped, saved/);
  const again = run();
  assert.match(again.stderr, /from cache/);
});

/* ------------------------------------------------- review findings (diff review) */

test('strict planner prose: an id or step count cannot ground a number that equals it', () => {
  const file = plans();
  // 21 is the id of the player he gets (P21); an id is a label, never evidence for a number.
  l4(file).next_move.value.reasoning.value.case_for = 'Team 3 wants 21 more points from this.';
  const r = brief.morningBrief({ db: appDb(), file, env: ON, now: MORNING });
  assert.ok(r.dropped.some(d => d.text.startsWith('Why: Team 3 wants 21 more')), 'the 21 is not grounded by a player id');
  // "What changed" is planner prose too: strict, so a number in it must match a result cell.
  const moved = plans();
  l4(moved)._run.changed = { changed: true, reason: 'Team 3 now pays 45% more.' };
  const m = brief.morningBrief({ db: appDb(), file: moved, env: ON, now: MORNING });
  assert.doesNotMatch(m.text, /45%/);
  assert.ok(m.dropped.some(d => d.text.startsWith('What changed: Team 3 now pays 45%')));
  const real = plans();
  l4(real)._run.changed = { changed: true, reason: 'The new deal adds 11.6 pts.' };
  assert.match(brief.morningBrief({ db: appDb(), file: real, env: ON, now: MORNING }).text,
    /What changed: The new deal adds 11\.6 pts\./, 'a number that is a result cell grounds');
});

test('a row written after the brief, dated before it, is caught next morning and not repeated', () => {
  const { db } = night();
  const first = brief.morningBrief({ db, file: plans(), env: ON, now: MORNING });
  assert.match(first.text, /Team 3 declined your offer\./);
  // Synced at 7:30 AM ET with the decline's own time, 6:55 AM ET: after the brief ran.
  db.prepare(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, model_p_accept,
    model_basis, status, resolved_at, created_at) VALUES (4, 2026, 'app_proposed', '1', '4', 0.3, 'no_information', 'declined', ?, ?)`)
    .run('2026-09-24T10:55:00.000Z', '2026-09-24T11:30:00.000Z');
  const next = brief.morningBrief({ db, file: plans(), env: ON, now: new Date(MORNING.getTime() + 24 * 3600e3) });
  assert.match(next.text, /Team 4 declined your offer\./);
  assert.doesNotMatch(next.text, /Team 3 declined|Team 3 countered|Roster Back/, 'rows already reported are not news twice');
});

test('a logged reply on a move that left the plan does not repeat its outcome', () => {
  const db = appDb();
  db.prepare(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, model_p_accept,
    model_basis, status, resolved_at, created_at) VALUES (4, 2026, 'app_proposed', '1', '3', 0.3, 'no_information', 'declined', ?, ?)`)
    .run(NIGHT, EARLIER);
  db.prepare(`INSERT INTO warroom_requests (user_id, league_id, kind, payload, created_at) VALUES (1, 4, 'offer.reply', ?, ?)`)
    .run(JSON.stringify({ move_id: 'L4-gone', reply: 'decline', decline_reason: 'wants_more' }), NIGHT);
  const r = brief.morningBrief({ db, file: plans(), env: ON, now: MORNING });
  assert.match(r.text, /Team 3 declined your offer\./);
  assert.doesNotMatch(r.text, /no longer in the plan/);
});

test('an explicit since is a one-off read: not saved, and not tomorrow\'s window', () => {
  const db = appDb();
  const r = brief.morningBrief({ db, file: plans(), env: ON, now: MORNING, since: '2026-09-20T00:00:00.000Z' });
  assert.equal(r.status, 'ok');
  assert.match(r.cache, /not saved/);
  assert.equal(rows(db, 'morning').length, 0);
  const normal = brief.morningBrief({ db, file: plans(), env: ON, now: MORNING });
  assert.equal(Date.parse(normal.window.until) - Date.parse(normal.window.since), brief.DEFAULT_WINDOW_HOURS * 3600e3);
});
