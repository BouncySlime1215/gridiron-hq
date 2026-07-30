import { Router } from 'express';
import { db, rows, row, run } from '../db/index.js';
import { callClaude, parseJson, getApiKey } from '../services/claude.js';

const r = Router();
const SEASON = Number(process.env.NFL_SEASON) || 2026;

db.exec(`
  CREATE TABLE IF NOT EXISTS player_gamelog (
    player_id INTEGER NOT NULL,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    opponent TEXT,
    fantasy_points REAL,
    PRIMARY KEY (player_id, season, week)
  );
  CREATE TABLE IF NOT EXISTS scout_reports (
    player_id INTEGER PRIMARY KEY REFERENCES players(id),
    verdict TEXT, report TEXT, confidence TEXT, generated_at TEXT
  );
`);

// ---------------------------------------------------------------- 1. VOR
/**
 * Value Over Replacement: projected points minus the points of the last
 * startable player at that position. This is what actually decides draft value —
 * 300 QB points are worth far less than 300 RB points when QB20 also scores 270.
 */
export function replacementLevels(teams = 12, starters = { QB: 1, RB: 2, WR: 3, TE: 1, K: 1, DEF: 1 }) {
  const levels = {};
  for (const [pos, n] of Object.entries(starters)) {
    const list = rows(`SELECT s.fantasy_points AS pts FROM player_season_stats s
                       JOIN players p ON p.id = s.player_id
                       WHERE s.season = ? AND s.kind = 'projected' AND p.position = ?
                         AND s.fantasy_points IS NOT NULL
                       ORDER BY s.fantasy_points DESC`, SEASON, pos).map(x => x.pts);
    const idx = Math.max(0, Math.min(list.length - 1, Math.round(teams * n) - 1));
    levels[pos] = list.length ? list[idx] : 0;
  }
  return levels;
}

export function vorBoard(teams = 12) {
  const levels = replacementLevels(teams);
  const list = rows(`SELECT p.id, p.name, p.position, p.espn_id, p.sleeper_id, t.abbr AS team_abbr,
                            s.fantasy_points AS proj, a.fantasy_points AS last_season,
                            adp.value AS adp
                     FROM players p
                     LEFT JOIN nfl_teams t ON t.id = p.team_id
                     JOIN player_season_stats s ON s.player_id = p.id AND s.season = ? AND s.kind = 'projected'
                     LEFT JOIN player_season_stats a ON a.player_id = p.id AND a.season = ? AND a.kind = 'actual'
                     LEFT JOIN player_metrics adp ON adp.player_id = p.id AND adp.source = 'ffc_adp'
                     WHERE s.fantasy_points IS NOT NULL`, SEASON, SEASON - 1);
  return list.map(p => ({
    ...p,
    replacement: levels[p.position] ?? 0,
    vor: +(p.proj - (levels[p.position] ?? 0)).toFixed(1)
  })).sort((a, b) => b.vor - a.vor)
    .map((p, i) => ({ ...p, vor_rank: i + 1, adp_edge: p.adp != null ? +(p.adp - (i + 1)).toFixed(1) : null }));
}

r.get('/vor', (req, res) => res.json(vorBoard(Number(req.query.teams) || 12)));

