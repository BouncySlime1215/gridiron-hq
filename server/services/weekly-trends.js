/**
 * What has changed recently, and whether it is real.
 *
 * The database holds 178 team metrics and about 60 player metrics for every week
 * of four seasons, and almost none of it has ever been read as a TIME SERIES.
 * Everything downstream consumes season aggregates, which is exactly the view
 * that cannot see the thing fantasy managers most want to know: that an offence
 * started throwing three weeks ago, that a receiver's target share has climbed
 * every game since the bye, that a defence has stopped generating pressure.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS MOSTLY A STATISTICS PROBLEM
 *
 * "Team X has been more pass-heavy lately" is trivial to compute and worthless
 * to compute naively, because with three games of data almost every metric looks
 * like it is trending. Weekly football numbers are extremely noisy: pass rate
 * swings twelve points on game script alone, and a team that fell behind twice
 * will look like it has changed philosophy when it has changed nothing.
 *
 * So a claim is only made when it survives three filters:
 *
 *  1. IT IS A PRE-SPECIFIED METRIC. Fifteen are tested, chosen in advance for
 *     having a mechanical link to fantasy scoring. Scanning all 178 and
 *     reporting whatever moved is how you manufacture a finding every single
 *     week, forever, with no information in any of them.
 *
 *  2. IT CLEARS A WELCH t-TEST against the same team's earlier weeks. Welch
 *     rather than Student because the recent window is small and its variance is
 *     usually different — game script alone guarantees that.
 *
 *  3. IT SURVIVES A ŠIDÁK CORRECTION across the fifteen. Testing fifteen metrics
 *     at p < 0.05 produces roughly one false positive per team per week by
 *     construction, which across 32 teams is 32 confident lies.
 *
 * What comes out the other side is a much shorter list than the naive version,
 * and it is a list where each entry has actually happened.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ON THE SHORT-WINDOW PROBLEM, WHICH CANNOT BE SOLVED, ONLY DISCLOSED
 *
 * Three games is three observations. Even a real change often will not clear a
 * significance bar on three points, and the honest consequence is that this
 * reports FEWER trends than a manager expects, especially early in a season.
 * That is the correct behaviour: the alternative is a page that always has
 * something exciting to say, which is the same page whether or not anything is
 * happening. Effect size is reported alongside significance so a large-but-
 * unproven move is visible as exactly that rather than hidden or promoted.
 */
import { rows, row } from '../db/index.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

/**
 * The metrics tested, fixed in advance.
 *
 * Each carries the fantasy consequence it implies, because a trend without a
 * consequence is trivia — "their third-down distance is up 0.4 yards" is true,
 * significant, and of no use to anyone setting a lineup.
 *
 * `direction` says which way is good for the fantasy asset named in `helps`.
 */
