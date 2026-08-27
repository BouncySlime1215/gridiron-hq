/**
 * Age and injury history — the two signal families the model genuinely did
 * not have.
 *
 * Everything tested before this reweighted a player's own production history
 * (recency heads, robust blends) or described his environment (opponent,
 * weather, scheme). All of it failed, which is informative: the structural
 * model had already extracted what those contain. Age and injury are
 * different in kind. Neither is derivable from a stat line at all — a 30-year
 * old running back and a 24-year old with identical usage look identical to
 * every model in this codebase today, and a player who missed six weeks with
 * a hamstring looks like a player with six fewer games.
 *
 * Both are available and neither needed a new data source:
 *
 *   age      `roster_players.age` is a current snapshot (July 2026), but age
 *            is deterministic, so age in season S is current_age - (2026 - S).
 *            That is exact, not an estimate. Its limitation is coverage, not
 *            accuracy: only players still on a roster in 2026 appear, which
 *            biases the sample toward players whose careers continued. That
 *            matters for aging-curve estimation and is stated where it does.
 *
 *   injury   `nfl_injuries` carries per-week report_status ("Out",
 *            "Questionable", "Doubtful") and practice participation for
 *            2023-2025, keyed by gsis_id — which `buildProjections` now
 *            carries through, so it joins cleanly.
 *
 * As with everything else here: measured, validated out of sample, and given
 * no production authority until it earns it.
 */
import { rows } from '../db/index.js';
import { playerWeeks } from './nfl-pbp.js';
import { pairedBootstrapDiff } from './backtest-significance.js';

const CURRENT_SNAPSHOT_SEASON = 2026;
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = a => {
  if (!a.length) return null;
  const x = [...a].sort((p, q) => p - q);
  return x[Math.floor(x.length / 2)];
};
const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

/* --------------------------------------------------------------------- age */

let ageCache = null;
/** name -> {age_2026, experience, position}. Name-keyed because roster_players has no gsis_id. */
function rosterAges() {
  if (ageCache) return ageCache;
  const out = new Map();
  for (const r of rows(`SELECT name, position, age, experience FROM roster_players
                        WHERE age IS NOT NULL AND unit = 'offense'`)) {
    out.set(r.name.toLowerCase(), { age_2026: r.age, experience: r.experience, position: r.position });
  }
  ageCache = out;
  return out;
}

/** Exact age in a given season, or null when the player is not in the 2026 snapshot. */
export function ageInSeason(playerName, season) {
  const r = rosterAges().get(String(playerName ?? '').toLowerCase());
  if (!r?.age_2026) return null;
  const age = r.age_2026 - (CURRENT_SNAPSHOT_SEASON - season);
  return age > 18 && age < 48 ? age : null;
}

/**
 * The aging curve, measured: how does a player's opportunity per game change
 * from one season to the next, as a function of the age he is entering?
 *
 * SURVIVORSHIP WARNING, stated rather than buried: ages come from the 2026
 * roster snapshot, so only players whose careers reached 2026 are included.
 * Players who aged out are missing precisely because they declined. That
 * biases every ratio here UPWARD at older ages — the real decline is steeper
 * than what this shows. The curve is therefore useful for shape and for
 * relative comparison between ages, and should not be read as an unbiased
 * level.
 */