// -------------------------------------------------- 2. Volatility / boom-bust
/** Weekly fantasy points from ESPN game logs, cached so we can compute variance. */
export async function syncGameLogs(season = SEASON - 1, limit = 250) {
  const targets = rows(`SELECT p.id, p.espn_id, p.position FROM players p
                        JOIN player_season_stats s ON s.player_id = p.id AND s.season = ? AND s.kind = 'projected'
                        WHERE p.espn_id IS NOT NULL AND p.position IN ('QB','RB','WR','TE')
                        ORDER BY s.fantasy_points DESC LIMIT ?`, SEASON, limit);
  const ins = db.prepare(`INSERT INTO player_gamelog (player_id, season, week, opponent, fantasy_points)
    VALUES (?,?,?,?,?) ON CONFLICT(player_id, season, week) DO UPDATE SET fantasy_points = excluded.fantasy_points`);

  // PPR scoring so weekly points line up with the season totals we already show
  const score = s => (s.passingYards ?? 0) * 0.04 + (s.passingTouchdowns ?? 0) * 4 - (s.interceptions ?? 0) * 2
    + (s.rushingYards ?? 0) * 0.1 + (s.rushingTouchdowns ?? 0) * 6
    + (s.receivingYards ?? 0) * 0.1 + (s.receivingTouchdowns ?? 0) * 6 + (s.receptions ?? 0);

  let done = 0, games = 0;
  for (let i = 0; i < targets.length; i += 8) {
    const batch = targets.slice(i, i + 8);
    const got = await Promise.allSettled(batch.map(async t => {
      const resp = await fetch(`https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${t.espn_id}/gamelog?season=${season}`,
        { headers: { Accept: 'application/json' } });
      if (!resp.ok) throw new Error(String(resp.status));
      return { t, d: await resp.json() };
    }));
    for (const g of got) {
      if (g.status !== 'fulfilled') continue;
      const { t, d } = g.value;
      const names = d.names ?? [];
      const evById = d.events ?? {};
      for (const st of d.seasonTypes ?? []) {
        for (const cat of st.categories ?? []) {
          for (const ev of cat.events ?? []) {
            const meta = evById[ev.eventId] ?? {};
            if (meta.week == null) continue;
            const line = {};
            (ev.stats ?? []).forEach((v, idx) => { if (names[idx]) line[names[idx]] = Number(v) || 0; });
            ins.run(t.id, season, meta.week, meta.opponent?.abbreviation ?? null, +score(line).toFixed(1));
            games++;
          }
        }
      }
      done++;
    }
  }
  return { players: done, games };
}

r.post('/gamelogs/sync', async (req, res, next) => {
  try { res.json(await syncGameLogs(Number(req.query.season) || SEASON - 1, Number(req.query.limit) || 250)); }
  catch (e) { next(e); }
});

/** Boom rate, bust rate, floor, ceiling and a consistency score from real weeks. */
export function volatility(season = SEASON - 1) {
  const BOOM = { QB: 24, RB: 18, WR: 18, TE: 14 };
  const BUST = { QB: 14, RB: 8, WR: 8, TE: 6 };
  const out = new Map();
  const byPlayer = {};
  for (const g of rows('SELECT player_id, fantasy_points FROM player_gamelog WHERE season = ?', season)) {
    (byPlayer[g.player_id] ??= []).push(g.fantasy_points ?? 0);
  }
  const pos = Object.fromEntries(rows('SELECT id, position FROM players').map(p => [p.id, p.position]));
  for (const [pid, pts] of Object.entries(byPlayer)) {
    if (pts.length < 4) continue;
    const p = pos[pid] ?? 'WR';
    const mean = pts.reduce((a, b) => a + b, 0) / pts.length;
    const sd = Math.sqrt(pts.reduce((s, x) => s + (x - mean) ** 2, 0) / pts.length);
    const sorted = [...pts].sort((a, b) => a - b);
    const q = f => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
    out.set(Number(pid), {
      games: pts.length,
      avg: +mean.toFixed(1),
      floor: +q(0.2).toFixed(1),
      ceiling: +q(0.8).toFixed(1),
      boom_rate: +(pts.filter(x => x >= (BOOM[p] ?? 18)).length / pts.length).toFixed(2),
      bust_rate: +(pts.filter(x => x <= (BUST[p] ?? 8)).length / pts.length).toFixed(2),
      // low variance relative to output = dependable
      consistency: +(mean > 0 ? Math.max(0, 1 - sd / mean) : 0).toFixed(2)
    });
  }
  return out;
}

