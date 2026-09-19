#!/usr/bin/env node
/**
 * Does the injury-return model beat what the engine assumes today?
 *
 *   node scripts/audit-injury-return.mjs [--json] [--horizon 4]
 *
 * THE INCUMBENT IS NOT A MODEL, IT IS AN ASSUMPTION. `ros-projection.js` produces a
 * per-game rate and says so; `trade-engine.js:360` prices every remaining week at
 * that rate. So the shipped behaviour is "P(he plays) = 1, for everyone, every
 * week", including a player on injured reserve. That is the baseline this measures
 * against, and it is the only honest one — comparing against a straw baseline
 * nobody ships would flatter the result.
 *
 * THE DESIGN, and each clause is load-bearing:
 *
 *   WALK-FORWARD. Each test season is scored by a fit that never saw it: 2024 is
 *   fitted on 2021-2023, 2025 on 2021-2024. Fitting and scoring on the same weeks
 *   would produce a lovely number and no information.
 *
 *   PREDICTED FROM STATE AT WEEK w, SCORED ON WEEK w+k. Nothing after week w enters
 *   the prediction. The panel row for week w+k is the outcome, never an input.
 *
 *   THE OUTCOME IS A SNAP, NOT A STATUS. `player_week_snaps` decides whether he
 *   played. A roster status says where the team put him, and the two disagree often
 *   enough to matter.
 *
 *   ONLY ADJACENT WEEKS COUNT. The panel can skip a week for a player who is on no
 *   roster at all; treating a gap as adjacency would credit a return to the wrong
 *   horizon.
 *
 *   THREE POPULATIONS, REPORTED SEPARATELY, and the middle one is the one that
 *   counts. "Every player-week" includes practice-squad and cut players who were
 *   never going to play, so a win there is partly free — it is reported for
 *   completeness, not as the result. "Active weeks only" is the population a fantasy
 *   roster is actually made of and the one `trade-engine.js` prices, and it is the
 *   hardest case for this model because the incumbent is nearly right there.
 *   "Reserve weeks only" is where the incumbent is catastrophically wrong. Quoting
 *   the aggregate alone would flatter the result; quoting the reserve subset alone
 *   would too.
 *
 * SCORES. Brier (mean squared error on the 0/1 outcome) and log loss. Log loss is
 * infinite for a confident wrong answer, which is exactly the incumbent's failure
 * mode on an injured-reserve player, so both are reported: Brier says how much
 * better, log loss says how catastrophic the thing being replaced is. Predictions
 * are clipped to [1e-6, 1-1e-6] for log loss only, and the clip is stated because
 * without it the incumbent's score is simply "infinity" and the comparison stops
 * being informative.
 */
import { availabilityPanel, bySeasonAndPlayer, stateSequence, fitInjuryReturn,
  playProbabilities, stateKey, FANTASY_POSITIONS } from '../server/services/injury-return.js';

const JSON_OUT = process.argv.includes('--json');
const horizonArg = process.argv.indexOf('--horizon');
const HORIZON = horizonArg > -1 ? Math.max(1, Number(process.argv[horizonArg + 1]) || 4) : 4;

const TRAIN_FROM = 2021;
const TEST_SEASONS = [2024, 2025];

const c = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`,
  b: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` };

const CLIP = 1e-6;
const clip = p => Math.min(1 - CLIP, Math.max(CLIP, p));

function scorer() {
  let n = 0, brier = 0, logloss = 0, outcomes = 0;
  return {
    add(p, y) { n++; outcomes += y; brier += (p - y) ** 2;
      logloss -= y ? Math.log(clip(p)) : Math.log(1 - clip(p)); },
    get() { return n ? { n, base_rate: outcomes / n, brier: brier / n, log_loss: logloss / n } : null; }
  };
}

/** Every (player-week w, horizon k) pair in `season` that has a real week w+k. */
function* casesFor(season, positions) {
  const panel = availabilityPanel({ seasons: [season], positions });
  for (const weeks of [...bySeasonAndPlayer(panel).values()].map(stateSequence)) {
    const byWeek = new Map(weeks.map(w => [w.week, w]));
    for (let i = 0; i < weeks.length; i++) {
      const here = weeks[i];
      const targets = [];
      for (let k = 1; k <= HORIZON; k++) {
        const target = byWeek.get(here.week + k);
        // Adjacency is required all the way along the path, not just at the end:
        // a hazard chained across a missing week is a different horizon.
        if (!target || !byWeek.get(here.week + k - 1)) break;
        targets.push({ k, played: target.played === 1 });
      }
      if (targets.length) yield { here, targets };
    }
  }
}