export function measureAgingCurve(seasons, { minGames = 6 } = {}) {
  const byPlayerSeason = new Map();
  for (const season of seasons) {
    for (const r of rows(`SELECT player_id, position, season,
                                 SUM(COALESCE(targets,0)+COALESCE(carries,0)+COALESCE(attempts,0)) opp,
                                 COUNT(*) games
                          FROM player_week_usage WHERE season = ? GROUP BY player_id`, season)) {
      byPlayerSeason.set(`${r.player_id}|${season}`, r);
    }
  }
  const names = new Map(rows(`SELECT id, name FROM players`).map(p => [p.id, p.name]));
  const points = [];
  for (const [key, before] of byPlayerSeason) {
    const [pid, seasonStr] = key.split('|');
    const season = Number(seasonStr);
    const after = byPlayerSeason.get(`${pid}|${season + 1}`);
    if (!after || before.games < minGames || after.games < minGames) continue;
    const age = ageInSeason(names.get(Number(pid)), season + 1);
    if (age == null) continue;
    const beforeRate = before.opp / before.games, afterRate = after.opp / after.games;
    if (!(beforeRate > 0)) continue;
    points.push({ player_id: pid, position: before.position, age, ratio: afterRate / beforeRate });
  }
  const buckets = {};
  for (const p of points) {
    const band = p.age <= 23 ? '<=23' : p.age >= 31 ? '31+' : String(p.age);
    (buckets[band] ??= []).push(p);
  }
  const summary = Object.fromEntries(Object.entries(buckets)
    .sort((a, b) => (a[0] === '<=23' ? -1 : b[0] === '<=23' ? 1 : a[0] === '31+' ? 1 : b[0] === '31+' ? -1 : Number(a[0]) - Number(b[0])))
    .map(([band, list]) => [band, { n: list.length, median_ratio: r3(median(list.map(x => x.ratio))) }]));
  const byPosition = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const sub = points.filter(p => p.position === pos);
    if (sub.length < 20) continue;
    const young = sub.filter(p => p.age <= 26), old = sub.filter(p => p.age >= 29);
    byPosition[pos] = {
      n: sub.length,
      age_26_and_under: { n: young.length, median_ratio: r3(median(young.map(x => x.ratio))) },
      age_29_and_over: { n: old.length, median_ratio: r3(median(old.map(x => x.ratio))) }
    };
  }
  return { seasons, n: points.length, by_age: summary, by_position: byPosition,
    survivorship_warning: 'Ages come from the 2026 roster snapshot, so players whose careers ended ' +
      'before 2026 are absent — and they are absent because they declined. Older-age ratios are ' +
      'biased upward; the true decline is steeper. Use for shape, not level.' };
}

/**
 * The validated opportunity multiplier for one player-week: age band and
 * injury designation combined.
 *
 * Both factors validated out of sample on their own (see
 * `validateAgeAdjustment` and `validateInjuryAdjustment`). They are applied
 * multiplicatively because they act on different mechanisms — age moves a
 * player's baseline role across seasons, injury suppresses a given week's
 * usage within it — and are therefore close to independent. They are also
 * clamped: no combination may move opportunity by more than 20%, because
 * neither factor was validated at extremes and stacking two fitted
 * multipliers is exactly how a plausible adjustment turns into an
 * overconfident one.
 *
 * Returns 1 when nothing is known, so a player missing from the age snapshot
 * or a season without injury coverage is simply unadjusted rather than
 * silently penalised.
 */
/*
 * The raw fitted factors are all below 1, because they were validated against
 * a naive "same as last season" baseline that does not regress at all. The
 * structural model DOES regress — shrinkage toward positional priors already
 * encodes most of the decline — so applying these as-is double counts it.
 *
 * Measured directly by ablation (GRIDIRON_NO_CONTEXT_ADJ): applying the raw
 * factors made the shipped pipeline WORSE on every stat and roughly doubled
 * the existing under-projection bias (rush -1.214 -> -2.248, receiving
 * -1.516 -> -2.615). A real effect, validated in isolation, that still
 * degrades the model it is added to — the same double-counting failure as
 * the opponent-on-volume attempt.
 *
 * So age is applied RELATIVELY: each band is divided by the population mean
 * band factor, leaving the average player unmoved and only redistributing
 * between young and old. That keeps the information the aging curve carries
 * (a 30-year-old and a 24-year-old with identical usage are not the same
 * player) without re-applying a level correction the model already made.
 *
 * Injury is left absolute. It is a genuine within-week suppression that the
 * structural model cannot know about — nothing in a player's usage history
 * says he practised on a bad hamstring this Wednesday — so there is nothing
 * to double count.
 */
