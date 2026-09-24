/**
 * E4 planner vs simple: on Sleeper replays, would the planner's moves have
 * beaten "take the finder's best offer" and "do nothing"?
 *
 * Source: the replay study's output file (not produced yet). Path from
 * GRIDIRON_E4_REPLAY_JSON, else server/data/eval/e4-planner-replay.json.
 * Contract:
 *   { "real_behavior_only": true,
 *     "rows": [{ "league_season": "...", "planner_gain": x, "finder_gain": x, "nothing_gain": x }] }
 * gains in title-odds points, one row per replayed league-season. The file
 * must declare real_behavior_only: the spec allows only steps where the other
 * side's REAL behaviour is known — a replay that invents accepts (as the
 * ACQ-FLIP prototype, #227, does with today's P(accept)) is not graded.
 *
 * Pass bar: planner minus each baseline, 95% CI > 0 for both.
 * Failing: either CI wholly below 0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATUS, result, waiting } from './common.js';
import { bootstrapCI, mean, moreNeeded } from './stats.js';

export const CHECK = 'E4';
export const NAME = 'Planner vs simple baselines';
export const MIN_N = 30;
const PASS_BAR = "planner title-odds gain minus finder's best offer AND minus do-nothing, both CI > 0";
export const DEFAULT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/eval/e4-planner-replay.json');

export function grade(file, { reason = null } = {}) {
  const common = { check: CHECK, name: NAME, metricName: 'min_gain_vs_baselines', passBar: PASS_BAR };
  if (!file) return waiting({ ...common, minN: MIN_N, unit: 'league_seasons', reason });
  if (file.real_behavior_only !== true) {
    return waiting({ ...common, minN: MIN_N, unit: 'league_seasons',
      reason: 'replay output does not declare real_behavior_only: invented accepts are not graded' });
  }
  const rows = (file.rows ?? []).filter(r => [r.planner_gain, r.finder_gain, r.nothing_gain].every(v => Number.isFinite(Number(v))));
  const n = rows.length;
  if (n < MIN_N) return waiting({ ...common, minN: MIN_N, n, unit: 'league_seasons', reason });
  const vsFinder = rows.map(r => Number(r.planner_gain) - Number(r.finder_gain));
  const vsNothing = rows.map(r => Number(r.planner_gain) - Number(r.nothing_gain));
  const clusters = rows.map((r, i) => r.league_season ?? i);
  const ciF = bootstrapCI(n, idx => mean(idx.map(i => vsFinder[i])), { clusters, seed: 308 });
  const ciN = bootstrapCI(n, idx => mean(idx.map(i => vsNothing[i])), { clusters, seed: 309 });
  const mF = mean(vsFinder);
  const mN = mean(vsNothing);
  const worse = mF <= mN ? { m: mF, ci: ciF } : { m: mN, ci: ciN };
  const detail = { vs_finder: { mean: mF, ci: ciF }, vs_nothing: { mean: mN, ci: ciN } };
  if ((ciF && ciF[1] < 0) || (ciN && ciN[1] < 0)) {
    return result({ ...common, status: STATUS.FAILING, metric: worse.m, ci: worse.ci, n, detail });
  }
  if (ciF && ciN && ciF[0] > 0 && ciN[0] > 0) {
    return result({ ...common, status: STATUS.PASSING, metric: worse.m, ci: worse.ci, n, detail });
  }
  const needs = worse.ci ? moreNeeded(n, worse.ci[1] - worse.ci[0], Math.max(Math.abs(worse.m), 1e-3) * 2) : MIN_N;
  return result({ ...common, status: STATUS.NOT_ENOUGH_DATA, metric: worse.m, ci: worse.ci, n, needsN: needs, needsUnit: 'league_seasons', detail });
}

/** The replay file, or why there is none. A file that exists but will not parse is an error, not an absence. */
export function load(filePath = process.env.GRIDIRON_E4_REPLAY_JSON || DEFAULT_PATH) {
  if (!fs.existsSync(filePath)) return { file: null, reason: 'planner replay output not produced yet; the E4 planner replay harness (Sleeper, no unit assigned yet) produces it' };
  return { file: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
}

export function run(_database, { filePath } = {}) {
  const { file, reason } = load(filePath);
  return grade(file, { reason });
}
