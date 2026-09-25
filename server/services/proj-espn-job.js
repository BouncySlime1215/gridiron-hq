/**
 * PROJ-ESPN: the scheduled job (scheduler.js `proj_espn`, on the refresh loop). Three steps,
 * each attempted on its own; a failed step is named in the thrown error after the others ran,
 * so sync_log records the job as failed and why (never a silent partial success):
 *   shadow       our own weekly number beside the served ESPN one, per league (trade-engine.js
 *                WEEK_SHADOW -> weekly_projection_shadow; rows freeze at kickoff)
 *   calibration  weekly coverage log + the Tuesday k refit rule (range-calibration.js)
 *   offers       the value-gain log per decided offer (offer-value-gain.js)
 */
import { db } from '../db/index.js';
import { projEspnFlag, logWeeklyShadow } from './espn-week-projection.js';
import { runRangeCalibration } from './range-calibration.js';
import { logOfferValueGains } from './offer-value-gain.js';

/** Shadow rows for every synced league of the served season. */
export async function logShadowForLeagues({ now = Date.now(), database = db } = {}) {
  if (!projEspnFlag().on) return { skipped: 'GRIDIRON_PROJ_ESPN=0 (ours is served; nothing to shadow)' };
  const te = await import('./trade-engine.js');
  const { deriveFormat } = await import('./format.js');
  const { season, week } = te.tradeWeekContext();
  const out = [];
  for (const lg of database.prepare('SELECT * FROM leagues WHERE payload IS NOT NULL AND season = ? ORDER BY id').all(season)) {
    const assets = te.assetUniverse(lg, deriveFormat(lg).formatKey);
    const scoringKey = assets.context?.week_projection?.scoring_key ?? 'ppr';
    const entries = [];
    for (const a of assets.values()) {
      const s = a[te.WEEK_SHADOW];
      if (!s || (s.espn == null && !(s.ours > 0))) continue;
      entries.push({ player_id: a.id, ...s });
    }
    out.push({ league_id: lg.id, rows: logWeeklyShadow({ season, week, scoringKey, entries, now, database }) });
  }
  return { season, week, leagues: out };
}

export async function runProjEspnJob({ now = Date.now(), database = db } = {}) {
  const result = {}, failed = [];
  for (const [name, fn] of [
    ['shadow', () => logShadowForLeagues({ now, database })],
    ['calibration', () => runRangeCalibration({ now, database })],
    ['offers', () => logOfferValueGains({ now, database })],
  ]) {
    try { result[name] = await fn(); } catch (e) {
      console.error(`[proj-espn] ${name} failed: ${e?.stack ?? e}`);
      failed.push(`${name}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  if (failed.length) throw new Error(`PROJ-ESPN job: ${failed.join('; ')} (other steps: ${JSON.stringify(result).slice(0, 300)})`);
  return result;
}
