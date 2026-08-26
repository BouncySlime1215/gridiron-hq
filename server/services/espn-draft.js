/**
 * Live ESPN draft mirror.
 *
 * ESPN's league endpoint exposes the entire draft board under `mDraftDetail`. Every
 * slot in the draft is pre-created before it starts — `playerId: -1`, with the round,
 * overall pick number and owning team already set — and each slot is filled in as the
 * pick happens. That makes a plain poll of this one endpoint enough to follow a live
 * draft, with no websocket and no scraping.
 *
 * Picks are mirrored into the same `draft_picks` table the mock drafter uses, so every
 * downstream feature (board, recommendation, grade) works unchanged on a live draft.
 */
import { rows, row, run, db } from '../db/index.js';
import { fetchEspnLeague } from './espn-client.js';
import { createHash } from 'node:crypto';
import { registerJob } from '../platform/jobs.js';

const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';

db.exec(`
  CREATE TABLE IF NOT EXISTS draft_advice (
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    pick_number INTEGER NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (draft_id, pick_number)
  );
`);

// Live drafts are bound to a connected league; mock drafts leave these null.
const draftCols = db.prepare(`PRAGMA table_info(drafts)`).all().map(c => c.name);
if (!draftCols.includes('league_row_id')) db.exec(`ALTER TABLE drafts ADD COLUMN league_row_id INTEGER`);
if (!draftCols.includes('espn_league_id')) db.exec(`ALTER TABLE drafts ADD COLUMN espn_league_id TEXT`);
if (!draftCols.includes('season')) db.exec(`ALTER TABLE drafts ADD COLUMN season INTEGER`);
if (!draftCols.includes('pick_order')) db.exec(`ALTER TABLE drafts ADD COLUMN pick_order TEXT`);
if (!draftCols.includes('roster_slots')) db.exec(`ALTER TABLE drafts ADD COLUMN roster_slots TEXT`);
if (!draftCols.includes('last_synced_at')) db.exec(`ALTER TABLE drafts ADD COLUMN last_synced_at TEXT`);
if (!draftCols.includes('draft_at')) db.exec(`ALTER TABLE drafts ADD COLUMN draft_at TEXT`);

const pickCols = db.prepare(`PRAGMA table_info(draft_picks)`).all().map(c => c.name);
if (!pickCols.includes('espn_team_id')) db.exec(`ALTER TABLE draft_picks ADD COLUMN espn_team_id INTEGER`);
if (!pickCols.includes('keeper')) db.exec(`ALTER TABLE draft_picks ADD COLUMN keeper INTEGER DEFAULT 0`);

/** ESPN cookies for one exact league/season. Never fall back across league rows. */
export function espnCookies(leagueId, season) {
  if (leagueId == null || season == null) return { s2: null, swid: null };
  const league = row(`SELECT espn_s2, swid FROM leagues
    WHERE platform='espn' AND league_id=? AND season=?`, String(leagueId), Number(season));
  return { s2: league?.espn_s2 ?? null, swid: league?.swid ?? null };
}

/** Draft board + settings + team names for a league. */
export function fetchDraftDetail(league) {
  if (!league.espn_s2 || !league.swid) {
    throw Object.assign(new Error('ESPN connection required'), { status: 400 });
  }
  return fetchEspnLeague({
    leagueId: league.league_id,
    season: league.season,
    espn_s2: league.espn_s2, swid: league.swid,
    views: ['mDraftDetail', 'mSettings', 'mTeam']
  });
}

const ESPN_POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF' };
const PRO_TEAM = {
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
  9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN',
  17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC',
  25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU'
};

/** ESPN lineup slot id -> our position label, for reading a league's roster requirements. */
export const SLOT_NAME = {
  0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'DEF', 17: 'K',
  23: 'FLEX', 20: 'BENCH', 21: 'IR', 7: 'OP'
};

/**
 * Starting-lineup requirements for a league, e.g. {QB:1,RB:2,WR:2,TE:1,FLEX:1,DEF:1,K:1}.
 * Bench and IR are excluded — they are depth, not lineup need.
 */
export function startingSlots(lineupSlotCounts = {}) {
  const out = {};
  for (const [slot, n] of Object.entries(lineupSlotCounts)) {
    const name = SLOT_NAME[Number(slot)];
    if (!name || name === 'BENCH' || name === 'IR' || !n) continue;
    out[name] = (out[name] ?? 0) + n;
  }
  return out;
}

