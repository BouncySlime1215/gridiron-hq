/**
 * TELLS-01b: per-manager behavioural tells as NAMED clone features, a
 * walk-forward logistic fit with shrunk weights on top of the activity-only
 * baseline, and the grade of that clone by E1 (log loss vs activity-only).
 *
 * THE FEATURES, each read as of an offer's proposal time from the responder's
 * own history (offers RESOLVED strictly before it was proposed):
 *   reply_latency       log(1 + median reply hours) of the responder minus the
 *                       league's, at the same cut. Needs 2 replies.
 *   counter_style       share of the responder's declines they followed with a
 *                       proposal back to the same team within 72 h (or that ESPN
 *                       recorded as 'countered'), shrunk to the league rate,
 *                       minus the league rate.
 *   prior_accept_price  this offer's value ratio for the responder,
 *                       log((received + 1) / (given + 1)) at FantasyCalc prices
 *                       captured on or before the proposal day, minus the mean
 *                       ratio of the deals they ACCEPTED before, shrunk to 0 by
 *                       n / (n + 2). Negative: this offer pays them less than
 *                       they have taken before.
 *   chat_wants_player   the responder receives a player they talked up in chat.
 *                       UNPROVEN and never fitted: manager_player_view holds one
 *                       all-time sentiment per player, not dated per message, so
 *                       it cannot be read as of an offer without leaking later
 *                       chat into the grade. It is shown on the card, labelled.
 *
 * A missing feature is 0 in the model. Every feature is centred on a league or
 * shrunk reference, so 0 means "the activity-only baseline, unchanged" — the
 * clone never invents a direction from nothing. The CARD shows missing as
 * `unknown` with its reason, never as 0.
 *
 * THE FIT. logit p = logit(activity-only baseline) + sum w_k x_k over the three
 * graded features. The weights are an L2-penalised (prior sd 0.5 per unit)
 * logistic fit on every offer, pooled across ESPN leagues (other leagues are
 * training data only), resolved strictly before the scored offer was proposed,
 * then capped at +/- WEIGHT_CAP. Under MIN_TRAIN training offers the weights
 * are 0 and the clone equals the baseline.
 *
 * THE GRADE is E1's own grader (eval/e1.js#grade) on the target league's
 * offers with the clone's p recorded as the model: same baseline, same
 * anytime-valid rule, same statuses. Nothing here reaches acceptanceBand or
 * any served P(accept); the TELLS-01 spec's trade KILL still stands.
 */
import { activityBaseline, grade as gradeE1 } from '../eval/e1.js';
import { loadLeagueOffers, priorCounts, SNAPSHOT_COLS } from '../eval/e1-league.js';
import { readSource } from '../eval/common.js';
import { logit, round } from '../eval/stats.js';

export const CLONE_FEATURES_VERSION = 1;
export const PENALTY = 4;
export const WEIGHT_CAP = 1.5;
export const MIN_TRAIN = 20;
export const COUNTER_WINDOW_MS = 72 * 3_600_000;
const H = 3_600_000;
const COUNTER_SHRINK = 3;
const PRICE_SHRINK = 2;
const CHAT_MIN_N = 2;

export const FEATURES = Object.freeze([
  { id: 'reply_latency', label: 'Reply latency', graded: true, min_n: 2,
    predicts: 'whether they say yes: slower than the league leans no',
    unit: 'log(1 + hours) vs league' },
  { id: 'counter_style', label: 'Counters after a no', graded: true, min_n: 3,
    predicts: 'whether they say yes: a counterer turns a no into talks',
    unit: 'counter rate vs league' },
  { id: 'prior_accept_price', label: 'Price they have accepted', graded: true, min_n: 1,
    predicts: 'whether they say yes: an offer below what they took before leans no',
    unit: 'log value ratio they received' },
  { id: 'chat_wants_player', label: 'Talks up a player', graded: false, min_n: CHAT_MIN_N,
    predicts: 'whether they want a player you could send',
    unit: 'players with positive chat sentiment',
    unproven_reason: 'chat sentiment is one all-time aggregate per player, not dated per message, so it cannot be graded as of an offer' },
]);
export const GRADED_FEATURES = Object.freeze(FEATURES.filter(f => f.graded).map(f => f.id));

