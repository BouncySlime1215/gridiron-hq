/**
 * STEP-REGRET at the serve step (campaign/serve-regret.js) and in the rules check
 * (scripts/rules/step-regret-check.mjs).
 *
 * Regression: league 3's alternative L3-lrer3n was served on 2026-09-26 with step 2 at
 * -0.17 pts of title odds, and the hourly rules check reported 0 breaks. Pinned here:
 *   - the rules check's own restatement flags exactly that step (fixture of the served move)
 *   - the serve guard holds it back: the deck closes up and keeps its ranks 1..n; a failing
 *     next move is held back with the reason; an entry with no break is returned untouched
 *   - Coach's plan reader (brief.js#leagueEntry) never reads it out
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-step-regret-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/step-regret-l3-lrer3n.json', import.meta.url), 'utf8'));
const { servedStepRegret } = await import('../scripts/rules/step-regret-check.mjs');
const { holdStepRegret, stepRegretBreaks } = await import('../server/services/campaign/serve-regret.js');
const { leagueEntry } = await import('../server/services/coach/brief.js');

const ok = value => ({ status: 'ok', value });
const step = (value, extra = {}) => ({ partner: '5', give: ['1'], get: ['2'], title_odds_delta: { status: 'ok', value, unit: 'title_odds' }, ...extra });
const move = (id, deltas, rank) => ({ move_id: id, rank, steps: deltas.map(d => step(d)) });

test('the rules check flags L3-lrer3n step 2 (the served regression)', () => {
  assert.deepEqual(servedStepRegret(FIXTURE), [{ move_id: 'L3-lrer3n', where: 'alternative', step: 2, delta: -0.001700000000000007 }]);
});

test('the serve guard holds it back; the rules check then passes', () => {
  const entry = { ...FIXTURE, alternatives: ok([move('A1', [0.02], 1), ...FIXTURE.alternatives.value.map(m => ({ ...m, rank: 2 })), move('A3', [0.01, 0.005], 3)]) };
  const { entry: held, held: list } = holdStepRegret(entry);
  assert.deepEqual(list.map(h => h.move_id), ['L3-lrer3n']);
  assert.deepEqual(held.alternatives.value.map(m => [m.move_id, m.rank]), [['A1', 1], ['A3', 2]], 'the deck closes up, ranks 1..n');
  assert.deepEqual(servedStepRegret(held), []);
  assert.deepEqual(held._run.step_regret_served.map(h => h.move_id), ['L3-lrer3n']);
});

test('a failing next move is held back with the reason; zero and negative gains fail; a clean entry is untouched', () => {
  const nm = move('N1', [0.03, 0], 1);
  const { entry } = holdStepRegret({ league: 9, next_move: ok(nm), alternatives: ok([nm, move('A2', [0.01], 2)]) });
  assert.equal(entry.next_move.status, 'unknown');
  assert.match(entry.next_move.reason, /step 2 does not beat doing nothing/);
  assert.deepEqual(entry.alternatives.value.map(m => [m.move_id, m.rank]), [['A2', 1]]);
  assert.equal(stepRegretBreaks({ alternatives: ok([move('Z', [0.01, -0.0001], 1)]) }).length, 1);
  const clean = { league: 9, next_move: ok(move('C1', [0.02], 1)), alternatives: ok([move('C1', [0.02], 1)]) };
  assert.equal(holdStepRegret(clean).entry, clean, 'no break: the same object back');
  const points = { alternatives: ok([{ move_id: 'P', steps: [step(-1, { title_odds_delta: { status: 'ok', value: -1, unit: 'points_per_week' } })] }]) };
  assert.equal(stepRegretBreaks(points).length, 0, 'a plan scored on points is judged upstream, not by title odds');
});

test("Coach's plan reader never reads the held move out", () => {
  const file = { leagues: [{ ...FIXTURE }] };
  const entry = leagueEntry(file, 3);
  assert.equal(entry.alternatives.value.length, 0);
  assert.equal(leagueEntry(file, 99), null);
});
