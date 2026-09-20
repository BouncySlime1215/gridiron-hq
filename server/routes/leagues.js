import { Router } from 'express';
import { db, rows, row, run } from '../db/index.js';
import { leagueTypeFromPayload } from '../services/format.js';
import { BROWSER_HEADERS } from '../services/espn-draft.js';
import { assertLeagueMember, assertCommissioner } from '../platform/auth.js';
import { requireCredentialsForLeague } from '../platform/espn-credentials.js';

const r = Router();

const ESPN_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';
const SLEEPER_BASE = 'https://api.sleeper.app/v1';

// Authentication (who is this caller) is applied by the mount site
// (server/index.js: app.use('/api/leagues', ...legacyAuthenticated, leaguesRouter)),
// same as news/players/tradelab/trades — so req.auth is always populated by the
// time a handler here runs in production. What was actually missing is
// per-league AUTHORIZATION: every :id route below accepted any authenticated
// caller for any league, letting one account read another's ESPN/Sleeper
// cookies via /:id/data, overwrite them via PUT, or purge someone else's league
// and drafts via DELETE. drafts.js and model.js already gate their league-scoped
// routes on assertLeagueMember/assertCommissioner; this file was the gap. Every
// existing league already has a commissioner membership row, so this doesn't
// lock anyone out of data they already had.

r.get('/', (req, res) => {
  res.json(rows(`SELECT l.id, l.platform, l.league_id, l.season, l.name, l.my_team_id, l.team_count, l.ppr,
                        l.superflex, l.league_type, l.fetched_at, l.connection_status, l.sync_error,
                        l.current_week, l.payload_season, l.espn_s2 IS NOT NULL AS has_cookies
                 FROM leagues l JOIN league_memberships m ON m.league_id = l.id
                 WHERE m.user_id = ? ORDER BY l.id`, req.auth.userId));
});

r.post('/', (req, res) => {
  const { platform, league_id, season = new Date().getFullYear(), espn_s2, swid, my_team_id } = req.body;
  if (!platform || !league_id) return res.status(400).json({ error: 'platform and league_id required' });
  run(`INSERT OR IGNORE INTO leagues (platform, league_id, season, espn_s2, swid, my_team_id)
       VALUES (?,?,?,?,?,?)`, platform, String(league_id), season, espn_s2 ?? null, swid ?? null,
    my_team_id != null ? String(my_team_id) : null);
  const created = row('SELECT id, platform, league_id, season FROM leagues WHERE platform = ? AND league_id = ? AND season = ?',
    platform, String(league_id), season);
  if (req.auth?.userId) {
    run(`INSERT INTO league_memberships (league_id,user_id,role) VALUES (?,?,'commissioner')
         ON CONFLICT(league_id,user_id) DO UPDATE SET role='commissioner'`, created.id, req.auth.userId);
  }
  res.json(created);
});

r.put('/:id', (req, res) => {
  assertCommissioner(req.auth.userId, req.params.id);
  const { my_team_id, espn_s2, swid } = req.body;
  run(`UPDATE leagues SET my_team_id = COALESCE(?, my_team_id),
       espn_s2 = COALESCE(?, espn_s2), swid = COALESCE(?, swid) WHERE id = ?`,
    my_team_id != null ? String(my_team_id) : null, espn_s2 ?? null, swid ?? null, req.params.id);
  res.json({ ok: true });
});

/**
 * What removing this league would actually destroy, so the UI can say so before
 * asking the user to confirm rather than after.
 */
function removalImpact(leagueId) {
  const drafts = rows('SELECT id, name, type FROM drafts WHERE league_row_id = ?', leagueId);
  const picks = drafts.length
    ? row(`SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id IN (${drafts.map(() => '?').join(',')})`,
      ...drafts.map(d => d.id)).n
    : 0;
  return { drafts: drafts.length, draft_picks: picks, draft_names: drafts.map(d => d.name) };
}

r.get('/:id/removal-impact', (req, res) => {
  assertLeagueMember(req.auth.userId, req.params.id);
  const lg = row('SELECT id, name FROM leagues WHERE id = ?', req.params.id);
  if (!lg) return res.status(404).json({ error: 'league not found' });
  res.json({ league: lg.name, ...removalImpact(req.params.id) });
});

