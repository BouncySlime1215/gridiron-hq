import { Router } from 'express';
import { syncSeason, syncSeasonSchedule, syncPitcherGameLogs, syncBatterGameLogs, syncFinalBoxscores, coverage } from '../services/mlb.js';
import { boardFor as firstPartyBoard, coverage as projCoverage } from '../services/mlb-projections.js';
import { ensurePicksFor, allPicks, standing as picksStanding, backfill, modelAudit, auditCandidateDecisions } from '../services/mlb-auto-picks.js';
import { refreshInBackground, schedulerStatus, runIfStale } from '../services/scheduler.js';
import { captureMlbPregame, mlbPregameCoverage } from '../services/mlb-pregame.js';
import { usage as oddsUsage } from '../services/odds-api.js';
import { createMlbExperiment, listMlbExperiments, getMlbExperiment, runMlbExperimentStage } from '../services/mlb-experiments.js';
import { appDate } from '../services/date-util.js';
import { mlbOperations } from '../services/mlb-research.js';
import { promoteEligibleAudit } from '../services/model-governance.js';
import { buildMlbCalibration, mlbCalibrations } from '../services/mlb-calibration.js';
import { runEvidenceDaemon, evidenceDaemonStatus } from '../services/evidence-daemon.js';
import { mlbIntelligence } from '../services/model-intelligence.js';
import { requireModelPermission } from '../modeling/authz.js';
import { recordModelAudit } from '../modeling/sqlite-store.js';
import { db } from '../db/index.js';

const r = Router();

/** Games + first-inning results + both game-log tables for one season. */
r.post('/sync', requireModelPermission('model:train'), async (req, res, next) => {
  try {
    const season = Number(req.query.season);
    if (!season) return res.status(400).json({ error: 'season query param required' });
    res.json(await syncSeason(season));
  } catch (e) { next(e); }
});

r.post('/sync/schedule', requireModelPermission('model:train'), async (req, res, next) => {
  try { res.json(await syncSeasonSchedule(Number(req.query.season))); } catch (e) { next(e); }
});
r.post('/sync/pitchers', requireModelPermission('model:train'), async (req, res, next) => {
  try { res.json(await syncPitcherGameLogs(Number(req.query.season))); } catch (e) { next(e); }
});
r.post('/sync/batters', requireModelPermission('model:train'), async (req, res, next) => {
  try { res.json(await syncBatterGameLogs(Number(req.query.season))); } catch (e) { next(e); }
});
r.post('/sync/boxscores', requireModelPermission('model:train'), async (req, res, next) => {
  try {
    const date = String(req.query.date ?? appDate());
    res.json(await syncFinalBoxscores(date));
  } catch (e) { next(e); }
});

/** Row counts per season across all three tables — the honest "how much training data" check. */
r.get('/status', (req, res, next) => {
  try { res.json(coverage()); } catch (e) { next(e); }
});

/**
 * The first-party board — built from this project's own ingestion rather than a
 * proxied feed, so it cannot silently go stale when someone else's pipeline
 * stops running.
 */
r.get('/board', (req, res, next) => {
  try {
    // Kick a refresh if the schedule is stale. Fire-and-forget, so this request
    // still answers immediately from what is already stored.
    refreshInBackground(['mlb_schedule']);
    const date = String(req.query.date ?? appDate());
    res.json(firstPartyBoard(date, { limit: Number(req.query.limit) || 40 }));
  } catch (e) { next(e); }
});

r.get('/coverage', (req, res, next) => {
  try { res.json(projCoverage()); } catch (e) { next(e); }
});

r.get('/model/accuracy', (req, res, next) => {
  try {
    const through = String(req.query.through ?? new Date().toISOString().slice(0, 10));
    const season = Number(req.query.season) || Number(through.slice(0, 4));
    res.json(modelAudit(season, through, {
      lookbackDays: Number(req.query.lookback_days) || 120,
      cadenceDays: Number(req.query.cadence_days) || 7
    }));
  } catch (e) { next(e); }
});

r.get('/operations', (req, res, next) => {
  try { res.json(mlbOperations({ throughDate: String(req.query.through ?? appDate()) })); } catch (e) { next(e); }
});

r.get('/intelligence', (_req, res, next) => {
  try { res.json(mlbIntelligence()); } catch (e) { next(e); }
});

r.get('/evidence/status', (_req, res, next) => {
  try { res.json(evidenceDaemonStatus()); } catch (e) { next(e); }
});

r.post('/evidence/capture', requireModelPermission('model:train'), async (req, res, next) => {
  try { res.json(await runEvidenceDaemon({ force: req.query.force === '1' })); } catch (e) { next(e); }
});