r.get('/volatility', (req, res) => {
  const v = volatility();
  const names = Object.fromEntries(rows('SELECT id, name, position FROM players').map(p => [p.id, p]));
  res.json([...v.entries()].map(([id, m]) => ({ player_id: id, ...names[id], ...m }))
    .filter(x => x.name)
    .sort((a, b) => b.avg - a.avg));
});

// ------------------------------------------- 3. Playoff & weekly schedule edge
/** Opponent strength per week, and specifically weeks 15-17 (fantasy playoffs). */
export function scheduleEdge(season = SEASON) {
  const strength = {};
  for (const t of rows(`SELECT t.abbr, COALESCE(SUM(m.value),0) AS s
                        FROM nfl_teams t
                        LEFT JOIN players p ON p.team_id = t.id AND p.fantasy_relevant = 1
                        LEFT JOIN player_metrics m ON m.player_id = p.id AND m.source = 'fc_value'
                        GROUP BY t.id`)) strength[t.abbr] = t.s;
  const vals = Object.values(strength).filter(v => v > 0);
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 1;

  return rows('SELECT id, abbr FROM nfl_teams').map(t => {
    const games = rows('SELECT week, opponent_abbr, home FROM schedule_games WHERE season = ? AND team_id = ? ORDER BY week',
      season, t.id);
    const playoff = games.filter(g => g.week >= 15 && g.week <= 17);
    const mean = arr => arr.length ? arr.reduce((s, g) => s + (strength[g.opponent_abbr] ?? avg), 0) / arr.length : avg;
    return {
      abbr: t.abbr,
      season_sos: +(mean(games) / avg).toFixed(3),
      playoff_sos: +(mean(playoff) / avg).toFixed(3),
      playoff_games: playoff.map(g => `${g.home ? '' : '@'}${g.opponent_abbr}`),
      games
    };
  }).sort((a, b) => a.playoff_sos - b.playoff_sos)
    .map((x, i) => ({ ...x, playoff_rank: i + 1 }));
}

r.get('/schedule-edge', (req, res) => res.json(scheduleEdge()));

// ------------------------------------------------ 4. Breakout / regression model
/**
 * Flags players whose projection diverges sharply from last season, then explains
 * why using age, draft capital, and market movement. Pure signal, no AI.
 */
r.get('/movers', (req, res) => {
  const list = rows(`SELECT p.id, p.name, p.position, p.espn_id, p.sleeper_id, t.abbr AS team_abbr,
                            s.fantasy_points AS proj, a.fantasy_points AS last,
                            rp.age, rp.experience, acc.draft_round, acc.draft_pick,
                            m.value AS market, mt.value AS trend
                     FROM players p
                     JOIN player_season_stats s ON s.player_id = p.id AND s.season = ? AND s.kind='projected'
                     LEFT JOIN player_season_stats a ON a.player_id = p.id AND a.season = ? AND a.kind='actual'
                     LEFT JOIN nfl_teams t ON t.id = p.team_id
                     LEFT JOIN roster_players rp ON rp.espn_id = p.espn_id
                     LEFT JOIN player_accolades acc ON acc.roster_player_id = rp.id
                     LEFT JOIN player_metrics m ON m.player_id = p.id AND m.source='fc_value'
                     LEFT JOIN player_metrics mt ON mt.player_id = p.id AND mt.source='fc_trend30'
                     WHERE s.fantasy_points > 80`, SEASON, SEASON - 1);

  const scored = list.map(p => {
    const delta = p.last != null ? p.proj - p.last : null;
    const pctDelta = p.last ? (delta / p.last) * 100 : null;
    const reasons = [];
    let score = pctDelta ?? 0;
    if (p.age != null && p.age <= 24) { score += 8; reasons.push(`age ${p.age}, ascending curve`); }
    if (p.age != null && p.age >= 30) { score -= 8; reasons.push(`age ${p.age}, decline risk`); }
    if (p.experience === 1) { score += 6; reasons.push('year-two leap window'); }
    if (p.draft_round === 1) { score += 4; reasons.push(`first-round pedigree (P${p.draft_pick})`); }
    if (p.trend != null && p.market) {
      const tp = (p.trend / (p.market - p.trend)) * 100;
      if (tp > 4) { score += 5; reasons.push(`market up ${tp.toFixed(1)}% in 30d`); }
      if (tp < -4) { score -= 5; reasons.push(`market down ${Math.abs(tp).toFixed(1)}% in 30d`); }
    }
    return { ...p, delta: delta != null ? +delta.toFixed(1) : null,
             pct_delta: pctDelta != null ? +pctDelta.toFixed(1) : null,
             signal: +score.toFixed(1), reasons };
  }).filter(p => p.pct_delta != null);

  scored.sort((a, b) => b.signal - a.signal);
  res.json({ breakouts: scored.slice(0, 25), regressions: scored.slice(-25).reverse() });
});