const RAW_AGE_FACTORS = { young: 1.023, prime: 0.948, late: 0.914, old: 0.99 };
const AGE_CENTER = Object.values(RAW_AGE_FACTORS).reduce((s, x) => s + x, 0) / Object.keys(RAW_AGE_FACTORS).length;
export const AGE_BAND_FACTORS = Object.freeze(Object.fromEntries(
  Object.entries(RAW_AGE_FACTORS).map(([k, v]) => [k, +(v / AGE_CENTER).toFixed(4)])));
export const INJURY_FACTORS = Object.freeze({ questionable: 0.926, limited: 0.933, dnp: 0.935 });

export function opportunityContextMultiplier({ playerName, gsisId, season, week } = {}) {
  const detail = { age: null, age_band: null, age_factor: 1, injury_factor: 1, injury_status: null };
  // Ablation switch. An adjustment that cannot be turned off cannot be
  // measured against its own absence, and "it validated in isolation" is not
  // the same claim as "it improves the shipped pipeline".
  if (process.env.GRIDIRON_NO_CONTEXT_ADJ === '1') return { multiplier: 1, clamped: false, disabled: true, ...detail };
  const age = playerName ? ageInSeason(playerName, season) : null;
  if (age != null) {
    const band = age <= 23 ? 'young' : age <= 27 ? 'prime' : age <= 29 ? 'late' : 'old';
    detail.age = age; detail.age_band = band; detail.age_factor = AGE_BAND_FACTORS[band] ?? 1;
  }
  const inj = gsisId && week != null ? injuryContext(gsisId, season, week) : null;
  if (inj?.on_report) {
    detail.injury_status = inj.report_status ?? (inj.dnp ? 'DNP' : inj.limited ? 'Limited' : 'Listed');
    detail.injury_factor = inj.dnp ? INJURY_FACTORS.dnp
      : inj.limited ? INJURY_FACTORS.limited
        : inj.report_status === 'Questionable' ? INJURY_FACTORS.questionable : 1;
  }
  const raw = detail.age_factor * detail.injury_factor;
  const multiplier = Math.max(0.8, Math.min(1.2, raw));
  return { multiplier, clamped: raw !== multiplier, ...detail };
}

/**
 * Does knowing a player's age improve a next-season opportunity forecast?
 *
 * Fit on `fitSeasons`, applied to `testSeason`. Age bands rather than a fitted
 * curve, because the survivorship bias above makes a smooth fit spuriously
 * precise — banding keeps the claim at the resolution the data supports.
 */
export function validateAgeAdjustment({ fitSeasons = [2022, 2023], testSeason = 2025, minGames = 6 } = {}) {
  const band = age => (age <= 23 ? 'young' : age <= 27 ? 'prime' : age <= 29 ? 'late' : 'old');
  const fit = measureAgingCurve(fitSeasons, { minGames });
  // Collapse the measured per-age medians into the same bands.
  const fitPoints = {};
  for (const [k, v] of Object.entries(fit.by_age)) {
    const age = k === '<=23' ? 23 : k === '31+' ? 31 : Number(k);
    (fitPoints[band(age)] ??= []).push(v.median_ratio);
  }
  const factors = Object.fromEntries(Object.entries(fitPoints).map(([b, list]) => [b, mean(list)]));

  const names = new Map(rows(`SELECT id, name FROM players`).map(p => [p.id, p.name]));
  const seasonAgg = season => new Map(rows(
    `SELECT player_id, position,
            SUM(COALESCE(targets,0)+COALESCE(carries,0)+COALESCE(attempts,0)) opp, COUNT(*) games
     FROM player_week_usage WHERE season = ? GROUP BY player_id`, season).map(r => [r.player_id, r]));
  const before = seasonAgg(testSeason - 1), after = seasonAgg(testSeason);

  const errBase = [], errAdj = [];
  for (const [pid, b] of before) {
    const a = after.get(pid);
    if (!a || b.games < minGames || a.games < minGames) continue;
    const age = ageInSeason(names.get(pid), testSeason);
    if (age == null) continue;
    const naive = b.opp / b.games, actual = a.opp / a.games;
    if (!(naive > 0)) continue;
    errBase.push(Math.abs(naive - actual));
    errAdj.push(Math.abs(naive * (factors[band(age)] ?? 1) - actual));
  }
  if (errBase.length < 30) return { error: `too few rows (${errBase.length})`, factors };
  const test = pairedBootstrapDiff(errBase, errAdj, { iterations: 2000, seed: 29 });
  const mae = a => r3(a.reduce((s, x) => s + x, 0) / a.length);
  return {
    fit_seasons: fitSeasons, test_season: testSeason, n: errBase.length,
    factors: Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, r3(v)])),
    unadjusted_mae: mae(errBase), adjusted_mae: mae(errAdj), bootstrap: test,
    improves: test.significant === true && test.mean_diff < 0,
    caveat: 'Age coverage is limited to players on the 2026 roster; see survivorship warning on measureAgingCurve.'
  };
}

