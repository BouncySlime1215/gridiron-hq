/**
 * FIX-05: the brain report and the number audit feed the War Room plan.
 *
 * The producer reads the latest brain report (eval/index.js#latestReport), runs
 * eval/brain-rule.js#brainReportRule on the requested risk mode BEFORE planning,
 * and plans on the effective mode. A failing, stale (>48 h), missing or errored
 * report forces BALANCED with testing-tier signals off; SAFE is never raised.
 * number_health is the league's rows from number-audit.js#readNumberAudit.
 *
 * Made-up four-team league (test/fixtures/campaign-league.mjs), in-memory
 * databases with migrations 077 + 078 only. No real league data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// number-audit.js opens the app DB on import; point it at a throwaway file.
process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-brain-gate-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const GATE = await import('../server/services/campaign/brain-gate.js');
const { result, STATUS } = await import('../server/services/eval/common.js');
const { writeReport } = await import('../server/services/eval/index.js');
const { writeAuditRows } = await import('../server/services/number-audit.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { tolerancesFor } = await import('../server/services/campaign/modes.js');
const { toEntry, validateEntry, SECTIONS } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');
const M077 = await import('../server/migrations/077_number_audit.js');
const M078 = await import('../server/migrations/078_brain_report.js');

const NOW = new Date('2026-10-05T12:00:00Z');
const FRESH = '2026-10-05T11:45:00.000Z';

/** Rows shaped exactly as the graders write them (common.js#result). */
const row = (check, status, extra = {}) => result({
  check, name: `check ${check}`, status, metricName: 'calibration_slope', passBar: 'slope within 0.8-1.2',
  ...(status === STATUS.NOT_ENOUGH_DATA ? { needsN: 40, needsUnit: 'offers' } : { metric: 0.4, ci: [0.2, 0.6], n: 60 }),
  ...extra,
});
const report = (rows, computed_at = FRESH) => ({ run_id: 'r1', computed_at, checks: rows.map(r => ({ ...r, detail: r.detail ?? {} })) });
const allNed = () => ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'].map(c => row(c, STATUS.NOT_ENOUGH_DATA));
const failingE1 = () => report([row('E1', STATUS.FAILING), ...allNed().slice(1)]);

const objective = (risk_mode, extra = {}) => normaliseObjective({ risk_mode, ...extra });

/** The brain_report section, checked against the War Room contract (#238) on its own. */
function contractErrors(section) {
  const entry = { league: 4, me: '1', names: {}, error: 'sections other than brain_report are FIX-03', brain_report: section };
  return validateLeague(entry).errors;
}
const asContractField = g => ({ status: 'ok', source: 'eval.check', as_of: FRESH, value: g.section });

/* ---------------------------------------------------------- the four ruled cases */

test('all_in + failing E1 -> the plan runs balanced, and brain_report says it fell back', () => {
  const g = GATE.applyBrainReport({ objective: objective('all_in'), report: failingE1(), now: NOW });
  assert.equal(g.objective.risk_mode, 'balanced');
  assert.equal(g.rule.fell_back, true);
  assert.equal(g.rule.testing_tier_enabled, false);
  assert.equal(g.objective.testing_tier_enabled, false);
  assert.equal(g.objective.requested_risk_mode, 'all_in');
  // The fallen-back plan uses Balanced's sliders, not the all-in ones the request carried.
  assert.deepEqual(g.objective.tolerances, tolerancesFor('balanced'));
  assert.equal(g.section.fell_back_to, 'balanced');
  assert.equal(g.section.overall, 'failing');
  assert.ok(g.section.blocks.some(b => /E1/.test(b) && /failing/.test(b)), g.section.blocks.join(' | '));
  assert.ok(g.section.blocks.some(b => /all.in/i.test(b) && /balanced/i.test(b)), 'says what was asked and what runs');
  assert.deepEqual(contractErrors(asContractField(g)), []);
});

test('safe + failing -> safe (the fallback never raises SAFE), no fell_back_to', () => {
  const g = GATE.applyBrainReport({ objective: objective('safe'), report: failingE1(), now: NOW });
  assert.equal(g.objective.risk_mode, 'safe');
  assert.equal(g.rule.fell_back, false);
  assert.equal(g.objective.testing_tier_enabled, false);
  assert.equal('fell_back_to' in g.section, false);
  assert.equal(g.section.overall, 'failing');
  assert.deepEqual(contractErrors(asContractField(g)), []);
});

