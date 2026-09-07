/**
 * Player-engine context features for the TD prop calibration heads.
 *
 * The props model (nfl-props.js) is built entirely from play-by-play: volume x
 * efficiency out of the shared player-week engine, simulated, then rescaled by
 * a calibration head. Nothing in that chain knows anything about a player that
 * is not in the last few weeks of snaps — so it cannot tell a 0.22 anytime-TD
 * probability that reflects a settled goal-line role from a 0.22 that reflects
 * three weeks of noise on a player who just inherited the job in March.
 *
 * Three engines built for the fantasy side already carry exactly that context,
 * and none of them has ever been offered to the props model:
 *
 *  - player-career.js   — multi-season TD production and how consistent it is
 *  - preseason-model.js — the projected role/points band for season T
 *  - offseason-model.js — vacated opportunity and depth-chart movement into T
 *
 * All three are read here at SEASON granularity and are strictly pre-Week-1
 * for their season, which is what makes them legal against the player_props
 * feature contract:
 *
 *  - careerLine(gsis, { season }) reads only completed seasons BEFORE `season`;
 *  - preseasonProjections(season) fits on seasons < season and reads only the
 *    preseason board plus prior-season charting for season T;
 *  - buildPanel(season) is the offseason panel, whose feature columns are all
 *    documented as pre-Week-1 of T (its outcome columns are ignored here).
 *
 * That means a feature attached to a season-T player-week never contains
 * anything from season T's games, including the target week's. It is coarser
 * than the weekly features it sits beside — the same number is used for all of
 * a player's weeks in a season — which is a real limitation, not a bug: these
 * engines produce season-level context and pretending otherwise would be the
 * leak.
 *
 * Every feature is emitted alongside a `*_missing` indicator rather than being
 * silently zero-filled, because "not on the preseason board" is itself
 * information and imputing it as an average player would hide it.
 */
import { careerLine } from './player-career.js';
import { preseasonProjections } from './preseason-model.js';
import { buildPanel } from './offseason-model.js';
import { rows } from '../db/index.js';

/** Feature blocks, so a candidate head can take one engine at a time. */
export const PROP_PLAYER_FEATURE_BLOCKS = Object.freeze({
  career: ['career_td_per_game', 'career_td_consistency', 'career_seasons', 'career_top12_rate', 'career_missing'],
  preseason: ['pre_ppg', 'pre_pos_rank_inv', 'pre_expected_games', 'pre_missing'],
  churn: ['off_vacated_share', 'off_depth_rank_delta', 'off_changed_team', 'off_prior_opp_share', 'off_missing']
});

export const PROP_PLAYER_FEATURE_NAMES = Object.freeze(
  Object.values(PROP_PLAYER_FEATURE_BLOCKS).flat());

const num = v => (Number.isFinite(v) ? v : null);
const cache = new Map();

/**
 * Career TD profile over the completed seasons before `season`.
 *
 * Rate is total TDs per game played, and consistency is 1 - the coefficient of
 * variation of that rate across seasons: a player who scored at the same rate
 * three years running gets a high number, one whose rate swung wildly gets a
 * low one. That distinction is the whole point — the raw model already knows
 * how often he has scored recently, not whether that rate has ever held up.
 */
function careerBlock(gsis, season) {
  const line = careerLine(gsis, { season, seasons: 5 });
  const seasons = (line?.seasons ?? []).filter(s => s.games > 0);
  if (!seasons.length) {
    return { career_td_per_game: 0, career_td_consistency: 0, career_seasons: 0,
      career_top12_rate: 0, career_missing: 1 };
  }
  const rates = seasons.map(s => s.total_td / s.games);
  const games = seasons.reduce((a, s) => a + s.games, 0);
  const tds = seasons.reduce((a, s) => a + s.total_td, 0);
  const m = rates.reduce((a, v) => a + v, 0) / rates.length;
  const sd = Math.sqrt(rates.reduce((a, v) => a + (v - m) ** 2, 0) / rates.length);
  const consistency = rates.length >= 2 && m > 0 ? Math.max(0, 1 - sd / m) : 0;
  const counted = line.consistency?.seasons_counted ?? seasons.length;
  return {
    career_td_per_game: games > 0 ? tds / games : 0,
    career_td_consistency: consistency,
    career_seasons: seasons.length,
    career_top12_rate: counted > 0 ? (line.consistency?.seasons_top12 ?? 0) / counted : 0,
    career_missing: 0
  };
}

/**
 * Season features for every player with any of the three engines' context.
 *
 * @returns Map<gsis_id, Record<featureName, number>>
 */
export function propPlayerFeatures(season) {
  season = Number(season);
  if (cache.has(season)) return cache.get(season);

  const out = new Map();
  const blank = () => Object.fromEntries(PROP_PLAYER_FEATURE_NAMES.map(k => [k, 0]));

  const ensure = gsis => {
    let r = out.get(gsis);
    if (!r) {
      r = blank();
      r.career_missing = 1; r.pre_missing = 1; r.off_missing = 1;
      out.set(gsis, r);
    }
    return r;
  };

  // Every gsis that has a season-T play-by-play row is a candidate. Reading the
  // id list from season T is not a leak: it says who played, not how they did,
  // and props are only ever quoted on players who are on a roster anyway.
  const ids = rows('SELECT DISTINCT player_id FROM nfl_player_week_features WHERE season = ?', season)
    .map(r => r.player_id).filter(Boolean);
  for (const gsis of ids) ensure(gsis);

  for (const gsis of out.keys()) Object.assign(out.get(gsis), careerBlock(gsis, season));

  let pre = new Map();
  try { pre = preseasonProjections(season) ?? new Map(); } catch { pre = new Map(); }
  for (const [gsis, p] of pre) {
    const r = ensure(gsis);
    r.pre_ppg = num(p.ppg) ?? 0;
    // Rank inverted so bigger is better and the scale is bounded; an unranked
    // player already reads as 0 through pre_missing.
    r.pre_pos_rank_inv = Number.isFinite(p.pos_rank) ? 1 / (1 + p.pos_rank) : 0;
    r.pre_expected_games = num(p.expected_games) ?? 0;
    r.pre_missing = 0;
  }

  let panel = [];
  try { panel = buildPanel(season) ?? []; } catch { panel = []; }
  for (const row of panel) {
    const r = ensure(row.player_id);
    r.off_vacated_share = num(row.vacated_share_new_team) ?? 0;
    r.off_depth_rank_delta = num(row.depth_rank_delta) ?? 0;
    r.off_changed_team = row.changed_team ? 1 : 0;
    r.off_prior_opp_share = num(row.prior_opp_share) ?? 0;
    r.off_missing = 0;
  }

  cache.set(season, out);
  return out;
}

/** Coverage of each block for a season — reported, never assumed. */
export function propPlayerFeatureCoverage(season) {
  const m = propPlayerFeatures(season);
  const n = m.size;
  const have = key => [...m.values()].filter(r => r[key] === 0).length;
  return { season, players: n,
    career: n ? +(have('career_missing') / n).toFixed(3) : 0,
    preseason: n ? +(have('pre_missing') / n).toFixed(3) : 0,
    churn: n ? +(have('off_missing') / n).toFixed(3) : 0 };
}

export function clearPropPlayerFeatureCache() { cache.clear(); }