/* ------------------------------------------------------------------ injury */

let injuryCache = null;
function injuryIndex() {
  if (injuryCache) return injuryCache;
  const out = new Map();   // `${gsis_id}|${season}|${week}` -> row
  for (const r of rows(`SELECT season, week, gsis_id, report_status, practice_status, injury
                        FROM nfl_injuries WHERE gsis_id IS NOT NULL`)) {
    out.set(`${r.gsis_id}|${r.season}|${r.week}`, r);
  }
  injuryCache = out;
  return out;
}

/** Severity ordering for a weekly report. Higher means less likely / less effective. */
export const REPORT_SEVERITY = { Out: 3, Doubtful: 2, Questionable: 1 };

/**
 * Injury context for a player-week, using only reports filed BEFORE the game.
 * The report for week W is published during week W's practices, so it is
 * legitimately pregame information — but everything about prior weeks is
 * strictly historical.
 */
export function injuryContext(gsisId, season, week, { lookback = 6 } = {}) {
  if (!gsisId) return null;
  const idx = injuryIndex();
  const current = idx.get(`${gsisId}|${season}|${week}`) ?? null;
  let priorReports = 0, priorOut = 0, priorDNP = 0;
  for (let w = Math.max(1, week - lookback); w < week; w++) {
    const r = idx.get(`${gsisId}|${season}|${w}`);
    if (!r) continue;
    priorReports++;
    if (r.report_status === 'Out') priorOut++;
    if (/Did Not Participate/i.test(r.practice_status ?? '')) priorDNP++;
  }
  return {
    on_report: !!current,
    report_status: current?.report_status ?? null,
    practice_status: current?.practice_status ?? null,
    injury: current?.injury ?? null,
    severity: current?.report_status ? (REPORT_SEVERITY[current.report_status] ?? 0) : 0,
    limited: current ? /Limited/i.test(current.practice_status ?? '') : false,
    dnp: current ? /Did Not Participate/i.test(current.practice_status ?? '') : false,
    prior_weeks_on_report: priorReports,
    prior_weeks_out: priorOut,
    prior_weeks_dnp: priorDNP,
    recently_injured: priorOut > 0 || priorDNP > 0
  };
}

/**
 * What does appearing on the injury report actually do to a player's
 * opportunity that week?
 *
 * The interesting cases are the ones that still play: "Out" is trivially
 * predictive (he records nothing) and the app already handles availability
 * separately. The question worth answering is whether a player listed
 * Questionable, or limited in practice, produces less than his own baseline
 * when he does suit up — because that is the case the model currently gets
 * wrong in both directions.
 */
