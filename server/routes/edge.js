/**
 * Draft and roster edge: VOR, survival curves, the gamelog sync, and the AI scout.
 *
 * SIX ROUTES WERE DELETED FROM THIS FILE on 2026-09-20, taking it from 13 to 7.
 * `/movers`, `/volatility`, `/schedule-edge` and `/efficiency` were read only by
 * `client/src/pages/Edge.tsx`, a page no file imports and no <Route> declares;
 * `/board` and `/sparklines` had no reader anywhere. `vorBoard()`, `volatility()`
 * and `scheduleEdge()` are untouched — `/scout/:id` still uses all three, and
 * trade-engine.js, draft-survival.js, tradelab.js and server/scripts/sync-history.js
 * still import them. The file was proposed for deletion on the strength of its dead
 * routes; four live importers is why that was wrong.
 *
 * `/vor` looked like the fifth dead one and is not: `client/src/pages/DraftRoom.tsx:33`
 * calls it and DraftRoom IS routed, at `/drafts/:id`.
 *
 * `POST /gamelogs/sync` has no client caller and is NOT dead either:
 * `scripts/bootstrap-data.mjs:104` dials it over HTTP once per season on a fresh
 * install. It was on the delete list until that line was read by hand.
 */
import { Router } from 'express';
import { db, rows, row, run } from '../db/index.js';
import { callClaude, parseJson, getApiKey } from '../services/claude.js';

import { draftSurvival } from '../services/draft-survival.js';
import { canonicalTeamCode } from '../services/team-codes.js';

const r = Router();
const SEASON = Number(process.env.NFL_SEASON) || 2026;

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

/**
 * Who survives to your next pick. Simulates the rest of the draft rather than
 * ranking the board, because "best available" is rarely the actual decision.
 */
