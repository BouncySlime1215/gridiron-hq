/**
 * O1 opportunity radar: the load-bearing claims, on a fixture small enough to check by hand.
 *
 *   1. a teammate ruled out is found from PRIOR-week rosters (he has no box-score row);
 *   2. a questionable teammate gives no bump: a pending watch item only (no double count);
 *   3. backup QB starting fires for pass-catchers when the starter who played last week is out;
 *   4. the baseline is strictly prior (the graded week's own box score never reaches it);
 *   5. only events that passed the gate reach net_validated_change; nothing moves a projection;
 *   6. the flag is default off, GRIDIRON_OPP_RADAR=0 vetoes preview, preview mode turns it on;
 *   7. the effect fitter recovers a planted slope and the gate needs both CIs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-radar-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const R = await import('../server/services/opportunity-radar.js');

const SEASON = 2024;
const P = [
  { id: 1, name: 'Alpha Back', position: 'RB', gsis: '00-0000001', carries: 18, targets: 3 },
  { id: 2, name: 'Bravo Back', position: 'RB', gsis: '00-0000002', carries: 6, targets: 1 },
  { id: 3, name: 'Charlie Wideout', position: 'WR', gsis: '00-0000003', carries: 0, targets: 8 },
  { id: 4, name: 'Delta Wideout', position: 'WR', gsis: '00-0000004', carries: 0, targets: 5 },
  { id: 5, name: 'Echo Passer', position: 'QB', gsis: '00-0000005', carries: 3, targets: 0 }
];
const injury = (week, gsis, status, practice = 'Did Not Participate In Practice') =>
  run(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status, practice_status)
       VALUES (?,?,?,?,?,?,?,?)`, SEASON, week, gsis, 'AAA', gsis, 'X', status, practice);

test.before(() => {
  for (const p of P) run('INSERT INTO players (id, name, position, gsis_id, fantasy_relevant) VALUES (?,?,?,?,1)', p.id, p.name, p.position, p.gsis);
  for (let week = 1; week <= 6; week++) {
    for (const p of P) {
      if (p.id === 1 && week === 5) continue; // Alpha ruled out week 5: no box-score row at all
      if (p.id === 5 && week === 6) continue; // Echo ruled out week 6
      const bump = p.id === 2 && week === 5 ? 12 : 0; // Bravo absorbs the carries in week 5
      run(`INSERT INTO player_week_usage (player_id, season, week, team, opponent, position, attempts, carries, targets, receptions)
           VALUES (?,?,?,?,?,?,?,?,?,?)`, p.id, SEASON, week, 'AAA', 'BBB', p.position,
      p.position === 'QB' ? 32 : 0, p.carries + bump, p.targets, Math.max(0, p.targets - 2));
      run('INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (?,?,?,?,?)', p.id, SEASON, week, 50, 0.7);
    }
  }
  injury(4, P[3].gsis, 'Questionable', 'Limited Participation in Practice'); // Delta questionable week 4
  injury(5, P[0].gsis, 'Out');                                               // Alpha out week 5
  injury(6, P[4].gsis, 'Out');                                               // Echo out week 6
});

const rowsFor = () => R.buildRadarRows(SEASON, { startWeek: 3, endWeek: 6 });
const find = (list, pid, week) => list.find(r => r.player_id === pid && r.week === week);

test('a teammate ruled out is found from prior-week rosters, with the opportunities he carried', () => {
  const bravo = find(rowsFor(), 2, 5);
  assert.ok(bravo, 'Bravo graded in week 5');
  const e = bravo.events.find(x => x.type === 'teammate_out');
  assert.ok(e, 'teammate_out fires although Alpha has no week-5 row');
  assert.equal(e.who, 'Alpha Back');
  assert.equal(e.m, 21, 'his EWMA opportunities (18 carries + 3 targets every game)');
  assert.equal(find(rowsFor(), 1, 5), undefined, 'Alpha himself is not a graded row that week');
});

test('a questionable teammate is a pending watch item, never a bump', () => {
  const charlie = find(rowsFor(), 3, 4);
  assert.equal(charlie.events.filter(x => x.type === 'teammate_out').length, 0);
  assert.equal(charlie.pending.length, 1);
  assert.equal(charlie.pending[0].who, 'Delta Wideout');
  assert.ok(charlie.pending[0].p_out < R.OUT_THRESHOLD);
  const served = R.serveRow(charlie);
  const q = served.opportunity_events.find(x => x.type === 'teammate_questionable');
  assert.equal(q.status, 'watch');
  assert.equal(q.effect, null);
  assert.equal(served.net_validated_change.value, 0);
});

test('backup QB starting fires for pass-catchers when the starter who played last week is out', () => {
  const list = rowsFor();
  const charlie = find(list, 3, 6);
  assert.ok(charlie.events.some(x => x.type === 'backup_qb_start' && x.who === 'Echo Passer'));
  assert.ok(!find(list, 3, 5).events.some(x => x.type === 'backup_qb_start'), 'not when the starter plays');
});

test('the baseline is strictly prior: the graded week never reaches it', () => {
  const bravo = find(rowsFor(), 2, 5);
  assert.equal(bravo.opp1, 19, 'week 5 actual: 18 carries + 1 target');
  assert.equal(bravo.base_opp, 7, 'EWMA of weeks 1-4 (7 every week), untouched by week 5');
  assert.deepEqual(bravo.prior_opps, [7, 7, 7, 7]);
});

test('only gated events reach net_validated_change; watch events never move a number', () => {
  const row = { player_id: 9, name: 'X', team: 'AAA', position: 'RB', group: 'RB', season: SEASON, week: 5,
    base_opp: 10, prior_games: 4, pending: [],
    events: [{ type: 'teammate_out', m: 20, who: 'Y', p_out: 1 }, { type: 'oline_out', m: 1, who: 'Z (LT)' }] };
  const effects = {
    'teammate_out|RB': { beta: 0.2, ci: [0.1, 0.3], n: 300, players: 140, passes_gate: true, graded: { gain: 0.7, ci: [0.3, 1.1] } },
    'oline_out|RB': { beta: -0.5, ci: [-0.9, 0.2], n: 400, players: 200, passes_gate: false }
  };
  const s = R.serveRow(row, effects);
  const tm = s.opportunity_events.find(e => e.type === 'teammate_out');
  assert.equal(tm.effect, 4);
  assert.equal(tm.status, 'validated');
  assert.match(tm.evidence, /measured on 300 similar cases/);
  const ol = s.opportunity_events.find(e => e.type === 'oline_out');
  assert.equal(ol.status, 'watch');
  assert.match(ol.evidence, /Below the bar/);
  assert.equal(s.net_validated_change.value, 4, 'the watch event is excluded');
  assert.equal(s.projection_moved, false, 'O1c writes projections, not this unit');
});

test('flag: default off, 0 vetoes preview, 1 or preview mode turns it on', () => {
  const before = { ...process.env };
  try {
    delete process.env.GRIDIRON_OPP_RADAR;
    delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
    assert.equal(R.radarFlag().on, false);
    assert.equal(R.opportunityOf(2, { season: SEASON, week: 5 }), null);
    process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
    const pv = R.radarFlag();
    assert.equal(pv.on, true);
    assert.equal(pv.preview, true);
    process.env.GRIDIRON_OPP_RADAR = '0';
    assert.equal(R.radarFlag().on, false, 'site flag 0 vetoes preview');
    process.env.GRIDIRON_OPP_RADAR = '1';
    delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
    R.__test.clearCache();
    const o = R.opportunityOf(2, { season: SEASON, week: 5 });
    assert.ok(o, 'served when on');
    assert.ok(o.opportunity_events.some(e => e.type === 'teammate_out'));
    assert.equal(typeof o.net_validated_change.value, 'number');
  } finally {
    for (const k of ['GRIDIRON_OPP_RADAR', 'GRIDIRON_PREVIEW_UNCONFIRMED']) {
      if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
    }
  }
});

test('fitEffect recovers a planted slope; the gate needs both CIs', () => {
  const rows = [];
  for (let p = 0; p < 120; p++) {
    for (let w = 0; w < 6; w++) {
      const m = (p + w) % 4 === 0 ? 10 : 0;
      const noise = ((p * 7 + w * 13) % 11) / 11 - 0.5;
      rows.push({ player_id: p, base_opp: 8, opp1: 8 + 0.3 * m + noise, events: m ? [{ type: 'teammate_out', m }] : [] });
    }
  }
  const f = R.fitEffect(rows, 'teammate_out', 'opp1', { reps: 200 });
  assert.ok(Math.abs(f.beta - 0.3) < 0.02, `beta ${f.beta}`);
  assert.ok(f.ci[0] > 0);
  const ev = rows.filter(r => r.events.length);
  const g = R.pairedGain(ev, 'opp1', r => r.base_opp + f.beta * R.magnitude(r, 'teammate_out'), { reps: 200 });
  assert.ok(g.gain > 0 && g.ci[0] > 0);
  assert.equal(R.passesGate(f, g), true);
  assert.equal(R.passesGate({ ...f, ci: [-0.1, 0.5] }, g), false, 'fit CI straddling 0 fails');
  assert.equal(R.passesGate(f, { ...g, ci: [-0.01, 0.2] }), false, 'graded CI touching 0 fails');
});

test('every served effect that passes the gate carries both CIs clear of zero', () => {
  for (const [k, e] of Object.entries(R.FITTED_EFFECTS)) {
    if (!e.passes_gate) continue;
    assert.ok(e.n >= 30, k);
    assert.ok(e.ci[0] > 0 || e.ci[1] < 0, `${k} fit CI`);
    assert.ok(e.graded.ci[0] > 0, `${k} graded CI`);
  }
});
