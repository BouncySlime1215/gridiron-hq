/**
 * RL-8-1: the in-season touchdown-luck signal no longer weights the football verdict or
 * the Start/Sit call.
 *
 * R&D r8 (rnd/loop/r8-external-regression-tag-priced.md, graded 2021-24): after the
 * consensus rest-of-season rank, a point per game of points-over-expected is worth about
 * 0 rest-of-season points per game, and real trade partners price most of it. The
 * player-case `td_luck` factor (weight up to 1.2, enough on its own to flip the ±0.8
 * verdict line) and lineup-brain's "Running hot" / "Due to score" flag were acting on a
 * priced signal.
 *
 * Rules pinned here:
 *   - a player on the touchdown-regression board gets the SAME football case (factors,
 *     net lean, verdict) and the SAME Start/Sit call (slot, who he beat, margin, label,
 *     win rate) as the same player off the board;
 *   - no call carries a td_luck factor or a caution/upside flag;
 *   - the registry entry fantasy.td_regression may inform but may not rank;
 *   - the td-regression.js header no longer calls the gap an inefficiency;
 *   - the PRESEASON feature td_luck_pg_1 is untouched (a fitted, tested feature).
 *
 * The regression board is injected by mocking td-regression.js, so the old code path is
 * exercised with a real hot/cold board and no play-by-play fixtures; the solver, roster
 * loading and slot rules are real (fixtures follow test/lineup-floor-objective.test.js).
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-td-luck-retired-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.NFL_WEEK = '3';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const realTradeEngine = await import('../server/services/trade-engine.js');
const realWaiverBrain = await import('../server/services/waiver-brain.js');
const realTdRegression = await import('../server/services/td-regression.js');

let assets = new Map();
mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realTradeEngine,
    assetUniverse: () => assets,
    tradeWeekContext: () => ({ season: 2026, week: 3 }),
    lineupDiff: () => ({ error: 'not under test' })
  }
});
mock.module('../server/services/waiver-brain.js', {
  namedExports: { ...realWaiverBrain, vegasLift: () => ({ multiplier: 1, line: null, applied: false }) }
});

// The board every consumer reads. EMPTY is the unflagged baseline.
const EMPTY = { season: 2026, positive_regression: [], negative_regression: [] };
let board = EMPTY;
let boardCalls = 0;
mock.module('../server/services/td-regression.js', {
  namedExports: {
    ...realTdRegression,
    regressionCandidates: () => { boardCalls++; return board; }
  }
});

const { lineupCall } = await import('../server/services/lineup-brain.js');
const playerCaseModule = await import('../server/services/player-case.js');
const { playerCase } = playerCaseModule;
const { modelMap, ask } = await import('../server/services/gridiron-model.js');
const { FEATURE_NAMES } = await import('../server/services/preseason-model.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// player-case memoised the board per season; clear it between runs where that exists.
const resetCaches = () => { playerCaseModule.clearPlayerCaseCache?.(); };

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
let nextId = 1;
function player(name, position, week) {
  const id = nextId++;
  return {
    asset: {
      id, name, position, team_abbr: 'MID', espn_id: 9000 + id, available: true,
      current_week_ppg: week, adj_ppg: week, ppg: week, ros_ppg: week,
      ceiling: +(week * 1.5).toFixed(2), floor: +(week * 0.4).toFixed(2), active_probability: 0.85, bye: 9
    },
    entry: {
      lineupSlotId: 20,
      playerPoolEntry: { player: { id: 9000 + id, fullName: name, defaultPositionId: POS_ID[position], injuryStatus: 'ACTIVE' } }
    }
  };
}

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
let leagueSeq = 1800;
function league(mine) {
  const id = leagueSeq++;
  assets = new Map(mine.map(p => [p.asset.id, p.asset]));
  const payload = { teams: [{ id: 1, name: 'Mine', roster: { entries: mine.map(p => p.entry) } }], schedule: [] };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, 'espn', ?, 2026, 'TD luck retired', '1', 10, 1, ?, ?)`,
  id, `tl-${id}`, JSON.stringify(SLOTS), JSON.stringify(payload));
  return id;
}

function roster() {
  return [
    player('Star Quarterback', 'QB', 22.4), player('Backup Quarterback', 'QB', 13.9),
    player('Back One', 'RB', 15.2), player('Back Two', 'RB', 12.8), player('Backup Back', 'RB', 6.1),
    player('Hot Receiver', 'WR', 16.0), player('Wideout Two', 'WR', 11.7), player('Backup Wideout', 'WR', 5.5),
    player('Tight End', 'TE', 8.3)
  ];
}

// Hot: 5 touchdowns on 1.4 expected, a +3 ppg swing (old weight min(1.2, 3/2) = 1.2).
const HOT = { player_id: '00-HOT', name: 'Hot Receiver', position: 'WR', actual: 5, expected: 1.4, ppg_swing: 3 };
// Cold: 0 touchdowns on 3.1 expected, a -2.4 ppg swing.
const COLD = { player_id: '00-COLD', name: 'Back Two', position: 'RB', actual: 0, expected: 3.1, ppg_swing: -2.4 };
const FLAGGED = { season: 2026, positive_regression: [COLD], negative_regression: [HOT] };

/** Everything a Start/Sit call decides or says about a starter. */
const decision = call => call.lineup.map(c => ({
  slot: c.slot, player: c.player.name, over: c.over?.name ?? null,
  margin: c.margin, confidence: c.confidence, win_rate: c.confidence_win_rate,
  verdict: c.football?.verdict ?? null, net_lean: c.football?.net_lean ?? null,
  factors: (c.football?.factors ?? []).map(f => `${f.kind}:${f.direction}:${f.weight}`),
  caution: c.caution ?? null, upside: c.upside ?? null
}));