export function measureInjuryEffect(seasons) {
  const groups = { clean: [], questionable: [], limited: [], dnp_but_played: [], returning: [] };
  for (const season of seasons) {
    const weeks = playerWeeks(season).filter(r => r.week >= 3);
    const history = new Map();
    for (const r of [...weeks].sort((a, b) => a.week - b.week)) {
      const opp = (r.features.targets ?? 0) + (r.features.carries ?? 0) + (r.features.pass_attempts ?? 0);
      const hist = history.get(r.player_id) ?? [];
      if (hist.length >= 3 && opp > 0) {
        const baseline = mean(hist);
        if (baseline > 0) {
          const ratio = opp / baseline;
          const inj = injuryContext(r.player_id, season, r.week);
          if (!inj || !inj.on_report) groups.clean.push(ratio);
          else {
            if (inj.report_status === 'Questionable') groups.questionable.push(ratio);
            if (inj.limited) groups.limited.push(ratio);
            if (inj.dnp) groups.dnp_but_played.push(ratio);
          }
          if (inj?.recently_injured && !inj.on_report) groups.returning.push(ratio);
        }
      }
      if (opp > 0) { hist.push(opp); history.set(r.player_id, hist); }
    }
  }
  const summarize = list => ({ n: list.length, median_ratio: r3(median(list)), mean_ratio: r3(mean(list)) });
  return {
    seasons,
    groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, summarize(v)])),
    note: 'Opportunity vs the player\'s own trailing baseline, for players who actually played. ' +
      'gsis_id joins player_week rows to nfl_injuries. Injury data covers 2023-2025 only.'
  };
}

/**
 * Do injury designations improve an opportunity forecast out of sample?
 * Factors fit on `fitSeasons`, applied to `testSeason`, never both.
 */
export function validateInjuryAdjustment({ fitSeasons = [2023, 2024], testSeason = 2025 } = {}) {
  const fit = measureInjuryEffect(fitSeasons);
  const clean = fit.groups.clean.median_ratio || 1;
  const factorFor = inj => {
    if (!inj?.on_report) return 1;
    if (inj.dnp) return (fit.groups.dnp_but_played.median_ratio || clean) / clean;
    if (inj.limited) return (fit.groups.limited.median_ratio || clean) / clean;
    if (inj.report_status === 'Questionable') return (fit.groups.questionable.median_ratio || clean) / clean;
    return 1;
  };

  const errBase = [], errAdj = [];
  const history = new Map();
  for (const r of [...playerWeeks(testSeason).filter(x => x.week >= 3)].sort((a, b) => a.week - b.week)) {
    const opp = (r.features.targets ?? 0) + (r.features.carries ?? 0) + (r.features.pass_attempts ?? 0);
    const hist = history.get(r.player_id) ?? [];
    if (hist.length >= 3 && opp > 0) {
      const baseline = mean(hist);
      if (baseline > 0) {
        const inj = injuryContext(r.player_id, testSeason, r.week);
        errBase.push(Math.abs(baseline - opp));
        errAdj.push(Math.abs(baseline * factorFor(inj) - opp));
      }
    }
    if (opp > 0) { hist.push(opp); history.set(r.player_id, hist); }
  }
  if (errBase.length < 50) return { error: `too few rows (${errBase.length})` };
  const test = pairedBootstrapDiff(errBase, errAdj, { iterations: 2000, seed: 23 });
  const mae = a => r3(a.reduce((s, x) => s + x, 0) / a.length);
  return {
    fit_seasons: fitSeasons, test_season: testSeason, n: errBase.length,
    factors: { questionable: r3(factorFor({ on_report: true, report_status: 'Questionable' })),
      limited: r3(factorFor({ on_report: true, limited: true })),
      dnp: r3(factorFor({ on_report: true, dnp: true })) },
    unadjusted_mae: mae(errBase), adjusted_mae: mae(errAdj), bootstrap: test,
    improves: test.significant === true && test.mean_diff < 0
  };
}