function normalizedMemberId(value) {
  return String(value ?? '').trim().replace(/^\{/, '').replace(/\}$/, '').toLowerCase();
}

function teamName(team) {
  return team?.name || `${team?.location ?? ''} ${team?.nickname ?? ''}`.trim() || `Team ${team?.id}`;
}

function teamOwnerIds(team) {
  const values = [team?.primaryOwner, ...(Array.isArray(team?.owners) ? team.owners : [])];
  return [...new Set(values.map(normalizedMemberId).filter(Boolean))];
}

function rosterRequirements(lineupSlotCounts = {}) {
  const requirements = {};
  for (const [slot, count] of Object.entries(lineupSlotCounts)) {
    const name = SLOT_NAME[Number(slot)] ?? `SLOT_${slot}`;
    if (Number.isFinite(Number(count)) && Number(count) > 0) requirements[name] = Number(count);
  }
  return requirements;
}

/** Convert ESPN's setup payload into the stable, UI-safe Phase 3A contract. */
export function normalizeDraftDiscovery(data, league, { userId } = {}) {
  const settings = data?.settings ?? {};
  const draftSettings = settings.draftSettings ?? {};
  const detail = data?.draftDetail ?? {};
  const teams = Array.isArray(data?.teams) ? data.teams.filter(team => team?.id != null) : [];
  const ids = new Set(teams.map(team => String(team.id)));
  const rawOrder = Array.isArray(draftSettings.pickOrder) ? draftSettings.pickOrder : [];
  const pickOrder = rawOrder.map(id => String(id)).filter(id => ids.has(id));
  const validPickOrder = pickOrder.length === teams.length && new Set(pickOrder).size === teams.length;
  const teamCount = Number(settings.size ?? teams.length) || null;
  const totalSlots = Array.isArray(detail.picks) ? detail.picks.length : 0;
  const lineup = settings.rosterSettings?.lineupSlotCounts ?? {};
  const rosterCount = Object.values(lineup).reduce((sum, count) => sum + (Number(count) || 0), 0);
  const rounds = Number(draftSettings.numberOfRounds)
    || (totalSlots && teamCount ? totalSlots / teamCount : 0)
    || rosterCount || null;
  const status = detail.drafted ? 'completed' : detail.inProgress ? 'active' : 'scheduled';
  const memberId = normalizedMemberId(league.swid);
  const ownedTeams = memberId ? teams.filter(team => teamOwnerIds(team).includes(memberId)) : [];
  const confirmation = userId == null ? null : row(
    'SELECT espn_team_id FROM espn_team_confirmations WHERE league_row_id=? AND user_id=?',
    league.id, Number(userId));
  const confirmedTeam = confirmation && teams.find(team => String(team.id) === String(confirmation.espn_team_id));
  const provedTeam = ownedTeams.length === 1 ? ownedTeams[0] : null;
  const selectedTeam = provedTeam ?? confirmedTeam ?? null;
  const ownershipSource = provedTeam ? 'espn' : confirmedTeam ? 'confirmed' : null;
  const selectedIndex = selectedTeam && validPickOrder
    ? pickOrder.indexOf(String(selectedTeam.id)) : -1;
  const scheduledMillis = draftSettings.date == null ? NaN : Number(draftSettings.date);
  const scheduledTime = Number.isFinite(scheduledMillis)
    ? new Date(scheduledMillis).toISOString() : null;

  return {
    league_name: settings.name ?? league.name ?? `ESPN ${league.league_id}`,
    league_id: String(league.league_id),
    league_row_id: league.id,
    season: Number(league.season),
    draft_status: status,
    scheduled_time: scheduledTime,
    team_count: teamCount,
    round_count: Number.isInteger(rounds) ? rounds : null,
    draft_type: String(draftSettings.type ?? (draftSettings.auction ? 'AUCTION' : 'SNAKE')).toLowerCase(),
    pick_timer_seconds: Number(draftSettings.timePerSelection) || null,
    roster_requirements: rosterRequirements(lineup),
    user_team: selectedTeam ? { id: String(selectedTeam.id), name: teamName(selectedTeam) } : null,
    user_draft_slot: selectedIndex >= 0 ? selectedIndex + 1 : null,
    ownership: {
      state: provedTeam ? 'proven' : confirmedTeam ? 'confirmed' : 'confirmation_required',
      source: ownershipSource,
      can_start: !!selectedTeam && selectedIndex >= 0,
      reason: !selectedTeam ? 'team_confirmation_required'
        : selectedIndex < 0 ? 'pick_order_unavailable' : null
    },
    pick_order: validPickOrder ? pickOrder : null,
    teams: teams.map(team => ({ id: String(team.id), name: teamName(team) }))
  };
}

