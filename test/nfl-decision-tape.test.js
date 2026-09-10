/**
 * Codex audit finding E6 (2026-09-10) and its four named acceptance tests:
 *
 *   "Zero-selection run writes all abstentions. A quote or policy version
 *    change creates another event while first remains byte-identical. Same
 *    input retry does not duplicate. Every selected opportunity traces to one
 *    frozen selection; every offered/declined/expired result remains
 *    accountable."
 *
 * The defect: `persistPickDecisions` UPSERTs over a key that omits
 * policy_version, overwriting the price, features, reasons and timestamp of
 * what the model decided BEFORE a line moved -- and the execution pipeline
 * wrote nothing at all for a run that selected nothing, losing the whole
 * denominator. Each test below maps to one of the four acceptance criteria.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-decision-tape-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const { recordDecisionRun, decisionRun, decisionRunsFor, findDecisionEvent, boardHash } =
  await import('../server/services/nfl-decision-tape.js');

const decision = (over = {}) => ({
  matchup: 'CHI at CAR', market: 'spread', selection: 'CAR', line: -2.5,
  american_price: -110, book: 'draftkings', quote_at: '2026-09-10T12:00:00Z',
  quote_source: 'draftkings', edge: 3.2, disagreement: 2.1,
  eligible: true, abstention_reason: null, policy_rank: 1,
  feature_snapshot: { raw_forecast: { projected_margin: 0.7 } }, ...over
});

const board = (decisions, over = {}) => ({
  decisions, selected: decisions.filter(d => d.eligible),
  policy: { id: 'nfl-production-v1', version: '1.0.0' }, engine_mode: 'champion', ...over
});

/* ---- acceptance 1: a zero-selection run still writes every abstention ---- */

test('a run that selects NOTHING still records every candidate and its abstention reason', () => {
  const abstained = [
    decision({ matchup: 'A at B', selection: 'B', eligible: false, abstention_reason: 'edge_below_minimum', policy_rank: null }),
    decision({ matchup: 'C at D', selection: 'D', eligible: false, abstention_reason: 'model_disagreement', policy_rank: null }),
    decision({ matchup: 'E at F', selection: 'F', eligible: false, abstention_reason: 'calibration_ineligible', policy_rank: null })
  ];
  const result = recordDecisionRun(2026, 3, board(abstained));
  assert.equal(result.created, true);
  assert.equal(result.decision_count, 3);
  assert.equal(result.selected_count, 0, 'nothing was selected — and that must still be recorded, not skipped');

  const stored = decisionRun(result.run_id);
  assert.equal(stored.events.length, 3, 'the denominator is the whole board, not just the selections');
  assert.deepEqual(stored.events.map(e => e.abstention_reason).sort(),
    ['calibration_ineligible', 'edge_below_minimum', 'model_disagreement']);
  assert.ok(stored.events.every(e => e.eligible === 0));
});

/* ---- acceptance 2: same input retry does not duplicate ---- */

test('re-running the identical board is idempotent — it finds the existing run instead of writing a second copy', () => {
  const decisions = [decision({ matchup: 'IDEM at TEST' })];
  const first = recordDecisionRun(2026, 4, board(decisions));
  const second = recordDecisionRun(2026, 4, board(decisions));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.run_id, first.run_id);
  assert.match(second.note, /idempotent retry/);
  assert.equal(decisionRunsFor(2026, 4).length, 1);
});

test('idempotency is content-based, not time-based — a later retry of the same board is still the same run', () => {
  const decisions = [decision({ matchup: 'TIME at TEST' })];
  const a = recordDecisionRun(2026, 5, board(decisions), { decidedAt: '2026-09-10T12:00:00Z' });
  const b = recordDecisionRun(2026, 5, board(decisions), { decidedAt: '2026-09-10T18:30:00Z' });
  assert.equal(b.created, false, 'a wall-clock difference alone is not a different decision');
  assert.equal(b.run_id, a.run_id);
});

/* ---- acceptance 3: a changed input creates a NEW run, the first unchanged ---- */

