import { Router } from 'express';
import { cached, fingerprint } from '../services/compute-cache.js';
import { boardFor, accuracy, predictGame, clearNflMarketCache } from '../services/nfl-market.js';
import { syncCurrentLines } from '../services/gamescript.js';
import { autoPickDecisionBoard, persistPickDecisions, ensurePicksFor, pickResultsFor, allPickResults, standing } from '../services/nfl-auto-picks.js';
import { addUserBet, removeUserBet, userBetsFor, allUserBets, userBetsStanding } from '../services/nfl-user-bets.js';
import { NFL_PRODUCTION_POLICY } from '../services/nfl-policy.js';
import { closingLineValue } from '../services/line-shopping.js';
import { latestTrainingAudit } from '../services/nfl-replay.js';
import { nflOperations, runNflFeatureAblations, refreshNflResidualAudit } from '../services/nfl-research.js';
import { promoteEligibleAudit } from '../services/model-governance.js';
import { runEvidenceDaemon, evidenceDaemonStatus } from '../services/evidence-daemon.js';
import { sportsGameOddsSnapshotStatus, captureSportsGameOddsSnapshot } from '../services/sportsgameodds.js';
import { bookFeedStatus, captureBookFeeds } from '../services/book-feeds.js';
import { propFeedStatus, capturePropFeeds } from '../services/prop-feeds.js';
import { polymarketMovement, refreshPolymarketLineWatch } from '../services/polymarket-lines.js';
import { reportCacheStatus, refreshReport, serveReport } from '../services/report-cache.js';
import { oddsArchiveStatus, backfillOddsArchive } from '../services/odds-archive.js';
import { beatTheCloseStatus, runBeatTheClose, weeklyRead } from '../services/beat-the-close.js';
import { verifyForwardEvidence } from '../services/nfl-evidence-provenance.js';
import { nflIntelligence } from '../services/model-intelligence.js';
import { nflEvidenceCoverage } from '../services/nfl-evidence.js';
import { currentNflWeek } from '../services/weekly-learning.js';
import { requireModelPermission } from '../modeling/authz.js';
import { recordModelAudit } from '../modeling/sqlite-store.js';
import { db } from '../db/index.js';

const r = Router();
const SEASON = Number(process.env.NFL_SEASON) || 2026;

r.get('/board', (req, res, next) => {
  try {
    const season = Number(req.query.season) || SEASON;
    // Default to the live week (first week with an unplayed game), not Week 1 forever.
    const week = Number(req.query.week) || currentNflWeek(season).week;
    const out = boardFor(season, week);
    if (out?.error) return res.status(409).json(out);
    res.json({ season, week, board: out });
  } catch (e) { next(e); }
});

