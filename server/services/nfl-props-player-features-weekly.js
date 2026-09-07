/**
 * WEEKLY-grain context features for the TD prop calibration heads.
 *
 * This is the second attempt at one hypothesis. The first
 * (`nfl-props-player-features.js`, documented in docs/PROPS_PLAYER_ENGINES.md)
 * offered the props model three fantasy engines — career, preseason, offseason
 * churn — and was declined 0/3 and 0/3. Its own post-mortem named the reason,
 * and the reason was a methodology limit rather than a verdict on the idea:
 *
 *   "A feature that is constant across all 17 of a player's weeks cannot
 *    separate the two 0.22s the idea was meant to separate."
 *
 * That is true by construction. A season-level constant has zero within-player
 * variance, so it can shift a player's whole season up or down but can never
 * explain why week 9 differs from week 3 — which is the only thing a per-game
 * prop price is asking. The test never had a fair chance.
 *
 * So this module rebuilds the same idea at the grain the question is actually
 * asked at. Every feature here MUST vary week to week within a player-season,
 * and `weeklyVarianceReport` measures that rather than assuming it: a feature
 * whose within-player-season variance is zero is the old test wearing a new
 * label, and would be caught before any number was read.
 *
 * Three blocks:
 *
 *  - `trend`   — is his red-zone / goal-line role trending up or down INSIDE
 *                this season, going into this game: trailing-3-game rate minus
 *                his season-to-date rate. Pure play-by-play, from nfl-pbp.js's
 *                stored weekly features. This is the block the first attempt's
 *                closing paragraph asked for: "red-zone role that moves when a
 *                starter goes out in week 6, not one frozen in August."
 *
 *  - `newrole` — the offseason churn signal from offseason-model.js, but
 *                INTERACTED with how little season-T box-score evidence exists
 *                yet. The theory the season-level test could not express: a
 *                real August role change is most mispriced in the first few
 *                weeks, before the market has games to see it in, and decays to
 *                nothing by midseason. The churn number itself is season-level;
 *                the feature is not, because the weight on it moves every week.
 *
 *  - `matchup` — opponent red-zone TD rate allowed. Carried deliberately and
 *                warily. `nfl-opponent.js`'s header records that opponent
 *                adjustment made WEEKLY STAT predictions monotonically worse
 *                (passing-yards MAE 70.56 -> 90.81) through double counting:
 *                `gameScriptFor` already moves volume with the betting line,
 *                and the line already prices the opponent. That risk applies
 *                here too — the raw prop probability these heads calibrate is
 *                built from game-script-adjusted volume. So this block is never
 *                bundled invisibly into a single "all features" variant: it is
 *                its own ablation arm, and if it hurts, the ablation says so in
 *                numbers instead of the failure being repeated blind.
 *
 * CUTOFF DISCIPLINE. Every value attached to (season T, week W, player) is
 * computed from weeks strictly before W in season T, plus seasons strictly
 * before T. The target week's own row is never read — not its usage, not its
 * outcome. `assertNoTargetWeekLeak` re-derives that claim from the data.
 *
 * Every block emits a `*_missing` indicator rather than zero-filling silently,
 * for the same reason as the season-level module: "no prior games this season"
 * is information, and imputing it as an average player hides it.
 */
import { playerWeeks } from './nfl-pbp.js';
import { buildPanel } from './offseason-model.js';

/** Feature blocks, so a candidate head can take one at a time. */
export const WEEKLY_FEATURE_BLOCKS = Object.freeze({
  trend: ['wk_games_prior', 'wk_rz_opp_recent', 'wk_rz_opp_trend', 'wk_gl_opp_recent',
    'wk_gl_opp_trend', 'wk_opp_share_trend', 'wk_td_rate_recent', 'wk_td_rate_trend',
    'wk_trend_missing'],
  newrole: ['wk_early_weight', 'wk_new_role_vacated', 'wk_new_role_depth',
    'wk_new_role_team', 'wk_newrole_missing'],
  matchup: ['wk_opp_rz_td_rel', 'wk_opp_rz_opp_faced', 'wk_matchup_missing']
});

export const WEEKLY_FEATURE_NAMES = Object.freeze(Object.values(WEEKLY_FEATURE_BLOCKS).flat());

const num = v => (Number.isFinite(v) ? v : 0);
const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/**
 * How much weight the "this role change is still new" interaction carries in
 * week W. Replay rows start at week 2, so the window is weeks 2-5 and the decay
 * is linear to zero by week 6. Stated as a fixed shape before any number was
 * read, so it is not a knob that got tuned until the answer came out right.
 */
const earlyWeight = week => Math.max(0, Math.min(1, (6 - Number(week)) / 4));

