/**
 * BUY-LOW (queue item 22): usage up, points down. Detector rule v1 (docs/tdd/BUY-LOW-PREREG.md),
 * its reader, and the shadow hook into Go get targets (GRIDIRON_BUY_LOW=1 only).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-buy-low-'));
process.env.GRIDIRON_DB_PATH ??= path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const {
  scoreBuyLow, shrinkGap, buyLowEnabled, buyLowPositions, BUY_LOW_TE_ENV, BUY_LOW_ENV, BUY_LOW_RULE, tieBreakSuggestions, applyBuyLow,
  annotateEntryTargets, buyLowForRun, usageOf, scoreBuyLowV2, BUY_LOW_V2_RULE, SERVED_POSITIONS, SERVED_RULE,
} = await import('../server/services/campaign/buy-low.js');
const { readBuyLow } = await import('../server/services/campaign/buy-low-inputs.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { buildPlansFile } = await import('../scripts/campaign/produce-plans.mjs');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');

const S = 2025;
/** A WR: last season 12% share, this season weeks 1-2 at 12%, weeks 3-5 at 25% with points well under xFP. */
const wrGames = () => [
  ...[1, 2, 3, 4, 5, 6].map(w => ({ season: S - 1, week: w, xfp: 10, act: 10, target_share: 0.12 })),
  { season: S, week: 1, xfp: 10, act: 10, target_share: 0.12 },
  { season: S, week: 2, xfp: 10, act: 10, target_share: 0.12 },
  { season: S, week: 3, xfp: 16, act: 8, target_share: 0.25 },
  { season: S, week: 4, xfp: 16, act: 8, target_share: 0.25 },
  { season: S, week: 5, xfp: 16, act: 8, target_share: 0.25 },
];