/**
 * Remove a league.
 *
 * Defaults to *disconnecting*: credentials are cleared but the league row and its
 * draft history stay. A bare `DELETE FROM leagues` used to run here, which left
 * drafts pointing at a league row that no longer existed — silently, because the
 * declared foreign key isn't actually enforced on databases where
 * services/espn-draft.js's import-time `ALTER TABLE drafts ADD COLUMN
 * league_row_id INTEGER` (no REFERENCES) won the race against migration 006.
 * On this machine that would have orphaned 3 drafts and 330 picks with no error.
 *
 * `?purge=1` really deletes, but only after removing the dependent drafts in the
 * same transaction, so it can't leave the same orphans behind.
 */
r.delete('/:id', (req, res) => {
  assertCommissioner(req.auth.userId, req.params.id);
  const lg = row('SELECT id FROM leagues WHERE id = ?', req.params.id);
  if (!lg) return res.status(404).json({ error: 'league not found' });
  const impact = removalImpact(req.params.id);

  if (req.query.purge !== '1') {
    run(`UPDATE leagues SET espn_s2 = NULL, swid = NULL,
         connection_status='needs_reconnect', sync_error=NULL WHERE id = ?`, req.params.id);
    return res.json({ ok: true, disconnected: true, retained: impact });
  }

  db.exec('BEGIN');
  try {
    const drafts = rows('SELECT id FROM drafts WHERE league_row_id = ?', req.params.id);
    for (const d of drafts) {
      run('DELETE FROM draft_picks WHERE draft_id = ?', d.id);
      run('DELETE FROM drafts WHERE id = ?', d.id);
    }
    run('DELETE FROM leagues WHERE id = ?', req.params.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, purged: true, removed: impact });
});

const ESPN_SLOT_NAME = { 0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'DEF', 17: 'K', 23: 'FLEX' };

async function fetchEspn(lg, season) {
  // Whose cookies, asked once, in the one place that answers it. This used to
  // read `lg.espn_s2`/`lg.swid` off the row and, when they were empty, send no
  // cookie and carry on. That never borrowed anyone else's pair, so it was not
  // the leak that motivated espn-credentials.js — but it is the same silent
  // failure: an unauthenticated fetch of a private ESPN league answers 200 with
  // a thin public payload, and everything below writes that down as though the
  // league really had emptied out. Measured before this change, on a league
  // whose row was bare while its OWNER was connected: 200, three ESPN calls,
  // `Cookie: null`.
  //
  // The resolver reads the league's own pair first, so the common path is
  // unchanged; what is new is that a member's credentials are now reachable
  // from here, and that "nobody who can see this league is connected" throws
  // instead of guessing. Callers already handle it: the route answers 409 and
  // scheduler.js#refreshLeagueRosters records `sync_failed` with the message on
  // that league alone and keeps going.
  const { s2, swid } = requireCredentialsForLeague(lg.id);
  // No scoringPeriodId: ESPN then answers for the CURRENT period. Pinning it to 1
  // froze every roster at week 1 for the whole season — leagues looked connected
  // but never changed (found 2026-09-17).
  const url = `${ESPN_BASE}/seasons/${season}/segments/0/leagues/${lg.league_id}`
    + `?view=mTeam&view=mRoster&view=mMatchup&view=mSettings`;
  const headers = { ...BROWSER_HEADERS };
  headers.Cookie = `espn_s2=${s2}; SWID=${swid}`;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!resp.ok) throw new Error(`ESPN API ${resp.status}`);
  return resp.json();
}

const rosterCount = data => (data.teams ?? []).reduce((s, t) => s + (t.roster?.entries?.length ?? 0), 0);

export async function syncEspnLeague(lg) {
  let data = await fetchEspn(lg, lg.season);
  let usedSeason = lg.season, fellBack = false;
  // Read the matchup period from THIS season's response, before the pre-draft
  // fallback below can reassign `data`. It used to be read afterwards, so a
  // league that fell back wrote last season's final period — 17 or 18 — into
  // `leagues.current_week`, and `leagueCurrentWeek()` trusts that column above
  // everything else. The league then read as week 17 on every week-aware
  // surface while `leagues.season` still said the current year.
  const currentSeasonWeek = Number(data.status?.currentMatchupPeriod) || null;
  // Pre-draft leagues return empty rosters; fall back to last season so analysis
  // still has something real to work with.
  if (rosterCount(data) === 0) {
    try {
      const prev = await fetchEspn(lg, lg.season - 1);
      if (rosterCount(prev) > 0) { data = prev; usedSeason = lg.season - 1; fellBack = true; }
    } catch { /* keep the empty current-season payload */ }
  }
  const lineup = data.settings?.rosterSettings?.lineupSlotCounts ?? {};
  const rosterPositions = Object.entries(lineup)
    .flatMap(([slot, n]) => Array(n).fill(ESPN_SLOT_NAME[slot]).filter(Boolean));
  const currentWeek = currentSeasonWeek;
  // `season_used` and `fell_back` were returned and then thrown away by the
  // scheduled path (scheduler.js refreshLeagueRosters keeps only counts), so a
  // league running on last season's rosters looked freshly connected to every
  // reader except the one manual-sync message. Persist them.
  run(`UPDATE leagues SET name = ?, team_count = ?, payload = ?, roster_positions = ?,
       league_type = ?, current_week = ?, payload_season = ?, fetched_at = datetime('now') WHERE id = ?`,
    data.settings?.name ?? `ESPN ${lg.league_id}`, data.teams?.length ?? null,
    JSON.stringify(data), rosterPositions.length ? JSON.stringify(rosterPositions) : null,
    leagueTypeFromPayload('espn', data), currentWeek, usedSeason, lg.id);
  return { teams: data.teams?.length ?? 0, roster_players: rosterCount(data), season_used: usedSeason, fell_back: fellBack };
}

