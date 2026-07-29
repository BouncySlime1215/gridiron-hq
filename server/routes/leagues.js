import { Router } from 'express';
import { rows, row, run } from '../db/index.js';

const r = Router();

const ESPN_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';
const SLEEPER_BASE = 'https://api.sleeper.app/v1';

r.get('/', (req, res) => {
  res.json(rows(`SELECT id, platform, league_id, season, name, my_team_id, team_count, ppr, superflex, fetched_at,
                        espn_s2 IS NOT NULL AS has_cookies
                 FROM leagues ORDER BY id`));
});

r.post('/', (req, res) => {
  const { platform, league_id, season = new Date().getFullYear(), espn_s2, swid, my_team_id } = req.body;
  if (!platform || !league_id) return res.status(400).json({ error: 'platform and league_id required' });
  run(`INSERT OR IGNORE INTO leagues (platform, league_id, season, espn_s2, swid, my_team_id)
       VALUES (?,?,?,?,?,?)`, platform, String(league_id), season, espn_s2 ?? null, swid ?? null,
    my_team_id != null ? String(my_team_id) : null);
  res.json(row('SELECT id, platform, league_id, season FROM leagues WHERE platform = ? AND league_id = ? AND season = ?',
    platform, String(league_id), season));
});

r.put('/:id', (req, res) => {
  const { my_team_id, espn_s2, swid } = req.body;
  run(`UPDATE leagues SET my_team_id = COALESCE(?, my_team_id),
       espn_s2 = COALESCE(?, espn_s2), swid = COALESCE(?, swid) WHERE id = ?`,
    my_team_id != null ? String(my_team_id) : null, espn_s2 ?? null, swid ?? null, req.params.id);
  res.json({ ok: true });
});

r.delete('/:id', (req, res) => {
  run('DELETE FROM leagues WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

const ESPN_SLOT_NAME = { 0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'DEF', 17: 'K', 23: 'FLEX' };

async function fetchEspn(lg, season) {
  const url = `${ESPN_BASE}/seasons/${season}/segments/0/leagues/${lg.league_id}`
    + `?scoringPeriodId=1&view=mTeam&view=mRoster&view=mMatchup&view=mSettings`;
  const headers = { Accept: 'application/json' };
  if (lg.espn_s2 && lg.swid) headers.Cookie = `espn_s2=${lg.espn_s2}; SWID=${lg.swid}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`ESPN API ${resp.status}`);
  return resp.json();
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
  run(`UPDATE leagues SET name = ?, team_count = ?, payload = ?, roster_positions = ?, fetched_at = datetime('now') WHERE id = ?`,
    data.settings?.name ?? `ESPN ${lg.league_id}`, data.teams?.length ?? null,
    JSON.stringify(data), rosterPositions.length ? JSON.stringify(rosterPositions) : null, lg.id);
  return { teams: data.teams?.length ?? 0, roster_players: rosterCount(data), season_used: usedSeason, fell_back: fellBack };
}

async function syncSleeperLeague(lg) {
  const j = async p => {
    const resp = await fetch(`${SLEEPER_BASE}${p}`, { headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`Sleeper API ${resp.status} on ${p}`);
    return resp.json();
  };
  const [league, rosters, users] = await Promise.all([
    j(`/league/${lg.league_id}`), j(`/league/${lg.league_id}/rosters`), j(`/league/${lg.league_id}/users`)
  ]);
  const scoring = league.scoring_settings ?? {};
  const rp = league.roster_positions ?? [];
  run(`UPDATE leagues SET name = ?, team_count = ?, ppr = ?, superflex = ?, roster_positions = ?,
       payload = ?, fetched_at = datetime('now') WHERE id = ?`,
    league.name, league.total_rosters ?? rosters.length,
    scoring.rec >= 1 ? 1 : scoring.rec >= 0.5 ? 0.5 : 0,
    rp.includes('SUPER_FLEX') ? 1 : 0,
    JSON.stringify(rp), JSON.stringify({ league, rosters, users }), lg.id);
  return { teams: rosters.length };
}

r.post('/:id/sync', async (req, res, next) => {
  try {
    const lg = row('SELECT * FROM leagues WHERE id = ?', req.params.id);
    if (!lg) return res.status(404).json({ error: 'league not found' });
    const result = lg.platform === 'sleeper' ? await syncSleeperLeague(lg) : await syncEspnLeague(lg);
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

r.get('/:id/data', (req, res) => {
  const lg = row('SELECT * FROM leagues WHERE id = ?', req.params.id);
  if (!lg) return res.status(404).json({ error: 'league not found' });
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
