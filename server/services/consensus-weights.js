/**
 * Inverse-variance weights for the SEASON-LONG consensus board.
 *
 * `server/routes/aggregates.js#computeConsensus()` blends three preseason
 * sources into one draft order by averaging their ordinal ranks with a
 * HAND-SET multiplier: ESPN's own ADP counts 2, FantasyFootballCalculator ADP
 * counts 1, Sleeper's search_rank counts 1. Nothing fitted that 2. It is a
 * plausible story ("ESPN's number is what the people in an ESPN draft room
 * actually see"), never a measured one.
 *
 * `gridiron-model.js`'s header states the right way to combine several
 * estimators of the same quantity: inverse-variance weighting, w ∝ 1/σ², the
 * minimum-variance unbiased combination. `fantasy-coordinator.js` already does
 * the fitted-weight version of this for the WEEKLY projection. This module is
 * the season-long attempt, built to the same discipline: walk-forward split
 * (weights fitted only on seasons < T), shrinkage toward the incumbent so a
 * thin fit cannot swing the board, per-source weight caps, and explicit
 * missingness handling.
 *
 * ── THE DATA PROBLEM, STATED UP FRONT ─────────────────────────────────────
 *
 * Two of computeConsensus()'s three sources have NO history in this app and
 * none obtainable:
 *
 *   - ESPN ADP (`espn_player_market`) — live only, one row per espn_id for the
 *     CURRENT season, overwritten on every sync. 400 rows, season 2026. There
 *     is no ESPN preseason-ADP archive to backfill from.
 *   - Sleeper `search_rank` (`player_metrics`, source 'sleeper_rank') — same
 *     shape: one live value per player, overwritten in place. Sleeper's API
 *     serves only "now"; it publishes no historical board.
 *   - FFC ADP — the one exception. FantasyFootballCalculator's public API
 *     takes a `year` parameter and really does serve past seasons' final
 *     preseason ADP (verified live 2021-2025: 157-249 players each, draft
 *     windows all closing before that season's Week 1 kickoff). That is a real
 *     per-source history, so it is ingested here (`nfl_historical_ffc_adp`).
 *
 * So a genuine three-source inverse-variance fit is NOT constructible: σ² is
 * unmeasurable for two of the three, and the 2x multiplier attaches to one of
 * the unmeasurable ones. Silently fitting weights on the one source that has
 * history and calling the result "fitted consensus weights" would be a
 * mis-fit dressed as a validation.
 *
 * ── WHAT IS ACTUALLY TESTABLE ─────────────────────────────────────────────
 *
 * The 2021-2025 audit panel already carries a second preseason source with
 * full history: FantasyPros expert consensus rank (`nfl_historical_adp`,
 * source dynastyprocess_fpecr) — the same rank docs/DRAFT_AUDIT_2021_2025.md
 * and preseason-model.js grade against. FPECR and FFC ADP are exactly the
 * pair-of-preseason-boards structure computeConsensus() faces, with five
 * seasons of realized outcomes behind both.
 *
 * So this module answers the closest question the data can answer:
 *
 *   Given two real preseason boards with measured per-position historical
 *   error, does an inverse-variance-fitted blend beat a hand-set 2:1
 *   multiplier — the same 2:1 computeConsensus() applies today?
 *
 * FPECR stands in for ESPN's rank (the weight-2 source) and FFC ADP is itself.
 * That is a SUBSTITUTION and it is why nothing here ships to the live board on
 * its own: a result about FPECR-vs-FFC is evidence about the method, not proof
 * about ESPN. It is stated as such in docs/CONSENSUS_WEIGHTS.md. What it can
 * do is settle the method question — if inverse-variance weights cannot beat a
 * hand-set multiplier even where both sources' errors ARE measurable, there is
 * no basis for replacing a multiplier whose sources' errors are not.
 *
 * ── SCORING ───────────────────────────────────────────────────────────────
 *
 * Reused wholesale from preseason-model.js, not reinvented: a source's board
 * is turned into predicted season points through `fitMarketCurve` (the
 * local-linear rank->points curve fitted on training seasons only) and graded
 * against `seasonTotals` (the play-by-play-derived PPR totals the audit
 * validated at r=0.9987 vs ESPN's own season totals). Error is |predicted -
 * actual| per player, the same quantity the preseason walk-forward reports as
 * MAE. Significance is `pairedBootstrapDiff`, clustered by NFL team within the
 * held-out season, matching draft-abstention-audit.js.
 */
