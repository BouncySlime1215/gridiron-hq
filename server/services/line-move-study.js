/**
 * Beat the close, Phase 1: does anything we hold before a line moves predict
 * where it goes from open to close? (docs/BEAT_THE_CLOSE_PLAN.md)
 *
 * The score model re-derives the closing line from the closing line's own
 * inputs, so its error is the market's. The only edge measurable inside a
 * season is closing line value: a number better than the close. That is a
 * forecast of the LINE, and this is the first one fitted here.
 *
 * Data: `nfl_odds_archive` (Pinnacle opener and last pre-kickoff line plus
 * ten soft books, each with the book's timestamp), `game_lines` results, the
 * verified event archive (v2 availability stamps), the walk-forward ratings
 * line and the four matchup roles. Every feature carries the decision time
 * it was knowable at: T0 = Pinnacle's opener, T1 = Wednesday 16:00Z,
 * T2 = Friday 16:00Z of game week. Nothing after the close enters.
 *
 * Target convention: `y` is the move TOWARD the home side (spreads: opener
 * minus close, so a line going from -3 to -4 is +1) or TOWARD the over
 * (totals: close minus open). Betting the opener on the predicted side then
 * earns CLV = y if the prediction was the positive side, else -y. Mean CLV
 * in points, with a week-clustered bootstrap interval on the held-out
 * seasons, is the gate. Direction accuracy is reported beside it.
 */
import { rows } from '../db/index.js';
import { fitModel, fitRatings } from './nfl-market.js';
import { matchupOpinion, MATCHUP_ROLES, ridge } from './nfl-matchup-specialists.js';
import { teamEventVector } from './nfl-event-archive.js';

export const LINE_MOVE_STUDY_VERSION = 'beat-the-close-phase1-v1';
export const CLV_GATE_POINTS = 0.3;
export const GATE_MIN_GAMES = 300;
export const MIN_SLICE = 30;
const HOLDOUT_FROM = 2024;
const MIN_TRAIN = 150;
const BOOTSTRAP = 400;
const LOGIT_LAMBDA = 2;
const RIDGE_LAMBDA = 10;

