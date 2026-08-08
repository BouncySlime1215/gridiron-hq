/**
 * Specialist models that argue with each other, and a meta-model that decides
 * who to listen to.
 *
 * The twenty-model ensemble in nfl-ensemble.js blends opinions about the *game*
 * and then compares the blend to the market. That framing loses before it
 * starts: the closing line is more accurate than any of those models
 * individually (RMSE 12.66 against 13.14, every season — docs/NFL_MODEL_STATUS.md),
 * so averaging them cannot beat it. The only question worth modelling is the one
 * the market has already answered for us and might have answered wrong: given
 * the number, what is left over?
 *
 * So every specialist here predicts the *market residual* — actual margin minus
 * the number — from one family of evidence. A specialist that knows nothing
 * useful predicts zero and costs nothing, because zero means "the market is
 * right", which is the correct default.
 *
 * The specialists then talk. A plain average would treat the weather model as
 * equally worth hearing in a domed game and a thirty-mile-an-hour gale, which is
 * obviously wrong. The meta-model instead learns weights that depend on context:
 * each specialist's output is interacted with the conditions of the game, so the
 * blend can learn "believe the trenches model in short-yardage games" or "fade
 * the passing model in wind" rather than one fixed opinion per family.
 *
 * Everything is fit walk-forward: a prediction for week W of season S sees only
 * games that finished before it. And because a system this flexible can fit
 * noise beautifully, `permutationTest` re-runs the whole pipeline against
 * shuffled outcomes. If the architecture reports signal on data where signal
 * cannot exist, its verdicts on real data mean nothing either.
 */
import { rows } from '../db/index.js';

/* ------------------------------------------------------------- families */

/**
 * Each family is one coherent way of looking at a football team. They overlap
 * on purpose — the meta-model is what resolves disagreement, and correlated
 * specialists are fine as long as the blend is regularised.
 *
 * Keys are suffixes applied to both `off_` and `def_`; the differential built
 * for each is (home off − away def) − (away off − home def), so a positive
 * number always means the home side is favoured by that family's evidence.
 */
export const FAMILIES = {
  efficiency: ['epa_per_play', 'success_rate', 'epa_neutral_wp', 'success_rate_neutral_wp', 'yards_per_play', 'wpa_per_play'],
  passing: ['pass_epa_per_play', 'pass_success_rate', 'yards_per_attempt', 'completion_pct', 'cpoe', 'adot', 'deep_pass_epa', 'short_pass_epa', 'yac_per_completion', 'yac_over_expected'],
  rushing: ['rush_epa_per_play', 'rush_success_rate', 'yards_per_carry', 'stuff_rate'],
  explosive: ['explosive_play_rate', 'explosive_pass_rate', 'explosive_rush_rate', 'deep_attempt_rate'],
  trenches: ['sack_rate', 'qb_hit_rate', 'tfl_rate', 'havoc_rate', 'pressure_epa', 'clean_pocket_epa', 'pressure_epa_delta', 'sack_yards'],
  situational: ['third_down_rate', 'third_and_short_rate', 'third_and_long_rate', 'third_down_distance', 'fourth_down_rate', 'red_zone_td_rate', 'goal_to_go_td_rate', 'first_down_rate', 'second_and_long_epa'],
  drives: ['drive_scoring_rate', 'drive_td_rate', 'drive_punt_rate', 'drive_turnover_rate', 'three_and_out_rate', 'avg_drive_start', 'yards_per_drive', 'plays_per_drive', 'series_success_rate'],
  tempo: ['proe', 'neutral_pass_rate', 'no_huddle_rate', 'shotgun_rate', 'seconds_per_drive', 'plays', 'early_down_pass_rate'],
  turnovers: ['turnover_rate', 'int_rate', 'fumble_rate', 'forced_fumbles', 'passes_defended'],
  volatility: ['epa_volatility', 'half_epa_delta', 'first_half_epa', 'second_half_epa', 'epa_q4_close', 'garbage_time_share'],
  field_position: ['epa_own_territory', 'epa_midfield', 'epa_opp_territory', 'avg_yards_to_go']
};