// ------------------------------------------------------- 5. Trade analyzer
r.post('/trade', (req, res) => {
  const { give = [], get = [], teams = 12 } = req.body ?? {};
  const board = new Map(vorBoard(teams).map(p => [p.id, p]));
  const val = ids => ids.map(id => board.get(Number(id))).filter(Boolean);
  const giveP = val(give), getP = val(get);
  const sum = list => ({
    vor: +list.reduce((s, p) => s + p.vor, 0).toFixed(1),
    proj: +list.reduce((s, p) => s + p.proj, 0).toFixed(1),
    best: list.slice().sort((a, b) => b.vor - a.vor)[0]?.name ?? null
  });
  const a = sum(giveP), b = sum(getP);
  const diff = +(b.vor - a.vor).toFixed(1);
  return res.json({
    give: giveP, get: getP, give_total: a, get_total: b, vor_diff: diff,
    verdict: diff > 15 ? 'clear win' : diff > 5 ? 'slight win' : diff < -15 ? 'clear loss' : diff < -5 ? 'slight loss' : 'even',
    note: giveP.length !== getP.length
      ? 'Uneven player counts — the side sending more players also needs roster spots to be worth it.'
      : null
  });
});

// -------------------------------------------------------- 6. AI Scout Report
r.post('/scout/:id', async (req, res, next) => {
  try {
    if (!getApiKey()) return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right).' });
    const p = row(`SELECT p.*, t.abbr AS team_abbr, t.name AS team_name, t.head_coach, t.oc_name,
                          t.off_scheme, t.off_scheme_detail, t.ol_analysis
                   FROM players p LEFT JOIN nfl_teams t ON t.id = p.team_id WHERE p.id = ?`, req.params.id);
    if (!p) return res.status(404).json({ error: 'player not found' });

    const board = vorBoard();
    const v = board.find(x => x.id === p.id);
    const vol = volatility().get(p.id);
    const sched = scheduleEdge().find(s => s.abbr === p.team_abbr);
    const news = rows(`SELECT date, headline FROM news_items n LEFT JOIN nfl_teams t ON t.id = n.team_id
                       WHERE n.headline LIKE ? OR t.abbr = ? ORDER BY n.date DESC LIMIT 6`,
      `%${p.name}%`, p.team_abbr ?? '');

    const msg = await callClaude({
      feature: 'scout-report',
      maxTokens: 1100,
      prompt: `Write a scouting report for ${p.name} (${p.position}, ${p.team_name ?? 'FA'}) for the 2026 fantasy season.

VALUE: projected ${v?.proj?.toFixed(0) ?? '?'} pts, VOR ${v?.vor ?? '?'} (rank ${v?.vor_rank ?? '?'} overall), ADP ${v?.adp ?? 'n/a'}${v?.adp_edge != null ? `, ADP is ${v.adp_edge > 0 ? `${v.adp_edge.toFixed(0)} picks LATER than his VOR rank (value)` : `${Math.abs(v.adp_edge).toFixed(0)} picks EARLIER than his VOR rank (cost)`}` : ''}
WEEKLY PROFILE (last season): ${vol ? `avg ${vol.avg}, floor ${vol.floor}, ceiling ${vol.ceiling}, boom ${(vol.boom_rate*100).toFixed(0)}% of weeks, bust ${(vol.bust_rate*100).toFixed(0)}%, consistency ${vol.consistency}` : 'no weekly data'}
SCHEDULE: season SOS ${sched?.season_sos ?? '?'}, fantasy-playoff SOS ${sched?.playoff_sos ?? '?'} (rank ${sched?.playoff_rank ?? '?'}/32, 1 = easiest), Wk15-17 vs ${sched?.playoff_games?.join(', ') ?? '?'}
OFFENSE: HC ${p.head_coach}, OC ${p.oc_name}. ${p.off_scheme_detail ?? ''}
O-LINE: ${p.ol_analysis ?? 'n/a'}
NEWS: ${news.map(n => `[${n.date}] ${n.headline}`).join(' | ') || 'none'}

Write for someone about to draft him. Reference the actual numbers above. Cover: what his role really is, whether ADP is a bargain or a tax, his floor/ceiling profile and what kind of roster he fits, the playoff schedule, and the single biggest risk.

Respond with ONLY JSON: {"verdict":"one of: LEAGUE WINNER, SOLID VALUE, FAIR PRICE, OVERPRICED, AVOID","confidence":"high|medium|low","report":"4-6 sentences"}`
    });
    const out = parseJson(msg);
    run(`INSERT INTO scout_reports (player_id, verdict, report, confidence, generated_at)
         VALUES (?,?,?,?,datetime('now'))
         ON CONFLICT(player_id) DO UPDATE SET verdict=excluded.verdict, report=excluded.report,
           confidence=excluded.confidence, generated_at=excluded.generated_at`,
      p.id, out.verdict, out.report, out.confidence);
    res.json(out);
  } catch (e) { next(e); }
});

