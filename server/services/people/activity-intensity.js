/**
 * ACTIVITY-01: each manager's weekly add intensity, as a self-exciting rate.
 *
 * R&D r25 IDEA-084 (CONFIRMED by its pre-registered rule, prereg sha 4069b465):
 * a manager's expected adds next week is his own shrunk season rate (B0) moved by
 * what he did lately. It replaces the constant "adds per week to date" rate as the
 * who-acts-this-week read. Poisson GLM, fit on Sleeper 2021-22 (122,482 team-weeks),
 * graded held out on 2023 and 2024 separately (nats per team-week vs B0, 90% CI,
 * league bootstrap):
 *   2023  +0.0259 [+0.0216, +0.0310]   2024  +0.0069 [+0.0039, +0.0101]
 * and, as the W6 season-harness input, 2024 W10-14 team-points MSE 956.29 -> 951.01.
 *
 *   B0      lambda0 = (adds weeks 1..w-1 + alpha * league mean adds/team-week) / ((w-1) + alpha)
 *   PP      log lambda = log lambda0 + const + b_l0 * log lambda0 + week effect
 *                        + b . [lost1, streak2, margin1, dead1, empty1, wp, exc]
 *   exc     log1p(sum_k gamma^(k-1) adds_(w-k)) - log1p(lambda0 * sum_k gamma^(k-1))
 *
 * What carries it (r25's reading of the coefficients): recent adds above his own
 * base rate raise the rate (exc +0.54), and dead or empty starters last week LOWER
 * it (-0.17 per slot, capped at 3): engaged managers stay engaged, neglected
 * lineups go quiet. A loss barely moves it.
 *
 * Every input is from weeks 1..w-1. Pure: callers pass the league's per-week
 * history, this module reads no table. The fit needs two scored weeks of history
 * (the corpus rows start at week 3); earlier, every team gets `lambda: null` with
 * the reason. Coefficient transfer from Sleeper to an ESPN league is not validated
 * until a 2026 forward check.
 */

export const ACTIVITY_INTENSITY_VERSION = 'activity-intensity-v1';

export const ACTIVITY_INTENSITY_FIT = Object.freeze({
  alpha: 2,
  gamma: 0.7,
  cap_slots: 3,
  min_history_weeks: 2,
  coef: Object.freeze({
    const: -0.22983550090754412,
    logl0: -0.17797686702817628,
    lost1: 0.023265465961508257,
    streak2: -0.028613103826499488,
    margin1: -0.059628219884557396,
    dead1: -0.17393353583484028,
    empty1: -0.1733680621651308,
    wp: 0.16702556075948305,
    exc: 0.5418180612824297,
  }),
  // Week fixed effects against week 3; weeks past 14 use week 14's (the corpus
  // regular season ends by 14).
  week: Object.freeze({
    4: 0.13414990692598922, 5: 0.22647046179002686, 6: 0.4072049981812928, 7: 0.4802204345593343,
    8: 0.2890738740157959, 9: 0.39423214729606915, 10: 0.22809579163413574, 11: 0.15679699312249837,
    12: 0.03057319048623816, 13: 0.09931401792567825, 14: 0.19305700602172488,
  }),
  source: 'Sleeper 2021-22 team-weeks 3..reg_end, Poisson GLM (rnd/loop r25 IDEA-084)',
  heldout: Object.freeze({
    '2023': Object.freeze({ gain: 0.02591, lo: 0.02158, hi: 0.03098, team_weeks: 63030 }),
    '2024': Object.freeze({ gain: 0.00687, lo: 0.00392, hi: 0.01014, team_weeks: 63108 }),
  }),
});

const FLAG_ENV = 'GRIDIRON_ACTIVITY_INTENSITY';
/** DEFAULT-OFF ship switch: GRIDIRON_ACTIVITY_INTENSITY=1. Preview mode is the caller's to add. */
export const activityIntensityFlag = () => process.env[FLAG_ENV] === '1';

const num = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * Next-week intensity for every team in one league.
 *
 * @param teams [{ roster_id, adds: [], points: [], opp_points: [], dead: [], empty: [] }]
 *   Index i is week i+1. `adds` must be known for every history week (0 is a
 *   count, not a gap); a null point, dead or empty value makes that term 0 and
 *   is named in `missing`.
 * @param week the week being predicted; history is weeks 1..week-1.
 * @returns Map roster_id -> { week, lambda, lambda0, log_ratio, p_any_add,
 *   vs_league, terms, missing } or { week, lambda: null, reason }.
 */
