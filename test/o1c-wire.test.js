/**
 * O1C-WIRE (batch D item 14): validated O1-RADAR cells reach projections.js share through
 * betting-fantasy-link.js, behind GRIDIRON_O1C_WIRE, and only for cells that passed the
 * O1C gate (docs/tdd/2026-09-25-o1c-wire.tdd.md). Radar rows are fixtures shaped like
 * opportunity-radar.js#serveRow (PR #440); nothing here reads the database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withOpportunityDelta } from '../server/services/projections.js';
import { O1C_FLAG, o1cFlag, opportunityWire } from '../server/services/betting-fantasy-link.js';
import { O1C_GATES, O1C_CELLS, gradeO1cCell } from '../server/services/o1c-gate.js';
import { PPR } from '../server/services/scoring.js';

/** A made-up receiver and running back, shaped like buildProjections' output. */
function wr() {
  return {
    player_id: 9001, name: 'Made Up Receiver', position: 'WR', team: 'AAA', expected_games: 16,
    volume: { target_share: 0.2, targets_per_game: 7, carry_share: 0, carries_per_game: 0,
      attempts_per_game: 0, team_pass_att: 35, team_rush_att: 25 },
    params: { position: 'WR', targets: 7, carries: 0, attempts: 0, dispersion: 5,
      ypt: 8, catch_rate: 0.65, rec_td_rate: 0.05, ypc: 4, rush_td_rate: 0.03,
      ypa: 7, pass_td_rate: 0.045, int_rate: 0.025 },
    structural_ppg_pre_qbr: 12.85, qbr_adjustment: 0, ppg: 12.85, points: 205.6
  };
}
function rb() {
  return {
    player_id: 9002, name: 'Made Up Back', position: 'RB', team: 'AAA', expected_games: 15,
    volume: { target_share: 0.1, targets_per_game: 3, carry_share: 0.6, carries_per_game: 15,
      attempts_per_game: 0, team_pass_att: 30, team_rush_att: 25 },
    params: { position: 'RB', targets: 3, carries: 15, attempts: 0, dispersion: 5,
      ypt: 6, catch_rate: 0.75, rec_td_rate: 0.03, ypc: 4.2, rush_td_rate: 0.035,
      ypa: 7, pass_td_rate: 0.045, int_rate: 0.025 },
    structural_ppg_pre_qbr: 13, qbr_adjustment: 0, ppg: 13, points: 195
  };
}
const ev = (type, effect, passes = true) => ({
  type, effect, passes_gate: passes, status: passes ? 'validated' : 'watch', n: 100, ci: [effect - 1, effect + 1]
});
const opp = (player_id, events) => ({ player_id, opportunity_events: events });
const passedGates = Object.fromEntries(O1C_CELLS.map(c => [c, { status: 'passed' }]));