const report = [];
for (const testSeason of TEST_SEASONS) {
  const trainSeasons = [];
  for (let s = TRAIN_FROM; s < testSeason; s++) trainSeasons.push(s);
  const fit = fitInjuryReturn({ seasons: trainSeasons, positions: FANTASY_POSITIONS });

  // The constant baseline is the training-set rate, not the test-set rate: using the
  // test rate would hand the baseline information the model is not given.
  const trainPanel = availabilityPanel({ seasons: trainSeasons, positions: FANTASY_POSITIONS });
  const constantRate = trainPanel.length
    ? trainPanel.reduce((sum, r) => sum + r.played, 0) / trainPanel.length : 0.5;

  const all = { model: scorer(), incumbent: scorer(), constant: scorer() };
  const active = { model: scorer(), incumbent: scorer(), constant: scorer() };
  const reserve = { model: scorer(), incumbent: scorer(), constant: scorer() };
  const byK = new Map();
  let noPrediction = 0;

  for (const { here, targets } of casesFor(testSeason, FANTASY_POSITIONS)) {
    const series = playProbabilities(fit, {
      status: here.status, statusDetail: here.status_detail,
      weeksOut: here.weeks_out, playedLastWeek: here.played === 1,
      horizon: targets.length
    });
    if (!series.length) { noPrediction += targets.length; continue; }
    for (const { k, played } of targets) {
      const p = series[k - 1].p_plays;
      const y = played ? 1 : 0;
      all.model.add(p, y); all.incumbent.add(1, y); all.constant.add(constantRate, y);
      if (here.state === 'ir') {
        reserve.model.add(p, y); reserve.incumbent.add(1, y); reserve.constant.add(constantRate, y);
      } else {
        active.model.add(p, y); active.incumbent.add(1, y); active.constant.add(constantRate, y);
      }
      const population = here.state === 'ir' ? 'reserve' : 'active';
      const bucket = byK.get(k) ?? { model: scorer(), incumbent: scorer(),
        active: { model: scorer(), incumbent: scorer() },
        reserve: { model: scorer(), incumbent: scorer() } };
      bucket.model.add(p, y); bucket.incumbent.add(1, y);
      bucket[population].model.add(p, y); bucket[population].incumbent.add(1, y);
      byK.set(k, bucket);
    }
  }

  report.push({
    test_season: testSeason, train_seasons: trainSeasons, horizon: HORIZON,
    constant_baseline_rate: constantRate, cases_without_a_prediction: noPrediction,
    fit_summary: {
      player_seasons: fit.player_seasons,
      // The one-week column of every cell above MIN_CELL: the table the module's own
      // header quotes, so a reader can check the header against the current data.
      one_week_rates: Object.fromEntries(Object.entries(fit.curve)
        .map(([key, byK]) => [key, byK[1]])
        .filter(([, v]) => v && v.n >= fit.min_cell)
        .sort((a, b) => b[1].n - a[1].n)
        .map(([key, v]) => [key, { n: v.n, rate: +v.rate.toFixed(4) }]))
    },
    all: { model: all.model.get(), incumbent: all.incumbent.get(), constant: all.constant.get() },
    active: { model: active.model.get(), incumbent: active.incumbent.get(), constant: active.constant.get() },
    reserve: { model: reserve.model.get(), incumbent: reserve.incumbent.get(), constant: reserve.constant.get() },
    by_horizon: Object.fromEntries([...byK].sort((a, b) => a[0] - b[0])
      .map(([k, v]) => [k, { model: v.model.get(), incumbent: v.incumbent.get(),
        active: { model: v.active.model.get(), incumbent: v.active.incumbent.get() },
        reserve: { model: v.reserve.model.get(), incumbent: v.reserve.incumbent.get() } }]))
  });
}

if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const pct = v => (v == null ? '   -  ' : `${(100 * v).toFixed(1)}%`);
const f4 = v => (v == null ? '  -   ' : v.toFixed(4));
for (const r of report) {
  console.log(`\n${c.b(`Test season ${r.test_season}`)}  ${c.dim(`fitted on ${r.train_seasons.join(', ')}, horizons 1-${r.horizon}`)}`);
  const oneWeek = r.fit_summary.one_week_rates;
  console.log(c.dim(`  fit: ${r.fit_summary.player_seasons} player-seasons; one-week rates — `
    + `active+played ${pct(oneWeek.active_played?.rate)} (n=${oneWeek.active_played?.n ?? 0}), `
    + `active+idle ${pct(oneWeek.active_idle?.rate)} (n=${oneWeek.active_idle?.n ?? 0})`));
  for (const [name, set] of [['every player-week', r.all], ['active weeks only', r.active],
    ['reserve weeks only', r.reserve]]) {
    if (!set.model) { console.log(`  ${name}: no cases`); continue; }
    const better = set.model.brier < set.incumbent.brier;
    console.log(`  ${c.b(name)} — n=${set.model.n}, outcome rate ${pct(set.model.base_rate)}`);
    console.log(`    Brier     model ${f4(set.model.brier)}   incumbent(P=1) ${f4(set.incumbent.brier)}   constant ${f4(set.constant.brier)}   `
      + (better ? c.g(`model better by ${f4(set.incumbent.brier - set.model.brier)}`) : c.r('model WORSE')));
    console.log(`    Log loss  model ${f4(set.model.log_loss)}   incumbent(P=1) ${f4(set.incumbent.log_loss)}   constant ${f4(set.constant.log_loss)}`);
  }
  const ks = Object.entries(r.by_horizon);
  if (ks.length) {
    console.log(c.dim('  Brier by horizon (model vs incumbent): ')
      + ks.map(([k, v]) => `k=${k} ${f4(v.model.brier)}/${f4(v.incumbent.brier)}`).join('  '));
  }
  if (r.cases_without_a_prediction) {
    console.log(c.dim(`  ${r.cases_without_a_prediction} case(s) the fit could not price — reported, not dropped silently`));
  }
}
console.log('');