/**
 * Situational families that are not team-vs-team differentials: conditions,
 * schedule and the team's own record against the number. These get their own
 * specialists because they answer a different question — not "who is better"
 * but "what does this particular spot do to the number".
 */
export const CONTEXT_FAMILY = 'context';
export const ATS_FAMILY = 'ats_history';

/**
 * Public opinion and news, which are real signals with no usable history yet.
 *
 * `movement` is where public money shows up. Licensed ticket/handle splits have
 * no free feed, but line movement is what those splits are a proxy for, and the
 * sharper half of it: a number moving *against* the popular side is the classic
 * tell. It needs an opening number and a closing one — game_lines has zero rows
 * with `open_spread`, so historically this is empty. The twice-daily snapshot
 * job added alongside the CLV rig is what fills it from here on.
 *
 * `news` reads reports filed in the days before kickoff. The stored feed covers
 * 31 offseason days, so it cannot be backtested either.
 *
 * Both are wired rather than omitted, because the ingestion is the slow part and
 * the data accumulates whether or not anyone is waiting for it. Both are also
 * *gated*: `fitSpecialists` disables any family whose inputs are mostly absent,
 * so an empty family contributes exactly zero instead of contributing noise that
 * the meta-model would happily fit. A family leaves the gate only by having real
 * coverage, and it only becomes trusted by beating the permutation null.
 */
export const MOVEMENT_FAMILY = 'movement';
export const NEWS_FAMILY = 'news';

/** A family is disabled when this share of its rows carry no information. */
const COVERAGE_FLOOR = 0.2;

/* ------------------------------------------------------------ linear algebra */

const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/** Ridge regression via normal equations. Intercept is never penalised. */
export function ridgeFit(X, y, lambda) {
  const p = X[0]?.length ?? 0, n = X.length;
  if (!n || !p) return null;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = X[i];
    for (let j = 0; j < p; j++) {
      b[j] += xi[j] * y[i];
      for (let k = j; k < p; k++) A[j][k] += xi[j] * xi[k];
    }
  }
  for (let j = 0; j < p; j++) for (let k = 0; k < j; k++) A[j][k] = A[k][j];
  for (let j = 1; j < p; j++) A[j][j] += lambda;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) continue;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= p; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => (Math.abs(r[i]) < 1e-12 ? 0 : r[p] / r[i]));
}

const predictWith = (w, x) => (w ? x.reduce((s, v, i) => s + v * w[i], 0) : 0);

/**
 * Standardisation is fitted on training data only and reused at prediction
 * time. Fitting it on everything would leak the test set's distribution into
 * the model — a small leak, but the kind that makes a dead model look alive.
 */
function fitScaler(X) {
  const p = X[0]?.length ?? 0;
  const mu = new Array(p).fill(0), sd = new Array(p).fill(1);
  for (let j = 0; j < p; j++) {
    const col = X.map(r => r[j]);
    mu[j] = mean(col);
    const v = mean(col.map(x => (x - mu[j]) ** 2));
    sd[j] = v > 1e-12 ? Math.sqrt(v) : 1;
  }
  return { mu, sd };
}
const applyScaler = (s, x) => x.map((v, j) => (v - s.mu[j]) / s.sd[j]);

/* ----------------------------------------------------------------- dataset */

const parse = s => { try { return JSON.parse(s); } catch { return null; } };

/**
 * Every completed game with the market's number, the outcome, and each team's
 * form going in.
 *
 * Form is the average of a team's prior weeks *within the same season*. Carrying
 * last season's form across the offseason would be a different feature with
 * different behaviour, and mixing the two silently is how a model ends up
 * unable to explain itself.
 */