test('flag: off by default; "shadow" and "1" are the only other modes; preview never turns it on', () => {
  assert.equal(O1C_FLAG, 'GRIDIRON_O1C_WIRE');
  assert.equal(o1cFlag({}), 'off');
  assert.equal(o1cFlag({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), 'off');
  assert.equal(o1cFlag({ GRIDIRON_OPP_RADAR: '1' }), 'off');
  assert.equal(o1cFlag({ [O1C_FLAG]: 'shadow' }), 'shadow');
  assert.equal(o1cFlag({ [O1C_FLAG]: '1' }), 'on');
  assert.equal(o1cFlag({ [O1C_FLAG]: 'true' }), 'off');
});

test('withOpportunityDelta: +2 targets moves share and ppg by the efficiency rates; team volume untouched', () => {
  const p = wr();
  const before = JSON.stringify(p);
  const q = withOpportunityDelta(p, { targets: 2 }, PPR);
  assert.equal(JSON.stringify(p), before, 'input is not mutated');
  assert.equal(q.params.targets, 9);
  assert.equal(q.volume.targets_per_game, 9);
  assert.equal(q.volume.target_share, +(9 / 35).toFixed(4));
  assert.equal(q.volume.team_pass_att, 35);
  assert.equal(q.volume.team_rush_att, 25);
  // per target: 0.65 receptions + 8 yards x 0.1 + 0.05 TD x 6 = 1.75 PPR points
  const perTarget = 0.65 * (PPR.rec ?? 1) + 8 * (PPR.rec_yd ?? 0.1) + 0.05 * (PPR.rec_td ?? 6);
  assert.ok(Math.abs(q.ppg - (12.85 + 2 * perTarget)) < 0.01, `ppg ${q.ppg}`);
  assert.ok(Math.abs(q.points - q.ppg * 16) < 0.2);
});

test('withOpportunityDelta: a cut never takes volume below zero', () => {
  const q = withOpportunityDelta(wr(), { targets: -50 }, PPR);
  assert.equal(q.params.targets, 0);
  assert.equal(q.volume.target_share, 0);
  assert.ok(q.ppg >= 0);
});

test('off: the served projection is the same object and nothing is computed', () => {
  const p = wr();
  const out = opportunityWire(p, opp(9001, [ev('usage_rise', -0.78)]), { env: {}, gates: passedGates });
  assert.equal(out.mode, 'off');
  assert.equal(out.projection, p);
  assert.equal(out.shadow, null);
});

test('shadow: computes the wired number beside the served one; the served number never moves', () => {
  const p = wr();
  const out = opportunityWire(p, opp(9001, [ev('usage_rise', -0.78)]), { env: { [O1C_FLAG]: 'shadow' }, gates: passedGates });
  assert.equal(out.mode, 'shadow');
  assert.equal(out.projection, p, 'shadow never serves');
  assert.equal(out.shadow.ppg_before, 12.85);
  assert.ok(out.shadow.ppg_wired < 12.85);
  assert.equal(out.shadow.targets, -0.78);
  assert.deepEqual(out.cells.map(c => [c.cell, c.applied]), [['usage_rise|WRTE', false]]);
});

test('on: applies only cells whose O1C gate passed; a pending cell stays shadow with its reason', () => {
  const p = wr();
  const gates = { ...passedGates, 'usage_rise|WRTE': { status: 'pending' } };
  const out = opportunityWire(p, opp(9001, [ev('usage_rise', -0.78), ev('star_return', -0.3)]),
    { env: { [O1C_FLAG]: '1' }, gates });
  const byCell = Object.fromEntries(out.cells.map(c => [c.cell, c]));
  assert.equal(byCell['usage_rise|WRTE'].applied, false);
  assert.match(byCell['usage_rise|WRTE'].reason, /O1C gate pending/);
  assert.equal(byCell['star_return|WRTE'].applied, true);
  assert.equal(out.projection.params.targets, 7 - 0.3);
  assert.deepEqual(out.projection.opportunity_wire.applied, ['star_return|WRTE']);
  // the shadow still carries both cells
  assert.ok(Math.abs(out.shadow.targets - (-1.08)) < 1e-9);
});

test('on with the shipped gates: every cell is pending, so no served number moves', () => {
  for (const c of O1C_CELLS) assert.equal(O1C_GATES[c].status, 'pending', c);
  const p = rb();
  const out = opportunityWire(p, opp(9002, [ev('teammate_out', 3.2)]), { env: { [O1C_FLAG]: '1' } });
  assert.equal(out.projection, p);
  assert.ok(out.shadow.ppg_wired > p.ppg);
});

test('watch flags and non-validated cells never enter, not even the shadow', () => {
  const p = wr();
  const out = opportunityWire(p, opp(9001, [ev('usage_drop', 1.1, false), ev('teammate_out', null)]),
    { env: { [O1C_FLAG]: '1' }, gates: passedGates });
  assert.equal(out.projection, p);
  assert.equal(out.cells.length, 0);
  assert.equal(out.shadow.ppg_wired, p.ppg);
});

test('a cell the radar validated but O1C never registered is held, not applied', () => {
  const p = wr();
  const out = opportunityWire(p, opp(9001, [ev('depth_promotion', 0.5)]), { env: { [O1C_FLAG]: '1' }, gates: passedGates });
  assert.equal(out.projection, p);
  assert.match(out.cells[0].reason, /not registered/);
});

test('RB cells split carries + targets by his own carry:target mix', () => {
  const p = rb();
  const out = opportunityWire(p, opp(9002, [ev('teammate_out', 3.6)]), { env: { [O1C_FLAG]: '1' }, gates: passedGates });
  assert.ok(Math.abs(out.projection.params.carries - (15 + 3))  < 1e-9);
  assert.ok(Math.abs(out.projection.params.targets - (3 + 0.6)) < 1e-9);
  assert.equal(out.projection.volume.team_rush_att, 25);
});

test('a radar row for a different player throws instead of moving the wrong projection', () => {
  assert.throws(() => opportunityWire(wr(), opp(1234, [ev('usage_rise', -0.78)]), { env: { [O1C_FLAG]: 'shadow' } }),
    /radar row is for player 1234/);
});

test('QBs are never wired (no QB cell passed the radar gate)', () => {
  const p = { ...wr(), position: 'QB' };
  const out = opportunityWire(p, opp(9001, [ev('usage_rise', 1)]), { env: { [O1C_FLAG]: '1' }, gates: passedGates });
  assert.equal(out.projection, p);
  assert.equal(out.cells.length, 0);
});

// ---------------------------------------------------------------- the gate

/** n paired player-weeks: wired error = base - gain, ESPN error = base - espnGain. */
function rowsOf(n, { gain, espnGain, players = n }) {
  return Array.from({ length: n }, (_, i) => {
    const base = 4 + (i % 7) * 0.5;
    return { player: i % players, err_base: base, err_wired: base - gain + ((i % 3) - 1) * 0.05,
      err_espn: espnGain == null ? null : base - espnGain };
  });
}

test('gate: passes only when wired beats unwired AND beats ESPN, n >= 30', () => {
  const g = gradeO1cCell(rowsOf(60, { gain: 0.4, espnGain: 0.1 }));
  assert.equal(g.passes, true, g.reason);
  assert.ok(g.vs_unwired.ci90[1] < 0);
  assert.ok(g.vs_espn.ci90[1] < 0);
});

test('gate: fails when ESPN is as good or better on the same player-weeks', () => {
  const g = gradeO1cCell(rowsOf(60, { gain: 0.4, espnGain: 0.8 }));
  assert.equal(g.passes, false);
  assert.match(g.reason, /ESPN/);
});

test('gate: fails with no ESPN rows (the served weekly number needs the ESPN comparison)', () => {
  const g = gradeO1cCell(rowsOf(60, { gain: 0.4, espnGain: null }));
  assert.equal(g.passes, false);
  assert.match(g.reason, /ESPN/);
});

test('gate: fails below n 30, and when the wire does not beat the unwired projection', () => {
  assert.match(gradeO1cCell(rowsOf(20, { gain: 0.4, espnGain: 0.1 })).reason, /n 20 < 30/);
  const g = gradeO1cCell(rowsOf(60, { gain: -0.2, espnGain: -0.5 }));
  assert.equal(g.passes, false);
  assert.match(g.reason, /unwired/);
});

// ---------------------------------------------------------------- the grader's row assembly

test('grader: only played weeks where a registered validated cell fired; errors on the same player-week', async () => {
  const { assembleCellRows } = await import('../scripts/rnd/o1c-grade.mjs');
  const radarRows = [
    { player_id: 9001, position: 'WR', week: 5, played: true, ppr1: 10 },
    { player_id: 9001, position: 'WR', week: 6, played: false },
    { player_id: 9002, position: 'RB', week: 5, played: true, ppr1: 20 },
    { player_id: 9003, position: 'WR', week: 5, played: true, ppr1: 8 }
  ];
  const served = {
    9001: opp(9001, [ev('usage_rise', -0.78), ev('usage_drop', 1.1, false)]),
    9002: opp(9002, [ev('teammate_out', 3.6)]),
    9003: opp(9003, [ev('usage_rise', -0.78)])
  };
  const projections = new Map([[9001, wr()], [9002, rb()]]);
  const { byCell, missing } = assembleCellRows(radarRows, {
    serve: r => served[r.player_id], projectionAt: () => projections,
    wire: (p, s) => opportunityWire(p, s, { env: { [O1C_FLAG]: 'shadow' } }),
    espnOf: r => (r.player_id === 9001 ? 11 : null)
  });
  assert.equal(missing.projection, 1, 'player 9003 has no projection and is counted, not dropped silently');
  const wrRows = byCell.get('usage_rise|WRTE');
  assert.equal(wrRows.length, 1);
  assert.equal(wrRows[0].err_base, Math.abs(12.85 - 10));
  assert.ok(wrRows[0].err_wired < wrRows[0].err_base);
  assert.equal(wrRows[0].err_espn, 1);
  assert.equal(byCell.get('teammate_out|RB').length, 1);
  assert.equal(byCell.get('teammate_out|RB')[0].err_espn, null);
});
