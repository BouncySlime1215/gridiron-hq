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
import { reconcileDraftBoard, openQuarantine } from './draft-reconcile.js';
import { normalizePlayerName } from './player-identity.js';

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
// NULL/0 means "we could not prove which ESPN team is the connected user's" — the
// client must ask them to confirm before treating any slot as "my turn" (Phase 3A).
if (!draftCols.includes('my_slot_confirmed')) db.exec(`ALTER TABLE drafts ADD COLUMN my_slot_confirmed INTEGER DEFAULT 1`);

const pickCols = db.prepare(`PRAGMA table_info(draft_picks)`).all().map(c => c.name);
if (!pickCols.includes('espn_team_id')) db.exec(`ALTER TABLE draft_picks ADD COLUMN espn_team_id INTEGER`);
if (!pickCols.includes('keeper')) db.exec(`ALTER TABLE draft_picks ADD COLUMN keeper INTEGER DEFAULT 0`);

/** ESPN cookies, from wherever the user connected (bookmarklet or manual form). */
export function espnCookies() {
  const get = k => row(`SELECT value FROM app_settings WHERE key = ?`, k)?.value ?? null;
  let s2 = get('espn_s2'), swid = get('swid');
  if (!s2 || !swid) {
    const lg = row(`SELECT espn_s2, swid FROM leagues
                    WHERE platform='espn' AND espn_s2 IS NOT NULL AND swid IS NOT NULL
                    ORDER BY fetched_at DESC LIMIT 1`);
    s2 = lg?.espn_s2 ?? null; swid = lg?.swid ?? null;
  }
  return { s2, swid };
}

async function espnGet(leagueId, season, views) {
  const { s2, swid } = espnCookies();
  const url = `${BASE}/seasons/${season}/segments/0/leagues/${leagueId}?${views.map(v => `view=${v}`).join('&')}`;
  const headers = { Accept: 'application/json' };
  if (s2 && swid) headers.Cookie = `espn_s2=${s2}; SWID=${swid}`;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`ESPN API ${resp.status} on league ${leagueId}`);
  return resp.json();
}

