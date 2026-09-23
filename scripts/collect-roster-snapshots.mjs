#!/usr/bin/env node
/**
 * Weekly roster snapshots: every team's roster and lineup slots, per league per
 * ESPN scoring period, into `league_roster_snapshots` (migration 058).
 *
 * Why (FANTASY-ENGINE-MASTER-PLAN.md section 00, [WA-ess]): bench points and
 * "what did I start" need lineup history, and `leagues.payload` is overwritten by
 * every hourly ESPN sync — the week just played was gone at each rollover.
 *
 * Two passes per run, both idempotent (the same input writes nothing):
 *   1. live   — the stored payload (no network): the current scoring period, one row
 *               per rostered player, updated only when something changed; players
 *               who left the roster during the period are kept with on_roster = 0.
 *   2. final  — each completed period of this season with no 'final' rows yet is
 *               read once from ESPN's boxscore (the period's final lineups with that
 *               period's points; the starters sum to ESPN's team score, which is
 *               checked). This also backfills periods the loop missed (laptop asleep,
 *               week 1 before this collector existed). Read-only against ESPN with
 *               the league's own cookies, like collect-league-transactions.mjs.
 *
 * Runs on the refresh loop (scripts/refresh-live-data.mjs) after the ESPN league
 * sync. One sync_log row, job 'roster_snapshots'. Never prints a credential.
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/collect-roster-snapshots.mjs [--no-network] [--json]
 * Exit 0 when every league captured cleanly; 1 otherwise (the reason is in sync_log).
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

process.env.SCHEDULER_DISABLED = '1';
const { db, rows, run } = await import('../server/db/index.js');
const { BROWSER_HEADERS, SLOT_NAME } = await import('../server/services/espn-draft.js');
const { round2, periodPoints } = await import('./lib/espn-period-points.mjs');

const ESPN_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';
const BENCH_SLOT = 20, IR_SLOT = 21;
const FETCH_TIMEOUT_MS = 20_000;
// Fields compared to decide whether a stored row changed. Timestamps are not.
const TRACKED = ['player_id', 'player_name', 'position', 'espn_position_id', 'pro_team_id', 'lineup_slot_id',
  'lineup_slot', 'is_starter', 'injury_status', 'pregame_injury_status', 'acquisition_type', 'lineup_locked', 'projected_points',
  'actual_points', 'on_roster', 'source'];


function playerIndex() {
  const byEspn = new Map();
  for (const p of rows('SELECT id, position, espn_id FROM players WHERE espn_id IS NOT NULL')) {
    byEspn.set(Number(p.espn_id), p);
  }
  return byEspn;
}

/**
 * Rows for one team's roster entries. `final` entries come from a boxscore, where
 * playerPoolEntry.appliedStatTotal is that period's total (a fallback only; in the
 * live mRoster payload it is the SEASON total and is never used).
 */
export function rowsFromEntries(entries, { season, period, source, players }) {
  const out = [];
  for (const e of entries ?? []) {
    const ppe = e.playerPoolEntry ?? {};
    const pl = ppe.player ?? {};
    const espnId = Number(e.playerId ?? pl.id ?? ppe.id);
    if (!Number.isFinite(espnId)) continue;
    const slot = Number(e.lineupSlotId);
    if (!Number.isFinite(slot)) continue;
    const ours = players.get(espnId);
    let actual = periodPoints(pl.stats, season, period, 0);
    if (actual == null && source === 'final') actual = round2(Number(ppe.appliedStatTotal));
    out.push({
      espn_player_id: espnId,
      player_id: ours?.id ?? null,
      player_name: pl.fullName ?? null,
      position: ours?.position ?? null,
      espn_position_id: Number.isFinite(pl.defaultPositionId) ? pl.defaultPositionId : null,
      pro_team_id: Number.isFinite(pl.proTeamId) ? pl.proTeamId : null,
      lineup_slot_id: slot,
      lineup_slot: SLOT_NAME[slot] ?? null,
      is_starter: slot === BENCH_SLOT || slot === IR_SLOT ? 0 : 1,
      // The player's status (ACTIVE, QUESTIONABLE, OUT, INJURY_RESERVE, ...), as waiver-wire and
      // trade-engine read it. The entry-level injuryStatus is 'NORMAL' on every rostered entry.
      injury_status: pl.injuryStatus ?? null,
      acquisition_type: e.acquisitionType ?? null,
      lineup_locked: typeof ppe.lineupLocked === 'boolean' ? (ppe.lineupLocked ? 1 : 0) : null,
      projected_points: periodPoints(pl.stats, season, period, 1),
      actual_points: actual,
      on_roster: 1,
      source,
    });
  }
  return out;
}

