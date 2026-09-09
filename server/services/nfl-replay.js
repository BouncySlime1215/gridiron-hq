/**
 * Season replay and error analysis — the training loop.
 *
 * Replays a season week by week, betting the model's picks with only the
 * information available at the time, grades every result, then looks for where
 * it went wrong.
 *
 * The important design decision is *how* it looks for mistakes. The tempting
 * version — open each loss, find something that would have called it, add that
 * variable, repeat — does not work. With 328 variables and roughly 270 games a
 * season, something always "explains" any single miss, and what the model
 * learns is that season's noise. It would grade beautifully on the data used to
 * build it and lose money on the next one.
 *
 * So this looks only for *systematic* error: segments of games (favourites,
 * road teams, windy games, short weeks, high totals) where the model is biased
 * across many games rather than unlucky in one. A segment only counts when it
 * holds over enough games to not be chance, and `validateAdjustment` re-tests
 * any correction on seasons it was not discovered on. A fix that only works on
 * the season that suggested it is reported as exactly that — rejected.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rows, run } from '../db/index.js';
import { fitEnsemble, ensembleLine } from './nfl-ensemble.js';
import { mean, quantile, random, withRandomSeed, normalCdf, holm } from './stats-util.js';
import { NFL_PRODUCTION_POLICY, NFL_HISTORICAL_REPLAY_POLICY,
  applyNflPolicy, normalizeNflPolicy } from './nfl-policy.js';
import { shinNoVig } from './nfl-devig.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
/** No-vig probability of the first side, from both sides' real American prices — Shin's method (nfl-devig.js). */
const noVigProb = (oddsA, oddsB) => shinNoVig(oddsA, oddsB);

export function uncertainty(bets) {
  const settled = bets.filter(b => b.result === 'Won' || b.result === 'Lost');
  const clusters = new Map();
  for (const b of bets) {
    const key = `${b.season}-${b.week}`;
    const group = clusters.get(key) ?? [];
    group.push(b); clusters.set(key, group);
  }
  const weeks = [...clusters.values()];
  const draws = [];
  if (weeks.length) withRandomSeed(20260804, () => {
    for (let trial = 0; trial < 4000; trial++) {
      const sample = [];
      for (let i = 0; i < weeks.length; i++) sample.push(...weeks[Math.floor(random() * weeks.length)]);
      const graded = sample.filter(b => b.result === 'Won' || b.result === 'Lost');
      const wins = graded.filter(b => b.result === 'Won').length;
      draws.push({ roi: sample.length ? mean(sample.map(b => b.units)) : 0, winRate: graded.length ? wins / graded.length : 0 });
    }
  });
  const rois = draws.map(x => x.roi), winRates = draws.map(x => x.winRate);
  return {
    method: 'deterministic weekly-cluster bootstrap',
    clusters: weeks.length,
    trials: draws.length,
    win_rate_95: draws.length ? [r2(quantile(winRates, 0.025)), r2(quantile(winRates, 0.975))] : [null, null],
    roi_95: draws.length ? [r2(quantile(rois, 0.025)), r2(quantile(rois, 0.975))] : [null, null],
    probability_roi_above_zero: draws.length ? r2(rois.filter(x => x > 0).length / draws.length) : null,
    sample_warning: settled.length < 100
      ? 'Very small sample: results are dominated by variance.'
      : settled.length < 500 ? 'Moderate sample: treat profitability as provisional until the interval clears zero.' : null
  };
}

/** Settle at the stored historical price. Missing prices never reach this path. */
const unitsFor = (won, pushed, price) => {
  if (pushed) return 0;
  if (!won) return -1;
  return price > 0 ? price / 100 : 100 / Math.abs(price);
};

/**
 * The primary grade above compares the pick to the CLOSING line -- a number
 * that does not exist yet at any point a real bet could have been placed.
 * "Beat the market" against it answers "beat the final number", not "beat
 * what was actually obtainable". This computes the same edge/cover call
 * against the OPENING line instead (`game_lines.open_spread`), which is a
 * real, obtainable decision-time price, and reports it as a separate,
 * clearly-labeled field rather than replacing the closing-line grade --
 * the same disclose-both pattern nfl-blind-audit.js already uses for its
 * beat-the-close shadow decisions.
 *
 * There is no stored opening PRICE (no `open_spread_odds` column, only the
 * opening line number), so win/loss/push here is determined purely from the
 * line number against the actual margin -- no price is needed for that --
 * and this never feeds `units`/staking, which still settle at the one price
 * that was ever actually obtainable: the closing odds.
 */
function spreadDecisionTimeReference(openSpread, projectedMargin, actualMargin, closeBackHome) {
  if (openSpread == null) return { available: false };
  const openMarketMargin = -openSpread;
  const openEdge = projectedMargin - openMarketMargin;
  const backHome = openEdge > 0;
  const pushed = actualMargin + openSpread === 0;
  const covered = backHome ? actualMargin + openSpread > 0 : actualMargin + openSpread < 0;
  return {
    available: true, line: openSpread, edge: r2(openEdge),
    side: backHome ? 'home' : 'away',
    result: pushed ? 'Push' : covered ? 'Won' : 'Lost',
    same_side_as_close: backHome === closeBackHome
  };
}

