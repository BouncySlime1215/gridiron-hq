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
// WEEK_LINES adds a line for one team in one week only (key `${team}|${week}`), so a test
// can tell this week's line from last week's; a team in THROWS makes the model throw.
const LINES = {
  ARI: { pass_mult: 1.2, rush_mult: 0.8, line: { spread: -7, total: 51, opponent: 'OPP', home: true } },
  ATL: { pass_mult: 0.9, rush_mult: 1.1, line: { spread: 6.5, total: 38, opponent: 'OPP', home: false } }
};
const WEEK_LINES = {};
const THROWS = new Set(['ZZT']);
const realGameScript = await import('../server/services/gamescript.js');
mock.module('../server/services/gamescript.js', {
  namedExports: {
    ...realGameScript,
    gameScriptFor: (team, _season, week) => {
      if (THROWS.has(team)) throw new Error(`no model for ${team}`);
      return WEEK_LINES[`${team}|${week}`] ?? LINES[team] ?? { pass_mult: 1, rush_mult: 1, line: null };
    }
  }
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
    // weeklyExpertValues' game-script expert: 12 structural points, scaled by the pass
    // multiplier when a line supplies one, so game_script_delta is 12 x (pass_mult - 1)
    // with a line and null without one (the fixture player P has no line).
    playerWeekEventExpectation: (_projection, { mult } = {}) =>
      ({ structural_fantasy_points: 12 * (mult && typeof mult === 'object' ? mult.pass : 1) })
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
const { lineupPosture } = await import('../server/services/lineup-posture.js');
const { deriveFormat } = await import('../server/services/format.js');
const { modelMap } = await import('../server/services/gridiron-model.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// ---------------------------------------------------------------- fixtures

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 2 ** 32; };
}
function syntheticExamples(n = 320, { scriptRange = 2 } = {}) {
  const r = lcg(11);
  const out = [];
  for (let i = 0; i < n; i++) {
    const shift = (r() - 0.5) * 6;
    const script = (r() - 0.5) * scriptRange;
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
// A structural fit whose game-script input carries real weight: with the script spread over
// +/-6 instead of +/-1, its shrinkage k is no longer ~0.04, so this week's line visibly
// moves the correction (FIT's does not, which is why it cannot pin the week passed in).
const FIT_GS = coordinator.fitFantasyCoordinator(syntheticExamples(320, { scriptRange: 12 }));
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

test('with only an unpromoted candidate, the player page serves the ensemble, the trade page\'s base', () => {
  // The state every database is in after migration 072 until someone promotes a fit
  // (production included): candidates exist, none is served.
  assert.equal(coordinator.activeFantasyCoordinatorFit().ready, false, 'only an unpromoted candidate exists here');
  assert.ok(row('SELECT COUNT(*) AS n FROM fantasy_coordinator_fits').n > 0, 'a candidate row exists (known-nonzero control)');
  const out = coordinator.weeklyProjectionFor(P.id, { season: 2026, week: 2 });
  assert.equal(out.corrected_ppg, PROJ.ppg, 'the ensemble: not the structural head, not the candidate\'s correction');
  assert.equal(out.week_basis, 'ensemble');
  assert.equal(out.coordinator, null);
  assert.match(out.coordinator_off, /promoted/);
  const a = assetUniverse(L, FORMAT, { season: 2026, week: 2 }).get(P.id);
  assert.equal(a.week_basis, out.week_basis, 'the trade page names the same construction');
  assert.equal(a.current_week_ppg, served(out.corrected_ppg, a), 'and multiplies the same number');
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

test('the window edge sits between weeks 4 and 5, on the trade page, the label and the player page', () => {
  // Each promotion is a new fit id, so the asset cache rebuilds on the id alone and this
  // test pins the edge, not the cache key (that is the re-promotion test below).
  const check = (week, on) => {
    const assets = assetUniverse(L, FORMAT, { season: 2026, week });
    const a = assets.get(P.id);
    const want = on ? corrected(FIT, PROJ.structural_ppg, week) : PROJ.ppg;
    const page = coordinator.weeklyProjectionFor(P.id, { season: 2026, week });
    assert.equal(assets.context.week_basis.window, week <= 4 ? '2-4' : '5-17', `week ${week}: window`);
    assert.equal(assets.context.week_basis.coordinator.on, on, `week ${week}: label`);
    assert.equal(a.week_basis, on ? 'structural+coordinator' : 'ensemble', `week ${week}: asset basis`);
    assert.equal(a.current_week_ppg, served(want, a), `week ${week}: current_week_ppg`);
    assert.equal(page.corrected_ppg, want, `week ${week}: player page`);
    assert.equal(page.week_basis, a.week_basis, `week ${week}: player page basis`);
  };
  coordinator.promoteFantasyCoordinatorFit(saveFit(FIT), { windows: { '2-4': 'on', '5-17': 'off' }, evidence: EVIDENCE });
  check(4, true);
  check(5, false);
  coordinator.promoteFantasyCoordinatorFit(saveFit(FIT), { windows: { '2-4': 'off', '5-17': 'on' }, evidence: EVIDENCE });
  check(4, false);
  check(5, true);
});

test('re-promoting the same fit with other windows changes the served number (the cache key carries the windows)', () => {
  const id = saveFit(FIT);
  coordinator.promoteFantasyCoordinatorFit(id, { windows: BOTH, evidence: EVIDENCE });
  const on = assetUniverse(L, FORMAT, { season: 2026, week: 6 }).get(P.id);
  assert.equal(on.week_basis, 'structural+coordinator');
  assert.equal(on.current_week_ppg, served(corrected(FIT, PROJ.structural_ppg, 6), on));
  coordinator.promoteFantasyCoordinatorFit(id, { windows: { '2-4': 'on', '5-17': 'off' }, evidence: EVIDENCE });
  assert.equal(coordinator.activeFantasyCoordinatorFit().fit_row.id, id, 'the same row is served');
  const off = assetUniverse(L, FORMAT, { season: 2026, week: 6 }).get(P.id);
  assert.equal(off.week_basis, 'ensemble', 'week 6 is now outside the promoted windows');
  assert.equal(off.current_week_ppg, served(PROJ.ppg, off));
});

test('the trade page builds the coordinator\'s game-script input from THIS week\'s line', () => {
  // A second seeded receiver whose team has a line in week 6 only.
  const Q = rows(`SELECT p.id, p.name, t.abbr AS team FROM players p JOIN nfl_teams t ON t.id = p.team_id
                  WHERE p.position = 'WR' AND p.fantasy_relevant = 1 AND t.abbr NOT IN ('ARI', 'ATL', ?)
                  ORDER BY p.id LIMIT 1`, P.team)[0];
  const QPROJ = { player_id: Q.id, position: 'WR', team: Q.team, ppg: 13.0, structural_ppg: 11.0, ensemble_shift: 2.0,
    params: { crafted: true }, player_week_engine: { cutoff: '2026-W5', mode: 'weekly' } };
  ENGINE.set(Q.id, QPROJ);
  WEEK_LINES[`${Q.team}|6`] = { pass_mult: 1.3, rush_mult: 0.8, line: { spread: -4, total: 49, opponent: 'OPP', home: true } };
  const id = saveFit(FIT_GS);
  coordinator.promoteFantasyCoordinatorFit(id, { windows: BOTH, evidence: EVIDENCE });
  const thisWeek = coordinator.weeklyExpertValues(QPROJ, 2026, 6, PPR);
  const lastWeek = coordinator.weeklyExpertValues(QPROJ, 2026, 5, PPR);
  assert.ok(Math.abs(thisWeek.game_script_delta - 3.6) < 1e-9, `week 6 has a line: 12 x (1.3 - 1), got ${thisWeek.game_script_delta}`);
  assert.equal(lastWeek.game_script_delta, null, 'week 5 has none');
  assert.ok(FIT_GS.shrinkage.game_script_delta.k > 0.1, `the game-script input carries weight (k ${FIT_GS.shrinkage.game_script_delta.k})`);
  const want = coordinator.coordinateFantasy(FIT_GS, thisWeek, QPROJ.structural_ppg).corrected_ppg;
  const stale = coordinator.coordinateFantasy(FIT_GS, lastWeek, QPROJ.structural_ppg).corrected_ppg;
  // corrected_ppg is rounded to 0.001; a gap of 0.05 is fifty rounding steps.
  assert.ok(Math.abs(want - stale) > 0.05, `this week's line must move the correction (${want} vs ${stale}), or this test proves nothing`);
  const a = assetUniverse(L, FORMAT, { season: 2026, week: 6 }).get(Q.id);
  assert.equal(a.fantasy_coordinator.corrected_ppg, want, 'built from week 6\'s line, not week 5\'s');
  assert.equal(a.current_week_ppg, served(want, a));
  assert.equal(coordinator.weeklyProjectionFor(Q.id, { season: 2026, week: 6 }).corrected_ppg, want, 'the player page too');
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

/** Every server .js file, relative to server/, with its source (comments stripped for call checks). */
function serverSources() {
  const root = new URL('../server/', import.meta.url).pathname;
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push({ file: path.relative(root, full), src: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(root);
  return out;
}
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

test('no served module calls gameScriptLift, the unswitched copy of the lift that studies read', () => {
  const hits = serverSources().filter(s => /\bgameScriptLift\b/.test(s.src)).map(s => s.file);
  assert.deepEqual(hits.filter(f => f !== path.join('services', 'waiver-brain.js')), []);
});

test('the betting line reaches a fantasy number only through the switch, or as a named, owned follow-up', () => {
  // Every module that CALLS gameScriptFor. Two fantasy producers still multiply sampled
  // volume by its multipliers outside vegasLift; they are listed with the unit that owns
  // them, so no third one can appear unlisted and a fixed one has to leave the list.
  const callers = serverSources().filter(s => /\bgameScriptFor\s*\(/.test(stripComments(s.src))).map(s => s.file).sort();
  const svc = f => path.join('services', f);
  const NOT_THE_LIFT = {
    [svc('gamescript.js')]: 'defines it',
    [svc('waiver-brain.js')]: 'gameScriptLift, which served code reads only through vegasLift (the switch)',
    [svc('fantasy-coordinator.js')]: 'the coordinator\'s own input (game_script_delta), fitted and graded inside it (S-02, S-03)',
    [svc('betting-fantasy-link.js')]: 'betting side: routes/nfl-betting.js',
    [svc('nfl-context-heads.js')]: 'betting-side head research',
    [svc('nfl-prop-head-validation.js')]: 'player-prop validation',
    [svc('nfl-props.js')]: 'player props'
  };
  const STILL_APPLY_THE_LIFT = {
    [svc('ceiling-lineup.js')]: 'S-06: the Ceiling tab draws week-N volume x the line (ceiling-lineup.js:108-110)',
    [svc('season-sim.js')]: 'S-05: the season simulation draws every week x the line (season-sim.js:224-225)'
  };
  assert.ok(callers.length >= 3, `the scan finds callers at all (known-nonzero control): ${callers.join(', ')}`);
  assert.deepEqual(callers.filter(f => !(f in NOT_THE_LIFT) && !(f in STILL_APPLY_THE_LIFT)), [],
    'a new module applies the betting line outside the switch: route it through vegasLift, or list it with its owner');
  for (const f of Object.keys(STILL_APPLY_THE_LIFT)) {
    assert.ok(callers.includes(f), `${f} no longer calls gameScriptFor: take it off this list and off gridiron-model.js's note`);
  }
  // The model registry says the same thing the code does: off in vegasLift, still on in the two above.
  const cap = modelMap().capabilities.find(c => c.id === 'crossover.vegas_to_fantasy');
  for (const f of Object.keys(STILL_APPLY_THE_LIFT)) assert.match(cap.note, new RegExp(path.basename(f).replace('.', '\\.')), cap.note);
  assert.doesNotMatch(cap.note, /every served number/i);
});

test('a failed game-script read is logged, and the switched-off lift carries no field nothing reads', t => {
  const logged = t.mock.method(console, 'error', () => {});
  const failed = waiverBrain.vegasLift({ team_abbr: 'ZZT', position: 'WR' }, 2026, 2);
  assert.equal(failed.multiplier, 1);
  assert.equal(failed.applied, false);
  assert.equal(logged.mock.callCount(), 1, 'the failure reaches the log');
  assert.match(logged.mock.calls[0].arguments.map(String).join(' '), /game-script/i);
  // What the served callers read: lineup-brain.js keeps reading/multiplier/applied, trade-engine
  // keeps applied/multiplier, horizonValueWithVegas keeps applied/multiplier. Nothing else.
  for (const lift of [failed, waiverBrain.vegasLift({ team_abbr: 'ARI', position: 'WR' }, 2026, 2)]) {
    assert.deepEqual(Object.keys(lift).sort(), ['applied', 'line', 'multiplier', 'reading']);
  }
});

// ------------------------------------------- the label on the surfaces that show this week's points

// The phrases that say a betting-line adjustment is IN this week's number. While the switch is
// off, no served basis sentence and no page may say them.
const LIFT_CLAIMS = [/\b(with|and|x|×|times|plus)\s+the\s+betting[- ]line/i, /betting[- ]line\s+(adjustment\s+)?included/i];
const claimsLift = s => LIFT_CLAIMS.some(r => r.test(String(s ?? '')));

test('the lift-claim check recognises every sentence the pages carried before S-03 (known-nonzero control)', () => {
  for (const old of [
    'Start/Sit week points: this week\'s projection x the betting-line game-script adjustment',
    'Both totals are the Start/Sit week points (this week\'s projection with the betting-line adjustment)',
    'Uses THIS WEEK\'s projection (Week 3: matchup, byes, injury odds and the betting line)',
    'Week 3 projection: this Sunday\'s game (0 on a bye) and injury odds, with the betting line\'s game script',
    'What "You" and "Them" are summed from: the Start/Sit week points, betting line included.'
  ]) assert.ok(claimsLift(old), old);
  assert.equal(claimsLift('This week\'s points: our weekly projection, times his chance to play. No betting-line boost.'), false);
});

// An ESPN league whose one rostered starter is the fixture player P, priced by the REAL universe.
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
     VALUES (303, 'espn', 's03-303', 2026, 'S-03 label', '1', 10, 1, ?, ?)`,
JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BENCH']), JSON.stringify({ teams: [{ id: 1, roster: { entries: [
  { lineupSlotId: 4, playerPoolEntry: { player: { id: 7001, fullName: P.name, defaultPositionId: 3, injuryStatus: 'ACTIVE' } } }
] } }] }));
const L303 = () => row('SELECT * FROM leagues WHERE id = 303');
const labelOf = lg => assetUniverse(lg, deriveFormat(lg).formatKey).context.week_basis;

test('the League Hub card serves the week\'s basis, and its note does not claim the lift', () => {
  assert.equal(waiverBrain.BETTING_LINE_LIFT.on, false);
  const d = lineupDiff(L303(), '1');
  assert.ifError(d.error);
  assert.deepEqual(d.week_basis, labelOf(L303()), 'the one produced label, not a second sentence');
  assert.match(d.week_basis.label, /no betting-line/i);
  assert.equal(claimsLift(d.note), false, d.note);
  // A caller that prices the players itself (plain assets, no context) still gets the label.
  const asset = { id: 5101, name: 'Plain Receiver', position: 'WR', team_abbr: 'ARI', espn_id: 5101, available: true,
    current_week_ppg: 10, adj_ppg: 10, ppg: 10, active_probability: 0.95, bye: 9, matchup: { opponent: 'OPP' } };
  const plain = lineupDiff({ ...L303(), payload: JSON.stringify({ teams: [{ id: 1, roster: { entries: [
    { lineupSlotId: 4, playerPoolEntry: { player: { id: 5101, fullName: 'Plain Receiver', defaultPositionId: 3, injuryStatus: 'ACTIVE' } } }
  ] } }] }) }, '1', { assets: new Map([[asset.id, asset]]) });
  assert.ifError(plain.error);
  assert.equal(plain.week_basis?.betting_line_lift?.on, false);
  assert.equal(claimsLift(plain.note), false, plain.note);
});

test('the matchup card on Start/Sit serves the week\'s basis, and its projection basis does not claim the lift', () => {
  const card = lineupPosture(L303(), {});
  assert.ifError(card.error);
  const label = labelOf(L303());
  assert.deepEqual(card.week_basis, label);
  assert.equal(claimsLift(card.projection_basis), false, card.projection_basis);
  assert.ok(card.projection_basis.includes(label.label), `the basis sentence carries the produced label: ${card.projection_basis}`);
});

test('the Start/Sit matchup card and the League Hub card render the week\'s basis, and no page claims the lift', () => {
  const read = f => fs.readFileSync(new URL(`../client/src/${f}`, import.meta.url), 'utf8');
  for (const f of ['components/lineup/MatchupPosture.tsx', 'pages/MyTeam.tsx']) {
    assert.match(read(f), /week_basis\?\.label/, `${f} renders the served label`);
  }
  const pages = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx|ts)$/.test(entry.name)) pages.push(full);
    }
  };
  walk(new URL('../client/src/', import.meta.url).pathname);
  assert.ok(pages.length > 20, `the scan reads the client (${pages.length} files)`);
  assert.deepEqual(pages.filter(f => claimsLift(fs.readFileSync(f, 'utf8'))).map(f => path.basename(f)), [],
    'a page says the betting line is in this week\'s number while BETTING_LINE_LIFT is off');
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
