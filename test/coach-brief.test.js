/**
 * COACH-BRIEF (COACH-ANCHOR.md job 6): Coach's morning brief, weekly itinerary
 * check-in and next-move push text for the target league (leagues.id 4).
 *
 * Pinned here:
 *   - off unless GRIDIRON_COACH_BRIEF_ENABLED=1 or preview mode; =0 vetoes preview
 *   - every shipped line is a claim that passes Coach's verify.js against the
 *     rows it cites; an invented number drops the claim and the brief says so
 *   - overnight = credible statements (labels and counts, no names, no text),
 *     replies to Nick's offers, injuries on his roster or in the next move
 *   - cached per plan version and window: same plan + same night is a lookup
 *   - push text only on a changed next move, capped, first sighting a baseline
 * In-memory SQLite for the app and chat DBs; plans from the real producer's
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
const { newLedger } = await import('../server/services/coach/ledger.js');
const mig088 = await import('../server/migrations/088_coach_briefs.js');
const mig058 = await import('../server/migrations/058_league_roster_snapshots.js');
const mig067 = await import('../server/migrations/067_outcome_ledgers.js');
const mig076 = await import('../server/migrations/076_warroom_requests.js');
const script = await import('../scripts/coach/morning-brief.mjs');

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const FIXTURE = path.join(ROOT, 'test/fixtures/warroom-contract/producer-plans.json');
const PLANS = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const plans = () => structuredClone(PLANS);
const l4 = file => file.leagues.find(e => e.league === 4);

const ON = { GRIDIRON_COACH_BRIEF_ENABLED: '1' };
// 2026-09-24 is EDT: 11:00Z = 7 AM ET. The default window is the 12 hours before.
const MORNING = new Date('2026-09-24T11:00:00.000Z');
const NIGHT = '2026-09-24T04:00:00.000Z';
const EARLIER = '2026-09-23T12:00:00.000Z';

function appDb({ cache = true } = {}) {
  const d = new DatabaseSync(':memory:');
  if (cache) mig088.up(d);
  mig058.up(d); mig067.up(d); mig076.up(d);
  d.exec(`CREATE TABLE league_member_identity (league_id INTEGER, roster_id TEXT, chat_name TEXT, confidence TEXT)`);
  return d;
}

function chatDb() {
  const c = new DatabaseSync(':memory:');
  c.exec(`CREATE TABLE messages (msg_id INTEGER, chat_kind TEXT, chat_name TEXT, handle TEXT, name TEXT, is_from_me INTEGER,
            ts_utc TEXT, text TEXT, is_tapback INTEGER, is_reply INTEGER);
          CREATE TABLE jev_chat_signals (msg_id INTEGER, name TEXT, chat_kind TEXT, mentioned_player TEXT, question TEXT,
            probability REAL, evaluated_at TEXT)`);
  return c;
}

function say(c, id, speaker, question, p, at, text = 'SECRET MESSAGE TEXT') {
  c.prepare('INSERT INTO messages (msg_id, name, ts_utc, text) VALUES (?, ?, ?, ?)').run(id, speaker, at, text);
  c.prepare('INSERT INTO jev_chat_signals (msg_id, name, question, probability) VALUES (?, ?, ?, ?)').run(id, speaker, question, p);
}

/** A night in league 4: statements, replies and injuries, plus rows that must be ignored. */
function night() {
  const db = appDb();
  const ident = db.prepare('INSERT INTO league_member_identity VALUES (4, ?, ?, ?)');
  ident.run('7', 'Chat Person A', 'confirmed');
  ident.run('5', 'Chat Person B', 'exact');
  ident.run('6', 'Chat Person C', 'likely'); // untrusted: never tied to a team
  const chat = chatDb();
  say(chat, 1, 'Chat Person A', 'open_to_trade', 0.9, NIGHT);
  say(chat, 2, 'Chat Person A', 'open_to_trade', 0.8, NIGHT);
  say(chat, 3, 'Chat Person A', 'open_to_trade', 0.2, NIGHT);                  // below the bar
  say(chat, 4, 'Chat Person B', 'own_roster.argmax:untouchable', 1, NIGHT);    // noise label
  say(chat, 5, 'Chat Person C', 'open_to_trade', 0.9, NIGHT);                  // untrusted identity
  say(chat, 6, 'Chat Person A', 'open_to_trade', 0.9, EARLIER);                // outside the window
  const offer = db.prepare(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id,
    model_p_accept, model_basis, status, resolved_at, created_at) VALUES (4, 2026, 'app_proposed', ?, ?, 0.3, 'no_information', ?, ?, ?)`);
  offer.run('1', '3', 'declined', NIGHT, EARLIER);
  offer.run('1', '8', 'accepted', EARLIER, EARLIER);                           // resolved before the window
  offer.run('9', '1', 'declined', NIGHT, EARLIER);                             // not Nick's offer
  const req = db.prepare(`INSERT INTO warroom_requests (user_id, league_id, kind, payload, created_at) VALUES (1, 4, ?, ?, ?)`);
  req.run('offer.reply', JSON.stringify({ move_id: 'L4-152u91k', reply: 'counter', decline_reason: null }), NIGHT);
  const gone = req.run('offer.reply', JSON.stringify({ move_id: 'L4-qmj39s', reply: 'accept', decline_reason: null }), NIGHT);
  req.run('retract', JSON.stringify({ request_id: Number(gone.lastInsertRowid) }), NIGHT);
  const snap = db.prepare(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id,
    player_id, player_name, lineup_slot_id, is_starter, injury_status, source, first_seen_at, changed_at)
    VALUES (4, 2026, 4, ?, ?, ?, ?, 0, 1, ?, 'live', ?, ?)`);
  snap.run(1, 101, 3, 'Roster Back', 'QUESTIONABLE', EARLIER, NIGHT);           // mine
  snap.run(2, 111, 11, 'Target Wideout', 'OUT', EARLIER, NIGHT);               // in the next move
  snap.run(6, 150, 50, 'Other Guy', 'OUT', EARLIER, NIGHT);                    // neither
  snap.run(1, 102, 4, 'Healthy Guy', 'ACTIVE', EARLIER, NIGHT);                // healthy
  snap.run(1, 103, 6, 'Old News', 'OUT', EARLIER, EARLIER);                    // not changed overnight
  return { db, chat, credibility: new Map([['7', { shop: 0.8 }]]) };
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