/** Red-zone opportunity in one player-week: carries inside the 20 plus targets inside the 20. */
const rzOpp = f => num(f.red_zone_carries) + num(f.red_zone_targets);
/** The tighter, higher-leverage slice: goal-line carries, goal-to-go and end-zone targets. */
const glOpp = f => num(f.goal_line_carries) + num(f.goal_to_go_targets) + num(f.end_zone_targets);
const tds = f => num(f.rushing_tds) + num(f.receiving_tds);

/* ------------------------------------------------ opponent red-zone defense */

/**
 * Red-zone TDs allowed per red-zone opportunity faced, by defense.
 *
 * Built from seasons T-1 and T-2 (weighted 1 and 0.5) plus season T's weeks
 * strictly before the target week, and shrunk toward the league rate by sample
 * size so a defense with 11 red-zone snaps does not get a strong opinion.
 * Returned RELATIVE to league average, so the feature is "this defense is
 * harder or easier than average in the red zone", not "the league scores".
 *
 * Every value is a function of (defense, week), so it moves across a player's
 * season purely because his schedule does — which is exactly the within-player
 * variation the season-level attempt could not produce.
 */
function opponentRedZoneDefense(season) {
  const prior = new Map();      // defense -> {td, opp}
  let priorLeagueTd = 0, priorLeagueOpp = 0;
  for (const [s, w] of [[season - 1, 1], [season - 2, 0.5]]) {
    let weeks = [];
    try { weeks = playerWeeks(s); } catch { weeks = []; }
    for (const r of weeks) {
      if (!r.opponent) continue;
      const o = rzOpp(r.features) * w, t = tds(r.features) * w;
      if (o <= 0 && t <= 0) continue;
      const cur = prior.get(r.opponent) ?? { td: 0, opp: 0 };
      cur.td += t; cur.opp += o; prior.set(r.opponent, cur);
      priorLeagueTd += t; priorLeagueOpp += o;
    }
  }

  // Season T accumulates forward, week by week, and is only ever read for
  // weeks already played.
  const byWeek = new Map();     // week -> Map<defense, {td, opp}> as of BEFORE that week
  const running = new Map();
  let runTd = 0, runOpp = 0;
  const weeksT = playerWeeks(season);
  const allWeeks = [...new Set(weeksT.map(r => r.week))].sort((a, b) => a - b);
  for (const week of allWeeks) {
    // snapshot state as of before `week`
    byWeek.set(week, {
      per: new Map([...running].map(([k, v]) => [k, { ...v }])),
      leagueTd: runTd, leagueOpp: runOpp
    });
    for (const r of weeksT.filter(x => x.week === week)) {
      if (!r.opponent) continue;
      const o = rzOpp(r.features), t = tds(r.features);
      if (o <= 0 && t <= 0) continue;
      const c = running.get(r.opponent) ?? { td: 0, opp: 0 };
      c.td += t; c.opp += o; running.set(r.opponent, c);
      runTd += t; runOpp += o;
    }
  }

  const K = 40;   // red-zone opportunities before a defense's own rate carries half the weight
  return (defense, week) => {
    const snap = byWeek.get(Number(week));
    if (!snap || !defense) return null;
    const p = prior.get(defense) ?? { td: 0, opp: 0 };
    const s = snap.per.get(defense) ?? { td: 0, opp: 0 };
    const td = p.td + s.td, opp = p.opp + s.opp;
    const leagueOpp = priorLeagueOpp + snap.leagueOpp;
    const leagueTd = priorLeagueTd + snap.leagueTd;
    if (leagueOpp <= 0) return null;
    const leagueRate = leagueTd / leagueOpp;
    if (opp <= 0) return { rel: 0, faced: 0 };
    const rate = (td + leagueRate * K) / (opp + K);
    return { rel: leagueRate > 0 ? rate / leagueRate - 1 : 0, faced: opp };
  };
}

/* --------------------------------------------------------------- the panel */

const cache = new Map();

/**
 * Weekly features for one season.
 *
 * @returns Map<`${week}|${player_id}`, Record<featureName, number>>
 */
