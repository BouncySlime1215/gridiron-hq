/**
 * What league-brain.js still claims, after the 2026-09-18 retirement.
 *
 * This file used to test `acceptProbability` — a tier-based logistic that was the
 * module's second opinion on whether a manager signs a deal. It is gone, with the
 * deal enumerator that fed it and the plan that ranked them, because trade ideas
 * now come from one place (`trade-engine.js#tradeIdeas`) and acceptance is read
 * from the counterparty layer (real accept rates, chat reads, declaration
 * credibility) rather than from a tier.
 *
 * The tests below are the retirement itself plus the part of the module that
 * survived: the TRADEABILITY tiers and their read/write helpers, which are the
 * only writer of `manager_profiles` and still feed the trade engine's one
 * `HARD_TIER_FACTOR`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-league-brain-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const brain = await import('../server/services/league-brain.js');
const { HARD_TIER_FACTOR } = await import('../server/services/trade-engine.js');
await runMigrations();
seedIfEmpty();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// The tier helpers read the league's real rosters, so the fixture has to be a
// synced league — a roster id that is not in the payload is refused on purpose.
const payload = {
  teams: [1, 2, 3].map(id => ({ id, name: `Team ${id}`, owners: [`{M${id}}`],
    roster: { entries: [{ playerPoolEntry: { player: { id: 500000 + id,
      fullName: `Fixture Player ${id}`, defaultPositionId: 2 } } }] } })),
  members: [1, 2, 3].map(id => ({ id: `{M${id}}`, firstName: `First${id}`, lastName: `Last${id}` })),
  settings: { name: 'Brain fixture' },
};
run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
     roster_positions, connection_status)
     VALUES (7, 'espn', 'espn-brain-7', 2026, 'Brain fixture', ?, 3, '1', ?, 'connected')`,
JSON.stringify(payload), JSON.stringify(['QB', 'RB', 'WR', 'TE', 'FLEX']));

test('the second acceptance model and the second deal enumerator are gone', () => {
  assert.equal(brain.acceptProbability, undefined);
  assert.equal(brain.brainPlan, undefined);
  assert.deepEqual(Object.keys(brain).sort(),
    ['TRADEABILITY', 'brainState', 'managerProfiles', 'recordNote', 'setManagerProfile']);
});

test('the three tiers survive, because the trade engine still prices "hard"', () => {
  assert.deepEqual(Object.keys(brain.TRADEABILITY).sort(), ['fair', 'hard', 'never']);
  for (const [id, t] of Object.entries(brain.TRADEABILITY)) {
    assert.equal(typeof t.label, 'string', `${id} has no label`);
    assert.ok(t.responsiveness >= 0 && t.responsiveness <= 1, `${id} responsiveness ${t.responsiveness}`);
  }
  // One factor, one place: the 0.55 that used to be applied twice.
  assert.equal(HARD_TIER_FACTOR, 0.55);
});

test('a tier round-trips, and an unknown tier is refused rather than stored', () => {
  const ok = brain.setManagerProfile(7, '3', { tradeability: 'hard', notes: 'counters everything', owner: 'Dana' });
  assert.equal(ok.ok, true);
  const dana = brain.managerProfiles(7).managers.find(m => String(m.roster_id) === '3');
  assert.equal(dana.tradeability, 'hard');
  const bad = brain.setManagerProfile(7, '4', { tradeability: 'sometimes' });
  assert.match(bad.error ?? '', /unknown tier/);
  assert.equal(brain.managerProfiles(7).managers.some(m => String(m.roster_id) === '4'), false);
});

test('an unsynced league says so rather than inventing managers', () => {
  assert.match(brain.managerProfiles(99).error ?? '', /not synced/);
});

test('every roster defaults to "fair" until somebody says otherwise', () => {
  const stored = brain.managerProfiles(7);
  assert.equal(stored.managers.length, 3);
  assert.ok(stored.managers.every(m => ['fair', 'hard', 'never'].includes(m.tradeability)));
  assert.ok(stored.tiers.some(t => t.id === 'fair'));
});