/** Fetch the current setup without creating or modifying any draft or ownership row. */
export async function discoverLiveDraft(leagueRowId, { userId } = {}) {
  const league = row('SELECT * FROM leagues WHERE id = ?', Number(leagueRowId));
  if (!league) throw Object.assign(new Error('league not found'), { status: 404 });
  if (league.platform !== 'espn') throw Object.assign(new Error('live draft discovery is ESPN-only'), { status: 400 });
  return normalizeDraftDiscovery(await fetchDraftDetail(league), league, { userId });
}

/**
 * ESPN player id -> our player row, inserting a stub for anyone we have never seen.
 *
 * A live draft cannot afford to drop a pick it can't resolve: `draft_picks.pick_number`
 * is a dense sequence, so one skipped pick would shift every later pick onto the wrong
 * team for the rest of the draft. Deep-league fliers and late-camp adds do get taken,
 * so unknown ids are looked up against ESPN's own player pool and inserted.
 */
let poolCache = { season: null, at: 0, map: null };

async function espnPlayerPool(season) {
  if (poolCache.map && poolCache.season === season && Date.now() - poolCache.at < 30 * 60_000) return poolCache.map;
  const filter = { players: { limit: 2000, sortPercOwned: { sortAsc: false, sortPriority: 1 } } };
  const resp = await fetch(`${BASE}/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`, {
    headers: { Accept: 'application/json', 'x-fantasy-filter': JSON.stringify(filter) },
    signal: AbortSignal.timeout(20000)
  });
  if (!resp.ok) throw new Error(`ESPN player pool ${resp.status}`);
  const data = await resp.json();
  const map = new Map();
  for (const e of data.players ?? []) {
    const p = e.player ?? e;
    if (p?.id == null) continue;
    map.set(p.id, { name: p.fullName, position: ESPN_POS[p.defaultPositionId], proTeam: PRO_TEAM[p.proTeamId] });
  }
  poolCache = { season, at: Date.now(), map };
  return map;
}

async function prepareEspnPlayers(espnIds, season) {
  const known = new Map(rows(
    `SELECT id, espn_id FROM players WHERE espn_id IS NOT NULL`).map(p => [p.espn_id, p.id]));
  const missing = espnIds.filter(id => !known.has(id));
  if (!missing.length) return { known, missing: new Map() };

  const pool = await espnPlayerPool(season);
  const unresolved = missing.filter(id => !pool.has(id));
  if (unresolved.length) throw invalidSnapshot('unknown ESPN player', { player_ids: unresolved });
  return { known, missing: new Map(missing.map(id => [id, pool.get(id)])) };
}

function materializeEspnPlayers(plan) {
  const known = new Map(plan.known);
  const teamIdByAbbr = new Map(rows(`SELECT id, abbr FROM nfl_teams`).map(t => [t.abbr, t.id]));
  for (const [espnId, info] of plan.missing) {
    const claimed = row('SELECT id FROM players WHERE espn_id = ?', espnId);
    if (claimed) { known.set(espnId, claimed.id); continue; }
    const name = info.name;
    // A seed row for this player may already exist with no espn_id yet. Claiming it
    // here (rather than always inserting) is what keeps a draft sync from creating a
    // second, unrostered row for the same person — see resolvePlayer() in trade-engine.js.
    const existing = row('SELECT id FROM players WHERE lower(name) = lower(?) AND espn_id IS NULL', name);
    if (existing) {
      run('UPDATE players SET espn_id = ?, fantasy_relevant = 1, team_id = COALESCE(?, team_id) WHERE id = ?',
        espnId, teamIdByAbbr.get(info?.proTeam) ?? null, existing.id);
      known.set(espnId, existing.id);
      continue;
    }
    const result = run(`INSERT INTO players (name, position, team_id, espn_id, fantasy_relevant)
         VALUES (?,?,?,?,1)`,
      name, info?.position ?? 'WR', teamIdByAbbr.get(info?.proTeam) ?? null, espnId);
    known.set(espnId, Number(result.lastInsertRowid));
  }
  return known;
}