r.get('/model/calibrations', (req, res, next) => {
  try { res.json({ calibrations: mlbCalibrations(String(req.query.before ?? appDate())) }); } catch (e) { next(e); }
});

r.post('/model/calibrations/:market', requireModelPermission('model:train'), (req, res, next) => {
  try { res.json(buildMlbCalibration(String(req.params.market), String(req.query.through ?? appDate()))); } catch (e) { next(e); }
});

r.post('/operations/audit', requireModelPermission('model:train'), (req, res, next) => {
  try { res.json(mlbOperations({ throughDate: String(req.query.through ?? appDate()), persist: true })); } catch (e) { next(e); }
});

r.post('/operations/promote/:auditId', requireModelPermission('model:promote'), (req, res, next) => {
  try {
    const out = promoteEligibleAudit(req.params.auditId, 'MLB');
    recordModelAudit(db, req.modelPrincipal, 'legacy_audit.promote', 'mlb_gate_audit', req.params.auditId, out);
    res.json(out);
  } catch (e) { next(e); }
});

/**
 * First-party auto-picks: generated from local projections, graded against
 * local box scores. Nothing here depends on an external pipeline.
 */
r.get('/auto-picks', requireModelPermission('model:execute'), (req, res, next) => {
  try {
    // Read path stays instant; the prior completed slate settles in the
    // background so a missing player log cannot be misreported as a void.
    refreshInBackground(['mlb_boxscores']);
    const date = String(req.query.date ?? appDate());
    const locked = ensurePicksFor(date, Number(req.query.n) || 5);
    const slateDate = locked[0]?.pick_date ?? null;
    // Grade the current slate too — ensurePicksFor returns raw rows, so reusing
    // the graded list keeps the status column from rendering blank.
    const graded = allPicks();
    const visible = graded.filter(p => p.pick_date <= date);
    const standing = picksStanding(date);
    const odds = oddsUsage();
    res.json({
      requested_date: date,
      slate_date: slateDate,
      today: visible.filter(p => p.pick_date === slateDate),
      history: visible,
      standing,
      economics: {
        available: standing.priced_settled > 0,
        odds_feed: odds.has_key,
        note: standing.priced_settled > 0
          ? `${standing.priced_settled} forward picks have real stored prices; economics exclude every retrospective row.`
          : 'No settled forward pick has a real stored price. Win rate grades projection direction only; retrospective units and ROI remain unavailable.'
      }
    });
  } catch (e) { next(e); }
});

r.post('/auto-picks/audit-decisions', requireModelPermission('model:train'), (req, res, next) => {
  try { res.json(auditCandidateDecisions(String(req.query.date ?? appDate()))); } catch (e) { next(e); }
});

r.get('/pregame/status', (_req, res, next) => {
  try { res.json({ ...mlbPregameCoverage(), odds_api: oddsUsage() }); } catch (e) { next(e); }
});

r.post('/pregame/snapshot', requireModelPermission('model:train'), async (req, res, next) => {
  try {
    const date = String(req.query.date ?? appDate());
    res.json(await captureMlbPregame(date));
  } catch (e) { next(e); }
});

r.get('/experiments', (_req, res, next) => {
  try { res.json({ experiments: listMlbExperiments() }); } catch (e) { next(e); }
});
r.get('/experiments/:id', (req, res, next) => {
  try {
    const x = getMlbExperiment(req.params.id);
    if (!x) return res.status(404).json({ error: 'MLB experiment not found' });
    res.json(x);
  } catch (e) { next(e); }
});
r.post('/experiments', requireModelPermission('model:train'), (req, res, next) => {
  try { res.status(201).json(createMlbExperiment(req.body ?? {})); } catch (e) { next(e); }
});
r.post('/experiments/:id/:stage', requireModelPermission('model:train'), (req, res, next) => {
  try { res.json(runMlbExperimentStage(req.params.id, req.params.stage)); } catch (e) { next(e); }
});

/** Generates picks for recent past dates so the record is not empty on day one. */
r.post('/auto-picks/backfill', requireModelPermission('model:train'), (req, res, next) => {
  try {
    const through = req.query.through ? String(req.query.through) : undefined;
    res.json(backfill(Number(req.query.days) || 14, through));
  } catch (e) { next(e); }
});

/** What the background scheduler has done, and when. */
r.get('/sync/status', (req, res, next) => {
  try { res.json(schedulerStatus()); } catch (e) { next(e); }
});

/** Force a refresh now rather than waiting for the timer. */
r.post('/sync/now', requireModelPermission('model:train'), async (req, res, next) => {
  try {
    const job = String(req.query.job ?? 'mlb_schedule');
    res.json(await runIfStale(job, { force: true }));
  } catch (e) { next(e); }
});

export default r;
