import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * The Monte Carlo lookahead draws player SEASON OUTCOMES, not just draft order.
 *
 * Everything here guards a silent failure. A copula that has quietly stopped
 * correlating still returns numbers; a marginal that has quietly collapsed to
 * the point estimate still returns numbers; and the reported `sd` looks
 * perfectly plausible in both cases — which is exactly how the pre-2026-09-07
 * version shipped a spread that only ever measured who else got drafted.
 *
 * draft-lookahead.js pulls in modules that create tables at import time, so
 * this isolates against a throwaway DB, the same convention as the rest of the
 * suite. `correlation_estimates` is seeded with known values so the copula's
 * output can be checked against a number this file chose.
 */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-lookahead-variance-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { lookahead, __test } = await import('../server/services/draft-lookahead.js');
const { clearCorrelationCache } = await import('../server/services/correlation.js');

const QB_WR_TEAM = 0.42;   // deliberately not the fitted value, so a hard-coded
const QB_TE_TEAM = 0.25;   // constant sneaking into the copula would fail here.
db.exec(`
  DELETE FROM correlation_estimates;
  INSERT INTO correlation_estimates (key, correlation, pairs, fitted_at) VALUES
    ('QB|WR|team', ${QB_WR_TEAM}, 9999, '2026-01-01'),
    ('QB|TE|team', ${QB_TE_TEAM}, 9999, '2026-01-01'),
    ('RB|WR|team', 0.0, 9999, '2026-01-01'),
    ('QB|WR|opp',  0.9, 9999, '2026-01-01');
`);
clearCorrelationCache();

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ helpers */

const NARROW = { p20: 0.80, p80: 1.20 };
const WIDE = { p20: 0.40, p80: 1.60 };

const stats = a => {
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length);
  return { mean, sd };
};

/** Pearson correlation of the drawn log-outcomes for two universe members. */
function drawnCorrelation(universe, worlds, i, j) {
  const x = worlds.map(w => Math.log(w[i])), y = worlds.map(w => Math.log(w[j]));
  const mx = stats(x).mean, my = stats(y).mean;
  let sxy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < x.length; k++) {
    const a = x[k] - mx, b = y[k] - my;
    sxy += a * b; sxx += a * a; syy += b * b;
  }
  return sxy / Math.sqrt(sxx * syy);
}

function universeOf(specs) {
  return specs.map((s, i) => ({
    player_id: i + 1, position: s.position, team_abbr: s.team,
    projected_points: s.points ?? 200, outcome_idx: i
  }));
}

/* ------------------------------------------------------- the marginal varies */

test('a drawn season outcome is a distribution, not the point estimate repeated', () => {
  const universe = universeOf([{ position: 'RB', team: 'DET' }]);
  const worlds = __test.outcomeWorlds(universe, { sims: 4000, seed: 1, bandOf: () => NARROW });
  const mult = worlds.map(w => w[0]);
  const { mean, sd } = stats(mult);
  assert.ok(sd > 0.05, `outcome multiplier should actually vary, got sd ${sd}`);
  assert.ok(new Set(mult.map(m => m.toFixed(6))).size > 3000, 'draws should be distinct, not a repeated constant');
  // Right-skewed: the mean sits above the median, which is what a ratio band
  // measured on realized seasons looks like.
  const median = [...mult].sort((a, b) => a - b)[Math.floor(mult.length / 2)];
  assert.ok(mean > median, `expected right skew, got mean ${mean} median ${median}`);
});

test('the marginal is mean-preserving: the point projection stays the expectation', () => {
  for (const band of [NARROW, WIDE, { p20: 0.05, p80: 3.0 }]) {
    const universe = universeOf([{ position: 'WR', team: 'CIN' }]);
    const worlds = __test.outcomeWorlds(universe, { sims: 20000, seed: 5, bandOf: () => band });
    const { mean } = stats(worlds.map(w => w[0]));
    // This is the guard against the rejected quantile-matching fit, whose mean
    // reached 4.76x in the deep tail and would have made the lookahead prefer
    // late-round lottery tickets.
    assert.ok(Math.abs(mean - 1) < 0.03, `E[multiplier] should be ~1 for band ${JSON.stringify(band)}, got ${mean}`);
  }
});

