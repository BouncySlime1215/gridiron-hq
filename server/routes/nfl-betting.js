/**
 * NFL betting API: the feature catalog, prop projections, weekly totals,
 * pick reasoning, role tracking and the combined hub summary.
 */
import { Router } from 'express';
import { requireModelPermission } from '../modeling/authz.js';
import { catalog, countVariables, teamFeatureVector, playerFeatureVector, bettingTrends } from '../services/nfl-features.js';
import {
  propBoard, propAccuracy, propQuoteStatus, topTotals, ensureTotalPicks,
  gradeTotalPicks, totalPicksStanding
} from '../services/nfl-props.js';
import { explainPick, explainBoard, publicSignal } from '../services/nfl-reasoning.js';
import { rolesFor, roleTimeline, advancedCoverage, syncAllAdvanced } from '../services/nfl-advanced.js';
import { pbpCoverage, syncPbpSeason } from '../services/nfl-pbp.js';
import { boardFor, accuracy, clearNflMarketCache } from '../services/nfl-market.js';
import { standing as spreadStanding, allPickResults } from '../services/nfl-auto-picks.js';
import { usage as oddsUsage, cacheStatus } from '../services/odds-api.js';
import { standouts, reconcile } from '../services/betting-fantasy-link.js';
import { modelCatalog, ensembleWeek, ensembleLine, featureContracts, clearEnsembleCache, clearEnsembleLineCache } from '../services/nfl-ensemble.js';
import { replaySeason, trainingIteration, validateAdjustment, saveTrainingAudit, latestTrainingAudit } from '../services/nfl-replay.js';
import { shopSlate, numberDisagreement, snapshotLines, closingLineValue } from '../services/line-shopping.js';
import { recordBet, listBets, gradeClosingLineValue, clvReport, clvBySource } from '../services/nfl-clv.js';
import { sharpBoard, sharpDivergence, steamMoves, sharpScorecard } from '../services/nfl-sharp.js';
import { runIfStale } from '../services/scheduler.js';
import { stakeFor, safeStakeFor, evaluateSizing } from '../services/staking.js';
import { createExperiment, getExperiment, listExperiments, runExperimentStage, experimentProtocol } from '../services/nfl-experiments.js';
import { buildCoverCalibration, latestCoverCalibration } from '../services/nfl-cover-calibration.js';
import { capturePregameSnapshots, pregameSnapshotCoverage } from '../services/nfl-pregame.js';
import { startAiBlindReplay, aiReplayRun, aiReplayLogs, activeAiReplayRun, latestAiReplayRun } from '../services/nfl-ai-replay.js';
import { nflEvidenceCoverage, validationFirewall } from '../services/nfl-evidence.js';
import { gamePlayerAvailability, teamPlayerAvailability } from '../services/nfl-player-value.js';
import { playerHeadCatalog } from '../services/player-head-registry.js';
import { auditPlayerHeads, playerHeadAuditHistory } from '../services/player-head-validation.js';
import {
  blindAuditProtocol, blindAuditStatus, listBlindAudits,
  preregisterBlindAudit, runNextBlindAuditWeek
} from '../services/nfl-blind-audit.js';
import { weeklyLearningStatus } from '../services/weekly-learning.js';
import { tdCalibrationCatalog } from '../services/nfl-prop-calibration.js';
import { signalQualityCatalog } from '../services/model-signal-quality.js';
import { profitabilityOperations, recordTeaserPrice, teaserPriceLedger } from '../services/nfl-profitability.js';
import { reconcilePropQuoteMatches, settlePropQuotes } from '../services/nfl-prop-clv.js';
import { newsSignalCoverage, syncAiNewsSignals, syncStructuredNewsSignals, teamNewsSignals } from '../services/nfl-news-signal.js';
import { passingSpecialistAudit } from '../services/nfl-passing-specialists.js';