const t = s => (s == null ? NaN : Date.parse(s));
const resolvedTime = o => (Number.isFinite(t(o.resolved_at)) ? t(o.resolved_at) : t(o.proposed_at));
const sameCp = (o, league, team) => String(o.league_id) === String(league) && String(o.counterparty_team_id) === String(team);
const median = xs => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sigmoid = z => 1 / (1 + Math.exp(-z));
const itemsKey = (league, season, txId) => `${league}:${season}:${txId}`;

/**
 * Everything the features read, indexed once. All inputs are plain rows so a
 * test can build one without a database; `input` keeps them for re-use.
 */
export function makeContext({ offers = [], proposals = [], itemsByTx = new Map(), valueHistory = new Map(),
  names = new Map(), wants = [], missing = [] } = {}) {
  const input = { offers, proposals, itemsByTx, valueHistory, names, wants, missing };
  return { input, offers, proposals, itemsByTx, valueHistory, names, wants, missing };
}

/* ------------------------------------------------------------ one tell each */

function latencyAt(ctx, league, team, cut) {
  const hours = o => (t(o.resolved_at) - t(o.proposed_at)) / H;
  const answered = ctx.offers.filter(o => String(o.league_id) === String(league)
    && Number.isFinite(t(o.resolved_at)) && t(o.resolved_at) < cut && hours(o) >= 0);
  const mine = answered.filter(o => sameCp(o, league, team)).map(hours);
  const all = answered.map(hours);
  const n = mine.length;
  if (n < 2 || all.length < 2) return { value: 0, missing: true, n, median_hours: n ? median(mine) : null };
  return { value: Math.log1p(median(mine)) - Math.log1p(median(all)), missing: false, n,
    median_hours: median(mine), league_median_hours: median(all) };
}

function counteredAfter(ctx, d, cut) {
  if (d.status === 'countered') return true;
  const from = resolvedTime(d);
  return ctx.proposals.some(p => String(p.league_id) === String(d.league_id)
    && String(p.proposer) === String(d.counterparty_team_id) && String(p.counterparty) === String(d.proposer_team_id)
    && t(p.proposed_at) > from && t(p.proposed_at) - from <= COUNTER_WINDOW_MS && t(p.proposed_at) < cut);
}

function counterAt(ctx, league, team, cut) {
  // A decline counts once its counter window has closed before the cut, or once
  // a counter was seen before it; an open window is not yet a "no counter".
  const declines = ctx.offers.filter(o => String(o.league_id) === String(league) && o.y === 0
    && resolvedTime(o) < cut && o.proposer_team_id != null);
  const judged = declines.map(d => ({ d, c: counteredAfter(ctx, d, cut) }))
    .filter(({ d, c }) => c || resolvedTime(d) + COUNTER_WINDOW_MS < cut);
  const mine = judged.filter(({ d }) => sameCp(d, league, team));
  const n = mine.length;
  const countered = mine.filter(x => x.c).length;
  if (!judged.length) return { value: 0, missing: true, n, countered };
  const g = (judged.filter(x => x.c).length + 0.5) / (judged.length + 1);
  const rate = (countered + COUNTER_SHRINK * g) / (n + COUNTER_SHRINK);
  return { value: n ? rate - g : 0, missing: n === 0, n, countered, rate, league_rate: g };
}

/** Price of one ESPN player on or before `day` (YYYY-MM-DD), or null. */
function priceOn(ctx, espnId, day) {
  const hist = ctx.valueHistory.get(String(espnId));
  if (!hist) return null;
  let best = null;
  for (const h of hist) if (h.on <= day && Number.isFinite(h.value)) best = h.value;
  return best;
}

/** The responder's log value ratio for an offer, or null when any piece is unpriced. */
export function valueRatio(ctx, o) {
  const items = ctx.itemsByTx.get(itemsKey(o.league_id, o.season, o.espn_tx_id));
  if (!Array.isArray(items) || !items.length) return null;
  const day = String(o.proposed_at).slice(0, 10);
  const team = String(o.counterparty_team_id);
  let got = 0; let gave = 0;
  for (const it of items) {
    if (it?.playerId == null) return null;
    const v = priceOn(ctx, it.playerId, day);
    if (v == null) return null;
    if (String(it.toTeamId) === team) got += v;
    else if (String(it.fromTeamId) === team) gave += v;
  }
  return Math.log((got + 1) / (gave + 1));
}