import { db, rows, run } from '../db/index.js';
import { normalizePlayerName } from './player-identity.js';
import { recordSync } from './scheduler.js';
import { pairedBootstrapDiff } from './backtest-significance.js';
import {
  SKILL_POSITIONS, seasonTotals, marketBoard, fitMarketCurve, marketCurvePoints, spearman, mean
} from './preseason-model.js';

/** The seasons with both a realized outcome and both sources' preseason board. */
export const PANEL_SEASONS = Object.freeze([2021, 2022, 2023, 2024, 2025]);
/** Held-out seasons: T is graded with weights fitted only on seasons < T. */
export const TEST_SEASONS = Object.freeze([2023, 2024, 2025]);
export const FFC_ADP_SOURCE = 'ffc_adp_ppr12';

/**
 * The hand-set weights `computeConsensus()` uses today, expressed over the two
 * sources this panel can actually measure. `expert_rank` is the weight-2 slot
 * (ESPN live; FPECR in the historical stand-in), `ffc_adp` the weight-1 slot.
 */
export const HAND_SET_WEIGHTS = Object.freeze({ expert_rank: 2, ffc_adp: 1 });

export const SOURCE_IDS = Object.freeze(['expert_rank', 'ffc_adp']);

// Shrinkage and caps, same discipline as fantasy-coordinator.js: a fit gets
// only as much authority as the evidence behind it, and no single source may
// take the whole board.
//
// SHRINK_N0 is the pseudo-count in lambda = n/(n + SHRINK_N0): the fitted
// weights are blended toward the incumbent hand-set weights, so a per-position
// cell with few training rows barely moves the board. 120 is the coordinator's
// same order of magnitude (192 player-weeks) scaled to a per-position cell,
// which holds ~150-200 player-seasons across four training seasons.
const SHRINK_N0 = 120;
// No source may fall below 20% or exceed 80% of the blend. fantasy-coordinator
// caps one expert at 0.35 of a 0.8 total influence budget (44%); with two
// sources the analogous statement is that neither can be silenced and neither
// can take the board alone.
const MIN_SHARE = 0.2;
const MAX_SHARE = 0.8;
// A per-position σ² fitted on fewer than this many training rows is not a
// measurement. Those positions fall back to the hand-set weights rather than
// to a number invented from six players.
const MIN_POSITION_ROWS = 40;

const SOURCE_URL = season =>
  `https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=${season}`;

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_historical_ffc_adp (
    season INTEGER NOT NULL,
    source TEXT NOT NULL,
    player_key TEXT NOT NULL,
    name TEXT NOT NULL,
    position TEXT,
    team TEXT,
    adp REAL NOT NULL,
    adp_stdev REAL,
    times_drafted INTEGER,
    window_start TEXT,
    window_end TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (season, source, player_key)
  )
