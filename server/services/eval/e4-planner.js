/**
 * E4 planner vs simple baselines, graded on the Sleeper replay (EVAL-E4).
 *
 * Question: when the War Room planner picks a move, does that move beat the
 * simple things Nick could do instead, measured in what really happened?
 *
 *   planner   the War Room planner's best plan (server/services/campaign/planner.js)
 *   finder    the Trade Lab finder's best single offer (proxy: best p x title delta
 *             over 1-for-1 / 2-for-1 deals inside the finder's fairness window where
 *             both lineups improve)
 *   nothing   do nothing (realized gain 0 by definition)
 *   greedy    the best value-fair 1-for-1 by projected lineup points, no simulator
 *
 * Every arm is scored the same way: the move is applied to the week-6 rosters,
 * the rest of the season is replayed with the players' REAL weekly points
 * (same lineup rule for every arm), and the realized title and playoff outcome
 * is compared with doing nothing. A multi-step plan is scored as its expected
 * realized gain across accept/decline outcomes, using the same acceptance curve
 * for every arm. Sleeper holds executed trades only, so that curve is ASSUMED,
 * not observed: `real_behavior_only` is false and the row says so.
 *
 * Two rows:
 *   E4       the historical replay (fit 2021-22, graded 2023-24, 2025 untouched),
 *            stored as a FIXED row (source 'historical_fixed', like E3). Numbers are
 *            frozen in HISTORICAL by scripts/eval/e4-planner-replay.mjs.
 *   E4-live  the target league in 2026: one row per graded week in
 *            `planner_move_outcomes` (not built yet). not_enough_data until
 *            LIVE_MIN_WEEKS weeks exist.
 *
 * Pass bar (pre-registered in the replay script header and the PR before the
 * graded run): planner minus the BEST baseline (highest mean on the graded rows),
 * realized title gain, league-clustered bootstrap 95% CI lower bound > 0.
 * Failing: that CI wholly below 0. Otherwise not_enough_data.
 */
import { STATUS, result, readSource, waiting } from './common.js';
import { bootstrapCI, mean, moreNeeded, round } from './stats.js';

export const CHECK = 'E4';
export const LIVE_CHECK = 'E4-live';
export const NAME = 'Planner vs simple baselines';
export const BASELINES = Object.freeze(['finder', 'nothing', 'greedy']);
export const ARMS = Object.freeze(['planner', ...BASELINES]);
export const LIVE_MIN_WEEKS = 4;
export const BOOT = Object.freeze({ reps: 2000, seed: 404 });
export const PASS_BAR = 'planner minus the best simple baseline (finder best offer, do nothing, greedy fair 1-for-1): '
  + 'realized title gain, league-clustered 95% CI > 0';

/**
 * The frozen historical result: the graded 2023-24 run's summary (aggregates only),
 * copied from scripts/eval/e4-planner-replay.mjs output. Title gains on the 0-1 scale.
 */
