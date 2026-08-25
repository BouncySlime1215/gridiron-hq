import { Router } from 'express';
import { rows, row, run } from '../db/index.js';
import { leagueTypeFromPayload } from '../services/format.js';
import { EspnAuthenticationError, fetchEspnLeague } from '../services/espn-client.js';

const r = Router();

const SLEEPER_BASE = 'https://api.sleeper.app/v1';

r.get('/', (req, res) => {
  res.json(rows(`SELECT id, platform, league_id, season, name, my_team_id, team_count, ppr, superflex,
                        league_type, fetched_at,
                        espn_s2 IS NOT NULL AS has_cookies
                 FROM leagues ORDER BY id`));
});

r.post('/', (req, res) => {
  const { platform, league_id, season = new Date().getFullYear(), my_team_id } = req.body;
  if (!platform || !league_id) return res.status(400).json({ error: 'platform and league_id required' });
  run(`INSERT OR IGNORE INTO leagues (platform, league_id, season, my_team_id)
       VALUES (?,?,?,?)`, platform, String(league_id), season,
    my_team_id != null ? String(my_team_id) : null);
  res.json(row('SELECT id, platform, league_id, season FROM leagues WHERE platform = ? AND league_id = ? AND season = ?',
    platform, String(league_id), season));
});

r.put('/:id', (req, res) => {
  const { my_team_id } = req.body;
  run(`UPDATE leagues SET my_team_id = COALESCE(?, my_team_id) WHERE id = ?`,
    my_team_id != null ? String(my_team_id) : null, req.params.id);
  res.json({ ok: true });
});

r.delete('/:id', (req, res) => {
  run('DELETE FROM leagues WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

const ESPN_SLOT_NAME = { 0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'DEF', 17: 'K', 23: 'FLEX' };

async function fetchEspn(lg, season) {
  if (!lg.espn_s2 || !lg.swid) throw Object.assign(new Error('ESPN connection required'), { status: 400 });
  return fetchEspnLeague({
    leagueId: lg.league_id,
    season,
    espn_s2: lg.espn_s2,
    swid: lg.swid
  });
}

const rosterCount = data => (data.teams ?? []).reduce((s, t) => s + (t.roster?.entries?.length ?? 0), 0);

async function syncEspnLeague(lg) {
  let data = await fetchEspn(lg, lg.season);
  let usedSeason = lg.season, fellBack = false;
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
  run(`UPDATE leagues SET name = ?, team_count = ?, payload = ?, roster_positions = ?,
       league_type = ?, fetched_at = datetime('now'), espn_last_sync_at=datetime('now'),
       espn_connection_state='connected' WHERE id = ?`,
    data.settings?.name ?? `ESPN ${lg.league_id}`, data.teams?.length ?? null,
    JSON.stringify(data), rosterPositions.length ? JSON.stringify(rosterPositions) : null,
    leagueTypeFromPayload('espn', data), lg.id);
  return { teams: data.teams?.length ?? 0, roster_players: rosterCount(data), season_used: usedSeason, fell_back: fellBack };
}

async function syncSleeperLeague(lg) {
  const j = async p => {
    const resp = await fetch(`${SLEEPER_BASE}${p}`, { headers: { Accept: 'application/json' } });
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
  let lg;
  try {
    lg = row('SELECT * FROM leagues WHERE id = ?', req.params.id);
    if (!lg) return res.status(404).json({ error: 'league not found' });
    const result = lg.platform === 'sleeper' ? await syncSleeperLeague(lg) : await syncEspnLeague(lg);

    // Market values are priced per league format, so they can only be fetched once a
    // league exists to derive that format from. Without this a freshly connected
    // league shows every player at value 0 until the user happens to hit "Refresh
    // data" — which is not a step anyone would guess at.
    const { syncDynastyValues } = await import('./aggregates.js');
    const values = await syncDynastyValues().catch(e => ({ error: e.message }));

    res.json({ ok: true, ...result, values });
  } catch (e) {
    if (lg?.platform === 'espn' && e instanceof EspnAuthenticationError) {
      run(`UPDATE leagues SET espn_connection_state='reconnect_required' WHERE id=?`, lg.id);
    }
    next(e);
  }
});

r.get('/:id/data', (req, res) => {
  const lg = row('SELECT * FROM leagues WHERE id = ?', req.params.id);
  if (!lg) return res.status(404).json({ error: 'league not found' });
  const { espn_s2: _espnS2, swid: _swid, ...safeLeague } = lg;
  res.json({ ...safeLeague, payload: lg.payload ? JSON.parse(lg.payload) : null });
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
  if (lg.platform === 'sleeper') {
    const userById = Object.fromEntries((payload.users ?? []).map(u => [u.user_id, u]));
    for (const ro of payload.rosters ?? []) {
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
      const players = (t.roster?.entries ?? [])
        .map(e => {
          const pl = e.playerPoolEntry?.player;
          if (!pl) return null;
          return map.get(`espn:${pl.id}`) ?? map.get(`${norm(pl.fullName ?? '')}|${({1:'QB',2:'RB',3:'WR',4:'TE',5:'K'})[pl.defaultPositionId] ?? ''}`);
        })
        .filter(Boolean)
        .map(p => ({ ...p, value: values.get(p.id) ?? 0 }));
      const label = t.name || `${t.location ?? ''} ${t.nickname ?? ''}`.trim() || `Team ${t.id}`;
      out.push({ roster_id: t.id, owner: label, players });
    }
  }
  return out;
}

r.get('/:id/analysis', (req, res) => {
  const lg = row('SELECT * FROM leagues WHERE id = ?', req.params.id);
  if (!lg?.payload) return res.status(400).json({ error: 'league not synced yet' });

  const rp = lg.roster_positions ? JSON.parse(lg.roster_positions) : ['QB','RB','RB','WR','WR','TE','FLEX'];
  const perTeam = Object.fromEntries(SKILL.map(p => [p, rp.filter(x => x === p).length]));
  const flex = rp.filter(x => ['FLEX','REC_FLEX','WRRB_FLEX'].includes(x)).length;
  perTeam.QB += rp.filter(x => x === 'SUPER_FLEX').length;
  for (const [pos, share] of Object.entries(FLEX_SPLIT)) perTeam[pos] += flex * share;

  const rosters = extractRosters(lg);
  const matched = rosters.reduce((s, ro) => s + ro.players.length, 0);
  if (matched === 0) {
    return res.json({
      league: { id: lg.id, name: lg.name, platform: lg.platform, my_team_id: lg.my_team_id },
      empty: true,
      message: 'No rostered players found — this league likely hasn’t drafted yet for this season. Analysis will populate after your draft.',
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
      const ratio = ro.positions[pos].starter_value / (averages[pos] || 1);
      ro.positions[pos].ratio = ratio;
      ro.positions[pos].status = ratio < WEAK ? 'need' : ratio > STRONG ? 'surplus' : 'ok';
      if (ratio < WEAK) ro.needs.push(pos);
      if (ratio > STRONG) ro.surplus.push(pos);
    }
  }
  res.json({ league: { id: lg.id, name: lg.name, platform: lg.platform, my_team_id: lg.my_team_id }, averages, rosters });
});

export default r;