test('missing report -> balanced, every check shown as not_run', () => {
  for (const requested of ['all_in', 'balanced']) {
    const g = GATE.applyBrainReport({ objective: objective(requested), report: null, now: NOW });
    assert.equal(g.objective.risk_mode, 'balanced', requested);
    assert.equal(g.objective.testing_tier_enabled, false);
    assert.equal(g.section.overall, 'not_enough_data');
    assert.deepEqual(g.section.checks.map(c => [c.id, c.status]),
      ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'].map(id => [id, 'not_run']));
    assert.ok(g.section.blocks.some(b => /no brain report/.test(b)));
    assert.equal(g.section.fell_back_to, requested === 'all_in' ? 'balanced' : undefined);
    assert.deepEqual(contractErrors(asContractField(g)), []);
  }
});

test('not_enough_data alone -> the requested mode is kept (all_in keeps its testing tier)', () => {
  for (const requested of ['safe', 'balanced', 'all_in']) {
    const g = GATE.applyBrainReport({ objective: objective(requested), report: report(allNed()), now: NOW });
    assert.equal(g.objective.risk_mode, requested);
    assert.equal(g.rule.fell_back, false);
    assert.equal(g.objective.testing_tier_enabled, requested === 'all_in');
    assert.equal(g.section.overall, 'not_enough_data');
    assert.equal('fell_back_to' in g.section, false);
    // needs_text reaches the screen as each check's result line.
    assert.equal(g.section.checks[0].result, 'needs 40 more offers');
    assert.deepEqual(contractErrors(asContractField(g)), []);
  }
});

/* ---------------------------------------------------------- fail closed */

test('stale (>48 h) and errored reports fail closed to balanced and say why', () => {
  const stale = GATE.applyBrainReport({ objective: objective('all_in'), report: report(allNed(), '2026-10-02T11:00:00.000Z'), now: NOW });
  assert.equal(stale.objective.risk_mode, 'balanced');
  assert.equal(stale.section.fell_back_to, 'balanced');
  assert.ok(stale.section.blocks.some(b => /stale/.test(b)));
  // A stale all-passing card is not "passing" on screen.
  const stalePass = GATE.applyBrainReport({ objective: objective('balanced'),
    report: report(allNed().map(r => row(r.check, STATUS.PASSING)), '2026-10-01T00:00:00.000Z'), now: NOW });
  assert.equal(stalePass.section.overall, 'not_enough_data');

  const errored = GATE.applyBrainReport({ objective: objective('all_in'), report: null, error: 'no such table: brain_report', now: NOW });
  assert.equal(errored.objective.risk_mode, 'balanced');
  assert.ok(errored.section.blocks.some(b => /could not be read/.test(b) && /no such table/.test(b)), errored.section.blocks.join(' | '));

  const graderError = report([row('E1', STATUS.NOT_ENOUGH_DATA, { needsN: 1, needsUnit: 'runs', needsText: 'grader could not run: boom',
    detail: { grader_error: 'boom' } }), ...allNed().slice(1)]);
  const ge = GATE.applyBrainReport({ objective: objective('all_in'), report: graderError, now: NOW });
  assert.equal(ge.objective.risk_mode, 'balanced');
  assert.equal(ge.section.checks[0].result, 'grader could not run: boom');
});

test('an unchanged mode keeps the objective the request carried (tolerances included)', () => {
  const o = objective('all_in', { tolerances: { max_assets: 2 } });
  const g = GATE.applyBrainReport({ objective: o, report: report(allNed()), now: NOW });
  assert.deepEqual(g.objective.tolerances, o.tolerances);
  assert.equal(g.objective.requested_risk_mode, 'all_in');
});

/* ---------------------------------------------------------- the DB readers */

function memDb() {
  const d = new DatabaseSync(':memory:');
  M077.up(d); M078.up(d);
  return d;
}

test('readBrainReport: latest run from brain_report; an unreadable store is an error, never a silent null', () => {
  const d = memDb();
  assert.deepEqual(GATE.readBrainReport(d), { report: null, error: null });
  writeReport(d, [row('E1', STATUS.FAILING), ...allNed().slice(1)], { now: new Date(FRESH) });
  const r = GATE.readBrainReport(d);
  assert.equal(r.error, null);
  assert.equal(r.report.checks.length, 7);
  assert.equal(r.report.checks[0].status, 'failing');

  const bare = new DatabaseSync(':memory:');
  const e = GATE.readBrainReport(bare);
  assert.equal(e.report, null);
  assert.match(e.error, /brain_report/);
});

test('readNumberHealth: the league\'s audit rows; missing table / no rows are unknown with a reason; a throw is failed', () => {
  const d = memDb();
  const none = GATE.readNumberHealth(d, 4);
  assert.equal(none.status, 'unknown');
  assert.match(none.reason, /not run for this league/);

  writeAuditRows(4, [
    { check_id: 'B.title_odds_paths', status: 'broken', title: 'Title odds disagree', detail: 'two paths differ by 6 pts', trust: 'my_team', pages_affected: ['My team', 'Trade Lab'], values: { a: 0.31, b: 0.25 } },
    { check_id: 'D.current_week', status: 'ok', title: 'Current week agrees', detail: 'all say week 5', values: {} },
  ], { asOf: FRESH, database: d });
  writeAuditRows(5, [{ check_id: 'D.current_week', status: 'warn', title: 'x', detail: 'y', values: {} }], { asOf: FRESH, database: d });
  const nh = GATE.readNumberHealth(d, 4);
  assert.equal(nh.status, 'ok');
  assert.equal(nh.as_of, FRESH);
  assert.deepEqual([nh.value.broken, nh.value.warn, nh.value.ok], [1, 0, 1]);
  assert.equal(nh.value.rows[0].check_id, 'B.title_odds_paths');
  assert.deepEqual(nh.value.rows[0].pages_affected, ['My team', 'Trade Lab']);
  assert.equal('values' in nh.value.rows[0], false, 'raw producer values stay on /api/number-audit');

  const missing = GATE.readNumberHealth(new DatabaseSync(':memory:'), 4);
  assert.equal(missing.status, 'unknown');
  assert.match(missing.reason, /not built/);

  const thrown = GATE.readNumberHealth(d, 4, { read: () => { throw new Error('disk I/O error'); } });
  assert.equal(thrown.status, 'failed');
  assert.match(thrown.reason, /disk I\/O error/);
});

/* ---------------------------------------------------------- into the plan */

function planned(requested, rep) {
  const a = makeAdapter();
  const g = GATE.applyBrainReport({ objective: objective(requested), report: rep, now: NOW });
  const res = planLeague(a, { objective: g.objective });
  const d = memDb();
  writeAuditRows(1, [{ check_id: 'D.current_week', status: 'ok', title: 'Current week agrees', detail: 'all say week 5', values: {} }],
    { asOf: FRESH, database: d });
  const entry = toEntry(res, { names: a.names(), as_of: FRESH, changed: { changed: true, reason: 'first plan' },
    brain: g, number_health: GATE.readNumberHealth(d, 1) });
  return { a, g, res, entry };
}

test('the entry: destination.risk_mode is the effective mode; brain_report and number_health are filled', () => {
  const { entry, res } = planned('all_in', failingE1());
  assert.deepEqual(validateEntry(entry), []);
  assert.ok(SECTIONS.includes('brain_report'));
  assert.equal(SECTIONS.includes('brain_check'), false, 'the contract name (#238) replaces the placeholder');
  assert.equal(res.objective.risk_mode, 'balanced');
  assert.equal(entry.view.destination.value.risk_mode, 'balanced');
  assert.equal(entry.view.risk_modes.value.find(m => m.active).mode, 'balanced');
  const br = entry.view.brain_report;
  assert.equal(br.status, 'ok');
  assert.equal(br.source, 'eval.check');
  assert.equal(br.as_of, FRESH);
  assert.equal(br.value.fell_back_to, 'balanced');
  assert.equal(br.value.overall, 'failing');
  const nh = entry.view.number_health;
  assert.equal(nh.status, 'ok');
  assert.equal(nh.source, 'audit.numbers');
  assert.equal(nh.value.ok, 1);
});

test('the fallback changes the plan on the same dice: all_in + failing plans exactly what balanced plans', () => {
  const fell = planned('all_in', failingE1());
  const bal = planned('balanced', failingE1());
  const kept = planned('all_in', report(allNed()));
  const key = r => JSON.stringify(r.best?.steps.map(s => [s.team, s.give, s.get]));
  assert.equal(key(fell.res), key(bal.res));
  assert.notEqual(key(kept.res), key(fell.res), 'all_in with no blocking check still plans all_in');
});

test('toEntry without a brain read says so; it never shows a placeholder as a result', () => {
  const a = makeAdapter();
  const res = planLeague(a, { objective: objective('balanced') });
  const entry = toEntry(res, { names: a.names(), as_of: FRESH });
  assert.equal(entry.view.brain_report.status, 'unknown');
  assert.match(entry.view.brain_report.reason, /not read/);
  assert.equal(entry.view.number_health.status, 'unknown');
  assert.equal('value' in entry.view.brain_report, false);
});

test('the producer reads the report once, gates every league before planLeague, and fills number_health', async () => {
  const src = fs.readFileSync(new URL('../scripts/campaign/produce-plans.mjs', import.meta.url), 'utf8');
  assert.match(src, /readBrainReport\(/);
  assert.match(src, /readNumberHealth\(/);
  const gate = src.indexOf('applyBrainReport(');
  const plan = src.indexOf('planLeague(adapter');
  assert.ok(gate > 0 && plan > gate, 'applyBrainReport runs before planLeague');
  assert.doesNotMatch(src, /brain_check/);
});