test('a wider band draws a wider season, and the sigma cap bounds the tail', () => {
  const draw = band => {
    const universe = universeOf([{ position: 'RB', team: 'ATL' }]);
    return stats(__test.outcomeWorlds(universe, { sims: 8000, seed: 3, bandOf: () => band }).map(w => w[0])).sd;
  };
  assert.ok(draw(WIDE) > draw(NARROW) * 1.5, 'a wider p20/p80 band must produce a wider season');
  // Past the graded range the band explodes; the cap keeps that from becoming
  // an unbounded multiplier on a deep bench player.
  const absurd = draw({ p20: 0.001, p80: 50 });
  const capped = draw({ p20: 0.02, p80: 30 });
  assert.ok(Math.abs(absurd - capped) < 0.05, `sigma cap should bind for both, got ${absurd} vs ${capped}`);
  assert.ok(absurd < 2.5, `capped spread should stay finite, got sd ${absurd}`);
});

/* ------------------------------------------------------ correlation is real */

test('the copula reproduces the fitted same-team archetype correlations', () => {
  const universe = universeOf([
    { position: 'QB', team: 'KC' }, { position: 'WR', team: 'KC' },
    { position: 'TE', team: 'KC' }, { position: 'WR', team: 'BUF' }
  ]);
  const worlds = __test.outcomeWorlds(universe, { sims: 40000, seed: 808, bandOf: () => NARROW });

  const qbWr = drawnCorrelation(universe, worlds, 0, 1);
  const qbTe = drawnCorrelation(universe, worlds, 0, 2);
  const stranger = drawnCorrelation(universe, worlds, 0, 3);

  // Measurable covariance, at the value the table says — not merely non-zero.
  assert.ok(Math.abs(qbWr - QB_WR_TEAM) < 0.02, `QB/WR same team should draw at ~${QB_WR_TEAM}, got ${qbWr}`);
  assert.ok(Math.abs(qbTe - QB_TE_TEAM) < 0.02, `QB/TE same team should draw at ~${QB_TE_TEAM}, got ${qbTe}`);
  assert.ok(qbWr > qbTe, 'the ordering of the fitted archetypes should survive the draw');

  // Season grain: no shared opponent, so two players on different teams are
  // independent. The 0.9 QB|WR|opp row above must NOT leak in.
  assert.ok(Math.abs(stranger) < 0.03, `players on different teams should be independent, got ${stranger}`);
});

test('a stack is a joint outcome: teammates land in the same tail together', () => {
  const stacked = universeOf([{ position: 'QB', team: 'KC' }, { position: 'WR', team: 'KC' }]);
  const split = universeOf([{ position: 'QB', team: 'KC' }, { position: 'WR', team: 'BUF' }]);
  const bothBig = u => {
    const worlds = __test.outcomeWorlds(u, { sims: 20000, seed: 77, bandOf: () => NARROW });
    return worlds.filter(w => w[0] > 1.15 && w[1] > 1.15).length / worlds.length;
  };
  const s = bothBig(stacked), d = bothBig(split);
  assert.ok(s > d * 1.15, `stacked teammates should boom together more often than strangers (${s} vs ${d})`);
});

/* -------------------------------------------------- the band lookup itself */

test('the band lookup is rank-local and falls back rather than throwing', () => {
  const curve = new Map([['WR', [
    { rank: 1, p20: 0.75, p80: 1.25 },
    { rank: 20, p20: 0.60, p80: 1.40 },
    { rank: 60, p20: 0.35, p80: 1.70 }
  ]]]);
  assert.deepEqual(__test.bandAt(curve, 'WR', 1), { rank: 1, p20: 0.75, p80: 1.25 });
  assert.equal(__test.bandAt(curve, 'WR', 21).rank, 20, 'should snap to the nearest fitted rank');
  assert.equal(__test.bandAt(curve, 'WR', 500).rank, 60, 'past the curve, use its deepest cell');
  // A position the preseason model never fitted must not take the simulation down.
  assert.deepEqual(__test.bandAt(curve, 'TE', 4), __test.FALLBACK_BAND);
  assert.deepEqual(__test.bandAt(new Map(), 'WR', 4), __test.FALLBACK_BAND);
});

