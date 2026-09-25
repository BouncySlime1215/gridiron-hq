/**
 * COACH-01a Step 0: does Coach's people gate pick out tells that predict
 * anything, when it is run on population tells with SEPARATE windows?
 *
 * The gate is `repeatability` in grading.js: split each person's history in
 * time, and pass a variable when the early value predicts the late one across
 * people (skill > 0, Spearman >= 0.5). Here it is run on the TELLS-01a
 * templates, one league-season at a time (a league-season's managers are the
 * "people", as a chat corpus's are), and its passes are scored against the
 * screen's outcome verdicts: a template is a hit for an outcome when the
 * screen CONFIRMED one of its tells for that outcome.
 *
 * The r18 critique ("passes noise": 232 passes, precision 0.116) compared
 * overlapping cumulative windows, so the early and late values shared weeks
 * and repeated partly because they were the same data. The validator put
 * precision at about 1.7x the 0.067 base rate and said the true numbers are
 * unknown until a rerun with separate windows (RL-18-3). This is that rerun:
 *
 *   PRIMARY      a 70/30 split of each team-season's own weeks 1-12
 *                (weeks 1-8 vs 9-12 for a full season)
 *   SENSITIVITY  weeks 1-5 vs 6-11
 *
 * An event that spans the cut (a lineup change measured against the week
 * before) goes to neither window.
 *
 * Precision is reported next to the base rate with recall, and a
 * league-clustered bootstrap CI. It is claimed only when the CI clears the
 * base rate; otherwise the gate is reported as repeatability-only. An outcome
 * with no confirmed tell reads "no replicated ... signal", never "predicts
 * nothing": the screen tested a finite set of tells, and a null result is
 * about that set.
 *
 * Pure: takes a panel and the screen, returns a report, writes nothing. The
 * panel is built locally from Sleeper history by scripts/rnd/coach-gate-panel.py.
 */
import { repeatability, GRADE_MIN_PEOPLE, GRADE_MIN_SPEARMAN, VERDICTS } from './grading.js';

export const WINDOW_MODES = Object.freeze({
  PRIMARY: 'split_70_30',
  SENSITIVITY: 'weeks_1_5_vs_6_11'
});

export const OUTCOMES = Object.freeze(['adds', 'checkout', 'trade']);

/** The screen's tell-level base rate the validator quoted (RL-18-3). Reported, not used. */
export const VALIDATOR_BASE_RATE = 0.067;

const PRIMARY_SHARE = 0.7;

/**
 * Early and late weeks for one team-season, from the weeks it actually played.
 * @param {number[]} weeks  weeks with data for this team-season
 * @param {string} mode     WINDOW_MODES value
 * @returns {{early: number[], late: number[]}}
 */
export function teamSeasonWindows(weeks, mode = WINDOW_MODES.PRIMARY) {
  const played = [...new Set(weeks)].filter(w => w >= 1 && w <= 12).sort((a, b) => a - b);
  let early;
  let late;
  if (mode === WINDOW_MODES.PRIMARY) {
    const cut = Math.floor(played.length * PRIMARY_SHARE);
    early = played.slice(0, cut);
    late = played.slice(cut);
  } else if (mode === WINDOW_MODES.SENSITIVITY) {
    early = played.filter(w => w <= 5);
    late = played.filter(w => w >= 6 && w <= 11);
  } else {
    throw new Error(`unknown window mode ${mode}`);
  }
  if (early.some(w => late.includes(w))) throw new Error('windows overlap; the rerun would repeat the r18 error');
  return { early, late };
}

/**
 * Put each event in the early window, the late window, or neither. An event
 * is `{week}` or `{from_week, to_week}`; one whose weeks touch both windows is
 * `straddling` and is used by neither.
 */
export function splitEvents(events, { early, late }) {
  const e = new Set(early);
  const l = new Set(late);
  const out = { early: [], late: [], straddling: [], outside: [] };
  for (const event of events) {
    const from = event.from_week ?? event.week;
    const to = event.to_week ?? event.week;
    const weeks = [];
    for (let w = from; w <= to; w++) weeks.push(w);
    const inEarly = weeks.every(w => e.has(w));
    const inLate = weeks.every(w => l.has(w));
    if (inEarly) out.early.push(event);
    else if (inLate) out.late.push(event);
    else if (weeks.some(w => e.has(w)) && weeks.some(w => l.has(w))) out.straddling.push(event);
    else out.outside.push(event);
  }
  return out;
}

/**
 * Group panel rows into template -> cluster -> [[early, late], ...].
 * A row is `{cluster, unit, template, early, late}`; nulls are skipped, as
 * grading.js skips a withheld value.
 */