const r = Router();
// Mutations are split between research/training and live operational execution.
// A training grant must not authorize spending API/AI resources, locking picks,
// or writing/grading bets.
const trainingMutation = /^(\/replay\/train|\/calibration\/cover|\/experiments(?:\/|$)|\/heads\/audit|\/blind-audits(?:\/|$)|\/sync$)/;
const resourceSpendingGet = /^(\/lines\/(?:shop|disagreement)|\/sharp\/(?:board|divergence))$/;
r.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    const spendsExternalResources = resourceSpendingGet.test(req.path)
      || (req.path === '/props' && req.query.market === '1');
    return spendsExternalResources ? requireModelPermission('model:execute')(req, res, next) : next();
  }
  const permission = trainingMutation.test(req.path) ? 'model:train' : 'model:execute';
  return requireModelPermission(permission)(req, res, next);
});
const SEASON = Number(process.env.NFL_SEASON) || 2026;
const wk = req => Number(req.query.week) || 1;
const ssn = req => Number(req.query.season) || SEASON;
const disagreement = req => req.query.max_disagreement === 'none'
  ? null
  : (req.query.max_disagreement != null ? Number(req.query.max_disagreement) : 4.5);

/* ---------------------------------------------------------------- catalog */

r.get('/catalog', (req, res, next) => {
  try {
    const c = catalog();
    const scope = req.query.scope;
    res.json({
      summary: countVariables(),
      variables: scope ? c.filter(v => v.scope === scope) : c
    });
  } catch (e) { next(e); }
});

r.get('/signal-quality', (_req, res, next) => {
  try { res.json(signalQualityCatalog()); }
  catch (e) { next(e); }
});

r.get('/features/team', (req, res, next) => {
  try {
    const team = String(req.query.team ?? '').toUpperCase();
    if (!team) return res.status(400).json({ error: 'team query param required' });
    res.json({ season: ssn(req), week: wk(req), team, features: teamFeatureVector(ssn(req), wk(req), team) });
  } catch (e) { next(e); }
});

r.get('/features/player', (req, res, next) => {
  try {
    const id = req.query.player_id;
    if (!id) return res.status(400).json({ error: 'player_id query param required' });
    res.json(playerFeatureVector(ssn(req), wk(req), String(id)) ?? { error: 'no history for this player' });
  } catch (e) { next(e); }
});