export async function syncSleeperLeague(lg) {
  const j = async p => {
    const resp = await fetch(`${SLEEPER_BASE}${p}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!resp.ok) throw new Error(`Sleeper API ${resp.status} on ${p}`);
    return resp.json();
  };
  // traded_picks + drafts drive draft-pick capital: the ledger says who holds which
  // future pick, and draft status says which seasons are already spent.
  const [league, rosters, users, tradedPicks, drafts] = await Promise.all([
    j(`/league/${lg.league_id}`), j(`/league/${lg.league_id}/rosters`), j(`/league/${lg.league_id}/users`),
    j(`/league/${lg.league_id}/traded_picks`).catch(() => []),
    j(`/league/${lg.league_id}/drafts`).catch(() => [])
  ]);
  const scoring = league.scoring_settings ?? {};
  const rp = league.roster_positions ?? [];
  const payload = { league, rosters, users, traded_picks: tradedPicks, drafts };
  run(`UPDATE leagues SET name = ?, team_count = ?, ppr = ?, superflex = ?, roster_positions = ?,
       league_type = ?, payload = ?, fetched_at = datetime('now') WHERE id = ?`,
    league.name, league.total_rosters ?? rosters.length,
    scoring.rec >= 1 ? 1 : scoring.rec >= 0.5 ? 0.5 : 0,
    rp.includes('SUPER_FLEX') ? 1 : 0,
    JSON.stringify(rp),
    leagueTypeFromPayload('sleeper', payload),
    JSON.stringify(payload), lg.id);
  return { teams: rosters.length, traded_picks: tradedPicks.length, drafts: drafts.length };
}

r.post('/:id/sync', async (req, res, next) => {
  try {
    // Self-heal a league that was connected through the ESPN-connect flow
    // before it granted membership on add (fixed in espn-connect.js) — a
    // league with literally zero members can only be the caller's own (a
    // stranger has no way to know it exists on this single-owner install),
    // so treat it as the same first-time grant POST / already gives a
    // league added through that path, rather than locking the owner out of
    // data that is unambiguously theirs.
    const hasAnyMember = row('SELECT 1 FROM league_memberships WHERE league_id = ?', req.params.id);
    if (!hasAnyMember && req.auth?.userId) {
      run(`INSERT INTO league_memberships (league_id,user_id,role) VALUES (?,?,'commissioner')
           ON CONFLICT(league_id,user_id) DO UPDATE SET role='commissioner'`, req.params.id, req.auth.userId);
    }
    assertLeagueMember(req.auth.userId, req.params.id);
    const lg = row('SELECT * FROM leagues WHERE id = ?', req.params.id);
    if (!lg) return res.status(404).json({ error: 'league not found' });
    const result = lg.platform === 'sleeper' ? await syncSleeperLeague(lg) : await syncEspnLeague(lg);
    run(`UPDATE leagues SET connection_status='connected', sync_error=NULL WHERE id=?`, lg.id);

    // Market values are priced per league format, so they can only be fetched once a
    // league exists to derive that format from. Without this a freshly connected
    // league shows every player at value 0 until the user happens to hit "Refresh
    // data" — which is not a step anyone would guess at.
    const { syncDynastyValues } = await import('./aggregates.js');
    const values = await syncDynastyValues().catch(e => ({ error: e.message }));

    // The season simulator (title odds on My Team) is cached in-process with no TTL,
    // keyed only on league id/runs/week — without this, a roster change (trade,
    // waiver claim, injury) never shows up in "Your title odds right now" until the
    // whole server restarts, silently disconnecting that card from the roster it's
    // supposed to describe.
    const { clearModelCache } = await import('./model.js');
    clearModelCache();

    res.json({ ok: true, ...result, values });
  } catch (e) {
    // An auth rejection isn't a sync failure — don't overwrite the league's real
    // sync_error with "forbidden" just because an unauthorized caller tried.
    if (e.status !== 401 && e.status !== 403) {
      run(`UPDATE leagues SET connection_status='sync_failed', sync_error=? WHERE id=?`,
        String(e.message ?? e).slice(0, 500), req.params.id);
    }
    next(e);
  }
});

r.get('/:id/data', (req, res) => {
  assertLeagueMember(req.auth.userId, req.params.id);
  const lg = row('SELECT * FROM leagues WHERE id = ?', req.params.id);
  if (!lg) return res.status(404).json({ error: 'league not found' });
  // Never echo the ESPN session cookies back to the client: this endpoint answers
  // any league member, but the cookies are commissioner-supplied credentials that
  // let a caller impersonate the league owner against ESPN directly.
  delete lg.espn_s2;
  delete lg.swid;
  res.json({ ...lg, payload: lg.payload ? JSON.parse(lg.payload) : null });
});

// ---- Roster needs/surplus analysis (ported from akodsi/fantasy-advisor) ----
const SKILL = ['QB', 'RB', 'WR', 'TE'];
const FLEX_SPLIT = { RB: 0.4, WR: 0.5, TE: 0.1 };
const WEAK = 0.80, STRONG = 1.15;

function fcValues() {
  const m = new Map();
  for (const x of rows(`SELECT player_id, value FROM player_metrics WHERE source = 'fc_value'`)) m.set(x.player_id, x.value);
  return m;
}
function playersByName() {
  const norm = s => s.toLowerCase().replace(/[.'’]/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();
  const m = new Map();
  for (const p of rows('SELECT id, name, position, sleeper_id, espn_id FROM players')) {
    m.set(`${norm(p.name)}|${p.position}`, p);
    if (p.sleeper_id) m.set(`sleeper:${p.sleeper_id}`, p);
    if (p.espn_id) m.set(`espn:${p.espn_id}`, p);
  }
  return { map: m, norm };
}

function extractRosters(lg) {
  const payload = JSON.parse(lg.payload);
  const { map, norm } = playersByName();
  const values = fcValues();
  const out = [];
  // Both branches below end in `.filter(Boolean)`, which drops every rostered
  // player that the local `players` table does not know. When `players` holds
  // only the bootstrap seed — no espn_id on any row — the `espn:` key never
  // hits and only the name|position fallback can match, so a real 16-player
  // roster silently becomes a handful. Count what was offered so a caller can
  // tell a thin roster from a thin join.
  let offered = 0;
  if (lg.platform === 'sleeper') {
    const userById = Object.fromEntries((payload.users ?? []).map(u => [u.user_id, u]));
    for (const ro of payload.rosters ?? []) {
      offered += (ro.players ?? []).length;
      const players = (ro.players ?? []).map(sid => map.get(`sleeper:${sid}`)).filter(Boolean)
        .map(p => ({ ...p, value: values.get(p.id) ?? 0 }));
      out.push({
        roster_id: ro.roster_id,
        owner: userById[ro.owner_id]?.display_name ?? `Team ${ro.roster_id}`,
        players
      });
    }
  } else {
    for (const t of payload.teams ?? []) {
      offered += (t.roster?.entries ?? []).length;
      const players = (t.roster?.entries ?? [])
        .map(e => {
          const pl = e.playerPoolEntry?.player;
          if (!pl) return null;
          // 16 is ESPN's D/ST. Leaving it out keyed every team defence as
          // "lions dst|" with an empty position, which matched nothing and then
          // got dropped by the filter below — so defences vanished from this
          // analysis while trade-engine.js:522, which has the same map with 16
          // in it, still counted them. The two readers disagreed about whether
          // your defence was on your team.
          const POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF' };
          return map.get(`espn:${pl.id}`) ?? map.get(`${norm(pl.fullName ?? '')}|${POS[pl.defaultPositionId] ?? ''}`);
        })
        .filter(Boolean)
        .map(p => ({ ...p, value: values.get(p.id) ?? 0 }));
      const label = t.name || `${t.location ?? ''} ${t.nickname ?? ''}`.trim() || `Team ${t.id}`;
      out.push({ roster_id: t.id, owner: label, players });
    }
  }
  const matched = out.reduce((n, ro) => n + ro.players.length, 0);
  const priced = out.reduce((n, ro) => n + ro.players.filter(p => p.value > 0).length, 0);
  return { rosters: out, offered, matched, priced };
}

r.get('/:id/analysis', (req, res) => {
  assertLeagueMember(req.auth.userId, req.params.id);
  const lg = row('SELECT * FROM leagues WHERE id = ?', req.params.id);
  if (!lg?.payload) return res.status(400).json({ error: 'league not synced yet' });

  const rp = lg.roster_positions ? JSON.parse(lg.roster_positions) : ['QB','RB','RB','WR','WR','TE','FLEX'];
  const perTeam = Object.fromEntries(SKILL.map(p => [p, rp.filter(x => x === p).length]));
  const flex = rp.filter(x => ['FLEX','REC_FLEX','WRRB_FLEX'].includes(x)).length;
  perTeam.QB += rp.filter(x => x === 'SUPER_FLEX').length;
  for (const [pos, share] of Object.entries(FLEX_SPLIT)) perTeam[pos] += flex * share;

  const { rosters, offered, matched, priced } = extractRosters(lg);
  const league = {
    id: lg.id, name: lg.name, platform: lg.platform, my_team_id: lg.my_team_id,
    // Freshness travels with the verdict. Without it a league last synced nine
    // hours ago, or one running on last season's payload, produced an analysis
    // that looked exactly like a fresh one.
    synced_at: lg.fetched_at ?? null,
    connection_status: lg.connection_status ?? null,
    season: lg.season,
    payload_season: lg.payload_season ?? null
  };
  const coverage = { rostered_in_payload: offered, matched_to_player_table: matched, priced };
  if (matched === 0) {
    return res.json({
      league,
      empty: true,
      // An undrafted league and a league whose players simply did not join
      // against the local table look identical from here, so say which.
      message: offered > 0
        ? `This league has ${offered} rostered players, but none of them matched the local player table, so there is nothing to price. The player universe needs to sync before this can mean anything.`
        : 'No rostered players found \u2014 this league likely hasn\u2019t drafted yet for this season. Analysis will populate after your draft.',
      coverage,
      averages: {}, rosters: []
    });
  }
  // Every value below comes from `player_metrics` rows with source 'fc_value'.
  // With none of them present every `p.value` is 0, so `starter_value` is 0 for
  // every team, `averages[pos]` is 0, and `ratio` is 0 / (0 || 1) = 0 — which
  // is under WEAK, so the page used to mark QB, RB, WR and TE as a NEED for
  // every team in the league, captioned 'priced off real FantasyCalc trade
  // values'. A verdict computed from no values is worse than no verdict.
  if (priced === 0) {
    return res.json({
      league,
      values_missing: true,
      message: `No FantasyCalc trade values are loaded for any of the ${matched} rostered players this league matched, so roster strength cannot be priced. Sync the player values and this fills in.`,
      coverage,
      averages: {}, rosters: []
    });
  }
  for (const ro of rosters) {
    const byPos = Object.fromEntries(SKILL.map(p => [p, []]));
    for (const p of ro.players) if (byPos[p.position]) byPos[p.position].push(p);
    for (const pos of SKILL) byPos[pos].sort((a, b) => b.value - a.value);
    ro.positions = {};
    for (const pos of SKILL) {
      const slots = Math.ceil(perTeam[pos] - 0.001);
      ro.positions[pos] = {
        starters: byPos[pos].slice(0, slots).map(p => ({ id: p.id, name: p.name, value: p.value })),
        starter_value: byPos[pos].slice(0, slots).reduce((s, p) => s + p.value, 0),
        depth: byPos[pos].length
      };
    }
  }
  const averages = Object.fromEntries(SKILL.map(pos =>
    [pos, rosters.reduce((s, ro) => s + ro.positions[pos].starter_value, 0) / (rosters.length || 1)]));
  for (const ro of rosters) {
    ro.needs = []; ro.surplus = [];
    for (const pos of SKILL) {
      // `starter_value / (averages[pos] || 1)` turned a league-wide 0 into a
      // ratio of 0, i.e. a confident NEED, for a position nobody has a price
      // for. There is no verdict to give there.
      if (!averages[pos]) {
        ro.positions[pos].ratio = null;
        ro.positions[pos].status = 'unknown';
        continue;
      }
      const ratio = ro.positions[pos].starter_value / averages[pos];
      ro.positions[pos].ratio = ratio;
      ro.positions[pos].status = ratio < WEAK ? 'need' : ratio > STRONG ? 'surplus' : 'ok';
      if (ratio < WEAK) ro.needs.push(pos);
      if (ratio > STRONG) ro.surplus.push(pos);
    }
  }
  res.json({ league, averages, coverage, rosters });
});

export default r;