export const HISTORICAL = Object.freeze({
  "title": {
    "n": 1792,
    "league_seasons": 896,
    "means": {
      "planner": 0.00163,
      "finder": 0.0005,
      "nothing": 0,
      "greedy": -0.001
    },
    "best_baseline": "finder",
    "vs_best": {
      "mean": 0.00113,
      "ci": [
        -0.00457,
        0.00685
      ]
    },
    "vs": {
      "finder": {
        "mean": 0.00113,
        "ci": [
          -0.00457,
          0.00685
        ]
      },
      "nothing": {
        "mean": 0.00163,
        "ci": [
          -0.00382,
          0.00659
        ]
      },
      "greedy": {
        "mean": 0.00262,
        "ci": [
          -0.00238,
          0.00752
        ]
      }
    }
  },
  "playoff": {
    "n": 1792,
    "league_seasons": 896,
    "means": {
      "planner": 0.00014,
      "finder": -0.00531,
      "nothing": 0,
      "greedy": 0.00631
    },
    "best_baseline": "greedy",
    "vs_best": {
      "mean": -0.00617,
      "ci": [
        -0.01175,
        -0.00064
      ]
    },
    "vs": {
      "finder": {
        "mean": 0.00545,
        "ci": [
          -0.00074,
          0.01223
        ]
      },
      "nothing": {
        "mean": 0.00014,
        "ci": [
          -0.00541,
          0.00567
        ]
      },
      "greedy": {
        "mean": -0.00617,
        "ci": [
          -0.01175,
          -0.00064
        ]
      }
    }
  },
  "title_if_completed": {
    "n": 1792,
    "league_seasons": 896,
    "means": {
      "planner": 0.00614,
      "finder": 0.00056,
      "nothing": 0,
      "greedy": -0.00391
    },
    "best_baseline": "finder",
    "vs_best": {
      "mean": 0.00558,
      "ci": [
        -0.00949,
        0.02009
      ]
    },
    "vs": {
      "finder": {
        "mean": 0.00558,
        "ci": [
          -0.00949,
          0.02009
        ]
      },
      "nothing": {
        "mean": 0.00614,
        "ci": [
          -0.00837,
          0.02009
        ]
      },
      "greedy": {
        "mean": 0.01004,
        "ci": [
          -0.00558,
          0.02455
        ]
      }
    }
  },
  "playoff_if_completed": {
    "n": 1792,
    "league_seasons": 896,
    "means": {
      "planner": 0.00446,
      "finder": -0.01283,
      "nothing": 0,
      "greedy": 0.01953
    },
    "best_baseline": "greedy",
    "vs_best": {
      "mean": -0.01507,
      "ci": [
        -0.03181,
        0.00167
      ]
    },
    "vs": {
      "finder": {
        "mean": 0.0173,
        "ci": [
          0.00056,
          0.03516
        ]
      },
      "nothing": {
        "mean": 0.00446,
        "ci": [
          -0.01116,
          0.02009
        ]
      },
      "greedy": {
        "mean": -0.01507,
        "ci": [
          -0.03181,
          0.00167
        ]
      }
    }
  },
  "by_season_title": {
    "2023": {
      "n": 890,
      "means": {
        "planner": 0.00103,
        "finder": -0.00254,
        "nothing": 0,
        "greedy": -0.00212
      },
      "vs_best": {
        "mean": 0.00103,
        "ci": [
          -0.00628,
          0.00811
        ]
      }
    },
    "2024": {
      "n": 902,
      "means": {
        "planner": 0.00221,
        "finder": 0.0035,
        "nothing": 0,
        "greedy": 0.00011
      },
      "vs_best": {
        "mean": -0.00129,
        "ci": [
          -0.00971,
          0.00728
        ]
      }
    }
  },
  "focal_teams": 1792,
  "league_seasons_exported": 948,
  "skipped_format": 52,
  "moves_made": {
    "planner": 1514,
    "finder": 1403,
    "greedy": 1769
  },
  "planner_mean_depth": 1.292,
  "planner_mean_sim_expected_title": 0.01011,
  "same_first_move_as_finder": 0.0185,
  "same_first_move_as_greedy": 0.041,
  "fidelity_champion_do_nothing": 0.4498,
  "split": "fit 2021-22 (simulator sd / miss rate), graded 2023-24 once, 2025 untouched",
  "acceptance": "assumed: p = clamp(0.35 + 0.01 x screen%, 0.02, 0.9)",
  "runs": 400,
  "decision_week": 7,
  "source": "scripts/eval/e4-planner-replay.mjs (pre-registered at a1ad1148), PR #294"
});

/** Gain of one arm on one row for a target ('title' | 'playoff'); nothing is 0 by definition. */
export function gainOf(row, arm, target = 'title') {
  if (arm === 'nothing') return 0;
  const v = Number(row?.[arm]?.[target]);
  return Number.isFinite(v) ? v : NaN;
}

/**
 * Paired comparison of the planner with each baseline on replay rows.
 * rows: [{ cluster, season, planner: { title, playoff }, finder: {...}, greedy: {...} }]
 * The best baseline is the one with the highest mean on these rows (chosen before the CI).
 */
export function summarize(rows, { target = 'title', reps = BOOT.reps, seed = BOOT.seed } = {}) {
  const ok = rows.filter(r => ARMS.every(a => Number.isFinite(gainOf(r, a, target))));
  const n = ok.length;
  const clusters = ok.map((r, i) => r.cluster ?? i);
  const col = arm => ok.map(r => gainOf(r, arm, target));
  const means = Object.fromEntries(ARMS.map(a => [a, n ? mean(col(a)) : null]));
  const planner = col('planner');
  const vs = {};
  BASELINES.forEach((b, j) => {
    const d = col(b).map((x, i) => planner[i] - x);
    vs[b] = { mean: n ? mean(d) : null, ci: bootstrapCI(n, idx => mean(idx.map(i => d[i])), { clusters, reps, seed: seed + j }) };
  });
  const best = n ? BASELINES.reduce((a, b) => (means[b] > means[a] ? b : a)) : null;
  return { target, n, league_seasons: new Set(clusters.map(String)).size, means, best_baseline: best,
    vs_best: best ? vs[best] : { mean: null, ci: null }, vs };
}