const r3 = v => (Number.isFinite(v) ? +v.toFixed(3) : null);
const r4 = v => (Number.isFinite(v) ? +v.toFixed(4) : null);
const mean = list => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : null);
const median = list => { const s = [...list].sort((a, b) => a - b); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sign = v => (v > 0 ? 1 : v < 0 ? -1 : 0);

/* ------------------------------------------------------------- dataset */

/**
 * Decision times. T0 is Pinnacle's opener. S is the moment the third soft
 * book has posted its opener: the soft books open HOURS after Pinnacle, so a
 * sharp-versus-soft gap is not knowable at T0 and, worse, partly reflects
 * Pinnacle's own move in between. At S the bettable number is the soft
 * opener, so CLV for S-time signals is measured against that, not against
 * Pinnacle's opener. T1/T2 are Wednesday and Friday 16:00Z of game week; the
 * archive has no line at those times, so their CLV against the opener is an
 * upper bound and is labelled as such.
 */
function decisionTimes(gameday, openerAt, closeAt, softOpenAt) {
  const day = new Date(`${gameday}T00:00:00Z`);
  const dow = day.getUTCDay(); // 0 Sunday
  const daysBackToWed = (dow - 3 + 7) % 7, daysBackToFri = (dow - 5 + 7) % 7;
  const wed = new Date(day.getTime() - daysBackToWed * 86400000 + 16 * 3600000).toISOString();
  const fri = new Date(day.getTime() - daysBackToFri * 86400000 + 16 * 3600000).toISOString();
  const clamp = t => (t < openerAt ? openerAt : t > closeAt ? closeAt : t);
  // Monotonic by construction: a decision time can never precede an earlier one.
  const S = clamp(softOpenAt ?? openerAt);
  const T1 = [clamp(wed), S].sort().at(-1);
  const T2 = [clamp(fri), T1].sort().at(-1);
  return { T0: openerAt, S, T1, T2 };
}
export const DECISION_TIMES = Object.freeze(['T0', 'S', 'T1', 'T2']);
export const CLV_BASIS = Object.freeze({ T0: 'pinnacle opener (bettable at T0)', S: 'soft-book opener (bettable at S)',
  T1: 'pinnacle opener (upper bound: no line stored at T1)', T2: 'pinnacle opener (upper bound: no line stored at T2)' });

function keyProximity(line) {
  const a = Math.abs(line);
  return Math.min(Math.abs(a - 3), Math.abs(a - 7));
}

/** Prior-week cover margin, margin of victory and ATS streak per team, strictly earlier weeks. */
function teamHistory(seasons) {
  const games = rows(`SELECT season,week,team home,opponent away,spread,team_score,opp_score FROM game_lines
    WHERE home=1 AND spread IS NOT NULL AND team_score IS NOT NULL AND opp_score IS NOT NULL
      AND season>=? ORDER BY season,week`, Math.min(...seasons) - 1);
  const byTeam = new Map();
  for (const g of games) {
    const margin = g.team_score - g.opp_score;
    const homeCover = margin + g.spread; // spread is home-perspective; negative = home favoured
    for (const [team, cover, mov] of [[g.home, homeCover, margin], [g.away, -homeCover, -margin]]) {
      const list = byTeam.get(team) ?? []; list.push({ season: g.season, week: g.week, cover, mov }); byTeam.set(team, list);
    }
  }
  return (team, season, week) => {
    const prior = (byTeam.get(team) ?? []).filter(x => x.season < season || (x.season === season && x.week < week));
    const last = prior.at(-1);
    let streak = 0;
    for (let i = prior.length - 1; i >= 0; i--) { if (prior[i].cover > 0) streak++; else break; }
    return { prior_cover: last?.cover ?? 0, prior_mov: last?.mov ?? 0, ats_streak: streak };
  };
}

function archiveRows(seasons) {
  return rows(`SELECT eid,season,week,home,away,commence_time,book,market,side,phase,line,price,book_updated_at
    FROM nfl_odds_archive WHERE season IN (${seasons.map(() => '?').join(',')}) AND market IN ('spreads','totals')
      AND ((market='spreads' AND side=home) OR (market='totals' AND side='Over'))`, ...seasons);
}

/**
 * One row per (game, market) with the target, the decision times and every
 * feature stamped by the time it was knowable. Games without a Pinnacle
 * opener and close, or with fewer than three books at either end, are
 * dropped and counted.
 */
export function buildLineMoveDataset({ seasons = [2022, 2023, 2024, 2025], includeModels = true, selectionThrough = null } = {}) {
  const byGame = new Map();
  for (const q of archiveRows(seasons)) {
    const key = `${q.eid}|${q.market}`;
    const g = byGame.get(key) ?? { eid: q.eid, season: q.season, week: q.week, home: q.home, away: q.away,
      commence_time: q.commence_time, market: q.market, pin: {}, soft: { open: [], close: [] } };
    if (q.book === 'pinnacle') g.pin[q.phase] = { line: q.line, at: q.book_updated_at ?? q.commence_time };
    else { g.soft[q.phase].push(q.line); (g.soft[`${q.phase}_at`] ??= []).push(q.book_updated_at ?? q.commence_time); }
    byGame.set(key, g);
  }
  const lines = new Map(rows(`SELECT season,week,team,opponent,home,gameday,gametime,div_game,rest_days,team_score,opp_score,spread,total
    FROM game_lines WHERE season IN (${seasons.map(() => '?').join(',')})`, ...seasons).map(r => [`${r.season}|${r.week}|${r.team}`, r]));
  const history = teamHistory(seasons);
  const market = includeModels ? (selectionThrough == null ? fitModel() : fitRatings({ selectionThrough })) : null;
  const walk = new Map();
  if (market && !market.error) for (const r of market.results) walk.set(`${r.g.season}|${r.g.week}|${r.g.home}`, r);
  // Last season's tendency for each team's lines to move toward it (from the archive itself).
  const tendency = new Map();
  for (const g of byGame.values()) {
    if (g.market !== 'spreads' || !g.pin.open || !g.pin.close) continue;
    const towardHome = g.pin.open.line - g.pin.close.line;
    for (const [team, v] of [[g.home, towardHome], [g.away, -towardHome]]) {
      const key = `${g.season}|${team}`; const list = tendency.get(key) ?? []; list.push(v); tendency.set(key, list);
    }
  }
  const dropped = { no_pinnacle: 0, thin_books: 0, no_game: 0, no_result: 0 };
  const out = [];
  for (const g of byGame.values()) {
    if (!g.pin.open || !g.pin.close) { dropped.no_pinnacle++; continue; }
    if (g.soft.open.length < 3 || g.soft.close.length < 3) { dropped.thin_books++; continue; }
    const homeRow = lines.get(`${g.season}|${g.week}|${g.home}`), awayRow = lines.get(`${g.season}|${g.week}|${g.away}`);
    if (!homeRow) { dropped.no_game++; continue; }
    if (!Number.isFinite(homeRow.team_score)) { dropped.no_result++; continue; }
    const openerAt = g.pin.open.at, closeAt = g.pin.close.at;
    const softOpenAt = [...(g.soft.open_at ?? [])].sort()[2] ?? null;
    const T = decisionTimes(homeRow.gameday, openerAt, closeAt, softOpenAt);
    const open = g.pin.open.line, close = g.pin.close.line;
    const y = g.market === 'spreads' ? open - close : close - open;
    const openSoft = median(g.soft.open), closeSoft = median(g.soft.close);
    const ySoft = g.market === 'spreads' ? openSoft - close : close - openSoft;
    const softLagHours = softOpenAt ? (Date.parse(softOpenAt) - Date.parse(openerAt)) / 3600000 : null;
    const h = history(g.home, g.season, g.week), a = history(g.away, g.season, g.week);
    const hour = Number(String(homeRow.gametime ?? '13:00').slice(0, 2));
    const dow = new Date(`${homeRow.gameday}T00:00:00Z`).getUTCDay();
    const features = {
      T0: {
        home_fav: g.market === 'spreads' ? (open < 0 ? 1 : 0) : 0,
        fav_size: g.market === 'spreads' ? Math.abs(open) : 0,
        key_proximity: g.market === 'spreads' ? keyProximity(open) : 0,
        primetime: hour >= 20 || dow === 4 || dow === 1 ? 1 : 0,
        div_game: Number(homeRow.div_game ?? 0),
        rest_diff: Number(homeRow.rest_days ?? 7) - Number(awayRow?.rest_days ?? 7),
        prior_cover_diff: h.prior_cover - a.prior_cover,
        prior_mov_diff: h.prior_mov - a.prior_mov,
        ats_streak_diff: h.ats_streak - a.ats_streak,
        team_move_tendency: (mean(tendency.get(`${g.season - 1}|${g.home}`) ?? []) ?? 0) - (mean(tendency.get(`${g.season - 1}|${g.away}`) ?? []) ?? 0)
      },
      S: {
        sharp_soft_gap: g.market === 'spreads' ? openSoft - open : open - openSoft,
        dispersion_open: Math.max(...g.soft.open, open) - Math.min(...g.soft.open, open),
        soft_open_lag_hours: softLagHours ?? 0
      },
      T1: {}, T2: {}
    };
    const w = walk.get(`${g.season}|${g.week}|${g.home}`);
    if (includeModels) {
      features.T0.ratings_vs_open = w ? (g.market === 'spreads' ? w.predMargin + open : w.predTotal - open) : 0;
      if (g.market === 'spreads') {
        for (const role of MATCHUP_ROLES) {
          const o = matchupOpinion(role, g.season, g.week, g.home, g.away);
          features.T0[`${role}_forecast`] = Number.isFinite(o.forecast) ? o.forecast : 0;
        }
      }
      const at0 = { home: teamEventVector(g.home, { before: T.T0, sinceDays: 10 }), away: teamEventVector(g.away, { before: T.T0, sinceDays: 10 }) };
      for (const t of ['T1', 'T2']) {
        const atT = { home: teamEventVector(g.home, { before: T[t], sinceDays: 10 }), away: teamEventVector(g.away, { before: T[t], sinceDays: 10 }) };
        const qbOut = side => atT[side].active_player_states.filter(e => e.position === 'QB' && /out|reserve|doubtful/i.test(String(e.status_after ?? '')) && e.available_at > T.T0).length;
        features[t] = {
          injury_burden_delta: ((atT.away.injury_burden - at0.away.injury_burden) - (atT.home.injury_burden - at0.home.injury_burden)),
          qb_out_delta: qbOut('away') - qbOut('home'),
          events_since_open: (atT.home.events - at0.home.events) + (atT.away.events - at0.away.events),
          trades_since_open: (atT.home.trade_arrivals - at0.home.trade_arrivals) + (atT.away.trade_arrivals - at0.away.trade_arrivals)
        };
      }
    }
    const margin = homeRow.team_score - homeRow.opp_score;
    out.push({ eid: g.eid, season: g.season, week: g.week, home: g.home, away: g.away, market: g.market,
      open, close, open_soft: openSoft, close_soft: closeSoft, books_open: g.soft.open.length + 1, books_close: g.soft.close.length + 1,
      opener_at: openerAt, close_at: closeAt, soft_open_at: softOpenAt, decision_times: T, y, y_sign: sign(y),
      y_soft: ySoft, y_soft_sign: sign(ySoft),
      key_cross: g.market === 'spreads' && [3, 7].some(k => (Math.abs(open) - k) * (Math.abs(close) - k) < 0) ? 1 : 0,
      actual_margin: margin, actual_total: homeRow.team_score + homeRow.opp_score, features });
  }
  out.sort((p, q) => p.season - q.season || p.week - q.week || String(p.home).localeCompare(q.home));
  return { version: LINE_MOVE_STUDY_VERSION, seasons, rows: out, dropped, built_at: new Date().toISOString(),
    ratings_line: market?.error ? null : `walk-forward ratings line (alpha/carryover selected on seasons ≤ ${market.fitWindow?.selection_seasons?.[1]})`,
    selection_through: selectionThrough };
}

/* ---------------------------------------------------------------- models */

function standardiser(X) {
  const k = X[0].length;
  const mx = Array.from({ length: k }, (_, j) => mean(X.map(r => r[j])));
  const sx = Array.from({ length: k }, (_, j) => Math.sqrt(mean(X.map(r => (r[j] - mx[j]) ** 2))) || 1);
  return row => row.map((v, j) => (v - mx[j]) / sx[j]);
}

/** L2 logistic regression by Newton steps on standardised features (intercept unpenalised). */
function logistic(Z, y, lambda) {
  const k = Z[0].length + 1;
  let beta = new Array(k).fill(0);
  const X = Z.map(r => [1, ...r]);
  for (let iter = 0; iter < 25; iter++) {
    const p = X.map(r => 1 / (1 + Math.exp(-r.reduce((s, v, j) => s + v * beta[j], 0))));
    const grad = new Array(k).fill(0), H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let n = 0; n < X.length; n++) {
      const w = p[n] * (1 - p[n]), e = y[n] - p[n];
      for (let i = 0; i < k; i++) {
        grad[i] += X[n][i] * e;
        for (let j = 0; j < k; j++) H[i][j] -= X[n][i] * X[n][j] * w;
      }
    }
    for (let i = 1; i < k; i++) { grad[i] -= lambda * beta[i]; H[i][i] -= lambda; }
    const step = solveLinear(H.map(r => r.map(v => -v)), grad);
    if (!step) break;
    beta = beta.map((b, i) => b + step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-6) break;
  }
  return { beta, predict: row => 1 / (1 + Math.exp(-[1, ...row].reduce((s, v, j) => s + v * beta[j], 0))) };
}