test('flag: only GRIDIRON_BUY_LOW=1; preview never switches it on', () => {
  assert.equal(BUY_LOW_ENV, 'GRIDIRON_BUY_LOW');
  assert.equal(buyLowEnabled({}), false);
  assert.equal(buyLowEnabled({ GRIDIRON_BUY_LOW: '0' }), false);
  assert.equal(buyLowEnabled({ GRIDIRON_BUY_LOW: 'true' }), false);
  assert.equal(buyLowEnabled({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), false);
  assert.equal(buyLowEnabled({ GRIDIRON_BUY_LOW: '1' }), true);
});

test('usage: WR/TE target share, RB carries + 2.5 x targets, QB xFP', () => {
  assert.equal(usageOf('WR', { target_share: 0.2 }), 0.2);
  assert.equal(usageOf('RB', { carries: 10, targets: 4 }), 20);
  assert.equal(usageOf('QB', { xfp: 18 }), 18);
  assert.equal(usageOf('WR', {}), null);
  assert.equal(usageOf('K', { xfp: 9 }), null);
});

test('confirmed buy-low: 3 games of usage up, gap 8 shrunk to 8 x 3/5', () => {
  const r = scoreBuyLow({ position: 'WR', games: wrGames() }, { season: S, week: 6 });
  assert.equal(r.status, 'ok');
  assert.equal(r.role, 'confirmed');
  assert.equal(r.buy_low, true);
  assert.equal(r.games, 3);
  assert.ok(Math.abs(r.gap - 8) < 1e-9);
  assert.ok(Math.abs(r.gap_shrunk - 8 * 3 / 5) < 1e-9);
  assert.equal(r.score, r.gap_shrunk);
  assert.equal(r.through_week, 5);
});

test('detected: one game of usage up (the latest) detects, it does not confirm', () => {
  const games = wrGames().map(g => (g.season === S && g.week < 5 ? { ...g, target_share: 0.12 } : g));
  const r = scoreBuyLow({ position: 'WR', games }, { season: S, week: 6 });
  assert.equal(r.role, 'detected');
  assert.equal(r.ups, 1);
});

test('shrinkage: toward 0 by n / (n + 2); a 1-game gap keeps a third', () => {
  assert.equal(BUY_LOW_RULE.shrink_games, 2);
  assert.ok(Math.abs(shrinkGap(9, 1) - 3) < 1e-9);
  assert.ok(Math.abs(shrinkGap(9, 3) - 5.4) < 1e-9);
  assert.equal(shrinkGap(9, 0), 0);
  // One game at gap 5: detected, shrunk to 1.67 < 2, so not flagged. The same gap over 3 games is.
  const one = [
    ...[1, 2, 3, 4].map(w => ({ season: S - 1, week: w, xfp: 10, act: 10, target_share: 0.12 })),
    { season: S, week: 1, xfp: 15, act: 10, target_share: 0.25 },
  ];
  const r1 = scoreBuyLow({ position: 'WR', games: one }, { season: S, week: 2 });
  assert.equal(r1.role, 'detected');
  assert.ok(Math.abs(r1.gap_shrunk - 5 / 3) < 1e-9);
  assert.equal(r1.buy_low, false);
});

test('leakage: nothing at or after the as-of week is read (same-week and future rows change nothing)', () => {
  const base = scoreBuyLow({ position: 'WR', games: wrGames() }, { season: S, week: 6 });
  const poisoned = [...wrGames(),
    { season: S, week: 6, xfp: 0, act: 99, target_share: 0.01 },
    { season: S, week: 7, xfp: 0, act: 99, target_share: 0.01 },
    { season: S + 1, week: 1, xfp: 0, act: 99, target_share: 0.01 }];
  assert.deepEqual(scoreBuyLow({ position: 'WR', games: poisoned }, { season: S, week: 6 }), base);
  // As of week 5, week 5 itself is unread: the window is weeks 2-4.
  const w5 = scoreBuyLow({ position: 'WR', games: wrGames() }, { season: S, week: 5 });
  assert.equal(w5.through_week, 4);
});

test('no baseline, no usage rule, low xFP: never flagged', () => {
  const thin = [{ season: S, week: 1, xfp: 20, act: 2, target_share: 0.4 }];
  assert.equal(scoreBuyLow({ position: 'WR', games: thin }, { season: S, week: 2 }).status, 'no_baseline');
  assert.equal(scoreBuyLow({ position: 'K', games: wrGames() }, { season: S, week: 6 }).status, 'no_usage_rule');
  const low = wrGames().map(g => ({ ...g, xfp: g.xfp / 4, act: g.act / 4 }));
  const r = scoreBuyLow({ position: 'WR', games: low }, { season: S, week: 6 });
  assert.equal(r.buy_low, false);
  assert.equal(r.eligible, false);
});

test('reader: weeks < as-of only, joins ffopportunity (gsis) with usage (players.id)', () => {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE players (id INTEGER, position TEXT, gsis_id TEXT);
    CREATE TABLE nfl_ffopportunity_weekly (season INT, week INT, player_gsis_id TEXT, expected_fantasy_points REAL, actual_fantasy_points REAL);
    CREATE TABLE player_week_usage (player_id INT, season INT, week INT, target_share REAL, carries REAL, targets REAL);`);
  d.prepare('INSERT INTO players VALUES (?, ?, ?)').run(7, 'WR', 'G7');
  d.prepare('INSERT INTO players VALUES (?, ?, ?)').run(8, 'RB', null);
  for (const g of [...wrGames(), { season: S, week: 6, xfp: 0, act: 99, target_share: 0.01 }]) {
    d.prepare('INSERT INTO nfl_ffopportunity_weekly VALUES (?, ?, ?, ?, ?)').run(g.season, g.week, 'G7', g.xfp, g.act);
    d.prepare('INSERT INTO player_week_usage VALUES (?, ?, ?, ?, ?, ?)').run(7, g.season, g.week, g.target_share, 0, 0);
  }
  const db = { row: (q, ...a) => d.prepare(q).get(...a), rows: (q, ...a) => d.prepare(q).all(...a) };
  const { reads, sources } = readBuyLow(db, { season: S, week: 6, ids: [7, 8], rule: 1 });
  assert.deepEqual(reads.get('7'), scoreBuyLow({ position: 'WR', games: wrGames() }, { season: S, week: 6 }));
  assert.equal(reads.get('8').status, 'no_games');
  assert.equal(sources.ffopportunity.rows, 11);
  assert.equal(sources.ffopportunity.missing_gsis, 1);
  d.exec('DROP TABLE player_week_usage');
  // The served rule (v2, the default) needs no usage table and no baseline.
  assert.deepEqual(readBuyLow(db, { season: S, week: 6, ids: [7] }).reads.get('7'), scoreBuyLowV2({ position: 'WR', games: wrGames() }, { season: S, week: 6 }));
  const absent = readBuyLow(db, { season: S, week: 6, ids: [7], rule: 1 });
  assert.equal(absent.sources.usage.status, 'table_absent');
  assert.equal(absent.reads.get('7').status, 'no_baseline');
});

const flagged = (score, role = 'confirmed', position = 'WR') => ({ status: 'ok', position, role, buy_low: true, score, gap_shrunk: score, games: 3, usage_delta: 0.1, through_week: 5 });
const plain = { status: 'ok', role: 'none', buy_low: false, score: 0 };

test('tie-breaker only: equal rank scores reorder, different ones never swap', () => {
  const sug = [{ player: 1, rank_score: 0.5 }, { player: 2, rank_score: 0.2 }, { player: 3, rank_score: 0.2 }, { player: 4, rank_score: 0.1 }];
  const reads = new Map([['1', plain], ['2', plain], ['3', flagged(4)], ['4', flagged(9)]]);
  const { suggestions, moved } = tieBreakSuggestions(sug, reads);
  assert.deepEqual(suggestions.map(s => s.player), [1, 3, 2, 4]);
  assert.equal(moved, 2);
  // Nothing added or dropped; no reads at all is the identity.
  assert.deepEqual(tieBreakSuggestions(sug, new Map()).suggestions, sug);
  assert.equal(tieBreakSuggestions(sug, new Map()).moved, 0);
});

test('applyBuyLow: buy_low on flagged suggestions, other rosters ranked, floor shown not used to add', () => {
  const res = { me: '1', suggestions: [{ player: 21, rank_score: 0.3 }, { player: 22, rank_score: 0.3 }] };
  const reads = new Map([['21', plain], ['22', flagged(3)], ['31', flagged(5)], ['32', flagged(2.5, 'detected')], ['33', plain]]);
  const out = applyBuyLow(res, reads, { others: [21, 22, 31, 32, 33], floorOf: id => id === '31' });
  assert.deepEqual(out.res.suggestions.map(s => s.player), [22, 21]);
  assert.equal(out.res.suggestions[0].buy_low.role, 'confirmed');
  assert.equal(out.res.suggestions[1].buy_low, undefined);
  assert.equal(res.suggestions[0].player, 21, 'input untouched');
  assert.deepEqual(out.summary.others_top.map(r => [r.player, r.passes_floor]), [['31', true], ['22', false], ['32', false]]);
  assert.deepEqual(out.summary.targets_flagged, ['22']);
});

test('buyLowForRun: a reader fault is recorded, the plan is served as planned', () => {
  const res = { me: '1', suggestions: [{ player: 2, rank_score: 1 }] };
  const adapter = { rosters: new Map([['1', [1]], ['2', [2]]]), buyLow: () => { throw new Error('db gone'); } };
  const r = buyLowForRun(res, adapter);
  assert.equal(r.res, res);
  assert.equal(r.summary.status, 'error');
  assert.match(r.summary.reason, /db gone/);
});

test('annotateEntryTargets: typed field, source usage.xfp, a guess', () => {
  const e = { targets: { status: 'ok', source: 'plan.path', value: [{ player: '5' }, { player: '6' }] } };
  const out = annotateEntryTargets(e, new Map([['5', flagged(3.2)]]));
  assert.deepEqual(out.targets.value[0].buy_low, { status: 'ok', source: 'usage.xfp', unit: 'points_per_week', guess: true,
    value: { rule: 1, role: 'confirmed', points_below_expected: 3.2, games: 3, usage_change: 0.1, through_week: 5 } });
  assert.equal(out.targets.value[1].buy_low, undefined);
  assert.equal(e.targets.value[0].buy_low, undefined, 'input untouched');
});

/* ---------------------------------------------------------------- producer */

const withReader = (reads) => {
  const a = makeAdapter();
  a.buyLow = ids => ({ reads: new Map(ids.map(id => [String(id), reads(String(id))])), sources: { ffopportunity: { status: 'ok' } } });
  return a;
};
const run = (adapter, env) => buildPlansFile([{ id: 4, load: async () => ({ adapter }) }],
  { generated_at: '2026-09-25T06:00:00.000Z', clock: () => 0, env });

test('flag off = byte-identical plans, even with a reader on the adapter or preview on', async () => {
  const base = JSON.stringify(await run(makeAdapter(), {}));
  const all = () => flagged(4);
  assert.equal(JSON.stringify(await run(withReader(all), {})), base);
  assert.equal(JSON.stringify(await run(withReader(all), { GRIDIRON_PREVIEW_UNCONFIRMED: '1', GRIDIRON_BUY_LOW: '0' })),
    JSON.stringify(await run(makeAdapter(), { GRIDIRON_PREVIEW_UNCONFIRMED: '1', GRIDIRON_BUY_LOW: '0' })));
});

test('flag on: targets carry buy_low, same target set, contract holds, summary in _run', async () => {
  const off = (await run(makeAdapter(), {})).leagues[0];
  const on = (await run(withReader(() => ({ ...flagged(4), rule: 1 })), { GRIDIRON_BUY_LOW: '1' })).leagues[0];
  assert.equal(validateLeague(on).ok, true, JSON.stringify(validateLeague(on).errors?.slice(0, 3)));
  const ids = l => l.targets.value.map(t => t.player).sort();
  assert.deepEqual(ids(on), ids(off), 'never adds or drops a target');
  assert.ok(on.targets.value.length > 0);
  assert.equal(on.targets.value.every(t => t.buy_low?.status === 'ok'), true);
  assert.equal(on._run.inputs.buy_low.flag, 'on');
  assert.equal(on._run.inputs.buy_low.status, 'ok');
  assert.equal(on._run.inputs.buy_low.rule_version, 1);
  // The deck (next move, alternatives) is the planner's, untouched by a tie-breaker on targets.
  assert.deepEqual(on.next_move, off.next_move);
  assert.deepEqual(on.alternatives, off.alternatives);
});

test('served positions: v2 serves QB/RB/WR/TE; a vetoed TE is listed in shadow, never served or tie-broken', () => {
  assert.deepEqual([...SERVED_POSITIONS], ['QB', 'RB', 'WR', 'TE']);
  assert.equal(SERVED_RULE, 2);
  const res = { me: '1', suggestions: [{ player: 21, rank_score: 0.3 }, { player: 22, rank_score: 0.3 }] };
  const reads = new Map([['21', plain], ['22', flagged(6, 'confirmed', 'TE')]]);
  const noTe = ['QB', 'RB', 'WR'];
  const out = applyBuyLow(res, reads, { others: [21, 22], positions: noTe });
  assert.deepEqual(out.res.suggestions.map(s => s.player), [21, 22]);
  assert.equal(out.res.suggestions[1].buy_low, undefined);
  assert.deepEqual(out.summary.others_top.map(r => [r.player, r.position, r.served]), [['22', 'TE', false]]);
  assert.equal(annotateEntryTargets({ targets: { status: 'ok', value: [{ player: '22' }] } }, reads, noTe).targets.value[0].buy_low, undefined);
  // Default (v2): TE is served and breaks the tie.
  const on = applyBuyLow(res, reads, { others: [21, 22] });
  assert.deepEqual(on.res.suggestions.map(s => s.player), [22, 21]);
});

/* ---------------------------------------------------------------- RULE-FUZZ, flag on */

test('RULE-FUZZ with BUY-LOW on: random buy-low reads never add a rule violation, a target, or a floor break', async () => {
  const { planLeague } = await import('../server/services/campaign/planner.js');
  const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
  const { makeFuzzLeague, rng } = await import('./fixtures/rule-fuzz-league.mjs');
  const { ruleViolations } = await import('./fixtures/nick-rules.mjs');
  const seeds = Array.from({ length: Number(process.env.BUY_LOW_FUZZ_N ?? 40) }, (_, i) => 9100 + i);
  let flaggedTargets = 0, moved = 0;
  for (const seed of seeds) {
    for (const mode of ['safe', 'balanced', 'all_in']) {
      const a = makeFuzzLeague(seed);
      const res = planLeague(a, { objective: normaliseObjective({ risk_mode: mode }), env: {} });
      const r = rng(seed * 7 + 1);
      const pos = ['QB', 'RB', 'WR', 'TE'];
      a.buyLow = ids => ({ reads: new Map(ids.map(id => [String(id), r() < 0.5
        ? flagged(1 + r() * 8, r() < 0.5 ? 'detected' : 'confirmed', pos[Math.floor(r() * 4)]) : plain])), sources: {} });
      // Force ties so the tie-breaker has something to do.
      const tied = { ...res, suggestions: res.suggestions.map(s => ({ ...s, rank_score: Math.round(s.rank_score * 10) / 10 })) };
      const out = buyLowForRun(tied, a);
      assert.deepEqual(ruleViolations(a, out.res), ruleViolations(a, tied), `seed ${seed} ${mode}`);
      assert.deepEqual(out.res.suggestions.map(s => String(s.player)).sort(), tied.suggestions.map(s => String(s.player)).sort());
      for (let i = 1; i < out.res.suggestions.length; i++) {
        assert.ok(out.res.suggestions[i - 1].rank_score >= out.res.suggestions[i].rank_score, `seed ${seed} ${mode}: rank order broken`);
      }
      assert.deepEqual(out.res.best, tied.best);
      flaggedTargets += out.summary.targets_flagged.length;
      moved += out.summary.tie_break_moved;
    }
  }
  assert.ok(flaggedTargets > 0 && moved > 0, 'the fuzz exercised the tie-breaker');
});

test('position-aware flag: GRIDIRON_BUY_LOW=1 serves QB/RB/WR/TE under v2; GRIDIRON_BUY_LOW_TE=0 vetoes TE', async () => {
  assert.equal(BUY_LOW_TE_ENV, 'GRIDIRON_BUY_LOW_TE');
  assert.deepEqual(buyLowPositions({}), []);
  assert.deepEqual(buyLowPositions({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), []);
  assert.deepEqual(buyLowPositions({ GRIDIRON_BUY_LOW: '1' }), ['QB', 'RB', 'WR', 'TE']);
  assert.deepEqual(buyLowPositions({ GRIDIRON_BUY_LOW: '1', GRIDIRON_BUY_LOW_TE: '0' }), ['QB', 'RB', 'WR']);
  assert.deepEqual(buyLowPositions({ GRIDIRON_BUY_LOW_TE: '1' }), [], 'the TE flag alone turns nothing on');
  assert.equal(buyLowEnabled({ GRIDIRON_BUY_LOW_TE: '1' }), false);
  const te = () => ({ ...flagged(4, undefined, 'TE'), rule: 2, role: undefined, usage_delta: undefined });
  const on = (await run(withReader(te), { GRIDIRON_BUY_LOW: '1' })).leagues[0];
  assert.equal(validateLeague(on).ok, true, JSON.stringify(validateLeague(on).errors?.slice(0, 3)));
  assert.equal(on.targets.value.every(t => t.buy_low?.value.rule === 2 && t.buy_low.value.role === undefined), true);
  assert.deepEqual(on._run.inputs.buy_low.positions, ['QB', 'RB', 'WR', 'TE']);
  assert.equal(on._run.inputs.buy_low.rule_version, 2);
  const veto = (await run(withReader(te), { GRIDIRON_BUY_LOW: '1', GRIDIRON_BUY_LOW_TE: '0' })).leagues[0];
  assert.equal(veto.targets.value.some(t => t.buy_low), false);
});

/* ---------------------------------------------------------------- Go get chip */

test('Go get card: the Buy-low chip is the War Room pill, plain words, a guess, no numbers on the card', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { loadWarRoom, textOf } = await import('./helpers/warroom-tsx.mjs');
  const w = await loadWarRoom();
  try {
    const { BuyLowChip } = await w.mod('ScreenGoGet');
    const html = renderToStaticMarkup(React.createElement(BuyLowChip, { b: { rule: 1, role: 'confirmed', points_below_expected: 2.6, games: 2, usage_change: 0.05, through_week: 2 } }));
    assert.equal(textOf(html).trim(), 'Buy-low');
    assert.match(html, /class="wr-pill2 wr-pill2-green"/);
    assert.match(html, /data-testid="target-buy-low"/);
    assert.match(html, /title="Buy-low \(a guess\): usage up in 2 recent games, scoring about 2\.6 pts\/game below what his usage predicts over his last 2 games\."/);
    const v2 = renderToStaticMarkup(React.createElement(BuyLowChip, { b: { rule: 2, points_below_expected: 3.1, games: 3, usage_change: null, through_week: 3 } }));
    assert.match(v2, /title="Buy-low \(a guess\): scoring about 3\.1 pts\/game below what his usage predicts over his last 3 games\."/);
    assert.doesNotMatch(html, /usage\.xfp|buy_low|points_below_expected/);
    const det = renderToStaticMarkup(React.createElement(BuyLowChip, { b: { rule: 1, role: 'detected', points_below_expected: 2.2, games: 2, usage_change: null, through_week: 2 } }));
    assert.match(det, /usage up in his latest game/);
  } finally { w.cleanup?.(); }
});

/* ---------------------------------------------------------------- v2 (gap-only), evaluation only */

test('v2 gap-only: shrunk gap alone, no baseline or usage needed, never reads the as-of week', () => {
  assert.equal(BUY_LOW_V2_RULE.version, 2);
  // No last season and no usage at all: v1 cannot score it, v2 can.
  const games = [3, 4, 5].map(w => ({ season: S, week: w, xfp: 16, act: 8 }));
  assert.equal(scoreBuyLow({ position: 'WR', games }, { season: S, week: 6 }).status, 'no_baseline');
  const r = scoreBuyLowV2({ position: 'WR', games }, { season: S, week: 6 });
  assert.equal(r.buy_low, true);
  assert.ok(Math.abs(r.gap_shrunk - 8 * 3 / 5) < 1e-9);
  const poisoned = [...games, { season: S, week: 6, xfp: 0, act: 99 }, { season: S, week: 7, xfp: 0, act: 99 }];
  assert.deepEqual(scoreBuyLowV2({ position: 'WR', games: poisoned }, { season: S, week: 6 }), r);
  // One game at gap 5 shrinks to 1.67: not flagged. xFP under 5: not flagged.
  assert.equal(scoreBuyLowV2({ position: 'RB', games: [{ season: S, week: 1, xfp: 15, act: 10 }] }, { season: S, week: 2 }).buy_low, false);
  assert.equal(scoreBuyLowV2({ position: 'RB', games: [1, 2, 3].map(w => ({ season: S, week: w, xfp: 4.5, act: 0 })) }, { season: S, week: 4 }).buy_low, false);
  assert.equal(scoreBuyLowV2({ position: 'RB', games: [] }, { season: S, week: 4 }).status, 'no_games');
});