export function propPlayerWeeklyFeatures(season) {
  season = Number(season);
  if (cache.has(season)) return cache.get(season);

  const out = new Map();
  const weeks = playerWeeks(season);
  const oppDef = opponentRedZoneDefense(season);

  let churn = new Map();
  try {
    for (const row of buildPanel(season) ?? []) {
      churn.set(row.player_id, {
        vacated: num(row.vacated_share_new_team),
        depth: num(row.depth_rank_delta),
        team: row.changed_team ? 1 : 0
      });
    }
  } catch { churn = new Map(); }

  // Per player, the ordered list of his season-T weeks played so far.
  const history = new Map();
  const ordered = [...weeks].sort((a, b) => a.week - b.week);
  const weekList = [...new Set(ordered.map(r => r.week))].sort((a, b) => a - b);

  for (const week of weekList) {
    const ew = earlyWeight(week);
    for (const r of ordered.filter(x => x.week === week)) {
      const past = history.get(r.player_id) ?? [];
      const n = past.length;
      const recent = past.slice(-3);

      const rzRecent = mean(recent.map(rzOpp));
      const rzSeason = mean(past.map(rzOpp));
      const glRecent = mean(recent.map(glOpp));
      const glSeason = mean(past.map(glOpp));
      const shareRecent = mean(recent.map(f => num(f.opportunity_share)));
      const shareSeason = mean(past.map(f => num(f.opportunity_share)));
      const tdRecent = mean(recent.map(tds));
      const tdSeason = mean(past.map(tds));

      const c = churn.get(r.player_id) ?? null;
      const d = oppDef(r.opponent, week);

      out.set(`${week}|${r.player_id}`, {
        // trend — every one of these is a within-season, within-player quantity
        wk_games_prior: n,
        wk_rz_opp_recent: rzRecent,
        wk_rz_opp_trend: n >= 2 ? rzRecent - rzSeason : 0,
        wk_gl_opp_recent: glRecent,
        wk_gl_opp_trend: n >= 2 ? glRecent - glSeason : 0,
        wk_opp_share_trend: n >= 2 ? shareRecent - shareSeason : 0,
        wk_td_rate_recent: tdRecent,
        wk_td_rate_trend: n >= 2 ? tdRecent - tdSeason : 0,
        wk_trend_missing: n >= 2 ? 0 : 1,

        // newrole — the season-level churn number times a weight that decays
        // away over the first month. Main effect `wk_early_weight` is carried
        // too, so the interactions are not silently proxying for "it is week 2".
        wk_early_weight: ew,
        wk_new_role_vacated: c ? c.vacated * ew : 0,
        wk_new_role_depth: c ? Math.max(-5, Math.min(5, c.depth)) * ew : 0,
        wk_new_role_team: c ? c.team * ew : 0,
        wk_newrole_missing: c ? 0 : 1,

        // matchup — quarantined into its own block on purpose; see the header.
        wk_opp_rz_td_rel: d ? d.rel : 0,
        wk_opp_rz_opp_faced: d ? Math.min(400, d.faced) / 100 : 0,
        wk_matchup_missing: d && d.faced > 0 ? 0 : 1
      });
    }
    // Only AFTER every week-W row is written does week W enter the history, so
    // no row can see its own game.
    for (const r of ordered.filter(x => x.week === week)) {
      if (!history.has(r.player_id)) history.set(r.player_id, []);
      history.get(r.player_id).push(r.features);
    }
  }

  cache.set(season, out);
  return out;
}

/* --------------------------------------------------------------- integrity */

/**
 * The check that makes this a different test from the season-level one.
 *
 * For each feature, the share of player-seasons (with >= 4 weeks) in which it
 * takes more than one distinct value. A season-level constant scores 0 here by
 * definition; the missing-indicators and the churn levels are allowed to be
 * flat for some players, so the number reported is a mean share, not a pass.
 */
export function weeklyVarianceReport(season) {
  const m = propPlayerWeeklyFeatures(season);
  const byPlayer = new Map();
  for (const [key, feat] of m) {
    const pid = key.split('|')[1];
    if (!byPlayer.has(pid)) byPlayer.set(pid, []);
    byPlayer.get(pid).push(feat);
  }
  const players = [...byPlayer.values()].filter(v => v.length >= 4);
  const out = {};
  for (const name of WEEKLY_FEATURE_NAMES) {
    const varying = players.filter(v => new Set(v.map(f => f[name])).size > 1).length;
    out[name] = players.length ? +(varying / players.length).toFixed(3) : 0;
  }
  return { season, player_seasons: players.length, varying_share: out };
}

/**
 * Re-derive the cutoff claim instead of asserting it in a comment.
 *
 * Recomputes each player-week's trailing red-zone mean from the raw weekly rows
 * with the target week EXCLUDED, and requires it to match what the panel
 * emitted. If the target week had leaked into its own feature, these differ.
 */
export function assertNoTargetWeekLeak(season) {
  const m = propPlayerWeeklyFeatures(season);
  const weeks = playerWeeks(season);
  const byPlayer = new Map();
  for (const r of weeks) {
    if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []);
    byPlayer.get(r.player_id).push(r);
  }
  let checked = 0;
  for (const [pid, list] of byPlayer) {
    list.sort((a, b) => a.week - b.week);
    for (let i = 0; i < list.length; i++) {
      const feat = m.get(`${list[i].week}|${pid}`);
      if (!feat) continue;
      const expect = mean(list.slice(Math.max(0, i - 3), i).map(r => rzOpp(r.features)));
      if (Math.abs(expect - feat.wk_rz_opp_recent) > 1e-9) {
        throw new Error(`target-week leak at ${season} w${list[i].week} ${pid}: ` +
          `${feat.wk_rz_opp_recent} vs prior-only ${expect}`);
      }
      checked++;
    }
  }
  return { season, rows_checked: checked, leaked: 0 };
}

export function clearWeeklyFeatureCache() { cache.clear(); }
