/**
 * The one producer of "this player carries the Sleeper injury flag".
 *
 * Table: player_metrics rows with source = 'injury_flag'. Writer:
 * syncSleeper() in server/routes/aggregates.js, which sets value = 1 while
 * Sleeper lists an injury_status and value = 0 once a matched player comes back
 * with none (RL-12-2). Every reader (contingency availability, trade-engine
 * asset universe, players evidence facts, draft-assist, rankings) goes through
 * here so they all agree on who is flagged.
 *
 * Stale-flag guard: the sync re-stamps fetched_at on every run that still sees
 * the injury, so a flag older than STALE_FLAG_DAYS means Sleeper has not
 * confirmed it for that long (sync down, or the player dropped out of the
 * pull). If that player also took offensive snaps in the latest loaded week,
 * and that week started after the flag was last confirmed, he has played since:
 * the flag is ignored and logged. STALE_FLAG_DAYS = 7 is a hand-set constant
 * (a guess: one game week), not a fitted number.
 */
import { rows, row } from '../db/index.js';

export const STALE_FLAG_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

// SQLite datetime('now') text is UTC without a zone marker.
function parseUtc(text) {
  if (!text) return NaN;
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
}

/**
 * @returns {{ active: Set<number>, ignored: Array<{player_id:number, fetched_at:string, season:number, week:number, offense_snaps:number, week_start:string}>, latest: {season:number, week:number, week_start:string|null}|null }}
 */
export function injuryFlagState({ staleDays = STALE_FLAG_DAYS, now = new Date() } = {}) {
  const latest = row(`SELECT season, week FROM player_week_snaps ORDER BY season DESC, week DESC LIMIT 1`) ?? null;
  const weekStart = latest
    ? row(`SELECT MIN(date) AS start FROM schedule_games WHERE season = ? AND week = ?`, latest.season, latest.week)?.start ?? null
    : null;
  const flags = rows(`SELECT m.player_id, m.fetched_at, s.offense_snaps
                      FROM player_metrics m
                      LEFT JOIN player_week_snaps s ON s.player_id = m.player_id AND s.season = ? AND s.week = ?
                      WHERE m.source = 'injury_flag' AND m.value > 0`,
    latest?.season ?? -1, latest?.week ?? -1);

  const cutoff = now.getTime() - staleDays * DAY_MS;
  const active = new Set();
  const ignored = [];
  for (const f of flags) {
    const confirmedAt = parseUtc(f.fetched_at);
    const confirmedDay = Number.isFinite(confirmedAt) ? new Date(confirmedAt).toISOString().slice(0, 10) : null;
    const stale = Number.isFinite(confirmedAt) && confirmedAt < cutoff;
    const playedSince = f.offense_snaps > 0 && weekStart != null && confirmedDay != null && weekStart > confirmedDay;
    if (stale && playedSince) {
      ignored.push({ player_id: f.player_id, fetched_at: f.fetched_at, season: latest.season, week: latest.week,
        offense_snaps: f.offense_snaps, week_start: weekStart });
    } else {
      active.add(f.player_id);
    }
  }
  return { active, ignored, latest: latest ? { ...latest, week_start: weekStart } : null };
}

let lastLoggedKey = '';

/** Set of player ids whose injury flag readers should honour; logs ignored stale flags once per distinct set. */
export function activeInjuryFlagIds(opts) {
  const st = injuryFlagState(opts);
  const key = st.ignored.map(x => x.player_id).join(',');
  if (key && key !== lastLoggedKey) {
    console.warn(`[injury-flags] ignored ${st.ignored.length} stale injury flag(s) older than ${opts?.staleDays ?? STALE_FLAG_DAYS} days `
      + `on players with snaps in ${st.latest.season} week ${st.latest.week}: player_id ${key}`);
  }
  lastLoggedKey = key;
  return st.active;
}
