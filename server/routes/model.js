/**
 * Prediction engine API.
 *
 * Exposes the projection model, its accuracy, the simulator and the supporting
 * estimates. Results that take real work — projections, correlation fits, season
 * simulations — are memoised per process, because the inputs only change on an
 * explicit sync.
 */
import { Router } from 'express';
import { db, row, rows, run } from '../db/index.js';
import { scoringFor, PPR } from '../services/scoring.js';
import { buildProjections, weeklyDistribution, seasonDistribution } from '../services/projections.js';
import { compare, actuals, gradePoint, gradeDistribution, baselines, weeklyDecisionBacktest } from '../services/backtest.js';
import { simulateSeason, tradeImpact } from '../services/season-sim.js';
import { fitCorrelations, correlationTable, clearCorrelationCache } from '../services/correlation.js';
import { fitGameScript, gameScriptFor, syncHistoricalLines, syncCurrentLines, linesFor, clearGameScriptCache } from '../services/gamescript.js';
import { availability, weeklyAvailability, cascades, handcuffValue } from '../services/contingency.js';
import { syncAll as syncNflverse, usageSeasons, usageFor } from '../services/nflverse.js';
import { clearMatchupCache } from '../services/matchups.js';
import { resolvePlayer, assetUniverse, loadRosters } from '../services/trade-engine.js';
import { deriveFormat } from '../services/format.js';
import { withRandomSeed } from '../services/stats-util.js';

const r = Router();
const SEASON = Number(process.env.NFL_SEASON) || 2026;

/* ------------------------------------------------------------------ cache */
const cache = new Map();
const memo = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};
export function clearModelCache() { cache.clear(); }

const league = (req, res) => {
  const id = req.params.leagueId ?? req.query.league_id;
  const lg = id ? row('SELECT * FROM leagues WHERE id = ?', id) : row('SELECT * FROM leagues ORDER BY id LIMIT 1');
  if (!lg) { res.status(404).json({ error: 'no league connected' }); return null; }
  return lg;
};

/* ------------------------------------------------------------ projections */

r.get('/projections', (req, res, next) => {
  try {
    const lg = row('SELECT * FROM leagues ORDER BY id LIMIT 1');
    const scoring = lg ? scoringFor(lg) : PPR;
    const through = Number(req.query.through) || SEASON - 1;
    const proj = memo(`proj:${through}:${JSON.stringify(scoring)}`, () => buildProjections({ through, scoring }));

    const pos = req.query.position;
    let list = [...proj.values()];
    if (pos) list = list.filter(p => p.position === String(pos).toUpperCase());
    list.sort((a, b) => b.points - a.points);
    res.json({
      through, season: SEASON, count: list.length,
      players: list.slice(0, Number(req.query.limit) || 300)
    });
  } catch (e) { next(e); }
});

/** Full distribution for one player — the percentiles behind a start/sit call. */
r.get('/projections/:playerId', (req, res, next) => {
  try {
    const lg = row('SELECT * FROM leagues ORDER BY id LIMIT 1');
    const scoring = lg ? scoringFor(lg) : PPR;
    const through = SEASON - 1;
    const proj = memo(`proj:${through}:${JSON.stringify(scoring)}`, () => buildProjections({ through, scoring }));

    let p = proj.get(Number(req.params.playerId));
    // Fall through the duplicate-row problem the same way the trade engine does.
    if (!p && lg?.payload) {
      const { formatKey } = deriveFormat(lg);
      const assets = assetUniverse(lg, formatKey);
      const resolved = resolvePlayer(req.params.playerId, assets, loadRosters(lg, assets));
      if (resolved) p = proj.get(resolved.id);
    }
    if (!p) return res.status(404).json({ error: 'no projection for this player — he has no usage history' });

    // The season-long distribution stays neutral (mult=1) on purpose — it averages
    // across a whole slate of different opponents, so no single week's Vegas line
    // belongs in it. The *weekly* number is a specific start/sit call for a specific
    // upcoming opponent, which is exactly what game script is for.
    const week = Number(req.query.week) || 1;
    const gs = p.team ? gameScriptFor(p.team, SEASON, week) : null;
    const mult = gs?.line ? { pass: gs.pass_mult, rush: gs.rush_mult } : 1;
    const weeklyAvail = weeklyAvailability(SEASON, week).get(p.player_id) ?? null;

    const seed = req.query.seed ?? null;
    res.json(withRandomSeed(seed, () => ({
      ...p,
      week,
      seed: seed == null ? null : Number(seed),
      game_script: gs,
      weekly: weeklyDistribution(p, {
        runs: 4000, scoring, mult,
        activeProbability: weeklyAvail?.active_probability ?? 1
      }),
      weekly_availability: weeklyAvail,
      season: (() => { const s = seasonDistribution(p, { runs: 800, scoring }); delete s.samples; return s; })(),
      availability: availability().get(p.player_id) ?? null,
      usage_history: usageFor(p.player_id).slice(0, 20)
    })));
  } catch (e) { next(e); }
});