/* ------------------------------------------------------ end-to-end lookahead */

/**
 * A small but complete board: 4 teams, 5 rounds, my slot on the clock at pick 1,
 * with two of the candidates sharing a team with a QB already on my roster so
 * the stack path is exercised.
 */
function boardFixture() {
  const positions = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'DEF', 'K']) {
    positions[pos] = { available: 10, replacement_points: pos === 'QB' ? 200 : pos === 'TE' ? 90 : 110 };
  }
  const teams = ['KC', 'BUF', 'CIN', 'DET', 'PHI', 'SFO'];
  const available = [];
  let id = 100;
  for (let i = 0; i < 60; i++) {
    const position = ['RB', 'WR', 'WR', 'QB', 'TE', 'RB'][i % 6];
    available.push({
      player_id: ++id, name: `P${id}`, position, team_abbr: teams[i % teams.length],
      market_rank: i + 1, board_rank: i + 1,
      projected_pos_rank: Math.floor(i / 6) + 1,
      projected_points: 260 - i * 2.5
    });
  }
  for (const pos of ['K', 'DEF']) {
    for (let i = 0; i < 6; i++) {
      available.push({
        player_id: ++id, name: `${pos}${i}`, position: pos, team_abbr: teams[i],
        market_rank: 300 + i, board_rank: 300 + i, projected_pos_rank: i + 1,
        projected_points: 120 - i * 3
      });
    }
  }
  return {
    draft: {
      id: 1, season: 2026, team_count: 4, rounds: 5, my_slot: 1,
      roster_slots: { QB: 1, RB: 1, WR: 2, TE: 1, K: 1, DEF: 1 }
    },
    on_the_clock: { my_turn: true, pick_number: 1, round: 1, slot: 1, picks_until_my_turn: 0, my_upcoming_picks: [8, 9, 16, 17] },
    positions,
    available,
    team_counts: { 1: {}, 2: {}, 3: {}, 4: {} },
    my_team: { picks: [] },
    targets: available.slice(0, 6)
  };
}

const run = opts => lookahead(boardFixture(), { sims: 120, candidates: 4, seed: 4242, bands: () => NARROW, ...opts });

test('the reported spread now contains player outcomes, and says so', () => {
  const withDraws = run({});
  const orderOnly = run({ outcomeDraws: false });

  assert.equal(withDraws.outcome_draws, true);
  assert.ok(withDraws.drawn_players > 20, `expected a populated draw universe, got ${withDraws.drawn_players}`);
  assert.equal(orderOnly.outcome_draws, false);
  assert.equal(orderOnly.drawn_players, 0);

  for (const c of orderOnly.candidates.filter(c => c.expected != null)) {
    assert.equal(c.sd, c.sd_order, 'without outcome draws the two spreads are the same number');
  }
  for (const c of withDraws.candidates.filter(c => c.expected != null)) {
    assert.ok(c.sd > c.sd_order * 2,
      `${c.name}: season variance should dominate draft-order variance (sd ${c.sd} vs sd_order ${c.sd_order})`);
    assert.ok(c.p10 < c.expected && c.expected < c.p90, `${c.name}: p10/p90 should bracket the mean`);
  }
});

test('adding outcome draws leaves the draft simulation itself bit-identical', () => {
  const withDraws = run({});
  const orderOnly = run({ outcomeDraws: false });
  const key = c => [c.player_id, c.sd_order, c.sniped_pct, c.sims, c.typical_build, JSON.stringify(c.likely_next)];

  const a = new Map(withDraws.candidates.map(c => [c.player_id, key(c)]));
  const b = new Map(orderOnly.candidates.map(c => [c.player_id, key(c)]));
  assert.equal(a.size, b.size);
  for (const [id, v] of a) {
    // Who gets drafted, who gets sniped and who survives to my next turn are
    // decided by the draft-order RNG alone. If the outcome layer ever perturbs
    // that stream, the two runs stop matching and this fires.
    assert.deepEqual(v, b.get(id), `candidate ${id}: the draft-order simulation must be untouched`);
  }
});