export const TRACKED = [
  { key: 'off_neutral_pass_rate', label: 'pass rate in neutral game script', unit: 'pct',
    helps: 'WR/TE', direction: 'up',
    up: 'throwing more when the game is close, which is the version of pass rate that is not just a scoreboard artefact',
    down: 'leaning on the run when the game is close' },
  { key: 'off_proe', label: 'pass rate over expected', unit: 'pct',
    helps: 'WR/TE', direction: 'up',
    up: 'passing more than the down, distance and score would predict — a genuine change in approach',
    down: 'passing less than the situation calls for' },
  { key: 'off_plays', label: 'plays run per game', unit: 'count',
    helps: 'everyone', direction: 'up',
    up: 'running more total plays, which raises the ceiling for every skill player on the roster',
    down: 'running fewer plays, shrinking the pie for everyone' },
  { key: 'off_seconds_per_drive', label: 'seconds per drive', unit: 'count',
    helps: 'everyone', direction: 'down',
    up: 'taking longer per drive, which means fewer possessions',
    down: 'playing faster, which means more possessions and more opportunities' },
  { key: 'off_red_zone_plays', label: 'red zone snaps', unit: 'count',
    helps: 'RB/TE', direction: 'up',
    up: 'reaching the red zone more often, where touchdowns are actually scored',
    down: 'stalling before the red zone' },
  { key: 'off_red_zone_td_rate', label: 'red zone touchdown rate', unit: 'pct',
    helps: 'RB/TE', direction: 'up',
    up: 'finishing drives with touchdowns rather than field goals',
    down: 'settling for field goals, which pays a kicker and nobody else' },
  { key: 'off_adot', label: 'average depth of target', unit: 'count',
    helps: 'deep WR', direction: 'up',
    up: 'throwing further downfield, which favours the boundary receivers over the slot',
    down: 'throwing shorter, which favours possession receivers and backs in the passing game' },
  { key: 'off_epa_per_play', label: 'efficiency per play', unit: 'count',
    helps: 'everyone', direction: 'up',
    up: 'moving the ball better, which sustains drives and creates volume',
    down: 'stalling, which costs everyone snaps' },
  { key: 'off_pass_epa_per_play', label: 'passing efficiency', unit: 'count',
    helps: 'QB/WR', direction: 'up',
    up: 'throwing efficiently, which sustains passing volume rather than forcing a run script',
    down: 'struggling to throw' },
  { key: 'off_rush_epa_per_carry', label: 'rushing efficiency', unit: 'count',
    helps: 'RB', direction: 'up',
    up: 'running effectively, which keeps the ground game in the plan',
    down: 'unable to run, which usually means the backs lose work' },
  { key: 'off_no_huddle_rate', label: 'no-huddle rate', unit: 'pct',
    helps: 'everyone', direction: 'up',
    up: 'going up-tempo more often, adding plays to the game',
    down: 'slowing down' },
  // Defensive metrics matter as MATCHUP information: they describe what an
  // opponent gives up, which is how you decide who to start against them.
  { key: 'def_pass_epa_per_play', label: 'passing efficiency allowed', unit: 'count',
    helps: 'opposing WR/QB', direction: 'up',
    up: 'giving up more through the air, so receivers facing them are in a better spot',
    down: 'tightening up against the pass' },
  { key: 'def_rush_epa_per_play', label: 'rushing efficiency allowed', unit: 'count',
    helps: 'opposing RB', direction: 'up',
    up: 'giving up more on the ground, so backs facing them are in a better spot',
    down: 'holding up against the run' },
  { key: 'def_explosive_pass_rate', label: 'explosive passes allowed', unit: 'pct',
    helps: 'opposing deep WR', direction: 'up',
    up: 'surrendering big plays through the air',
    down: 'keeping everything in front of them' },
  { key: 'def_red_zone_td_rate', label: 'red zone touchdowns allowed', unit: 'pct',
    helps: 'opposing RB/TE', direction: 'up',
    up: 'letting opponents finish drives with touchdowns',
    down: 'holding opponents to field goals' }
];

/** Two-sample Welch t-test. Returns t, approximate df, and a two-sided p. */
export function welch(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
  const varOf = xs => {
    const m = mean(xs);
    return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  };
  const ma = mean(a), mb = mean(b);
  const va = varOf(a), vb = varOf(b);
  const sa = va / a.length, sb = vb / b.length;
  const denom = Math.sqrt(sa + sb);
  if (!(denom > 1e-12)) return null;
  const t = (ma - mb) / denom;
  // Welch–Satterthwaite degrees of freedom.
  const df = (sa + sb) ** 2 / ((sa ** 2) / (a.length - 1) + (sb ** 2) / (b.length - 1));
  return { t: r3(t), df: r2(df), p: r3(twoSidedP(t, df)), mean_recent: r3(ma), mean_before: r3(mb),
    // Cohen's d on the pooled standard deviation — the size of the move, which
    // matters independently of whether it cleared a significance bar on three
    // observations.
    effect: r3((ma - mb) / Math.sqrt(((a.length - 1) * va + (b.length - 1) * vb) / (a.length + b.length - 2) || 1)) };
}

/**
 * Two-sided p from a t statistic, via the incomplete beta function.
 *
 * A normal approximation is tempting and wrong here: the recent window is three
 * or four games, and at those degrees of freedom the normal tail understates p
 * badly enough to promote noise into findings — which is the exact failure this
 * whole module exists to avoid.
 */
