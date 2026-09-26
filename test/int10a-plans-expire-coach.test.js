/**
 * integration-10a (PLANS-EXPIRE #428 x Coach): the War Room hides a kept plan older than 24 h (or of
 * unknown age) as "Plan out of date". Coach reads the same plans file through plan_read
 * (brain-tools.js), the starter answers and the brief; none of them may state a move from a plan the
 * War Room hides. One gate: plan-age.js#outOfDateReason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-int10a-expire-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const PLANS = path.join(temp, 'plans.json');
process.env.GRIDIRON_WARROOM_PLANS = PLANS;
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const AGE = await import('../server/services/campaign/plan-age.js');
const { planRead } = await import('../server/services/coach/brain-tools.js');
const { starterAnswer } = await import('../server/services/coach/starter-answers.js');
const { weeklyCheckIn } = await import('../server/services/coach/brief.js');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'warroom-contract', 'producer-plans.json'), 'utf8'));
const H = 3_600_000;
const now = Date.now();
const iso = ms => new Date(ms).toISOString();
// Two leagues the producer planned (an entry with `error` reads as failed before any age check).
const leagues = FIXTURE.leagues.filter(e => !e.error).map(e => e.league);
const [FRESH, STALE] = leagues;

/** The fixture with league FRESH planned just now and league STALE 30 h ago (kept by --leagues runs). */
function write(times) {
  const doc = structuredClone(FIXTURE);
  for (const e of doc.leagues) if (e.league in times) e.planned_at = times[e.league];
  fs.writeFileSync(PLANS, JSON.stringify(doc));
  return doc;
}

test('outOfDateReason: fresh, undated file and flag off -> null; 30 h old -> the out-of-date reason', () => {
  const doc = write({ [FRESH]: iso(now), [STALE]: iso(now - 30 * H) });
  const entry = id => doc.leagues.find(e => e.league === id);
  assert.equal(AGE.outOfDateReason(entry(FRESH), doc.leagues, { env: {}, now }), null);
  assert.match(AGE.outOfDateReason(entry(STALE), doc.leagues, { env: {}, now }), /Plan out of date: .*30 h ago/);
  assert.equal(AGE.outOfDateReason(entry(STALE), doc.leagues, { env: { GRIDIRON_PLANS_EXPIRE: '0' }, now }), null);
  const undated = structuredClone(FIXTURE.leagues);
  assert.equal(AGE.outOfDateReason(undated.find(e => e.league === STALE), undated, { env: {}, now }), null, 'a file with no plan times is not judged');
});

test('plan_read: an out-of-date league reads as unknown with the reason; a fresh one reads as before', () => {
  write({ [FRESH]: iso(now), [STALE]: iso(now - 30 * H) });
  const [stale] = planRead({ league_id: STALE, section: 'next_move' });
  assert.equal(stale.status, 'unknown');
  assert.match(stale.reason, /Plan out of date/);
  assert.ok(!Object.keys(stale).some(k => k.startsWith('next_move_') && k !== 'next_move_status'), 'no move columns leak');
  const [fresh] = planRead({ league_id: FRESH, section: 'next_move' });
  assert.equal(fresh.status, 'ok');
  // A kept entry with no stamp in a dated file has an unknown age: out of date too.
  write({ [FRESH]: iso(now) });
  assert.equal(planRead({ league_id: STALE, section: 'next_move' })[0].status, 'unknown');
});

test('plan_read: GRIDIRON_PLANS_EXPIRE=0 reads an old plan as before', () => {
  write({ [FRESH]: iso(now), [STALE]: iso(now - 30 * H) });
  process.env.GRIDIRON_PLANS_EXPIRE = '0';
  try { assert.equal(planRead({ league_id: STALE, section: 'next_move' })[0].status, 'ok'); }
  finally { delete process.env.GRIDIRON_PLANS_EXPIRE; }
});

test('starter answer and weekly brief refuse an out-of-date plan with the reason, and state no claim', async () => {
  const doc = write({ [FRESH]: iso(now), [STALE]: iso(now - 30 * H) });
  const a = await starterAnswer({ question: 'what is my next move?', intent: 'next_move', leagueId: STALE, plansPath: PLANS });
  assert.deepEqual(a.answer.claims, []);
  assert.match(a.answer.refusals.join(' '), /Plan out of date/);
  const ok = await starterAnswer({ question: 'what is my next move?', intent: 'next_move', leagueId: FRESH, plansPath: PLANS });
  assert.doesNotMatch(ok.answer.refusals.join(' '), /Plan out of date/);
  const b = weeklyCheckIn({ db: null, file: doc, leagueId: STALE, now: new Date(now), env: { GRIDIRON_COACH_BRIEF_ENABLED: '1' } });
  assert.equal(b.status, 'unknown');
  assert.match(b.reason, /Plan out of date/);
});