`);

/**
 * Ingest FantasyFootballCalculator's final preseason PPR ADP for each season.
 *
 * Kept in its own table rather than added to `nfl_historical_adp`, the same
 * reason historical-adp-scrapes.js keeps its tape separate: every existing
 * reader of that table (the boom/bust join, preseason-model.js#marketBoard,
 * the draft audit) treats it as "the ECR board" and would silently start
 * seeing a second, differently-shaped board interleaved into its own ordering.
 *
 * Only the LAST preseason ADP window is available from this endpoint per year
 * — that is what it serves and it is the right snapshot anyway: what the
 * market thought immediately before kickoff, matching `historical-adp.js`'s
 * own "last scrape before Week 1" rule so the two boards describe the same
 * moment.
 */
export async function syncFfcAdpHistory(seasons = PANEL_SEASONS) {
  const fetchedAt = new Date().toISOString();
  const results = [];
  try {
    for (const season of seasons) {
      const res = await fetch(SOURCE_URL(season), {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60000)
      });
      if (!res.ok) throw new Error(`${SOURCE_URL(season)} -> HTTP ${res.status}`);
      const data = await res.json();
      const players = data?.players ?? [];
      // A season whose draft window ran INTO the regular season would be
      // graded on partly-known outcomes. Refused rather than quietly used.
      const kickoffGuard = data?.meta?.end_date;

      db.exec('BEGIN IMMEDIATE');
      try {
        run(`DELETE FROM nfl_historical_ffc_adp WHERE season = ? AND source = ?`, season, FFC_ADP_SOURCE);
        const stmt = db.prepare(`INSERT OR REPLACE INTO nfl_historical_ffc_adp
          (season, source, player_key, name, position, team, adp, adp_stdev, times_drafted,
           window_start, window_end, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
        let stored = 0;
        for (const p of players) {
          const key = normalizePlayerName(p.name ?? '');
          const adp = Number(p.adp);
          if (!key || !Number.isFinite(adp)) continue;
          const pos = p.position === 'PK' ? 'K' : p.position;
          stmt.run(season, FFC_ADP_SOURCE, key, p.name, pos ?? null, p.team ?? null, adp,
            Number.isFinite(Number(p.stdev)) ? Number(p.stdev) : null,
            Number.isFinite(Number(p.times_drafted)) ? Number(p.times_drafted) : null,
            data?.meta?.start_date ?? null, kickoffGuard ?? null, fetchedAt);
          stored++;
        }
        db.exec('COMMIT');
        results.push({ season, fetched: players.length, stored, window_end: kickoffGuard ?? null });
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
  } catch (e) { recordSync('ffc_adp_history', 'error', e.message); throw e; }
  recordSync('ffc_adp_history', 'ok', { seasons: results });
  return { seasons: results };
}

export function ffcAdpCoverage() {
  return rows(`SELECT season, COUNT(*) AS players, MIN(window_start) AS window_start,
                      MAX(window_end) AS window_end
               FROM nfl_historical_ffc_adp GROUP BY season ORDER BY season`);
}

/* ============================================================ the boards */

/**
 * Both sources' boards for one season, on ONE shared player set with realized
 * outcomes attached.
 *
 * Identity resolution is not re-implemented here. `marketBoard(season)` already
 * carries the audit's validated ECR->gsis join (four roster sources, position
 * match, nflverse abbreviated-name and team tie-breaks, seven explicit
 * aliases); FFC rows are matched into it by `normalizePlayerName`, the same key
 * that join is built on. An FFC name that does not land on a board row is
 * REPORTED as unmatched, never guessed at.
 *
 * The panel is the INTERSECTION — players both sources ranked. That is the
 * only set on which a per-source error is comparable: grading FPECR on the 400
 * players FFC never listed would measure FPECR's depth, not its accuracy, and
 * would make the deeper board look worse purely for being deeper. Missingness
 * on the live board is a separate matter and is handled by computeConsensus()'s
 * own present-sources-only average, which this module does not change.
 */
