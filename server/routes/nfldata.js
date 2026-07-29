import { Router } from 'express';
import { db, rows, row, run } from '../db/index.js';

const r = Router();
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
export const SEASON = Number(process.env.NFL_SEASON) || 2026;

db.exec(`
  CREATE TABLE IF NOT EXISTS roster_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL REFERENCES nfl_teams(id),
    espn_id INTEGER,
    name TEXT NOT NULL,
    position TEXT,
    unit TEXT,                -- offense | defense | specialTeam | ir | practiceSquad
    jersey TEXT,
    age INTEGER,
    experience INTEGER,
    height TEXT,
    weight INTEGER,
    status TEXT,
    fetched_at TEXT,
    depth_slot TEXT,
    depth_order INTEGER,
    UNIQUE(team_id, espn_id)
  );

  CREATE TABLE IF NOT EXISTS schedule_games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL,
    team_id INTEGER NOT NULL REFERENCES nfl_teams(id),
    week INTEGER,
    date TEXT,
    opponent_abbr TEXT,
    home INTEGER,
    UNIQUE(season, team_id, week)
  );

  CREATE TABLE IF NOT EXISTS team_cap (
    team_id INTEGER PRIMARY KEY REFERENCES nfl_teams(id),
    cap_space REAL,
    effective_cap_space REAL,
    active_spending REAL,
    dead_money REAL,
    roster_count INTEGER,
    source TEXT,
    fetched_at TEXT
  );
`);

// migrations for tables created before these columns existed
const rpCols = db.prepare(`PRAGMA table_info(roster_players)`).all().map(c => c.name);
if (!rpCols.includes('depth_slot')) db.exec(`ALTER TABLE roster_players ADD COLUMN depth_slot TEXT`);
if (!rpCols.includes('depth_order')) db.exec(`ALTER TABLE roster_players ADD COLUMN depth_order INTEGER`);

// ESPN team id -> our abbr
const PRO_TEAM = {
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
  9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN',
  17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC',
  25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU'
};
const ABBR_TO_ESPN = Object.fromEntries(Object.entries(PRO_TEAM).map(([id, ab]) => [ab, id]));

// OverTheCap uses nicknames; map to our abbrs.
const NICK_TO_ABBR = {
  'Cardinals': 'ARI', 'Falcons': 'ATL', 'Ravens': 'BAL', 'Bills': 'BUF', 'Panthers': 'CAR',
  'Bears': 'CHI', 'Bengals': 'CIN', 'Browns': 'CLE', 'Cowboys': 'DAL', 'Broncos': 'DEN',
  'Lions': 'DET', 'Packers': 'GB', 'Texans': 'HOU', 'Colts': 'IND', 'Jaguars': 'JAX',
  'Chiefs': 'KC', 'Raiders': 'LV', 'Chargers': 'LAC', 'Rams': 'LAR', 'Dolphins': 'MIA',
  'Vikings': 'MIN', 'Patriots': 'NE', 'Saints': 'NO', 'Giants': 'NYG', 'Jets': 'NYJ',
  'Eagles': 'PHI', 'Steelers': 'PIT', '49ers': 'SF', 'Seahawks': 'SEA', 'Buccaneers': 'TB',
  'Titans': 'TEN', 'Commanders': 'WAS', 'Football Team': 'WAS', 'Redskins': 'WAS'
};

const teamIdByAbbr = () => Object.fromEntries(rows('SELECT id, abbr FROM nfl_teams').map(t => [t.abbr, t.id]));

