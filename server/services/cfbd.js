/**
 * CollegeFootballData.com rookie-evaluation signal.
 *
 * Real, free, actively-maintained public API (api.collegefootballdata.com) — the
 * college-football equivalent of the public data sources this codebase already
 * pulls from (nflverse, dynastyprocess/data — see historical-adp.js). A free API
 * key is required (CFBD_API_KEY); this module follows historical-adp.js's exact
 * shape (env-gated key -> fetch -> parse -> store) and odds-api.js's hasKey()
 * no-op-when-absent gating convention — do not attempt to obtain a real key,
 * gate gracefully when one isn't configured.
 *
 * Two endpoints, both ADDITIVE rookie-evaluation inputs alongside this app's
 * existing combine/draft-capital data (player_accolades), never a replacement:
 *   - /player/usage: each player's share of their team's overall/rush/pass
 *     snaps — the closest real college equivalent of "target share".
 *   - /ppa/players/season: CFBD's own Predicted Points Added metric. It is
 *     opponent-adjusted BY CONSTRUCTION (derived from a drive-level expected-
 *     points model conditioned on down/distance/field position/opponent, not
 *     raw box-score yards) — the "opponent-adjusted efficiency" signal the
 *     roadmap calls for.
 * Yards/play is left to the existing accolades/nflverse combine data rather
 * than re-pulled here, since college box-score yardage is already commonly
 * available; usage share and PPA are the two things CFBD uniquely adds.
 */
import { db, rows, run } from '../db/index.js';
import { normalizePlayerName } from './player-identity.js';

const BASE = 'https://api.collegefootballdata.com';

db.exec(`
  CREATE TABLE IF NOT EXISTS cfbd_player_season (
    season INTEGER NOT NULL,
    player_key TEXT NOT NULL,
    name TEXT NOT NULL,
    position TEXT,
    team TEXT,
    usage_overall REAL,
    usage_rush REAL,
    usage_pass REAL,
    ppa_overall REAL,
    ppa_rush REAL,
    ppa_pass REAL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (season, player_key)
  );
`);

/** Same convention as odds-api.js's hasKey(): callers check this rather than
 *  letting a missing key surface as a network/auth error. */
export const hasKey = () => Boolean(process.env.CFBD_API_KEY);

async function cfbdGet(path) {
  const resp = await fetch(`${BASE}${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${process.env.CFBD_API_KEY}` },
    signal: AbortSignal.timeout(20000)
  });
  if (!resp.ok) throw new Error(`CFBD API ${resp.status} on ${path}`);
  return resp.json();
}

/**
 * Fetch and store one season's usage + PPA signal for every FBS player CFBD
 * has data for. Returns null (no-op) without a configured key — the
 * scheduler/caller must check the return value rather than assume a sync
 * always runs, same as every other optional-key feed in this codebase.
 */
export async function syncCfbdSeason(season) {
  if (!hasKey()) return null;
  const [usage, ppa] = await Promise.all([
    cfbdGet(`/player/usage?year=${season}`),
    cfbdGet(`/ppa/players/season?year=${season}`)
  ]);

  const byKey = new Map();
  for (const u of usage ?? []) {
    if (!u?.name) continue;
    const key = normalizePlayerName(u.name);
    byKey.set(key, {
      season, player_key: key, name: u.name, position: u.position ?? null, team: u.team ?? null,
      usage_overall: u.usage?.overall ?? null, usage_rush: u.usage?.rush ?? null, usage_pass: u.usage?.pass ?? null,
      ppa_overall: null, ppa_rush: null, ppa_pass: null
    });
  }
  for (const p of ppa ?? []) {
    if (!p?.name) continue;
    const key = normalizePlayerName(p.name);
    const existing = byKey.get(key) ?? {
      season, player_key: key, name: p.name, position: p.position ?? null, team: p.team ?? null,
      usage_overall: null, usage_rush: null, usage_pass: null, ppa_overall: null, ppa_rush: null, ppa_pass: null
    };
    existing.ppa_overall = p.averagePPA?.all ?? null;
    existing.ppa_rush = p.averagePPA?.rush ?? null;
    existing.ppa_pass = p.averagePPA?.pass ?? null;
    byKey.set(key, existing);
  }

  const fetchedAt = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    run(`DELETE FROM cfbd_player_season WHERE season = ?`, season);
    const stmt = db.prepare(`INSERT INTO cfbd_player_season
      (season, player_key, name, position, team, usage_overall, usage_rush, usage_pass, ppa_overall, ppa_rush, ppa_pass, fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of byKey.values()) {
      stmt.run(r.season, r.player_key, r.name, r.position, r.team,
        r.usage_overall, r.usage_rush, r.usage_pass, r.ppa_overall, r.ppa_rush, r.ppa_pass, fetchedAt);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  return { season, stored: byKey.size };
}

/**
 * One rookie's stored college signal for a given (final college) season, by
 * normalized name. Returns null when nothing was ever synced for that
 * season/player — including simply because CFBD_API_KEY was never configured,
 * which is the graceful no-op path every caller must already handle.
 */
export function cfbdSignalFor(name, season) {
  if (name == null || season == null) return null;
  const key = normalizePlayerName(name);
  return rows(`SELECT * FROM cfbd_player_season WHERE season = ? AND player_key = ?`, season, key)[0] ?? null;
}