export function twoSidedP(t, df) {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return 1;
  const x = df / (df + t * t);
  return Math.max(0, Math.min(1, incompleteBeta(x, df / 2, 0.5)));
}

/** Regularised incomplete beta, by the standard continued fraction. */
function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  let f = 1, c = 1, d = 0;
  for (let i = 0; i <= 200; i++) {
    const m = Math.floor(i / 2);
    let numerator;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else numerator = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    const cd = c * d;
    f *= cd;
    if (Math.abs(1 - cd) < 1e-10) break;
  }
  const v = front * (f - 1);
  // The identity below keeps the continued fraction in its convergent region.
  return a < (a + b) * x ? 1 - incompleteBetaSwap(1 - x, b, a) : v;
}
function incompleteBetaSwap(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  let f = 1, c = 1, d = 0;
  for (let i = 0; i <= 200; i++) {
    const m = Math.floor(i / 2);
    let numerator;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else numerator = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    const cd = c * d;
    f *= cd;
    if (Math.abs(1 - cd) < 1e-10) break;
  }
  return front * (f - 1);
}

/** Lanczos log-gamma. */
function lgamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

/**
 * How one team has changed over its last few games.
 *
 * @param lookback how many recent games form the "now" window. Three is the
 *   default because it is what a manager means by "lately" and because four is
 *   often a quarter of the observed season.
 */
export function teamTrends(team, season, { throughWeek = null, lookback = 3, alpha = 0.05 } = {}) {
  const all = rows(
    `SELECT week, features FROM nfl_team_week_features
     WHERE team = ? AND season = ? ${throughWeek ? 'AND week <= ?' : ''}
     ORDER BY week`,
    team, season, ...(throughWeek ? [throughWeek] : []));
  if (all.length < lookback + 2) {
    return { team, season, weeks_available: all.length,
      trends: [], insufficient: true,
      note: `Only ${all.length} games on record. A trend needs a recent window and something to ` +
        'compare it against; with fewer than five games there is nothing to say that is not noise.' };
  }

  const parsed = all.map(r => ({ week: r.week, f: JSON.parse(r.features) }));
  const recent = parsed.slice(-lookback);
  const before = parsed.slice(0, -lookback);

  // Šidák rather than Bonferroni: slightly less conservative and exact under
  // independence, which is close enough here and is what the rest of this
  // codebase already uses.
  const adjusted = 1 - Math.pow(1 - alpha, 1 / TRACKED.length);

  const trends = [];
  for (const spec of TRACKED) {
    const a = recent.map(x => x.f[spec.key]).filter(Number.isFinite);
    const b = before.map(x => x.f[spec.key]).filter(Number.isFinite);
    const w = welch(a, b);
    if (!w) continue;
    const rising = w.mean_recent > w.mean_before;
    const pct = w.mean_before !== 0 ? r2(((w.mean_recent - w.mean_before) / Math.abs(w.mean_before)) * 100) : null;
    trends.push({
      metric: spec.key, label: spec.label, unit: spec.unit,
      helps: spec.helps,
      // The actual week-by-week series. A trend rendered as two numbers hides
      // the shape that decides whether to believe it: a steady climb and one
      // enormous outlier produce the same means and mean very different things,
      // and only a reader looking at the sequence can tell them apart.
      series: parsed.map(x => ({ week: x.week, value: r3(x.f[spec.key]) }))
        .filter(x => x.value != null),
      recent: w.mean_recent, baseline: w.mean_before,
      change_pct: pct, effect_size: w.effect,
      t: w.t, p: w.p,
      significant: w.p <= adjusted,
      direction: rising ? 'up' : 'down',
      // Good or bad for the fantasy asset this metric drives.
      favourable: (spec.direction === 'up') === rising,
      what_it_means: rising ? spec.up : spec.down
    });
  }

  const real = trends.filter(t => t.significant)
    .sort((a, b) => Math.abs(b.effect_size) - Math.abs(a.effect_size));
  const suggestive = trends.filter(t => !t.significant && Math.abs(t.effect_size) >= 1.0)
    .sort((a, b) => Math.abs(b.effect_size) - Math.abs(a.effect_size));

  return {
    team, season,
    window: { recent_weeks: recent.map(x => x.week), baseline_weeks: before.map(x => x.week) },
    metrics_tested: TRACKED.length,
    alpha_after_correction: r3(adjusted),
    trends: real,
    suggestive,
    note: real.length
      ? `${real.length} of ${TRACKED.length} tracked metrics changed by more than noise across the ` +
        `last ${lookback} games, after correcting for testing ${TRACKED.length} of them.`
      : `Nothing has changed by more than noise across the last ${lookback} games. That is the usual ` +
        'answer and it is the honest one — three games is three observations, and most of what looks ' +
        'like a trend at that length is game script.'
  };
}