// ---- Full 90-man rosters (real OL / DL / LB / DB, not just fantasy skill players) ----
export async function syncRosters() {
  const ids = teamIdByAbbr();
  const ins = db.prepare(`INSERT INTO roster_players
    (team_id, espn_id, name, position, unit, jersey, age, experience, height, weight, status, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(team_id, espn_id) DO UPDATE SET
      name=excluded.name, position=excluded.position, unit=excluded.unit, jersey=excluded.jersey,
      age=excluded.age, experience=excluded.experience, height=excluded.height, weight=excluded.weight,
      status=excluded.status, fetched_at=excluded.fetched_at`);

  let total = 0, teams = 0;
  const abbrs = Object.keys(ABBR_TO_ESPN);
  for (let i = 0; i < abbrs.length; i += 8) {
    const batch = abbrs.slice(i, i + 8);
    const results = await Promise.allSettled(batch.map(async abbr => {
      const resp = await fetch(`${SITE}/teams/${ABBR_TO_ESPN[abbr]}/roster`, { headers: { Accept: 'application/json' } });
      if (!resp.ok) throw new Error(`roster ${abbr} ${resp.status}`);
      return { abbr, data: await resp.json() };
    }));
    for (const res of results) {
      if (res.status !== 'fulfilled') continue;
      const { abbr, data } = res.value;
      const teamId = ids[abbr];
      if (!teamId) continue;
      // wipe stale entries for this team, then re-insert (handles cuts/releases)
      run('DELETE FROM roster_players WHERE team_id = ?', teamId);
      for (const grp of data.athletes ?? []) {
        for (const p of grp.items ?? []) {
          ins.run(teamId, p.id ? Number(p.id) : null, p.displayName ?? p.fullName,
            p.position?.abbreviation ?? null, grp.position ?? null, p.jersey ?? null,
            p.age ?? null, p.experience?.years ?? null, p.displayHeight ?? null,
            p.weight ?? null, p.status?.type ?? null);
          total++;
        }
      }
      teams++;
    }
  }
  return { teams, players: total };
}

// ---- Schedules + strength of schedule ----
export async function syncSchedules(season = SEASON) {
  const ids = teamIdByAbbr();
  const ins = db.prepare(`INSERT INTO schedule_games (season, team_id, week, date, opponent_abbr, home)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(season, team_id, week) DO UPDATE SET
      date=excluded.date, opponent_abbr=excluded.opponent_abbr, home=excluded.home`);
  let games = 0, teams = 0;
  const abbrs = Object.keys(ABBR_TO_ESPN);
  for (let i = 0; i < abbrs.length; i += 8) {
    const batch = abbrs.slice(i, i + 8);
    const results = await Promise.allSettled(batch.map(async abbr => {
      const resp = await fetch(`${SITE}/teams/${ABBR_TO_ESPN[abbr]}/schedule?season=${season}`, { headers: { Accept: 'application/json' } });
      if (!resp.ok) throw new Error(`schedule ${abbr} ${resp.status}`);
      return { abbr, data: await resp.json() };
    }));
    for (const res of results) {
      if (res.status !== 'fulfilled') continue;
      const { abbr, data } = res.value;
      const teamId = ids[abbr];
      if (!teamId) continue;
      for (const e of data.events ?? []) {
        const comp = e.competitions?.[0];
        if (!comp) continue;
        const me = comp.competitors?.find(c => c.team?.abbreviation === abbr);
        const opp = comp.competitors?.find(c => c.team?.abbreviation !== abbr);
        if (!opp) continue;
        ins.run(season, teamId, e.week?.number ?? null, (e.date ?? '').slice(0, 10),
          opp.team?.abbreviation ?? null, me?.homeAway === 'home' ? 1 : 0);
        games++;
      }
      teams++;
    }
  }
  return { teams, games };
}

// ---- Salary cap (OverTheCap, public HTML) ----
export async function syncCap() {
  const resp = await fetch('https://overthecap.com/salary-cap-space', {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' }
  });
  if (!resp.ok) throw new Error(`OverTheCap ${resp.status}`);
  const html = await resp.text();
  const ids = teamIdByAbbr();
  const money = s => {
    const neg = s.includes('(');
    const n = Number(s.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? (neg ? -n : n) : null;
  };
  const strip = c => c.replace(/<[^>]+>/g, '').trim();
  const trs = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  const seen = new Set();
  let updated = 0;
  for (const tr of trs) {
    const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []).map(strip);
    if (cells.length < 4 || !cells[1]?.includes('$')) continue;
    const abbr = NICK_TO_ABBR[cells[0]];
    if (!abbr || seen.has(abbr)) continue;   // first table on the page = current league year
    seen.add(abbr);
    const teamId = ids[abbr];
    if (!teamId) continue;
    run(`INSERT INTO team_cap (team_id, cap_space, effective_cap_space, active_spending, dead_money, roster_count, source, fetched_at)
         VALUES (?,?,?,?,?,?,'OverTheCap',datetime('now'))
         ON CONFLICT(team_id) DO UPDATE SET cap_space=excluded.cap_space, effective_cap_space=excluded.effective_cap_space,
           active_spending=excluded.active_spending, dead_money=excluded.dead_money,
           roster_count=excluded.roster_count, fetched_at=excluded.fetched_at`,
      teamId, money(cells[1]), money(cells[2]), money(cells[4] ?? ''), money(cells[5] ?? ''),
      Number(cells[3]) || null);
    updated++;
  }
  if (updated < 30) throw new Error(`OverTheCap parse only matched ${updated}/32 teams — layout may have changed; not trusting it`);
  return { teams: updated };
}