function solveLinear(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

function featureNames(rowsIn, upTo) {
  const names = new Set();
  const limit = DECISION_TIMES.indexOf(upTo);
  for (const r of rowsIn) for (const t of DECISION_TIMES.slice(0, limit + 1)) {
    for (const k of Object.keys(r.features[t] ?? {})) names.add(`${t}:${k}`);
  }
  return [...names];
}
const vec = (r, names) => names.map(n => { const [t, k] = n.split(':'); const v = r.features[t]?.[k]; return Number.isFinite(v) ? v : 0; });

function seededRandom(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/** Mean CLV with a week-clustered bootstrap interval. */
function clvSummary(preds, basis = 'T0') {
  const target = basis === 'S' ? p => p.y_soft : p => p.y;
  const targetSign = basis === 'S' ? p => p.y_soft_sign : p => p.y_sign;
  const scored = preds.filter(p => targetSign(p) !== 0);
  const clv = preds.map(p => (p.side > 0 ? target(p) : -target(p)));
  const weeks = new Map();
  for (const p of preds) { const key = `${p.season}|${p.week}`; const list = weeks.get(key) ?? []; list.push(p.side > 0 ? target(p) : -target(p)); weeks.set(key, list); }
  const clusters = [...weeks.values()];
  const rand = seededRandom(20260902);
  const means = [];
  for (let b = 0; b < BOOTSTRAP; b++) {
    const sample = [];
    for (let i = 0; i < clusters.length; i++) sample.push(...clusters[Math.floor(rand() * clusters.length)]);
    means.push(mean(sample));
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(0.025 * means.length)], hi = means[Math.floor(0.975 * means.length)];
  return { n: preds.length, weeks: clusters.length, clv_basis: CLV_BASIS[basis], mean_clv: r3(mean(clv)), clv_interval: [r3(lo), r3(hi)],
    positive_share: r4(clv.filter(v => v > 0).length / clv.length),
    p_clv_le_zero: r4(means.filter(m => m <= 0).length / means.length),
    direction_accuracy: scored.length ? r4(scored.filter(p => p.side === targetSign(p)).length / scored.length) : null,
    direction_n: scored.length,
    brier: r4(mean(scored.map(p => (p.p_home - (targetSign(p) > 0 ? 1 : 0)) ** 2))) };
}

function fitAndPredict(train, test, names) {
  if (train.length < MIN_TRAIN || !test.length) return null;
  const std = standardiser(train.map(r => vec(r, names)));
  const Ztrain = train.map(r => std(vec(r, names)));
  const yTrain = train.map(r => (r.y_sign > 0 ? 1 : 0));
  const logit = logistic(Ztrain, yTrain, LOGIT_LAMBDA);
  const mag = ridge(train.map(r => vec(r, names)), train.map(r => r.y), RIDGE_LAMBDA);
  return test.map(r => {
    const z = std(vec(r, names));
    const p = logit.predict(z);
    return { season: r.season, week: r.week, market: r.market, y: r.y, y_sign: r.y_sign, y_soft: r.y_soft, y_soft_sign: r.y_soft_sign, p_home: p,
      side: p >= 0.5 ? 1 : -1, magnitude: mag ? mag.predict(vec(r, names)) : 0, row: r };
  }).concat();
}

function walkForward(data, names) {
  const weeks = [...new Set(data.map(r => `${r.season}|${r.week}`))];
  const preds = [];
  for (const wk of weeks) {
    const [season, week] = wk.split('|').map(Number);
    const train = data.filter(r => r.season < season || (r.season === season && r.week < week));
    const test = data.filter(r => r.season === season && r.week === week);
    const p = fitAndPredict(train, test, names);
    if (p) preds.push(...p);
  }
  return preds;
}

function holdout(data, names) {
  const train = data.filter(r => r.season < HOLDOUT_FROM), test = data.filter(r => r.season >= HOLDOUT_FROM);
  return { train, preds: fitAndPredict(train, test, names) ?? [] };
}

/** Holm step-down on a list of p-values; returns adjusted p per index. */
function holm(pvals) {
  const order = pvals.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const m = pvals.length, adjusted = new Array(m).fill(1);
  let running = 0;
  order.forEach(([p, i], rank) => { running = Math.max(running, Math.min(1, (m - rank) * p)); adjusted[i] = running; });
  return adjusted;
}

/* ---------------------------------------------------------------- report */

export function lineMoveStudy({ seasons = [2022, 2023, 2024, 2025], includeModels = true, dataset = null, selectionThrough = null } = {}) {
  const built = dataset ?? buildLineMoveDataset({ seasons, includeModels, selectionThrough });
  const all = built.rows;
  if (all.length < MIN_TRAIN * 2) return { available: false, version: LINE_MOVE_STUDY_VERSION, reason: `only ${all.length} archived games with a Pinnacle opener and close`, dropped: built.dropped };
  const markets = ['spreads', 'totals'];
  const headline = [];
  const featureReport = [];
  const slices = {};
  let gatePassed = [];
  for (const market of markets) {
    const data = all.filter(r => r.market === market);
    for (const upTo of DECISION_TIMES) {
      const names = featureNames(data, upTo);
      if (!names.length) continue;
      const wf = walkForward(data, names);
      const ho = holdout(data, names);
      const entry = { market, decision_time: upTo, features: names.length, clv_basis: CLV_BASIS[upTo],
        walk_forward: wf.length ? clvSummary(wf, upTo) : null,
        holdout: ho.preds.length ? clvSummary(ho.preds, upTo) : null,
        magnitude_rmse_vs_zero: ho.preds.length ? { model: r3(Math.sqrt(mean(ho.preds.map(p => (p.magnitude - p.y) ** 2)))),
          zero: r3(Math.sqrt(mean(ho.preds.map(p => p.y ** 2)))) } : null };
      headline.push(entry);
      if (upTo === 'T2' && ho.preds.length) {
        // Per-feature: bet the opener on the side that feature's training-fold coefficient implies.
        const std = standardiser(ho.train.map(r => vec(r, names)));
        const Z = ho.train.map(r => std(vec(r, names)));
        const logit = logistic(Z, ho.train.map(r => (r.y_sign > 0 ? 1 : 0)), LOGIT_LAMBDA);
        const perFeature = names.map((name, j) => {
          const coef = logit.beta[j + 1];
          const preds = ho.preds.map(p => { const z = std(vec(p.row, names))[j]; const side = sign(coef * z) || 1;
            return { ...p, side, p_home: side > 0 ? 0.5 + Math.min(0.49, Math.abs(coef * z) / 4) : 0.5 - Math.min(0.49, Math.abs(coef * z) / 4) }; });
          const knownAt = name.split(':')[0];
          const summary = clvSummary(preds, knownAt);
          return { market, name, known_at: knownAt, coefficient: r4(coef), ...summary };
        });
        const adjusted = holm(perFeature.map(f => f.p_clv_le_zero ?? 1));
        perFeature.forEach((f, i) => { f.p_holm = r4(adjusted[i]); });
        featureReport.push(...perFeature.sort((a, b) => (b.mean_clv ?? -9) - (a.mean_clv ?? -9)));
        const sliceOf = (label, fn) => { const sub = ho.preds.filter(fn); return { slice: label, n: sub.length, readable: sub.length >= MIN_SLICE, ...(sub.length ? clvSummary(sub) : {}) }; };
        slices[market] = [
          sliceOf('favourite ≤ 3', p => market === 'spreads' && Math.abs(p.row.open) <= 3),
          sliceOf('favourite 3.5–7', p => market === 'spreads' && Math.abs(p.row.open) > 3 && Math.abs(p.row.open) <= 7),
          sliceOf('favourite > 7', p => market === 'spreads' && Math.abs(p.row.open) > 7),
          sliceOf('primetime', p => p.row.features.T0.primetime === 1),
          sliceOf('daytime', p => p.row.features.T0.primetime === 0),
          sliceOf('crossed a key number', p => p.row.key_cross === 1),
          sliceOf('did not cross a key', p => p.row.key_cross === 0)
        ].filter(s => s.n > 0);
      }
    }
  }
  // Gate: a single decision time whose holdout mean CLV clears the bar with an interval above zero on enough games.
  gatePassed = headline.filter(h => h.holdout && h.holdout.n >= GATE_MIN_GAMES && h.holdout.mean_clv >= CLV_GATE_POINTS && h.holdout.clv_interval[0] > 0)
    .map(h => ({ market: h.market, decision_time: h.decision_time, mean_clv: h.holdout.mean_clv, interval: h.holdout.clv_interval, n: h.holdout.n }));
  const passingFeatures = featureReport.filter(f => f.n >= GATE_MIN_GAMES && f.mean_clv >= CLV_GATE_POINTS && f.clv_interval[0] > 0 && f.p_holm < 0.05);
  // Secondary: what CLV was worth in units, spreads only, predicted side at the opener vs at the close (-110 both).
  const units = (() => {
    const entry = headline.find(h => h.market === 'spreads' && h.decision_time === 'T0');
    if (!entry?.holdout) return null;
    const data = all.filter(r => r.market === 'spreads');
    const names = featureNames(data, 'T0');
    const ho = holdout(data, names);
    const grade = (p, line) => { const cover = p.side > 0 ? p.row.actual_margin + line : -(p.row.actual_margin + line); return cover > 0 ? 0.909 : cover < 0 ? -1 : 0; };
    return { n: ho.preds.length, units_at_opener: r3(ho.preds.reduce((s, p) => s + grade(p, p.row.open), 0)),
      units_at_close: r3(ho.preds.reduce((s, p) => s + grade(p, p.row.close), 0)),
      note: 'what CLV was worth on this sample at -110; descriptive, not promotion evidence' };
  })();
  return { available: true, version: LINE_MOVE_STUDY_VERSION, built_at: built.built_at, seasons, holdout_from: HOLDOUT_FROM,
    dataset: { rows: all.length, spreads: all.filter(r => r.market === 'spreads').length, totals: all.filter(r => r.market === 'totals').length,
      dropped: built.dropped, ratings_line: built.ratings_line, selection_through: built.selection_through ?? null },
    headline, features: featureReport, slices, units,
    gate: { rule: `holdout mean CLV ≥ +${CLV_GATE_POINTS} points, 95% week-clustered interval above zero, ≥ ${GATE_MIN_GAMES} games, one decision time; single features also need Holm p < 0.05`,
      passed_decision_times: gatePassed, passed_features: passingFeatures.map(f => ({ market: f.market, name: f.name, mean_clv: f.mean_clv, interval: f.clv_interval, p_holm: f.p_holm, n: f.n })),
      verdict: gatePassed.length || passingFeatures.length ? 'something predicts the move; see passed lists (T1/T2 CLV is an upper bound: no line is stored at those times)' : 'nothing predicts the open-to-close move on the held-out seasons; Phase 2 is price and speed' },
    read_floor: MIN_SLICE,
    rule: 'Every feature is stamped with the decision time it was knowable at; nothing after the close enters. CLV in points is the gate; direction accuracy is context.' };
}