test('a player on the touchdown-regression board gets the same Start/Sit call as off it', () => {
  const id = league(roster());

  board = EMPTY; resetCaches();
  const baseline = lineupCall(id, { objective: 'mean', providers: {} });
  assert.ifError(baseline.error);

  board = FLAGGED; resetCaches();
  const flagged = lineupCall(id, { objective: 'mean', providers: {} });
  assert.ifError(flagged.error);

  const hot = decision(flagged).find(c => c.player === 'Hot Receiver');
  const cold = decision(flagged).find(c => c.player === 'Back Two');
  assert.ok(hot && cold, 'both flagged players start in this fixture');
  assert.deepEqual(hot.factors.filter(f => f.startsWith('td_luck')), [], 'no td_luck factor on the hot starter');
  assert.deepEqual(cold.factors.filter(f => f.startsWith('td_luck')), [], 'no td_luck factor on the cold starter');
  assert.equal(hot.caution, null, 'no "Running hot" flag');
  assert.equal(cold.upside, null, 'no "Due to score" flag');
  assert.deepEqual(decision(flagged), decision(baseline),
    'the verdict and the Start/Sit call are identical with and without the regression board');
  board = EMPTY;
});

test('the football case gives zero weight to the regression board', () => {
  const p = { id: 1, name: 'Hot Receiver', position: 'WR', team_abbr: 'MID' };
  board = EMPTY; resetCaches();
  const off = playerCase(p, 2026, 3, { regression: { positive: [], negative: [] } });
  board = FLAGGED; resetCaches();
  const on = playerCase(p, 2026, 3, { regression: { positive: [COLD], negative: [HOT] } });
  const strip = c => ({ factors: c.factors, net_lean: c.net_lean, verdict: c.verdict, headline: c.headline });
  assert.deepEqual(strip(on), strip(off), 'a hot flag moves no factor, lean or verdict');
  assert.equal(on.factors.some(f => f.kind === 'td_luck'), false);
  board = EMPTY;
});

test('the Start/Sit path no longer reads the regression board at all', () => {
  const id = league(roster());
  board = FLAGGED; resetCaches(); boardCalls = 0;
  lineupCall(id, { objective: 'mean', providers: {} });
  assert.equal(boardCalls, 0, 'lineupCall (and the football case under it) must not call regressionCandidates');
  board = EMPTY;
});

test('source: player-case.js and lineup-brain.js carry no td_luck / fpoe / regression-board reads', () => {
  const pattern = /td_luck|tdLuck|fpoe|regressionCandidates|td-regression\.js/i;
  const read = f => fs.readFileSync(new URL(`../server/services/${f}`, import.meta.url), 'utf8');
  // Known-nonzero control: the same pattern finds the preseason feature.
  assert.match(read('preseason-model.js'), pattern, 'control: the pattern must find td_luck_pg_1');
  for (const f of ['player-case.js', 'lineup-brain.js']) {
    const hits = read(f).split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => pattern.test(l));
    assert.deepEqual(hits, [], `${f} still reads the touchdown-luck signal`);
  }
});

test('registry: fantasy.td_regression may inform but may not rank or decide', () => {
  const cap = modelMap().capabilities.find(c => c.id === 'fantasy.td_regression');
  assert.ok(cap, 'the entry stays on the record so it is not rebuilt unread');
  assert.equal(cap.authority, 'research');
  assert.match(cap.refuses ?? '', /consensus/i, 'the refusal names why: consensus already prices it');
  assert.equal(ask('fantasy.td_regression', { purpose: 'inform' }).permitted, true);
  assert.equal(ask('fantasy.td_regression', { purpose: 'rank' }).permitted, false);
});

test('td-regression.js header no longer claims the gap is a market inefficiency', () => {
  const src = fs.readFileSync(new URL('../server/services/td-regression.js', import.meta.url), 'utf8');
  const header = src.slice(0, src.indexOf('*/'));
  assert.doesNotMatch(header, /most reliable inefficiency|profitable half|almost nobody plays it/i);
  assert.match(header, /priced/i, 'the header states that consensus prices it');
});

test('preseason feature td_luck_pg_1 is untouched', () => {
  assert.equal(FEATURE_NAMES[16], 'td_luck_pg_1', 'feature index 16 is still points over expected');
  const src = fs.readFileSync(new URL('../server/services/preseason-model.js', import.meta.url), 'utf8');
  assert.match(src, /td_luck_pg_1: tdLuck,/, 'the feature row still computes it');
  assert.match(src, /td_luck_pg_1: 'points over expected'/, 'the driver label is still there');
});

// Skeptic round 1: removing both production importers stranded td-regression.js and
// turned `node scripts/wiring-map.mjs --check` red. It is kept on purpose (research
// only), so it is baselined out loud with a reason and a retire-when, not silently.
test('td-regression.js is a declared orphan with a retire-when, and nothing claims a surface for it', () => {
  const ann = JSON.parse(fs.readFileSync(new URL('../docs/wiring/annotations.json', import.meta.url), 'utf8'));
  const mod = 'server/services/td-regression.js';
  assert.ok(ann.accepted_orphan_modules.includes(mod), 'baselined in accepted_orphan_modules');
  const why = ann._PERMANENT_ORPHAN_REASONS?.[mod] ?? '';
  assert.match(why, /RETIRE THIS ENTRY WHEN/, 'the reason names what retires it');
  assert.match(why, /Owner:/, 'the reason names an owner');
  for (const f of ['player-case.js', 'gridiron-model.js', 'td-regression.js']) {
    const src = fs.readFileSync(new URL(`../server/services/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /board stays readable|It may explain a line|may\s+\*?\s*EXPLAIN a line/,
      `${f} does not promise an explanation surface that no code reaches`);
  }
});
