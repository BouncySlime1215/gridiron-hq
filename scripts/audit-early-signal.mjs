#!/usr/bin/env node
/**
 * At week w, how much does what has happened tell you about how the season ends?
 *
 *   node scripts/audit-early-signal.mjs [--json]
 *
 * This is the measurement Team Outlook rests on. Its verdict is Fine / Watch / Act, and
 * the master plan's own standard is that it "may never say Act on noise alone" -- which
 * requires knowing, per week, how much of what has happened is noise. That is what this
 * measures, on real completed seasons rather than on judgement.
 *
 * WHAT IS BEING PREDICTED: made_playoffs, for a team-season, from its state at the end of
 * week w. Nothing after week w is an input; the outcome is never an input.
 *
 * WALK-FORWARD. Every predictor is fitted on 2021-2023 and scored on 2024 and 2025
 * separately. Fitting and scoring on the same seasons would produce a flattering number
 * and no information.
 *
 * THE BASELINES MATTER MORE THAN THE MODEL HERE. The question is not "can something
 * predict the playoffs" -- of course it can, by week 13. It is which signal is worth
 * listening to at week 2, and whether it beats the two things a person actually does:
 * read the record, or read nothing and assume the base rate.
 *
 *   base_rate      the league's playoff share, which knows nothing about the team
 *   all_play       the luck-free record: who you outscored, pooled over weeks so far
 *   points_z       scoring so far in league z-units
 *   points_shrunk  the same, shrunk toward the league by n/(n+k) with k from the
 *                  variance decomposition -- the plan's k(w), applied
 *
 * Each predictor is turned into a probability the same way: bin the fit seasons on that
 * predictor, take each bin's observed playoff rate, and read the test season off those
 * bins. Identical treatment for all of them, so the comparison is of the SIGNALS and not
 * of four different model classes. Bins are equal-count (deciles) on the fit set, so no
 * predictor is helped or hurt by an arbitrary cut point.
 *
 * SCORES: Brier and log loss, plus expected calibration error. Log loss is clipped at
 * 1e-6 and the clip is stated.
 *
 * The record is conditioned on the league's playoff share throughout, because 6 of 8
 * teams making the playoffs is a different question from 6 of 14 and pooling them would
 * credit a model for learning the league format.
 */
import { weeklyPanel, varianceComponents, shrinkToLeague, historyStatus } from '../server/services/league-history.js';

const JSON_OUT = process.argv.includes('--json');
const FIT_SEASONS = [2021, 2022, 2023];
const TEST_SEASONS = [2024, 2025];
const WEEKS = [1, 2, 3, 4, 5, 6, 8, 10, 13];
const BINS = 10;
const CLIP = 1e-6;
const clip = p => Math.min(1 - CLIP, Math.max(CLIP, p));

const c = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`,
  b: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` };

const status = historyStatus();
if (!status.available) { console.error(status.reason); process.exit(1); }

const fitPanel = weeklyPanel({ seasons: FIT_SEASONS });
const vc = varianceComponents({ panel: fitPanel });
if (!vc) { console.error('not enough history to estimate variance components'); process.exit(1); }
const K = vc.k;

/** The predictors, each a pure function of a panel row. Higher should mean better. */
const PREDICTORS = {
  base_rate: r => r.playoff_teams / r.num_teams,
  all_play: r => r.all_play_pct,
  points_z: r => r.mean_points_z,
  points_shrunk: r => shrinkToLeague(r.mean_points_z, r.games, K)
};

/** Equal-count bins on the fit set, each carrying its observed playoff rate. */
function fitBins(rowsIn, predictor) {
  const scored = rowsIn.map(r => ({ x: predictor(r), y: r.made_playoffs }))
    .filter(v => Number.isFinite(v.x)).sort((a, b) => a.x - b.x);
  if (scored.length < BINS * 5) return null;
  const size = Math.floor(scored.length / BINS);
  const bins = [];
  for (let i = 0; i < BINS; i++) {
    const slice = i === BINS - 1 ? scored.slice(i * size) : scored.slice(i * size, (i + 1) * size);
    if (!slice.length) continue;
    bins.push({
      lo: slice[0].x, hi: slice.at(-1).x, n: slice.length,
      rate: slice.reduce((s, v) => s + v.y, 0) / slice.length
    });
  }
  // A predictor with no spread (base_rate within one league shape) collapses to one
  // bin; that is a real property of the predictor, not an error.
  return bins.length ? bins : null;
}