/**
 * Real depth charts from ESPN's core API — every slot is named (lt/lg/c/rg/rt,
 * lde/ldt/rdt/rde, wlb/mlb/slb, lcb/rcb/nb/ss/fs) with a starter rank. This is
 * what fills in the O-line and separates edge rushers from off-ball linebackers;
 * the team roster endpoint only exposes a generic "LB"/"G"/"OT".
 */
export async function syncDepthChart(season = SEASON) {
  const ids = teamIdByAbbr();
  const abbrs = Object.keys(ABBR_TO_ESPN);
  let matched = 0, teamsDone = 0;

  for (let i = 0; i < abbrs.length; i += 6) {
    const batch = abbrs.slice(i, i + 6);
    const results = await Promise.allSettled(batch.map(async abbr => {
      const url = `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/teams/${ABBR_TO_ESPN[abbr]}/depthcharts?limit=50`;
      const resp = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!resp.ok) throw new Error(`depthchart ${abbr} ${resp.status}`);
      return { abbr, data: await resp.json() };
    }));

    for (const res of results) {
      if (res.status !== 'fulfilled') continue;
      const { abbr, data } = res.value;
      const teamId = ids[abbr];
      if (!teamId) continue;
      const byEspnId = new Map(
        rows('SELECT id, espn_id FROM roster_players WHERE team_id = ? AND espn_id IS NOT NULL', teamId)
          .map(p => [String(p.espn_id), p.id]));

      // Prefer the base offense/defense formations over sub packages.
      for (const unit of data.items ?? []) {
        for (const [slot, info] of Object.entries(unit.positions ?? {})) {
          const code = (info.position?.abbreviation ?? slot).toUpperCase();
          for (const a of info.athletes ?? []) {
            const id = String(a.athlete?.$ref ?? '').match(/athletes\/(\d+)/)?.[1];
            if (!id) continue;
            const rid = byEspnId.get(id);
            if (!rid) continue;
            // don't let a sub-package slot overwrite a base-formation starter
            const existing = row('SELECT depth_slot, depth_order FROM roster_players WHERE id = ?', rid);
            if (existing?.depth_order != null && existing.depth_order <= (a.rank ?? 99)) continue;
            run('UPDATE roster_players SET depth_slot = ?, depth_order = ? WHERE id = ?', code, a.rank ?? null, rid);
            matched++;
          }
        }
      }
      teamsDone++;
    }
  }
  return { teams: teamsDone, assignments: matched };
}

r.post('/sync-depth', async (req, res, next) => {
  try { res.json(await syncDepthChart()); } catch (e) { next(e); }
});

r.post('/sync-rosters', async (req, res, next) => {
  try { res.json(await syncRosters()); } catch (e) { next(e); }
});
r.post('/sync-schedules', async (req, res, next) => {
  try { res.json(await syncSchedules(Number(req.query.season) || SEASON)); } catch (e) { next(e); }
});
r.post('/sync-cap', async (req, res, next) => {
  try { res.json(await syncCap()); } catch (e) { next(e); }
});