r.get('/scout/:id', (req, res) => {
  res.json(row('SELECT verdict, report, confidence, generated_at FROM scout_reports WHERE player_id = ?', req.params.id) ?? null);
});

// ------------------------------------------------- 7. Season Monte Carlo sim
/** Simulate a roster's weekly output using each player's real distribution. */
r.post('/simulate', (req, res) => {
  const { player_ids = [], runs = 2000, starters = { QB: 1, RB: 2, WR: 3, TE: 1 } } = req.body ?? {};
  const vol = volatility();
  const meta = Object.fromEntries(rows('SELECT id, name, position FROM players').map(p => [p.id, p]));
  const roster = player_ids.map(Number).map(id => ({ id, ...meta[id], v: vol.get(id) })).filter(p => p.name);
  if (!roster.length) return res.status(400).json({ error: 'no valid players' });

  // gaussian sample around each player's mean using their observed spread
  const draw = p => {
    if (!p.v) return 0;
    const sd = Math.max(1, (p.v.ceiling - p.v.floor) / 2);
    const u = Math.random(), w = Math.random();
    const z = Math.sqrt(-2 * Math.log(u || 1e-9)) * Math.cos(2 * Math.PI * w);
    return Math.max(0, p.v.avg + z * sd);
  };

  const totals = [];
  for (let i = 0; i < runs; i++) {
    let week = 0;
    for (const [pos, n] of Object.entries(starters)) {
      const scores = roster.filter(p => p.position === pos).map(draw).sort((a, b) => b - a);
      week += scores.slice(0, n).reduce((s, x) => s + x, 0);
    }
    totals.push(week);
  }
  totals.sort((a, b) => a - b);
  const pct = f => +totals[Math.floor(f * (totals.length - 1))].toFixed(1);
  res.json({
    runs, players: roster.length,
    median_week: pct(0.5), floor_week: pct(0.1), ceiling_week: pct(0.9),
    p25: pct(0.25), p75: pct(0.75),
    missing_data: roster.filter(p => !p.v).map(p => p.name)
  });
});

export default r;

