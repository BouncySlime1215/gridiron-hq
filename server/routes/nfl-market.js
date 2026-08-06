import { Router } from 'express';
import { boardFor, accuracy, predictGame, clearNflMarketCache } from '../services/nfl-market.js';
import { syncCurrentLines } from '../services/gamescript.js';
import { autoPickDecisionBoard, persistPickDecisions, ensurePicksFor, pickResultsFor, allPickResults, standing } from '../services/nfl-auto-picks.js';
import { NFL_PRODUCTION_POLICY } from '../services/nfl-policy.js';
import { closingLineValue } from '../services/line-shopping.js';
import { latestTrainingAudit } from '../services/nfl-replay.js';
import { nflOperations, runNflFeatureAblations, refreshNflResidualAudit } from '../services/nfl-research.js';
import { promoteEligibleAudit } from '../services/model-governance.js';
import { runEvidenceDaemon, evidenceDaemonStatus } from '../services/evidence-daemon.js';
import { nflIntelligence } from '../services/model-intelligence.js';

const r = Router();
const SEASON = Number(process.env.NFL_SEASON) || 2026;

r.get('/board', (req, res, next) => {
  try {
    const season = Number(req.query.season) || SEASON;
    const week = Number(req.query.week) || 1;
    const out = boardFor(season, week);
    if (out?.error) return res.status(409).json(out);
    res.json({ season, week, board: out });
  } catch (e) { next(e); }
});

r.get('/accuracy', (req, res, next) => {
  try { res.json(accuracy()); } catch (e) { next(e); }
});

r.get('/operations', (_req, res, next) => {
  try { res.json(nflOperations()); } catch (e) { next(e); }
});

r.get('/intelligence', (_req, res, next) => {
  try { res.json(nflIntelligence()); } catch (e) { next(e); }
});

r.get('/evidence/status', (_req, res, next) => {
  try { res.json(evidenceDaemonStatus()); } catch (e) { next(e); }
});

r.post('/evidence/capture', async (req, res, next) => {
  try { res.json(await runEvidenceDaemon({ force: req.query.force === '1' })); } catch (e) { next(e); }
});

r.post('/operations/audit', (_req, res, next) => {
  try { res.json(nflOperations({ persist: true })); } catch (e) { next(e); }
});

r.post('/operations/residual', (_req, res, next) => {
  try { res.json(refreshNflResidualAudit()); } catch (e) { next(e); }
});

r.post('/operations/ablations', (req, res, next) => {
  try {
    const seasons = Array.isArray(req.body?.seasons) ? req.body.seasons.map(Number) : [2021, 2022, 2023, 2024, 2025];
    res.json(runNflFeatureAblations(seasons));
  } catch (e) { next(e); }
});

r.post('/operations/promote/:auditId', (req, res, next) => {
  try { res.json(promoteEligibleAudit(req.params.auditId, 'NFL')); } catch (e) { next(e); }
});

r.get('/predict', (req, res, next) => {
  try {
    const { home, away } = req.query;
    if (!home || !away) return res.status(400).json({ error: 'home and away query params required' });
    res.json(predictGame(String(home), String(away)));
  } catch (e) { next(e); }
});

r.get('/picks/history', (req, res, next) => {
  try { res.json({ results: allPickResults(), standing: standing() }); } catch (e) { next(e); }
});

r.get('/picks', (req, res, next) => {
  try {
    const season = Number(req.query.season) || SEASON;
    const week = Number(req.query.week) || 1;
    res.json({ season, week, picks: pickResultsFor(season, week), standing: standing() });
  } catch (e) { next(e); }
});

/** Current production-policy candidates without locking or mutating the slate. */
r.get('/picks/candidates', (req, res, next) => {
  try {
    const season = Number(req.query.season) || SEASON;
    const week = Number(req.query.week) || 1;
    const decisionBoard = autoPickDecisionBoard(season, week);
    const evidence = latestTrainingAudit();
    res.json({
      season, week, candidates: decisionBoard.selected,
      abstentions: decisionBoard.decisions.filter(d => !d.eligible),
      policy: decisionBoard.policy,
      clv: closingLineValue(),
      evidence,
      evidence_status: evidence ? 'not_proven' : 'requires_exact_replay',
      evidence_note: evidence
        ? 'The exact-policy interval crosses zero. Require 2026 forward evidence and CLV before calling an edge proven.'
        : 'The prior five-season ROI came from a non-parity replay and is retired. Rerun the exact versioned policy.'
    });
  } catch (e) { next(e); }
});

/**
 * The weekly workflow: refresh every current-season line (which is also how last
 * week's final scores arrive), grade whatever picks are now settled, then lock in
 * this week's 5 most confident spread edges as new straight bets. Simulation
 * trial count is generous (default 20k per bet) since "how many scenarios were
 * actually run" is the honesty check on this button, not a number to shortcut.
 */
r.post('/sync-and-pick', async (req, res, next) => {
  try {
    const season = Number(req.query.season) || SEASON;
    const week = Number(req.query.week) || 1;
    const trials = Number(req.query.trials) || 20000;

    const synced = await syncCurrentLines(season, 18);
    clearNflMarketCache();

    const lastWeek = week - 1;
    const lastWeekResults = lastWeek >= 1 ? pickResultsFor(season, lastWeek) : [];

    const decisionBoard = autoPickDecisionBoard(season, week);
    const decisionAudit = persistPickDecisions(season, week, decisionBoard);
    const candidates = decisionBoard.selected;
    const newPicks = ensurePicksFor(season, week, candidates, NFL_PRODUCTION_POLICY.maxPicksPerWeek);

    res.json({
      season, week, trials, synced,
      last_week: { week: lastWeek, results: lastWeekResults },
      policy: decisionBoard.policy,
      decision_audit: decisionAudit,
      eligible_candidates: candidates.length, new_picks: newPicks,
      standing: standing()
    });
  } catch (e) { next(e); }
});

export default r;
