/**
 * IS-TITLE measurement (pre-registered in server/services/is-title.js): M1-M4.
 *
 * Skipped unless IS_TITLE_BENCH=1: it plays ~200,000 simulated seasons (a few
 * minutes), too slow for the CI suite. Run it with:
 *
 *   IS_TITLE_BENCH=1 GRIDIRON_DB_PATH=/tmp/ist.sqlite SCHEDULER_DISABLED=1 \
 *     node --experimental-test-module-mocks --test test/is-title-bench.test.js
 *
 * Seeds 1001-1020 are the K = 20 measured seeds; the reference pools 25 plain
 * worlds of 4,000 runs (seeds 5001-5025, 100,000 runs) so no world holds 100k
 * runs of draws in memory. Every seed builds its own world (its own outcome
 * pools), so the spread over seeds includes pool noise, for both arms alike.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const ON = process.env.IS_TITLE_BENCH === '1';

test('IS-TITLE bench: M1-M4 against the pre-registered bars', { skip: !ON && 'IS_TITLE_BENCH unset' }, async () => {
  const { setupIsTitleLeague, TARGET } = await import('./fixtures/is-title-league.mjs');
  const { sim, league, teamPlayers, cleanup } = await setupIsTitleLeague({ tag: 'is-title-bench' });
  try {
    const K = 20, N = 1200, REF_WORLDS = 25, REF_RUNS = 4000;
    const deal = { myTeamId: 1, theirTeamId: 2, iGive: [teamPlayers.get(1)[6]], iGet: [teamPlayers.get(2)[1]] };
    const lg = league();
    const sd = a => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
    const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
    const unrounded = (w, id) => w.base.per_run.get(id).title.reduce((s, x) => s + x, 0) / w.runs;
    const pairedPlain = w => {
      const r = sim.tradeImpactIS({ ...w, weights: new Float64Array(w.runs).fill(1) }, deal);
      return r.me.title_delta;
    };

    // Reference: plain Monte Carlo, 100,000 runs over 25 worlds.
    let refHits = 0, refDelta = 0;
    for (let i = 0; i < REF_WORLDS; i++) {
      const w = sim.tradeImpactWorld(lg, { runs: REF_RUNS, seed: 5001 + i });
      refHits += unrounded(w, TARGET) * REF_RUNS;
      refDelta += pairedPlain(w) * REF_RUNS;
    }
    const REF = REF_WORLDS * REF_RUNS;
    const ref = refHits / REF, refSe = Math.sqrt(ref * (1 - ref) / REF);
    const refD = refDelta / REF;

    const plain = [], is = [], plainD = [], isD = [], weightChecks = [], reportedRatio = [], hits = [];
    let refDeltaVar = 0;
    for (let k = 0; k < K; k++) {
      const seed = 1001 + k;
      const p = sim.tradeImpactWorld(lg, { runs: N, seed });
      plain.push(unrounded(p, TARGET));
      plainD.push(pairedPlain(p));
      const w = sim.titleWorldIS(lg, { runs: N, seed });
      const s = sim.titleOddsIS(w);
      const raw = sim.tradeImpactIS(w, deal);
      is.push(s.title_odds); isD.push(raw.me.title_delta);
      weightChecks.push(Math.abs(s.mean_weight - 1) <= 3 * s.mean_weight_se);
      reportedRatio.push(s.se_ratio); hits.push(s.proposal_title_runs);
    }
    // The reference delta's SE from the plain seeds' spread, scaled to 100k runs.
    refDeltaVar = sd(plainD) ** 2 * N / REF;

    const m1 = sd(is) / sd(plain);
    const m2 = { diff: mean(is) - ref, bound: 3 * Math.sqrt(sd(is) ** 2 / K + refSe ** 2) };
    const m4 = sd(isD) / sd(plainD);
    const m4bias = { diff: mean(isD) - refD, bound: 3 * Math.sqrt(sd(isD) ** 2 / K + refDeltaVar) };
    const out = {
      reference: { runs: REF, title_odds: +ref.toFixed(5), se: +refSe.toFixed(5), paired_delta: +refD.toFixed(5) },
      levels: { plain_mean: +mean(plain).toFixed(5), plain_sd: +sd(plain).toFixed(5), is_mean: +mean(is).toFixed(5), is_sd: +sd(is).toFixed(5),
        M1_se_ratio: +m1.toFixed(3), M2_bias: +m2.diff.toFixed(5), M2_bound: +m2.bound.toFixed(5),
        reported_se_ratio_median: [...reportedRatio].sort((a, b) => a - b)[K / 2],
        proposal_title_runs_mean: mean(hits), plain_title_runs_mean: mean(plain) * N },
      M3_weights_ok: `${weightChecks.filter(Boolean).length} of ${K}`,
      paired: { plain_mean: +mean(plainD).toFixed(5), plain_sd: +sd(plainD).toFixed(5), is_mean: +mean(isD).toFixed(5), is_sd: +sd(isD).toFixed(5),
        M4_se_ratio: +m4.toFixed(3), M4_bias: +m4bias.diff.toFixed(5), M4_bound: +m4bias.bound.toFixed(5) }
    };
    console.log(`IS-TITLE-BENCH ${JSON.stringify(out)}`);
    // The bars, as registered. A failure here is the result, reported as is.
    assert.ok(ref >= 0.001 && ref <= 0.01, `precondition: reference ${ref} in 0.1-1%`);
    assert.ok(m1 <= 0.5, `M1 SE ratio ${m1} <= 0.5`);
    assert.ok(Math.abs(m2.diff) <= m2.bound, `M2 bias ${m2.diff} within ${m2.bound}`);
    assert.ok(weightChecks.every(Boolean), `M3 mean weight within 3 SE of 1 on every seed (${out.M3_weights_ok})`);
    assert.ok(m4 <= 0.6, `M4 paired SE ratio ${m4} <= 0.6`);
    assert.ok(Math.abs(m4bias.diff) <= m4bias.bound, `M4 bias ${m4bias.diff} within ${m4bias.bound}`);
  } finally {
    cleanup();
  }
});
