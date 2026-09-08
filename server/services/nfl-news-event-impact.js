/**
 * Package E — learned market impact of a typed news event, plus the negative
 * controls that expose a hidden timing leak (NFL_RESEARCH_MASTER_PLAN §E,
 * and independent conclusion #6: a model agreeing with its own assumptions is
 * not validation — this file grounds every number in `nfl_quote_tape`, the
 * raw multi-book price tape Package A built, never in a simulator's own output).
 *
 * THE CENTRAL DISCIPLINE: every price used as evidence for a claim's impact is
 * read strictly AFTER that claim's `first_seen_time`, never at its
 * `published_at`. We do not know when this system would actually have seen a
 * story at any point before `first_seen_time` records it, so pricing the
 * reaction against publication time is exactly the leak nfl-bitemporal.js's
 * header describes ("a model trained on the latest value has read Friday's
 * report on Wednesday").
 *
 * WHAT THIS BUILDS:
 *   - reactionPairs()      the last quote at/before first_seen_time and the
 *                          first quote after it, per book/market/side
 *   - buildImpactDataset() one row per verified claim: news features, a
 *                          price-only feature computed with NO knowledge of
 *                          the claim, and the measured post-claim move
 *   - evaluateModels()     news-only vs price-only vs combined MAE against a
 *                          "no movement" baseline, on a chronological holdout
 *   - three negative controls, run against the SAME code path real claims
 *     use, not a separate "safe" path that would not catch the same bugs
 *
 * WHAT THIS DOES NOT CLAIM: an observed reaction is not proof of causation —
 * see the irrelevant-team control below, which routinely finds "reactions"
 * for a story that has nothing to do with the game whose price moved. This
 * mirrors the caveat nfl-tweet-line-correlation.js's header already states
 * for the same reason.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rows } from '../db/index.js';
import { normalizeToken } from './team-codes.js';

export const IMPACT_MODEL_VERSION = 'nfl-news-event-impact-v1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT_DIR = path.join(root, 'server/data/news-event-impact');
const MIN_ROWS_FOR_MODELING = 20;

const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const minutes = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 60000;
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const stdev = xs => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

function teamAliasMap() {
  return new Map(rows('SELECT abbr, name FROM nfl_teams').map(t => [t.abbr, normalizeToken(t.name)]));
}
function quoteMatchesTeam(quote, alias) {
  if (!alias) return false;
  return normalizeToken(quote.home_team).includes(alias) || normalizeToken(quote.away_team).includes(alias);
}

/**
 * All quotes for a claim's team, grouped by exact contract (event/book/market/
 * side), paired into the last quote at-or-before `pivotTime` ("before") and
 * the first quote strictly after it ("after"). `pivotTime` is the caller's
 * choice of clock — real usage always passes `first_seen_time`; the
 * time-shift control deliberately passes something else to show what
 * happens when that discipline is violated.
 */