function acceptedPriceAt(ctx, league, team, cut) {
  const ratios = ctx.offers.filter(o => sameCp(o, league, team) && o.y === 1 && resolvedTime(o) < cut)
    .map(o => valueRatio(ctx, o)).filter(r => r != null);
  const n = ratios.length;
  return { n, shrunk: n ? ratios.reduce((a, b) => a + b, 0) / (n + PRICE_SHRINK) : null };
}

function priceAt(ctx, o, cut) {
  const prior = acceptedPriceAt(ctx, o.league_id, o.counterparty_team_id, cut);
  const now = valueRatio(ctx, o);
  if (!prior.n || now == null) return { value: 0, missing: true, n: prior.n, accepted_ratio: prior.shrunk };
  return { value: now - prior.shrunk, missing: false, n: prior.n, accepted_ratio: prior.shrunk, offer_ratio: now };
}

function wantsAt(ctx, league, team, cut) {
  return ctx.wants.filter(w => String(w.league_id) === String(league) && String(w.roster_id) === String(team)
    && Number(w.sentiment) > 0 && Number(w.n) >= CHAT_MIN_N && t(w.last_mention) < cut);
}

function chatAt(ctx, o, cut) {
  const liked = wantsAt(ctx, o.league_id, o.counterparty_team_id, cut);
  if (!ctx.wants.some(w => String(w.league_id) === String(o.league_id) && String(w.roster_id) === String(o.counterparty_team_id))) {
    return { value: 0, missing: true, n: 0 };
  }
  const items = ctx.itemsByTx.get(itemsKey(o.league_id, o.season, o.espn_tx_id)) ?? [];
  const names = new Set(liked.map(w => String(w.player_name).toLowerCase()));
  const hit = items.some(it => String(it?.toTeamId) === String(o.counterparty_team_id)
    && names.has(String(ctx.names.get(String(it.playerId)) ?? '').toLowerCase()));
  return { value: hit ? 1 : 0, missing: false, n: liked.reduce((a, w) => a + Number(w.n), 0) };
}

/** Every named feature for one offer, as of its proposal time. */
export function featuresAsOf(o, ctx) {
  const cut = t(o.proposed_at);
  return {
    reply_latency: latencyAt(ctx, o.league_id, o.counterparty_team_id, cut),
    counter_style: counterAt(ctx, o.league_id, o.counterparty_team_id, cut),
    prior_accept_price: priceAt(ctx, o, cut),
    chat_wants_player: chatAt(ctx, o, cut),
  };
}

/* ------------------------------------------------------------------ the fit */

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r += 1) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k += 1) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * Penalised logistic regression with a fixed offset, by Newton. Rows are
 * `{x: number[], offset, y}`. The penalty (1 / prior variance) is what
 * shrinks each weight toward 0; the cap bounds what one tell can move.
 */
export function fitWeights(rows, { penalty = PENALTY, cap = WEIGHT_CAP, minTrain = MIN_TRAIN } = {}) {
  const k = GRADED_FEATURES.length;
  if (rows.length < minTrain) {
    return { weights: new Array(k).fill(0), n: rows.length, reason: `fewer than ${minTrain} resolved offers to fit on (${rows.length})` };
  }
  let w = new Array(k).fill(0);
  for (let iter = 0; iter < 50; iter += 1) {
    const g = w.map(wi => -penalty * wi);
    const Hm = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (__, j) => (i === j ? penalty : 0)));
    for (const r of rows) {
      const p = sigmoid(r.offset + r.x.reduce((a, xi, i) => a + xi * w[i], 0));
      const v = p * (1 - p);
      for (let i = 0; i < k; i += 1) {
        g[i] += (r.y - p) * r.x[i];
        for (let j = 0; j < k; j += 1) Hm[i][j] += v * r.x[i] * r.x[j];
      }
    }
    const step = solve(Hm, g);
    w = w.map((wi, i) => wi + step[i]);
    if (step.every(s => Math.abs(s) < 1e-10)) break;
  }
  return { weights: w.map(wi => Math.max(-cap, Math.min(cap, wi)) + 0), n: rows.length, reason: null };
}

