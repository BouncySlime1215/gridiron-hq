/**
 * "Chase the ceiling" / "Protect the floor" must not print a win rate or a Clear / Lean /
 * Coin flip label measured on something else (RL-3-4, C-18 / S-08).
 *
 * Under a non-mean objective lineupCall's margin is a gap between two players' p90s (or
 * p10s). The labels (CLEAR_THRESHOLD / TIE_THRESHOLD) and decisionWinRate() were measured
 * on week_points gaps (docs/evidence/2026-09-22/start-sit-decision-curve.md), so on a
 * ceiling gap the page printed "has won about 90% of the time" and a "Clear" chip on a
 * basis the server itself tagged `uncalibrated_for_ceiling` — and the page never read
 * the tag.
 *
 * Rules pinned here:
 *   - objective ceiling/floor: every call's confidence_win_rate is null, no `why` says
 *     "has won", no call carries a clear/lean/coin flip label, confidence_basis stays
 *     uncalibrated_for_<objective>;
 *   - objective mean (control): the numeric rate, the wording and the labels are kept;
 *   - the Start/Sit page, rendered from lineupCall's own output, prints the "no call is
 *     graded" line and a "Not graded" chip under ceiling/floor, and neither under mean.
 *
 * Fixtures follow test/lineup-floor-objective.test.js: the asset universe is mocked, the
 * solver, roster loading and slot rules are real.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ceiling-uncal-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.NFL_WEEK = '3';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const realTradeEngine = await import('../server/services/trade-engine.js');
const realWaiverBrain = await import('../server/services/waiver-brain.js');

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

const { lineupCall } = await import('../server/services/lineup-brain.js');

// The page half, rendered for real (the pattern of test/start-sit-gate-panel.test.js): the
// TSX is compiled with the repo's TypeScript, every import but React is stubbed, the data
// hook returns lineupCall's own output as the route sends it (res.json at
// server/routes/trades.js:220), and React renders the markup. A source grep cannot tell a
// condition from its inverse, or a 'Not graded' chip from a 'Lean' one; the markup can.
const repoRequire = createRequire(new URL('../package.json', import.meta.url));
async function compileLineupPage() {
  const dir = fs.mkdtempSync(path.join(temp, 'page-'));
  const write = (name, text) => { fs.writeFileSync(path.join(dir, name), text); return pathToFileURL(path.join(dir, name)).href; };
  const cjs = spec => `import { createRequire } from 'node:module';
const m = createRequire(${JSON.stringify(repoRequire.resolve(spec))})(${JSON.stringify(repoRequire.resolve(spec))});`;
  const stubs = {
    "'react'": write('react.mjs', `${cjs('react')}\nexport default m; export const useMemo = m.useMemo; export const useState = m.useState;`),
    '"react/jsx-runtime"': write('jsx-runtime.mjs', `${cjs('react/jsx-runtime')}
export const jsx = m.jsx; export const jsxs = m.jsxs; export const Fragment = m.Fragment;`),
    "'../api'": write('api.mjs', `export function useApi(p) {
  return { data: p && p.includes('/lineup?') ? globalThis.__lineupPayload : null, loading: false, error: null, refetch() {} };
}`),
    "'../state/league'": write('league.mjs', 'export function useLeague() { return { activeId: 901 }; }'),
    "'../components/lineup/EvidenceStrip'": write('evidence.mjs', 'export default function EvidenceStrip() { return null; }\nexport function RecordLine() { return null; }'),
    "'../components/PageExplainContext'": write('explain.mjs', 'export function usePageExplain() {}'),
    "'../components/PageState'": write('state.mjs', 'export function PageLoading() { return null; }\nexport function PageError() { return null; }\nexport function EmptyState() { return null; }\nexport function logServerDetail() {}'),
    "'../components/lineup/WaiverWire'": write('waiver.mjs', 'export default function WaiverWire() { return null; }\nexport function WaiverTeaser() { return null; }\nexport function onATeam() { return true; }'),
    "'../components/lineup/StreamingBoard'": write('streaming.mjs', 'export default function StreamingBoard() { return null; }'),
    "'../components/lineup/MatchupPosture'": write('posture.mjs', 'export default function MatchupPosture() { return null; }'),
    "'../components/lineup/StartSitGate'": write('gate.mjs', 'export default function StartSitGate() { return null; }')
  };
  const source = fs.readFileSync(new URL('../client/src/pages/Lineup.tsx', import.meta.url), 'utf8');
  let { outputText: compiled } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  });
  for (const [from, to] of Object.entries(stubs)) {
    assert.ok(compiled.includes(from), `the compiled page imports ${from}`);
    compiled = compiled.split(from).join(`'${to}'`);
  }
  return (await import(write('Lineup.mjs', compiled))).default;
}
const Lineup = await compileLineupPage();
// Compiled here, before the first test() and before test.after is registered: node:test
// starts running already-registered tests while this module is still at a top-level
// await, so a compile placed after them raced test.after's rmSync of `temp` (CI: ENOENT
// on page-*/Lineup.mjs, "asynchronous activity after the test ended").

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
let nextId = 1;
function player(name, position, week, ceiling, floor) {
  const id = nextId++;
  return {
    asset: {
      id, name, position, team_abbr: 'MID', espn_id: 9000 + id, available: true,
      current_week_ppg: week, adj_ppg: week, ppg: week, ros_ppg: week,
      ceiling, floor, active_probability: 0.95, bye: 9
    },
    entry: {
      lineupSlotId: 20,
      playerPoolEntry: { player: { id: 9000 + id, fullName: name, defaultPositionId: POS_ID[position], injuryStatus: 'ACTIVE' } }
    }
  };
}

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
let leagueSeq = 900;
function league(mine) {
  const id = leagueSeq++;
  assets = new Map(mine.map(p => [p.asset.id, p.asset]));
  const payload = { teams: [{ id: 1, name: 'Mine', roster: { entries: mine.map(p => p.entry) } }], schedule: [] };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, 'espn', ?, 2026, 'Ceiling uncalibrated', '1', 10, 1, ?, ?)`,
  id, `cu-${id}`, JSON.stringify(SLOTS), JSON.stringify(payload));
  return id;
}

/**
 * Ceiling gaps span every band the week_points labels have: a 15-point QB gap (the
 * "about 90%" band on a mean margin), mid gaps, and a sub-1.5 TE gap (the "coin flip"
 * band). Week_points gaps do the same, so the mean control has rates and labels to keep.
 */
function roster() {
  return [
    player('Star Quarterback', 'QB', 24.0, 38.0, 12.0), player('Backup Quarterback', 'QB', 12.0, 23.0, 5.0),
    player('Back One', 'RB', 17.0, 30.0, 7.0), player('Back Two', 'RB', 13.0, 25.0, 6.0),
    player('Back Three', 'RB', 7.0, 14.0, 2.0),
    player('Wideout One', 'WR', 16.0, 29.0, 6.5), player('Wideout Two', 'WR', 12.5, 24.0, 5.5),
    player('Wideout Three', 'WR', 10.0, 20.0, 3.0), player('Wideout Four', 'WR', 4.0, 9.0, 1.0),
    player('Tight End', 'TE', 8.0, 16.0, 3.5), player('Backup Tight End', 'TE', 7.4, 15.2, 3.2)
  ];
}

const LABELS = new Set(['clear', 'lean', 'coin flip']);

for (const objective of ['ceiling', 'floor']) {
  test(`objective ${objective}: no win rate, no "has won" sentence, no week_points label on a ${objective} gap`, () => {
    const id = league(roster());
    const call = lineupCall(id, { objective, providers: {} });
    assert.ifError(call.error);
    assert.equal(call.objective_used, objective, `the ${objective} key ranks these players, so it is optimised`);
    assert.equal(call.confidence_basis, `uncalibrated_for_${objective}`);
    const compared = call.lineup.filter(c => c.margin != null);
    assert.ok(compared.length >= 5, `known-nonzero control: ${compared.length} calls carry a ${objective} margin`);
    for (const c of call.lineup) {
      assert.equal(c.confidence_win_rate, null,
        `${c.slot} ${c.player.name}: margin ${c.margin} is a ${objective} gap; decisionWinRate was measured on week_points`);
      assert.doesNotMatch(c.why, /has won/, `${c.slot} ${c.player.name}: "${c.why}"`);
      assert.ok(!LABELS.has(c.confidence), `${c.slot} ${c.player.name}: label "${c.confidence}" on a ${objective} gap`);
    }
    for (const c of compared) {
      assert.equal(c.confidence, 'not measured');
      assert.match(c.why, objective === 'ceiling' ? /good-week ceiling/ : /bad-week floor/,
        'the sentence says what the gap is between');
      assert.match(c.why, /no win rate/i, 'and that no rate was measured for it');
    }
    assert.equal(call.coin_flips, 0, 'no call is called a tie on a basis nobody measured');
  });
}

test('objective mean (control): the measured rate, its wording and the labels are kept', () => {
  const id = league(roster());
  const call = lineupCall(id, { objective: 'mean', providers: {} });
  assert.ifError(call.error);
  assert.equal(call.objective_used, 'week_points');
  assert.equal(call.confidence_basis, 'calibrated_on_week_points');
  const rated = call.lineup.filter(c => typeof c.confidence_win_rate === 'number');
  assert.ok(rated.length >= 1, 'at least one week_points margin reaches a curve anchor');
  for (const c of rated) {
    assert.match(c.why, /has won about [\d.]+% of the time/, `${c.slot} ${c.player.name}: "${c.why}"`);
  }
  const qb = call.lineup.find(c => c.slot === 'QB');
  assert.equal(qb.margin, 12);
  assert.equal(qb.confidence, 'clear');
  assert.equal(typeof qb.confidence_win_rate, 'number');
  const te = call.lineup.find(c => c.slot === 'TE');
  assert.equal(te.confidence, 'coin flip', 'a 0.6 week_points gap is still called a tie');
  assert.match(te.why, /has won [\d.]+% of the time, so this is a tie/);
});

test('a ceiling request that fell back to week_points keeps the measured rate (the margins ARE week_points gaps)', () => {
  // The predicate is the objective actually solved on, not the one asked for: when every
  // ceiling ties, the lineup is solved on week_points and says so, and its margins are
  // exactly what the curve measured. Keying on the request would blank a real rate.
  const flat = roster();
  for (const p of flat) p.asset.ceiling = 20;
  const id = league(flat);
  const call = lineupCall(id, { objective: 'ceiling', providers: {} });
  assert.ifError(call.error);
  assert.equal(call.objective, 'ceiling');
  assert.equal(call.objective_used, 'week_points', 'a key that ranks no one falls back');
  assert.match(call.objective_fallback ?? '', /ceiling/);
  assert.equal(call.confidence_basis, 'calibrated_on_week_points');
  const qb = call.lineup.find(c => c.slot === 'QB');
  assert.equal(qb.confidence, 'clear');
  assert.equal(typeof qb.confidence_win_rate, 'number');
  assert.match(qb.why, /has won about [\d.]+% of the time/);
});

const clean = h => h.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
/** Render the page on one lineupCall result, serialised the way the route sends it. */
function renderPage(call) {
  globalThis.__lineupPayload = JSON.parse(JSON.stringify(call));
  const html = renderToStaticMarkup(React.createElement(Lineup));
  // Slot chips: the only `rounded-full px-2 py-0.5 ... ring-1` spans on the page (Lineup.tsx Slot).
  const chips = [...html.matchAll(/<span class="rounded-full px-2 py-0\.5[^"]*ring-1[^"]*">([\s\S]*?)<\/span>/g)]
    .map(m => clean(m[1]));
  return { text: clean(html), chips };
}
const GRADES = ['Clear', 'Lean', 'Coin flip'];
const NO_GRADE_LINE = /not projections\. Our win rates were measured on projections only, so no call is graded\./;

for (const objective of ['ceiling', 'floor']) {
  test(`the Start/Sit page, rendered on a ${objective} lineup: the "no call is graded" line and a "Not graded" chip, no Clear/Lean/Coin flip`, () => {
    const call = lineupCall(league(roster()), { objective, providers: {} });
    assert.ifError(call.error);
    assert.equal(call.confidence_basis, `uncalibrated_for_${objective}`);
    const { text, chips } = renderPage(call);
    assert.equal(chips.length, call.lineup.length, `known-nonzero control: one chip per slot (${chips.join(', ')})`);
    assert.match(text, NO_GRADE_LINE, 'the hero line says nothing on this page is graded');
    assert.match(text, objective === 'ceiling' ? /Gaps below are between good-week ceilings/ : /Gaps below are between bad-week floors/);
    assert.doesNotMatch(text, /ties inside the model's own error|Every call has a real margin behind it/);
    const compared = call.lineup.filter(c => c.margin != null).length;
    assert.equal(chips.filter(c => c === 'Not graded').length, compared, `every compared slot is chipped "Not graded": ${chips.join(', ')}`);
    for (const g of GRADES) assert.ok(!chips.includes(g), `a "${g}" chip on a ${objective} gap: ${chips.join(', ')}`);
    assert.doesNotMatch(text, /has won/);
  });
}

test('the Start/Sit page, rendered on the average lineup (control): graded chips and the tie line, no "no call is graded"', () => {
  const call = lineupCall(league(roster()), { objective: 'mean', providers: {} });
  assert.ifError(call.error);
  assert.equal(call.confidence_basis, 'calibrated_on_week_points');
  const { text, chips } = renderPage(call);
  assert.equal(chips.length, call.lineup.length, `one chip per slot (${chips.join(', ')})`);
  assert.doesNotMatch(text, NO_GRADE_LINE, 'a measured basis is not called ungraded');
  assert.ok(!chips.includes('Not graded'), `a "Not graded" chip on a week_points gap: ${chips.join(', ')}`);
  assert.ok(chips.includes('Clear') && chips.includes('Coin flip'), `the measured labels stay: ${chips.join(', ')}`);
  assert.match(text, /\d+ of these calls are ties inside the model's own error/);
  assert.match(text, /has won about [\d.]+% of the time/);
});