r.get('/draft-survival', (req, res, next) => {
  try {
    // Not `.split(',').map(Number)` — ''.split(',') is [''] and Number('') is 0,
    // so an absent parameter would parse as "player 0 is taken" and shift every
    // pick in the simulated draft by one.
    const taken = String(req.query.taken ?? '').split(',')
      .map(x => x.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
    res.json(draftSurvival({
      seat: Math.max(1, Number(req.query.seat) || 1),
      teams: Math.min(16, Math.max(4, Number(req.query.teams) || 10)),
      rounds: Math.min(20, Math.max(3, Number(req.query.rounds) || 15)),
      trials: Math.min(8000, Number(req.query.trials) || 3000),
      taken
    }));
  } catch (e) { next(e); }
});

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

// ------------------------------------------- 3. Playoff & weekly schedule edge
/**
 * Opponent strength per week, and specifically weeks 15-17 (fantasy playoffs).
 *
 * POLARITY: here higher = HARDER (opponent strength over league average, sorted
 * ascending so rank 1 = easiest). matchups.js#scheduleOutlook also emits a field
 * called playoff_sos with the OPPOSITE polarity (a points multiplier, higher =
 * easier). They are different quantities that happen to share a name; do not
 * compare one to the other.
 *
 * NO DATA IS NOT A NUMBER. Strength is the summed market value (player_metrics,
 * source 'fc_value') of each team's fantasy-relevant players, and player_metrics
 * is currently EMPTY. The old code did not notice: every team's strength summed to
 * 0, `avg` defaulted to 1, and because 0 is not nullish the `?? avg` fallback never
 * fired — except for opponents whose abbreviation was missing from nfl_teams.
 * schedule_games spells Washington 'WSH' while nfl_teams says 'WAS', so the ONLY
 * variation in the output was "does this team play Washington in weeks 15-17"
 * (0 vs 0.333), mean 0.0416, not centred on 1. That arbitrary order was ranked
 * 1..32 and written verbatim into the Claude scout-report prompt as the
 * "fantasy-playoff SOS". Now: opponents are canonicalised (WSH -> WAS), and when no
 * team has any strength data the SOS fields are null and unranked rather than a
 * fabricated number.
 *
 * Separately, and not fixed here: even populated, an opponent's OFFENSIVE market
 * value is not a measure of how its DEFENCE handles your position.
 */
export function scheduleEdge(season = SEASON) {
  const strength = {};
  for (const t of rows(`SELECT t.abbr, COALESCE(SUM(m.value),0) AS s
                        FROM nfl_teams t
                        LEFT JOIN players p ON p.team_id = t.id AND p.fantasy_relevant = 1
                        LEFT JOIN player_metrics m ON m.player_id = p.id AND m.source = 'fc_value'
                        GROUP BY t.id`)) strength[canonicalTeamCode(t.abbr)] = t.s;
  const vals = Object.values(strength).filter(v => v > 0);
  const hasStrength = vals.length > 0;
  const avg = hasStrength ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const strengthOf = abbr => {
    const v = strength[canonicalTeamCode(abbr)];
    return Number.isFinite(v) && v > 0 ? v : avg;
  };

  const out = rows('SELECT id, abbr FROM nfl_teams').map(t => {
    const games = rows('SELECT week, opponent_abbr, home FROM schedule_games WHERE season = ? AND team_id = ? ORDER BY week',
      season, t.id);
    const playoff = games.filter(g => g.week >= 15 && g.week <= 17);
    const mean = arr => (arr.length ? arr.reduce((s, g) => s + strengthOf(g.opponent_abbr), 0) / arr.length : avg);
    return {
      abbr: t.abbr,
      season_sos: hasStrength ? +(mean(games) / avg).toFixed(3) : null,
      playoff_sos: hasStrength ? +(mean(playoff) / avg).toFixed(3) : null,
      playoff_games: playoff.map(g => `${g.home ? '' : '@'}${g.opponent_abbr}`),
      games,
      strength_basis: hasStrength ? 'opponent fantasy-relevant market value (offence, not defence)' : null,
      unavailable_reason: hasStrength ? null : 'no opponent-strength data on file (player_metrics fc_value is empty)'
    };
  });
  if (!hasStrength) return out.map(x => ({ ...x, playoff_rank: null }));
  return out.sort((a, b) => a.playoff_sos - b.playoff_sos)
    .map((x, i) => ({ ...x, playoff_rank: i + 1 }));
}

// --------------------------------------------- 5. Trade analyzer (RETIRED)
/**
 * RETIRED 2026-09-18 (trade-engine-correctness, GATE G7).
 *
 * This summed VOR on each side and called the difference a verdict. It ignored
 * the only currency that decides a trade (what your STARTING LINEUP projects
 * afterwards), the rest-of-season and playoff horizon, and the other manager
 * entirely — and it had no client caller. The scorer that does all three is
 * POST /api/trades/:leagueId/evaluate, the same `evaluate()` the trade finder
 * ranks with.
 *
 * IT IS A TOMBSTONE AND IT STAYS. `route-no-caller` reports it, correctly: nothing
 * calls it. Deleting it would turn a 410 that explains itself, and names the endpoint
 * to use instead, into a bare 404 — which is what an old client or a bookmarked call
 * would then get, with nothing to read. The row stays visible rather than going into
 * annotations.json, because "nothing calls this" is the true and intended state.
 */
r.post('/trade', (_req, res) => res.status(410).json({
  error: 'This endpoint was retired on 2026-09-18. A VOR-sum difference is not a trade verdict: it ignores your starting lineup, the rest of the season and the other manager.',
  use: '/api/trades/:leagueId/evaluate',
}));

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
SCHEDULE: ${sched?.playoff_sos != null ? `season SOS ${sched.season_sos}, fantasy-playoff SOS ${sched.playoff_sos} (rank ${sched.playoff_rank}/32, 1 = easiest), ` : 'no opponent-strength data on file — do not rate the schedule as easy or hard; '}Wk15-17 vs ${sched?.playoff_games?.join(', ') ?? '?'}
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

/* ------------------------------------------------------------------ */