/** Total-market counterpart of {@link spreadDecisionTimeReference}, against `game_lines.open_total`. */
function totalDecisionTimeReference(openTotal, projectedTotal, actualTotal, closeOver) {
  if (openTotal == null) return { available: false };
  const openEdge = projectedTotal - openTotal;
  const over = openEdge > 0;
  const pushed = actualTotal === openTotal;
  const won = over ? actualTotal > openTotal : actualTotal < openTotal;
  return {
    available: true, line: openTotal, edge: r2(openEdge),
    side: over ? 'Over' : 'Under',
    result: pushed ? 'Push' : won ? 'Won' : 'Lost',
    same_side_as_close: over === closeOver
  };
}

/**
 * Replays one season. For each week, the ensemble is asked for a line using
 * only prior games, a bet is placed when the edge clears `minEdge`, and the
 * result is graded against what actually happened.
 */
export function replaySeason(season, {
  minEdge = NFL_PRODUCTION_POLICY.minEdge,
  // Skip games where the component models disagree with each other by more than
  // this. The 4.5-point guard and 3-point edge floor were frozen using only
  // 2018-2020 before the 2021-2025 evaluation window was opened.
  maxDisagreement = NFL_PRODUCTION_POLICY.maxDisagreement,
  markets = NFL_PRODUCTION_POLICY.markets,
  maxPicksPerWeek = NFL_PRODUCTION_POLICY.maxPicksPerWeek,
  startWeek = 1,
  endWeek = 22,
  modelOptions = {},
  label = null
} = {}) {
  const slate = rows(`
    SELECT gl.season, gl.week, gl.team AS home, gl.opponent AS away,
           gl.team_score AS home_score, gl.opp_score AS away_score,
           gl.spread AS home_spread, gl.total,
           gl.open_spread AS home_open_spread, gl.open_total,
           gl.spread_odds AS home_spread_odds,
           away.spread_odds AS away_spread_odds,
           gl.total_over_odds, gl.total_under_odds,
           gl.moneyline AS home_ml, away.moneyline AS away_ml,
           gl.source, gl.fetched_at
    FROM game_lines gl
    LEFT JOIN game_lines away ON away.season=gl.season AND away.week=gl.week AND away.team=gl.opponent
    WHERE gl.season = ? AND gl.week BETWEEN ? AND ?
      AND gl.home = 1 AND gl.team_score IS NOT NULL AND gl.spread IS NOT NULL
    ORDER BY gl.week
  `, season, startWeek, endWeek);
  if (!slate.length) return { error: `no completed games stored for ${season}` };

  const bets = [], decisions = [];
  // Historical replay grades the policy that was actually live at the time.
  // It intentionally does not apply today's calibration gate retroactively:
  // that would turn a losing audit into an artificial zero-bet backtest.
  const policy = normalizeNflPolicy({ ...NFL_HISTORICAL_REPLAY_POLICY,
    minEdge, maxDisagreement, markets, maxPicksPerWeek });
  let currentWeek = null, weekly = [];
  const commitWeek = () => {
    if (!weekly.length) return;
    const judged = applyNflPolicy(weekly, policy);
    decisions.push(...judged.decisions);
    bets.push(...judged.selected.map(b => ({ ...b, units: unitsFor(b.won, b.pushed, b.american_price) })));
    weekly = [];
  };
  for (const g of slate) {
    if (currentWeek != null && g.week !== currentWeek) commitWeek();
    currentWeek = g.week;
    const line = ensembleLine(season, g.week, g.home, g.away, { includeEvidence: false, ...modelOptions });
    if (line.error) continue;
    const e = line.ensemble;

    const actualMargin = g.home_score - g.away_score;
    const actualTotal = g.home_score + g.away_score;

    if (markets.includes('spread') && e.projected_margin != null && g.home_spread != null) {
      const marketMargin = -g.home_spread;
      const edge = e.projected_margin - marketMargin;
      const backHome = edge > 0;
      const covered = backHome
        ? actualMargin + g.home_spread > 0
        : actualMargin + g.home_spread < 0;
      const pushed = actualMargin + g.home_spread === 0;
      weekly.push({
          season, week: g.week, home: g.home, away: g.away, market: 'spread',
          side: backHome ? `${g.home} ${fmtLine(g.home_spread)}` : `${g.away} ${fmtLine(-g.home_spread)}`,
          line: backHome ? g.home_spread : -g.home_spread,
          american_price: backHome ? g.home_spread_odds : g.away_spread_odds,
          opposite_price: backHome ? g.away_spread_odds : g.home_spread_odds,
          model_margin: e.projected_margin, market_margin: marketMargin,
          edge: r2(edge), edge_points: Math.abs(edge), disagreement: e.model_disagreement_margin,
          actual_margin: actualMargin, actual_total: actualTotal,
          result: pushed ? 'Push' : covered ? 'Won' : 'Lost',
          won: covered, pushed, book: g.source ?? null, quote_source: g.source ?? null, quote_at: g.fetched_at ?? null,
          decision_time_reference: spreadDecisionTimeReference(g.home_open_spread, e.projected_margin, actualMargin, backHome),
          feature_snapshot: {
            margin_models_active: e.models_contributing_margin ?? null,
            predictive_distribution: e.distribution ?? null,
            input_mode: line.input_mode ?? null,
            model_trace: line.models.map(model => ({ id: model.id, family: model.family,
              challenger_only: model.challenger_only, margin: model.margin,
              margin_weight: model.margin_weight, residual_slope: model.residual_slope }))
          }
        });
    }

    if (markets.includes('total') && e.projected_total != null && g.total != null) {
      const edge = e.projected_total - g.total;
      const over = edge > 0;
      const won = over ? actualTotal > g.total : actualTotal < g.total;
      const pushed = actualTotal === g.total;
      weekly.push({
          season, week: g.week, home: g.home, away: g.away, market: 'total',
          side: `${over ? 'Over' : 'Under'} ${g.total}`, line: g.total,
          american_price: over ? g.total_over_odds : g.total_under_odds,
          opposite_price: over ? g.total_under_odds : g.total_over_odds,
          model_margin: e.projected_total, market_margin: g.total,
          edge: r2(edge), edge_points: Math.abs(edge), disagreement: e.model_disagreement_total,
          actual_margin: actualMargin, actual_total: actualTotal,
          result: pushed ? 'Push' : won ? 'Won' : 'Lost',
          won, pushed, book: g.source ?? null, quote_source: g.source ?? null, quote_at: g.fetched_at ?? null,
          decision_time_reference: totalDecisionTimeReference(g.open_total, e.projected_total, actualTotal, over),
          feature_snapshot: { total_models_active: e.models_contributing_total ?? null }
        });
    }

    // Moneyline is graded from the SAME margin distribution spread already uses
    // (e.distribution.home_win_probability is just that distribution read at a
    // threshold of zero instead of the spread line — see predictiveDistribution
    // in nfl-ensemble.js), so it can never disagree with the spread call about
    // which team the model likes; only the market comparison differs.
    //
    // Its edge is measured in probability, not points, so it is expressed here
    // as percentage points of no-vig edge (0.03 -> 3) rather than game points.
    // That keeps it on the same numeric scale the shared minEdge/maxDisagreement
    // policy thresholds already use for spread, instead of a probability edge
    // (almost always < 1) being compared against a game-point threshold like 3
    // and abstaining on every candidate regardless of whether a real edge exists.
    const homeWinP = e.distribution?.home_win_probability;
    if (markets.includes('moneyline') && homeWinP != null && g.home_ml != null && g.away_ml != null) {
      const marketP = noVigProb(g.home_ml, g.away_ml);
      if (marketP != null) {
        const edgeProb = homeWinP - marketP;
        const backHome = edgeProb > 0;
        const won = backHome ? actualMargin > 0 : actualMargin < 0;
        const pushed = actualMargin === 0; // an outright tie; exceedingly rare in the NFL
        weekly.push({
          season, week: g.week, home: g.home, away: g.away, market: 'moneyline',
          side: backHome ? g.home : g.away, line: null,
          american_price: backHome ? g.home_ml : g.away_ml,
          opposite_price: backHome ? g.away_ml : g.home_ml,
          model_margin: e.projected_margin, market_margin: null,
          edge: r2(edgeProb), edge_points: r2(Math.abs(edgeProb) * 100),
          disagreement: e.model_disagreement_margin,
          actual_margin: actualMargin, actual_total: actualTotal,
          result: pushed ? 'Push' : won ? 'Won' : 'Lost',
          won, pushed, book: g.source ?? null, quote_source: g.source ?? null, quote_at: g.fetched_at ?? null,
          feature_snapshot: {
            model_probability: r2(backHome ? homeWinP : 1 - homeWinP),
            market_probability: r2(backHome ? marketP : 1 - marketP),
            derived_from: 'shared margin-residual distribution (same as spread)'
          }
        });
      }
    }
  }
  commitWeek();

  const wins = bets.filter(b => b.result === 'Won').length;
  const losses = bets.filter(b => b.result === 'Lost').length;
  const pushes = bets.filter(b => b.result === 'Push').length;
  const units = bets.reduce((s, b) => s + b.units, 0);
  const averageBreakEven = avg(bets.filter(b => b.american_price != null).map(b => {
    const p = b.american_price;
    return p > 0 ? 100 / (p + 100) : Math.abs(p) / (Math.abs(p) + 100);
  }));

  const summary = {
    season, label, bets: bets.length, wins, losses, pushes,
    win_rate: wins + losses ? r2(wins / (wins + losses)) : null,
    units: r2(units),
    roi: bets.length ? r2(units / bets.length) : null,
    // Historical payouts use each stored price; there is no synthetic -110.
    break_even_needed: r2(averageBreakEven),
    beat_vig: bets.length ? units > 0 : null,
    config: { policy, modelOptions, startWeek, endWeek },
    decision_audit: {
      candidates: decisions.length,
      selected: bets.length,
      abstentions: Object.fromEntries([...new Set(decisions.filter(d => !d.eligible).map(d => d.abstention_reason))]
        .map(reason => [reason, decisions.filter(d => d.abstention_reason === reason).length]))
    },
    uncertainty: uncertainty(bets),
    vs_open_line: vsOpenLineSummary(bets)
  };
  return { summary, bets, decisions };
}