/** Draft board + settings + team names for a league. */
export function fetchDraftDetail(leagueId, season) {
  return espnGet(leagueId, season, ['mDraftDetail', 'mSettings', 'mTeam']);
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

/**
 * ESPN player id -> our player row, for ids ESPN's own pool can genuinely resolve.
 *
 * An id ESPN's pool doesn't have any record of at all is left OUT of the returned
 * map on purpose — the caller (the reconciliation engine) quarantines it instead of
 * this function inventing a name and guessing a position for it. A fabricated "WR"
 * fallback used to sit here; that's exactly what put unresolved kickers, defenses,
 * and deep-league fliers on the board under a made-up position (Phase 3C).
 */
export async function resolveEspnPlayers(espnIds, season) {
  const known = new Map(rows(
    `SELECT id, espn_id FROM players WHERE espn_id IS NOT NULL`).map(p => [p.espn_id, p.id]));
  const missing = espnIds.filter(id => !known.has(id));
  if (!missing.length) return known;

  let pool;
  try { pool = await espnPlayerPool(season); } catch { pool = new Map(); }
  const teamIdByAbbr = new Map(rows(`SELECT id, abbr FROM nfl_teams`).map(t => [t.abbr, t.id]));

  // Seed/import rows with no espn_id yet are the same players ESPN is about to hand
  // us an id for; inserting unconditionally created a permanent twin row (fixed in
  // trade-engine.js#resolvePlayer as a read-time workaround, but the duplicate
  // itself was never stopped at the source). Claim the existing row by normalized
  // name + position when exactly one candidate matches; an ambiguous name (two
  // real players sharing it at the same position) falls back to inserting, same
  // as before, rather than risk claiming the wrong one.
  const unclaimed = new Map();
  for (const p of rows(`SELECT id, name, position FROM players WHERE espn_id IS NULL`)) {
    const key = `${normalizePlayerName(p.name)}|${p.position}`;
    (unclaimed.get(key) ?? unclaimed.set(key, []).get(key)).push(p.id);
  }

  for (const espnId of missing) {
    const info = pool.get(espnId);
    if (!info?.name || !info?.position) continue; // genuinely unresolvable — leave for quarantine, do not fabricate
    const teamId = teamIdByAbbr.get(info.proTeam) ?? null;
    const candidates = unclaimed.get(`${normalizePlayerName(info.name)}|${info.position}`);
    if (candidates?.length === 1) {
      const [claimId] = candidates;
      run(`UPDATE players SET espn_id = ?, team_id = COALESCE(?, team_id), fantasy_relevant = 1 WHERE id = ?`,
        espnId, teamId, claimId);
      known.set(espnId, claimId);
      continue;
    }
    run(`INSERT INTO players (name, position, team_id, espn_id, fantasy_relevant)
         VALUES (?,?,?,?,1)`,
      info.name, info.position, teamId, espnId);
    known.set(espnId, row('SELECT last_insert_rowid() AS id').id);
  }
  return known;
}

/**
 * Create (or find) the live draft row mirroring a connected league's ESPN draft.
 * Idempotent: calling it again returns the existing draft and refreshes its settings.
 */
export async function ensureLiveDraft(leagueRowId) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueRowId);
  if (!lg) throw Object.assign(new Error('league not found'), { status: 404 });
  if (lg.platform !== 'espn') throw Object.assign(new Error('live draft sync is ESPN-only'), { status: 400 });

  const data = await fetchDraftDetail(lg.league_id, lg.season);
  const ds = data.settings?.draftSettings ?? {};
  const lineup = data.settings?.rosterSettings?.lineupSlotCounts ?? {};
  const pickOrder = ds.pickOrder ?? (data.teams ?? []).map(t => t.id);
  const teamCount = pickOrder.length || data.teams?.length || 10;
  const totalSlots = (data.draftDetail?.picks ?? []).length;
  const rounds = totalSlots && teamCount ? Math.round(totalSlots / teamCount)
    : Object.values(lineup).reduce((s, n) => s + n, 0);
  // A user whose ESPN team can't be matched in the current pick order must never be
  // silently assigned slot 1 — that would misattribute "my turn" to a stranger's team.
  const mySlotIndex = pickOrder.indexOf(Number(lg.my_team_id));
  const mySlot = mySlotIndex === -1 ? null : mySlotIndex + 1;
  const mySlotConfirmed = mySlotIndex === -1 ? 0 : 1;

  const existing = row(`SELECT * FROM drafts WHERE type='live' AND league_row_id = ? AND season = ?`,
    lg.id, lg.season);
  const name = `${lg.name ?? `ESPN ${lg.league_id}`} — ${lg.season} draft`;
  const teamNames = JSON.stringify(Object.fromEntries((data.teams ?? []).map(t =>
    [t.id, t.name || `${t.location ?? ''} ${t.nickname ?? ''}`.trim() || `Team ${t.id}`])));

  if (existing) {
    // Don't let a transient lookup miss silently un-confirm a team the user already
    // had correctly matched — only overwrite my_slot/confirmation if this pass found
    // it, or if it was never confirmed to begin with (nothing to lose either way).
    const keepPrevious = !mySlotConfirmed && existing.my_slot_confirmed;
    const finalSlot = keepPrevious ? existing.my_slot : mySlot;
    const finalConfirmed = keepPrevious ? existing.my_slot_confirmed : mySlotConfirmed;
    run(`UPDATE drafts SET name=?, team_count=?, rounds=?, my_slot=?, my_slot_confirmed=?, pick_seconds=?,
         pick_order=?, roster_slots=?, espn_league_id=?, draft_at=? WHERE id=?`,
      name, teamCount, rounds, finalSlot, finalConfirmed, ds.timePerSelection ?? 90,
      JSON.stringify({ order: pickOrder, team_names: JSON.parse(teamNames) }),
      JSON.stringify(startingSlots(lineup)), String(lg.league_id),
      ds.date ? new Date(ds.date).toISOString() : null, existing.id);
    return { draft_id: existing.id, created: false, my_slot_confirmed: Boolean(finalConfirmed) };
  }

  run(`INSERT INTO drafts (name, type, team_count, rounds, my_slot, my_slot_confirmed, pick_seconds,
        league_row_id, espn_league_id, season, pick_order, roster_slots, draft_at)
       VALUES (?, 'live', ?,?,?,?,?,?,?,?,?,?,?)`,
    name, teamCount, rounds, mySlot, mySlotConfirmed, ds.timePerSelection ?? 90,
    lg.id, String(lg.league_id), lg.season,
    JSON.stringify({ order: pickOrder, team_names: JSON.parse(teamNames) }),
    JSON.stringify(startingSlots(lineup)),
    ds.date ? new Date(ds.date).toISOString() : null);
  return { draft_id: row('SELECT last_insert_rowid() AS id').id, created: true, my_slot_confirmed: Boolean(mySlotConfirmed) };
}

/**
 * Pull the current ESPN board and mirror any picks we don't have yet.
 *
 * Cheap enough to call every couple of seconds: it only writes when a new pick has
 * actually landed, and returns just the deltas so the UI can announce them.
 */