test('migration 088 is additive: one table and its unique key, idempotent', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/migrations/088_coach_briefs.js'), 'utf8');
  assert.doesNotMatch(src.slice(src.indexOf('export function up'), src.indexOf('export function down')), /\b(DROP|ALTER|DELETE)\b/i);
  const d = new DatabaseSync(':memory:');
  mig088.up(d); mig088.up(d);
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
  assert.match(r.text, /Offer Team 2 P3 \(RB\) \+ P5 \(TE\) for P11 \(WR\)\./);
  assert.match(r.text, /If he says yes, title odds move \+30\.7 pts to 73%\./);
  assert.match(r.text, /Chance he says yes: 6%, a guess until the yes-model is proven\./);
  assert.match(r.text, /Why: If all 2 step\(s\) land you gain 37\.1 pts/);
  assert.match(r.text, /The brain isn't proven here yet/);
  assert.match(r.text, /Destination: Get P21 \(WR\) · where we are: title odds 43% in week 4 · next move: Get P11 from Team 2$/);
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

test('overnight: credible statements, replies and injuries, each from its window', () => {
  const { db, chat, credibility } = night();
  const r = brief.morningBrief({ db, chat, file: plans(), env: ON, now: MORNING, credibility });
  assert.deepEqual(r.dropped, []);
  assert.match(r.text, /Team 7 said he is open to dealing \(SHOP, 2x, his follow-through on this is 0\.80\)\./);
  assert.match(r.text, /Not counted as news: 1 statements whose kind has no proven follow-through for that manager \(UNTOUCHABLE\)\./);
  assert.match(r.text, /Team 3 declined your offer\./);
  assert.match(r.text, /Team 2 countered your offer\./);
  assert.doesNotMatch(r.text, /accepted/, 'a retracted reply and an out-of-window outcome are not news');
  assert.doesNotMatch(r.text, /Team 9|Team 6/);
  assert.match(r.text, /Roster Back \(your roster\) is listed QUESTIONABLE\./);
  assert.match(r.text, /Target Wideout \(in the next move\) is listed OUT\./);
  assert.doesNotMatch(r.text, /Other Guy|Healthy Guy|Old News/);
});

test('no chat name and no message text leave the chat DB', () => {
  const { db, chat, credibility } = night();
  brief.morningBrief({ db, chat, file: plans(), env: ON, now: MORNING, credibility });
  const stored = db.prepare('SELECT body FROM coach_briefs').all().map(r => r.body).join('\n');
  assert.doesNotMatch(stored, /Chat Person|SECRET MESSAGE/);
});

test('without his credibility a SHOP statement is not counted as news', () => {
  const { db, chat } = night();
  const r = brief.morningBrief({ db, chat, file: plans(), env: ON, now: MORNING });
  assert.doesNotMatch(r.text, /Team 7 said/);
  assert.match(r.text, /Not counted as news: 3 statements .*\(SHOP, UNTOUCHABLE\)|Not counted as news: 3 statements .*\(UNTOUCHABLE, SHOP\)/);
});

test('a missing source says it was not read; a quiet night says nothing happened', () => {
  const r = brief.morningBrief({ db: new DatabaseSync(':memory:'), file: plans(), env: ON, now: MORNING });
  assert.match(r.text, /Statements not read: No chat DB/);
  assert.match(r.text, /Replies not read:/);
  assert.match(r.text, /Injuries not read:/);
  assert.match(r.cache, /^inert/);
  const quiet = brief.morningBrief({ db: appDb(), chat: chatDb(), file: plans(), env: ON, now: MORNING });
  assert.match(quiet.text, /Statements not read: No confirmed chat identities/);
  assert.match(quiet.text, /No replies to your offers in this window\./);
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
  const { db, chat, credibility } = night();
  const a = brief.morningBrief({ db, chat, file: plans(), env: ON, now: MORNING, credibility });
  const b = brief.morningBrief({ db, chat, file: plans(), env: ON, now: new Date(MORNING.getTime() + 60e3), credibility });
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(b.text, a.text);
  assert.equal(rows(db, 'morning').length, 1);
  const newer = plans(); newer.generated_at = '2026-09-24T10:30:00.000Z';
  assert.equal(brief.morningBrief({ db, chat, file: newer, env: ON, now: MORNING, credibility }).cached, false, 'a new plan version builds fresh');
  say(chat, 9, 'Chat Person A', 'open_to_trade', 0.9, '2026-09-24T10:59:00.000Z');
  const later = brief.morningBrief({ db, chat, file: newer, env: ON, now: new Date(MORNING.getTime() + 120e3), credibility });
  assert.equal(later.cached, false, 'a new overnight row builds fresh');
  assert.equal(later.window.since, a.window.since, 'a re-read the same morning covers the same night');
  assert.match(later.text, /SHOP, 3x/);
  assert.equal(rows(db, 'morning').length, 3);
});

test('the next morning starts where the last brief ended', () => {
  const db = appDb();
  const a = brief.morningBrief({ db, file: plans(), env: ON, now: MORNING });
  const next = brief.morningBrief({ db, file: plans(), env: ON, now: new Date(MORNING.getTime() + 24 * 3600e3) });
  assert.equal(next.window.since, a.window.until);
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
  it.stops[1].status = 'done';
  it.conflicts = [{ text: 'Selling P2 conflicts with untouchable.' }];
  it.untouchables = ['2'];
  l4(file)._run.behind = true;
  const w = brief.weeklyCheckIn({ db, file, env: ON });
  assert.deepEqual(w.dropped, []);
  assert.match(w.text, /^Weekly check-in, league 4/);
  assert.match(w.text, /Goal: Get P21 \(WR\)\./);
  assert.match(w.text, /It is week 4; the trade deadline is week 8\./);
  assert.match(w.text, new RegExp(`Stops: 1 of ${it.stops.length} done, 0 waiting, 0 blocked\\.`));
  assert.match(w.text, /Next stop: Get P11 from Team 2\./);
  assert.match(w.text, /Conflict: Selling P2 conflicts with untouchable\./);
  assert.match(w.text, /Untouchable players kept out of every deal: 1\./);
  assert.match(w.text, /Behind plan\. Cheapest way back: /);
  assert.equal(w.week, 4);
  assert.equal(brief.weeklyCheckIn({ db, file, env: ON }).cached, true);
  l4(file)._run.week = 5;
  assert.equal(brief.weeklyCheckIn({ db, file, env: ON }).cached, false);
});

/* ------------------------------------------------------------------ push */

test('push: first sighting is a baseline, a changed move drafts one capped text', () => {
  const db = appDb();
  const first = brief.nextMovePush({ db, file: plans(), env: ON });
  assert.equal(first.status, 'unchanged');
  assert.match(first.reason, /baseline/);
  assert.equal(brief.nextMovePush({ db, file: plans(), env: ON }).status, 'unchanged');
  const moved = plans();
  const e = l4(moved);
  e.next_move.value.move_id = 'L4-new';
  e._run.changed = { changed: true, reason: 'better partner now: Team 2', previous_key: 'x', next_key: 'y' };
  const p = brief.nextMovePush({ db, file: moved, env: ON });
  assert.equal(p.status, 'ok');
  assert.deepEqual([p.from, p.to], ['L4-152u91k', 'L4-new']);
  assert.ok(p.text.length <= brief.PUSH_MAX_CHARS, p.text);
  assert.match(p.text, /^League 4: new next move\. What changed: better partner now: Team 2 Offer Team 2 P3 \(RB\) \+ P5 \(TE\) for P11 \(WR\)\./);
  assert.equal(brief.nextMovePush({ db, file: moved, env: ON }).status, 'unchanged', 'announced once');
  assert.equal(rows(db, 'push').length, 2);
});

test('push against a previous plans file; an unreadable move is not a change', () => {
  const db = appDb();
  const prev = plans();
  l4(prev).next_move.value.move_id = 'L4-old';
  const p = brief.nextMovePush({ db, previous: prev, file: plans(), env: ON });
  assert.equal(p.status, 'ok');
  assert.equal(brief.nextMovePush({ db, previous: prev, file: plans(), env: ON }).cached, true);
  const failed = plans();
  l4(failed).next_move = { status: 'failed', reason: 'rescorer disagreed', source: 'plan.path' };
  assert.equal(brief.nextMovePush({ db, previous: prev, file: failed, env: ON }).status, 'unchanged');
  const none = plans();
  l4(none).next_move = { status: 'unknown', reason: 'No move clears the bar this week.', source: 'plan.path' };
  const n = brief.nextMovePush({ db, previous: prev, file: none, env: ON });
  assert.match(n.text, /^League 4: the next move changed\. No next move: No move clears the bar this week\.$/);
});

test('push text is cut at whole claims when long', () => {
  const file = plans();
  const e = l4(file);
  e.next_move.value.move_id = 'L4-long';
  e._run.changed = { changed: true, reason: `new numbers moved a different deal to the top ${'and more '.repeat(20)}`.trim() + '.' };
  const prev = plans();
  const p = brief.nextMovePush({ db: appDb(), previous: prev, file, env: ON });
  assert.ok(p.text.length <= brief.PUSH_MAX_CHARS);
  assert.ok(p.dropped.some(d => d.violations[0] === 'over the push length cap'));
  assert.ok(p.text.endsWith('.'));
});

/* ---------------------------------------------------------------- script */

test('script: args, summary line, and an end-to-end run on a DB copy', () => {
  assert.equal(script.parseArgs(['n', 's', '--kind', 'weekly', '--league', '4', '--json']).kind, 'weekly');
  assert.throws(() => script.parseArgs(['n', 's', '--kind', 'daily']), /--kind/);
  assert.throws(() => script.parseArgs(['n', 's', '--bogus']), /unknown argument/);
  assert.match(script.summaryLine('morning', { status: 'off', line: 'x' }), /morning: off: x/);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-brief-'));
  const env = { ...process.env, GRIDIRON_DB_PATH: path.join(tmp, 'app.sqlite'), GRIDIRON_WARROOM_PLANS: FIXTURE,
    GRIDIRON_CHAT_DB_PATH: path.join(tmp, 'absent.sqlite'), SCHEDULER_DISABLED: '1' };
  delete env.GRIDIRON_PREVIEW_UNCONFIRMED;
  delete env.GRIDIRON_COACH_BRIEF_ENABLED;
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/coach/morning-brief.mjs'), ...args],
    { env, encoding: 'utf8', timeout: 120_000 });
  const off = run();
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /\[coach-brief\] morning: off/);
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
