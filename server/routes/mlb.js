import { Router } from 'express';
import { syncSeason, syncSeasonSchedule, syncPitcherGameLogs, syncBatterGameLogs, coverage } from '../services/mlb.js';
import { boardFor as firstPartyBoard, coverage as projCoverage } from '../services/mlb-projections.js';
import { ensurePicksFor, allPicks, standing as picksStanding, backfill, modelAudit } from '../services/mlb-auto-picks.js';
import { refreshInBackground, schedulerStatus, runIfStale } from '../services/scheduler.js';
import { captureMlbPregame, mlbPregameCoverage } from '../services/mlb-pregame.js';
import { usage as oddsUsage } from '../services/odds-api.js';
import { createMlbExperiment, listMlbExperiments, getMlbExperiment, runMlbExperimentStage } from '../services/mlb-experiments.js';
import { appDate } from '../services/date-util.js';

const r = Router();

/** Games + first-inning results + both game-log tables for one season. */
r.post('/sync', async (req, res, next) => {
  try {
    const season = Number(req.query.season);
    if (!season) return res.status(400).json({ error: 'season query param required' });
    res.json(await syncSeason(season));
  } catch (e) { next(e); }
});

r.post('/sync/schedule', async (req, res, next) => {
  try { res.json(await syncSeasonSchedule(Number(req.query.season))); } catch (e) { next(e); }
});
r.post('/sync/pitchers', async (req, res, next) => {
  try { res.json(await syncPitcherGameLogs(Number(req.query.season))); } catch (e) { next(e); }
});
r.post('/sync/batters', async (req, res, next) => {
  try { res.json(await syncBatterGameLogs(Number(req.query.season))); } catch (e) { next(e); }
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

/**
 * First-party auto-picks: generated from local projections, graded against
 * local box scores. Nothing here depends on an external pipeline.
 */
r.get('/auto-picks', (req, res, next) => {
  try {
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

r.get('/pregame/status', (_req, res, next) => {
  try { res.json({ ...mlbPregameCoverage(), odds_api: oddsUsage() }); } catch (e) { next(e); }
});

r.post('/pregame/snapshot', async (req, res, next) => {
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
r.post('/experiments', (req, res, next) => {
  try { res.status(201).json(createMlbExperiment(req.body ?? {})); } catch (e) { next(e); }
});
r.post('/experiments/:id/:stage', (req, res, next) => {
  try { res.json(runMlbExperimentStage(req.params.id, req.params.stage)); } catch (e) { next(e); }
});

/** Generates picks for recent past dates so the record is not empty on day one. */
r.post('/auto-picks/backfill', (req, res, next) => {
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
r.post('/sync/now', async (req, res, next) => {
  try {
    const job = String(req.query.job ?? 'mlb_schedule');
    res.json(await runIfStale(job, { force: true }));
  } catch (e) { next(e); }
});

export default r;