const hasFinal = (leagueId, season, period) => rows(`SELECT 1 FROM league_roster_snapshots
  WHERE league_id = ? AND season = ? AND scoring_period_id = ? AND source = 'final' LIMIT 1`,
leagueId, season, period).length > 0;

/**
 * Write one period's rows for the given teams: insert new keys, update changed ones,
 * and mark players of those teams no longer present as on_roster = 0. Returns counts.
 */
function writePeriod(leagueId, season, period, byTeam, source, now) {
  const stored = new Map(rows(`SELECT * FROM league_roster_snapshots
    WHERE league_id = ? AND season = ? AND scoring_period_id = ?`, leagueId, season, period)
    .map(r => [`${r.team_id}|${r.espn_player_id}`, r]));
  const insert = db.prepare(`INSERT INTO league_roster_snapshots
    (league_id, season, scoring_period_id, team_id, espn_player_id, ${TRACKED.join(', ')}, first_seen_at, changed_at)
    VALUES (?, ?, ?, ?, ?, ${TRACKED.map(() => '?').join(', ')}, ?, ?)`);
  const update = db.prepare(`UPDATE league_roster_snapshots SET ${TRACKED.map(c => `${c} = ?`).join(', ')}, changed_at = ?
    WHERE league_id = ? AND season = ? AND scoring_period_id = ? AND team_id = ? AND espn_player_id = ?`);
  const markGone = db.prepare(`UPDATE league_roster_snapshots SET on_roster = 0, changed_at = ?
    WHERE league_id = ? AND season = ? AND scoring_period_id = ? AND team_id = ? AND espn_player_id = ?`);
  let inserted = 0, updated = 0, dropped = 0;
  db.exec('BEGIN');
  try {
    for (const [teamId, teamRows] of byTeam) {
      const present = new Set();
      for (const r of teamRows) {
        const key = `${teamId}|${r.espn_player_id}`;
        present.add(key);
        const old = stored.get(key);
        // The status he carried into his game: taken while his lineup is still unlocked,
        // then held (ESPN's status keeps moving after kickoff; boxscores carry no lock flag).
        r.pregame_injury_status = source === 'live' && r.lineup_locked === 0
          ? r.injury_status : (old?.pregame_injury_status ?? null);
        if (!old) {
          insert.run(leagueId, season, period, teamId, r.espn_player_id, ...TRACKED.map(c => r[c]), now, now);
          inserted++;
        } else if (TRACKED.some(c => (old[c] ?? null) !== (r[c] ?? null))) {
          update.run(...TRACKED.map(c => r[c]), now, leagueId, season, period, teamId, r.espn_player_id);
          updated++;
        }
      }
      for (const [key, old] of stored) {
        if (old.team_id !== teamId || present.has(key) || old.on_roster === 0) continue;
        markGone.run(now, leagueId, season, period, teamId, old.espn_player_id);
        dropped++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { inserted, updated, dropped };
}

function matchupPeriodFor(payload, period) {
  const periods = payload?.settings?.scheduleSettings?.matchupPeriods ?? {};
  for (const [m, list] of Object.entries(periods)) {
    if (Array.isArray(list) && list.map(Number).includes(period)) return { matchup: Number(m), scoringPeriods: list.length };
  }
  return { matchup: period, scoringPeriods: 1 };
}

/** A period is complete once ESPN has moved past it, or every matchup in it is decided. */
function completedPeriods(payload) {
  const current = Number(payload.scoringPeriodId);
  const first = Number(payload.status?.firstScoringPeriod) || 1;
  const last = Number(payload.status?.finalScoringPeriod) || current;
  const out = [];
  for (let p = first; p <= Math.min(current, last); p++) {
    if (p < current) { out.push(p); continue; }
    const { matchup } = matchupPeriodFor(payload, p);
    const games = (payload.schedule ?? []).filter(m => Number(m.matchupPeriodId) === matchup);
    if (games.length && games.every(m => m.winner && m.winner !== 'UNDECIDED')) out.push(p);
  }
  return out;
}

async function fetchBoxscore(lg, season, period, matchup, fetchImpl) {
  const url = `${ESPN_BASE}/seasons/${season}/segments/0/leagues/${lg.league_id}`
    + `?view=mMatchupScore&view=mBoxscore&scoringPeriodId=${period}`;
  const headers = { ...BROWSER_HEADERS,
    'x-fantasy-filter': JSON.stringify({ schedule: { filterMatchupPeriodIds: { value: [matchup] } } }) };
  if (lg.espn_s2 && lg.swid) headers.Cookie = `espn_s2=${lg.espn_s2}; SWID=${lg.swid}`;
  const resp = await fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`ESPN ${resp.status} on the period ${period} boxscore`);
  return resp.json();
}

async function finalizePeriod(lg, season, period, payload, players, fetchImpl, now) {
  const { matchup, scoringPeriods } = matchupPeriodFor(payload, period);
  const box = await fetchBoxscore(lg, season, period, matchup, fetchImpl);
  const byTeam = new Map();
  const mismatched = [];
  for (const m of box.schedule ?? []) {
    if (Number(m.matchupPeriodId) !== matchup) continue;
    for (const side of [m.home, m.away]) {
      const entries = side?.rosterForCurrentScoringPeriod?.entries;
      if (!side || !Array.isArray(entries)) continue;
      const teamRows = rowsFromEntries(entries, { season, period, source: 'final', players });
      byTeam.set(Number(side.teamId), teamRows);
      // One scoring period per matchup: the starters must add up to ESPN's score.
      if (scoringPeriods === 1 && Number.isFinite(side.totalPoints)) {
        const starters = round2(teamRows.filter(r => r.is_starter).reduce((s, r) => s + (r.actual_points ?? 0), 0));
        if (Math.abs(starters - side.totalPoints) > 0.01) {
          mismatched.push({ team_id: Number(side.teamId), starters, espn_total: side.totalPoints });
        }
      }
    }
  }
  if (!byTeam.size) throw new Error(`ESPN returned no lineups for period ${period}`);
  const counts = writePeriod(lg.id, season, period, byTeam, 'final', now);
  return { period, teams: byTeam.size, ...counts, mismatched_teams: mismatched };
}

/**
 * One run over every ESPN league. `network: false` skips the boxscore pass (tests,
 * or a manual offline run); `fetchImpl` is injectable for tests.
 */
export async function collectRosterSnapshots({ fetchImpl = globalThis.fetch, network = true,
  now = () => new Date().toISOString() } = {}) {
  const started = Date.now();
  const players = playerIndex();
  const leagues = rows(`SELECT id, league_id, season, name, payload, espn_s2, swid FROM leagues
                        WHERE platform = 'espn' ORDER BY id`);
  const out = [];
  let writes = 0, fetches = 0;
  for (const lg of leagues) {
    const summary = { league_id: lg.id, name: String(lg.name ?? '').trim() };
    out.push(summary);
    try {
      if (!lg.payload) { summary.live = { skipped: 'league not synced' }; continue; }
      const payload = JSON.parse(lg.payload);
      const season = Number(lg.season);
      if (Number(payload.seasonId) !== season) {
        summary.live = { skipped: `payload is season ${payload.seasonId}, not ${season} (pre-draft fallback)` };
        continue;
      }
      const period = Number(payload.scoringPeriodId);
      if (!Number.isInteger(period) || period < 1) {
        summary.live = { skipped: `no scoring period yet (${payload.scoringPeriodId})` };
        continue;
      }
      if (hasFinal(lg.id, season, period)) {
        summary.live = { skipped: `period ${period} is already final` };
      } else {
        const byTeam = new Map((payload.teams ?? []).map(t => [Number(t.id),
          rowsFromEntries(t.roster?.entries, { season, period, source: 'live', players })]));
        const counts = writePeriod(lg.id, season, period, byTeam, 'live', now());
        summary.live = { period, teams: byTeam.size, ...counts };
        writes += counts.inserted + counts.updated + counts.dropped;
      }
      summary.final = [];
      if (!network) continue;
      for (const p of completedPeriods(payload)) {
        if (hasFinal(lg.id, season, p)) continue;
        fetches++;
        try {
          const f = await finalizePeriod(lg, season, p, payload, players, fetchImpl, now());
          summary.final.push(f);
          writes += f.inserted + f.updated + f.dropped;
        } catch (e) {
          summary.final.push({ period: p, error: String(e?.message ?? e).slice(0, 200) });
        }
      }
    } catch (e) {
      summary.error = String(e?.message ?? e).slice(0, 200);
    }
  }
  const failed = out.filter(l => l.error || (l.final ?? []).some(f => f.error || f.mismatched_teams?.length));
  const status = !failed.length ? 'ok' : failed.length === out.length && out.every(l => l.error) ? 'error' : 'partial';
  return { status, writes, fetches, ms: Date.now() - started, leagues: out };
}

export function recordRosterSnapshotRun(summary, at = new Date().toISOString()) {
  run(`INSERT INTO sync_log (job, last_run_at, last_status, last_detail, runs) VALUES ('roster_snapshots', ?, ?, ?, 1)
       ON CONFLICT(job) DO UPDATE SET last_run_at = excluded.last_run_at, last_status = excluded.last_status,
       last_detail = excluded.last_detail, runs = runs + 1`,
  at, summary.status, JSON.stringify(summary));
}

function describe(l) {
  const head = `league ${l.league_id} ${l.name}`.trim();
  if (l.error) return [`${head}: ERROR ${l.error}`];
  const live = l.live?.skipped ? `live skipped (${l.live.skipped})`
    : `live period ${l.live.period}: ${l.live.teams} teams, +${l.live.inserted} ~${l.live.updated} -${l.live.dropped}`;
  const lines = [`${head}: ${live}`];
  for (const f of l.final ?? []) {
    if (f.error) lines.push(`${head}: final period ${f.period} ERROR ${f.error}`);
    else {
      lines.push(`${head}: final period ${f.period}: ${f.teams} teams, +${f.inserted} ~${f.updated} -${f.dropped}`
        + (f.mismatched_teams.length ? ` MISMATCH ${JSON.stringify(f.mismatched_teams)}` : ''));
    }
  }
  return lines;
}

export async function main(argv = process.argv.slice(2)) {
  await (await import('../server/db/migrate.js')).runMigrations();
  const startedAt = new Date().toISOString();
  let summary;
  try {
    summary = await collectRosterSnapshots({ network: !argv.includes('--no-network') });
  } catch (e) {
    summary = { status: 'error', error: String(e?.message ?? e).slice(0, 200), writes: 0, fetches: 0, leagues: [] };
  }
  recordRosterSnapshotRun(summary, startedAt);
  if (argv.includes('--json')) console.log(JSON.stringify(summary));
  else {
    for (const l of summary.leagues) for (const line of describe(l)) console.log(line);
    console.log(`roster_snapshots: ${summary.status}${summary.error ? ` (${summary.error})` : ''}, `
      + `${summary.writes} writes, ${summary.fetches} fetches in ${summary.ms ?? '?'} ms`);
  }
  return summary.status === 'ok' ? 0 : 1;
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) process.exit(await main());