/** Activity-only baseline per offer, computed league by league exactly as E1 does. */
function baselines(offers) {
  const out = new Map();
  const byLeague = new Map();
  for (const o of offers) (byLeague.get(String(o.league_id)) ?? byLeague.set(String(o.league_id), []).get(String(o.league_id))).push(o);
  for (const list of byLeague.values()) {
    const b = activityBaseline(list, priorCounts(list));
    list.forEach((o, i) => out.set(o, b[i]));
  }
  return out;
}

const vector = f => GRADED_FEATURES.map(id => (f[id].missing ? 0 : f[id].value));

/**
 * The clone's p for every offer, walk-forward: features as of the offer, and
 * weights fitted only on offers resolved before it was proposed. Input order.
 */
export function cloneScores(offers, ctx) {
  const base = baselines(offers);
  const rows = offers.map(o => {
    const f = featuresAsOf(o, ctx);
    return { o, f, x: vector(f), offset: logit(base.get(o)), baseline: base.get(o), y: o.y };
  });
  return rows.map(r => {
    const cut = t(r.o.proposed_at);
    const fit = fitWeights(rows.filter(q => q !== r && resolvedTime(q.o) < cut));
    const z = r.offset + r.x.reduce((a, xi, i) => a + xi * fit.weights[i], 0);
    return { ...r.o, p: sigmoid(z), baseline: r.baseline, features: r.f, weights: fit.weights, n_train: fit.n };
  });
}

/**
 * E1 on the target league, twice on the same offers: the clone (tells on top
 * of activity-only) and the production replay (acceptanceBand as of then).
 */
export function gradeClone(offers, ctx, { leagueId, excluded = null, sources = null, reason = null } = {}) {
  const scored = cloneScores(offers, ctx);
  const target = scored.filter(o => String(o.league_id) === String(leagueId));
  const strip = ({ features, weights, n_train, baseline, p, ...o }) => o;
  const clone = gradeE1(target.map(o => ({ ...strip(o), model_p_accept: o.p })),
    { alreadyMerged: true, excluded, sources, reason });
  const production = gradeE1(target.map(o => strip(o)), { alreadyMerged: true, excluded, sources, reason });
  return { league_id: Number(leagueId), version: CLONE_FEATURES_VERSION, features: GRADED_FEATURES,
    terms_sources: termsCount(target), clone, production };
}

/* ------------------------------------------------------------------ the card */

const statusFor = (spec, n) => (n === 0 ? 'unknown' : n < spec.min_n ? 'thin' : 'measured');

