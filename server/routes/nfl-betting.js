/**
 * NFL betting API: the feature catalog, prop projections, weekly totals,
 * pick reasoning, role tracking and the combined hub summary.
 */
import { footballFirstLean, residualModel, peekResidualModel, FEATURES as FF_FEATURES } from '../services/football-first.js';
import { footballContext, quarterbackPicture, rosterContinuity } from '../services/football-context.js';
import { pickConfidence, confidenceCalibration } from '../services/pick-confidence.js';
import { walkForward } from '../services/weekly-walkforward.js';
import { forwardLedger, recordThisWeek, settleForwardPicks } from '../services/forward-ledger.js';
import { spreadContext, atsProfile, efficiencyGap, fantasyContext } from '../services/nfl-spread-context.js';
// Aliased: nfl-reasoning.js exports its own explainPick, which answers a
// different question (which team is better on which variable). This one
// attributes the number to the component models that produced it and folds the
// factor analysis in — see pick-reasoning.js.
import { explainPick as explainPickTrace, explainWeek } from '../services/pick-reasoning.js';
import { Router } from 'express';
import { cached, fingerprint } from '../services/compute-cache.js';
import { requireModelPermission } from '../modeling/authz.js';
import { catalog, countVariables, teamFeatureVector, playerFeatureVector, bettingTrends } from '../services/nfl-features.js';
import {
  propBoard, propAccuracy, propQuoteStatus, topTotals, ensureTotalPicks,
  gradeTotalPicks, totalPicksStanding
} from '../services/nfl-props.js';
import { explainPick, explainBoard, publicSignal } from '../services/nfl-reasoning.js';
import { callClaude, getApiKey, parseJson } from '../services/claude.js';
import { liveGames } from '../services/nfl-live.js';
import { rolesFor, roleTimeline, advancedCoverage, syncAllAdvanced } from '../services/nfl-advanced.js';
import { pbpCoverage, syncPbpSeason } from '../services/nfl-pbp.js';
import { syncAll as syncNflversePlayerFeeds } from '../services/nflverse.js';
import { boardFor, accuracy, clearNflMarketCache } from '../services/nfl-market.js';
import { standing as spreadStanding, allPickResults } from '../services/nfl-auto-picks.js';
import { usage as oddsUsage, cacheStatus } from '../services/odds-api.js';
import { standouts, reconcile } from '../services/betting-fantasy-link.js';
import { modelCatalog, ensembleWeek, ensembleLine, featureContracts, clearEnsembleCache, clearEnsembleLineCache } from '../services/nfl-ensemble.js';
import { replaySeason, trainingIteration, validateAdjustment, saveTrainingAudit, latestTrainingAudit,
  candidateInputComparison, saveCandidateInputAudit, latestCandidateInputAudit } from '../services/nfl-replay.js';
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
import { nflDiagnostic } from '../services/nfl-diagnostic.js';
import { runNflModelGrowthCycle } from '../services/nfl-model-growth.js';
import { captureOnlineNeuralWeek, nflOnlineNeuralStatus, settleOnlineNeuralExamples,
  trainOnlineNeuralThroughSettled } from '../services/nfl-online-neural.js';
import { captureRiskLabWeek, nflRiskLabStatus, settleRiskLabPredictions,
  trainRiskLabThroughSettled } from '../services/nfl-risk-lab.js';
import { reconcilePropQuoteMatches, settlePropQuotes } from '../services/nfl-prop-clv.js';
import { newsSignalCoverage, syncAiNewsSignals, syncStructuredNewsSignals, teamNewsSignals } from '../services/nfl-news-signal.js';
import { passingSpecialistAudit } from '../services/nfl-passing-specialists.js';
import { recordPickExplanation, recentPickExplanations } from '../services/nfl-pick-explanation-audit.js';
import { nflEngineStatus, nflEngineVersionFor, startLearningEpoch } from '../services/nfl-engine-registry.js';
import { unifiedGameProjection } from '../services/nfl-unified-engine.js';
import { backfillChallengerSignals, historicalReplayBiasAudit, nflBackfillPlan, nflBackfillStatus,
  runNflEngineBackfill } from '../services/nfl-engine-backfill.js';
import { teamRosterStrength, pffConnectorStatus, syncLicensedPffGrades } from '../services/nfl-roster-strength.js';
import { buildCandidateRobustnessReport, saveCandidateRobustnessReport,
  latestCandidateRobustnessReport } from '../services/nfl-candidate-analysis.js';
import { nflDataConsistencyAudit } from '../services/nfl-data-consistency.js';
import { nflFeatureCoverage } from '../services/nfl-feature-coverage.js';
import { weeklyFeatureStoreStatus } from '../services/nfl-weekly-feature-store.js';
import { teamCardCoverage } from '../services/nfl-team-card.js';
import { nflRebuildProgress } from '../services/nfl-rebuild-progress.js';
import { expertCouncilStatus, captureForwardExpertWeek } from '../services/nfl-expert-council.js';

const r = Router();
// Mutations are split between research/training and live operational execution.
// A training grant must not authorize spending API/AI resources, locking picks,
// or writing/grading bets.
const trainingMutation = /^(\/replay\/(?:train|candidate-audit|candidate-robustness)|\/calibration\/cover|\/experiments(?:\/|$)|\/heads\/audit|\/blind-audits(?:\/|$)|\/(?:online-neural|risk-lab)\/train|\/engine\/(?:backfill|learning-epoch)|\/roster\/(?:pff-sync|rookies\/(?:sync|college-sync))|\/sync$)/;
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

r.get('/diagnostic', (_req, res, next) => {
  try { res.json(nflDiagnostic()); }
  catch (e) { next(e); }
});

r.get('/data-consistency', (_req, res, next) => {
  try { res.json(nflDataConsistencyAudit()); }
  catch (e) { next(e); }
});

/** Run the same finalized-week growth cycle used by the scheduler. */
r.post('/profitability/model-growth/run', async (req, res, next) => {
  try {
    res.json(await runNflModelGrowthCycle({
      season: Number(req.body?.season) || undefined,
      force: req.body?.force === true
    }));
  } catch (e) { next(e); }
});