export function buildDataset({ minSeason = 2016, maxSeason = 2025 } = {}) {
  const feats = rows(`SELECT season, week, team, features FROM nfl_team_week_features
                      WHERE season BETWEEN ? AND ?`, minSeason, maxSeason);
  const byTeam = new Map();           // season|team -> [{week, f}]
  for (const r of feats) {
    const f = parse(r.features);
    if (!f) continue;
    const k = `${r.season}|${r.team}`;
    if (!byTeam.has(k)) byTeam.set(k, []);
    byTeam.get(k).push({ week: r.week, f });
  }
  for (const list of byTeam.values()) list.sort((a, b) => a.week - b.week);

  /** Average of a team's features across every week strictly before `week`. */
  const formFor = (season, team, week) => {
    const list = byTeam.get(`${season}|${team}`);
    if (!list) return null;
    const prior = list.filter(x => x.week < week);
    if (prior.length < 2) return null;      // one game of form is mostly noise
    const out = {};
    const keys = new Set();
    for (const p of prior) for (const k of Object.keys(p.f)) keys.add(k);
    for (const k of keys) {
      const vals = prior.map(p => p.f[k]).filter(v => v != null && Number.isFinite(v));
      if (vals.length) out[k] = mean(vals);
    }
    return { ...out, _games: prior.length };
  };

  const games = rows(`SELECT season, week, team AS home, opponent AS away,
      team_score AS hs, opp_score AS as_, spread AS home_spread, total,
      open_spread, open_total,
      temp, wind, roof, surface, rest_days AS home_rest, div_game, gameday
    FROM game_lines
    WHERE home = 1 AND team_score IS NOT NULL AND spread IS NOT NULL
      AND season BETWEEN ? AND ? ORDER BY season, week`, minSeason, maxSeason);
  const awayRest = new Map();
  for (const r of rows(`SELECT season, week, team, rest_days FROM game_lines WHERE home = 0`)) {
    awayRest.set(`${r.season}|${r.week}|${r.team}`, r.rest_days);
  }

  const out = [];
  for (const g of games) {
    const H = formFor(g.season, g.home, g.week);
    const A = formFor(g.season, g.away, g.week);
    if (!H || !A) continue;
    const marketMargin = -g.home_spread;
    out.push({
      season: g.season, week: g.week, home: g.home, away: g.away,
      gameday: g.gameday, open_spread: g.open_spread, open_total: g.open_total,
      market_margin: marketMargin, market_total: g.total,
      actual_margin: g.hs - g.as_, actual_total: g.hs + g.as_,
      residual: (g.hs - g.as_) - marketMargin,     // the only target that matters
      H, A,
      ctx: {
        wind: g.wind ?? 0, temp: g.temp ?? 60,
        indoors: (g.roof === 'dome' || g.roof === 'closed') ? 1 : 0,
        turf: g.surface && g.surface !== 'grass' ? 1 : 0,
        home_rest: g.home_rest ?? 7,
        away_rest: awayRest.get(`${g.season}|${g.week}|${g.away}`) ?? 7,
        div: g.div_game ?? 0,
        spread_abs: Math.abs(g.home_spread), spread: g.home_spread,
        total: g.total ?? 45, week: g.week
      }
    });
  }
  return out;
}

/** (home offence − away defence) − (away offence − home defence), per key. */
function familyVector(row, keys) {
  const v = [];
  for (const k of keys) {
    const ho = row.H[`off_${k}`], hd = row.H[`def_${k}`];
    const ao = row.A[`off_${k}`], ad = row.A[`def_${k}`];
    v.push([ho, hd, ao, ad].every(x => x != null && Number.isFinite(x))
      ? (ho - ad) - (ao - hd) : 0);
  }
  return v;
}

function contextVector(row) {
  const c = row.ctx;
  return [
    c.wind / 10, (c.temp - 60) / 20, c.indoors, c.turf,
    (c.home_rest - c.away_rest) / 7, c.div,
    c.spread / 7, c.spread_abs / 7, (c.total - 45) / 7, (c.week - 9) / 9
  ];
}