r.get('/accuracy', (req, res, next) => {
  try {
    // 26 seconds cold: a nested rolling holdout across five seasons, recomputed
    // on every hub load. It is a pure function of the games and features it
    // reads, so it only has to run again when those change.
    res.json(cached('nfl_market_accuracy',
      fingerprint([{ table: 'game_lines', stamp: 'fetched_at' }, 'nfl_team_week_features']),
      () => accuracy()));
  } catch (e) { next(e); }
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

r.get('/evidence/coverage', (_req, res, next) => {
  try { res.json(nflEvidenceCoverage()); } catch (e) { next(e); }
});

r.post('/evidence/capture', requireModelPermission('model:train'), async (req, res, next) => {
  try { res.json(await runEvidenceDaemon({ force: req.query.force === '1' })); } catch (e) { next(e); }
});

r.get('/evidence/sgo-status', (_req, res, next) => {
  try { res.json(sportsGameOddsSnapshotStatus()); } catch (e) { next(e); }
});

r.get('/evidence/book-feeds', (_req, res, next) => {
  try { res.json(bookFeedStatus()); } catch (e) { next(e); }
});

r.post('/evidence/book-feeds/capture', requireModelPermission('model:train'), async (_req, res, next) => {
  try { res.json(await captureBookFeeds()); } catch (e) { next(e); }
});

r.get('/evidence/prop-feeds', (_req, res, next) => {
  try { res.json(propFeedStatus()); } catch (e) { next(e); }
});

r.post('/evidence/prop-feeds/capture', requireModelPermission('model:train'), async (req, res, next) => {
  try { res.json(await capturePropFeeds({ week: req.query.week ? Number(req.query.week) : null })); } catch (e) { next(e); }
});

/** Every timestamp inside a frozen forward payload must precede its kickoff cutoff. */
r.get('/evidence/provenance', (req, res, next) => {
  try {
    res.json(verifyForwardEvidence({ season: req.query.season ? Number(req.query.season) : null,
      week: req.query.week ? Number(req.query.week) : null }));
  } catch (e) { next(e); }
});

r.get('/reports', (_req, res, next) => {
  try { res.json(reportCacheStatus()); } catch (e) { next(e); }
});

r.post('/reports/:name/refresh', requireModelPermission('model:train'), (req, res, next) => {
  try {
    refreshReport(req.params.name, { force: true }).catch(() => {});
    res.status(202).json({ queued: true, report: req.params.name });
  } catch (e) { next(e); }
});

/** Beat the close, Phase 2: live signal snapshots and the zero-unit shadow rule, graded by CLV. */
r.get('/beat-the-close', (_req, res, next) => {
  try { res.json(beatTheCloseStatus()); } catch (e) { next(e); }
});
r.post('/beat-the-close/run', requireModelPermission('model:train'), (_req, res, next) => {
  try { res.json(runBeatTheClose()); } catch (e) { next(e); }
});
r.get('/beat-the-close/weekly/:season/:week', (req, res, next) => {
  try { res.json(weeklyRead(Number(req.params.season), Number(req.params.week))); } catch (e) { next(e); }
});

/** Beat the close, Phase 1: served from the worker store; never computed on a request. */
r.get('/line-move-study', (_req, res, next) => {
  try { res.json(serveReport('line_move_study')); } catch (e) { next(e); }
});

r.get('/odds-archive', (_req, res, next) => {
  try { res.json(oddsArchiveStatus()); } catch (e) { next(e); }
});

/** Historical per-book opening and closing quotes for 2022-2025; runs in the background and answers at once. */
let archiveJob = null;
r.post('/odds-archive/backfill', requireModelPermission('model:train'), (req, res, next) => {
  try {
    if (archiveJob) return res.status(202).json({ running: true, ...archiveJob.progress });
    const seasons = Array.isArray(req.body?.seasons) ? req.body.seasons.map(Number) : [2022, 2023, 2024, 2025];
    archiveJob = { progress: { seasons, started_at: new Date().toISOString() } };
    backfillOddsArchive({ seasons, onProgress: p => { archiveJob.progress = { ...archiveJob.progress, ...p }; } })
      .then(result => { archiveJob = null; console.log('[odds-archive] backfill', JSON.stringify(result).slice(0, 400)); })
      .catch(error => { archiveJob = null; console.error('[odds-archive] backfill failed', error.message); });
    res.status(202).json({ queued: true, seasons });
  } catch (e) { next(e); }
});
r.get('/odds-archive/progress', (_req, res) => res.json(archiveJob ? { running: true, ...archiveJob.progress } : { running: false }));

r.get('/polymarket/lines', (req, res, next) => {
  try { res.json(polymarketMovement({ hours: Number(req.query.hours) || 168 })); } catch (e) { next(e); }
});

r.post('/polymarket/lines/poll', requireModelPermission('model:train'), async (_req, res, next) => {
  try { res.json(await refreshPolymarketLineWatch()); } catch (e) { next(e); }
});

r.post('/evidence/sgo-capture', requireModelPermission('model:train'), async (_req, res, next) => {
  try { res.json(await captureSportsGameOddsSnapshot()); } catch (e) { next(e); }
});

r.post('/operations/audit', requireModelPermission('model:train'), (_req, res, next) => {
  try { res.json(nflOperations({ persist: true })); } catch (e) { next(e); }
});

r.post('/operations/residual', requireModelPermission('model:train'), (_req, res, next) => {
  try { res.json(refreshNflResidualAudit()); } catch (e) { next(e); }
});

r.post('/operations/ablations', requireModelPermission('model:train'), (req, res, next) => {
  try {
    const seasons = Array.isArray(req.body?.seasons) ? req.body.seasons.map(Number) : [2021, 2022, 2023, 2024, 2025];
    res.json(runNflFeatureAblations(seasons));
  } catch (e) { next(e); }
});

r.post('/operations/promote/:auditId', requireModelPermission('model:promote'), (req, res, next) => {
  try {
    const out = promoteEligibleAudit(req.params.auditId, 'NFL');
    recordModelAudit(db, req.modelPrincipal, 'legacy_audit.promote', 'nfl_gate_audit', req.params.auditId, out);
    res.json(out);
  } catch (e) { next(e); }
});

r.get('/predict', (req, res, next) => {
  try {
    const { home, away, season } = req.query;
    if (!home || !away) return res.status(400).json({ error: 'home and away query params required' });
    res.json(predictGame(String(home), String(away), season != null ? Number(season) : null));
  } catch (e) { next(e); }
});

r.get('/picks/history', (req, res, next) => {
  try { res.json({ results: allPickResults(), standing: standing() }); } catch (e) { next(e); }
});

r.get('/picks', (req, res, next) => {
  try {
    const season = Number(req.query.season) || SEASON;
    // Default to the live week (first week with an unplayed game), not Week 1 forever.
    const week = Number(req.query.week) || currentNflWeek(season).week;
    res.json({ season, week, picks: pickResultsFor(season, week), standing: standing() });
  } catch (e) { next(e); }
});

/** Current production-policy candidates without locking or mutating the slate. */
r.get('/picks/candidates', (req, res, next) => {
  try {
    const season = Number(req.query.season) || SEASON;
    // Default to the live week (first week with an unplayed game), not Week 1 forever.
    const week = Number(req.query.week) || currentNflWeek(season).week;
    const decisionBoard = autoPickDecisionBoard(season, week);
    const evidence = latestTrainingAudit();
    res.json({
      season, week, candidates: decisionBoard.selected,
      abstentions: decisionBoard.decisions.filter(d => !d.eligible),
      // Every game on the slate, model confidence included, whether or not it
      // cleared the policy's edge/disagreement bar to become a "pick". The
      // curated 5-a-week candidates list is the model's own best-conviction
      // subset; this is the full board for a user who wants to see and
      // decide on every game themselves, confidence included.
      all_games: decisionBoard.decisions.map(d => ({
        matchup: d.matchup, market: d.market, selection: d.selection, side: d.side,
        home_team: d.home_team, away_team: d.away_team, line: d.line,
        american_price: d.american_price, model_probability: d.model_probability,
        implied_probability: d.implied_probability, edge: d.probability_difference,
        edge_points: d.edge_points, disagreement: d.disagreement,
        eligible: d.eligible, is_pick: decisionBoard.selected.some(s => s.matchup === d.matchup && s.market === d.market),
        detail: d.detail
      })),
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

/** Every game the user has chosen to track as their own bet, this week, graded. */
r.get('/bets', (req, res, next) => {
  try {
    const season = Number(req.query.season) || SEASON;
    // Default to the live week (first week with an unplayed game), not Week 1 forever.
    const week = Number(req.query.week) || currentNflWeek(season).week;
    res.json({ season, week, bets: userBetsFor(season, week), standing: userBetsStanding() });
  } catch (e) { next(e); }
});

r.get('/bets/history', (req, res, next) => {
  try { res.json({ bets: allUserBets(), standing: userBetsStanding() }); } catch (e) { next(e); }
});

/** Track any game from the full slate as the user's own bet — separate from the model's curated auto-picks. */
r.post('/bets', requireModelPermission('model:execute'), (req, res, next) => {
  try {
    const season = Number(req.body?.season) || SEASON;
    const week = Number(req.body?.week) || 1;
    res.json(addUserBet(season, week, req.body ?? {}));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

r.delete('/bets/:id', requireModelPermission('model:execute'), (req, res, next) => {
  try { res.json(removeUserBet(Number(req.params.id))); } catch (e) { next(e); }
});

/**
 * The weekly workflow: refresh every current-season line (which is also how last
 * week's final scores arrive), grade whatever picks are now settled, then lock in
 * this week's 5 most confident spread edges as new straight bets. Simulation
 * trial count is generous (default 20k per bet) since "how many scenarios were
 * actually run" is the honesty check on this button, not a number to shortcut.
 */
r.post('/sync-and-pick', requireModelPermission('model:execute'), async (req, res, next) => {
  try {
    const season = Number(req.query.season) || SEASON;
    // Default to the live week (first week with an unplayed game), not Week 1 forever.
    const week = Number(req.query.week) || currentNflWeek(season).week;
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