function invalidSnapshot(message, details = {}) {
  return Object.assign(new Error(`invalid ESPN draft snapshot: ${message}`), {
    status: 422, code: 'ESPN_INVALID_SNAPSHOT', category: 'invalid_data', details
  });
}

function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Validate and normalize one complete ESPN board without touching the database.
 * A populated board must contain every pre-created ESPN slot; made picks must form
 * a dense prefix. This distinguishes a legitimate in-progress board from a
 * truncated response that would otherwise delete valid local picks.
 */
export function normalizeAuthoritativeSnapshot(data, draft) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidSnapshot('payload is not an object');
  const detail = data.draftDetail;
  const settings = data.settings;
  const draftSettings = settings?.draftSettings;
  if (!detail || typeof detail !== 'object' || !draftSettings || typeof draftSettings !== 'object') {
    throw invalidSnapshot('draft detail or settings missing');
  }
  if (!Array.isArray(detail.picks) || !Array.isArray(draftSettings.pickOrder) || !Array.isArray(data.teams)) {
    throw invalidSnapshot('picks, pick order, or teams missing');
  }

  const teamCount = Number(draft.team_count);
  const rounds = Number(draft.rounds);
  const total = teamCount * rounds;
  if (!Number.isInteger(teamCount) || teamCount < 2 || !Number.isInteger(rounds) || rounds < 1) {
    throw invalidSnapshot('local draft dimensions are invalid');
  }
  const teams = data.teams.map(team => String(team?.id ?? ''));
  const teamSet = new Set(teams);
  if (teams.length !== teamCount || teamSet.size !== teamCount || teamSet.has('')) {
    throw invalidSnapshot('team list does not match draft dimensions');
  }
  const pickOrder = draftSettings.pickOrder.map(id => String(id));
  if (pickOrder.length !== teamCount || new Set(pickOrder).size !== teamCount
      || pickOrder.some(id => !teamSet.has(id))) {
    throw invalidSnapshot('pick order is incomplete or inconsistent');
  }
  if (detail.picks.length !== 0 && detail.picks.length !== total) {
    throw invalidSnapshot('board is truncated', { expected_slots: total, received_slots: detail.picks.length });
  }
  if ((detail.inProgress || detail.drafted) && detail.picks.length !== total) {
    throw invalidSnapshot('active or completed board is truncated', { expected_slots: total, received_slots: detail.picks.length });
  }

  const slotNumbers = new Set();
  const made = [];
  for (const raw of detail.picks) {
    if (!raw || typeof raw !== 'object') throw invalidSnapshot('pick entry is malformed');
    const pickNumber = Number(raw.overallPickNumber);
    if (!Number.isInteger(pickNumber) || pickNumber < 1 || pickNumber > total || slotNumbers.has(pickNumber)) {
      throw invalidSnapshot('duplicate or impossible pick number', { pick_number: raw.overallPickNumber });
    }
    slotNumbers.add(pickNumber);
    if (raw.playerId === -1) continue;
    const playerId = Number(raw.playerId);
    const espnTeamId = String(raw.teamId ?? '');
    if (!Number.isInteger(playerId) || playerId === -1) throw invalidSnapshot('pick has an invalid player id', { pick_number: pickNumber });
    if (!teamSet.has(espnTeamId)) throw invalidSnapshot('pick references an unknown team', { pick_number: pickNumber, team_id: espnTeamId });
    made.push({
      pick_number: pickNumber,
      espn_player_id: playerId,
      espn_team_id: espnTeamId,
      team_slot: pickOrder.indexOf(espnTeamId) + 1,
      keeper: raw.keeper === true || raw.keeper === 1 ? 1 : 0
    });
  }
  if (detail.picks.length && slotNumbers.size !== total) throw invalidSnapshot('board slot numbers are incomplete');
  made.sort((a, b) => a.pick_number - b.pick_number);
  if (made.some((pick, index) => pick.pick_number !== index + 1)) {
    throw invalidSnapshot('made picks contain an invalid gap');
  }
  const playerIds = made.map(pick => pick.espn_player_id);
  if (new Set(playerIds).size !== playerIds.length) throw invalidSnapshot('duplicate drafted player');
  if (detail.drafted && made.length !== total) throw invalidSnapshot('completed board has unfilled picks');

  const status = detail.drafted ? 'complete' : detail.inProgress || made.length ? 'active' : 'scheduled';
  const canonical = { pick_order: pickOrder, status, picks: made };
  return { ...canonical, hash: canonicalHash(canonical), total };
}

