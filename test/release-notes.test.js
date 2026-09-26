/**
 * RELEASE NOTES (Batch D plan item 60): a plain-English "what changed for you" note after each merged
 * batch, shown once in Today.
 *
 * Pre-registered bars B1-B8 live in docs/tdd/2026-09-26-release-notes.tdd.md. B2/B3 run on 56 real
 * commits from main (subjects, plus only the body lines that name a flag or shadow), so the dev-text
 * gate is proven on the wording this repository actually writes, not on friendly examples.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-release-notes-'));
const NOTES = path.join(temp, 'release-notes.json');
process.env.GRIDIRON_RELEASE_NOTES_FILE = NOTES;
delete process.env.GRIDIRON_RELEASE_NOTES;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const rn = await import('../server/services/release-notes.js');
const { default: releaseNotesRouter } = await import('../server/routes/release-notes.js');

const app = express();
app.use('/api/release-notes', releaseNotesRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, url) => {
  const res = await fetch(base + url, { method });
  return { status: res.status, body: await res.json() };
};

test.after(() => { server.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const HISTORY = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/release-notes-main-history.json'), 'utf8'));
const NOW = Date.parse('2026-09-26T12:00:00Z');
/** A made-up league-mate denylist (no real names): what denylistFromPlans returns. */
const DENY = [
  { term: 'Zebra Stripes FC', roster: '7', kind: 'team', league: 4 },
  { term: 'Quillon Pardee', roster: '7', kind: 'manager', league: 4 },
];
const build = (commits, extra = {}) => rn.buildReleaseNote({ commits, from: 'aaaaaaa1', to: 'bbbbbbb2', denylist: DENY, now: NOW, ...extra });
const withFlag = async (fn) => {
  process.env.GRIDIRON_RELEASE_NOTES = '1';
  try { return await fn(); } finally { delete process.env.GRIDIRON_RELEASE_NOTES; }
};

/* ------------------------------------------------------------------ B1 */

test('B1: flag off, GET and POST answer { enabled: false, reason } and touch no file', async () => {
  fs.writeFileSync(NOTES, '{ not json');
  const before = fs.statSync(NOTES).mtimeMs;
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try {
    const get = await call('GET', '/api/release-notes');
    assert.equal(get.status, 200);
    assert.deepEqual(Object.keys(get.body).sort(), ['enabled', 'reason']);
    assert.equal(get.body.enabled, false);
    const post = await call('POST', '/api/release-notes/x/seen');
    assert.equal(post.body.enabled, false);
    // A corrupt file would have made a reading route answer 'unknown': it answered off, so it read nothing.
    assert.equal(fs.readFileSync(NOTES, 'utf8'), '{ not json');
    assert.equal(fs.statSync(NOTES).mtimeMs, before);
  } finally {
    delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
    fs.rmSync(NOTES, { force: true });
  }
  assert.deepEqual(rn.releaseNotesFlag({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }).enabled, false);
  assert.deepEqual(rn.releaseNotesFlag({ GRIDIRON_RELEASE_NOTES: '1' }), { enabled: true });
});

/* ------------------------------------------------------------------ B2 / B3 / B4 on real history */