r.post('/sync-all', async (req, res, next) => {
  try {
    const out = {};
    out.rosters = await syncRosters().catch(e => ({ error: e.message }));
    out.depth = await syncDepthChart().catch(e => ({ error: e.message }));
    out.schedules = await syncSchedules().catch(e => ({ error: e.message }));
    out.cap = await syncCap().catch(e => ({ error: e.message }));
    res.json({ ok: true, ...out });
  } catch (e) { next(e); }
});

/** Strength of schedule: average opponent market strength, ranked easiest → hardest.
 *  Opponent strength = that team's total FantasyCalc value of its rostered fantasy
 *  players (a proxy for real roster quality that updates as the market moves). */
export function computeSOS(season = SEASON) {
  const strengthByTeam = {};
  for (const t of rows(`SELECT t.id, t.abbr, COALESCE(SUM(m.value),0) AS strength
                        FROM nfl_teams t
                        LEFT JOIN players p ON p.team_id = t.id AND p.fantasy_relevant = 1
                        LEFT JOIN player_metrics m ON m.player_id = p.id AND m.source = 'fc_value'
                        GROUP BY t.id`)) {
    strengthByTeam[t.abbr] = t.strength;
  }
  const vals = Object.values(strengthByTeam).filter(v => v > 0);
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 1;

  const teams = rows('SELECT id, abbr, name FROM nfl_teams');
  const out = [];
  for (const t of teams) {
    const games = rows('SELECT opponent_abbr, home, week FROM schedule_games WHERE season = ? AND team_id = ?', season, t.id);
    if (!games.length) continue;
    const oppStrengths = games.map(g => strengthByTeam[g.opponent_abbr] ?? avg);
    const mean = oppStrengths.reduce((a, b) => a + b, 0) / oppStrengths.length;
    out.push({
      team_id: t.id, abbr: t.abbr, name: t.name,
      games: games.length,
      home_games: games.filter(g => g.home).length,
      sos: mean / (avg || 1)   // 1.0 = league-average schedule
    });
  }
  out.sort((a, b) => a.sos - b.sos);      // easiest first
  out.forEach((x, i) => { x.rank = i + 1; });
  return out;
}

r.get('/sos', (req, res) => res.json(computeSOS(Number(req.query.season) || SEASON)));

/** Offseason overview for one team: cap, roster churn, needs, schedule. */
r.get('/offseason/:abbr', (req, res) => {
  const team = row('SELECT * FROM nfl_teams WHERE abbr = ?', req.params.abbr.toUpperCase());
  if (!team) return res.status(404).json({ error: 'team not found' });
  const season = Number(req.query.season) || SEASON;

  const roster = rows(`SELECT name, position, unit, jersey, age, experience, status
                       FROM roster_players WHERE team_id = ? ORDER BY unit, position, name`, team.id);
  const rookies = roster.filter(p => (p.experience ?? 99) === 0);
  const cap = row('SELECT * FROM team_cap WHERE team_id = ?', team.id);
  const schedule = rows(`SELECT week, date, opponent_abbr, home FROM schedule_games
                         WHERE season = ? AND team_id = ? ORDER BY week`, season, team.id);
  const sos = computeSOS(season).find(s => s.abbr === team.abbr) ?? null;

  // Positional group counts drive the "needs" read off the real 90-man roster.
  // ESPN uses a generic "LB" for off-ball backers and "DE" for most edge rushers.
  const GROUPS = {
    QB: ['QB'], RB: ['RB', 'FB'], WR: ['WR'], TE: ['TE'],
    OL: ['OT', 'OG', 'C', 'G', 'T', 'OL'],
    DL: ['DT', 'NT', 'DL'], EDGE: ['DE', 'OLB', 'EDGE'],
    LB: ['LB', 'ILB', 'MLB'], CB: ['CB'], S: ['S', 'FS', 'SS'], ST: ['K', 'P', 'LS']
  };
  const counts = {};
  for (const [g, poss] of Object.entries(GROUPS)) {
    counts[g] = roster.filter(p => poss.includes(p.position ?? '')).length;
  }
  const avgAgeBy = {};
  for (const [g, poss] of Object.entries(GROUPS)) {
    const ages = roster.filter(p => poss.includes(p.position ?? '') && p.age).map(p => p.age);
    avgAgeBy[g] = ages.length ? +(ages.reduce((a, b) => a + b, 0) / ages.length).toFixed(1) : null;
  }

  res.json({
    team: { abbr: team.abbr, name: team.name, head_coach: team.head_coach, oc_name: team.oc_name, dc_name: team.dc_name,
            primary_color: team.primary_color },
    cap,
    roster_size: roster.length,
    rookies: rookies.map(p => ({ name: p.name, position: p.position, jersey: p.jersey })),
    group_counts: counts,
    group_avg_age: avgAgeBy,
    schedule,
    sos,
    roster,
    // honest gaps — no free live source for these
    unavailable: {
      future_draft_picks: 'No free live source for future pick inventory (incl. traded picks). Not shown rather than guessed.',
      transactions: 'ESPN’s transactions API returns empty for this offseason; FA/trade moves appear in the news feed instead.'
    }
  });
});