async function syncLiveDraftImpl(draftId) {
  const draft = row('SELECT * FROM drafts WHERE id = ?', draftId);
  if (!draft) throw Object.assign(new Error('draft not found'), { status: 404 });
  if (draft.type !== 'live' || !draft.espn_league_id) {
    throw Object.assign(new Error('not an ESPN-linked live draft'), { status: 400 });
  }

  const data = await fetchDraftDetail(draft.espn_league_id, draft.season);
  const detail = data.draftDetail ?? {};
  const ds = data.settings?.draftSettings ?? {};
  const pickOrder = ds.pickOrder ?? JSON.parse(draft.pick_order ?? '{}').order ?? [];
  const slotOf = new Map(pickOrder.map((teamId, i) => [teamId, i + 1]));

  // Only slots that have actually been used. ESPN's own sentinel for "not filled yet"
  // is exactly -1 (see the file comment) — every real pick, including D/ST (whose ids
  // can be positive or negative depending on league/season), is anything else. An
  // earlier version of this guessed at a numeric range for D/ST ids and silently
  // dropped any pick that fell outside it; trust ESPN's actual sentinel instead.
  const made = (detail.picks ?? [])
    .filter(p => p.playerId != null && p.playerId !== -1)
    .sort((a, b) => a.overallPickNumber - b.overallPickNumber);

  // Resolve every pick ESPN reports, not just ones missing locally — a correction or
  // renumber can touch an already-mirrored pick, and the engine needs the full picture
  // to detect that. resolveEspnPlayers() is a no-op for ids already known.
  const idMap = made.length
    ? await resolveEspnPlayers([...new Set(made.map(p => p.playerId))], draft.season)
    : new Map();

  // An ESPN response with zero picks while we already have mirrored picks is far more
  // likely a transient/incomplete response than a real draft reset — treating it as
  // authoritative would wipe the whole board as "stale". Skip reconciliation for this
  // poll instead (Phase 3B / spec B.14: preserve the previous valid board rather than
  // apply a reconciliation that cannot be trusted).
  const hasExistingPicks = rows('SELECT 1 FROM draft_picks WHERE draft_id=? LIMIT 1', draftId).length > 0;
  const suspiciousEmptyResponse = made.length === 0 && hasExistingPicks;
  const { added, corrected, removed, quarantined } = suspiciousEmptyResponse
    ? { added: [], corrected: [], removed: [], quarantined: [] }
    : reconcileDraftBoard(draftId, made, idMap, slotOf, new Date().toISOString());
  const failures = quarantined; // kept under the old field name for API back-compat

  run(`UPDATE drafts SET last_synced_at = datetime('now'),
       status = ? WHERE id = ?`, detail.drafted ? 'complete' : 'active', draftId);

  const total = draft.team_count * draft.rounds;
  const count = row('SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ?', draftId).n;
  // Next pick / on-the-clock must reflect ESPN's authoritative count, not our local
  // mirrored count — a quarantined pick otherwise makes every downstream "whose turn
  // is it" computation wrong for the rest of the draft (Phase 3B fix).
  const nextPick = made.length + 1;
  const desynced = count < made.length || quarantined.length > 0;

  return {
    ok: true,
    espn_in_progress: !!detail.inProgress,
    espn_complete: !!detail.drafted,
    picks_on_espn: made.length,
    picks_mirrored: count,
    new_picks: added,
    corrected_picks: corrected,
    removed_picks: removed,
    unresolved_count: openQuarantine(draftId).length,
    failures,
    desynced,
    next_pick: nextPick <= total ? nextPick : null,
    on_the_clock_slot: nextPick <= total ? slotForPick(nextPick, draft.team_count) : null,
    my_slot: draft.my_slot,
    my_turn: nextPick <= total && slotForPick(nextPick, draft.team_count) === draft.my_slot
  };
}

// One sync in flight per draft at a time. The client polls on a plain 4s interval with
// no overlap guard, and ESPN's API is often slower during a live draft than off it — an
// overlapping second sync racing the first through resolveEspnPlayers() is exactly how
// the same new player ends up inserted twice under different local ids, or a pick
// silently lost to the UNIQUE(draft_id, pick_number) race between two inserts.
const inFlight = new Map();
export function syncLiveDraft(draftId) {
  if (inFlight.has(draftId)) return inFlight.get(draftId);
  const p = syncLiveDraftImpl(draftId).finally(() => inFlight.delete(draftId));
  inFlight.set(draftId, p);
  return p;
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