const readBins = (bins, x) => {
  if (!Number.isFinite(x)) return null;
  for (const b of bins) if (x <= b.hi) return b.rate;
  return bins.at(-1).rate;
};

function score(preds) {
  if (!preds.length) return null;
  let brier = 0, logloss = 0, outcomes = 0;
  const buckets = new Map();
  for (const { p, y } of preds) {
    brier += (p - y) ** 2;
    logloss -= y ? Math.log(clip(p)) : Math.log(1 - clip(p));
    outcomes += y;
    const b = Math.min(9, Math.floor(p * 10));
    const acc = buckets.get(b) ?? { n: 0, p: 0, y: 0 };
    acc.n++; acc.p += p; acc.y += y; buckets.set(b, acc);
  }
  const n = preds.length;
  let ece = 0;
  for (const acc of buckets.values()) ece += (acc.n / n) * Math.abs(acc.p / acc.n - acc.y / acc.n);
  return { n, base_rate: +(outcomes / n).toFixed(4), brier: +(brier / n).toFixed(4),
    log_loss: +(logloss / n).toFixed(4), ece: +ece.toFixed(4) };
}

const report = { variance: vc, k: K, history: status, weeks: [] };

for (const testSeason of TEST_SEASONS) {
  const testPanel = weeklyPanel({ seasons: [testSeason] });
  for (const week of WEEKS) {
    const fitRows = fitPanel.filter(r => r.week === week);
    const testRows = testPanel.filter(r => r.week === week);
    if (!fitRows.length || !testRows.length) continue;
    const entry = { test_season: testSeason, week, fit_n: fitRows.length, test_n: testRows.length, predictors: {} };
    for (const [name, fn] of Object.entries(PREDICTORS)) {
      const bins = fitBins(fitRows, fn);
      if (!bins) { entry.predictors[name] = null; continue; }
      const preds = testRows.map(r => ({ p: readBins(bins, fn(r)), y: r.made_playoffs }))
        .filter(v => v.p != null);
      entry.predictors[name] = score(preds);
    }
    report.weeks.push(entry);
  }
}

/*
 * The master plan's own early evidence, re-measured at scale.
 *
 * D1 records these from Nick's 7 completed league-seasons (62 team-seasons) and labels
 * them small and descriptive: "top-4 base rate 45%; after a bad week 1, 38%; after bad
 * weeks 1-3, 24%; after hot weeks 1-3, 71%", concluding "one bad week is mostly noise;
 * three bad weeks are signal". That conclusion is load-bearing for the verdict
 * thresholds, so it is worth knowing whether 62 team-seasons got it right.
 *
 * Restricted to leagues where six of twelve make the playoffs, so the base rate is one
 * number rather than a mixture and the comparison is not confounded by league format.
 * "Bad" is outscoring under a third of the league over the weeks so far, "hot" over two
 * thirds -- the all-play form, because a record at week 1 is mostly a coin flip.
 */
const allPanel = weeklyPanel({});
const byTeam = new Map();
for (const r of allPanel) {
  const key = `${r.league_id}|${r.roster_id}`;
  (byTeam.get(key) ?? byTeam.set(key, []).get(key)).push(r);
}
const teams = [...byTeam.values()].map(ws => {
  ws.sort((a, b) => a.week - b.week);
  return {
    made: ws[0].made_playoffs,
    share: ws[0].playoff_teams / ws[0].num_teams,
    w1: ws.find(x => x.week === 1), w3: ws.find(x => x.week === 3)
  };
}).filter(t => t.w1 && t.w3 && Math.abs(t.share - 0.5) < 0.01);