/** The unit rosters used by X-and-O views and AI analysis. */
const DEPTH_UNIT = {
  LT: 'OL', LG: 'OL', C: 'OL', RG: 'OL', RT: 'OL', OL: 'OL',
  LDT: 'DL', RDT: 'DL', NT: 'DL', DT: 'DL', DL: 'DL',
  LDE: 'EDGE', RDE: 'EDGE', DE: 'EDGE', LOLB: 'EDGE', ROLB: 'EDGE', SLB: 'EDGE',
  MLB: 'LB', LILB: 'LB', RILB: 'LB', WLB: 'LB', ILB: 'LB', LB: 'LB',
  LCB: 'CB', RCB: 'CB', NB: 'CB', CB: 'CB',
  SS: 'S', FS: 'S', S: 'S',
  PK: 'ST', K: 'ST', P: 'ST', LS: 'ST', H: 'ST', PR: 'ST', KR: 'ST'
};
export const OL_SLOTS = ['LT', 'LG', 'C', 'RG', 'RT'];
// Fallback when Sleeper has no depth slot for a player.
const POS_UNIT = {
  OT: 'OL', OG: 'OL', C: 'OL', G: 'OL', T: 'OL', OL: 'OL',
  DT: 'DL', NT: 'DL', DL: 'DL', DE: 'EDGE',
  LB: 'LB', ILB: 'LB', MLB: 'LB', OLB: 'EDGE',
  CB: 'CB', S: 'S', FS: 'S', SS: 'S', DB: 'S',
  K: 'ST', P: 'ST', LS: 'ST'
};

export function unitRoster(teamId) {
  const roster = rows(`SELECT name, position, unit, jersey, age, experience, depth_slot, depth_order
                       FROM roster_players WHERE team_id = ?`, teamId);
  const groups = { OL: [], DL: [], EDGE: [], LB: [], CB: [], S: [], ST: [] };
  for (const p of roster) {
    const g = DEPTH_UNIT[p.depth_slot ?? ''] ?? POS_UNIT[p.position ?? ''];
    if (g && groups[g]) groups[g].push(p);
  }
  const sortUnit = list => list.sort((a, b) =>
    (a.depth_order ?? 99) - (b.depth_order ?? 99) || (a.name > b.name ? 1 : -1));
  for (const k of Object.keys(groups)) sortUnit(groups[k]);
  return {
    ...groups,
    DB: [...groups.CB, ...groups.S],
    starters: roster.filter(p => p.depth_order === 1 && p.depth_slot),
    all: roster
  };
}

r.get('/roster/:abbr', (req, res) => {
  const team = row('SELECT id, abbr, name FROM nfl_teams WHERE abbr = ?', req.params.abbr.toUpperCase());
  if (!team) return res.status(404).json({ error: 'team not found' });
  res.json({ team, ...unitRoster(team.id) });
});


/**
 * Per-slot and per-unit grades computed from real roster data — no AI, no guesses.
 * Signals: starter experience, room depth behind the starter, average age, and
 * (for skill players) FantasyCalc market value percentile.
 */