/**
 * Create (or find) the live draft row mirroring a connected league's ESPN draft.
 * Idempotent: calling it again returns the existing draft and refreshes its settings.
 */
export async function ensureLiveDraft(leagueRowId, { userId, confirmedTeamId } = {}) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueRowId);
  if (!lg) throw Object.assign(new Error('league not found'), { status: 404 });
  if (lg.platform !== 'espn') throw Object.assign(new Error('live draft sync is ESPN-only'), { status: 400 });

  if (!Number.isInteger(Number(userId))) throw Object.assign(new Error('authenticated user required'), { status: 401 });
  const data = await fetchDraftDetail(lg);
  const teams = Array.isArray(data.teams) ? data.teams : [];
  if (confirmedTeamId != null) {
    const selected = teams.find(team => String(team.id) === String(confirmedTeamId));
    if (!selected) throw Object.assign(new Error('confirmed ESPN team is not in this league'), { status: 400 });
    run(`INSERT INTO espn_team_confirmations (league_row_id,user_id,espn_team_id,confirmed_at)
         VALUES (?,?,?,datetime('now'))
         ON CONFLICT(league_row_id,user_id) DO UPDATE SET
           espn_team_id=excluded.espn_team_id, confirmed_at=excluded.confirmed_at`,
      lg.id, Number(userId), String(selected.id));
  }
  const setup = normalizeDraftDiscovery(data, lg, { userId });
  if (!setup.ownership.can_start) {
    throw Object.assign(new Error(setup.ownership.reason === 'pick_order_unavailable'
      ? 'ESPN pick order is not available yet' : 'explicit ESPN team confirmation required'), {
      status: 409, code: setup.ownership.reason === 'pick_order_unavailable'
        ? 'ESPN_PICK_ORDER_UNAVAILABLE' : 'ESPN_TEAM_CONFIRMATION_REQUIRED', discovery: setup
    });
  }
  const ds = data.settings?.draftSettings ?? {};
  const lineup = data.settings?.rosterSettings?.lineupSlotCounts ?? {};
  const pickOrder = setup.pick_order;
  const teamCount = setup.team_count;
  const rounds = setup.round_count;
  const mySlot = setup.user_draft_slot;

  const identity = row(`SELECT d.* FROM espn_live_draft_identity i
    JOIN drafts d ON d.id=i.draft_id WHERE i.league_row_id=? AND i.season=?`, lg.id, lg.season);
  const legacy = identity ?? row(`SELECT * FROM drafts WHERE type='live' AND league_row_id=? AND season=? ORDER BY id LIMIT 1`, lg.id, lg.season);
  const name = `${setup.league_name} — ${lg.season} draft`;
  const teamNames = JSON.stringify(Object.fromEntries((data.teams ?? []).map(t =>
    [t.id, t.name || `${t.location ?? ''} ${t.nickname ?? ''}`.trim() || `Team ${t.id}`])));

  let draftId = legacy?.id ?? null;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (draftId) {
      run(`INSERT OR IGNORE INTO espn_live_draft_identity (league_row_id,season,draft_id) VALUES (?,?,?)`, lg.id, lg.season, draftId);
      run(`UPDATE drafts SET name=?, team_count=?, rounds=?, my_slot=?, pick_seconds=?,
         pick_order=?, roster_slots=?, espn_league_id=?, draft_at=?, espn_draft_status=?,
         espn_draft_type=?, espn_team_id=?, espn_ownership_source=?, setup_synced_at=datetime('now') WHERE id=?`,
      name, teamCount, rounds, mySlot, ds.timePerSelection ?? 90,
      JSON.stringify({ order: pickOrder, team_names: JSON.parse(teamNames) }),
      JSON.stringify(startingSlots(lineup)), String(lg.league_id),
      setup.scheduled_time, setup.draft_status, setup.draft_type, setup.user_team.id,
      setup.ownership.source, draftId);
    } else {
      const inserted = run(`INSERT INTO drafts (name, type, team_count, rounds, my_slot, pick_seconds,
          league_row_id, espn_league_id, season, pick_order, roster_slots, draft_at,
          espn_draft_status,espn_draft_type,espn_team_id,espn_ownership_source,setup_synced_at)
         VALUES (?, 'live', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      name, teamCount, rounds, mySlot, ds.timePerSelection ?? 90,
      lg.id, String(lg.league_id), lg.season,
      JSON.stringify({ order: pickOrder, team_names: JSON.parse(teamNames) }),
      JSON.stringify(startingSlots(lineup)), setup.scheduled_time, setup.draft_status,
      setup.draft_type, setup.user_team.id, setup.ownership.source);
      draftId = Number(inserted.lastInsertRowid);
      run(`INSERT INTO espn_live_draft_identity (league_row_id,season,draft_id) VALUES (?,?,?)`, lg.id, lg.season, draftId);
    }
    run(`INSERT INTO draft_team_ownership (draft_id,team_slot,user_id) VALUES (?,?,?)
         ON CONFLICT(draft_id,user_id) DO UPDATE SET team_slot=excluded.team_slot`, draftId, mySlot, Number(userId));
    run(`INSERT OR IGNORE INTO espn_draft_sync_state (draft_id,recovery_state)
         VALUES (?, 'catch_up')`, draftId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { draft_id: draftId, created: !legacy, discovery: setup };
}

/** Pull, validate, and transactionally make the local ESPN board exactly authoritative. */
async function syncLiveDraftImpl(draftId) {
  const draft = row('SELECT * FROM drafts WHERE id = ?', draftId);
  if (!draft) throw Object.assign(new Error('draft not found'), { status: 404 });
  if (draft.type !== 'live' || !draft.espn_league_id) {
    throw Object.assign(new Error('not an ESPN-linked live draft'), { status: 400 });
  }

  const league = row('SELECT * FROM leagues WHERE id = ?', draft.league_row_id);
  if (!league || league.platform !== 'espn'
      || String(league.league_id) !== String(draft.espn_league_id)
      || Number(league.season) !== Number(draft.season)) {
    throw Object.assign(new Error('draft is not bound to its requested ESPN league'), { status: 409 });
  }
  const data = await fetchDraftDetail(league);
  const snapshot = normalizeAuthoritativeSnapshot(data, draft);
  const existing = rows(`SELECT dp.pick_number, dp.team_slot, dp.espn_team_id, dp.keeper, p.espn_id AS espn_player_id
    FROM draft_picks dp JOIN players p ON p.id=dp.player_id WHERE dp.draft_id=? ORDER BY dp.pick_number`, draftId)
    .map(pick => ({ pick_number: pick.pick_number, espn_player_id: pick.espn_player_id,
      espn_team_id: String(pick.espn_team_id), team_slot: pick.team_slot, keeper: Number(pick.keeper) }));
  const boardMatches = JSON.stringify(existing) === JSON.stringify(snapshot.picks);
  const snapshotMatches = draft.espn_snapshot_hash === snapshot.hash;

  let changed = [];
  let revision = Number(draft.espn_board_revision ?? 0);
  if (!boardMatches || !snapshotMatches || draft.status !== snapshot.status) {
    const plan = await prepareEspnPlayers([...new Set(snapshot.picks.map(pick => pick.espn_player_id))], draft.season);
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = row('SELECT espn_snapshot_hash, espn_board_revision FROM drafts WHERE id=?', draftId);
      // Another process may have reconciled the same snapshot while player metadata
      // was fetched. Treat that as the same serialized result, not another revision.
      if (!snapshotMatches && current?.espn_snapshot_hash === snapshot.hash) {
        db.exec('COMMIT');
        revision = Number(current.espn_board_revision ?? 0);
      } else {
        const idMap = materializeEspnPlayers(plan);
        run('DELETE FROM draft_picks WHERE draft_id=?', draftId);
        for (const pick of snapshot.picks) {
          const playerId = idMap.get(pick.espn_player_id);
          if (!playerId) throw invalidSnapshot('player mapping disappeared during reconciliation');
          run(`INSERT INTO draft_picks
            (draft_id,pick_number,team_slot,player_id,espn_team_id,keeper,source)
            VALUES (?,?,?,?,?,?,'espn')`, draftId, pick.pick_number, pick.team_slot,
          playerId, pick.espn_team_id, pick.keeper);
        }
        revision = Number(current?.espn_board_revision ?? 0) + 1;
        run(`UPDATE drafts SET status=?, pick_order=?, last_synced_at=datetime('now'),
          espn_snapshot_hash=?, espn_snapshot_pick_count=?, espn_board_revision=? WHERE id=?`,
        snapshot.status,
        JSON.stringify({ order: snapshot.pick_order,
          team_names: JSON.parse(draft.pick_order ?? '{}').team_names ?? {} }),
        snapshot.hash, snapshot.picks.length, revision, draftId);
        db.exec('COMMIT');
        const before = new Map(existing.map(pick => [pick.pick_number, pick]));
        const after = new Map(snapshot.picks.map(pick => [pick.pick_number, pick]));
        changed = [...new Set([...before.keys(), ...after.keys()])]
          .filter(number => JSON.stringify(before.get(number)) !== JSON.stringify(after.get(number)))
          .sort((a, b) => a - b);
      }
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const count = snapshot.picks.length;
  const nextPick = count + 1;

  return {
    ok: true,
    espn_in_progress: snapshot.status === 'active',
    espn_complete: snapshot.status === 'complete',
    picks_on_espn: count,
    picks_mirrored: count,
    new_picks: changed.filter(number => !existing.some(pick => pick.pick_number === number)),
    changed_picks: changed,
    failures: [],
    desynced: false,
    board_revision: revision,
    snapshot_hash: snapshot.hash,
    idempotent: changed.length === 0,
    next_pick: nextPick <= snapshot.total ? nextPick : null,
    on_the_clock_slot: nextPick <= snapshot.total ? slotForPick(nextPick, draft.team_count) : null,
    my_slot: draft.my_slot,
    my_turn: nextPick <= snapshot.total && slotForPick(nextPick, draft.team_count) === draft.my_slot
  };
}

// One sync in flight per draft at a time. The client polls on a plain 4s interval with
// no overlap guard, and ESPN's API is often slower during a live draft than off it — an
// overlapping second sync racing the first through resolveEspnPlayers() is exactly how
// the same new player ends up inserted twice under different local ids, or a pick
// silently lost to the UNIQUE(draft_id, pick_number) race between two inserts.
const inFlight = new Map();
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;

function syncFailure(error) {
  if (error?.code === 'ESPN_AUTHENTICATION_FAILED' || error?.code === 'ESPN_INVALID_CREDENTIALS') {
    return { category: 'authentication', health: 'auth_required', retry: 'stopped' };
  }
  if (error?.code === 'ESPN_INVALID_SNAPSHOT' || error?.code === 'ESPN_MALFORMED_RESPONSE'
      || error?.code === 'ESPN_LEAGUE_MISMATCH') {
    return { category: 'invalid_data', health: 'invalid_data', retry: 'stopped' };
  }
  return { category: 'transient', health: 'retrying', retry: 'scheduled' };
}

function retryDelay(draftId, failures) {
  const exponential = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(failures - 1, 5)));
  // Stable per-draft jitter keeps tests deterministic while preventing every draft
  // on a restarted server from retrying on the same millisecond.
  const jitter = (Number(draftId) * 1103515245 + failures * 12345) >>> 0;
  return Math.min(RETRY_MAX_MS, exponential + (jitter % Math.max(1, Math.floor(exponential / 4))));
}

function ensureSyncState(draftId) {
  run(`INSERT OR IGNORE INTO espn_draft_sync_state (draft_id,recovery_state)
       VALUES (?, 'catch_up')`, Number(draftId));
}

function beginSyncAttempt(draftId, recoveryState) {
  ensureSyncState(draftId);
  run(`UPDATE espn_draft_sync_state SET health_state='syncing', last_attempt_at=datetime('now'),
       retry_status='ready', next_retry_at=NULL, recovery_state=?, updated_at=datetime('now')
       WHERE draft_id=?`, recoveryState, Number(draftId));
}

function recordSyncSuccess(draftId, result) {
  const complete = result.espn_complete;
  run(`UPDATE espn_draft_sync_state SET health_state=?, last_success_at=datetime('now'),
       failure_category=NULL, failure_code=NULL, failure_message=NULL,
       consecutive_failures=0, next_retry_at=NULL, retry_status=?, recovery_state='recovered',
       updated_at=datetime('now') WHERE draft_id=?`,
  complete ? 'complete' : 'healthy', complete ? 'complete' : 'ready', Number(draftId));
}

function recordSyncFailure(draftId, error) {
  const failure = syncFailure(error);
  const current = row(`SELECT consecutive_failures,retry_count FROM espn_draft_sync_state WHERE draft_id=?`, Number(draftId));
  const failures = Number(current?.consecutive_failures ?? 0) + 1;
  const nextRetryAt = failure.retry === 'scheduled'
    ? new Date(Date.now() + retryDelay(draftId, failures)).toISOString() : null;
  run(`UPDATE espn_draft_sync_state SET health_state=?, last_failure_at=datetime('now'),
       failure_category=?, failure_code=?, failure_message=?, consecutive_failures=?,
       retry_count=?, next_retry_at=?, retry_status=?, recovery_state=?, updated_at=datetime('now')
       WHERE draft_id=?`, failure.health, failure.category, error?.code ?? 'ESPN_SYNC_FAILED',
  String(error?.message ?? 'ESPN synchronization failed').slice(0, 500), failures,
  Number(current?.retry_count ?? 0) + 1, nextRetryAt, failure.retry,
  failure.retry === 'stopped' ? 'action_required' : 'catch_up', Number(draftId));
}

export function syncLiveDraft(draftId, { recoveryState = 'none' } = {}) {
  const key = String(draftId);
  if (inFlight.has(key)) return inFlight.get(key);
  const p = (async () => {
    beginSyncAttempt(draftId, recoveryState);
    try {
      const result = await syncLiveDraftImpl(draftId);
      recordSyncSuccess(draftId, result);
      return result;
    } catch (error) {
      recordSyncFailure(draftId, error);
      throw error;
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

export function liveDraftSyncStatus(draftId) {
  ensureSyncState(draftId);
  const state = row(`SELECT s.*, d.espn_snapshot_pick_count AS board_count,
      d.espn_board_revision AS board_revision, d.status AS draft_status,
      d.last_synced_at AS board_synced_at
    FROM espn_draft_sync_state s JOIN drafts d ON d.id=s.draft_id WHERE s.draft_id=?`, Number(draftId));
  return state;
}

/** Reconcile every due ESPN draft. Terminal auth/data failures wait for a manual retry. */
export async function syncDueLiveDrafts({ now = new Date() } = {}) {
  const due = rows(`SELECT d.id FROM drafts d
    LEFT JOIN espn_draft_sync_state s ON s.draft_id=d.id
    WHERE d.type='live' AND d.espn_league_id IS NOT NULL AND d.status<>'complete'
      AND (s.draft_id IS NULL OR s.retry_status IN ('ready','scheduled'))
      AND (s.next_retry_at IS NULL OR s.next_retry_at<=?)
    ORDER BY d.id`, now.toISOString());
  return Promise.all(due.map(({ id }) => syncLiveDraft(id, { recoveryState: 'catch_up' })
    .then(result => ({ draft_id: id, ok: true, result }))
    .catch(error => ({ draft_id: id, ok: false, code: error?.code ?? 'ESPN_SYNC_FAILED' }))));
}

export function startEspnDraftSyncJob({ intervalMs = 4_000 } = {}) {
  return registerJob('espn-live-draft-sync', {
    intervalMs, runImmediately: true, run: () => syncDueLiveDrafts()
  });
}

/** Snake order: odd rounds run 1..N, even rounds run back N..1. */
export function slotForPick(pickNumber, teamCount) {
  const round = Math.ceil(pickNumber / teamCount);
  const inRound = ((pickNumber - 1) % teamCount) + 1;
  return round % 2 === 1 ? inRound : teamCount - inRound + 1;
}

/** Every remaining pick number belonging to a given slot, in order. */
export function myUpcomingPicks(fromPick, mySlot, teamCount, rounds, limit = 4) {
  const out = [];
  for (let p = fromPick; p <= teamCount * rounds && out.length < limit; p++) {
    if (slotForPick(p, teamCount) === mySlot) out.push(p);
  }
  return out;
}