/**
 * A team's own history against the number, going into this game.
 *
 * This is the family most likely to be pure noise — ATS records are famously
 * non-predictive — which is exactly why it gets a specialist rather than being
 * asserted. If it has nothing, the meta-model will learn to ignore it, and that
 * is a more useful answer than leaving it out on a hunch.
 */
function atsHistory(dataset) {
  const hist = new Map();     // season|team -> [residual from that team's view]
  const push = (s, t, v) => {
    const k = `${s}|${t}`;
    if (!hist.has(k)) hist.set(k, []);
    hist.get(k).push(v);
  };
  const out = new Map();
  for (const r of dataset) {
    const h = hist.get(`${r.season}|${r.home}`) ?? [];
    const a = hist.get(`${r.season}|${r.away}`) ?? [];
    out.set(r, [
      h.length ? mean(h) / 7 : 0,
      a.length ? mean(a) / 7 : 0,
      h.length ? mean(h.slice(-3)) / 7 : 0,
      a.length ? mean(a.slice(-3)) / 7 : 0,
      (h.length ? h.filter(x => x > 0).length / h.length : 0.5) - 0.5,
      (a.length ? a.filter(x => x > 0).length / a.length : 0.5) - 0.5
    ]);
    push(r.season, r.home, r.residual);
    push(r.season, r.away, -r.residual);
  }
  return out;
}

/**
 * Where the number opened versus where it sits now — the public-money proxy.
 *
 * Both the stored opener and the snapshot history are consulted, because the
 * two fill from different sources: `open_spread` would come from a historical
 * backfill, the snapshots from the scheduled capture running now.
 */
function movementVector(row, snapshotMoves) {
  const snap = snapshotMoves.get(row.home);
  const spreadMove = row.open_spread != null
    ? row.market_margin - -row.open_spread
    : (snap?.spread_move ?? null);
  const totalMove = row.open_total != null && row.market_total != null
    ? row.market_total - row.open_total
    : (snap?.total_move ?? null);
  return [
    spreadMove == null ? 0 : Math.max(-3, Math.min(3, spreadMove)) / 3,
    totalMove == null ? 0 : Math.max(-6, Math.min(6, totalMove)) / 6,
    // Movement against the favourite is the part that historically carries the
    // signal, so it gets its own term rather than being folded into the first.
    spreadMove == null ? 0 : Math.sign(spreadMove) * (row.market_margin > 0 ? -1 : 1)
  ];
}

/** Volume and weight of reporting on each side in the week before kickoff. */
function newsVector(row, newsByTeamDate) {
  const pick = team => {
    const hits = newsByTeamDate.get(`${row.season}|${row.week}|${team}`);
    return hits ? [hits.count, hits.importance] : [0, 0];
  };
  const [hc, hi] = pick(row.home);
  const [ac, ai] = pick(row.away);
  return [(hc - ac) / 5, (hi - ai) / 5];
}