export function sourceBoards(season) {
  const board = marketBoard(season);
  const byKey = new Map();
  for (const e of board) {
    if (!SKILL_POSITIONS.includes(e.position)) continue;
    const key = e.player_key ?? (e.name ? normalizePlayerName(e.name) : null);
    if (key && !byKey.has(key)) byKey.set(key, e);
  }

  const ffc = rows(`SELECT player_key, name, position, adp FROM nfl_historical_ffc_adp
                    WHERE season = ? AND source = ? ORDER BY adp ASC`, season, FFC_ADP_SOURCE);
  const totals = seasonTotals(season).players;

  const entries = [];
  let unmatched = 0;
  for (const f of ffc) {
    if (!SKILL_POSITIONS.includes(f.position)) continue;
    const e = byKey.get(f.player_key);
    if (!e) { unmatched++; continue; }
    const a = e.gsis ? totals.get(e.gsis) ?? null : null;
    entries.push({
      season, player_key: f.player_key, name: e.name, position: e.position,
      gsis: e.gsis ?? null,
      team: a?.team ?? e.team ?? null,
      expert_overall: e.market_rank,
      ffc_adp: f.adp,
      // A ranked player with no stat line played zero games. An outcome, not
      // missing data — same rule as preseason-model.js#buildSeasonRows.
      actual_points: e.gsis ? (a?.points ?? 0) : null
    });
  }

  // Ordinals within the shared panel, per source. Ranks are recomputed here
  // rather than carried over, exactly as computeConsensus() does: it converts
  // each source's raw value to an ordinal over the players it has, then
  // averages ordinals. Comparing a rank-283 against an ADP of 14.2 would be
  // comparing different units.
  const ordinal = (list, key, dir) => {
    const sorted = [...list].sort((a, b) => dir * (a[key] - b[key]));
    const m = new Map();
    sorted.forEach((e, i) => m.set(e.player_key, i + 1));
    return m;
  };
  const expertOrd = ordinal(entries, 'expert_overall', 1);
  const ffcOrd = ordinal(entries, 'ffc_adp', 1);

  const posCount = { expert_rank: {}, ffc_adp: {} };
  const byExpert = [...entries].sort((a, b) => a.expert_overall - b.expert_overall);
  const byFfc = [...entries].sort((a, b) => a.ffc_adp - b.ffc_adp);
  const posRank = { expert_rank: new Map(), ffc_adp: new Map() };
  for (const e of byExpert) {
    posCount.expert_rank[e.position] = (posCount.expert_rank[e.position] ?? 0) + 1;
    posRank.expert_rank.set(e.player_key, posCount.expert_rank[e.position]);
  }
  for (const e of byFfc) {
    posCount.ffc_adp[e.position] = (posCount.ffc_adp[e.position] ?? 0) + 1;
    posRank.ffc_adp.set(e.player_key, posCount.ffc_adp[e.position]);
  }

  const panel = entries.map(e => ({
    ...e,
    ranks: { expert_rank: expertOrd.get(e.player_key), ffc_adp: ffcOrd.get(e.player_key) },
    pos_ranks: { expert_rank: posRank.expert_rank.get(e.player_key), ffc_adp: posRank.ffc_adp.get(e.player_key) }
  }));

  return { season, panel, unmatched, ffc_rows: ffc.length, board_rows: byKey.size };
}

/* ============================================================ the fit */

/** Rows shaped for `fitMarketCurve`: one source's positional rank -> outcome. */
const curveRows = (panel, sourceId) => panel
  .filter(e => e.actual_points != null)
  .map(e => ({ position: e.position, pos_rank: e.pos_ranks[sourceId],
    actual_points: e.actual_points, actual_games: 0 }));

/**
 * Each source's own measured error, per position, on TRAINING seasons only.
 *
 * The curve is fitted on the same training rows it is then scored on, which is
 * in-sample and would flatter a source that overfits. It cannot do so here:
 * `fitMarketCurve` is a kernel smoother over positional rank with a fixed
 * bandwidth and no free parameters per source, so neither source can buy a
 * lower training error by fitting harder — the quantity being measured is how
 * much residual variance a rank from that source leaves behind, which is
 * exactly the σ² inverse-variance weighting wants.
 */
export function measureSourceErrors(trainSeasons) {
  const panel = trainSeasons.flatMap(s => sourceBoards(s).panel);
  const out = {};
  for (const sourceId of SOURCE_IDS) {
    const cr = curveRows(panel, sourceId);
    const curves = fitMarketCurve(cr, { bandwidth: 9 });
    const byPos = {};
    for (const pos of SKILL_POSITIONS) {
      const list = panel.filter(e => e.position === pos && e.actual_points != null);
      const sq = list.map(e => {
        const pred = marketCurvePoints(curves, pos, e.pos_ranks[sourceId]);
        return pred == null ? null : (pred - e.actual_points) ** 2;
      }).filter(v => v != null);
      byPos[pos] = { n: sq.length, variance: sq.length ? mean(sq) : null,
        rmse: sq.length ? Math.sqrt(mean(sq)) : null };
    }
    out[sourceId] = { by_position: byPos, curves };
  }
  return { errors: out, train_rows: panel.length, train_seasons: [...trainSeasons] };
}