function pairsByTemplate(panel) {
  const out = new Map();
  for (const row of panel) {
    if (row.early == null || row.late == null) continue;
    if (!Number.isFinite(row.early) || !Number.isFinite(row.late)) continue;
    let byCluster = out.get(row.template);
    if (!byCluster) out.set(row.template, (byCluster = new Map()));
    let pairs = byCluster.get(row.cluster);
    if (!pairs) byCluster.set(row.cluster, (pairs = []));
    pairs.push([row.early, row.late]);
  }
  return out;
}

const PASS = 1;
const FAIL = 0;
const UNGRADED = -1;

/**
 * Per template, one code per cluster (aligned to `clusters`): PASS, FAIL, or
 * UNGRADED when the league-season was too thin. Typed arrays, because the
 * bootstrap re-reads every cell on every draw.
 */
function cellVerdicts(grouped, clusters, { minPeople, minSpearman }) {
  const index = new Map(clusters.map((c, i) => [c, i]));
  const cells = new Map();
  for (const [template, byCluster] of grouped) {
    const codes = new Int8Array(clusters.length).fill(UNGRADED);
    for (const [cluster, pairs] of byCluster) {
      const { verdict } = repeatability(pairs, { minPeople, minSpearman });
      codes[index.get(cluster)] = verdict === VERDICTS.PASS ? PASS : verdict === VERDICTS.FAIL ? FAIL : UNGRADED;
    }
    cells.set(template, codes);
  }
  return cells;
}

/**
 * A template passes when it passes in at least half of the league-seasons
 * that could grade it. `sample` holds cluster indices; a bootstrap draw may
 * repeat one, and it then counts twice.
 */
function templateVerdicts(cells, sample, { minClusters, minPeople }) {
  const out = new Map();
  for (const [template, codes] of cells) {
    let graded = 0;
    let passes = 0;
    for (let k = 0; k < sample.length; k++) {
      const v = codes[sample[k]];
      if (v === UNGRADED) continue;
      graded += 1;
      if (v === PASS) passes += 1;
    }
    const pass = graded >= minClusters && graded > 0 && passes / graded >= 0.5;
    out.set(template, { clusters_graded: graded, clusters_passed: passes,
      pass_share: graded ? +(passes / graded).toFixed(4) : null, pass,
      reason: graded < minClusters || graded === 0
        ? `${graded} league-seasons had ${minPeople}+ people with a value in both windows; `
          + `the rerun needs ${Math.max(minClusters, 1)}.`
        : `passed the gate in ${passes} of ${graded} league-seasons.` });
  }
  return out;
}

const allIndices = n => Int32Array.from({ length: n }, (_, i) => i);

/**
 * Run the gate on every template in the panel.
 * @returns {Map<string, {clusters_graded, clusters_passed, pass_share, pass, reason}>}
 */
export function emulateGate(panel, { minPeople = GRADE_MIN_PEOPLE, minSpearman = GRADE_MIN_SPEARMAN,
  minClusters = 1 } = {}) {
  const clusters = [...new Set(panel.map(r => r.cluster))];
  const cells = cellVerdicts(pairsByTemplate(panel), clusters, { minPeople, minSpearman });
  return templateVerdicts(cells, allIndices(clusters.length), { minClusters, minPeople });
}

/** Template -> set of outcomes the screen confirmed one of its tells for (arm A only). */
export function templateLabels(screen) {
  const labels = new Map();
  for (const tell of screen?.tells ?? []) {
    if (tell.arm !== 'A' || typeof tell.id !== 'string') continue;
    const template = tell.id.split('|').slice(0, -1).join('|');
    if (!labels.has(template)) labels.set(template, new Set());
    if (tell.verdict === 'confirmed' && OUTCOMES.includes(tell.outcome)) labels.get(template).add(tell.outcome);
  }
  return labels;
}

/** Seeded PRNG (mulberry32) so a rerun's CI is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const r4 = v => (v == null ? null : +v.toFixed(4));

function scoreOutcome(verdicts, universe, isHit) {
  let passes = 0;
  let hitsPassed = 0;
  let hits = 0;
  for (const template of universe) {
    const hit = isHit(template);
    const pass = verdicts.get(template)?.pass === true;
    if (hit) hits += 1;
    if (pass) passes += 1;
    if (pass && hit) hitsPassed += 1;
  }
  return { passes, hits, hitsPassed,
    precision: passes ? hitsPassed / passes : null,
    recall: hits ? hitsPassed / hits : null };
}

function statementFor(outcome, s) {
  const label = outcome === 'trade' ? 'trade-next-week' : outcome;
  if (s.confirmed === 0) {
    return `no replicated ${label} signal among the screened tells, so the gate has nothing to find `
      + 'for this outcome; that is a statement about the screened set, not a claim that nothing predicts it.';
  }
  if (s.precision == null) {
    return `the gate passed no template, so it has no precision for ${outcome} to set against the `
      + `base rate of ${s.base_rate}; for ${outcome} the gate is repeatability-only.`;
  }
  if (s.beats_base) {
    return `gate passes are confirmed for ${outcome} at ${s.precision} vs a base rate of ${s.base_rate} `
      + `(90% CI ${s.ci90[0]}..${s.ci90[1]}, league-clustered), recall ${s.recall}.`;
  }
  return `gate precision for ${outcome} is ${s.precision} vs a base rate of ${s.base_rate}; the 90% CI `
    + `(${s.ci90[0]}..${s.ci90[1]}) does not clear it, so for ${outcome} the gate is repeatability-only.`;
}

/**
 * The Step 0 table for one window mode.
 * @param {{panel?: object[], pairs?: Map<string, Map<string, number[][]>>, screen: object,
 *   reps?: number, seed?: number, ci?: number, minPeople?: number, minSpearman?: number,
 *   minClusters?: number}} args
 *   Either `panel` rows or `pairs` already grouped template -> cluster -> [[early, late]]
 *   (what scripts/coach-gate-rerun.mjs reads from the local panel file).
 */