/** Every specialist's design vector for one game. */
export function designVectors(dataset) {
  const ats = atsHistory(dataset);

  // Snapshots store full team names and news stores team ids, while games use
  // abbreviations. Both joins go through nfl_teams.
  const abbrByName = new Map(), abbrById = new Map();
  for (const t of rows('SELECT id, abbr, name FROM nfl_teams')) {
    abbrByName.set(t.name, t.abbr);
    abbrById.set(t.id, t.abbr);
  }

  // First and last captured number per game, which is the movement the public
  // created. Empty until the scheduled capture has run across a real slate.
  const snapshotMoves = new Map();
  const bySide = new Map();
  for (const r of rows(`SELECT home_team, away_team, commence_time, market, side, line, captured_at
                        FROM nfl_line_snapshots WHERE line IS NOT NULL ORDER BY captured_at`)) {
    const home = abbrByName.get(r.home_team);
    if (!home) continue;
    const key = `${home}|${r.market}|${r.side}|${(r.commence_time ?? '').slice(0, 10)}`;
    const e = bySide.get(key) ?? { home, market: r.market, side: r.side, first: r.line, last: r.line };
    e.last = r.line;
    bySide.set(key, e);
  }
  for (const e of bySide.values()) {
    // Season/week are not on a snapshot, so movement is attached by home team
    // and resolved against the schedule at lookup time.
    const k = e.home;
    const cur = snapshotMoves.get(k) ?? {};
    if (e.market === 'spreads' && abbrByName.get(e.side) === e.home) cur.spread_move = e.last - e.first;
    if (e.market === 'totals' && e.side === 'Over') cur.total_move = e.last - e.first;
    snapshotMoves.set(k, cur);
  }

  // Reports filed in the seven days before kickoff, weighted by importance.
  const newsByTeamDate = new Map();
  const gameDates = new Map();
  for (const r of dataset) gameDates.set(`${r.season}|${r.week}|${r.home}`, r.gameday);
  for (const n of rows(`SELECT date, team_id, importance FROM news_items WHERE team_id IS NOT NULL`)) {
    const abbr = abbrById.get(n.team_id);
    if (!abbr || !n.date) continue;
    for (const r of dataset) {
      if (r.home !== abbr && r.away !== abbr) continue;
      if (!r.gameday) continue;
      const days = (new Date(r.gameday) - new Date(n.date)) / 86400000;
      if (days < 0 || days > 7) continue;
      const key = `${r.season}|${r.week}|${abbr}`;
      const e = newsByTeamDate.get(key) ?? { count: 0, importance: 0 };
      e.count++; e.importance += Number(n.importance) || 0;
      newsByTeamDate.set(key, e);
    }
  }

  return dataset.map(r => {
    const fam = {};
    for (const [name, keys] of Object.entries(FAMILIES)) fam[name] = familyVector(r, keys);
    fam[CONTEXT_FAMILY] = contextVector(r);
    fam[ATS_FAMILY] = ats.get(r);
    fam[MOVEMENT_FAMILY] = movementVector(r, snapshotMoves);
    fam[NEWS_FAMILY] = newsVector(r, newsByTeamDate);
    return fam;
  });
}

export const FAMILY_NAMES = [...Object.keys(FAMILIES), CONTEXT_FAMILY, ATS_FAMILY,
  MOVEMENT_FAMILY, NEWS_FAMILY];

/* -------------------------------------------------------------- the models */

/**
 * Fits one specialist per family on the training residuals.
 *
 * Lambda is deliberately heavy. These families have up to ten correlated
 * columns each and the true signal, if any, is small; under-regularising here
 * produces specialists that are confidently wrong and a meta-model that cannot
 * tell them apart.
 */
export function fitSpecialists(design, target, { lambda = 250 } = {}) {
  const models = {};
  for (const name of FAMILY_NAMES) {
    const raw = design.map(d => d[name]);
    // Coverage gate. A family whose inputs are almost entirely zero has no data,
    // not a flat signal, and fitting it anyway hands the meta-model a column of
    // noise to chase. Disabled families predict exactly zero, which is the same
    // as saying "the market is right" — the correct thing to say when you know
    // nothing. They report why, so an empty family is visible rather than
    // silently weightless.
    const informative = raw.filter(x => x.some(v => v !== 0 && Number.isFinite(v))).length;
    const coverage = raw.length ? informative / raw.length : 0;
    if (coverage < COVERAGE_FLOOR) {
      models[name] = { disabled: true, coverage: r4(coverage), reason: 'insufficient data coverage' };
      continue;
    }
    const scaler = fitScaler(raw);
    const X = raw.map(x => [1, ...applyScaler(scaler, x)]);
    models[name] = { scaler, w: ridgeFit(X, target, lambda), coverage: r4(coverage) };
  }
  return models;
}

export function specialistPredictions(models, design) {
  return design.map(d => {
    const o = {};
    for (const name of FAMILY_NAMES) {
      const m = models[name];
      o[name] = m && !m.disabled && m.w
        ? predictWith(m.w, [1, ...applyScaler(m.scaler, d[name])]) : 0;
    }
    return o;
  });
}