/**
 * A player's own trajectory: is he getting more of his offence?
 *
 * Usage share is the right thing to trend rather than fantasy points, because
 * points are a noisy function of touchdowns and share is close to a decision the
 * coaching staff is making. A receiver whose target share has climbed while his
 * points have not is the single most valuable pattern in fantasy, and points
 * alone hide it completely.
 */
const PLAYER_TRACKED = [
  { key: 'target_share', label: 'share of team targets', helps: 'WR/TE/RB' },
  { key: 'wopr', label: 'weighted opportunity rating', helps: 'WR/TE' },
  { key: 'air_yards_share', label: 'share of team air yards', helps: 'WR' },
  { key: 'carries', label: 'carries per game', helps: 'RB' },
  { key: 'targets', label: 'targets per game', helps: 'WR/TE/RB' },
  { key: 'receptions', label: 'receptions per game', helps: 'WR/TE/RB' }
];

export function playerTrends(playerId, season, { throughWeek = null, lookback = 3, alpha = 0.05 } = {}) {
  const all = rows(
    `SELECT week, target_share, air_yards_share, wopr, carries, targets, receptions,
            receiving_yards, rushing_yards, receiving_tds, rushing_tds
     FROM player_week_usage
     WHERE player_id = ? AND season = ? ${throughWeek ? 'AND week <= ?' : ''}
     ORDER BY week`,
    playerId, season, ...(throughWeek ? [throughWeek] : []));
  if (all.length < lookback + 2) {
    return { player_id: playerId, season, weeks_available: all.length, trends: [], insufficient: true };
  }

  const recent = all.slice(-lookback);
  const before = all.slice(0, -lookback);
  const adjusted = 1 - Math.pow(1 - alpha, 1 / PLAYER_TRACKED.length);

  const trends = [];
  for (const spec of PLAYER_TRACKED) {
    const a = recent.map(x => x[spec.key]).filter(Number.isFinite);
    const b = before.map(x => x[spec.key]).filter(Number.isFinite);
    const w = welch(a, b);
    if (!w) continue;
    const rising = w.mean_recent > w.mean_before;
    trends.push({
      metric: spec.key, label: spec.label, helps: spec.helps,
      series: all.map(x => ({ week: x.week, value: r3(x[spec.key]) }))
        .filter(x => x.value != null),
      recent: w.mean_recent, baseline: w.mean_before,
      change_pct: w.mean_before !== 0 ? r2(((w.mean_recent - w.mean_before) / Math.abs(w.mean_before)) * 100) : null,
      effect_size: w.effect, t: w.t, p: w.p,
      significant: w.p <= adjusted,
      direction: rising ? 'up' : 'down'
    });
  }

  const real = trends.filter(t => t.significant)
    .sort((a, b) => Math.abs(b.effect_size) - Math.abs(a.effect_size));

  return {
    player_id: playerId, season,
    window: { recent_weeks: recent.map(x => x.week), baseline_weeks: before.map(x => x.week) },
    trends: real,
    suggestive: trends.filter(t => !t.significant && Math.abs(t.effect_size) >= 1.0),
    all: trends,
    note: real.length
      ? 'Usage share is trended rather than fantasy points, because points are mostly touchdowns and ' +
        'share is close to a decision the coaching staff is actually making.'
      : 'No usage change beyond noise. Points may still have moved — that is usually touchdown luck ' +
        'rather than a change in role, and it reverts.'
  };
}
