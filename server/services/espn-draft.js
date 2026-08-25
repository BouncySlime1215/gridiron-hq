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

async function resolveEspnPlayers(espnIds, season) {
  const known = new Map(rows(
    `SELECT id, espn_id FROM players WHERE espn_id IS NOT NULL`).map(p => [p.espn_id, p.id]));
  const missing = espnIds.filter(id => !known.has(id));
  if (!missing.length) return known;

  let pool;
  try { pool = await espnPlayerPool(season); } catch { pool = new Map(); }
  const teamIdByAbbr = new Map(rows(`SELECT id, abbr FROM nfl_teams`).map(t => [t.abbr, t.id]));
  for (const espnId of missing) {
    const info = pool.get(espnId);
    const name = info?.name ?? `ESPN player ${espnId}`;
    run(`INSERT INTO players (name, position, team_id, espn_id, fantasy_relevant)
         VALUES (?,?,?,?,1)`,
      name, info?.position ?? 'WR', teamIdByAbbr.get(info?.proTeam) ?? null, espnId);
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
  const mySlot = Math.max(1, pickOrder.indexOf(Number(lg.my_team_id)) + 1);

  const existing = row(`SELECT * FROM drafts WHERE type='live' AND league_row_id = ? AND season = ?`,
    lg.id, lg.season);
  const name = `${lg.name ?? `ESPN ${lg.league_id}`} — ${lg.season} draft`;
  const teamNames = JSON.stringify(Object.fromEntries((data.teams ?? []).map(t =>
    [t.id, t.name || `${t.location ?? ''} ${t.nickname ?? ''}`.trim() || `Team ${t.id}`])));

  if (existing) {
    run(`UPDATE drafts SET name=?, team_count=?, rounds=?, my_slot=?, pick_seconds=?,
         pick_order=?, roster_slots=?, espn_league_id=?, draft_at=? WHERE id=?`,
      name, teamCount, rounds, mySlot, ds.timePerSelection ?? 90,
      JSON.stringify({ order: pickOrder, team_names: JSON.parse(teamNames) }),
      JSON.stringify(startingSlots(lineup)), String(lg.league_id),
      ds.date ? new Date(ds.date).toISOString() : null, existing.id);
    return { draft_id: existing.id, created: false };
  }

  run(`INSERT INTO drafts (name, type, team_count, rounds, my_slot, pick_seconds,
        league_row_id, espn_league_id, season, pick_order, roster_slots, draft_at)
       VALUES (?, 'live', ?,?,?,?,?,?,?,?,?,?)`,
    name, teamCount, rounds, mySlot, ds.timePerSelection ?? 90,
    lg.id, String(lg.league_id), lg.season,
    JSON.stringify({ order: pickOrder, team_names: JSON.parse(teamNames) }),
    JSON.stringify(startingSlots(lineup)),
    ds.date ? new Date(ds.date).toISOString() : null);
  return { draft_id: row('SELECT last_insert_rowid() AS id').id, created: true };
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

  const have = new Set(rows('SELECT pick_number FROM draft_picks WHERE draft_id = ?', draftId)
    .map(p => p.pick_number));
  const fresh = made.filter(p => !have.has(p.overallPickNumber));

  let added = [];
  const failures = [];
  if (fresh.length) {
    const idMap = await resolveEspnPlayers([...new Set(fresh.map(p => p.playerId))], draft.season);
    for (const p of fresh) {
      const playerId = idMap.get(p.playerId);
      if (!playerId) { failures.push({ pick: p.overallPickNumber, reason: 'player could not be resolved' }); continue; }
      // pickOrder is re-derived fresh from this same ESPN response every call, so a
      // missing slot means the team genuinely isn't in the current draft order (a real
      // ESPN data inconsistency) rather than stale cached data. Skip rather than write
      // a made-up team_slot — team_slot drives "is this my pick" everywhere downstream,
      // and a wrong number there is worse than retrying this pick on the next poll.
      const slot = slotOf.get(p.teamId);
      if (slot == null) { failures.push({ pick: p.overallPickNumber, reason: `team ${p.teamId} not in pick order` }); continue; }
      try {
        run(`INSERT INTO draft_picks (draft_id, pick_number, team_slot, player_id, espn_team_id, keeper)
             VALUES (?,?,?,?,?,?)`,
          draftId, p.overallPickNumber, slot, playerId, p.teamId, p.keeper ? 1 : 0);
        added.push(p.overallPickNumber);
      } catch (e) {
        // UNIQUE(draft_id, player_id) is the one expected failure here: the same player
        // already mirrored under another pick number, which happens if ESPN renumbers
        // after a trade. Anything else is a real bug and must not vanish silently —
        // it's exactly the kind of thing that quietly desyncs the board for the rest
        // of the draft with no visible error.
        if (!String(e.message).includes('UNIQUE') || !String(e.message).includes('player_id')) {
          console.error(`[live-draft] failed to mirror pick ${p.overallPickNumber} for draft ${draftId}:`, e.message);
          failures.push({ pick: p.overallPickNumber, reason: e.message });
        }
      }
    }
  }

  run(`UPDATE drafts SET last_synced_at = datetime('now'),
       status = ? WHERE id = ?`, detail.drafted ? 'complete' : 'active', draftId);

  const total = draft.team_count * draft.rounds;
  const count = row('SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ?', draftId).n;
  const nextPick = count + 1;
  // Reconcile against ESPN's own count rather than trust that "we added N rows" means
  // "we have everything ESPN has" — a pick that failed for a reason not caught above
  // (or on a prior sync, before this fix existed) would otherwise desync silently for
  // the rest of the draft with every downstream "on the clock" computation just wrong.
  const desynced = count < made.length;

  return {
    ok: true,
    espn_in_progress: !!detail.inProgress,
    espn_complete: !!detail.drafted,
    picks_on_espn: made.length,
    picks_mirrored: count,
    new_picks: added,
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