/** passing / failing / not_enough_data from the planner-minus-best-baseline CI. */
export function verdict(vsBest) {
  const ci = vsBest?.ci;
  if (!ci) return STATUS.NOT_ENOUGH_DATA;
  if (ci[0] > 0) return STATUS.PASSING;
  if (ci[1] < 0) return STATUS.FAILING;
  return STATUS.NOT_ENOUGH_DATA;
}

const roundSummary = s => s && ({
  ...s,
  means: Object.fromEntries(Object.entries(s.means).map(([k, v]) => [k, round(v, 5)])),
  vs_best: { mean: round(s.vs_best.mean, 5), ci: s.vs_best.ci?.map(x => round(x, 5)) ?? null },
  vs: Object.fromEntries(Object.entries(s.vs).map(([k, v]) => [k, { mean: round(v.mean, 5), ci: v.ci?.map(x => round(x, 5)) ?? null }])),
});

/** The fixed historical row. Status is computed from the stored CI, not asserted. */
export function historical(h = HISTORICAL) {
  const common = { check: CHECK, name: `${NAME} (Sleeper replay, historical)`, metricName: 'title_gain_planner_minus_best_baseline', passBar: PASS_BAR };
  if (!h) {
    return waiting({ ...common, minN: 30, unit: 'league_seasons',
      reason: 'planner replay not frozen yet (scripts/eval/e4-planner-replay.mjs)' });
  }
  const t = h.title;
  const status = verdict(t.vs_best);
  const needs = status === STATUS.NOT_ENOUGH_DATA
    ? { needsN: t.vs_best.ci ? moreNeeded(t.n, t.vs_best.ci[1] - t.vs_best.ci[0], Math.max(Math.abs(t.vs_best.mean ?? 0), 1e-3) * 2) : 30,
      needsUnit: 'league_seasons',
      needsText: `2023-24 replay inconclusive: about ${t.vs_best.ci ? moreNeeded(t.n, t.vs_best.ci[1] - t.vs_best.ci[0], Math.max(Math.abs(t.vs_best.mean ?? 0), 1e-3) * 2) : 30} more league-seasons `
        + 'at this effect size; fresh data is 2026 (E4-live) or a registered 2025 confirmation' }
    : {};
  return result({
    ...common, status, metric: t.vs_best.mean, ci: t.vs_best.ci, n: t.n, source: 'historical_fixed',
    ...needs,
    detail: { ...h, real_behavior_only: false,
      acceptance: 'assumed curve (same for every arm); Sleeper holds executed trades only' },
  });
}

/**
 * E4-live: the target league's 2026 weeks. Source table (not built yet):
 *   planner_move_outcomes(league_id, season, week, planner_gain, finder_gain, greedy_gain)
 * one row per league-week once the week's realized outcome is known.
 */
export function live(database, { season = 2026, minWeeks = LIVE_MIN_WEEKS } = {}) {
  const common = { check: LIVE_CHECK, name: `${NAME} (2026, live)`, metricName: 'title_gain_planner_minus_best_baseline', passBar: PASS_BAR };
  const src = readSource(database, 'planner_move_outcomes', ['league_id', 'season', 'week', 'planner_gain', 'finder_gain', 'greedy_gain']);
  if (!src.ok) return waiting({ ...common, minN: minWeeks, unit: 'weeks', reason: src.reason });
  const rows = src.rows.filter(r => Number(r.season) === season
    && [r.planner_gain, r.finder_gain, r.greedy_gain].every(v => v != null && Number.isFinite(Number(v))));
  const weeks = new Set(rows.map(r => `${r.league_id}:${r.week}`)).size;
  if (weeks < minWeeks) return waiting({ ...common, minN: minWeeks, n: weeks, unit: 'weeks', reason: `${weeks} graded week(s) so far` });
  const s = summarize(rows.map(r => ({ cluster: `${r.league_id}:${r.week}`, season: r.season,
    planner: { title: Number(r.planner_gain) }, finder: { title: Number(r.finder_gain) }, greedy: { title: Number(r.greedy_gain) } })));
  const status = verdict(s.vs_best);
  return result({ ...common, status, metric: s.vs_best.mean, ci: s.vs_best.ci, n: weeks,
    ...(status === STATUS.NOT_ENOUGH_DATA ? { needsN: s.vs_best.ci ? moreNeeded(weeks, s.vs_best.ci[1] - s.vs_best.ci[0], Math.max(Math.abs(s.vs_best.mean), 1e-3) * 2) : minWeeks, needsUnit: 'weeks' } : {}),
    detail: roundSummary(s) });
}

export function run(database) {
  return [historical(), live(database)];
}

export { roundSummary };