test('B2: 56 real main commits, served lines carry no dev text and no "Nick"', () => {
  assert.equal(HISTORY.commits.length, 56);
  const note = build(HISTORY.commits);
  assert.equal(note.status, 'ready');
  const lines = note.items.map(i => i.text);
  for (const line of lines) {
    assert.deepEqual(rn.devTextHits(line), [], `dev text in: ${line}`);
    assert.doesNotMatch(line, /\bNick\b/, line);
    assert.match(line, /^[A-Z0-9"]/, `starts capitalised: ${line}`);
    assert.match(line, /\.$/, `ends with a full stop: ${line}`);
  }
  assert.ok(lines.length >= 4, `at least 4 lines served, got ${lines.length}: ${JSON.stringify(lines)}`);
  const has = re => assert.ok(lines.some(l => re.test(l)), `expected a line matching ${re}: ${JSON.stringify(lines, null, 1)}`);
  has(/overpay rule/);
  has(/finished starter/);
  has(/News edge/);
  has(/Rankings/);
  for (const item of note.items) assert.ok(rn.AREAS.includes(item.area), item.area);
  // The note carries no sha, path or id a screen could print by mistake beyond its own id.
  assert.deepEqual(rn.devTextHits(note.summary), []);
});

test('B2: the gate holds code names, the never-shown source and engine jargon', () => {
  for (const t of ['The classic WarRoom is retired.', 'FantasyPros ranks now load.', 'With the O1 radar merged but off.',
    'Search keeps the ledger basis on blended step bands.', 'UI test draws the live planner.', 'Costs $3 a day now.']) {
    assert.notDeepEqual(rn.devTextHits(t), [], t);
  }
  for (const t of ["Every served War Room step passes your overpay rule at today's FantasyCalc prices.",
    'Start/Sit counts a finished starter at his actual.', 'ESPN scores refresh every minute on game days.']) {
    assert.deepEqual(rn.devTextHits(t), [], t);
  }
});

test('B3: every shadow or flag-off unit in the real history is "switched off", never a line', () => {
  const note = build(HISTORY.commits);
  const offSubjects = new Set(note.off.map(o => o.sha));
  const expectOff = [/U6 IS-TITLE importance sampling behind/, /GREEN calibration monitor/, /GREEN playoff seeding sim/,
    /waivers perishable \(never/, /E-LATENCY reply-time table per manager/, /CLONE v2 manager clones as a shadow/,
    /JEV-01a Jev gateway/, /RB-DELTAS, GRIDIRON_RB_TITLE/, /O1C-WIRE GREEN/, /per-league rules in never-give\.js/];
  for (const re of expectOff) {
    const c = HISTORY.commits.find(x => re.test(x.subject));
    assert.ok(c, `fixture has ${re}`);
    assert.ok(offSubjects.has(c.sha), `off: ${c.subject}`);
    assert.ok(!note.items.some(i => i.shas.includes(c.sha)), `not a line: ${c.subject}`);
  }
});

test('B4: every commit lands in exactly one bucket', () => {
  const note = build(HISTORY.commits);
  const seen = [...note.items.flatMap(i => i.shas), ...note.off.map(o => o.sha), ...note.behind.map(b => b.sha),
    ...note.held.lines.map(h => h.sha)];
  assert.equal(seen.length, HISTORY.commits.length);
  assert.equal(new Set(seen).size, HISTORY.commits.length);
  assert.equal(note.counts.commits, HISTORY.commits.length);
  assert.equal(note.counts.items + note.counts.duplicates + note.counts.off + note.counts.behind + note.counts.held,
    HISTORY.commits.length);
});

/* ------------------------------------------------------------------ B5 names */

test('B5: a league-mate name holds the line back and is never stored; no denylist holds the note', () => {
  const commits = [
    { sha: 'c1', subject: 'feat(trades): trade ideas now skip Zebra Stripes FC when their roster is locked', body: '' },
    { sha: 'c2', subject: 'fix: the reply clock reads Quillon Pardee replies in the right time zone', body: '' },
    { sha: 'c3', subject: 'fix(players): the injury tag clears the moment a player is active again', body: '' },
  ];
  const note = build(commits);
  assert.equal(note.held.names, 2);
  assert.equal(note.items.length, 1);
  const json = JSON.stringify(note);
  assert.ok(!json.includes('Zebra'), 'team name stored');
  assert.ok(!json.includes('Pardee'), 'manager name stored');
  assert.equal(note.held.lines.length, 2);
  for (const h of note.held.lines) assert.equal(h.reason, 'names');

  for (const denylist of [null, []]) {
    const held = build(commits, { denylist });
    assert.equal(held.status, 'held');
    assert.equal(held.items.length, 0);
    assert.match(held.reason, /names check/i);
    assert.deepEqual(rn.devTextHits(held.reason), []);
  }
});

/* ------------------------------------------------------------------ B6 trailer */

test('B6: a Release-note trailer wins, "none" hides, and a trailer with dev text is held', () => {
  const note = build([
    { sha: 't1', subject: 'feat: STEP-REGRET held at the serve step (plans.json)', body: 'Details.\n\nRelease-note: A trade step that would lower your title odds is no longer shown.' },
    { sha: 't2', subject: 'feat(today): the brief opens on your next game', body: 'Release-note: none' },
    { sha: 't3', subject: 'fix: something plain enough to serve on its own', body: 'Release-note: Fixed the fc_value reader.' },
  ]);
  assert.deepEqual(note.items.map(i => i.text), ['A trade step that would lower your title odds is no longer shown.']);
  assert.deepEqual(note.behind.map(b => b.sha), ['t2']);
  assert.deepEqual(note.held.lines.map(h => [h.sha, h.reason]), [['t3', 'wording']]);
});

/* ------------------------------------------------------------------ B7 shown once */

test('B7: GET shows the newest unseen note once; POST seen hides it; a newer one shows', async () => {
  await withFlag(async () => {
    fs.rmSync(NOTES, { force: true });
    let r = await call('GET', '/api/release-notes');
    assert.deepEqual(r.body, { enabled: true, status: 'ok', note: null });

    const first = build([{ sha: 'a1', subject: 'fix(players): the injury tag clears the moment a player is active again', body: '' }]);
    rn.appendNote(NOTES, first);
    r = await call('GET', '/api/release-notes');
    assert.equal(r.body.note.id, first.id);
    assert.equal(r.body.note.items.length, 1);

    r = await call('POST', `/api/release-notes/${first.id}/seen`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    r = await call('GET', '/api/release-notes');
    assert.equal(r.body.note, null);

    r = await call('POST', `/api/release-notes/${first.id}/seen`);
    assert.equal(r.status, 200);

    r = await call('POST', '/api/release-notes/nope/seen');
    assert.equal(r.status, 404);

    const second = build([{ sha: 'a2', subject: 'fix(draft): the draft room keeps your queue after a refresh', body: '' }],
      { from: 'bbbbbbb2', to: 'ccccccc3' });
    assert.notEqual(second.id, first.id);
    rn.appendNote(NOTES, second);
    r = await call('GET', '/api/release-notes');
    assert.equal(r.body.note.id, second.id);
  });
});

/* ------------------------------------------------------------------ B8 visible failure */

test('B8: a corrupt notes file is reported, logged, never served as "no news"', async () => {
  await withFlag(async () => {
    fs.writeFileSync(NOTES, '{ not json');
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
      const r = await call('GET', '/api/release-notes');
      assert.equal(r.body.enabled, true);
      assert.equal(r.body.status, 'unknown');
      assert.equal(r.body.note, null);
      assert.deepEqual(rn.devTextHits(r.body.reason), []);
    } finally { console.error = orig; }
    assert.ok(errors.length >= 1, 'the error is logged');
    assert.throws(() => rn.appendNote(NOTES, build([])), /could not be read/);
    assert.equal(fs.readFileSync(NOTES, 'utf8'), '{ not json');
  });
});

/* ------------------------------------------------------------------ script: B1 + B8 end to end */

test('script: dry run by default; --apply needs the flag; a corrupt file exits 1 untouched', () => {
  const repo = path.join(temp, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Test');
  git('commit', '-q', '--allow-empty', '-m', 'chore: start');
  const from = git('rev-parse', 'HEAD');
  git('commit', '-q', '--allow-empty', '-m', 'fix(players): the injury tag clears the moment a player is active again');
  git('commit', '-q', '--allow-empty', '-m', 'feat: CAL-MON calibration monitor, shadow behind GRIDIRON_CAL_MONITOR');
  const plans = path.join(temp, 'plans.json');
  fs.writeFileSync(plans, JSON.stringify({ leagues: [{ league: 4, teams: { status: 'ok', value: { 7: { name: 'Zebra Stripes FC', manager: 'Quillon Pardee' } } } }] }));
  const out = path.join(temp, 'script-notes.json');
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/release-notes.mjs'), '--repo', repo, '--plans', plans, '--file', out, ...args], {
    encoding: 'utf8', env: { ...process.env, GRIDIRON_RELEASE_NOTES: '', ...env },
  });

  let r = run(['--from', from, '--to', 'HEAD']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /the injury tag clears/i);
  assert.match(r.stdout, /dry run/i);
  assert.ok(!fs.existsSync(out), 'dry run writes nothing');

  r = run(['--from', from, '--to', 'HEAD', '--apply']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(out), 'apply with the flag off writes nothing');

  r = run(['--from', from, '--to', 'HEAD', '--apply'], { GRIDIRON_RELEASE_NOTES: '1' });
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(doc.notes.length, 1);
  assert.equal(doc.notes[0].counts.items, 1);
  assert.equal(doc.notes[0].counts.off, 1);

  // --from defaults to the last note's `to`: nothing new, so no second note.
  r = run(['--apply'], { GRIDIRON_RELEASE_NOTES: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no new commits/i);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).notes.length, 1);

  fs.writeFileSync(out, '{ not json');
  r = run(['--from', from, '--to', 'HEAD', '--apply'], { GRIDIRON_RELEASE_NOTES: '1' });
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(out, 'utf8'), '{ not json');
});