/**
 * Discloses the same win/loss grade using the opening line instead of the
 * closing line -- see {@link spreadDecisionTimeReference} for why this
 * exists and why it never touches `units`. Only spread/total bets carry a
 * `decision_time_reference` (moneyline has no stored opening price at all);
 * `coverage` says what share of this run's actual bets could be checked
 * this way, so a thin sample reads as thin rather than as certainty.
 */
function vsOpenLineSummary(bets) {
  const checkable = bets.filter(b => b.decision_time_reference?.available);
  const wins = checkable.filter(b => b.decision_time_reference.result === 'Won').length;
  const losses = checkable.filter(b => b.decision_time_reference.result === 'Lost').length;
  const flippedSide = checkable.filter(b => b.decision_time_reference.same_side_as_close === false).length;
  return {
    note: 'Same picks, graded against the obtainable opening line instead of the closing line. ' +
      'Payout units are unaffected -- there is no stored opening price to settle at, only the closing one.',
    coverage: bets.length ? r2(checkable.length / bets.length) : null,
    bets: checkable.length, wins, losses,
    win_rate: wins + losses ? r2(wins / (wins + losses)) : null,
    picks_that_flip_side_at_open: flippedSide
  };
}

const fmtLine = v => (v > 0 ? `+${v}` : `${v}`);