/**
 * Inverse-variance weights per position, shrunk toward the hand-set weights
 * and capped.
 *
 * w_s ∝ 1/σ²_s is the minimum-variance combination when the estimators are
 * unbiased and independent. Neither holds exactly here (two preseason boards
 * read the same news and share most of the same bias), which is precisely why
 * the result is shrunk and capped rather than trusted raw: correlated sources
 * make the raw inverse-variance solution over-confident in whichever one
 * happens to have measured slightly lower error.
 */
export function fitInverseVarianceWeights(trainSeasons) {
  const measured = measureSourceErrors(trainSeasons);
  const handSum = SOURCE_IDS.reduce((s, id) => s + HAND_SET_WEIGHTS[id], 0);
  const handShare = Object.fromEntries(SOURCE_IDS.map(id => [id, HAND_SET_WEIGHTS[id] / handSum]));

  const weights = {};
  for (const pos of SKILL_POSITIONS) {
    const cells = SOURCE_IDS.map(id => ({ id, ...measured.errors[id].by_position[pos] }));
    const usable = cells.every(c => c.n >= MIN_POSITION_ROWS && c.variance > 0);
    if (!usable) {
      weights[pos] = { ...handShare, fitted: false, n: Math.min(...cells.map(c => c.n)),
        reason: `fewer than ${MIN_POSITION_ROWS} training rows or no measurable variance — held at hand-set weights` };
      continue;
    }
    const inv = Object.fromEntries(cells.map(c => [c.id, 1 / c.variance]));
    const invSum = SOURCE_IDS.reduce((s, id) => s + inv[id], 0);
    const n = Math.min(...cells.map(c => c.n));
    const lambda = n / (n + SHRINK_N0);
    const share = {};
    for (const id of SOURCE_IDS) {
      const raw = inv[id] / invSum;
      share[id] = lambda * raw + (1 - lambda) * handShare[id];
    }
    // Cap, then renormalize so the shares still sum to 1.
    for (const id of SOURCE_IDS) share[id] = Math.max(MIN_SHARE, Math.min(MAX_SHARE, share[id]));
    const capSum = SOURCE_IDS.reduce((s, id) => s + share[id], 0);
    for (const id of SOURCE_IDS) share[id] /= capSum;
    weights[pos] = { ...share, fitted: true, lambda: +lambda.toFixed(3), n,
      rmse: Object.fromEntries(cells.map(c => [c.id, c.rmse == null ? null : +c.rmse.toFixed(2)])),
      reason: null };
  }
  return { weights, hand_set_share: handShare, measured_rows: measured.train_rows,
    train_seasons: measured.train_seasons,
    safeguards: { shrink_pseudo_count: SHRINK_N0, min_share: MIN_SHARE, max_share: MAX_SHARE,
      min_position_rows: MIN_POSITION_ROWS } };
}

/**
 * One weighted consensus ordering of a season's panel.
 *
 * `weightsFor(position)` returns the per-source shares. The blend is the same
 * arithmetic computeConsensus() performs — a weighted mean of each source's
 * ordinal rank — with the weights allowed to vary by position, which is the
 * whole point: a source can be much better at WR than at QB and pooling hides
 * it.
 */
export function consensusOrder(panel, weightsFor) {
  const scored = panel.map(e => {
    const w = weightsFor(e.position);
    let sum = 0, wsum = 0;
    for (const id of SOURCE_IDS) {
      const rank = e.ranks[id];
      if (!Number.isFinite(rank)) continue;
      sum += rank * w[id]; wsum += w[id];
    }
    return { ...e, consensus: wsum ? sum / wsum : null };
  }).filter(e => e.consensus != null).sort((a, b) => a.consensus - b.consensus);

  const posCount = {};
  return scored.map((e, i) => {
    posCount[e.position] = (posCount[e.position] ?? 0) + 1;
    return { ...e, consensus_overall: i + 1, consensus_pos_rank: posCount[e.position] };
  });
}