r.get('/trends', (req, res, next) => {
  try {
    const team = String(req.query.team ?? '').toUpperCase();
    if (!team) return res.status(400).json({ error: 'team query param required' });
    res.json({ team, season: ssn(req), week: wk(req), trends: bettingTrends(ssn(req), wk(req), team) });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ props */

/** Model-only by default; `?market=1` spends Odds API credits to price it. */
r.get('/props', async (req, res, next) => {
  try {
    res.json(await propBoard(ssn(req), wk(req), {
      fetchMarket: req.query.market === '1',
      limit: Number(req.query.limit) || 60,
      maxEvents: Math.min(Number(req.query.max_events) || 4, 16)
    }));
  } catch (e) { next(e); }
});

/** Walk-forward error and probability calibration for every prop family. */
r.get('/props/accuracy', (req, res, next) => {
  try {
    const seasons = String(req.query.seasons ?? '2022,2023,2024,2025').split(',').map(Number);
    res.json({ ...propAccuracy(seasons), calibration: tdCalibrationCatalog().active });
  } catch (e) { next(e); }
});

r.get('/props/quotes/status', (req, res, next) => {
  try { res.json(propQuoteStatus()); }
  catch (e) { next(e); }
});

r.post('/props/quotes/reconcile', (_req, res, next) => {
  try { res.json(reconcilePropQuoteMatches({ force: true })); }
  catch (e) { next(e); }
});

r.post('/props/quotes/settle', (req, res, next) => {
  try { res.json(settlePropQuotes({ season: ssn(req), week: wk(req) })); }
  catch (e) { next(e); }
});

r.get('/profitability', (_req, res, next) => {
  try { res.json(profitabilityOperations()); }
  catch (e) { next(e); }
});

r.get('/profitability/passing-specialists', (_req, res, next) => {
  try { res.json(passingSpecialistAudit()); }
  catch (e) { next(e); }
});

r.get('/teasers/prices', (_req, res, next) => {
  try { res.json(teaserPriceLedger()); }
  catch (e) { next(e); }
});

r.post('/teasers/prices', (req, res, next) => {
  try {
    const out = recordTeaserPrice(req.body ?? {});
    if (out.error) return res.status(400).json(out);
    res.status(201).json(out);
  } catch (e) { next(e); }
});

r.post('/news/signals/sync', (req, res, next) => {
  try { res.json(syncStructuredNewsSignals({ sinceDays: Number(req.query.days) || 14 })); }
  catch (e) { next(e); }
});

r.post('/news/signals/ai', async (req, res, next) => {
  try { res.json(await syncAiNewsSignals({ sinceDays: Number(req.query.days) || 7 })); }
  catch (e) { next(e); }
});

r.get('/news/signals', (req, res, next) => {
  try {
    const team = req.query.team ? String(req.query.team).toUpperCase() : null;
    res.json({ coverage: newsSignalCoverage(), team: team ? teamNewsSignals(team) : null });
  } catch (e) { next(e); }
});

r.get('/props/calibration', (_req, res, next) => {
  try { res.json(tdCalibrationCatalog()); }
  catch (e) { next(e); }
});

r.get('/heads', (req, res, next) => {
  try { res.json({ ...playerHeadCatalog(), audits: playerHeadAuditHistory().slice(0, 5),
    forward: weeklyLearningStatus().candidate_heads, prop_calibration: tdCalibrationCatalog() }); }
  catch (e) { next(e); }
});

r.get('/blind-audits/protocol', (_req, res, next) => {
  try { res.json(blindAuditProtocol()); }
  catch (e) { next(e); }
});

r.get('/blind-audits', (_req, res, next) => {
  try { res.json({ audits: listBlindAudits() }); }
  catch (e) { next(e); }
});

r.get('/blind-audits/:id', (req, res, next) => {
  try {
    const audit = blindAuditStatus(req.params.id);
    if (!audit) return res.status(404).json({ error: 'blind audit not found' });
    res.json(audit);
  } catch (e) { next(e); }
});

r.post('/blind-audits', (req, res, next) => {
  try { res.status(201).json(preregisterBlindAudit(req.body ?? {})); }
  catch (e) { next(e); }
});

r.post('/blind-audits/:id/next', (req, res, next) => {
  try { res.json(runNextBlindAuditWeek(req.params.id)); }
  catch (e) { next(e); }
});

r.post('/heads/audit', (req, res, next) => {
  try {
    res.json(auditPlayerHeads({
      openValidation: req.body?.open_validation === true,
      persist: true
    }));
  } catch (e) { next(e); }
});

/* ----------------------------------------------------------------- totals */

r.get('/totals', async (req, res, next) => {
  try {
    const picks = await topTotals(ssn(req), wk(req), Number(req.query.n) || 5);
    if (picks?.error) return res.status(409).json(picks);
    res.json({
      season: ssn(req), week: wk(req),
      picks: picks.map(p => ({ ...p, reasoning: explainPick({
        season: ssn(req), week: wk(req), market: 'total',
        pickTeam: p.home_team, oppTeam: p.away_team, side: p.side, line: p.line,
        modelProbability: p.model_probability, impliedProbability: p.implied_probability,
        detail: p.detail
      }) }))
    });
  } catch (e) { next(e); }
});

r.post('/totals/lock', async (req, res, next) => {
  try { res.json({ picks: await ensureTotalPicks(ssn(req), wk(req), Number(req.query.n) || 5) }); }
  catch (e) { next(e); }
});

r.get('/totals/results', (req, res, next) => {
  try { res.json({ results: gradeTotalPicks(), standing: totalPicksStanding() }); }
  catch (e) { next(e); }
});

/* -------------------------------------------------------------- reasoning */

/** The full board with a computed rationale attached to every row. */
r.get('/board/explained', (req, res, next) => {
  try {
    const board = boardFor(ssn(req), wk(req));
    if (board?.error) return res.status(409).json(board);
    const filtered = req.query.market ? board.filter(b => b.market === req.query.market) : board;
    res.json({
      season: ssn(req), week: wk(req),
      board: explainBoard(ssn(req), wk(req), filtered.slice(0, Number(req.query.limit) || 20))
    });
  } catch (e) { next(e); }
});

r.get('/sentiment', (req, res, next) => {
  try {
    const team = String(req.query.team ?? '').toUpperCase();
    if (!team) return res.status(400).json({ error: 'team query param required' });
    res.json(publicSignal(ssn(req), wk(req), team, req.query.market ?? 'spread'));
  } catch (e) { next(e); }
});

/* -------------------------------------------------- betting -> fantasy */

/** Players the betting model is highest on this week, in fantasy points. */
r.get('/fantasy/standouts', (req, res, next) => {
  try {
    res.json({
      season: ssn(req), week: wk(req),
      players: standouts(ssn(req), wk(req), {
        minPoints: Number(req.query.min_points) || 8,
        limit: Number(req.query.limit) || 25
      })
    });
  } catch (e) { next(e); }
});

/** One player: betting-model points vs the fantasy projection, and why they differ. */
r.get('/fantasy/reconcile', (req, res, next) => {
  try {
    const id = req.query.player_id;
    if (!id) return res.status(400).json({ error: 'player_id query param required' });
    const fp = req.query.fantasy_points != null ? Number(req.query.fantasy_points) : null;
    const out = reconcile(ssn(req), wk(req), String(id), fp);
    if (!out) return res.status(404).json({ error: 'no usage history for this player' });
    res.json(out);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ roles */

r.get('/roles', (req, res, next) => {
  try {
    const team = String(req.query.team ?? '').toUpperCase();
    if (!team) return res.status(400).json({ error: 'team query param required' });
    res.json({ season: ssn(req), week: wk(req), team, roles: rolesFor(ssn(req), wk(req), team) });
  } catch (e) { next(e); }
});

r.get('/roles/timeline', (req, res, next) => {
  try {
    const id = req.query.gsis_id;
    if (!id) return res.status(400).json({ error: 'gsis_id query param required' });
    res.json({ season: ssn(req), timeline: roleTimeline(ssn(req), String(id)) });
  } catch (e) { next(e); }
});

/* --------------------------------------------------------------- ensemble */

r.get('/ensemble/models', (req, res, next) => {
  try {
    const c = modelCatalog();
    if (c?.error) return res.status(409).json(c);
    res.json(c);
  } catch (e) { next(e); }
});

r.get('/ensemble/contracts', (req, res, next) => {
  try { res.json({ contracts: featureContracts() }); } catch (e) { next(e); }
});

r.get('/ensemble/week', (req, res, next) => {
  try {
    res.json({ season: ssn(req), week: wk(req), games: ensembleWeek(ssn(req), wk(req)) });
  } catch (e) { next(e); }
});

r.get('/ensemble/game', (req, res, next) => {
  try {
    const { home, away } = req.query;
    if (!home || !away) return res.status(400).json({ error: 'home and away query params required' });
    const out = ensembleLine(ssn(req), wk(req), String(home).toUpperCase(), String(away).toUpperCase());
    if (out?.error) return res.status(409).json(out);
    res.json(out);
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- replay */

/** Replays a season betting the ensemble, walk-forward, and grades every pick. */
r.get('/replay', (req, res, next) => {
  try {
    const research = req.query.research === '1';
    const out = replaySeason(ssn(req), research ? {
      minEdge: Number(req.query.min_edge) || 3,
      maxDisagreement: disagreement(req),
      markets: String(req.query.markets ?? 'spread').split(','),
      maxPicksPerWeek: Number(req.query.max_picks) || 5
    } : {});
    if (out?.error) return res.status(409).json(out);
    res.json(out);
  } catch (e) { next(e); }
});

/** Replay across seasons plus the systematic error analysis. */
r.get('/replay/train', requireModelPermission('model:train'), (req, res, next) => {
  try {
    const seasons = String(req.query.seasons ?? '2021,2022,2023,2024,2025').split(',').map(Number);
    const research = req.query.research === '1';
    res.json(trainingIteration(seasons, research ? {
      minEdge: Number(req.query.min_edge) || 3,
      maxDisagreement: disagreement(req),
      maxPicksPerWeek: Number(req.query.max_picks) || 5,
      markets: String(req.query.markets ?? 'spread').split(','),
      minBets: Number(req.query.min_bets) || 30
    } : { minBets: Number(req.query.min_bets) || 30 }));
  } catch (e) { next(e); }
});

/** Runs and stores the canonical exact-policy audit used by the decision desk. */
r.post('/replay/train', (req, res, next) => {
  try {
    const seasons = String(req.query.seasons ?? '2021,2022,2023,2024,2025').split(',').map(Number);
    res.json(saveTrainingAudit(trainingIteration(seasons, { minBets: Number(req.query.min_bets) || 30 })));
  } catch (e) { next(e); }
});

r.get('/replay/latest', (_req, res, next) => {
  try { res.json({ audit: latestTrainingAudit() }); } catch (e) { next(e); }
});

/** Starts a bounded-cost, outcome-blind AI risk-gate replay. */
r.post('/ai-replay', (req, res, next) => {
  try { res.status(202).json(startAiBlindReplay(req.body ?? {})); }
  catch (e) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});
r.get('/ai-replay/active', (_req, res, next) => {
  try { res.json({ run: activeAiReplayRun() }); } catch (e) { next(e); }
});
r.get('/ai-replay/latest', (_req, res, next) => {
  try { res.json({ run: latestAiReplayRun() }); } catch (e) { next(e); }
});
r.get('/ai-replay/:id', (req, res, next) => {
  try {
    const out = aiReplayRun(req.params.id);
    if (!out) return res.status(404).json({ error: 'AI replay run not found' });
    res.json(out);
  } catch (e) { next(e); }
});
r.get('/ai-replay/:id/logs', (req, res, next) => {
  try {
    const logs = aiReplayLogs(req.params.id);
    if (!logs) return res.status(404).json({ error: 'AI replay run not found' });
    res.json({ logs });
  } catch (e) { next(e); }
});

r.get('/calibration/cover', (req, res, next) => {
  try { res.json({ calibration: latestCoverCalibration(Number(req.query.before_season) || SEASON) }); }
  catch (e) { next(e); }
});

r.post('/calibration/cover', (req, res, next) => {
  try { res.json(buildCoverCalibration({
    fromSeason: Number(req.query.from) || 2021,
    throughSeason: Number(req.query.through) || SEASON - 1
  })); } catch (e) { next(e); }
});

r.get('/pregame/snapshots', (_req, res, next) => {
  try { res.json({ coverage: pregameSnapshotCoverage() }); } catch (e) { next(e); }
});

r.post('/pregame/snapshots', (req, res, next) => {
  try { res.json(capturePregameSnapshots(ssn(req), wk(req))); } catch (e) { next(e); }
});

/**
 * Tests a threshold change the honest way: derived on some seasons, judged on
 * others. `min_edge` and `max_disagreement` are the two knobs worth tuning.
 */
r.get('/replay/validate', (req, res, next) => {
  try {
    const discovery = String(req.query.discovery ?? '2022,2023').split(',').map(Number);
    const holdout = String(req.query.holdout ?? '2024,2025').split(',').map(Number);
    const maxDis = req.query.max_disagreement ? Number(req.query.max_disagreement) : 4.5;
    // The candidate correction: skip bets where the models scatter more than
    // the threshold, on the theory that internal disagreement means no edge.
    res.json(validateAdjustment({
      discoverySeasons: discovery, holdoutSeasons: holdout,
      // The baseline must be unfiltered or applying maxDis below is a no-op.
      // replaySeason defaults to 4.5, so pass null explicitly here.
      config: { minEdge: Number(req.query.min_edge) || 3, maxDisagreement: null },
      adjust: b => ((b.disagreement ?? 0) <= maxDis ? b : null)
    }));
  } catch (e) { next(e); }
});

/* --------------------------------------------------------- line shopping */

/**
 * The best available price on every side across all books.
 * This is the one edge that needs no prediction — only refusing the worse number.
 */
r.get('/lines/shop', async (req, res, next) => {
  try {
    const out = await shopSlate();
    if (out?.error) return res.status(409).json(out);
    res.json(out);
  } catch (e) { next(e); }
});

/** Where books disagree on the number itself, not just the price. */
r.get('/lines/disagreement', async (req, res, next) => {
  try {
    const out = await numberDisagreement();
    if (out?.error) return res.status(409).json(out);
    res.json(out);
  } catch (e) { next(e); }
});

/** Records the current board so closing line value becomes measurable later. */
r.post('/lines/snapshot', async (req, res, next) => {
  try {
    const out = await snapshotLines();
    if (out?.error) return res.status(409).json(out);
    res.json(out);
  } catch (e) { next(e); }
});

/** Snapshot coverage — whether a close exists to measure anything against. */
r.get('/lines/clv/coverage', (req, res, next) => {
  try { res.json(closingLineValue()); } catch (e) { next(e); }
});

/**
 * The CLV verdict on recorded bets. This is the number to read weekly — it
 * settles whether a strategy has edge far sooner than the win/loss record does.
 */
r.get('/lines/clv', (req, res, next) => {
  try {
    res.json({
      overall: clvReport({ source: req.query.source ?? null, since: req.query.since ?? null }),
      by_source: clvBySource()
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ sharp money */

/** The sharp consensus price for every game, and who is quoting it. */
r.get('/sharp/board', async (req, res, next) => {
  try {
    const out = await sharpBoard({ markets: req.query.markets ?? 'spreads,totals' });
    if (out?.error) return res.status(409).json(out);
    // The internal book lists are for divergence scoring, not for the wire.
    for (const g of out.games) for (const m of Object.values(g.markets)) {
      delete m._sharp; delete m._rec; delete m._ref;
    }
    res.json(out);
  } catch (e) { next(e); }
});

/** Recreational books that have not caught up to the sharp number. */
r.get('/sharp/divergence', async (req, res, next) => {
  try {
    const out = await sharpDivergence({
      minEdgePct: req.query.min_edge != null ? Number(req.query.min_edge) : 0.01
    });
    if (out?.error) return res.status(409).json(out);
    res.json(out);
  } catch (e) { next(e); }
});

/** Synchronised multi-book moves — the visible trace of syndicate money. */
r.get('/sharp/steam', (req, res, next) => {
  try {
    res.json(steamMoves({
      minBooks: Number(req.query.min_books) || 3,
      minPoints: req.query.min_points != null ? Number(req.query.min_points) : 0.5
    }));
  } catch (e) { next(e); }
});

/** Whether sharp-sourced picks are actually beating the close. */
r.get('/sharp/scorecard', (req, res, next) => {
  try { res.json(sharpScorecard()); } catch (e) { next(e); }
});

/** Logs a bet as taken. Without the price and time, CLV cannot be computed. */
r.post('/bets', (req, res, next) => {
  try {
    const out = recordBet(req.body ?? {});
    if (out?.error) return res.status(400).json(out);
    res.status(201).json(out);
  } catch (e) { next(e); }
});

r.get('/bets', (req, res, next) => {
  try { res.json(listBets({ limit: Number(req.query.limit) || 200 })); } catch (e) { next(e); }
});

/** Grades any bet whose game has kicked off against the market's close. */
r.post('/bets/grade', (req, res, next) => {
  try { res.json(gradeClosingLineValue()); } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- staking */

/** Fractional-Kelly stake for a single price and model probability. */
r.get('/stake', (req, res, next) => {
  try {
    const winProb = Number(req.query.prob);
    const odds = Number(req.query.odds);
    if (!Number.isFinite(winProb) || !Number.isFinite(odds)) {
      return res.status(400).json({ error: 'prob and odds query params required' });
    }
    res.json(stakeFor({
      winProb, americanOdds: odds,
      bankroll: Number(req.query.bankroll) || 100,
      multiplier: Number(req.query.kelly) || 0.25
    }));
  } catch (e) { next(e); }
});

r.get('/stake/safe', (req, res, next) => {
  try {
    const winProb = Number(req.query.prob), odds = Number(req.query.odds);
    if (!Number.isFinite(winProb) || !Number.isFinite(odds)) {
      return res.status(400).json({ error: 'prob and odds query params required' });
    }
    res.json(safeStakeFor({
      winProb, americanOdds: odds, bankroll: Number(req.query.bankroll) || 100,
      calibrationPassed: req.query.calibrated === '1',
      forwardSettled: Number(req.query.forward_settled) || 0,
      uncertaintyWidth: req.query.interval_width == null ? null : Number(req.query.interval_width),
      openPortfolioFraction: Number(req.query.open_exposure) || 0
    }));
  } catch (e) { next(e); }
});

/** Does confidence-tiered sizing actually beat flat staking on past bets? */
r.get('/stake/evaluate', (req, res, next) => {
  try {
    const seasons = String(req.query.seasons ?? '2022,2023,2024,2025').split(',').map(Number);
    const bets = [];
    for (const s of seasons) {
      const rp = replaySeason(s, {
        minEdge: Number(req.query.min_edge) || 3,
        maxDisagreement: disagreement(req)
      });
      if (!rp.error) bets.push(...rp.bets.filter(b => b.result !== 'Push'));
    }
    res.json({ seasons, bets: bets.length, ...evaluateSizing(bets) });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ admin */

r.get('/experiments/protocol', (req, res, next) => {
  try { res.json(experimentProtocol()); } catch (e) { next(e); }
});

r.get('/experiments', (req, res, next) => {
  try { res.json({ experiments: listExperiments() }); } catch (e) { next(e); }
});

r.get('/experiments/:id', (req, res, next) => {
  try {
    const out = getExperiment(req.params.id);
    if (!out) return res.status(404).json({ error: 'experiment not found' });
    res.json(out);
  } catch (e) { next(e); }
});

r.post('/experiments', (req, res, next) => {
  try { res.status(201).json(createExperiment(req.body ?? {})); } catch (e) { next(e); }
});

r.post('/experiments/:id/:stage', (req, res, next) => {
  try { res.json(runExperimentStage(req.params.id, req.params.stage)); } catch (e) { next(e); }
});

r.get('/status', (req, res, next) => {
  try {
    res.json({
      variables: countVariables(),
      pbp: pbpCoverage(),
      advanced: advancedCoverage(),
      odds_api: oddsUsage(),
      odds_cache: cacheStatus()
    });
  } catch (e) { next(e); }
});

r.get('/evidence/coverage', (_req, res, next) => {
  try { res.json(nflEvidenceCoverage()); } catch (e) { next(e); }
});

r.get('/validation/firewall', (_req, res, next) => {
  try { res.json(validationFirewall()); } catch (e) { next(e); }
});

r.get('/availability/team', (req, res, next) => {
  try {
    const team = String(req.query.team ?? '').toUpperCase();
    if (!team) return res.status(400).json({ error: 'team query param required' });
    res.json(teamPlayerAvailability(ssn(req), wk(req), team));
  } catch (e) { next(e); }
});

r.get('/availability/game', (req, res, next) => {
  try {
    const home = String(req.query.home ?? '').toUpperCase();
    const away = String(req.query.away ?? '').toUpperCase();
    if (!home || !away) return res.status(400).json({ error: 'home and away query params required' });
    res.json(gamePlayerAvailability(ssn(req), wk(req), home, away));
  } catch (e) { next(e); }
});

r.post('/sync', async (req, res, next) => {
  try {
    const seasons = String(req.query.seasons ?? '2022,2023,2024,2025').split(',').map(Number);
    const out = { pbp: [] };
    for (const s of seasons) out.pbp.push(await syncPbpSeason(s));
    out.advanced = await syncAllAdvanced(seasons);
    clearEnsembleCache();
    clearNflMarketCache();
    out.cache_invalidated = true;
    res.json(out);
  } catch (e) { next(e); }
});

/**
 * The lightweight refresh a board's "Refresh" button should trigger — current
 * lines and scores only, not the multi-season play-by-play resync above, which
 * takes minutes and would make a refresh button feel broken.
 */
r.post('/lines/sync-now', async (req, res, next) => {
  try {
    const result = await runIfStale('nfl_lines', { force: true });
    clearEnsembleLineCache();
    res.json(result);
  }
  catch (e) { next(e); }
});

export default r;
