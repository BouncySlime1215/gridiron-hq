/**
 * S-03: the served weekly construction applies S-02's grade.
 *
 * What these tests pin (docs/tdd/2026-09-22-apply-weekly-construction-grade.tdd.md):
 *   - a coordinator fit trained on the STRUCTURAL residual is never added to the ENSEMBLE
 *     base (arm B, the old trade-engine.js:354 and fantasy-coordinator.js:571 form);
 *   - only a PROMOTED fantasy_coordinator_fits row is served, and only in the weeks its
 *     promotion covers; a newer unpromoted candidate changes nothing;
 *   - once promoted, the served number is S-02's winning arm S1 (structural head plus the
 *     correction), on the trade page's current_week_ppg and on weeklyProjectionFor alike;
 *   - the betting-line lift is switched off once, inside vegasLift, so Start/Sit, the League
 *     Hub card and the waiver horizon all apply 1, while gameScriptLift still computes the
 *     multiplier for studies and no served module calls it;
 *   - the surface says what the number is built from.
 *
 * Only the weekly engine, the rest-of-season model and the game-script model are mocked.
 * The coordinator, the fit store, trade-engine, lineup-brain and waiver-brain are real.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-served-week-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.NFL_SEASON = '2026';

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { seedIfEmpty } = await import('../server/db/seed/index.js');
seedIfEmpty();
// Every seeded team plays every 2026 week, so each player has this week's game.
run(`INSERT OR IGNORE INTO schedule_games (season, team_id, week, opponent_abbr, home)
     SELECT 2026, t.id, w.week, t.abbr, 1 FROM nfl_teams t
     JOIN (WITH RECURSIVE n(week) AS (SELECT 1 UNION ALL SELECT week + 1 FROM n WHERE week < 18) SELECT week FROM n) w`);

// The game-script model under the real vegasLift: ARI a high-volume script (pass 1.2,
// rush 0.8, so the RB 0.65/0.35 split is visible), ATL a low one, every other team no line.
const LINES = {
  ARI: { pass_mult: 1.2, rush_mult: 0.8, line: { spread: -7, total: 51, opponent: 'OPP', home: true } },
  ATL: { pass_mult: 0.9, rush_mult: 1.1, line: { spread: 6.5, total: 38, opponent: 'OPP', home: false } }
};
const realGameScript = await import('../server/services/gamescript.js');
mock.module('../server/services/gamescript.js', {
  namedExports: { ...realGameScript, gameScriptFor: team => LINES[team] ?? { pass_mult: 1, rush_mult: 1, line: null } }
});

// The weekly engine: one crafted projection per test player, the ensemble 2.4 points above
// the structural head, so arm B (ensemble base) and arm S1 (structural base) differ visibly.
const ENGINE = new Map();
const realEngine = await import('../server/services/player-week-engine.js');
mock.module('../server/services/player-week-engine.js', {
  namedExports: {
    ...realEngine,
    buildPlayerWeekEngine: () => ENGINE,
    playerWeekDistribution: () => null,
    // weeklyExpertValues' game-script expert: the same structural points with or without
    // a line, so game_script_delta is 0 with a line and null without one.
    playerWeekEventExpectation: () => ({ structural_fantasy_points: 12 })
  }
});
mock.module('../server/services/ros-projection.js', { namedExports: { buildRosProjections: () => new Map() } });

// Side-effect imports, as test/ros-projection-wiring.test.js: routes assetUniverse reads.
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const coordinator = await import('../server/services/fantasy-coordinator.js');
const { assetUniverse, lineupDiff } = await import('../server/services/trade-engine.js');
const waiverBrain = await import('../server/services/waiver-brain.js');
const { startSitWeekPoints } = await import('../server/services/lineup-brain.js');
const { runDecayWatch } = await import('../server/services/decay-watch.js');
const { PPR } = await import('../server/services/scoring.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// ---------------------------------------------------------------- fixtures

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 2 ** 32; };
}
function syntheticExamples(n = 320) {
  const r = lcg(11);
  const out = [];
  for (let i = 0; i < n; i++) {
    const shift = (r() - 0.5) * 6;
    const script = (r() - 0.5) * 2;
    out.push({
      season: 2022 + (i % 3), week: 1 + (i % 17), player_id: i, team: 'AAA', opponent: 'BBB',
      market_spread: null, market_total: null,
      target: -0.8 + 0.6 * shift + 0.5 * script + (r() - 0.5) * 3,
      experts: { ensemble_shift: shift, game_script_delta: script, boom_bust_signal: null }
    });
  }
  return out;
}
const EXAMPLES = syntheticExamples();
const FIT = coordinator.fitFantasyCoordinator(EXAMPLES);
const FIT_E = coordinator.fitFantasyCoordinator(
  EXAMPLES.map(e => ({ ...e, target: e.target - e.experts.ensemble_shift })), { target: 'ensemble' });
const BOTH = { '2-4': 'on', '5-17': 'on' };
const EVIDENCE = 'docs/evidence/2026-09-22/weekly-construction-walk-forward-output.json';

// A seeded skill player on a team with no line (MID in spirit), and his crafted projection.
const P = rows(`SELECT p.id, p.name, p.position, t.abbr AS team FROM players p JOIN nfl_teams t ON t.id = p.team_id
                WHERE p.position = 'WR' AND p.fantasy_relevant = 1 AND t.abbr NOT IN ('ARI', 'ATL')
                ORDER BY p.id LIMIT 1`)[0];
const PROJ = {
  player_id: P.id, position: 'WR', team: P.team, ppg: 14.4, structural_ppg: 12.0, ensemble_shift: 2.4,
  params: { crafted: true }, player_week_engine: { cutoff: '2026-W1', mode: 'weekly' }
};
ENGINE.set(P.id, PROJ);

run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
     VALUES (301, 'sleeper', 's03-301', 2026, 'S-03 fixture', '1', 12, 1, ?, ?)`,
JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']), JSON.stringify({ rosters: [] }));
const L = row('SELECT * FROM leagues WHERE id = 301');
const FORMAT = 'rd_sf1_t12_ppr1';

const experts = week => coordinator.weeklyExpertValues(PROJ, 2026, week, PPR);
const corrected = (fit, base, week) => coordinator.coordinateFantasy(fit, experts(week), base).corrected_ppg;
// trade-engine.js's own arithmetic: base x this game's multiplier x chance to play, 2 dp.
const served = (base, a) => +(base * a.matchup.mult * a.active_probability).toFixed(2);
const saveFit = (fit, through = 2025) => {
  coordinator.saveFantasyCoordinatorFit(fit, through);
  return row('SELECT MAX(id) AS id FROM fantasy_coordinator_fits').id;
};

// ------------------------------------------------ the coordinator's base and promotion

test('the synthetic fits are ready and move the number (known-nonzero control)', () => {
  assert.equal(FIT.ready, true);
  assert.equal(FIT_E.ready, true);
  const c = coordinator.coordinateFantasy(FIT, experts(2), 0).correction;
  assert.ok(Math.abs(c) > 0.1, `correction ${c} should be visibly nonzero`);
  assert.ok(Math.abs(corrected(FIT, PROJ.ppg, 2) - corrected(FIT, PROJ.structural_ppg, 2)) > 2,
    'arm B and arm S1 must differ in this fixture, or the base tests below prove nothing');
});

test('migration 072 adds the promotion columns to fantasy_coordinator_fits', () => {
  const cols = db.prepare('PRAGMA table_info(fantasy_coordinator_fits)').all().map(c => c.name);
  assert.ok(cols.includes('promoted'), `columns: ${cols.join(', ')}`);
  assert.ok(cols.includes('promotion_json'), `columns: ${cols.join(', ')}`);
});

test('a structural-residual fit is never added to the ensemble base (arm B is not served)', () => {
  saveFit(FIT);
  const a = assetUniverse(L, FORMAT, { season: 2026, week: 2 }).get(P.id);
  assert.ok(a?.matchup, 'the fixture player has a game this week');
  const B = corrected(FIT, PROJ.ppg, 2);
  assert.notEqual(a.current_week_ppg, served(B, a),
    'current_week_ppg is the structural-residual fit added to the ensemble: the combination S-02 did not pick');
  assert.equal(a.current_week_ppg, served(PROJ.ppg, a), 'an unpromoted candidate leaves the ensemble alone');
  assert.equal(a.fantasy_coordinator, null);
});

test('an unpromoted candidate is never served, however new', () => {
  const active = coordinator.activeFantasyCoordinatorFit();
  assert.equal(active.ready, false);
  assert.match(active.reason, /promoted/);
});

test('decay watch grades the served (promoted) fit, not the newest candidate', async () => {
  const out = await runDecayWatch({ minN: 30 });
  const finding = out.findings.find(f => f.finding_key === 'fantasy_coordinator_weights');
  assert.equal(finding.status, 'not_applicable', JSON.stringify(finding));
  assert.match(finding.reason, /promoted/);
});

test('once promoted for both windows, the served number is S-02\'s arm S1 (structural head + correction)', () => {
  const id = row('SELECT MAX(id) AS id FROM fantasy_coordinator_fits').id;
  const before = coordinator.servedCoordinatorFitKey();
  coordinator.promoteFantasyCoordinatorFit(id, { windows: BOTH, evidence: EVIDENCE });
  assert.notEqual(coordinator.servedCoordinatorFitKey(), before, 'promotion changes the served-fit key');
  const active = coordinator.activeFantasyCoordinatorFit();
  assert.equal(active.ready, true);
  assert.equal(active.fit_row.id, id);
  assert.deepEqual(active.promotion.windows, BOTH);

  // Same league and week as the unpromoted build above: the cached universe must rebuild.
  const a = assetUniverse(L, FORMAT, { season: 2026, week: 2 }).get(P.id);
  const S1 = corrected(FIT, PROJ.structural_ppg, 2);
  assert.equal(a.current_week_ppg, served(S1, a));
  assert.equal(a.fantasy_coordinator.corrected_ppg, S1);
  assert.equal(a.week_basis, 'structural+coordinator');
});

test('weeklyProjectionFor serves the same construction as the trade page', () => {
  const out = coordinator.weeklyProjectionFor(P.id, { season: 2026, week: 2 });
  assert.equal(out.corrected_ppg, corrected(FIT, PROJ.structural_ppg, 2));
  assert.equal(out.week_basis, 'structural+coordinator');
});

test('a newer unpromoted candidate does not displace the promoted fit', () => {
  const promotedId = coordinator.activeFantasyCoordinatorFit().fit_row.id;
  const newer = saveFit(coordinator.fitFantasyCoordinator(EXAMPLES.map(e => ({ ...e, target: e.target + 3 }))));
  assert.ok(newer > promotedId);
  assert.equal(coordinator.activeFantasyCoordinatorFit().fit_row.id, promotedId);
});

test('a week outside the promoted window serves the ensemble, labelled', () => {
  const id = saveFit(FIT);
  coordinator.promoteFantasyCoordinatorFit(id, { windows: { '2-4': 'on', '5-17': 'off' }, evidence: EVIDENCE });
  const week6 = assetUniverse(L, FORMAT, { season: 2026, week: 6 });
  const a6 = week6.get(P.id);
  assert.equal(a6.current_week_ppg, served(PROJ.ppg, a6));
  assert.equal(a6.week_basis, 'ensemble');
  assert.equal(week6.context.week_basis.coordinator.on, false);
  assert.match(week6.context.week_basis.coordinator.reason, /5-17/);
  const a3 = assetUniverse(L, FORMAT, { season: 2026, week: 3 }).get(P.id);
  assert.equal(a3.current_week_ppg, served(corrected(FIT, PROJ.structural_ppg, 3), a3));
});

test('an ensemble-residual fit is applied to the ensemble base', () => {
  const id = saveFit(FIT_E);
  coordinator.promoteFantasyCoordinatorFit(id, { windows: BOTH, evidence: EVIDENCE });
  const a = assetUniverse(L, FORMAT, { season: 2026, week: 7 }).get(P.id);
  assert.equal(a.current_week_ppg, served(corrected(FIT_E, PROJ.ppg, 7), a));
  assert.equal(a.week_basis, 'ensemble+coordinator');
});

test('promotion refuses a fit whose base is unknown, a bad window map and a missing evidence path', () => {
  const unknown = saveFit({ ...FIT, safeguards: { ...FIT.safeguards, target: 'last week\'s points' } });
  assert.throws(() => coordinator.promoteFantasyCoordinatorFit(unknown, { windows: BOTH, evidence: EVIDENCE }), /target/);
  const id = saveFit(FIT);
  assert.throws(() => coordinator.promoteFantasyCoordinatorFit(id, { windows: { '2-4': 'yes' }, evidence: EVIDENCE }), /window/);
  assert.throws(() => coordinator.promoteFantasyCoordinatorFit(id, { windows: { '2-4': 'off', '5-17': 'off' }, evidence: EVIDENCE }), /window/);
  assert.throws(() => coordinator.promoteFantasyCoordinatorFit(id, { windows: BOTH, evidence: '' }), /evidence/);
  assert.throws(() => coordinator.promoteFantasyCoordinatorFit(999999, { windows: BOTH, evidence: EVIDENCE }), /no fantasy_coordinator_fits row/);
});

test('the surface says what this week\'s number is built from', () => {
  const id = saveFit(FIT);
  coordinator.promoteFantasyCoordinatorFit(id, { windows: BOTH, evidence: EVIDENCE });
  const assets = assetUniverse(L, FORMAT, { season: 2026, week: 8 });
  const basis = assets.context.week_basis;
  assert.equal(basis.coordinator.on, true);
  assert.equal(basis.coordinator.fit_id, id);
  assert.equal(basis.coordinator.base, 'structural');
  assert.equal(basis.betting_line_lift.on, false);
  assert.match(basis.label, /structural projection/i);
  assert.match(basis.label, /chance to play/i);
  assert.match(basis.label, /no betting-line/i);
  assert.equal(assets.get(P.id).week_basis, 'structural+coordinator');
  assert.equal(basis.graded_week, true);
  // Weeks 1 and 18 were never graded; the label says so.
  const week1 = assetUniverse(L, FORMAT, { season: 2026, week: 1 }).context.week_basis;
  assert.equal(week1.graded_week, false);
  assert.match(week1.label, /not graded/i);
});

// ------------------------------------------------------------------ the betting-line lift

test('vegasLift is switched off: every position on a team with a line gets multiplier 1', () => {
  for (const position of ['QB', 'RB', 'WR', 'TE']) {
    const lift = waiverBrain.vegasLift({ team_abbr: 'ARI', position }, 2026, 2);
    assert.equal(lift.applied, false, position);
    assert.equal(lift.multiplier, 1, position);
    assert.equal(lift.switched_off, true, position);
  }
  // One switch, frozen, in waiver-brain.js beside vegasLift.
  assert.equal(waiverBrain.BETTING_LINE_LIFT?.on, false);
  assert.ok(Object.isFrozen(waiverBrain.BETTING_LINE_LIFT));
});

test('gameScriptLift still computes the multiplier the lift used to apply (RB split included)', () => {
  const wr = waiverBrain.gameScriptLift({ team_abbr: 'ARI', position: 'WR' }, 2026, 2);
  assert.equal(wr.applied, true);
  assert.equal(wr.multiplier, 1.2);
  const rb = waiverBrain.gameScriptLift({ team_abbr: 'ARI', position: 'RB' }, 2026, 2);
  assert.equal(rb.multiplier, +(0.65 * 0.8 + 0.35 * 1.2).toFixed(3));
  assert.equal(waiverBrain.gameScriptLift({ team_abbr: 'NOPE', position: 'WR' }, 2026, 2).applied, false);
});

test('Start/Sit, the waiver horizon and the League Hub card all apply no lift', () => {
  const wr = { team_abbr: 'ARI', position: 'WR', current_week_ppg: 10, adj_ppg: 10, ppg: 10 };
  const ss = startSitWeekPoints(wr, 2026, 2);
  assert.equal(ss.week_points, 10);
  assert.equal(ss.vegas.applied, false);
  const hv = waiverBrain.horizonValueWithVegas(wr, 2026, 2);
  assert.equal(hv.value, hv.base);
  assert.equal(hv.lift, null);

  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (302, 'espn', 's03-302', 2026, 'S-03 hub', '1', 10, 1, ?, ?)`,
  JSON.stringify(['QB', 'RB', 'RB', 'WR', 'TE']), JSON.stringify({ teams: [{ id: 1, roster: { entries: [
    { lineupSlotId: 4, playerPoolEntry: { player: { id: 5001, fullName: 'Lined Receiver', defaultPositionId: 3, injuryStatus: 'ACTIVE' } } }
  ] } }] }));
  const lg = row('SELECT * FROM leagues WHERE id = 302');
  const asset = { id: 5001, name: 'Lined Receiver', position: 'WR', team_abbr: 'ARI', espn_id: 5001, available: true,
    current_week_ppg: 10, adj_ppg: 10, ppg: 10, active_probability: 0.95, bye: 9, matchup: { opponent: 'OPP' } };
  const d = lineupDiff(lg, '1', { assets: new Map([[asset.id, asset]]) });
  assert.ifError(d.error);
  const priced = d.optimal.find(s => s.player?.id === 5001)?.player;
  assert.equal(priced?.week_points, 10, 'the League Hub card prices him on current_week_ppg alone');
});

test('the lift\'s reading says the number leaves the market out, and only when the market says something', () => {
  const high = waiverBrain.vegasLift({ team_abbr: 'ARI', position: 'WR' }, 2026, 2).reading;
  assert.match(high, /51/);
  assert.match(high, /does not add/i);
  assert.doesNotMatch(high, /more volume/i);
  const low = waiverBrain.vegasLift({ team_abbr: 'ATL', position: 'WR' }, 2026, 2).reading;
  assert.match(low, /38/);
  assert.doesNotMatch(low, /usual work/i);
  assert.equal(waiverBrain.vegasLift({ team_abbr: 'NOPE', position: 'WR' }, 2026, 2).reading, null);
});

test('no served module calls gameScriptLift: the switch in vegasLift cannot be routed around', () => {
  const root = new URL('../server/', import.meta.url);
  const hits = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && /\bgameScriptLift\b/.test(fs.readFileSync(full, 'utf8'))) {
        hits.push(path.relative(root.pathname, full));
      }
    }
  };
  walk(root.pathname);
  assert.deepEqual(hits.filter(f => f !== path.join('services', 'waiver-brain.js')), []);
});

// ------------------------------------------------------------------ decay watch on the served fit

test('decay watch grades the promoted ensemble-residual fit on the ensemble residual', async () => {
  // Six played 2026 weeks for the fixture player: examples after the fit's 2025 cutoff.
  const lines = [[5, 60, 0], [8, 110, 1], [3, 20, 0], [6, 75, 0], [9, 130, 1], [4, 41, 0]];
  lines.forEach(([rec, yds, td], i) => run(`INSERT INTO player_week_usage (player_id, season, week, team, position, receptions, receiving_yards, receiving_tds)
                                            VALUES (?, 2026, ?, ?, 'WR', ?, ?, ?)`, P.id, i + 1, P.team, rec, yds, td));
  const id = saveFit(FIT_E);
  coordinator.promoteFantasyCoordinatorFit(id, { windows: BOTH, evidence: EVIDENCE });
  const out = await runDecayWatch({ minN: 5 });
  const finding = out.findings.find(f => f.finding_key === 'fantasy_coordinator_weights');
  assert.equal(finding.n, 6, JSON.stringify(finding));
  // Each example: target = PPR points - structural 12; the ensemble residual subtracts the 2.4 shift.
  const c = coordinator.coordinateFantasy(FIT_E, { ensemble_shift: 2.4, game_script_delta: null, boom_bust_signal: null }, 0).correction;
  const seq = lines.map(([rec, yds, td]) => rec + 0.1 * yds + 6 * td - 12 - 2.4).map(r => Math.abs(r) - Math.abs(r - c));
  const mean = seq.reduce((s, x) => s + x, 0) / seq.length;
  assert.equal(finding.mean_post_approval_effect, +mean.toFixed(4));
});