export function reactionPairs(team, pivotTime, { market = 'spreads', quotes = null } = {}) {
  const alias = teamAliasMap().get(team) ?? normalizeToken(team);
  const all = quotes ?? rows(`SELECT provider_event_id, bookmaker_key, market, side_key, home_team, away_team,
      commence_time, snapshot_at, line, american_price, implied_probability
    FROM nfl_quote_tape WHERE market=? ORDER BY snapshot_at`, market);
  const eligible = all.filter(q => quoteMatchesTeam(q, alias) && new Date(q.commence_time) > new Date(pivotTime));
  const groups = new Map();
  for (const q of eligible) {
    const key = `${q.provider_event_id}|${q.bookmaker_key}|${q.market}|${q.side_key}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }
  const pairs = [];
  for (const [key, quotesForContract] of groups) {
    quotesForContract.sort((a, b) => new Date(a.snapshot_at) - new Date(b.snapshot_at));
    const before = [...quotesForContract].reverse().find(q => new Date(q.snapshot_at) <= new Date(pivotTime));
    const after = quotesForContract.find(q => new Date(q.snapshot_at) > new Date(pivotTime));
    if (!after) continue;
    const probMove = before ? +(after.implied_probability - before.implied_probability).toFixed(4) : null;
    pairs.push({ contract: key, event_id: after.provider_event_id, book: after.bookmaker_key,
      market: after.market, side: after.side_key, had_before: Boolean(before),
      minutes_pivot_to_after: +minutes(pivotTime, after.snapshot_at).toFixed(2),
      minutes_before_to_pivot: before ? +minutes(before.snapshot_at, pivotTime).toFixed(2) : null,
      prob_move: probMove, before: before ? { snapshot_at: before.snapshot_at, line: before.line,
        implied_probability: before.implied_probability } : null,
      after: { snapshot_at: after.snapshot_at, line: after.line, implied_probability: after.implied_probability } });
  }
  return pairs;
}

/**
 * A price-only feature that uses NOTHING about the claim: the standard
 * deviation of this team's own consecutive-snapshot probability changes in
 * the `lookbackHours` before `pivotTime`. A high pre-existing volatility
 * predicts a bigger next move whether or not any news arrives — the
 * "price-only" baseline below is exactly this number.
 */
export function preClaimVolatility(team, pivotTime, { market = 'spreads', lookbackHours = 72, quotes = null } = {}) {
  const alias = teamAliasMap().get(team) ?? normalizeToken(team);
  const all = quotes ?? rows(`SELECT provider_event_id, bookmaker_key, market, side_key, home_team, away_team,
      commence_time, snapshot_at, implied_probability FROM nfl_quote_tape WHERE market=? ORDER BY snapshot_at`, market);
  const since = new Date(new Date(pivotTime).getTime() - lookbackHours * 3600000).toISOString();
  const eligible = all.filter(q => quoteMatchesTeam(q, alias) && q.snapshot_at <= pivotTime && q.snapshot_at >= since);
  const groups = new Map();
  for (const q of eligible) {
    const key = `${q.provider_event_id}|${q.bookmaker_key}|${q.market}|${q.side_key}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }
  const deltas = [];
  for (const list of groups.values()) {
    list.sort((a, b) => new Date(a.snapshot_at) - new Date(b.snapshot_at));
    for (let i = 1; i < list.length; i++) deltas.push(Math.abs(list[i].implied_probability - list[i - 1].implied_probability));
  }
  const vol = deltas.length >= 2 ? stdev(deltas) : 0;
  return { n_deltas: deltas.length, volatility: +(vol ?? 0).toFixed(4) };
}

const CLAIM_TYPE_INDEX = ['injury_status', 'role_change', 'transaction', 'return_from_injury',
  'suspension', 'role_change_unconfirmed', 'other'];

/** One dataset row per verified claim with a team and an observed post-claim quote. */
export function buildImpactDataset({ market = 'spreads', minRows = MIN_ROWS_FOR_MODELING } = {}) {
  const claims = rows(`SELECT event_id, team, claim_type, certainty, novelty_score, first_seen_time, published_at
    FROM nfl_news_events WHERE team IS NOT NULL AND verification_state='verified' ORDER BY first_seen_time`);
  const quotes = rows(`SELECT provider_event_id, bookmaker_key, market, side_key, home_team, away_team,
      commence_time, snapshot_at, line, american_price, implied_probability
    FROM nfl_quote_tape WHERE market=? ORDER BY snapshot_at`, market);

  const dataRows = [];
  let skippedNoPair = 0;
  for (const claim of claims) {
    const pairs = reactionPairs(claim.team, claim.first_seen_time, { market, quotes })
      .filter(p => p.prob_move != null);
    if (!pairs.length) { skippedNoPair++; continue; }
    const fastest = pairs.reduce((a, b) => a.minutes_pivot_to_after < b.minutes_pivot_to_after ? a : b);
    const vol = preClaimVolatility(claim.team, claim.first_seen_time, { market, quotes });
    dataRows.push({
      event_id: claim.event_id, first_seen_time: claim.first_seen_time, team: claim.team,
      claim_type: claim.claim_type, certainty: claim.certainty ?? 0.5, novelty_score: claim.novelty_score ?? 1,
      pre_claim_volatility: vol.volatility, label_abs_move: Math.abs(fastest.prob_move),
      minutes_to_reaction: fastest.minutes_pivot_to_after, contract_pairs_considered: pairs.length
    });
  }
  return { schema: IMPACT_MODEL_VERSION, market, claims_considered: claims.length,
    rows: dataRows, skipped_no_quote_pair: skippedNoPair,
    insufficient_data: dataRows.length < minRows,
    min_rows_required: minRows };
}