test('outcome draws do not move the expected roster value beyond bench option value', () => {
  const withDraws = run({ sims: 600 });
  const orderOnly = run({ sims: 600, outcomeDraws: false });
  const flat = new Map(orderOnly.candidates.map(c => [c.player_id, c.expected]));
  for (const c of withDraws.candidates.filter(c => c.expected != null)) {
    const before = flat.get(c.player_id);
    if (before == null) continue;
    // The marginal is mean-preserving, so the only legitimate drift is the
    // convexity of max(0, points - replacement) in the bench term.
    const drift = (c.expected - before) / before;
    assert.ok(drift >= -0.01 && drift < 0.06,
      `${c.name}: expected value drifted ${(drift * 100).toFixed(1)}% (${before} -> ${c.expected})`);
  }
});

test('the lookahead is deterministic for a seed and paired across candidates', () => {
  assert.deepEqual(
    run({}).candidates.map(c => [c.name, c.expected, c.sd]),
    run({}).candidates.map(c => [c.name, c.expected, c.sd]),
    'same seed, same board, same answer'
  );
  // Common random numbers plus the blocking step: a re-seeded run draws entirely
  // different seasons, which moves every candidate's absolute `expected` a long
  // way, but their gaps to the leader are a within-iteration quantity and should
  // barely move. Keyed by player, since the ordering is what is under test.
  const deltas = r => new Map(r.candidates.filter(c => c.delta != null).map(c => [c.player_id, c.delta]));
  const a = deltas(run({ sims: 400 })), b = deltas(run({ sims: 400, seed: 999 }));
  assert.ok(a.size > 1, 'expected several scored candidates');
  let worst = 0;
  for (const [id, v] of a) {
    assert.ok(b.has(id), `candidate ${id} missing from the re-seeded run`);
    worst = Math.max(worst, Math.abs(v - b.get(id)));
  }
  assert.ok(worst < 25, `candidate gaps should survive re-seeding, worst move ${worst}`);

  // And the absolute level really does move, so the line above is testing the
  // blocking rather than an accidentally-shared random stream.
  const exp = r => new Map(r.candidates.filter(c => c.expected != null).map(c => [c.player_id, c.expected]));
  const ea = exp(run({ sims: 400 })), eb = exp(run({ sims: 400, seed: 999 }));
  assert.ok([...ea].some(([id, v]) => Math.abs(v - eb.get(id)) > worst),
    'a different seed should move the absolute expectation more than it moves the gaps');
});

test('the number on screen cannot disagree with the ranking beside it', () => {
  for (const opts of [{}, { outcomeDraws: false }]) {
    const out = run({ sims: 300, ...opts });
    const scored = out.candidates.filter(c => c.expected_paired != null);
    assert.ok(scored.length > 1);
    for (let i = 1; i < scored.length; i++) {
      assert.ok(scored[i - 1].expected_paired >= scored[i].expected_paired - 0.15,
        `row ${i} (${scored[i].name}, ${scored[i].expected_paired}) outranks the row above it ` +
        `(${scored[i - 1].name}, ${scored[i - 1].expected_paired})`);
      assert.ok(scored[i - 1].delta >= scored[i].delta, 'delta must be monotone down the list');
    }
    // Candidates are ranked on the like-for-like comparison, and the paired
    // level is that comparison re-anchored — so the two agree by construction.
    // The raw `expected` need not, and that is the point: it is conditional on
    // the candidate surviving, which happens in different worlds for each.
    assert.equal(scored[0].delta, 0);
  }
});

test('a board with no fitted band still simulates, on the fallback', () => {
  const out = lookahead(boardFixture(), { sims: 60, candidates: 3, seed: 7, bands: () => null });
  assert.ok(out.candidates.length > 0);
  for (const c of out.candidates.filter(c => c.expected != null)) {
    assert.ok(Number.isFinite(c.expected) && Number.isFinite(c.sd));
    assert.ok(c.sd > 0, 'the fallback band must still produce a spread');
  }
});