/**
 * Walk-forward comparison: fitted inverse-variance weights vs the hand-set
 * multiplier, on held-out seasons.
 *
 * For each T in `testSeasons`, weights AND the grading curve are fitted only on
 * seasons < T, then both consensus orderings for T are turned into predicted
 * points through that curve and graded against realized totals. Errors are
 * paired per player (identical player set for both, by construction), and the
 * bootstrap resamples whole NFL teams: players in the same offense share a
 * quarterback, a play-caller and a target pool, so they are not independent
 * draws.
 *
 * TWO GRADINGS, AND WHY BOTH ARE REPORTED. `own_curve` refits the rank->points
 * curve on each candidate's own training ordering, which treats a candidate as
 * a whole system. `fixed_curve` grades every candidate through the INCUMBENT's
 * curve, so only the ordering differs.
 *
 * They disagree, and the disagreement is the most useful thing this harness
 * found. Under `own_curve`, several mutually contradictory alternatives to the
 * hand-set 2:1 all come out "significantly better" — equal weighting, an
 * FFC-heavy 1:2, AND expert-only 1:0. Those cannot all be right; a weighting
 * cannot be improved by moving in both directions at once. Under `fixed_curve`
 * every one of them collapses into the noise band. The apparent significance
 * was the curve REFIT moving the MAE, not the board order. `fixed_curve` is
 * therefore the decision, and `own_curve` is kept only so the artifact stays
 * visible instead of being quietly dropped.
 */
export function consensusWeightsWalkForward({
  panelSeasons = PANEL_SEASONS, testSeasons = TEST_SEASONS, iterations = 2000
} = {}) {
  const results = [];
  for (const testSeason of testSeasons) {
    const train = panelSeasons.filter(s => s < testSeason);
    if (train.length < 2) { results.push({ test_season: testSeason, skipped: true, reason: 'fewer than 2 training seasons' }); continue; }

    const fit = fitInverseVarianceWeights(train);
    const trainPanel = train.flatMap(s => sourceBoards(s).panel);
    const handFor = () => fit.hand_set_share;
    const fitFor = pos => fit.weights[pos] ?? fit.hand_set_share;

    // Both grading curves are fitted on the TRAINING seasons' own consensus
    // ordering under the corresponding weights — the curve is part of the
    // candidate, so each candidate is graded through its own.
    const handCurves = fitMarketCurve(curveRowsFromConsensus(consensusOrder(trainPanel, handFor)), { bandwidth: 9 });
    const fitCurves = fitMarketCurve(curveRowsFromConsensus(consensusOrder(trainPanel, fitFor)), { bandwidth: 9 });

    const testPanel = sourceBoards(testSeason).panel.filter(e => e.actual_points != null);
    if (testPanel.length < 10) { results.push({ test_season: testSeason, skipped: true, reason: `too few graded test rows (${testPanel.length})` }); continue; }

    const handOrder = consensusOrder(testPanel, handFor);
    const fitOrder = consensusOrder(testPanel, fitFor);
    const fitByKey = new Map(fitOrder.map(e => [e.player_key, e]));

    const err = { own_curve: { hand: [], fit: [] }, fixed_curve: { hand: [], fit: [] } };
    const groups = [], handRank = [], fitRank = [], actual = [];
    for (const e of handOrder) {
      const f = fitByKey.get(e.player_key);
      if (!f) continue;
      const ph = marketCurvePoints(handCurves, e.position, e.consensus_pos_rank);
      const pf = marketCurvePoints(fitCurves, f.position, f.consensus_pos_rank);
      // The fixed-curve arm grades BOTH orderings through the incumbent's
      // curve, so the only thing that differs between the arms is the board.
      const pfFixed = marketCurvePoints(handCurves, f.position, f.consensus_pos_rank);
      if (ph == null || pf == null || pfFixed == null) continue;
      err.own_curve.hand.push(Math.abs(ph - e.actual_points));
      err.own_curve.fit.push(Math.abs(pf - e.actual_points));
      err.fixed_curve.hand.push(Math.abs(ph - e.actual_points));
      err.fixed_curve.fit.push(Math.abs(pfFixed - e.actual_points));
      groups.push(e.team ?? e.player_key);
      handRank.push(e.consensus_overall);
      fitRank.push(f.consensus_overall);
      actual.push(e.actual_points);
    }

    const arm = pair => {
      const gate = pairedBootstrapDiff(pair.hand, pair.fit, { iterations, seed: 17, groups });
      return {
        hand_set_mae: +mean(pair.hand).toFixed(3), fitted_mae: +mean(pair.fit).toFixed(3),
        significant_improvement: !gate.error && gate.significant && gate.ci90[1] < 0,
        significant_regression: !gate.error && gate.significant && gate.ci90[0] > 0,
        p_value: gate.error ? null : Math.max(1 / (gate.iterations + 1), 1 - gate.p_b_better),
        gate
      };
    };
    const fixedCurve = arm(err.fixed_curve);
    results.push({
      test_season: testSeason, train_seasons: train, n: err.fixed_curve.hand.length,
      weights: fit.weights, hand_set_share: fit.hand_set_share,
      // The decision arm. Promoted to the top level because it is what the
      // >=2-of-3 bar is read off.
      ...fixedCurve,
      own_curve: arm(err.own_curve),
      // Descriptive only — Spearman is not a per-unit quantity and cannot be
      // bootstrapped by this gate. The MAE bootstrap is the decision.
      hand_set_spearman: +(-spearman(handRank, actual)).toFixed(4),
      fitted_spearman: +(-spearman(fitRank, actual)).toFixed(4),
      // How much the board actually moves when the weights change at all. When
      // this is a couple of slots, no weighting scheme can matter much.
      mean_rank_shift: +mean(handRank.map((r, i) => Math.abs(r - fitRank[i]))).toFixed(2),
      max_rank_shift: Math.max(...handRank.map((r, i) => Math.abs(r - fitRank[i])))
    });
  }

  const graded = results.filter(r => !r.skipped);
  const wins = graded.filter(r => r.significant_improvement).length;
  return {
    results,
    bar: 'significant MAE improvement (fixed-curve arm) in >= 2 of 3 held-out seasons to replace the hand-set weights',
    board_agreement: panelSeasons.map(s => {
      const p = sourceBoards(s).panel;
      return { season: s, n: p.length,
        source_rank_spearman: +spearman(p.map(e => e.ranks.expert_rank), p.map(e => e.ranks.ffc_adp)).toFixed(4) };
    }),
    seasons_significantly_better: wins,
    seasons_significantly_worse: graded.filter(r => r.significant_regression).length,
    decision: wins >= 2 ? 'replace hand-set weights' : 'keep hand-set weights',
    // Never omitted: the result is about FPECR-vs-FFC, and two of
    // computeConsensus()'s three live sources have no history at all.
    substitution: 'FPECR stands in for ESPN ADP (the weight-2 source); ESPN and Sleeper have no historical coverage'
  };
}