// ---- a small, hand-rolled, unit-tested OLS so no ML dependency is needed ----

function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    if (Math.abs(M[col][col]) < 1e-12) M[col][col] = 1e-12; // singular guard, not a silent zero-fit
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Ridge-regularized OLS via normal equations. Intercept is the last coefficient. */
export function fitOLS(X, y, { ridge = 1e-6 } = {}) {
  const n = X.length, k = (X[0]?.length ?? 0) + 1;
  const Xa = X.map(row => [...row, 1]);
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += Xa[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += Xa[i][a] * Xa[i][b];
    }
  }
  for (let a = 0; a < k; a++) XtX[a][a] += ridge;
  return solveLinear(XtX, Xty);
}
export function predictOLS(beta, x) {
  return x.reduce((sum, v, i) => sum + v * beta[i], 0) + beta[beta.length - 1];
}
const mae = (yTrue, yPred) => mean(yTrue.map((y, i) => Math.abs(y - yPred[i])));

/**
 * News-only, price-only and combined comparisons on a chronological holdout
 * (train = earlier claims, test = later ones — never a random split, for the
 * same reason Package C's protocol forbids one). Reports `insufficient_data`
 * rather than fabricating a comparison below `minRows` observations.
 */
export function evaluateModels(dataset, { testFraction = 0.3 } = {}) {
  if (dataset.insufficient_data) {
    return { insufficient_data: true, rows: dataset.rows.length, min_rows_required: dataset.min_rows_required,
      verdict: `only ${dataset.rows.length} claims paired with a post-claim quote — below ${dataset.min_rows_required}; no model comparison is reportable yet` };
  }
  const sorted = [...dataset.rows].sort((a, b) => new Date(a.first_seen_time) - new Date(b.first_seen_time));
  const cut = Math.max(1, Math.floor(sorted.length * (1 - testFraction)));
  const train = sorted.slice(0, cut), test = sorted.slice(cut);
  if (!test.length) return { insufficient_data: true, verdict: 'chronological split left no test rows' };

  const yTrain = train.map(r => r.label_abs_move), yTest = test.map(r => r.label_abs_move);

  // no_move baseline: predicts zero movement, always.
  const noMove = mae(yTest, yTest.map(() => 0));

  // news-only: grouped mean of label by claim_type, learned on train only.
  const groupMeans = new Map();
  for (const claimType of CLAIM_TYPE_INDEX) {
    const inGroup = train.filter(r => r.claim_type === claimType).map(r => r.label_abs_move);
    if (inGroup.length) groupMeans.set(claimType, mean(inGroup));
  }
  const overallTrainMean = mean(yTrain) ?? 0;
  const newsOnlyPred = test.map(r => groupMeans.get(r.claim_type) ?? overallTrainMean);
  const newsOnly = mae(yTest, newsOnlyPred);

  // price-only: single-feature OLS on pre-claim volatility alone — no claim content used at all.
  const priceBeta = fitOLS(train.map(r => [r.pre_claim_volatility]), yTrain);
  const priceOnlyPred = test.map(r => predictOLS(priceBeta, [r.pre_claim_volatility]));
  const priceOnly = mae(yTest, priceOnlyPred);

  // combined: certainty + novelty + pre-claim volatility.
  const combinedBeta = fitOLS(train.map(r => [r.certainty, r.novelty_score, r.pre_claim_volatility]), yTrain);
  const combinedPred = test.map(r => predictOLS(combinedBeta, [r.certainty, r.novelty_score, r.pre_claim_volatility]));
  const combined = mae(yTest, combinedPred);

  return { insufficient_data: false, n_train: train.length, n_test: test.length,
    mae: { no_move: +noMove.toFixed(4), news_only: +newsOnly.toFixed(4),
      price_only: +priceOnly.toFixed(4), combined: +combined.toFixed(4) },
    coefficients: { price_only: priceBeta, combined: combinedBeta },
    verdict: combined < Math.min(noMove, newsOnly, priceOnly)
      ? 'combined model beats every simpler baseline on this holdout'
      : 'combined model did NOT beat every simpler baseline — report this, do not tune it away' };
}

// ---------------------------- negative controls -----------------------------