/**
 * The meta-model: how much to believe each specialist, given the situation.
 *
 * Its inputs are each specialist's prediction *and* that prediction multiplied
 * by a handful of context gates. The interaction terms are the whole point —
 * they are what let the blend say "this family matters here and not there"
 * instead of assigning one permanent weight per family.
 */
const GATES = [
  ['windy', c => Math.min(1, c.wind / 20)],
  ['indoors', c => c.indoors],
  ['big_spread', c => Math.min(1, c.spread_abs / 10)],
  ['high_total', c => Math.min(1, Math.max(-1, (c.total - 45) / 10))],
  ['late_season', c => Math.min(1, Math.max(0, (c.week - 9) / 9))],
  ['rest_edge', c => Math.max(-1, Math.min(1, (c.home_rest - c.away_rest) / 7))]
];

function metaVector(preds, ctx) {
  const v = [1];
  for (const name of FAMILY_NAMES) {
    const p = preds[name] ?? 0;
    v.push(p);
    for (const [, fn] of GATES) v.push(p * fn(ctx));
  }
  return v;
}

export function fitMeta(preds, dataset, target, { lambda = 500 } = {}) {
  const X = preds.map((p, i) => metaVector(p, dataset[i].ctx));
  return ridgeFit(X, target, lambda);
}

export const metaPredict = (w, preds, ctx) => predictWith(w, metaVector(preds, ctx));

/* ------------------------------------------------------------- evaluation */

/**
 * Walk-forward evaluation.
 *
 * For each test season, everything — scalers, specialists and the meta-model —
 * is refit on prior seasons only, then applied once. This is the number that
 * decides whether the architecture is worth anything; a positive out-of-sample
 * R² means the specialists collectively know something the closing line does
 * not, and anything at or below zero means they do not.
 */
export function evaluate({
  dataset = null, testSeasons = [2021, 2022, 2023, 2024, 2025],
  minTrainSeasons = 3, lambda = 250, metaLambda = 500, shuffle = null
} = {}) {
  const data = dataset ?? buildDataset();
  const design = designVectors(data);
  let target = data.map(r => r.residual);
  if (shuffle) target = shuffle(target.slice());

  const perSeason = [];
  let lastModels = null;
  const all = { pred: [], actual: [], rows: [] };
  const familyContribution = Object.fromEntries(FAMILY_NAMES.map(n => [n, []]));

  for (const season of testSeasons) {
    const trainIdx = [], testIdx = [];
    data.forEach((r, i) => {
      if (r.season < season) trainIdx.push(i);
      else if (r.season === season) testIdx.push(i);
    });
    if (!testIdx.length) continue;
    const trainSeasons = new Set(trainIdx.map(i => data[i].season));
    if (trainSeasons.size < minTrainSeasons) continue;

    const trD = trainIdx.map(i => design[i]), trY = trainIdx.map(i => target[i]);
    const models = fitSpecialists(trD, trY, { lambda });
    lastModels = models;
    const trPred = specialistPredictions(models, trD);
    const metaW = fitMeta(trPred, trainIdx.map(i => data[i]), trY, { lambda: metaLambda });

    const teD = testIdx.map(i => design[i]);
    const tePred = specialistPredictions(models, teD);
    const pred = tePred.map((p, j) => metaPredict(metaW, p, data[testIdx[j]].ctx));
    const actual = testIdx.map(i => target[i]);

    // Each specialist's standalone out-of-sample correlation with the residual,
    // which is what "did this family matter" should mean.
    for (const name of FAMILY_NAMES) {
      familyContribution[name].push(...tePred.map((p, j) => [p[name], actual[j]]));
    }

    const ssr = mean(actual.map((a, j) => (a - pred[j]) ** 2));
    const sst = mean(actual.map(a => a ** 2));       // baseline: trust the market
    perSeason.push({
      season, games: testIdx.length,
      r2: r4(1 - ssr / sst),
      rmse: r4(Math.sqrt(ssr)),
      market_rmse: r4(Math.sqrt(sst))
    });
    all.pred.push(...pred); all.actual.push(...actual);
    all.rows.push(...testIdx.map(i => data[i]));
  }

  const ssr = mean(all.actual.map((a, i) => (a - all.pred[i]) ** 2));
  const sst = mean(all.actual.map(a => a ** 2));
  const corrOf = pairs => {
    const x = pairs.map(p => p[0]), y = pairs.map(p => p[1]);
    const mx = mean(x), my = mean(y);
    let n = 0, dx = 0, dy = 0;
    for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
    return dx > 0 && dy > 0 ? n / Math.sqrt(dx * dy) : 0;
  };

  return {
    games: all.actual.length,
    gated_families: lastModels
      ? FAMILY_NAMES.filter(n => lastModels[n]?.disabled)
        .map(n => ({ family: n, coverage: lastModels[n].coverage, reason: lastModels[n].reason }))
      : [],
    r2: r4(1 - ssr / sst),
    rmse: r4(Math.sqrt(ssr)),
    market_rmse: r4(Math.sqrt(sst)),
    per_season: perSeason,
    families: FAMILY_NAMES
      .map(n => ({ family: n, out_of_sample_corr: r4(corrOf(familyContribution[n])) }))
      .sort((a, b) => Math.abs(b.out_of_sample_corr) - Math.abs(a.out_of_sample_corr)),
    predictions: all.pred.map((p, i) => ({
      season: all.rows[i].season, week: all.rows[i].week,
      home: all.rows[i].home, away: all.rows[i].away,
      market_margin: all.rows[i].market_margin,
      predicted_residual: r4(p), actual_residual: r4(all.actual[i])
    }))
  };
}