const rateOf = list => (list.length ? +(list.reduce((s, t) => s + t.made, 0) / list.length).toFixed(3) : null);
const descriptive = {
  population: 'leagues where 6 of 12 make the playoffs',
  team_seasons: teams.length,
  base_rate: rateOf(teams),
  after_bad_week_1: { n: teams.filter(t => t.w1.all_play_pct < 0.34).length,
    rate: rateOf(teams.filter(t => t.w1.all_play_pct < 0.34)), plan_said: 0.38 },
  after_bad_weeks_1_3: { n: teams.filter(t => t.w3.all_play_pct < 0.34).length,
    rate: rateOf(teams.filter(t => t.w3.all_play_pct < 0.34)), plan_said: 0.24 },
  after_hot_weeks_1_3: { n: teams.filter(t => t.w3.all_play_pct > 0.66).length,
    rate: rateOf(teams.filter(t => t.w3.all_play_pct > 0.66)), plan_said: 0.71 }
};
report.descriptive = descriptive;

if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

console.log(`\n${c.b('League history')} ${c.dim(`${status.leagues} leagues, ${status.team_seasons} team-seasons`)}`);
console.log(`${c.b('Variance decomposition')} ${c.dim(`(fit seasons ${FIT_SEASONS.join(', ')}, ${vc.team_seasons} team-seasons)`)}`);
console.log(`  within-team week-to-week variance  ${vc.s2_within}`);
console.log(`  between-team true variance         ${vc.s2_between}   ${c.dim(`(observed ${vc.s2_observed_between}, sampling error removed)`)}`);
console.log(`  ${c.b(`k = ${K}`)}  ${c.dim(`so the observed mean carries half the weight after ${vc.games_for_half_weight} games`)}`);
const w = vc.weight_by_week;
const pc = n => `${(w[n] * 100).toFixed(1)}%`;
console.log(c.dim(`  weight on what has happened: wk1 ${pc(1)}  wk2 ${pc(2)}  wk3 ${pc(3)}  wk4 ${pc(4)}  wk6 ${pc(6)}  wk8 ${pc(8)}  wk13 ${pc(13)}`));

for (const testSeason of TEST_SEASONS) {
  console.log(`\n${c.b(`Predicting made_playoffs, ${testSeason} held out`)} ${c.dim(`(bins fitted on ${FIT_SEASONS.join(', ')})`)}`);
  console.log(c.dim('  wk     n   base  all_play  points_z  shrunk   | best'));
  for (const e of report.weeks.filter(x => x.test_season === testSeason)) {
    const p = e.predictors;
    const f = v => (v == null ? '  -   ' : v.brier.toFixed(4));
    const named = Object.entries(p).filter(([, v]) => v).sort((a, b) => a[1].brier - b[1].brier);
    const best = named[0];
    const beatsBase = best && p.base_rate && best[1].brier < p.base_rate.brier;
    console.log(`  ${String(e.week).padStart(2)} ${String(e.test_n).padStart(5)}  `
      + `${f(p.base_rate)}  ${f(p.all_play)}    ${f(p.points_z)}  ${f(p.points_shrunk)}  | `
      + (best ? (beatsBase ? c.g(best[0]) : c.r(`${best[0]} (no better than base)`)) : '-'));
  }
}
console.log(c.dim('\n  Brier, lower is better. Log loss clipped at 1e-6. Every predictor is binned '
  + 'identically (fit-set deciles) so the comparison is of signals, not model classes.'));

const d = descriptive;
console.log(`\n${c.b('The plan\'s early evidence, re-measured')} ${c.dim(`(${d.population}, ${d.team_seasons} team-seasons vs the plan's 62)`)}`);
console.log(c.dim('                        measured    n     plan said (on 62)'));
for (const [label, key] of [['base rate', null], ['after a bad week 1', 'after_bad_week_1'],
  ['after bad weeks 1-3', 'after_bad_weeks_1_3'], ['after hot weeks 1-3', 'after_hot_weeks_1_3']]) {
  if (!key) { console.log(`  ${label.padEnd(22)} ${String(d.base_rate).padStart(6)}  ${String(d.team_seasons).padStart(5)}`); continue; }
  const v = d[key];
  const gap = Math.abs(v.rate - v.plan_said);
  console.log(`  ${label.padEnd(22)} ${String(v.rate).padStart(6)}  ${String(v.n).padStart(5)}      ${v.plan_said}`
    + `   ${gap <= 0.04 ? c.g(`within ${(gap * 100).toFixed(1)}pp`) : c.r(`off by ${(gap * 100).toFixed(1)}pp`)}`);
}
console.log('');