/**
 * Irrelevant-team control: measure a "reaction" for a claim reassigned to a
 * team that had nothing to do with it. A nonzero number here is not proof of
 * a bug — it is proof that "a quote moved after the claim" is not by itself
 * evidence the claim caused it, exactly the caveat nfl-tweet-line-
 * correlation.js already states. Report the number; do not suppress it.
 */
export function irrelevantTeamControl(claim, unrelatedTeam, { market = 'spreads' } = {}) {
  const pairs = reactionPairs(unrelatedTeam, claim.first_seen_time, { market })
    .filter(p => p.prob_move != null);
  const moves = pairs.map(p => Math.abs(p.prob_move));
  return { control: 'irrelevant_team', original_team: claim.team, substituted_team: unrelatedTeam,
    pivot_time: claim.first_seen_time, pairs_found: pairs.length,
    max_abs_move: moves.length ? Math.max(...moves) : null, mean_abs_move: mean(moves),
    interpretation: moves.length && Math.max(...moves) > 0
      ? 'the pairing found market movement for a team the claim never mentioned — a measured "reaction" is not proof of causation'
      : 'no post-pivot quote pair existed for the substituted team in this dataset' };
}

/**
 * Duplicate-article control: run the real extraction entry point twice over
 * the identical underlying stories. The cache must make the second pass a
 * strict no-op — zero new candidates sent to the model, zero new rows.
 * `extractOnce` is injected so this can drive either the real LLM-backed
 * extractor or a test double without this module depending on claude.js.
 */
export async function duplicateArticleControl(extractOnce, extractArgs) {
  const first = await extractOnce(extractArgs);
  const second = await extractOnce(extractArgs);
  const leak = (second.candidates ?? 0) > 0 || (second.accepted ?? 0) > 0;
  return { control: 'duplicate_article', first_pass: first, second_pass: second,
    leak, interpretation: leak
      ? 'the second identical pass still found billable candidates or created rows — the content-hash cache is not deduping'
      : 'the second identical pass found zero new candidates and created zero new rows' };
}

/**
 * Time-shifted future news control: take a real claim and pretend it was
 * first seen a full day before it was even published. Two things are
 * checked: (1) the provenance rule (`published_at <= first_seen_time`) must
 * flag this as a leak signature, since observing something before its own
 * publication is impossible; (2) what the reaction-pairing code reports when
 * fed that impossible pivot, so a silent join-on-the-wrong-clock bug would
 * show up as a nonzero, unexplainable "reaction" rather than getting caught
 * by (1) alone.
 */
export function timeShiftedFutureControl(claim, { market = 'spreads' } = {}) {
  const shiftedFirstSeen = new Date(new Date(claim.published_at).getTime() - 24 * 3600000).toISOString();
  const provenanceLeak = shiftedFirstSeen < claim.published_at; // true by construction; asserted, not assumed
  const pairs = reactionPairs(claim.team, shiftedFirstSeen, { market }).filter(p => p.prob_move != null);
  const moves = pairs.map(p => Math.abs(p.prob_move));
  return { control: 'time_shifted_future_news', real_published_at: claim.published_at,
    shifted_first_seen_time: shiftedFirstSeen, provenance_flag: provenanceLeak,
    pairs_found: pairs.length, max_abs_move: moves.length ? Math.max(...moves) : null,
    interpretation: provenanceLeak
      ? 'the shifted claim is caught by the published_at <= first_seen_time rule before it could reach the impact model'
      : 'the shift did not trigger the provenance rule — investigate before trusting timing results' };
}

/** Freeze one impact run to disk under its content hash, same convention as nfl-evidence-dataset.js. */
export function freezeImpactRun(report, { outputDir = OUTPUT_DIR } = {}) {
  const hash = sha(report);
  const dir = path.join(outputDir, hash);
  if (fs.existsSync(path.join(dir, 'manifest.json'))) return { existing: true, run_hash: hash, dir };
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { ...report, run_hash: hash, frozen_at: new Date().toISOString(), schema: IMPACT_MODEL_VERSION };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outputDir, 'latest.json'), JSON.stringify(manifest, null, 2));
  return { existing: false, run_hash: hash, dir };
}

export function latestImpactRun({ outputDir = OUTPUT_DIR } = {}) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'latest.json'), 'utf8'));
    return manifest?.schema === IMPACT_MODEL_VERSION ? manifest : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export const __test = { solveLinear, teamAliasMap, quoteMatchesTeam };