export function unitGrades(teamId) {
  const roster = rows(`SELECT rp.name, rp.position, rp.depth_slot, rp.depth_order, rp.age, rp.experience,
                              m.value AS market
                       FROM roster_players rp
                       LEFT JOIN players p ON p.espn_id = rp.espn_id
                       LEFT JOIN player_metrics m ON m.player_id = p.id AND m.source = 'fc_value'
                       WHERE rp.team_id = ? AND rp.depth_slot IS NOT NULL`, teamId);

  // league-wide market percentile reference for skill positions
  const marketVals = rows(`SELECT value FROM player_metrics WHERE source = 'fc_value' ORDER BY value`).map(r => r.value);
  const pct = v => {
    if (v == null || !marketVals.length) return null;
    let lo = 0, hi = marketVals.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (marketVals[mid] < v) lo = mid + 1; else hi = mid; }
    return lo / marketVals.length;
  };

  const bySlot = {};
  for (const p of roster) (bySlot[p.depth_slot] ??= []).push(p);
  for (const list of Object.values(bySlot)) list.sort((a, b) => (a.depth_order ?? 99) - (b.depth_order ?? 99));

  const slots = {};
  for (const [slot, list] of Object.entries(bySlot)) {
    const starter = list[0];
    if (!starter) continue;
    let score = 0.5;                                  // neutral baseline
    const reasons = [];

    const mp = pct(starter.market);
    if (mp != null) {
      score = mp;                                     // market is the strongest signal when we have it
      if (mp >= 0.9) reasons.push('elite market value');
      else if (mp <= 0.35) reasons.push('low market value');
    }
    const exp = starter.experience;
    if (exp === 0) { score -= 0.12; reasons.push('rookie starter'); }
    else if (exp != null && exp >= 9) { score -= 0.05; reasons.push(`${exp}-year vet`); }
    if (starter.age != null && starter.age >= 31) { score -= 0.08; reasons.push(`age ${starter.age}`); }
    if (starter.age != null && starter.age <= 24 && exp && exp >= 2) { score += 0.05; reasons.push('young ascending'); }

    const depthCount = list.length;
    if (depthCount <= 1) { score -= 0.10; reasons.push('no proven backup'); }
    else if (depthCount >= 4) { score += 0.04; reasons.push('deep room'); }

    score = Math.max(0, Math.min(1, score));
    slots[slot] = {
      starter: starter.name,
      score: +score.toFixed(2),
      grade: score >= 0.58 ? 'strength' : score <= 0.40 ? 'weakness' : 'ok',
      // skill slots are graded on real market value; trenches only on age/experience/depth
      basis: starter.market != null ? 'market value + age/experience/depth' : 'age, experience and depth only',
      reasons,
      depth: depthCount
    };
  }

  // roll slots up into units
  const UNIT_SLOTS = {
    OL: ['LT', 'LG', 'C', 'RG', 'RT'],
    SKILL: ['QB', 'RB', 'LWR', 'RWR', 'SWR', 'WR', 'TE'],
    DL: ['LDE', 'RDE', 'NT', 'LDT', 'RDT'],
    LB: ['MLB', 'WLB', 'SLB', 'LILB', 'RILB', 'LOLB', 'ROLB'],
    DB: ['LCB', 'RCB', 'NB', 'SS', 'FS']
  };
  const units = {};
  for (const [unit, codes] of Object.entries(UNIT_SLOTS)) {
    const present = codes.map(c => slots[c]).filter(Boolean);
    if (!present.length) continue;
    const avg = present.reduce((s, x) => s + x.score, 0) / present.length;
    units[unit] = {
      score: +avg.toFixed(2),
      grade: avg >= 0.56 ? 'strength' : avg <= 0.43 ? 'weakness' : 'ok',
      weakest: present.slice().sort((a, b) => a.score - b.score)[0]?.starter ?? null,
      strongest: present.slice().sort((a, b) => b.score - a.score)[0]?.starter ?? null,
      filled: present.length,
      expected: codes.length
    };
  }
  return { slots, units };
}

r.get('/grades/:abbr', (req, res) => {
  const team = row('SELECT id, abbr, name FROM nfl_teams WHERE abbr = ?', req.params.abbr.toUpperCase());
  if (!team) return res.status(404).json({ error: 'team not found' });
  res.json({ team, ...unitGrades(team.id) });
});

export default r;