export function gateRerun({ panel, pairs, screen, reps = 1000, seed = 1, ci = 0.9,
  minPeople = GRADE_MIN_PEOPLE, minSpearman = GRADE_MIN_SPEARMAN, minClusters = 1 } = {}) {
  const grouped = pairs ?? (Array.isArray(panel) ? pairsByTemplate(panel) : null);
  if (!grouped?.size) throw new Error('gateRerun needs a non-empty panel');
  if (!screen?.tells?.length) throw new Error('gateRerun needs the TELLS-01a screen');

  const labels = templateLabels(screen);
  const clusterSet = new Set(panel ? panel.map(r => r.cluster) : []);
  for (const byCluster of grouped.values()) for (const c of byCluster.keys()) clusterSet.add(c);
  const clusters = [...clusterSet];
  const cells = cellVerdicts(grouped, clusters, { minPeople, minSpearman });
  const inPanel = [...cells.keys()];
  const universe = inPanel.filter(t => labels.has(t)).sort();
  const unscreened = inPanel.filter(t => !labels.has(t)).length;

  const tests = [
    ...OUTCOMES.map(o => [o, t => labels.get(t).has(o)]),
    ['any', t => labels.get(t).size > 0]
  ];

  const point = templateVerdicts(cells, allIndices(clusters.length), { minClusters, minPeople });
  const draws = new Map(tests.map(([o]) => [o, []]));
  const random = rng(seed);
  for (let rep = 0; rep < reps; rep++) {
    // Resample league-seasons with replacement; a cluster drawn twice counts twice.
    const sample = new Int32Array(clusters.length);
    for (let k = 0; k < sample.length; k++) sample[k] = Math.floor(random() * clusters.length);
    const verdicts = templateVerdicts(cells, sample, { minClusters, minPeople });
    for (const [o, isHit] of tests) {
      const s = scoreOutcome(verdicts, universe, isHit);
      // A resample in which the gate passes nothing has no precision; it is left out, not scored 0.
      if (s.precision != null) draws.get(o).push(s.precision);
    }
  }

  const lowQ = (1 - ci) / 2;
  const outcomes = {};
  for (const [o, isHit] of tests) {
    const s = scoreOutcome(point, universe, isHit);
    const sorted = draws.get(o).slice().sort((a, b) => a - b);
    const baseRate = universe.length ? s.hits / universe.length : null;
    const ciPair = [r4(quantile(sorted, lowQ)), r4(quantile(sorted, 1 - lowQ))];
    const row = {
      templates: universe.length, confirmed: s.hits, passes: s.passes, passes_confirmed: s.hitsPassed,
      base_rate: r4(baseRate), precision: r4(s.precision), recall: r4(s.recall),
      lift: baseRate && s.precision != null ? r4(s.precision / baseRate) : null,
      ci90: ciPair, bootstrap_draws_with_passes: sorted.length,
      beats_base: s.hits > 0 && ciPair[0] != null && baseRate != null && ciPair[0] > baseRate
    };
    row.statement = statementFor(o, row);
    outcomes[o] = row;
  }

  const claimed = ['adds', 'checkout', 'trade'].filter(o => outcomes[o].beats_base);
  const passed = universe.filter(t => point.get(t).pass).map(t => ({ template: t,
    pass_share: point.get(t).pass_share, clusters_graded: point.get(t).clusters_graded,
    confirmed_for: [...labels.get(t)].sort() }));
  return {
    clusters: clusters.length,
    templates: universe.length,
    templates_unscreened: unscreened,
    gate: { min_people: minPeople, min_spearman: minSpearman, min_clusters: minClusters,
      template_pass: 'passes in at least half of the league-seasons that could grade it' },
    bootstrap: { unit: 'league-season', reps, seed, ci },
    validator_base_rate: VALIDATOR_BASE_RATE,
    outcomes,
    gate_claim: claimed.length ? 'precision_claimed' : 'repeatability_only',
    claimed_for: claimed,
    passed
  };
}