r.get('/online-neural', (_req, res, next) => {
  try { res.json(nflOnlineNeuralStatus()); }
  catch (e) { next(e); }
});

r.get('/engine/backfill', (req, res, next) => {
  try {
    res.json({ status: nflBackfillStatus(), plan: nflBackfillPlan({
      startSeason: Number(req.query.start) || 2022, endSeason: Number(req.query.end) || 2025
    }), bias_audit: historicalReplayBiasAudit({
      startSeason: Number(req.query.start) || 2022, endSeason: Number(req.query.end) || 2025
    }) });
  } catch (e) { next(e); }
});

r.post('/engine/backfill', async (req, res, next) => {
  try {
    if (req.body?.signals_only === true) return res.json(backfillChallengerSignals({
      startSeason: Number(req.body?.start_season) || 2022,
      endSeason: Number(req.body?.end_season) || 2025
    }));
    res.json(await runNflEngineBackfill({
      startSeason: Number(req.body?.start_season) || 2022,
      endSeason: Number(req.body?.end_season) || 2025,
      ingest: req.body?.ingest === true,
      maxWeeks: req.body?.max_weeks == null ? null : Number(req.body.max_weeks)
    }));
  } catch (e) { next(e); }
});

r.post('/engine/learning-epoch', (req, res, next) => {
  try {
    res.status(201).json(startLearningEpoch({ reason: req.body?.reason,
      confirmed: req.body?.confirmed === true, reset: req.body?.reset }));
  } catch (e) { next(e); }
});

r.post('/online-neural/capture', (req, res, next) => {
  try {
    const neural = captureOnlineNeuralWeek(ssn(req), wk(req), { horizons: ['manual'] });
    // The expert council freezes alongside the neural and risk-lab heads; it was
    // the one forward ledger with no manual capture path.
    res.json({ ...neural, risk_lab: captureRiskLabWeek(ssn(req), wk(req), { horizons: ['manual'] }),
      expert_council: captureForwardExpertWeek(ssn(req), wk(req), { horizon: 'manual' }) });
  }
  catch (e) { next(e); }
});

r.post('/online-neural/train', (_req, res, next) => {
  try {
    const settlement = settleOnlineNeuralExamples();
    const riskSettlement = settleRiskLabPredictions();
    res.json({ settlement, ...trainOnlineNeuralThroughSettled(),
      risk_lab: { settlement: riskSettlement, ...trainRiskLabThroughSettled() } });
  } catch (e) { next(e); }
});

r.get('/risk-lab', (_req, res, next) => {
  try { res.json(nflRiskLabStatus()); }
  catch (e) { next(e); }
});

