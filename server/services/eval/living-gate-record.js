/**
 * LIVING-01b re-gate, the forward half: record each team's predicted
 * starting-lineup points for the week after the one in progress, from the
 * static sim and the sim with league-mates acting, before that week starts.
 * eval/living-gate.js (L01B-SIM) grades the rows once the week is complete.
 *
 * Run by scripts/eval/run-graders.mjs on the refresh tick, before the graders,
 * the way REASON-02's claims are. It records nothing until a predictor exists:
 *
 *   predict(league, { week }) -> { runs, seed, model, teams: [{ team_id, static, living }] }
 *
 * `static` and `living` are the mean lineup points for `week` over the same runs
 * and seed (LIVING-01b's livingPoints gives both off one set of draws). The
 * runner resolves it as season-sim.js's `nextWeekLineupMeans` export, which the
 * LIVING-01b sim (#261) supplies; until that is on main the recorder waits and
 * says so. The ACTIVITY-01 model (#334) is resolved the same way.
 */
import { fileURLToPath } from 'node:url';

export const SIM_PREDICTOR = Object.freeze({ module: '../season-sim.js', export: 'nextWeekLineupMeans' });
export const ACTIVITY_MODEL = Object.freeze({ module: '../people/activity-intensity.js', export: 'leagueActivityIntensity' });

/**
 * A named export of a module that may not be on this build, or null. Only
 * "that module does not exist" is null: a module that exists but fails to load
 * (a syntax error, a missing dependency of its own) throws.
 */
export async function optionalExport(specifier, exportName) {
  const url = new URL(specifier, import.meta.url).href;
  let mod;
  try {
    mod = await import(url);
  } catch (e) {
    const self = url.startsWith('file:') ? fileURLToPath(url) : url;
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && (e.url === url || String(e.message).includes(`module '${self}'`))) return null;
    throw e;
  }
  return typeof mod[exportName] === 'function' ? mod[exportName] : null;
}

/** The gate's two optional models, as the grader and the recorder take them. */
export async function resolveGateModels() {
  const intensity = await optionalExport(ACTIVITY_MODEL.module, ACTIVITY_MODEL.export);
  const predict = await optionalExport(SIM_PREDICTOR.module, SIM_PREDICTOR.export);
  return { intensityFor: intensity ? () => intensity : null, predict };
}

/**
 * Record the next week's paired predictions for every ESPN league. Write-once per
 * (league, season, week, team). A league whose predictor throws is reported in
 * `errors` and the others still run.
 */
export async function recordSimPredictions(database, { predict, now = new Date() } = {}) {
  if (!predict) {
    return { state: 'waiting', written: 0, errors: [],
      reason: `no sim predictor: season-sim.js has no ${SIM_PREDICTOR.export} (LIVING-01b, #261, is not on this build)` };
  }
  const leagues = database.prepare(`SELECT id, season, payload FROM leagues
    WHERE platform = 'espn' AND payload IS NOT NULL ORDER BY id`).all();
  const have = database.prepare(`SELECT COUNT(*) AS n FROM living_gate_sim_predictions
    WHERE league_id = ? AND season = ? AND week = ?`);
  const ins = database.prepare(`INSERT OR IGNORE INTO living_gate_sim_predictions
    (league_id, season, week, team_id, runs, seed, pred_static, pred_living, model, recorded_period, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const errors = [];
  let written = 0;
  for (const row of leagues) {
    const payload = JSON.parse(row.payload);
    const season = row.season ?? payload.seasonId;
    const inProgress = Number(payload.scoringPeriodId);
    if (!(inProgress >= 1)) continue;
    const week = inProgress + 1;
    const teams = payload.teams ?? [];
    if (teams.length && have.get(row.id, season, week).n >= teams.length) continue;
    try {
      const p = await predict({ id: row.id, season, payload }, { week });
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const t of p.teams) {
          if (!Number.isFinite(t.static) || !Number.isFinite(t.living)) {
            throw new Error(`team ${t.team_id}: prediction is not a number`);
          }
          written += Number(ins.run(row.id, season, week, String(t.team_id), p.runs, p.seed ?? null,
            t.static, t.living, p.model, inProgress, now.toISOString()).changes);
        }
        database.exec('COMMIT');
      } catch (e) {
        database.exec('ROLLBACK');
        throw e;
      }
    } catch (e) {
      errors.push({ league_id: row.id, message: String(e?.message ?? e).slice(0, 300) });
    }
  }
  return { state: 'ran', written, errors };
}