/** One manager's tells as of `asOf`, each with n, direction, evidence and a reason chain. */
function managerTells(ctx, league, team, cut, asOf, fit, e1) {
  const specs = Object.fromEntries(FEATURES.map(f => [f.id, f]));
  const evidence = {
    e1_status: e1?.status ?? 'not_graded', e1_metric: e1?.metric ?? null,
    e1_ci: e1 && e1.ci_low != null ? [e1.ci_low, e1.ci_high] : null, e1_n: e1?.n ?? 0,
    e1_needs: e1?.needs_text ?? null, fit_n: fit.n, fit_reason: fit.reason,
  };
  const weightOf = id => fit.weights[GRADED_FEATURES.indexOf(id)];
  const entry = (id, m, extra = {}) => {
    const spec = specs[id];
    const status = spec.graded ? statusFor(spec, m.n) : (m.n === 0 ? 'unknown' : 'unproven');
    const shown = status === 'unknown' ? null : m.value;
    const w = spec.graded ? round(weightOf(id), 4) : null;
    const delta = spec.graded && shown != null ? round(w * shown, 4) : null;
    return {
      id, label: spec.label, predicts: spec.predicts, unit: spec.unit, graded: spec.graded,
      status, value: shown == null ? null : round(shown, 4), n: m.n, weight: w,
      direction: delta == null || delta === 0 ? 'none' : delta > 0 ? 'toward yes' : 'toward no',
      reason: status === 'unknown' ? (m.reason ?? `no ${spec.label.toLowerCase()} history before ${asOf}`)
        : spec.graded ? null : spec.unproven_reason,
      as_of: asOf, evidence,
      reason_chain: { contributions: delta == null ? [] : [{ source: `tells.${id}`, delta, text: `${spec.label}: ${round(shown, 3)} x weight ${w}` }] },
      ...extra,
    };
  };

  const lat = latencyAt(ctx, league, team, cut);
  const cnt = counterAt(ctx, league, team, cut);
  const price = acceptedPriceAt(ctx, league, team, cut);
  const liked = wantsAt(ctx, league, team, cut);
  return [
    entry('reply_latency', { ...lat, value: lat.missing ? null : lat.value },
      { median_hours: lat.median_hours == null ? null : round(lat.median_hours, 1) }),
    entry('counter_style', { ...cnt, value: cnt.missing ? null : cnt.value }, { countered: cnt.countered }),
    // On the card the price tell is the manager's accepted ratio itself; the
    // model's gap needs a specific offer to compare against.
    entry('prior_accept_price', { n: price.n, value: price.shrunk }),
    entry('chat_wants_player', { n: liked.reduce((a, w) => a + Number(w.n), 0), value: liked.length,
      reason: 'no dated chat read for this manager' },
    { players: liked.sort((a, b) => b.sentiment - a.sentiment).slice(0, 3).map(w => w.player_name) }),
  ];
}

/**
 * The Trade Brain tells card for one league: every team seen in its offers or
 * chat reads, with the weights fitted on every offer resolved before `asOf`.
 */
export function tellsCard(ctx, { leagueId, asOf = new Date().toISOString(), grade = null } = {}) {
  const cut = t(asOf);
  const base = baselines(ctx.offers);
  const train = ctx.offers.filter(o => resolvedTime(o) < cut)
    .map(o => ({ x: vector(featuresAsOf(o, ctx)), offset: logit(base.get(o)), y: o.y }));
  const fit = fitWeights(train);
  const teams = new Set();
  for (const o of ctx.offers) {
    if (String(o.league_id) !== String(leagueId)) continue;
    if (o.counterparty_team_id != null) teams.add(String(o.counterparty_team_id));
    if (o.proposer_team_id != null) teams.add(String(o.proposer_team_id));
  }
  for (const w of ctx.wants) if (String(w.league_id) === String(leagueId)) teams.add(String(w.roster_id));
  const e1 = grade?.clone ?? null;
  const managers = [...teams].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))
    .map(team => ({ team_id: team, tells: managerTells(ctx, leagueId, team, cut, asOf, fit, e1) }));
  return {
    league_id: Number(leagueId), as_of: asOf, version: CLONE_FEATURES_VERSION,
    weights: Object.fromEntries(GRADED_FEATURES.map((id, i) => [id, round(fit.weights[i], 4)])),
    fit_n: fit.n, fit_reason: fit.reason, missing_sources: ctx.missing,
    // Which table each league offer's terms were read from (snapshot first).
    terms_sources: termsCount(ctx.offers.filter(o => String(o.league_id) === String(leagueId))), managers,
  };
}

/* ------------------------------------------------------------------ loading */

const RAW_COLS = ['league_id', 'season', 'tx_id', 'type', 'execution_type', 'team_id', 'proposed_at', 'items_json'];

/** How many offers took their terms from each table ('none': unpriced). */
export function termsCount(offers) {
  const out = {};
  for (const o of offers) {
    const from = o.terms_source ?? 'none';
    out[from] = (out[from] ?? 0) + 1;
  }
  return out;
}

function parseItems(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : null;
  } catch {
    return null; // an unreadable proposal is unpriced; valueRatio() then returns null for it
  }
}