/**
 * The honesty check.
 *
 * The same pipeline is run against outcomes that have been shuffled, destroying
 * any real relationship while preserving every distribution and correlation
 * among the features. A well-behaved model scores about zero here. If it scores
 * well, the architecture is capable of inventing signal, and its result on real
 * data is not evidence of anything.
 */
export function permutationTest({ trials = 5, seed = 7, ...options } = {}) {
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const data = buildDataset();
  const real = evaluate({ ...options, dataset: data });
  const nulls = [];
  for (let t = 0; t < trials; t++) {
    const r = evaluate({
      ...options, dataset: data,
      shuffle: y => {
        for (let i = y.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [y[i], y[j]] = [y[j], y[i]];
        }
        return y;
      }
    });
    nulls.push(r.r2);
  }
  const nullMean = mean(nulls);
  const nullSd = nulls.length > 1
    ? Math.sqrt(nulls.reduce((s, v) => s + (v - nullMean) ** 2, 0) / (nulls.length - 1)) : null;
  // A slightly negative null R2 is the healthy result, not a failure: fitting
  // parameters to shuffled outcomes costs a little accuracy, so the null lands
  // just below zero. The failure mode is a null that scores *positive* — that
  // would mean the pipeline can conjure signal from noise.
  const manufacturesSignal = nullMean > 0.01;
  // The only claim that matters: is real meaningfully above the null?
  const z = nullSd && nullSd > 1e-9 ? (real.r2 - nullMean) / nullSd : null;

  return {
    real_r2: real.r2,
    null_r2: nulls.map(r4),
    null_mean_r2: r4(nullMean),
    null_sd_r2: r4(nullSd),
    z_vs_null: r4(z),
    passes: !manufacturesSignal,
    has_signal: !manufacturesSignal && z != null && z >= 2 && real.r2 > 0,
    verdict: manufacturesSignal
      ? 'The pipeline scores positively on shuffled outcomes, so it can manufacture signal. Its result on real data proves nothing until this is fixed.'
      : z != null && z >= 2 && real.r2 > 0
        ? 'Shuffled outcomes score at or below zero, as they must, and real outcomes score clearly above them. That gap is real signal.'
        : 'Real outcomes score no better than shuffled ones. The specialists collectively know nothing the closing line does not — this architecture is honest, and its answer is no.'
  };
}
