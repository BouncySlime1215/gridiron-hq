import { Router } from 'express';
import { syncSeason, syncSeasonSchedule, syncPitcherGameLogs, syncBatterGameLogs, coverage } from '../services/mlb.js';
import { boardFor as firstPartyBoard, coverage as projCoverage } from '../services/mlb-projections.js';
import { ensurePicksFor, allPicks, standing as picksStanding, backfill, modelAudit } from '../services/mlb-auto-picks.js';
import { refreshInBackground, schedulerStatus, runIfStale } from '../services/scheduler.js';

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
    const date = String(req.query.date ?? new Date().toISOString().slice(0, 10));
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
    const date = String(req.query.date ?? new Date().toISOString().slice(0, 10));
    const locked = ensurePicksFor(date, Number(req.query.n) || 5);
    const slateDate = locked[0]?.pick_date ?? null;
    // Grade the current slate too — ensurePicksFor returns raw rows, so reusing
    // the graded list keeps the status column from rendering blank.
    const graded = allPicks();
    res.json({
      requested_date: date,
      slate_date: slateDate,
      today: graded.filter(p => p.pick_date === slateDate),
      history: graded,
      standing: picksStanding()
    });
  } catch (e) { next(e); }
});

/** Generates picks for recent past dates so the record is not empty on day one. */
r.post('/auto-picks/backfill', (req, res, next) => {
  try { res.json(backfill(Number(req.query.days) || 14)); } catch (e) { next(e); }
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