/**
 * Everything from the app DB. Missing optional sources are listed, never thrown.
 *
 * OFFER TERMS come from `trade_proposal_snapshots` (#247, migration 084) first
 * and from `league_transactions_raw.items_json` only when no snapshot exists
 * for that proposal: the raw upsert overwrites items_json on every sighting,
 * the snapshot keeps the terms as first seen. `termsSource` maps each proposal
 * to the table its terms came from; each offer carries it as `terms_source`
 * (null: no terms anywhere, so the offer is unpriced).
 */
export function loadCloneContext(database) {
  const { offers: loaded, excluded, sources, reason, terms_sources: offerTerms = null } = loadLeagueOffers(database);
  const missing = [];
  const proposals = [];
  const itemsByTx = new Map();
  const termsSource = new Map();
  const addProposal = (r, items, from) => {
    const k = itemsKey(r.league_id, r.season, r.tx_id);
    if (itemsByTx.has(k)) return;
    itemsByTx.set(k, items);
    termsSource.set(k, from);
    const others = [...new Set(items.flatMap(i => [i?.fromTeamId, i?.toTeamId])
      .filter(x => x != null && Number(x) > 0).map(String))].filter(x => x !== String(r.team_id));
    if (r.team_id != null && others.length === 1) {
      proposals.push({ league_id: r.league_id, proposer: String(r.team_id), counterparty: others[0], proposed_at: r.proposed_at });
    }
  };
  const snaps = readSource(database, 'trade_proposal_snapshots', SNAPSHOT_COLS);
  if (snaps.ok) {
    for (const sn of snaps.rows) {
      const items = parseItems(sn.items_json);
      if (items?.length) {
        addProposal({ league_id: sn.league_id, season: sn.season, tx_id: sn.proposal_tx_id, team_id: sn.proposer_team_id,
          proposed_at: sn.proposed_at }, items, 'trade_proposal_snapshots');
      }
    }
  } else missing.push(`${snaps.reason}; offer terms fall back to league_transactions_raw.items_json`);
  const raw = readSource(database, 'league_transactions_raw', RAW_COLS,
    `SELECT ${RAW_COLS.join(', ')} FROM league_transactions_raw WHERE type = 'TRADE_PROPOSAL' AND execution_type = 'EXECUTE'`);
  if (raw.ok) {
    for (const r of raw.rows) {
      const items = parseItems(r.items_json);
      if (items) addProposal(r, items, 'league_transactions_raw');
    }
  } else missing.push(raw.reason);
  const offers = loaded.map(o => ({ ...o,
    terms_source: termsSource.get(itemsKey(o.league_id, o.season, o.espn_tx_id)) ?? null }));

  const valueHistory = new Map();
  const names = new Map();
  const vh = readSource(database, 'dynasty_value_history', ['format_key', 'player_id', 'captured_on', 'value', 'redraft_value']);
  const pl = readSource(database, 'players', ['id', 'name', 'espn_id'],
    'SELECT id, name, espn_id FROM players WHERE espn_id IS NOT NULL');
  if (pl.ok) for (const p of pl.rows) names.set(String(p.espn_id), p.name);
  else missing.push(pl.reason);
  if (vh.ok && pl.ok) {
    const espnOf = new Map(pl.rows.map(p => [p.id, String(p.espn_id)]));
    const counts = new Map();
    for (const r of vh.rows) counts.set(r.format_key, (counts.get(r.format_key) ?? 0) + 1);
    const format = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    for (const r of vh.rows.filter(x => x.format_key === format).sort((a, b) => a.captured_on.localeCompare(b.captured_on))) {
      const id = espnOf.get(r.player_id);
      const v = r.redraft_value ?? r.value;
      if (id == null || v == null) continue;
      (valueHistory.get(id) ?? valueHistory.set(id, []).get(id)).push({ on: r.captured_on, value: Number(v) });
    }
  } else if (!vh.ok) missing.push(vh.reason);

  const wv = readSource(database, 'manager_player_view', ['league_id', 'roster_id', 'player_name', 'sentiment', 'n', 'last_mention']);
  if (!wv.ok) missing.push(wv.reason);

  const ctx = makeContext({ offers, proposals, itemsByTx, valueHistory, names, wants: wv.ok ? wv.rows : [], missing });
  return { ...ctx, excluded, sources, reason, terms_sources: termsCount(offers), offer_parties_from: offerTerms };
}
