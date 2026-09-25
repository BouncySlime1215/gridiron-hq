/**
 * PYES-ONE (ONE-PLAN night 3): every served P(yes) goes through server/services/p-yes.js.
 * Pre-registration: docs/tdd/2026-09-24-pyes-one.tdd.md. Made-up teams and offers only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const { pYesFlag, pYesFor, pYesTableFrom, stepPYes, PYES_ENV, PYES_BASIS, PYES_LABEL } = await import('../server/services/p-yes.js');
const { acceptanceBand } = await import('../server/services/trade-acceptance.js');
const { activityBaseline } = await import('../server/services/eval/e1.js');
const { priorCounts } = await import('../server/services/eval/e1-league.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');

const ROOT = new URL('..', import.meta.url).pathname;
const NOW = Date.UTC(2026, 9, 1);
const LEAGUE = '99';

// Decided offers, made up: team 2 said yes 2 of 3, team 3 said no twice, team 5 has one
// answer that lands AFTER now (so it must not count), team 4 has none.
const day = d => new Date(Date.UTC(2026, 8, d)).toISOString();
const OFFERS = [
  { league_id: LEAGUE, counterparty_team_id: '2', proposed_at: day(1), resolved_at: day(2), y: 1 },
  { league_id: LEAGUE, counterparty_team_id: '2', proposed_at: day(3), resolved_at: day(4), y: 0 },
  { league_id: LEAGUE, counterparty_team_id: '2', proposed_at: day(5), resolved_at: day(6), y: 1 },
  { league_id: LEAGUE, counterparty_team_id: '3', proposed_at: day(7), resolved_at: day(8), y: 0 },
  { league_id: LEAGUE, counterparty_team_id: '3', proposed_at: day(9), resolved_at: day(10), y: 0 },
  { league_id: LEAGUE, counterparty_team_id: '5', proposed_at: day(29), resolved_at: new Date(NOW + 864e5).toISOString(), y: 1 },
];
const TEAMS = ['2', '3', '4', '5'];

const CPS = [
  { counterparty_data: false, receptiveness: 1, perception_delta: null },
  { counterparty_data: true, receptiveness: 0.7, perception_delta: 0.05, accept_rate: 0.4, accept_rate_n: 10 },
  { counterparty_data: true, receptiveness: 1.3, perception_delta: -0.1 },
];

test('flag: on only when the env says exactly 1', () => {
  assert.equal(pYesFlag({}).on, false);
  assert.equal(pYesFlag({ [PYES_ENV]: '0' }).on, false);
  assert.equal(pYesFlag({ [PYES_ENV]: 'true' }).on, false);
  assert.equal(pYesFlag({ [PYES_ENV]: '1' }).on, true);
});

test('metric 2: flag off, pYesFor IS acceptanceBand, in both caller shapes', () => {
  const table = pYesTableFrom(OFFERS, LEAGUE, TEAMS, { now: NOW });
  for (const counterparty of CPS) {
    for (const edge of [{ passes: true }, { passes: false, failed: ['x'] }, null]) {
      const clone = acceptanceBand({ counterparty, edge, profile: null });
      // Trade-engine shape: the acceptance object itself.
      assert.deepEqual(pYesFor({ counterparty, edge, team: '2', table, on: false }), clone);
      assert.deepEqual(pYesFor({ counterparty, edge, team: '2', table: null, on: true }), clone);
      // War Room shape: exactly what league-adapter.mjs priceStep returned before.
      const b = clone.band;
      assert.deepEqual(stepPYes(pYesFor({ counterparty, edge, team: '2', table, on: false })),
        { p: b?.mid ?? 0, band: b ? { low: b.low, high: b.high } : null, basis: clone.basis });
    }
  }
});

test('the table is the E1 activity baseline as of now, row by row', () => {
  const table = pYesTableFrom(OFFERS, LEAGUE, TEAMS, { now: NOW });
  const at = new Date(NOW).toISOString();
  for (const t of TEAMS) {
    const probe = { league_id: LEAGUE, counterparty_team_id: t, proposed_at: at };
    const all = [...OFFERS, probe];
    const want = activityBaseline([probe], priorCounts(all).slice(OFFERS.length))[0];
    assert.ok(Math.abs(table.byTeam.get(t).p - want) < 1e-12, `team ${t}`);
  }
  assert.equal(table.byTeam.get('2').n, 3);
  assert.equal(table.byTeam.get('3').n, 2);
  assert.equal(table.byTeam.get('5').n, 0, 'an answer resolved after now is not known now');
  assert.equal(table.pooled.n, 5);
  assert.ok(table.byTeam.get('2').p > table.byTeam.get('3').p);
});

test('metric 3: flag on, both caller shapes serve the baseline row by row', () => {
  const table = pYesTableFrom(OFFERS, LEAGUE, TEAMS, { now: NOW });
  for (const t of [...TEAMS, '8']) {
    const want = (table.byTeam.get(t) ?? table.unseen).p;
    for (const counterparty of CPS) {
      const a = pYesFor({ counterparty, edge: { passes: true }, team: Number(t), table, on: true });
      const clone = acceptanceBand({ counterparty, edge: { passes: true } });
      assert.ok(Math.abs(a.band.mid - want) < 1e-12, `trade-engine shape, team ${t}`);
      assert.ok(Math.abs(stepPYes(a).p - want) < 1e-12, `War Room shape, team ${t}`);
      assert.equal(a.basis, PYES_BASIS);
      assert.equal(a.label, PYES_LABEL);
      assert.equal(a.point, true);
      assert.deepEqual(a.challenger, { band: clone.band, basis: clone.basis }, 'the clone rides along');
      assert.equal(stepPYes(a).band, null, 'a point carries no band on the War Room step');
    }
  }
  // An idea that fails the edge test still carries no acceptance number, flag or not.
  const refused = pYesFor({ counterparty: CPS[1], edge: { passes: false }, team: '2', table, on: true });
  assert.equal(refused.band, null);
  assert.equal(refused.basis, 'edge_failed');
});

test('metric 1: no production file imports acceptanceBand outside p-yes.js and the E1 replay', () => {
  const allowed = new Set(['server/services/p-yes.js', 'server/services/eval/e1-league.js', 'server/services/trade-acceptance.js']);
  const hits = [];
  const walk = dir => {
    for (const f of readdirSync(dir)) {
      if (f === 'node_modules' || f.startsWith('.')) continue;
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(m?js|ts)$/.test(f)) {
        const rel = relative(ROOT, p);
        const src = readFileSync(p, 'utf8');
        const code = src.split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
        // An import of it, a call to it, or a handle on it (svc.acc.acceptanceBand); not the word in a string.
        if (/import[^;]*\bacceptanceBand\b|\bacceptanceBand\s*\(|\.acceptanceBand\b/.test(code) && !allowed.has(rel)) hits.push(rel);
      }
    }
  };
  walk(join(ROOT, 'server'));
  walk(join(ROOT, 'scripts'));
  assert.deepEqual(hits, []);
});

test('War Room card: a baseline p is sourced activity.accept and says rungs differ by gain', () => {
  const a = makeAdapter();
  const base = a.priceStep;
  a.priceStep = (team, g, r) => ({ ...base(team, g, r), p: 0.41, band: null, basis: PYES_BASIS, label: PYES_LABEL, n: 3 });
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }) });
  const entry = toEntry(res, { names: a.names(), as_of: '2026-09-24T00:00:00Z', changed: { changed: true, reason: 'first plan' } });
  assert.deepEqual(validateLeague(entry).errors, []);
  const st = entry.next_move.value.steps[0];
  assert.equal(st.p_yes.source, 'activity.accept');
  assert.equal(st.p_yes.guess, true);
  assert.match(st.reasoning.value.confidence, /activity baseline \(E1 pending\)/);
  assert.match(st.reasoning.value.confidence, /ladder rungs differ by your gain, not by P\(yes\)/);
  for (const f of entry.flip_map.value) {
    if (f.legs) assert.equal(f.legs.p1.source, 'activity.accept');
  }
});

test('War Room card: flag off the source and text are the clone, unchanged', () => {
  const a = makeAdapter();
  const res = planLeague(a, { objective: normaliseObjective({ risk_mode: 'balanced' }) });
  const entry = toEntry(res, { names: a.names(), as_of: '2026-09-24T00:00:00Z', changed: { changed: true, reason: 'first plan' } });
  const st = entry.next_move.value.steps[0];
  assert.equal(st.p_yes.source, 'clone.accept');
  assert.doesNotMatch(st.reasoning.value.confidence, /activity baseline/);
  assert.ok(!('p_basis' in res.best.steps[0]), 'no new key on a flag-off step');
});