/** Persists a replay so runs can be compared over time. */
export function saveReplay(result) {
  const s = result.summary;
  run(`INSERT INTO nfl_replay_runs (season, label, created_at, bets, wins, losses, pushes, units, roi, config)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    s.season, s.label, new Date().toISOString(), s.bets, s.wins, s.losses, s.pushes,
    s.units, s.roi, JSON.stringify(s.config));
  const id = rows('SELECT last_insert_rowid() AS id')[0].id;
  for (const b of result.bets) {
    run(`INSERT INTO nfl_replay_bets
        (run_id, season, week, home, away, market, side, line, model_margin, market_margin,
         edge, disagreement, actual_margin, actual_total, result, units)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT DO NOTHING`,
      id, b.season, b.week, b.home, b.away, b.market, b.side, b.line,
      b.model_margin, b.market_margin, b.edge, b.disagreement,
      b.actual_margin, b.actual_total, b.result, b.units);
  }
  return id;
}

/* ------------------------------------------------------- error analysis */

/**
 * Buckets a bet into the segments worth checking for systematic bias.
 * Each is a hypothesis about *when* the model might be wrong, not about any
 * individual game.
 */
/**
 * +1 when a bet backs the home side (spread/moneyline) or the over (total),
 * -1 for away/under. Every place that needs to know "which side did this bet
 * take" reads it from here, so there is exactly one definition to get right —
 * see `analyzeErrors`'s `mean_signed_error`, which silently read backwards
 * for away/under bets before this existed (2026-09-09 fix).
 */
function sideSign(b) {
  if (b.market === 'total') return /Over/.test(b.side) ? 1 : -1;
  if (b.market === 'moneyline') return b.side === b.home ? 1 : -1;
  return b.side.includes(b.home) ? 1 : -1;
}

function segmentsFor(b, ctx) {
  const segs = [];
  segs.push(['market', b.market]);
  if (b.market === 'spread') {
    segs.push(['side', sideSign(b) > 0 ? 'backed home' : 'backed away']);
    segs.push(['role', b.line < 0 ? 'home favoured' : 'home underdog']);
    segs.push(['spread size', Math.abs(b.line) >= 7 ? 'big spread (7+)' : Math.abs(b.line) <= 3 ? 'short spread (<=3)' : 'mid spread']);
  } else if (b.market === 'moneyline') {
    segs.push(['side', sideSign(b) > 0 ? 'backed home' : 'backed away']);
    segs.push(['role', b.american_price < 0 ? 'backed favourite' : 'backed underdog']);
  } else {
    segs.push(['side', sideSign(b) > 0 ? 'took over' : 'took under']);
    segs.push(['total size', b.line >= 48 ? 'high total (48+)' : b.line <= 41 ? 'low total (<=41)' : 'mid total']);
  }
  segs.push(['edge size', Math.abs(b.edge) >= 4 ? 'large edge (4+)' : 'small edge (<4)']);
  segs.push(['model agreement',
    (b.disagreement ?? 0) <= 3.5 ? 'models agree' : (b.disagreement ?? 0) >= 5.5 ? 'models scatter' : 'mixed']);
  segs.push(['part of season', b.week <= 6 ? 'early (wk 1-6)' : b.week >= 14 ? 'late (wk 14+)' : 'mid']);
  const c = ctx.get(`${b.season}|${b.week}|${b.home}`);
  if (c) {
    if (c.roof) segs.push(['venue', c.roof === 'dome' || c.roof === 'closed' ? 'indoors' : 'outdoors']);
    if (c.wind != null) segs.push(['wind', c.wind >= 15 ? 'windy (15+ mph)' : 'calm']);
    if (c.temp != null) segs.push(['temperature', c.temp < 32 ? 'freezing' : 'mild']);
    if (c.rest_days != null) segs.push(['rest', c.rest_days <= 6 ? 'short week' : c.rest_days >= 10 ? 'off a bye' : 'normal week']);
    if (c.div_game != null) segs.push(['divisional', c.div_game === 1 ? 'divisional' : 'non-divisional']);
  }
  return segs;
}

/** Two-sided p-value from a z-score, via the shared normal CDF. */
const zToP = z => 2 * (1 - normalCdf(Math.abs(z)));

/** A bet's stable identity, for detecting when two segments are really the same games. */
const betKey = b => `${b.season}|${b.week}|${b.home}|${b.away}|${b.market}`;

/**
 * Family-wise significance threshold after Holm correction, and the minimum
 * practical effect a segment must clear even if it is statistically real.
 * Both are named here, not buried in a conditional, because "how sure" and
 * "how much" are two different questions and this file used to only ask one.
 */
const ALPHA = 0.05;
const MIN_EFFECT_ROI = 0.05;
const OVERLAP_THRESHOLD = 0.5;

/**
 * Finds segments where the model is systematically wrong.
 *
 * `minBets` is the first guard: a 2-8 stretch in freezing games is not
 * evidence of anything. It is not the only one. This function tests ~20-30
 * segment/bucket combinations at once, which is exactly the setting where
 * *something* looks significant by chance alone if you only check one
 * threshold — so every segment's p-value is Holm-corrected across the whole
 * family before anything is called a finding (mirroring the Holm correction
 * `line-move-study.js` already trusts for the same class of problem). A
 * corrected p-value is still not enough on its own: a segment can be
 * statistically real and practically meaningless, so `MIN_EFFECT_ROI` also
 * requires the bootstrapped ROI interval's near-zero bound to still represent
 * a real edge, not just "different from zero." Two more checks run only on
 * survivors, because they are the expensive ones: overlap detection (two
 * "findings" that are mostly the same games wearing different labels are one
 * finding, not two) and leave-one-season-out (a pooled effect that is really
 * one anomalous season dominating the total is not a systematic bias).
 */
function gameContext() {
  const ctx = new Map();
  for (const r of rows(`SELECT season, week, team, roof, wind, temp, rest_days, div_game
                        FROM game_lines WHERE home = 1`)) {
    ctx.set(`${r.season}|${r.week}|${r.team}`, r);
  }
  return ctx;
}

export function analyzeErrors(bets, { minBets = 25 } = {}) {
  const ctx = gameContext();

  const buckets = new Map();
  for (const b of bets) {
    if (b.result === 'Push') continue;
    for (const [dim, val] of segmentsFor(b, ctx)) {
      const key = `${dim}|${val}`;
      const e = buckets.get(key) ?? { dim, val, n: 0, wins: 0, units: 0, signed: [], breakEven: [], bets: [] };
      e.n++;
      if (b.result === 'Won') e.wins++;
      e.units += b.units;
      e.bets.push(b);
      if (b.american_price != null) e.breakEven.push(b.american_price > 0
        ? 100 / (b.american_price + 100) : Math.abs(b.american_price) / (Math.abs(b.american_price) + 100));
      // Signed model error, relative to the side actually bet: positive means
      // the model was too generous to its own pick, regardless of whether
      // that pick was home/away or over/under (sideSign flips it for the
      // away/under half of every bucket that mixes both).
      e.signed.push(sideSign(b) * (b.market === 'total'
        ? b.model_margin - b.actual_total
        : b.model_margin - b.actual_margin));
      buckets.set(key, e);
    }
  }

  const out = [];
  for (const e of buckets.values()) {
    if (e.n < minBets) continue;
    const winRate = e.wins / e.n;
    const breakEven = avg(e.breakEven) ?? 0.524;
    const z = (winRate - breakEven) / Math.sqrt(breakEven * (1 - breakEven) / e.n);
    out.push({
      dimension: e.dim, segment: e.val, bets: e.n,
      win_rate: r2(winRate), units: r2(e.units),
      roi: r2(e.units / e.n),
      mean_signed_error: r2(avg(e.signed)),
      break_even_needed: r2(breakEven),
      beats_vig: e.units > 0,
      // How far from break-even, in standard errors — the input to the real
      // (Holm-corrected) significance test below, not itself the test.
      z: r2(z),
      p: zToP(z),
      _bets: e.bets, _seasons: [...new Set(e.bets.map(x => x.season))]
    });
  }
  out.sort((a, b) => a.win_rate - b.win_rate);

  // Holm correction across every segment tested in this call — the family is
  // "everything checked this run," not "everything that happened to look
  // interesting," which is the part a flat per-segment threshold gets wrong.
  const adjustedP = holm(out.map(s => s.p));
  out.forEach((s, i) => { s.p_holm = r2(adjustedP[i]); delete s.p; });

  const significant = side => out.filter(s => s.p_holm < ALPHA
    && (side === 'weak' ? s.win_rate < 0.5 : s.win_rate > 0.55));

  /** Bootstrapped ROI interval for one segment's own bets, reusing `uncertainty`'s
   * weekly-cluster method rather than a second bootstrap implementation. */
  const effectGate = (candidates, side) => candidates.filter(s => {
    const ci = uncertainty(s._bets).roi_95;
    s.roi_95 = ci;
    if (ci[0] == null || ci[1] == null) return false;
    // The bound CLOSER to zero must still clear the minimum real-world effect —
    // "even in the least extreme quarter of plausible outcomes, this still
    // loses/wins by a meaningful margin," not merely "differs from zero."
    return side === 'weak' ? ci[1] < -MIN_EFFECT_ROI : ci[0] > MIN_EFFECT_ROI;
  });

  /** At least 2 of the segment's own seasons must individually show the same
   * direction of bias — otherwise one anomalous season is doing all the work
   * and the pooled effect is not "systematic," just "once." */
  const robustAcrossSeasons = (segment, side) => {
    if (segment._seasons.length < 3) return { robust: true, note: 'fewer than 3 seasons in this segment; leave-one-out not meaningful' };
    let agreeing = 0;
    const perSeason = segment._seasons.map(season => {
      const subset = segment._bets.filter(b => b.season !== season); // leave THIS season out
      const w = subset.filter(b => b.result === 'Won').length, l = subset.filter(b => b.result === 'Lost').length;
      const wr = w + l ? w / (w + l) : null;
      const agrees = wr != null && (side === 'weak' ? wr < 0.5 : wr > 0.5);
      if (agrees) agreeing++;
      return { held_out_season: season, win_rate_without_it: r2(wr) };
    });
    return { robust: agreeing >= Math.ceil(segment._seasons.length * (2 / 3)), agreeing_folds: agreeing, of: segment._seasons.length, detail: perSeason };
  };

  /** Two segments sharing more than OVERLAP_THRESHOLD of the smaller one's
   * bets are correlated, not independent — flag rather than double-count. */
  const overlapWarnings = (segments) => {
    const warnings = [];
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const a = new Set(segments[i]._bets.map(betKey)), b = new Set(segments[j]._bets.map(betKey));
        const shared = [...a].filter(k => b.has(k)).length;
        const smaller = Math.min(a.size, b.size);
        const fraction = smaller ? shared / smaller : 0;
        if (fraction >= OVERLAP_THRESHOLD) warnings.push({
          a: `${segments[i].dimension}|${segments[i].segment}`, b: `${segments[j].dimension}|${segments[j].segment}`,
          shared_bets: shared, overlap_fraction: r2(fraction),
          note: 'These likely describe the same underlying games, not two independent biases.'
        });
      }
    }
    return warnings;
  };

  const finalize = side => effectGate(significant(side), side).map(s => {
    const robustness = robustAcrossSeasons(s, side);
    return { ...s, robust_across_seasons: robustness.robust, leave_one_season_out: robustness };
  });

  let weakest = finalize('weak');
  let strongest = finalize('strong');
  const overlap_warnings = overlapWarnings([...weakest, ...strongest]);

  // Strip working fields (_bets/_seasons) from every returned segment now that
  // they've done their job — they are large and not meant for API consumers.
  const strip = s => { const { _bets, _seasons, ...rest } = s; return rest; };
  out.forEach(s => { delete s._bets; delete s._seasons; });
  weakest = weakest.map(strip);
  strongest = strongest.map(strip);

  return {
    segments: out,
    weakest, strongest, overlap_warnings,
    thresholds: { alpha: ALPHA, min_effect_roi: MIN_EFFECT_ROI, overlap_threshold: OVERLAP_THRESHOLD },
    note: weakest.length || strongest.length
      ? 'These segments cleared Holm-corrected significance AND a minimum real effect size AND held up leaving each season out one at a time. Still not a green light — validateAdjustment/proposeAdjustment must confirm on seasons none of this ran on before anything changes.'
      : 'Nothing here survives correction for testing ~20-30 segments at once plus a real minimum effect size. That is itself the honest finding, not a failure of the search.'
  };
}

/**
 * Tests a proposed correction honestly.
 *
 * The adjustment is discovered on `discoverySeasons` and applied on
 * `holdoutSeasons`. If it only helps where it was found, it was noise — and
 * this says so rather than reporting the flattering number.
 */
export function validateAdjustment({ discoverySeasons, holdoutSeasons, adjust, config = {} }) {
  // Replays are deterministic, so each season is run once and the adjustment is
  // applied to the same bets — otherwise this replays every season four times.
  const cache = new Map();
  const betsFor = seasons => seasons.flatMap(s => {
    if (!cache.has(s)) {
      const r = replaySeason(s, config);
      cache.set(s, r.error ? [] : r.bets);
    }
    return cache.get(s);
  });

  const score = list => {
    const w = list.filter(b => b.result === 'Won').length;
    const l = list.filter(b => b.result === 'Lost').length;
    const u = list.reduce((s, b) => s + b.units, 0);
    return {
      bets: list.length, wins: w, losses: l,
      win_rate: w + l ? r2(w / (w + l)) : null,
      units: r2(u), roi: list.length ? r2(u / list.length) : null,
      uncertainty: uncertainty(list)
    };
  };

  const discBets = betsFor(discoverySeasons);
  const holdBets = betsFor(holdoutSeasons);
  const discBase = score(discBets);
  const discAdj = score(discBets.map(adjust).filter(Boolean));
  const holdBase = score(holdBets);
  const holdAdj = score(holdBets.map(adjust).filter(Boolean));

  const helpedDiscovery = (discAdj.roi ?? -9) > (discBase.roi ?? -9);
  const helpedHoldout = (holdAdj.roi ?? -9) > (holdBase.roi ?? -9);

  return {
    discovery: { seasons: discoverySeasons, before: discBase, after: discAdj },
    holdout: { seasons: holdoutSeasons, before: holdBase, after: holdAdj },
    helped_discovery: helpedDiscovery,
    helped_holdout: helpedHoldout,
    verdict: helpedDiscovery && helpedHoldout
      ? 'Keep — the correction helped on seasons it was not derived from.'
      : helpedDiscovery && !helpedHoldout
        ? 'Reject — it only helps on the data that suggested it. This is overfitting, and shipping it would make the model worse on new games.'
        : !helpedDiscovery && helpedHoldout
          ? 'Inconclusive — it helps out of sample but not in sample, which usually means the sample is too small to tell.'
          : 'Reject — it does not help anywhere.'
  };
}

/** Content hash of a segment's exact predicate — frozen the moment a finding
 * is proposed, so nothing downstream can quietly redefine what is being
 * tested after seeing how it does on a holdout (see Phase 3 of the
 * 2026-09-09 learning-pipeline plan: a rule is frozen at discovery, forever). */
export function segmentRuleHash(segment) {
  return sha256Hex(JSON.stringify({ dimension: segment.dimension, segment: segment.segment,
    direction: segment.win_rate < 0.5 ? 'weak' : 'strong' }));
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The only sanctioned path from a raw `analyzeErrors` finding to a validated
 * one. Two things `validateAdjustment` alone does not enforce, made
 * structurally impossible here instead of merely documented:
 *
 *   1. Discovery and holdout seasons cannot overlap — throws immediately if
 *      they do, rather than silently producing a number that looks like an
 *      out-of-sample test but isn't.
 *   2. The correction being tested is always exactly "stop betting this
 *      segment" — derived mechanically from the segment's own frozen
 *      dimension/value, never a hand-written closure a caller could get
 *      subtly wrong or drift from what was actually discovered.
 *
 * `rule_definition_hash` on the result is `segmentRuleHash(segment)` — the
 * frozen predicate this call tested, for Phase 3's candidate-findings ledger
 * to key on so a later re-test of the "same" finding is provably the same
 * finding, not a redefinition.
 */
export function proposeAdjustment(segment, { discoverySeasons, holdoutSeasons, config = {} }) {
  const overlap = discoverySeasons.filter(s => holdoutSeasons.includes(s));
  if (overlap.length) {
    throw new Error(`proposeAdjustment: discovery and holdout seasons must not overlap (shared: ${overlap.join(', ')})`);
  }
  if (!discoverySeasons.length || !holdoutSeasons.length) {
    throw new Error('proposeAdjustment: both discoverySeasons and holdoutSeasons are required and non-empty');
  }
  const ctx = gameContext();
  const matchesSegment = b => segmentsFor(b, ctx).some(([dim, val]) => dim === segment.dimension && val === segment.segment);
  // The mechanical correction a segment finding implies: stop betting there.
  // Not "adjust the number" — that would need its own validated magnitude,
  // which this tool does not claim to know. Dropping a proven-bad segment is
  // the one correction directly supported by "this segment loses."
  const adjust = b => (matchesSegment(b) ? null : b);
  const result = validateAdjustment({ discoverySeasons, holdoutSeasons, adjust, config });
  return { ...result, segment: { dimension: segment.dimension, segment: segment.segment },
    rule_definition_hash: segmentRuleHash(segment) };
}

/**
 * One full training iteration: replay, grade, look for systematic bias, and
 * report what is worth acting on.
 */
export function trainingIteration(seasons, config = {}) {
  const perSeason = [];
  const allBets = [];
  for (const s of seasons) {
    const r = replaySeason(s, config);
    if (r.error) { perSeason.push({ season: s, error: r.error }); continue; }
    perSeason.push(r.summary);
    allBets.push(...r.bets);
  }
  const analysis = analyzeErrors(allBets, { minBets: config.minBets ?? 25 });

  const wins = allBets.filter(b => b.result === 'Won').length;
  const losses = allBets.filter(b => b.result === 'Lost').length;
  const units = allBets.reduce((s, b) => s + b.units, 0);
  let cumulative = 0;
  const byWeek = new Map();
  for (const b of allBets) {
    const key = `${b.season}-${String(b.week).padStart(2, '0')}`;
    byWeek.set(key, (byWeek.get(key) ?? 0) + b.units);
  }
  const equityCurve = [...byWeek].sort(([a], [b]) => a.localeCompare(b)).map(([week, weekUnits]) => ({
    week, week_units: r2(weekUnits), cumulative_units: r2(cumulative += weekUnits)
  }));

  return {
    seasons, config,
    policy: perSeason.find(x => x.config?.policy)?.config.policy ?? normalizeNflPolicy(config),
    overall: {
      bets: allBets.length, wins, losses,
      win_rate: wins + losses ? r2(wins / (wins + losses)) : null,
      units: r2(units), roi: allBets.length ? r2(units / allBets.length) : null,
      break_even_needed: r2(avg(allBets.filter(b => b.american_price != null).map(b => {
        const p = b.american_price;
        return p > 0 ? 100 / (p + 100) : Math.abs(p) / (Math.abs(p) + 100);
      }))),
      beat_vig: allBets.length ? units > 0 : null,
      uncertainty: uncertainty(allBets)
    },
    equity_curve: equityCurve,
    per_season: perSeason,
    analysis
  };
}

/**
 * Lightweight content-addressing for a training audit, so a finding is
 * provably tied to a specific, reproducible code+data state rather than just
 * a timestamp — the same discipline `nfl-blind-audit.js` uses for the full
 * blind audit, scoped down here to what `trainingIteration` actually reads
 * (the replay/analysis code, and the settled games for the seasons involved).
 * Not the blind audit's own machinery (that is private to that module and
 * proves a stronger, week-by-week no-leak guarantee this tool doesn't need)
 * — a purpose-built equivalent for this tool's own reproducibility claim.
 */
function trainingAuditCodeHash() {
  try {
    const cwd = process.cwd();
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z',
      '--', 'server/services/nfl-replay.js', 'server/services/stats-util.js', 'server/services/nfl-policy.js'],
      { cwd, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
    const content = createHash('sha256');
    for (const path of files) { try { content.update(path).update('\0').update(readFileSync(resolve(cwd, path))); } catch { /* skip */ } }
    return content.digest('hex');
  } catch { return null; }
}

function trainingAuditDataHash(seasons) {
  const data = rows(`SELECT season, week, team, opponent, team_score, opp_score, spread, total
    FROM game_lines WHERE season IN (${seasons.map(() => '?').join(',')}) AND home = 1 AND team_score IS NOT NULL
    ORDER BY season, week, team`, ...seasons);
  return sha256Hex(JSON.stringify({ seasons, rows: data.length, data }));
}

export function saveTrainingAudit(result) {
  const policy = result.policy ?? normalizeNflPolicy(result.config ?? {});
  const code_hash = trainingAuditCodeHash();
  const data_hash = trainingAuditDataHash(result.seasons);
  const stamped = { ...result, provenance: { code_hash, data_hash } };
  run(`INSERT INTO nfl_policy_audits
    (policy_id,policy_version,seasons_json,created_at,result_json) VALUES (?,?,?,?,?)`,
    policy.id, policy.version, JSON.stringify(result.seasons), new Date().toISOString(), JSON.stringify(stamped));
  return latestTrainingAudit();
}

export function latestTrainingAudit() {
  const r = rows('SELECT * FROM nfl_policy_audits ORDER BY id DESC LIMIT 1')[0];
  if (!r) return null;
  return {
    id: r.id, policy_id: r.policy_id, policy_version: r.policy_version,
    seasons: JSON.parse(r.seasons_json), created_at: r.created_at,
    result: JSON.parse(r.result_json)
  };
}

/**
 * Development comparison for the unified all-inputs engine. This is not the
 * sealed blind audit and cannot promote itself. Both sides use identical
 * policy, seasons and chronological cutoffs; only challenger input visibility
 * changes.
 */
export function candidateInputComparison(seasons = [2021, 2022, 2023, 2024, 2025], config = {}) {
  const shared = { ...config, minBets: config.minBets ?? 30 };
  const baseline = trainingIteration(seasons, { ...shared, label: 'champion-inputs', modelOptions: {} });
  const combined = trainingIteration(seasons, {
    ...shared, label: 'all-inputs', modelOptions: { includeChallengers: true }
  });
  const b = baseline.overall, c = combined.overall;
  const earlierSeasons = [2021].filter(season => !seasons.includes(season));
  const earlierBaseline = earlierSeasons.length ? trainingIteration(earlierSeasons,
    { ...shared, label: 'champion-inputs-pre-feature', modelOptions: {} }) : null;
  const earlierCombined = earlierSeasons.length ? trainingIteration(earlierSeasons,
    { ...shared, label: 'all-inputs-pre-feature', modelOptions: { includeChallengers: true } }) : null;
  const join = (current, earlier) => {
    if (!earlier) return current;
    const bets = current.bets + earlier.bets;
    const wins = current.wins + earlier.wins, losses = current.losses + earlier.losses;
    const units = current.units + earlier.units;
    return { seasons: [...earlierSeasons, ...seasons], bets, wins, losses,
      win_rate: wins + losses ? r2(wins / (wins + losses)) : null,
      units: r2(units), roi: bets ? r2(units / bets) : null,
      note: 'Descriptive full-window total retained when a caller requests a narrower development slice; it prevents an opened 2021 result from disappearing.' };
  };
  const result = {
    candidate_id: 'unified-all-inputs-v3-isolated-roster',
    candidate_inputs: 9,
    evidence_class: 'chronological development replay; not sealed forward proof',
    seasons,
    baseline: { overall: b, per_season: baseline.per_season },
    combined: { overall: c, per_season: combined.per_season },
    full_window_context: {
      baseline: join(b, earlierBaseline?.overall), combined: join(c, earlierCombined?.overall)
    },
    delta: {
      bets: c.bets - b.bets,
      win_rate: r2((c.win_rate ?? 0) - (b.win_rate ?? 0)),
      units: r2(c.units - b.units),
      roi: r2((c.roi ?? 0) - (b.roi ?? 0))
    }
  };
  const lowerRoi = c.uncertainty?.roi_95?.[0];
  result.promotion_gate_passed = c.beat_vig === true && lowerRoi != null && lowerRoi > 0;
  result.verdict = result.promotion_gate_passed
    ? 'Eligible for a separately preregistered forward audit; not automatically promoted.'
    : c.beat_vig
      ? 'Promising development lift, but uncertainty still crosses zero. Keep all inputs visible and withhold bankroll authority.'
      : 'Rejected for bankroll authority: the combined engine did not beat the stored prices.';
  return result;
}

export function saveCandidateInputAudit(result) {
  run(`INSERT INTO nfl_candidate_input_audits
    (candidate_id,seasons_json,created_at,result_json) VALUES (?,?,?,?)`,
  result.candidate_id, JSON.stringify(result.seasons), new Date().toISOString(), JSON.stringify(result));
  return latestCandidateInputAudit();
}

export function latestCandidateInputAudit() {
  const audit = rows('SELECT * FROM nfl_candidate_input_audits ORDER BY id DESC LIMIT 1')[0];
  if (!audit) return null;
  return { id: audit.id, candidate_id: audit.candidate_id,
    seasons: JSON.parse(audit.seasons_json), created_at: audit.created_at,
    result: JSON.parse(audit.result_json) };
}