export function leagueActivityIntensity(teams, week, fit = ACTIVITY_INTENSITY_FIT) {
  const out = new Map();
  const h = Math.floor(Number(week)) - 1;
  const fail = reason => { for (const t of teams) out.set(String(t.roster_id), { week, lambda: null, reason }); return out; };
  if (!(h >= fit.min_history_weeks)) {
    return fail(`needs ${fit.min_history_weeks} completed weeks of history; ${Math.max(0, h)} so far`);
  }
  const addsOf = t => Array.from({ length: h }, (_, i) => num(t.adds?.[i]));
  if (teams.some(t => addsOf(t).some(a => a == null))) {
    return fail(`adds are not known for every week 1..${h}`);
  }
  if (!teams.length) return out;

  const c = fit.coef;
  let addSum = 0, ptSum = 0, ptN = 0;
  for (const t of teams) {
    for (let i = 0; i < h; i++) {
      addSum += num(t.adds[i]);
      const p = num(t.points?.[i]);
      if (p != null) { ptSum += p; ptN++; }
    }
  }
  const leagueRate = addSum / (teams.length * h);
  const leagueMeanPts = ptN ? ptSum / ptN : null;
  const decay = Array.from({ length: h }, (_, k) => fit.gamma ** k);
  const decaySum = decay.reduce((a, b) => a + b, 0);
  const weekFx = fit.week[Math.min(h + 1, 14)] ?? 0;

  for (const t of teams) {
    const adds = addsOf(t);
    const missing = [];
    const own = adds.reduce((a, b) => a + b, 0);
    const lambda0 = Math.max((own + fit.alpha * leagueRate) / (h + fit.alpha), 1e-3);
    const recent = decay.reduce((a, g, k) => a + g * adds[h - 1 - k], 0);
    const exc = Math.log1p(recent) - Math.log1p(lambda0 * decaySum);

    const res = i => {
      const p = num(t.points?.[i]), o = num(t.opp_points?.[i]);
      return p == null || o == null ? null : { p, o, lost: p < o ? 1 : 0, win: p > o ? 1 : p === o ? 0.5 : 0 };
    };
    const last = res(h - 1), prev = res(h - 2);
    if (!last) missing.push('last_week_result');
    const lost1 = last ? last.lost : 0;
    const streak2 = last && prev ? last.lost * prev.lost : 0;
    if (last && !prev) missing.push('prior_week_result');
    const margin1 = last && leagueMeanPts > 0 ? clip((last.p - last.o) / leagueMeanPts, -1, 1) : 0;
    const scored = Array.from({ length: h }, (_, i) => res(i)).filter(Boolean);
    const wp = scored.length ? scored.reduce((a, r) => a + r.win, 0) / scored.length : 0;
    if (scored.length < h) missing.push('win_pct_weeks');
    const deadRaw = num(t.dead?.[h - 1]), emptyRaw = num(t.empty?.[h - 1]);
    if (deadRaw == null) missing.push('dead_starts_last_week');
    if (emptyRaw == null) missing.push('empty_starts_last_week');
    const dead1 = Math.min(deadRaw ?? 0, fit.cap_slots);
    const empty1 = Math.min(emptyRaw ?? 0, fit.cap_slots);

    const terms = {
      base: c.const + weekFx + c.logl0 * Math.log(lambda0),
      lost1: c.lost1 * lost1, streak2: c.streak2 * streak2, margin1: c.margin1 * margin1,
      dead1: c.dead1 * dead1, empty1: c.empty1 * empty1, wp: c.wp * wp, exc: c.exc * exc,
    };
    const logRatio = Object.values(terms).reduce((a, b) => a + b, 0);
    const lambda = lambda0 * Math.exp(logRatio);
    out.set(String(t.roster_id), {
      week: h + 1, lambda, lambda0, log_ratio: logRatio, p_any_add: 1 - Math.exp(-lambda),
      inputs: { lost1, streak2, margin1, dead1, empty1, wp, exc, recent_adds: recent },
      terms, missing,
    });
  }
  const live = [...out.values()];
  const mean = live.reduce((a, r) => a + r.lambda, 0) / live.length;
  for (const r of live) r.vs_league = mean > 0 ? r.lambda / mean : null;
  return out;
}

/** Poisson log-likelihood of `y` adds under rate `lambda` (the grade metric). */
export function poissonLogLik(y, lambda) {
  let lg = 0;
  for (let k = 2; k <= y; k++) lg += Math.log(k);
  return y * Math.log(lambda) - lambda - lg;
}

/**
 * The same league's constant-rate baseline (B0 alone) for week `week`: what the
 * intensity replaces. Exported so the grade script and the test compare like with like.
 */
export function leagueBaselineRate(teams, week, fit = ACTIVITY_INTENSITY_FIT) {
  const h = Math.floor(Number(week)) - 1;
  const out = new Map();
  if (!(h >= 1) || !teams.length) return out;
  const tot = teams.reduce((a, t) => a + Array.from({ length: h }, (_, i) => num(t.adds?.[i]) ?? 0)
    .reduce((x, y) => x + y, 0), 0);
  const leagueRate = tot / (teams.length * h);
  for (const t of teams) {
    const own = Array.from({ length: h }, (_, i) => num(t.adds?.[i]) ?? 0).reduce((x, y) => x + y, 0);
    out.set(String(t.roster_id), Math.max((own + fit.alpha * leagueRate) / (h + fit.alpha), 1e-3));
  }
  return out;
}