const curveRowsFromConsensus = order => order
  .filter(e => e.actual_points != null)
  .map(e => ({ position: e.position, pos_rank: e.consensus_pos_rank,
    actual_points: e.actual_points, actual_games: 0 }));

/**
 * Which of computeConsensus()'s live sources could be fitted at all, and why
 * not. Read-only; this is the finding, not a diagnostic.
 */
export function sourceHistoryCoverage() {
  const count = sql => { try { return rows(sql)[0]?.n ?? 0; } catch { return 0; } };
  return [
    { source: 'espn_adp', live_weight: 2, historical_seasons: 0,
      live_rows: count(`SELECT COUNT(*) n FROM espn_player_market`),
      fittable: false, reason: 'espn_player_market holds one current-season row per espn_id, overwritten on every sync; ESPN publishes no preseason-ADP archive' },
    { source: 'ffc_adp', live_weight: 1,
      historical_seasons: rows(`SELECT COUNT(DISTINCT season) n FROM nfl_historical_ffc_adp`)[0]?.n ?? 0,
      live_rows: count(`SELECT COUNT(*) n FROM player_metrics WHERE source = 'ffc_adp'`),
      fittable: true, reason: null },
    { source: 'sleeper_rank', live_weight: 1, historical_seasons: 0,
      live_rows: count(`SELECT COUNT(*) n FROM player_metrics WHERE source = 'sleeper_rank'`),
      fittable: false, reason: "player_metrics holds one live search_rank per player, overwritten on every sync; Sleeper's API serves no historical board" }
  ];
}

export const __test = { curveRows, curveRowsFromConsensus, SHRINK_N0, MIN_SHARE, MAX_SHARE, MIN_POSITION_ROWS };