/* ------------------------------------------ Efficiency & opportunity metrics */
/**
 * Rate stats, not totals. Volume tells you the role; efficiency tells you
 * whether the role is being converted — and which way a projection should bend.
 */
r.get('/efficiency', (req, res) => {
  const season = Number(req.query.season) || SEASON - 1;
  const pos = req.query.position;
  const list = rows(`SELECT p.id, p.name, p.position, p.espn_id, p.sleeper_id, t.abbr AS team_abbr,
                            a.raw AS actual, pr.raw AS proj_raw,
                            a.fantasy_points AS pts, pr.fantasy_points AS proj
                     FROM players p
                     LEFT JOIN nfl_teams t ON t.id = p.team_id
                     JOIN player_season_stats a  ON a.player_id = p.id  AND a.season = ? AND a.kind='actual'
                     LEFT JOIN player_season_stats pr ON pr.player_id = p.id AND pr.season = ? AND pr.kind='projected'
                     WHERE a.raw IS NOT NULL ${pos ? 'AND p.position = ?' : ''}`,
    season, SEASON, ...(pos ? [pos] : []));

  // team pass/rush volume so we can express usage as a share of the offense
  const teamTot = {};
  for (const p of list) {
    const s = JSON.parse(p.actual);
    const k = p.team_abbr ?? '—';
    teamTot[k] ??= { targets: 0, carries: 0 };
    teamTot[k].targets += s.targets ?? 0;
    teamTot[k].carries += s.rushAtt ?? 0;
  }

  const out = list.map(p => {
    const s = JSON.parse(p.actual);
    const tt = teamTot[p.team_abbr ?? '—'] ?? { targets: 1, carries: 1 };
    const targets = s.targets ?? 0, rec = s.rec ?? 0, carries = s.rushAtt ?? 0;
    const recYds = s.recYds ?? 0, rushYds = s.rushYds ?? 0;
    const tds = (s.recTD ?? 0) + (s.rushTD ?? 0) + (s.passTD ?? 0);
    const touches = carries + rec;
    return {
      id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
      espn_id: p.espn_id, sleeper_id: p.sleeper_id,
      points: p.pts, projected: p.proj,
      // opportunity
      targets, carries, touches,
      target_share: tt.targets ? +((targets / tt.targets) * 100).toFixed(1) : null,
      rush_share: tt.carries ? +((carries / tt.carries) * 100).toFixed(1) : null,
      // efficiency
      catch_rate: targets ? +((rec / targets) * 100).toFixed(1) : null,
      yds_per_target: targets ? +(recYds / targets).toFixed(2) : null,
      yds_per_catch: rec ? +(recYds / rec).toFixed(2) : null,
      yds_per_carry: carries ? +(rushYds / carries).toFixed(2) : null,
      yds_per_touch: touches ? +((recYds + rushYds) / touches).toFixed(2) : null,
      // scoring rate — the most regression-prone number in fantasy
      td_rate: touches ? +((tds / touches) * 100).toFixed(1) : null,
      tds
    };
  }).filter(p => p.touches >= 20 || p.position === 'QB');

  // flag TD rates far from positional norm — those are the projections most likely to move
  const byPos = {};
  for (const p of out) if (p.td_rate != null) (byPos[p.position] ??= []).push(p.td_rate);
  const mean = {};
  for (const [k, v] of Object.entries(byPos)) mean[k] = v.reduce((a, b) => a + b, 0) / v.length;

  res.json(out.map(p => ({
    ...p,
    td_rate_vs_pos: p.td_rate != null && mean[p.position]
      ? +(p.td_rate - mean[p.position]).toFixed(1) : null,
    regression_flag: p.td_rate != null && mean[p.position]
      ? (p.td_rate > mean[p.position] * 1.6 ? 'TD rate unsustainably high'
        : p.td_rate < mean[p.position] * 0.5 ? 'TD rate due to rebound' : null)
      : null
  })).sort((a, b) => (b.points ?? 0) - (a.points ?? 0)));
});