/* -------------------------------------------------------------- accuracy */

/**
 * How good the model actually is, against the baselines it has to beat.
 * Backtests are run on held-out seasons, with the model rebuilt using only data
 * available before the season it is predicting.
 */
r.get('/accuracy', (req, res, next) => {
  try {
    const season = Number(req.query.season) || SEASON - 1;
    const out = memo(`acc:${season}`, () => {
      const truth = actuals(season);
      if (!truth.size) return { error: `no weekly usage data for ${season} — sync nflverse first` };
      const proj = buildProjections({ through: season - 1 });
      if (!proj.size) return { error: `no usage data before ${season} to build a projection from` };

      // Grade every source on the same player set, or the comparison is meaningless.
      const prior = actuals(season - 1);
      const ids = [...proj.keys()].filter(id => truth.get(id)?.games >= 4 && prior.has(id));
      const t = new Map(ids.map(id => [id, truth.get(id)]));
      const mk = f => new Map(ids.map(id => [id, f(id)]));
      const sources = {
        'Gridiron model': mk(id => proj.get(id).points),
        'Last season points': mk(id => prior.get(id).points),
        'Last season ppg x 17': mk(id => prior.get(id).ppg * 17),
        'Blend (60/40)': mk(id => 0.6 * proj.get(id).points + 0.4 * prior.get(id).points)
      };
      const table = Object.entries(sources)
        .map(([source, preds]) => ({ source, ...gradePoint(preds, t) }))
        .filter(x => !x.error)
        .sort((a, b) => (b.spearman ?? -1) - (a.spearman ?? -1));

      // Distributional accuracy for the model only — the baselines are point estimates.
      const samples = new Map();
      for (const id of ids.slice(0, 150)) {
        const s = seasonDistribution(proj.get(id), { runs: 300 });
        samples.set(id, s.samples);
      }
      return {
        season, players_graded: ids.length, table,
        distribution: gradeDistribution(samples, t),
        weekly_decisions: weeklyDecisionBacktest(proj, truth),
        note: 'Every source is graded on the same players. The model is rebuilt using only seasons before the one it predicts.'
      };
    });
    res.json(out);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------- simulator */

r.get('/:leagueId/simulate', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    if (!lg.payload) return res.status(400).json({ error: 'league not synced yet' });
    const runs = Math.min(6000, Number(req.query.runs) || 2000);
    const key = `sim:${lg.id}:${runs}:${req.query.from_week ?? 1}`;
    const seed = req.query.seed ?? null;
    res.json(withRandomSeed(seed, () => memo(`${key}:seed:${seed ?? 'random'}`, () => simulateSeason(lg, {
      runs, fromWeek: Number(req.query.from_week) || 1, scoring: scoringFor(lg)
    }))));
  } catch (e) { next(e); }
});

/** Title-odds impact of a specific trade. */
r.post('/:leagueId/trade-impact', (req, res, next) => {
  try {
    const lg = league(req, res); if (!lg) return;
    if (!lg.payload) return res.status(400).json({ error: 'league not synced yet' });
    const { my_team_id, their_team_id, i_give = [], i_get = [] } = req.body ?? {};
    if (!their_team_id) return res.status(400).json({ error: 'their_team_id required' });
    res.json(tradeImpact(lg, {
      myTeamId: my_team_id ?? lg.my_team_id,
      theirTeamId: their_team_id,
      iGive: i_give, iGet: i_get,
      runs: Math.min(3000, Number(req.body?.runs) || 1200),
      fromWeek: Number(req.body?.from_week) || 1,
      seed: req.body?.seed ?? null,
      scoring: scoringFor(lg)
    }));
  } catch (e) { next(e); }
});

/* --------------------------------------------------- supporting estimates */

r.get('/correlations', (req, res) => res.json(correlationTable()));

r.get('/gamescript', (req, res, next) => {
  try {
    const season = Number(req.query.season) || SEASON;
    const week = req.query.week ? Number(req.query.week) : null;
    const model = rows('SELECT * FROM gamescript_model');
    const lines = linesFor(season, week).map(l => ({
      ...l, ...gameScriptFor(l.team, l.season, l.week)
    }));
    res.json({ season, week, model, lines });
  } catch (e) { next(e); }
});

r.get('/handcuffs', (req, res, next) => {
  try { res.json(memo('handcuffs', () => handcuffValue()).slice(0, Number(req.query.limit) || 60)); }
  catch (e) { next(e); }
});

r.get('/cascade/:playerId', (req, res, next) => {
  try {
    const c = memo('cascades', () => cascades());
    res.json(c.get(Number(req.params.playerId)) ?? { error: 'no measured cascade for this player' });
  } catch (e) { next(e); }
});

r.get('/availability', (req, res, next) => {
  try {
    if (req.query.week) {
      const season = Number(req.query.season) || SEASON;
      const week = Number(req.query.week);
      const a = weeklyAvailability(season, week);
      return res.json({ season, week, players: [...a.values()]
        .sort((x, y) => x.active_probability - y.active_probability).slice(0, 200) });
    }
    const a = memo('avail', () => availability());
    const names = new Map(rows('SELECT id, name, position FROM players').map(p => [p.id, p]));
    res.json([...a.values()].map(x => ({ ...x, name: names.get(x.player_id)?.name }))
      .filter(x => x.name).sort((a, b) => a.available - b.available).slice(0, 120));
  } catch (e) { next(e); }
});

r.get('/status', (req, res) => {
  res.json({
    usage_seasons: usageSeasons(),
    correlations_fitted: row('SELECT COUNT(*) AS n FROM correlation_estimates')?.n ?? 0,
    gamescript_fitted: row('SELECT COUNT(*) AS n FROM gamescript_model')?.n ?? 0,
    lines: rows('SELECT season, COUNT(*) AS n FROM game_lines GROUP BY season ORDER BY season DESC'),
    players_with_gsis: row('SELECT COUNT(*) AS n FROM players WHERE gsis_id IS NOT NULL')?.n ?? 0
  });
});

/* ------------------------------------------------------------------ sync */

/** Pull everything the engine needs and refit every model. */
r.post('/sync', async (req, res, next) => {
  try {
    const seasons = (req.query.seasons ? String(req.query.seasons).split(',').map(Number)
      : [SEASON - 4, SEASON - 3, SEASON - 2, SEASON - 1]).filter(Boolean);
    const out = { seasons };
    out.nflverse = await syncNflverse(seasons);
    out.historical_lines = await syncHistoricalLines().catch(e => ({ error: e.message }));
    out.current_lines = await syncCurrentLines(SEASON).catch(e => ({ error: e.message }));
    out.gamescript = fitGameScript();
    out.correlations = fitCorrelations().length;
    clearModelCache(); clearMatchupCache(); clearCorrelationCache(); clearGameScriptCache();
    res.json({ ok: true, ...out });
  } catch (e) { next(e); }
});

export default r;