test('a moved quote creates a second run while the first stays byte-identical', () => {
  const before = [decision({ matchup: 'MOVE at TEST', line: -2.5, american_price: -110 })];
  const first = recordDecisionRun(2026, 6, board(before));
  const firstStored = JSON.stringify(decisionRun(first.run_id));

  const after = [decision({ matchup: 'MOVE at TEST', line: -3.5, american_price: -115 })];
  const second = recordDecisionRun(2026, 6, board(after));

  assert.equal(second.created, true);
  assert.notEqual(second.run_id, first.run_id);
  assert.equal(JSON.stringify(decisionRun(first.run_id)), firstStored,
    'the earlier run must remain byte-identical — this is the whole point of an append-only tape');
  assert.equal(decisionRunsFor(2026, 6).length, 2, 'both versions remain readable');
});

test('a policy VERSION change alone creates a separate run — the old UPSERT key omitted exactly this', () => {
  const decisions = [decision({ matchup: 'POLICY at TEST' })];
  const v1 = recordDecisionRun(2026, 7, board(decisions), { policyId: 'p', policyVersion: '1.0.0' });
  const v2 = recordDecisionRun(2026, 7, board(decisions), { policyId: 'p', policyVersion: '2.0.0' });
  assert.equal(v2.created, true);
  assert.notEqual(v2.run_id, v1.run_id);
});

test('boardHash ignores wall-clock time but reacts to every field that defines the decision', () => {
  const base = { season: 2026, week: 8, policyId: 'p', policyVersion: '1', decisions: [decision()] };
  const same = boardHash(base);
  assert.equal(boardHash(base), same, 'pure function of its inputs');
  assert.notEqual(boardHash({ ...base, decisions: [decision({ line: -7 })] }), same);
  assert.notEqual(boardHash({ ...base, decisions: [decision({ american_price: +120 })] }), same);
  assert.notEqual(boardHash({ ...base, decisions: [decision({ eligible: false, abstention_reason: 'x' })] }), same);
  assert.notEqual(boardHash({ ...base, policyVersion: '2' }), same);
  // Ordering of the same decisions must not change the hash — a board is a
  // set of decisions, not a list whose order carries meaning.
  const two = [decision({ matchup: 'A at B' }), decision({ matchup: 'C at D' })];
  assert.equal(boardHash({ ...base, decisions: two }), boardHash({ ...base, decisions: [...two].reverse() }));
});

/* ---- acceptance 4: a selection traces to exactly one frozen decision ---- */

test('findDecisionEvent resolves a selection to exactly one immutable event on that run', () => {
  const decisions = [
    decision({ matchup: 'TRACE at ONE', selection: 'ONE' }),
    decision({ matchup: 'TRACE at TWO', selection: 'TWO' })
  ];
  const result = recordDecisionRun(2026, 9, board(decisions));
  const found = findDecisionEvent(result.run_id, { matchup: 'TRACE at TWO', market: 'spread', selection: 'TWO' });
  assert.ok(found);
  assert.equal(found.run_id, result.run_id);
  assert.equal(found.selection, 'TWO');
  assert.equal(findDecisionEvent(result.run_id, { matchup: 'NOT at HERE', market: 'spread', selection: 'X' }), undefined);
});

/* ---- the immutability is a schema fact, not a convention ---- */

test('the database itself refuses to mutate or delete a recorded decision', () => {
  const result = recordDecisionRun(2026, 10, board([decision({ matchup: 'IMMUTABLE at TEST' })]));
  assert.throws(() => db.prepare(`UPDATE nfl_decision_events SET edge=99 WHERE run_id=?`).run(result.run_id),
    /append-only/);
  assert.throws(() => db.prepare(`DELETE FROM nfl_decision_events WHERE run_id=?`).run(result.run_id),
    /append-only/);
  assert.throws(() => db.prepare(`UPDATE nfl_decision_runs SET selected_count=99 WHERE id=?`).run(result.run_id),
    /immutable/);
});