r.post('/risk-lab/train', (_req, res, next) => {
  try {
    const settlement = settleRiskLabPredictions();
    res.json({ settlement, ...trainRiskLabThroughSettled() });
  } catch (e) { next(e); }
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

r.get('/expert-council', (_req, res, next) => {
  try { res.json(expertCouncilStatus()); }
  catch (e) { next(e); }
});

r.get('/blind-audits', (_req, res, next) => {
  try { res.json({ audits: listBlindAudits() }); }
  catch (e) { next(e); }
});

r.get('/blind-audits/:id', (req, res, next) => {
  try {
    const requestedLimit = req.query.week_limit == null ? null : Number(req.query.week_limit);
    const audit = blindAuditStatus(req.params.id, {
      weekLimit: Number.isFinite(requestedLimit) ? Math.max(0, Math.min(20, requestedLimit)) : null,
      compact: req.query.compact === '1'
    });
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
    const limit = Number(req.query.limit) || 20;
    // 29 seconds cold: the reasoning pass re-walks the ensemble per game. Same
    // data in, same explanation out, so it is cached on the data rather than
    // regenerated for every page view.
    res.json(cached(`board_explained:${ssn(req)}:${wk(req)}:${req.query.market ?? 'all'}:${limit}`,
      fingerprint([{ table: 'game_lines', stamp: 'fetched_at' }, 'nfl_team_week_features']),
      () => ({ season: ssn(req), week: wk(req),
        board: explainBoard(ssn(req), wk(req), filtered.slice(0, limit)) })));
  } catch (e) { next(e); }
});

/**
 * Stats-to-English, for debugging the model, not selling the pick. The
 * structured factor breakdown (explainPick) is already deterministic and
 * complete — this just asks Claude to translate it into one readable
 * paragraph. Claude is told explicitly not to add facts or make a call;
 * it can only rephrase what the deterministic reasoning already found,
 * which is the point — this is a lens onto the model's own inputs, not a
 * second opinion.
 */
r.post('/explain/ai', async (req, res, next) => {
  try {
    if (!getApiKey()) return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right).' });
    const b = req.body ?? {};
    const season = Number(b.season) || SEASON, week = Number(b.week) || 1;
    const market = String(b.market ?? 'spread');
    const pickTeam = market === 'total' ? b.home_team : b.selection;
    const oppTeam = market === 'total' ? b.away_team : (b.selection === b.home_team ? b.away_team : b.home_team);
    const reasoning = explainPick({
      season, week, market, pickTeam, oppTeam, side: b.side, line: b.line,
      modelProbability: b.model_probability, impliedProbability: b.implied_probability, detail: b.detail
    });

    const fmtFactor = f => `${f.label}: ${pickTeam} ${f.pick_display} vs ${oppTeam} ${f.opponent_display}`;
    const availableFactorKeys = [...reasoning.supporting, ...reasoning.opposing].map(factor => factor.key);
    const prompt = `You are translating an NFL betting model's already-computed reasoning into plain English for someone debugging the model. You are NOT making a betting recommendation and must NOT introduce any fact, stat, injury, or weather detail that is not listed below.

GAME: ${b.matchup ?? `${b.away_team ?? ''} at ${b.home_team ?? ''}`}, ${market} — model likes ${b.selection ?? pickTeam} ${b.side ?? ''}
${reasoning.headline}
${reasoning.no_history ? reasoning.no_history_note : ''}
Factors favoring this side: ${reasoning.supporting.length ? reasoning.supporting.map(fmtFactor).join('; ') : 'none found'}
Factors against this side: ${reasoning.opposing.length ? reasoning.opposing.map(fmtFactor).join('; ') : 'none found'}
Market movement: ${reasoning.market_agreement ?? 'no meaningful line movement recorded'}
News context — ${pickTeam}: ${reasoning.news_context?.pick_team?.length ? reasoning.news_context.pick_team.map(n => n.headline).join('; ') : 'nothing typed/extracted'}
News context — ${oppTeam}: ${reasoning.news_context?.opponent?.length ? reasoning.news_context.opponent.map(n => n.headline).join('; ') : 'nothing typed/extracted'}
Model's own confidence label: ${reasoning.confidence}

Return ONLY JSON with:
{
  "paragraph": "4-6 sentences explaining what drove the number, what opposed it, and how thin the evidence is",
  "factor_keys_used": ${JSON.stringify(availableFactorKeys)},
  "limitations": ["short evidence limitation stated in the paragraph"]
}

factor_keys_used may contain only keys from the supplied array and only when that factor is actually discussed. If a category above is empty (no news, no history, no movement), state that limitation rather than skipping it. Do not recommend betting the pick or not.`;

    const msg = await callClaude({ feature: 'nfl-pick-explain-ai', maxTokens: 500, prompt });
    const translated = parseJson(msg);
    if (typeof translated.paragraph !== 'string' || !translated.paragraph.trim()) {
      return res.status(502).json({ error: 'AI translation did not return a grounded paragraph' });
    }
    const factorKeys = Array.isArray(translated.factor_keys_used)
      ? translated.factor_keys_used.filter(key => availableFactorKeys.includes(key)) : [];
    const limitations = Array.isArray(translated.limitations)
      ? translated.limitations.filter(value => typeof value === 'string').slice(0, 5) : [];
    const translation = { paragraph: translated.paragraph.trim(), factor_keys_used: factorKeys, limitations };
    const audit = recordPickExplanation({ season, week,
      matchup: b.matchup ?? `${b.away_team ?? ''} at ${b.home_team ?? ''}`,
      market, selection: b.selection ?? pickTeam, reasoning, translation });
    res.json({ ...translation, reasoning, audit });
  } catch (e) { next(e); }
});

r.get('/explain/ai/audits', (req, res, next) => {
  try { res.json({ explanations: recentPickExplanations({ limit: req.query.limit }) }); }
  catch (e) { next(e); }
});

/** Live scoreboard and in-game win probability. Free — no key, no quota. */
r.get('/live', async (req, res, next) => {
  try {
    res.json(await liveGames({
      season: Number(req.query.season) || undefined,
      week: req.query.week ? Number(req.query.week) : null
    }));
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

/** Full preseason-first player/depth ranking for one team. */
r.get('/roster/strength', (req, res, next) => {
  try {
    const team = String(req.query.team ?? '').toUpperCase();
    if (!team) return res.status(400).json({ error: 'team query param required' });
    res.json(teamRosterStrength(ssn(req), wk(req), team));
  } catch (e) { next(e); }
});

r.get('/roster/pff-status', (_req, res, next) => {
  try { res.json(pffConnectorStatus()); } catch (e) { next(e); }
});

/** Authorized connector only; never scrapes a PFF browser session. */
r.post('/roster/pff-sync', async (req, res, next) => {
  try { res.json(await syncLicensedPffGrades(ssn(req), wk(req))); } catch (e) { next(e); }
});

r.get('/roster/rookies/status', async (_req, res, next) => {
  try {
    const { rookieAcquisitionStatus } = await import('../services/nfl-rookie-ingest.js');
    res.json(rookieAcquisitionStatus());
  } catch (e) { next(e); }
});

r.get('/roster/rookies/profile', async (req, res, next) => {
  try {
    const playerId = Number(req.query.player_id);
    if (!playerId) return res.status(400).json({ error: 'player_id query param required' });
    const { rookieEvidenceProfile, fitRookieEvidenceModel } = await import('../services/nfl-rookies.js');
    res.json({ profile: rookieEvidenceProfile(playerId, ssn(req), String(req.query.cutoff ?? `${ssn(req)}-09-01T00:00:00Z`)),
      fit: fitRookieEvidenceModel(ssn(req)) });
  } catch (e) { next(e); }
});

r.post('/roster/rookies/sync', async (req, res, next) => {
  try {
    const { syncPublicRookieEvidence } = await import('../services/nfl-rookie-ingest.js');
    res.json(await syncPublicRookieEvidence({ fromSeason: Number(req.query.from) || 2000,
      throughSeason: Number(req.query.through) || ssn(req) }));
  } catch (e) { next(e); }
});

r.post('/roster/rookies/college-sync', async (req, res, next) => {
  try {
    const { syncPublicCollegeEvidence } = await import('../services/nfl-rookie-ingest.js');
    res.json(await syncPublicCollegeEvidence({ fromSeason: Number(req.query.from) || 2022,
      throughSeason: Number(req.query.through) || Math.max(2022, ssn(req) - 1) }));
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
    res.json({ season: ssn(req), week: wk(req), engine_version: nflEngineVersionFor(ssn(req), wk(req)),
      games: ensembleWeek(ssn(req), wk(req)) });
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

/** Compare the champion with the same engine hearing every candidate input. */
r.post('/replay/candidate-audit', (req, res, next) => {
  try {
    const seasons = String(req.query.seasons ?? '2021,2022,2023,2024,2025').split(',').map(Number);
    res.json(saveCandidateInputAudit(candidateInputComparison(seasons, {
      minBets: Number(req.query.min_bets) || 30
    })));
  } catch (e) { next(e); }
});

r.get('/replay/candidate-audit/latest', (_req, res, next) => {
  try { res.json({ audit: latestCandidateInputAudit() }); } catch (e) { next(e); }
});

r.post('/replay/candidate-robustness', (req, res, next) => {
  try {
    const seasons = String(req.query.seasons ?? '2021,2022,2023,2024,2025').split(',').map(Number);
    res.json(saveCandidateRobustnessReport(buildCandidateRobustnessReport(seasons)));
  } catch (e) { next(e); }
});

r.get('/replay/candidate-robustness/latest', (_req, res, next) => {
  try { res.json({ audit: latestCandidateRobustnessReport() }); } catch (e) { next(e); }
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
    // The RAW Kelly calculator. It applies no validation gate at all, which is
    // fine for a calculator and dangerous if read as advice — it will happily
    // size a model probability that /stake/safe and the execution-edge staking
    // path both refuse, because neither spreads nor props have ever recorded
    // positive closing-line value here. Saying so in the payload is the
    // difference between a tool and a trap.
    const sized = stakeFor({
      winProb, americanOdds: odds,
      bankroll: Number(req.query.bankroll) || 100,
      multiplier: Number(req.query.kelly) || 0.25
    });
    res.json({
      ...sized,
      validation_gate_applied: false,
      warning: 'Raw Kelly arithmetic on the probability you supplied. No gate was applied: this ' +
        'endpoint does not check whether the probability came from a model that has ever beaten a ' +
        'closing line, and none here has. Use /stake/safe for the sized-with-safeguards figure.',
      safe_endpoint: '/api/nfl-betting/stake/safe'
    });
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
      weekly_features: weeklyFeatureStoreStatus(),
      team_cards: teamCardCoverage(),
      odds_api: oddsUsage(),
      odds_cache: cacheStatus(),
      engine: nflEngineStatus(ssn(req), wk(req))
    });
  } catch (e) { next(e); }
});

r.get('/features/coverage', (_req, res, next) => {
  try { res.json(nflFeatureCoverage()); } catch (e) { next(e); }
});

r.get('/rebuild/progress', (_req, res, next) => {
  try { res.json(nflRebuildProgress()); } catch (e) { next(e); }
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
    const seasons = String(req.query.seasons ?? '2021,2022,2023,2024,2025').split(',').map(Number);
    const out = { pbp: [] };
    for (const s of seasons) out.pbp.push(await syncPbpSeason(s));
    out.advanced = await syncAllAdvanced(seasons);
    out.player = await syncNflversePlayerFeeds(seasons);
    out.consistency = nflDataConsistencyAudit();
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

/* ------------------------------------------------ play-by-play simulator */

r.get('/engine/game', (req, res, next) => {
  try {
    const out = unifiedGameProjection({
      season: ssn(req), week: wk(req), home: req.query.home, away: req.query.away,
      trials: Number(req.query.trials) || 8000,
      spread: req.query.spread == null ? null : Number(req.query.spread),
      total: req.query.total == null ? null : Number(req.query.total),
      sampleDrives: req.query.drives === '1'
    });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  } catch (e) { next(e); }
});

/**
 * Simulate a matchup play by play. The joint score distribution this returns is
 * what makes moneyline, spread and total mutually consistent — they are all
 * counted off the same simulated games.
 */
r.get('/sim/matchup', async (req, res, next) => {
  try {
    const { simulateMatchup } = await import('../services/nfl-drive-sim.js');
    res.json(simulateMatchup({
      home: req.query.home, away: req.query.away,
      trials: Math.min(20000, Number(req.query.trials) || 8000),
      spread: req.query.spread == null ? null : Number(req.query.spread),
      total: req.query.total == null ? null : Number(req.query.total),
      season: req.query.season ? Number(req.query.season) : null,
      week: req.query.week ? Number(req.query.week) : null,
      sampleDrives: req.query.drives === '1'
    }));
  } catch (e) { next(e); }
});

/** Does the engine reproduce real NFL scoring? Reported pass or fail. */
r.get('/sim/calibration', async (req, res, next) => {
  try {
    const { calibrationReport } = await import('../services/nfl-drive-sim.js');
    const { cached: c3, fingerprint: f3 } = await import('../services/compute-cache.js');
    const trials = Math.min(600, Number(req.query.trials) || 250);
    const games = Math.min(60, Number(req.query.games) || 35);
    // Deterministic since the matchup enumeration was fixed, so it caches cleanly.
    res.json(c3(`sim_calibration:${trials}:${games}`,
      f3([{ table: 'game_lines', stamp: 'fetched_at' }, 'nfl_team_week_features']),
      () => calibrationReport({ trials, games })));
  } catch (e) { next(e); }
});

/** The only question that matters: does it beat the closing line? */
r.get('/sim/backtest', async (req, res, next) => {
  try {
    const { backtest } = await import('../services/nfl-drive-sim.js');
    res.json(backtest({ season: Number(req.query.season) || 2025,
      trials: Math.min(500, Number(req.query.trials) || 250),
      maxGames: Math.min(200, Number(req.query.games) || 90) }));
  } catch (e) { next(e); }
});

/** The twenty strategic decision modules, and where each one comes from. */
r.get('/sim/modules', async (req, res, next) => {
  try {
    const { moduleCatalog } = await import('../services/nfl-sim-policy.js');
    res.json(moduleCatalog());
  } catch (e) { next(e); }
});

/** How hard each learned rate is shrunk, and the minimax diagnostic. */
r.get('/sim/learning', async (req, res, next) => {
  try {
    const L = await import('../services/nfl-sim-learn.js');
    res.json({
      shrinkage: L.shrinkageReport({}),
      minimax: L.minimaxDiagnostic({}),
      play_influence: L.playInfluenceReport({})
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------- ESPN play-by-play feed */

/** What the play corpus holds right now. */
r.get('/pbp/status', async (req, res, next) => {
  try {
    const { pbpStatus } = await import('../services/nfl-espn-pbp.js');
    res.json(pbpStatus());
  } catch (e) { next(e); }
});

/** Ingest completed games to grow the corpus the model learns from. */
r.post('/pbp/ingest', async (req, res, next) => {
  try {
    const { ingestCompleted } = await import('../services/nfl-espn-pbp.js');
    res.json(await ingestCompleted({ date: req.query.date ?? null,
      limit: Math.min(20, Number(req.query.limit) || 16) }));
  } catch (e) { next(e); }
});

/** Poll games currently in progress. Free — ESPN charges nothing for this. */
r.post('/pbp/poll', async (req, res, next) => {
  try {
    const { pollLiveGames } = await import('../services/nfl-espn-pbp.js');
    res.json(await pollLiveGames({ date: req.query.date ?? null }));
  } catch (e) { next(e); }
});

/** Does the engine's play distribution match the real play log? */
r.get('/pbp/audit', async (req, res, next) => {
  try {
    const { playDistributionAudit } = await import('../services/nfl-espn-pbp.js');
    res.json(await playDistributionAudit({
      season: req.query.season ? Number(req.query.season) : null }));
  } catch (e) { next(e); }
});

/** Finish a live game from its actual current state, thousands of times. */
r.get('/pbp/live/:eventId', async (req, res, next) => {
  try {
    const { simulateLiveGame } = await import('../services/nfl-espn-pbp.js');
    res.json(await simulateLiveGame(req.params.eventId, {
      trials: Math.min(10000, Number(req.query.trials) || 4000),
      spread: req.query.spread == null ? null : Number(req.query.spread),
      total: req.query.total == null ? null : Number(req.query.total) }));
  } catch (e) { next(e); }
});

/**
 * Backfill whole seasons of play-by-play from ESPN.
 *
 * Free and unmetered, but long-running — five seasons is roughly 1,400 games —
 * so it answers immediately and keeps working in the background rather than
 * holding a request open for ten minutes.
 */
r.post('/pbp/backfill', async (req, res, next) => {
  try {
    const { backfillSeasons } = await import('../services/nfl-espn-pbp.js');
    const seasons = String(req.query.seasons ?? '2021,2022,2023,2024,2025')
      .split(',').map(Number).filter(Number.isFinite);
    if (req.query.wait === '1') {
      return res.json(await backfillSeasons({ seasons }));
    }
    backfillSeasons({ seasons }).catch(() => {});
    res.json({ started: true, seasons,
      note: 'Running in the background. Poll GET /nfl-betting/pbp/status to watch the corpus grow.' });
  } catch (e) { next(e); }
});

/** Shotgun, no-huddle and pass-depth splits measured from real play text. */
r.get('/pbp/formations', async (req, res, next) => {
  try {
    const { formationReport } = await import('../services/nfl-espn-pbp.js');
    res.json(formationReport({ season: req.query.season ? Number(req.query.season) : null }));
  } catch (e) { next(e); }
});

/* ------------------------------------------------- opening lines and CLV */

/** Backfill opening lines from nflverse — the columns that shipped empty. */
r.post('/lines/opening/ingest', async (req, res, next) => {
  try {
    const { ingestOpeningLines } = await import('../services/nfl-opening-lines.js');
    res.json(await ingestOpeningLines({}));
  } catch (e) { next(e); }
});

/** What opening-line coverage exists, and how far the number moves before close. */
r.get('/lines/opening', async (req, res, next) => {
  try {
    const m = await import('../services/nfl-opening-lines.js');
    const season = Number(req.query.season) || 2021;
    res.json({ coverage: m.openingLineCoverage(), movement: m.closingLineValue({ season }) });
  } catch (e) { next(e); }
});

/**
 * Closing-line value: does our disagreement with the opening number predict
 * which way the line then moves? The only edge test that returns a verdict in
 * weeks rather than seasons.
 */
r.get('/clv', async (req, res, next) => {
  try {
    const { clvReport } = await import('../services/nfl-drive-sim.js');
    res.json(clvReport({ season: Number(req.query.season) || 2021,
      trials: Math.min(500, Number(req.query.trials) || 250) }));
  } catch (e) { next(e); }
});

/** The injury availability feature the spread model never had. */
r.get('/availability', async (req, res, next) => {
  try {
    const { availabilityAudit } = await import('../services/nfl-availability.js');
    res.json(availabilityAudit({ season: Number(req.query.season) || 2024 }));
  } catch (e) { next(e); }
});

/* ------------------------------------------------- research modules, wired */

/**
 * Eleven analytics modules — roughly 2,500 lines — were built, tested and left
 * unreachable: nothing imported them and no route could trigger them. That is
 * this project's most expensive recurring failure, and it is invisible in
 * normal use because unused code does not error, it just sits there.
 *
 * These expose them. Several are validators that report whether an adjustment
 * is worth making at all, which is exactly the sort of thing that should be
 * runnable rather than assumed.
 */
r.get('/research/:topic', async (req, res, next) => {
  try {
    const topic = String(req.params.topic);
    // Several of these read the play-by-play feature table, which lags the
    // current season — defaulting to SEASON (2026) asks for data that does not
    // exist yet and fails at the SQL layer rather than saying so.
    const { rows: dbRows } = await import('../db/index.js');
    const latestFeatureSeason = dbRows(
      `SELECT MAX(season) AS s FROM nfl_team_week_features`)[0]?.s ?? SEASON;
    const season = Number(req.query.season) || latestFeatureSeason;
    switch (topic) {
      case 'coaches': {
        const m = await import('../services/nfl-coaches.js');
        return res.json({ changes: m.coachChanges(season), status: m.coachHistoryStatus() });
      }
      case 'opponent': {
        const m = await import('../services/nfl-opponent.js');
        return res.json(m.validateOpponentEfficiency({}));
      }
      case 'rookies': {
        const m = await import('../services/nfl-rookies.js');
        return res.json(m.measureRookiePriors());
      }
      case 'scheme': {
        const m = await import('../services/nfl-scheme.js');
        return res.json({ archetypes: Object.fromEntries(m.schemeArchetypes(season)),
          changes: Object.fromEntries(m.allSchemeChanges(season)),
          validation: m.validateSchemeAdjustment({}) });
      }
      case 'competition': {
        const m = await import('../services/nfl-teammate-competition.js');
        return res.json(m.validateCompetitionAdjustment({}));
      }
      case 'offseason': {
        const m = await import('../services/nfl-offseason-change.js');
        return res.json({ changes: m.offseasonChanges(season),
          validation: m.validateTeamChangeAdjustment({}) });
      }
      case 'passing': {
        const m = await import('../services/nfl-passing-diagnostic.js');
        return res.json(m.passingComponentDiagnostic());
      }
      case 'prop-grades': {
        const m = await import('../services/nfl-prop-grading.js');
        return res.json(m.allPropGrades([season - 2, season - 1, season]));
      }
      case 'prop-replay': {
        const m = await import('../services/nfl-props-replay.js');
        return res.json(m.replayPropsBySeason());
      }
      case 'specialists': {
        const m = await import('../services/nfl-specialists.js');
        return res.json(m.evaluate({}));
      }
      case 'context-heads': {
        // This one audits a single named metric rather than the whole family.
        const m = await import('../services/nfl-context-heads.js');
        return res.json(m.auditContextHeads(String(req.query.metric ?? 'rec_yds'), {}));
      }
      default:
        return res.status(404).json({ error: `unknown research topic "${topic}"`,
          available: ['coaches', 'opponent', 'rookies', 'scheme', 'competition', 'offseason',
            'passing', 'prop-grades', 'prop-replay', 'specialists', 'context-heads'] });
    }
  } catch (e) { next(e); }
});

/** Does the actual live remainder simulator work? Graded on completed games. */
r.get('/pbp/live-validation', async (req, res, next) => {
  try {
    const { liveRemainderValidation } = await import('../services/nfl-espn-pbp.js');
    res.json(liveRemainderValidation({
      season: req.query.season ? Number(req.query.season) : null,
      maxGames: Math.min(120, Number(req.query.games) || 40),
      trials: Math.min(1000, Math.max(100, Number(req.query.trials) || 300)) }));
  } catch (e) { next(e); }
});

/** Backfill early-week lines for 2013-2021 from nflverse. */
r.post('/lines/opening/supercontest', async (req, res, next) => {
  try {
    const { ingestSuperContestLines } = await import('../services/nfl-opening-lines.js');
    res.json(await ingestSuperContestLines({}));
  } catch (e) { next(e); }
});

/**
 * A single simulated drive, play by play, for the field animation.
 *
 * The engine already resolves every snap individually — down, distance, field
 * position, play type, yardage, formation. This exposes that tape so a drive can
 * be drawn and stepped through rather than only summarised.
 */
r.get('/sim/drive', async (req, res, next) => {
  try {
    const { simulateMatchup } = await import('../services/nfl-drive-sim.js');
    const out = simulateMatchup({
      home: req.query.home, away: req.query.away, trials: 1, sampleDrives: true,
      seed: req.query.seed ? Number(req.query.seed) : Math.floor(Math.random() * 1e6),
      spread: req.query.spread == null ? null : Number(req.query.spread) });
    if (out.error) return res.json(out);
    const drives = (out.example_drives ?? []).filter(d => (d.tape ?? []).length > 0);
    res.json({ home: out.home, away: out.away, drives_with_plays: drives.length,
      drives: drives.slice(0, 24),
      play_model: out.play_model, season: out.season, profile_fell_back: out.profile_fell_back,
      note: 'One simulated game. Each drive carries its own play tape — the same snaps the scoring ' +
        'came from, not a separate illustrative sequence.' });
  } catch (e) { next(e); }
});

/* ------------------------------------------------- formations and charting */

/** Ingest nflverse participation and FTN charting for a season. */
r.post('/formations/ingest', async (req, res, next) => {
  try {
    const m = await import('../services/nfl-formations.js');
    const season = Number(req.query.season) || 2023;
    res.json({ formations: await m.ingestFormations(season),
      charting: await m.ingestCharting(season), status: m.formationStatus() });
  } catch (e) { next(e); }
});

/** How offences actually line up — the real distribution, not a shotgun rate. */
r.get('/formations', async (req, res, next) => {
  try {
    const { formationDistribution } = await import('../services/nfl-formations.js');
    res.json(formationDistribution({
      season: req.query.season ? Number(req.query.season) : null,
      team: req.query.team ?? null }));
  } catch (e) { next(e); }
});

/** Hand-charted play detail: play action, motion, RPO, screens. */
r.get('/formations/charting', async (req, res, next) => {
  try {
    const { chartingSummary } = await import('../services/nfl-formations.js');
    res.json(chartingSummary({ season: req.query.season ? Number(req.query.season) : null }));
  } catch (e) { next(e); }
});

/* ------------------------------------------------- officials and GBM */

/** Ingest every referee assignment nflverse has. */
r.post('/officials/ingest', async (req, res, next) => {
  try {
    const { ingestOfficials } = await import('../services/nfl-officials.js');
    res.json(await ingestOfficials());
  } catch (e) { next(e); }
});

/** Does the referee crew move a total? Corrected for having examined them all. */
r.get('/officials/totals', async (req, res, next) => {
  try {
    const { refereeTotals, officialsStatus } = await import('../services/nfl-officials.js');
    res.json({ ...refereeTotals({ minGames: Number(req.query.min_games) || 25 }),
      corpus: officialsStatus() });
  } catch (e) { next(e); }
});

/**
 * Gradient-boosted trees on the residual the market leaves behind.
 *
 * A different model class from everything else here, aimed at the only target
 * that can pay: what the closing line MISSED, rather than the margin itself.
 */
r.get('/gbm', async (req, res, next) => {
  try {
    const { gbmWalkForward } = await import('../services/nfl-gbm.js');
    const { cached: c2, fingerprint: f2 } = await import('../services/compute-cache.js');
    const trees = Math.min(200, Number(req.query.trees) || 60);
    const depth = Math.min(6, Number(req.query.depth) || 3);
    const lr = Number(req.query.lr) || 0.05;
    // Eight seconds to fit sixty trees across three walk-forward seasons. The
    // fit is deterministic given the data and the hyperparameters, so the key
    // carries both.
    return res.json(c2(`gbm:${trees}:${depth}:${lr}`,
      f2([{ table: 'game_lines', stamp: 'fetched_at' }, 'nfl_team_week_features']),
      () => gbmWalkForward({ trees, maxDepth: depth, learningRate: lr })));
    /* eslint-disable-next-line no-unreachable */
    res.json(gbmWalkForward({
      trees: Math.min(200, Number(req.query.trees) || 60),
      maxDepth: Math.min(6, Number(req.query.depth) || 3),
      learningRate: Number(req.query.lr) || 0.05 }));
  } catch (e) { next(e); }
});

/* ------------------------------------------------- availability and sources */

/** Who plays for one team this week, from every source, with conflicts shown. */
r.get('/who-plays/:team', async (req, res, next) => {
  try {
    const { whoPlays } = await import('../services/who-plays.js');
    res.json(whoPlays(Number(req.query.season) || 2025, Number(req.query.week) || 1,
      req.params.team));
  } catch (e) { next(e); }
});

/** The whole slate, ranked by expected snaps lost rather than headcount. */
r.get('/who-plays', async (req, res, next) => {
  try {
    const m = await import('../services/who-plays.js');
    res.json({ ...m.slateAvailability(Number(req.query.season) || 2025, Number(req.query.week) || 1),
      sources: m.availabilitySources() });
  } catch (e) { next(e); }
});

/** Verify every configured news handle against the live API. Costs budget. */
r.post('/news/sources/validate', async (req, res, next) => {
  try {
    const { validateAllSources } = await import('../services/source-validation.js');
    res.json(await validateAllSources({ limit: Math.min(200, Number(req.query.limit) || 200) }));
  } catch (e) { next(e); }
});

/** Which sources are trustworthy, without spending anything. */
r.get('/news/sources', async (req, res, next) => {
  try {
    const m = await import('../services/source-validation.js');
    res.json({ ...m.sourceStatus(), trusted: m.trustedHandles({}) });
  } catch (e) { next(e); }
});

/** How much the compute cache is saving. */
r.get('/system/cache', async (req, res, next) => {
  try {
    const { cacheStatus } = await import('../services/compute-cache.js');
    res.json(cacheStatus());
  } catch (e) { next(e); }
});

/* ------------------------------------------------- press conferences */

/** Resolve and validate every team YouTube channel. */
r.post('/press/channels', async (req, res, next) => {
  try {
    const { resolveAllChannels } = await import('../services/press-conference.js');
    res.json(await resolveAllChannels());
  } catch (e) { next(e); }
});

/** Discover recent videos and transcribe the press conferences among them. */
r.post('/press/ingest', async (req, res, next) => {
  try {
    const m = await import('../services/press-conference.js');
    const teams = req.query.team ? [req.query.team]
      : Object.keys(m.TEAM_CHANNEL_HANDLES).slice(0, Number(req.query.limit) || 8);
    const out = [];
    for (const t of teams) {
      const d = await m.discoverVideos(t);
      if (d.error) { out.push({ team: t, error: d.error }); continue; }
      let transcribed = 0, statements = 0;
      for (const v of (d.found ?? []).filter(x => x.is_presser).slice(0, 2)) {
        const tr = await m.fetchTranscript(v.video_id);
        if (tr.error) continue;
        transcribed++;
        statements += (m.extractAvailability(v.video_id).statements ?? 0);
      }
      out.push({ team: t, videos: d.videos, pressers: d.pressers, transcribed, statements });
    }
    res.json({ teams: out, status: m.pressStatus() });
  } catch (e) { next(e); }
});

/** What coaches have said about availability, by team. */
r.get('/press/:team', async (req, res, next) => {
  try {
    const { pressAvailabilityFor } = await import('../services/press-conference.js');
    res.json(pressAvailabilityFor(req.params.team, { days: Number(req.query.days) || 14 }));
  } catch (e) { next(e); }
});

/** Pipeline status, including whether transcription is even possible here. */
r.get('/press', async (req, res, next) => {
  try {
    const m = await import('../services/press-conference.js');
    res.json({ ...m.pressStatus(), transcript_tool: await m.transcriptToolAvailable() });
  } catch (e) { next(e); }
});

export default r;

/* ------------------------------------------------- spread context + reasoning */

/** One team's relationship with the number, cutoff-safe. */
r.get('/ats/:team', (req, res, next) => {
  try {
    const season = Number(req.query.season) || new Date().getFullYear();
    res.json(atsProfile(String(req.params.team).toUpperCase(), season, {
      throughWeek: Number(req.query.week) || null,
      lookback: Number(req.query.lookback) || null
    }));
  } catch (e) { next(e); }
});

/** Whether a team's record is keeping up with how it has played. */
r.get('/efficiency/:team', (req, res, next) => {
  try {
    const season = Number(req.query.season) || new Date().getFullYear();
    res.json(efficiencyGap(String(req.params.team).toUpperCase(), season, {
      throughWeek: Number(req.query.week) || null
    }));
  } catch (e) { next(e); }
});

/** Everything about one matchup, assembled for a reasoning trace. */
r.get('/spread-context/:season/:week/:home/:away', (req, res, next) => {
  try {
    res.json(spreadContext(Number(req.params.season), Number(req.params.week),
      String(req.params.home).toUpperCase(), String(req.params.away).toUpperCase(),
      { lookback: Number(req.query.lookback) || null }));
  } catch (e) { next(e); }
});

/** The same context aimed at a fantasy lineup rather than at a bet. */
r.get('/fantasy-context/:season/:week/:team', (req, res, next) => {
  try {
    res.json(fantasyContext(String(req.params.team).toUpperCase(),
      Number(req.params.season), Number(req.params.week)));
  } catch (e) { next(e); }
});

/**
 * Every pick of one week, in English.
 *
 * Separates what CAUSED the number — component models and their weights, which
 * is exact arithmetic on a weighted mean — from what was merely true at the
 * time, which the model never read.
 */
r.get('/reasoning/:season/:week', async (req, res, next) => {
  try {
    const season = Number(req.params.season), week = Number(req.params.week);
    if (!Number.isInteger(season) || !Number.isInteger(week)) {
      return res.status(400).json({ error: 'season and week must be integers' });
    }
    const { replaySeason } = await import('../services/nfl-replay.js');
    const { ensembleLine } = await import('../services/nfl-ensemble.js');
    const replay = replaySeason(season, { startWeek: week, endWeek: week });
    if (replay.error) return res.status(404).json({ error: replay.error });

    const modelsByGame = new Map();
    for (const b of replay.bets) {
      const key = `${b.home}|${b.away}`;
      if (modelsByGame.has(key)) continue;
      try {
        const line = ensembleLine(season, week, b.home, b.away, { includeEvidence: false });
        if (!line.error) modelsByGame.set(key, line.models);
      } catch { /* explained without attribution rather than not at all */ }
    }
    res.json({ season, week, ...explainWeek(replay.bets, { modelsByGame }) });
  } catch (e) { next(e); }
});

/** Explain a single supplied pick, for inspecting one decision. */
r.post('/reasoning/explain', (req, res, next) => {
  try {
    const out = explainPickTrace(req.body?.pick, { models: req.body?.models ?? null });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------ football-first model */

/** The football read on one game, decomposed into the facts that produced it. */
r.get('/football-first/:season/:week/:home/:away', (req, res, next) => {
  try {
    const season = Number(req.params.season), week = Number(req.params.week);
    const home = String(req.params.home).toUpperCase(), away = String(req.params.away).toUpperCase();
    const lean = footballFirstLean(season, week, home, away);
    res.json({
      ...lean,
      confidence: lean.abstains || lean.error ? null : pickConfidence({
        season, market: 'spread',
        model_margin: (lean.market_number ?? 0) + (lean.lean_points ?? 0),
        market_margin: lean.market_number ?? 0
      }, { season }),
      football: footballContext(season, week, home, away)
    });
  } catch (e) { next(e); }
});

/**
 * Which football facts the fit currently weights, and how heavily.
 *
 * The fit walks about a thousand games and computes injury, efficiency and
 * tendency features for each, which takes roughly ninety seconds cold. Doing
 * that inside a request handler blocks the entire Node event loop for that
 * whole time — the page never loads, and neither does anything else on the
 * server. It is cached after the first run, but somebody has to pay for the
 * first run and it must not be a web request.
 *
 * So this answers immediately either way: the cached coefficients if they exist,
 * or an honest "not computed yet" plus the command that computes it. No fake
 * progress bar over work that has not started.
 */
r.get('/football-first/coefficients', (req, res, next) => {
  try {
    const season = Number(req.query.season) || new Date().getFullYear();
    const cachedFit = peekResidualModel(season, 'margin');
    if (cachedFit) return res.json({ ...cachedFit, features: FF_FEATURES, cached: true });
    res.status(202).json({
      fitted: false, computing: false, features: FF_FEATURES, season,
      why: 'The coefficient fit has not been computed for this season yet. It walks about a ' +
        'thousand games building injury, efficiency and tendency features and takes roughly ninety ' +
        'seconds, which is far too long to hold a request open — doing it here would block every ' +
        'other route on the server for the duration.',
      how: 'POST /api/nfl-betting/football-first/fit to compute and cache it once.'
    });
  } catch (e) { next(e); }
});

/** Compute the fit once, deliberately out of band. */
r.post('/football-first/fit', (req, res, next) => {
  try {
    const season = Number(req.body?.season) || new Date().getFullYear();
    const started = Date.now();
    const m = residualModel(season, 'margin');
    res.json({ ...m, features: FF_FEATURES, took_ms: Date.now() - started });
  } catch (e) { next(e); }
});

/** The weekly walk-forward: refit every week, predict the next. */
r.get('/walk-forward', (req, res, next) => {
  try {
    res.json(walkForward({
      minLean: Math.max(0.25, Math.min(5, Number(req.query.min_lean) || 1.0))
    }));
  } catch (e) { next(e); }
});

/** Whether the confidence number means what it says. */
r.get('/confidence/calibration', (_req, res, next) => {
  try { res.json(confidenceCalibration({})); } catch (e) { next(e); }
});

/** Quarterback room and replacement value for one team. */
r.get('/quarterback/:season/:week/:team', (req, res, next) => {
  try {
    res.json(quarterbackPicture(String(req.params.team).toUpperCase(),
      Number(req.params.season), Number(req.params.week)));
  } catch (e) { next(e); }
});

/** How much of last season's production is still on a roster. */
r.get('/continuity/:season/:team', (req, res, next) => {
  try {
    res.json(rosterContinuity(String(req.params.team).toUpperCase(), Number(req.params.season)));
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------- forward ledger */

/** The running forward record — the only evidence that cannot be re-sliced. */
r.get('/forward', (req, res, next) => {
  try {
    res.json(forwardLedger({
      source: req.query.source ?? null,
      season: Number(req.query.season) || null
    }));
  } catch (e) { next(e); }
});

/** Log this week's leans before kickoff. */
r.post('/forward/record', async (req, res, next) => {
  try {
    const season = Number(req.body?.season);
    const week = Number(req.body?.week);
    if (!Number.isInteger(season) || !Number.isInteger(week)) {
      return res.status(400).json({ error: 'season and week are required integers' });
    }
    res.json(await recordThisWeek({ season, week,
      minLean: Math.max(0.25, Math.min(5, Number(req.body?.min_lean) || 1.0)) }));
  } catch (e) { next(e); }
});

/** Grade everything that has finished. */
r.post('/forward/settle', (_req, res, next) => {
  try { res.json(settleForwardPicks()); } catch (e) { next(e); }
});
