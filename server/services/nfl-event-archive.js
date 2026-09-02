/**
 * Cutoff-safe archive of verified NFL facts.
 *
 * Historical prose is incomplete and cannot be reconstructed honestly. What
 * can be reconstructed are dated primary facts: official injury/practice
 * reports, trades, and weekly Shield roster state. They are stored as immutable
 * events with source precision and never converted into points by prose.
 */
import { canonicalTeamCode } from './team-codes.js';
import { nflKickoffDate } from './date-util.js';
import crypto from 'node:crypto';
import { db, rows, run } from '../db/index.js';
import { parseCsv } from './nflverse.js';
import { syncInjuries } from './nfl-advanced.js';

/**
 * v2 (2026-09-02): conservative availability times. A weekly roster snapshot
 * is the game-day inactive list, which is published ninety minutes before
 * kickoff, not at midnight; a trade is known by the END of its date, not at
 * midday. v1 rows stay in the immutable table but every reader filters on
 * the current version, so week-N game-day facts cannot reach a week-N
 * pregame read early, and nothing from week N+1 can reach week N at all.
 */
export const VERIFIED_EVENT_ARCHIVE_VERSION = 'nfl-verified-event-archive-v2-conservative-availability';
const RELEASE = 'https://github.com/nflverse/nflverse-data/releases/download';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_verified_events (
    event_key TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    season INTEGER,
    week INTEGER,
    team TEXT,
    other_team TEXT,
    player_id TEXT,
    pfr_id TEXT,
    player_name TEXT,
    position TEXT,
    status_before TEXT,
    status_after TEXT,
    body_part TEXT,
    occurred_at TEXT NOT NULL,
    available_at TEXT NOT NULL,
    time_precision TEXT NOT NULL,
    source TEXT NOT NULL,
    source_url TEXT NOT NULL,
    verification_state TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    archive_version TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_nfl_verified_events_team_time
    ON nfl_verified_events(team,available_at,event_type);
  CREATE INDEX IF NOT EXISTS idx_nfl_verified_events_player_time
    ON nfl_verified_events(player_id,available_at,event_type);
  CREATE TRIGGER IF NOT EXISTS nfl_verified_events_no_update BEFORE UPDATE ON nfl_verified_events
    BEGIN SELECT RAISE(ABORT, 'verified event archive is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_verified_events_no_delete BEFORE DELETE ON nfl_verified_events
    BEGIN SELECT RAISE(ABORT, 'verified event archive is immutable'); END;
`);

const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
};
const sha = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const parse = (value, fallback = {}) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const at = (header, name) => header.indexOf(name);
const get = (record, index) => index < 0 ? null : record[index] || null;
const normTeam = value => (value == null || value === '' ? value : canonicalTeamCode(value));

async function csv(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000), headers: { Accept: 'text/csv' } });
  if (!response.ok) throw new Error(`${url.split('/').pop()} -> HTTP ${response.status}`);
  return parseCsv(await response.text());
}

function insertEvent(event) {
  const stable = {
    event_type: event.event_type, season: event.season ?? null, week: event.week ?? null,
    team: event.team ?? null, other_team: event.other_team ?? null,
    player_id: event.player_id ?? null, pfr_id: event.pfr_id ?? null,
    player_name: event.player_name ?? null, position: event.position ?? null,
    status_before: event.status_before ?? null, status_after: event.status_after ?? null,
    body_part: event.body_part ?? null, occurred_at: event.occurred_at,
    available_at: event.available_at, time_precision: event.time_precision,
    source: event.source, source_url: event.source_url,
    verification_state: event.verification_state ?? 'verified', payload: event.payload ?? {},
    // Part of the key: a new archive version re-materializes every event with
    // its own rows rather than being swallowed by v1's INSERT OR IGNORE.
    archive_version: VERIFIED_EVENT_ARCHIVE_VERSION
  };
  const eventKey = sha(stable);
  const result = run(`INSERT OR IGNORE INTO nfl_verified_events
      (event_key,event_type,season,week,team,other_team,player_id,pfr_id,player_name,position,
       status_before,status_after,body_part,occurred_at,available_at,time_precision,source,
       source_url,verification_state,payload_json,archive_version,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  eventKey, stable.event_type, stable.season, stable.week, stable.team, stable.other_team,
  stable.player_id, stable.pfr_id, stable.player_name, stable.position, stable.status_before,
  stable.status_after, stable.body_part, stable.occurred_at, stable.available_at,
  stable.time_precision, stable.source, stable.source_url, stable.verification_state,
  JSON.stringify(stable.payload), VERIFIED_EVENT_ARCHIVE_VERSION, new Date().toISOString());
  return { inserted: Number(result.changes ?? 0), event_key: eventKey };
}

function injuryStatus(row) {
  return row.report_status || row.practice_status || 'listed';
}

export function materializeInjuryEvents(seasons = [2021, 2022, 2023, 2024, 2025]) {
  const sourceUrl = `${RELEASE}/injuries/injuries_{season}.csv`;
  const items = rows(`SELECT season,week,team,gsis_id,full_name,position,report_status,
      practice_status,injury,modified_at FROM nfl_injuries
    WHERE season IN (${seasons.map(() => '?').join(',')}) AND modified_at IS NOT NULL
    ORDER BY season,team,gsis_id,week`, ...seasons);
  let inserted = 0;
  for (const item of items) {
    inserted += insertEvent({
      event_type: 'official_injury_report', season: item.season, week: item.week,
      team: normTeam(item.team), player_id: item.gsis_id, player_name: item.full_name,
      position: item.position, status_after: injuryStatus(item), body_part: item.injury,
      occurred_at: item.modified_at, available_at: item.modified_at, time_precision: 'timestamp',
      source: 'nflverse_injuries', source_url: sourceUrl.replace('{season}', item.season),
      payload: { report_status: item.report_status, practice_status: item.practice_status,
        injury: item.injury, evidence_kind: 'official_weekly_report' }
    }).inserted;
  }
  return { reviewed: items.length, inserted };
}

export async function syncTradeEvents({ fromSeason = 2002, throughSeason = 2026 } = {}) {
  const url = `${RELEASE}/trades/trades.csv`;
  const { header, records } = await csv(url);
  const index = Object.fromEntries(['trade_id', 'season', 'trade_date', 'gave', 'received',
    'pfr_id', 'pfr_name', 'pick_season', 'pick_round', 'pick_number', 'conditional']
    .map(name => [name, at(header, name)]));
  let reviewed = 0, inserted = 0, skippedPicks = 0;
  for (const record of records) {
    const season = Number(get(record, index.season));
    if (!Number.isFinite(season) || season < fromSeason || season > throughSeason) continue;
    reviewed++;
    const pfrId = get(record, index.pfr_id), playerName = get(record, index.pfr_name);
    if (!pfrId && !playerName) { skippedPicks++; continue; }
    const date = get(record, index.trade_date);
    if (!date) continue;
    const gave = normTeam(get(record, index.gave)), received = normTeam(get(record, index.received));
    // Known by the end of the trade date in US time (noon UTC the next day,
    // 8am ET): a trade announced at 5pm ET must not count as known at 8am the
    // same day, and UTC midnight is still 8pm ET on the trade date.
    const occurred = `${date}T12:00:00Z`;
    const known = new Date(Date.parse(`${date}T00:00:00Z`) + 36 * 3600000).toISOString();
    inserted += insertEvent({
      event_type: 'trade', season, team: received, other_team: gave,
      pfr_id: pfrId, player_name: playerName, status_before: gave, status_after: received,
      occurred_at: occurred, available_at: known, time_precision: 'date_end_conservative',
      source: 'nflverse_trades', source_url: url,
      payload: { trade_id: get(record, index.trade_id), gave, received,
        pick_season: get(record, index.pick_season), pick_round: get(record, index.pick_round),
        pick_number: get(record, index.pick_number), conditional: get(record, index.conditional) }
    }).inserted;
  }
  return { reviewed, inserted, skipped_pick_only_rows: skippedPicks };
}

/**
 * When a weekly roster snapshot became public: the inactive list is posted
 * ninety minutes before that team's kickoff. A team without a stored kickoff
 * that week (bye, or a schedule gap) yields null and the row is skipped rather
 * than guessed.
 */
function gameAvailability(season, week, team) {
  const game = rows(`SELECT gameday,gametime FROM game_lines WHERE season=? AND week=? AND team=? LIMIT 1`,
  season, week, team)[0];
  if (!game?.gameday) return null;
  const kickoff = nflKickoffDate(game.gameday, game.gametime || '13:00');
  return kickoff ? new Date(kickoff.getTime() - 90 * 60000).toISOString() : null;
}

export async function syncWeeklyRosterEvents(seasons = [2021, 2022, 2023, 2024, 2025]) {
  let reviewed = 0, inserted = 0;
  const failures = [];
  for (const season of seasons) {
    const url = `${RELEASE}/weekly_rosters/roster_weekly_${season}.csv`;
    try {
      const { header, records } = await csv(url);
      const index = Object.fromEntries(['team', 'position', 'status', 'full_name', 'gsis_id',
        'pfr_id', 'week', 'game_type', 'status_description_abbr', 'depth_chart_position']
        .map(name => [name, at(header, name)]));
      const byPlayer = new Map();
      for (const record of records) {
        if (get(record, index.game_type) && get(record, index.game_type) !== 'REG') continue;
        const week = Number(get(record, index.week)), gsisId = get(record, index.gsis_id);
        const playerName = get(record, index.full_name);
        if (!week || (!gsisId && !playerName)) continue;
        reviewed++;
        const key = gsisId || `${playerName}|${get(record, index.position)}`;
        const list = byPlayer.get(key) ?? [];
        list.push({ season, week, team: normTeam(get(record, index.team)),
          position: get(record, index.position), status: get(record, index.status),
          status_detail: get(record, index.status_description_abbr), player_name: playerName,
          player_id: gsisId, pfr_id: get(record, index.pfr_id),
          depth_position: get(record, index.depth_chart_position) });
        byPlayer.set(key, list);
      }
      for (const list of byPlayer.values()) {
        list.sort((a, b) => a.week - b.week);
        for (let i = 0; i < list.length; i++) {
          const current = list[i], prior = list[i - 1];
          if (prior && prior.team === current.team && prior.status === current.status
            && prior.status_detail === current.status_detail) continue;
          const availableAt = gameAvailability(season, current.week, current.team);
          if (!availableAt) continue;
          const eventType = prior && prior.team !== current.team ? 'weekly_roster_team_change'
            : prior ? 'weekly_roster_status_change' : 'weekly_roster_observation';
          inserted += insertEvent({ event_type: eventType, season, week: current.week,
            team: current.team, other_team: prior?.team ?? null, player_id: current.player_id,
            pfr_id: current.pfr_id, player_name: current.player_name, position: current.position,
            status_before: prior?.status ?? null, status_after: current.status,
            occurred_at: availableAt, available_at: availableAt,
            time_precision: 'weekly_snapshot_inactives_deadline', source: 'nflverse_weekly_rosters',
            source_url: url, payload: { prior, current,
              caveat: 'weekly state transition, not proof of transaction time or cause' }
          }).inserted;
        }
      }
    } catch (error) {
      failures.push({ season, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { reviewed, inserted, failures };
}

export async function syncVerifiedEventArchive({ seasons = [2021, 2022, 2023, 2024, 2025],
  includeWeeklyRosters = true } = {}) {
  const injuriesSync = await syncInjuries(seasons);
  const injuries = materializeInjuryEvents(seasons);
  const trades = await syncTradeEvents({ fromSeason: Math.min(...seasons) - 1,
    throughSeason: Math.max(...seasons) + 1 });
  const rosters = includeWeeklyRosters ? await syncWeeklyRosterEvents(seasons) : { skipped: true };
  return { version: VERIFIED_EVENT_ARCHIVE_VERSION, injuries_sync: injuriesSync,
    injuries, trades, rosters, coverage: verifiedEventCoverage() };
}

export function verifiedEventsForTeam(team, { before, sinceDays = 45, limit = 100 } = {}) {
  const cutoff = before ?? new Date().toISOString();
  const since = new Date(new Date(cutoff).getTime() - sinceDays * 86400000).toISOString();
  return rows(`SELECT * FROM nfl_verified_events WHERE team=? AND verification_state='verified'
      AND archive_version=? AND available_at<=? AND available_at>=? ORDER BY available_at DESC LIMIT ?`,
  team, VERIFIED_EVENT_ARCHIVE_VERSION, cutoff, since, limit).map(item => ({ ...item, payload: parse(item.payload_json) }));
}

export function teamEventVector(team, { before, sinceDays = 21 } = {}) {
  const events = verifiedEventsForTeam(team, { before, sinceDays, limit: 250 });
  const count = type => events.filter(event => event.event_type === type).length;
  const statuses = new Map();
  for (const event of events.filter(item => item.player_id || item.player_name)) {
    const key = event.player_id || event.player_name;
    if (!statuses.has(key)) statuses.set(key, event);
  }
  const active = [...statuses.values()];
  const severity = status => {
    const value = String(status ?? '').toLowerCase();
    if (/out|reserve|inactive/.test(value)) return 1;
    if (/doubtful|did not/.test(value)) return 0.75;
    if (/questionable|limited/.test(value)) return 0.4;
    return 0;
  };
  return { team, cutoff: before, events: events.length,
    injury_burden: active.reduce((sum, event) => sum + severity(event.status_after), 0),
    trade_arrivals: count('trade'), roster_team_changes: count('weekly_roster_team_change'),
    roster_status_changes: count('weekly_roster_status_change'), active_player_states: active,
    source_mix: Object.fromEntries([...new Set(events.map(event => event.source))]
      .map(source => [source, events.filter(event => event.source === source).length])) };
}

export function verifiedEventCoverage() {
  const summary = rows(`SELECT event_type,time_precision,COUNT(*) events,COUNT(DISTINCT player_id) players,
      MIN(available_at) first_at,MAX(available_at) last_at
    FROM nfl_verified_events WHERE archive_version=? GROUP BY event_type,time_precision ORDER BY events DESC`, VERIFIED_EVENT_ARCHIVE_VERSION);
  const seasons = rows(`SELECT season,COUNT(*) events,COUNT(DISTINCT team) teams
    FROM nfl_verified_events WHERE season IS NOT NULL AND archive_version=? GROUP BY season ORDER BY season`, VERIFIED_EVENT_ARCHIVE_VERSION);
  const legacy = rows(`SELECT archive_version,COUNT(*) events FROM nfl_verified_events WHERE archive_version<>? GROUP BY archive_version`, VERIFIED_EVENT_ARCHIVE_VERSION);
  return { version: VERIFIED_EVENT_ARCHIVE_VERSION, summary, seasons, legacy_versions: legacy,
    availability_rule: 'injury reports at their modification timestamp; weekly roster snapshots at kickoff minus 90 minutes; trades at the end of the trade date. Readers see only the current version.' };
}
