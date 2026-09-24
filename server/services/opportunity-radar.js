/**
 * O1 opportunity radar: who is about to get MORE (or LESS) opportunity, and why.
 *
 * Event-driven, on top of the one baseline that has survived four earlier attempts
 * (docs/OPPORTUNITY-FINDINGS-2026-09-19.md): an EWMA of the player's own recent usage.
 * Every event below is a real, pre-kickoff observable (injury report, depth chart,
 * box scores of weeks already played). Each one gets its own measured effect on the
 * player's own next-week and next-three-week opportunity, with n and a
 * player-clustered CI, fitted on 2021-2023 and graded on 2024 (scripts/fit-opportunity-radar.mjs).
 * 2025 is never read here.
 *
 * Rules this module holds itself to:
 *  - Usage is a number. Absences, arrivals and returns enter as the opportunity count the
 *    teammate actually carried (his own EWMA), never as a bucket.
 *  - Rosters come from PRIOR weeks. A player ruled out has no box-score row the week he
 *    misses; searching the graded week finds nobody (the 0-of-5,336 bug the 9/19 study
 *    pinned in test/opportunity-model.test.js).
 *  - "Out" is the role layer's P(out) (nfl_availability_role_rates) clearing OUT_THRESHOLD.
 *    A questionable teammate gives no bump: he is surfaced as a pending watch item only.
 *  - An event moves a number only if it passed the pre-registered gate (FITTED_EFFECTS
 *    below, passes_gate). Everything else is served as 'watch' with its evidence.
 *  - Nothing here writes into projections.js / player-week-engine.js. That is O1c.
 *
 * Served behind GRIDIRON_OPP_RADAR (default off), which GRIDIRON_PREVIEW_UNCONFIRMED also
 * turns on (preview-mode.js is the only reader of that variable).
 */
import { rows } from '../db/index.js';
import { detectRoleChange } from './role-changepoint.js';
import { previewUnconfirmed, previewFields } from './preview-mode.js';

export const RADAR_FLAG = 'GRIDIRON_OPP_RADAR';
export const EWMA_ALPHA = 0.4;          // the 9/19 winner's recency weight
export const OUT_THRESHOLD = 0.5;       // P(out) at or above this counts as out
export const MIN_PRIOR_GAMES = 2;
export const POSITIONS = Object.freeze(['QB', 'RB', 'WR', 'TE']);
export const GROUPS = Object.freeze({ QB: 'QB', RB: 'RB', WR: 'WRTE', TE: 'WRTE' });
const OL_SLOTS = ['LT', 'LG', 'C', 'RG', 'RT'];

/**
 * Every event type the radar looks for, what its magnitude m means, and which
 * position groups it is measured on. Effect on the outcome is beta * m.
 */
export const EVENT_TYPES = Object.freeze({
  teammate_out:       { label: 'Same-position teammate ruled out (fresh)', unit: 'opportunities the absent teammate averaged', groups: ['RB', 'WRTE'] },
  backup_qb_start:    { label: 'Backup QB starting (starter ruled out)', unit: 'binary', groups: ['RB', 'WRTE'] },
  qb_return:          { label: 'Starting QB returning', unit: 'binary', groups: ['RB', 'WRTE'] },
  oline_out:          { label: 'O-line starters ruled out (fresh)', unit: 'starters out', groups: ['QB', 'RB', 'WRTE'] },
  traded_player:      { label: 'He was traded (first game with new team)', unit: 'binary', groups: ['QB', 'RB', 'WRTE'] },
  teammate_arrival:   { label: 'Same-position player traded in', unit: 'opportunities the arrival averaged', groups: ['RB', 'WRTE'] },
  teammate_departure: { label: 'Same-position teammate traded away', unit: 'opportunities he averaged', groups: ['RB', 'WRTE'] },
  usage_drop:         { label: 'Realized usage drop (2 games, snap-confirmed)', unit: 'binary', groups: ['QB', 'RB', 'WRTE'] },
  usage_rise:         { label: 'Realized usage rise (2 games, snap-confirmed)', unit: 'binary', groups: ['QB', 'RB', 'WRTE'] },
  depth_promotion:    { label: 'Depth chart promotion', unit: 'binary', groups: ['QB', 'RB', 'WRTE'] },
  depth_demotion:     { label: 'Depth chart demotion', unit: 'binary', groups: ['QB', 'RB', 'WRTE'] },
  snap_trend_up:      { label: 'Snap share up (last 3 vs season)', unit: 'snap-share points', groups: ['RB', 'WRTE'] },
  snap_trend_down:    { label: 'Snap share down (last 3 vs season)', unit: 'snap-share points', groups: ['RB', 'WRTE'] },
  redzone_growth:     { label: 'Red-zone role growth (last 3 vs season)', unit: 'red-zone share points', groups: ['RB', 'WRTE'] },
  coach_change:       { label: 'Head coach / play-caller change', unit: 'binary', groups: ['QB', 'RB', 'WRTE'] },
  star_return:        { label: 'Same-position teammate returning from injury', unit: 'opportunities he averaged', groups: ['RB', 'WRTE'] },
  rookie_ramp:        { label: 'Rookie, second half of season', unit: 'binary', groups: ['QB', 'RB', 'WRTE'] },
  news_role:          { label: 'News role report (typed extraction)', unit: 'binary', groups: ['QB', 'RB', 'WRTE'] }
});

/** Outcomes each event is measured on. `opp1` is the gate outcome. */
export const OUTCOMES = Object.freeze({
  opp1: 'opportunities next week',
  opp3: 'opportunities per game, next 3 weeks',
  ppr1: 'PPR points next week',
  eff1: 'PPR points per opportunity next week'
});
export const OPP_UNIT = { QB: 'pass attempts + carries', RB: 'carries + targets', WRTE: 'targets' };

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
export function ewma(series, alpha = EWMA_ALPHA) {
  if (!series.length) return null;
  let acc = series[0];
  for (let i = 1; i < series.length; i++) acc = alpha * series[i] + (1 - alpha) * acc;
  return acc;
}
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** A player's opportunity count: the thing the radar predicts. */
export function opportunityCount(r) {
  if (r.position === 'QB') return num(r.attempts) + num(r.carries);
  if (r.position === 'RB') return num(r.carries) + num(r.targets);
  return num(r.targets);
}
export function pprPoints(r) {
  return 0.04 * num(r.passing_yards) + 4 * num(r.passing_tds) - 2 * num(r.interceptions)
    + 0.1 * num(r.rushing_yards) + 6 * num(r.rushing_tds)
    + num(r.receptions) + 0.1 * num(r.receiving_yards) + 6 * num(r.receiving_tds) - 2 * num(r.fumbles_lost);
}

// ---------------------------------------------------------------- role layer P(out)

const PRACTICE = s => {
  const t = String(s ?? '').toLowerCase();
  if (t.includes('did not')) return 'dnp';
  if (t.includes('limited')) return 'limited';
  if (t.includes('full')) return 'full';
  return 'none';
};
const REPORT_DEFAULT = { out: 1, doubtful: 0.9, questionable: 0.25 };

/** P(out) lookup from the role layer's fitted cells (tier and gap pooled). */
export function loadPOut() {
  const cells = new Map();
  try {
    for (const r of rows(`SELECT report_status, practice_status, position, p_active FROM nfl_availability_role_rates
                          WHERE tier = '*' AND gap = '*'`)) {
      cells.set(`${r.report_status}|${r.practice_status}|${r.position}`, 1 - r.p_active);
    }
  } catch { /* table absent in a bare test DB: report-status defaults below */ }
  return (report, practice, position) => {
    const rep = String(report ?? '').toLowerCase();
    if (!REPORT_DEFAULT[rep]) return 0; // not on the report as out/doubtful/questionable: not flagged
    const pr = PRACTICE(practice);
    return cells.get(`${rep}|${pr}|${position}`) ?? cells.get(`${rep}|*|${position}`) ?? REPORT_DEFAULT[rep];
  };
}

// ---------------------------------------------------------------- season loaders

function loadSeason(season) {
  const usage = rows(`
    SELECT u.player_id, u.week, u.team, u.opponent, u.position,
           u.attempts, u.carries, u.targets, u.receptions, u.passing_yards, u.passing_tds, u.interceptions,
           u.rushing_yards, u.rushing_tds, u.receiving_yards, u.receiving_tds, u.fumbles_lost,
           s.offense_pct, p.gsis_id, p.name
      FROM player_week_usage u
      JOIN players p ON p.id = u.player_id
      LEFT JOIN player_week_snaps s ON s.player_id = u.player_id AND s.season = u.season AND s.week = u.week
     WHERE u.season = ? AND u.week <= 18 AND u.position IN ('QB','RB','WR','TE')
     ORDER BY u.week, u.team`, season);
  const injuries = new Map();
  for (const r of rows(`SELECT week, gsis_id, report_status, practice_status, position FROM nfl_injuries
                        WHERE season = ? AND gsis_id IS NOT NULL`, season)) {
    injuries.set(`${r.week}|${r.gsis_id}`, r);
  }
  const depth = new Map();   // week|team -> rows
  for (const r of rows(`SELECT week, team, gsis_id, player_name, pos_abb, pos_rank, pos_slot FROM nfl_depth WHERE season = ?`, season)) {
    const k = `${r.week}|${r.team}`;
    if (!depth.has(k)) depth.set(k, []);
    depth.get(k).push(r);
  }
  const rz = new Map();
  try {
    for (const r of rows(`SELECT week, player_id AS gsis_id, team,
                                 COALESCE(json_extract(features,'$.red_zone_targets'),0) + COALESCE(json_extract(features,'$.red_zone_carries'),0) AS rz
                            FROM nfl_player_week_features WHERE season = ?`, season)) rz.set(`${r.week}|${r.gsis_id}`, num(r.rz));
  } catch { /* optional */ }
  const teamWeek = new Map();
  try {
    for (const r of rows(`SELECT week, team, json_extract(features,'$.off_plays') AS plays,
                                 json_extract(features,'$.off_pass_rate') AS pass_rate
                            FROM nfl_team_week_features WHERE season = ?`, season)) teamWeek.set(`${r.week}|${r.team}`, r);
  } catch { /* optional */ }
  const box = new Map();     // week|defence -> mean defenders in box
  try {
    for (const r of rows(`SELECT game_id, possession, AVG(defenders_in_box) AS box FROM nfl_play_formations
                           WHERE season = ? AND defenders_in_box > 0 GROUP BY game_id, possession`, season)) {
      const [, wk, away, home] = String(r.game_id).split('_');
      const defence = r.possession === home ? away : home;
      box.set(`${Number(wk)}|${defence}`, r.box);
    }
  } catch { /* optional */ }
  const lines = new Map();
  for (const r of rows(`SELECT week, team, opponent, spread, total, implied_points FROM game_lines WHERE season = ?`, season)) {
    lines.set(`${r.week}|${r.team}`, r);
  }
  const coaches = new Map();
  try {
    for (const r of rows('SELECT team, coach, games FROM nfl_team_coaches WHERE season = ?', season)) {
      if (!coaches.has(r.team)) coaches.set(r.team, []);
      coaches.get(r.team).push(r);
    }
  } catch { /* optional */ }
  let rookies = new Set();
  try {
    rookies = new Set(rows(`SELECT player_id FROM nfl_player_week_features GROUP BY player_id HAVING MIN(season) = ?`, season)
      .map(r => r.player_id));
  } catch { /* optional */ }
  return { usage, injuries, depth, rz, teamWeek, box, lines, coaches, rookies };
}

/** Week of a midseason head-coach change, from nfl_team_coaches (games per coach); null when none. */
function coachChangeWeek(list) {
  if (!list || list.length < 2) return null;
  const first = list[0];
  return num(first.games) + 1;
}

// ---------------------------------------------------------------- the row builder

/**
 * One row per (player, week) for weeks 3-18: the strictly-prior EWMA baseline, every
 * event found before kickoff, and (when the week has been played) the outcomes.
 *
 * `live: true` also emits roster members with no row that week (the week is not played
 * yet), which is how the served list for the current week is built; grading keeps only
 * players who played (`played: true`).
 *
 * `newsSignals`: optional Map player_id -> [{ role_delta, published_at }] for the live week.
 * `trades`: optional Map player_id -> { from_team, to_team } for the live week (roster events).
 */
export function buildRadarRows(season, { startWeek = 3, endWeek = 18, live = false, data = null,
  newsSignals = null, trades = null, pOut = null } = {}) {
  const d = data ?? loadSeason(season);
  const P = pOut ?? loadPOut();
  const byWeek = new Map();
  for (const r of d.usage) {
    if (!byWeek.has(r.week)) byWeek.set(r.week, []);
    byWeek.get(r.week).push(r);
  }
  const lastPlayed = Math.max(0, ...byWeek.keys());
  const lastWeek = live ? Math.max(endWeek, lastPlayed + 1) : lastPlayed;

  // Outcomes by player/week, for the 3-week horizon.
  const oppAt = new Map();
  for (const r of d.usage) oppAt.set(`${r.player_id}|${r.week}`, opportunityCount(r));

  const hist = new Map();      // player_id -> { games: [...], team, position, gsis, name }
  const teamGames = new Map(); // team -> [weeks played]
  const teamOpp = new Map();   // team|group -> [{week,total}] team totals per group
  const teamRz = new Map();    // team -> week -> rz total
  const allowed = new Map();   // defence|group -> [opp allowed per game]
  const coachWeek = new Map([...d.coaches].map(([t, l]) => [t, coachChangeWeek(l)]));
  const pace = new Map();      // team -> [{plays, pass_rate}] per game played
  const boxFaced = new Map();  // defence -> [mean defenders in box] per game played
  const out = [];

  const pOutOf = (week, gsis, position) => {
    const inj = gsis ? d.injuries.get(`${week}|${gsis}`) : null;
    return inj ? P(inj.report_status, inj.practice_status, position) : 0;
  };
  const statusOf = (week, gsis) => (gsis ? d.injuries.get(`${week}|${gsis}`)?.report_status ?? null : null);
  const prevTeamWeek = (team, week) => {
    const w = teamGames.get(team) ?? [];
    for (let i = w.length - 1; i >= 0; i--) if (w[i] < week) return w[i];
    return null;
  };
  const depthRank = (week, team, gsis, position) => {
    const list = d.depth.get(`${week}|${team}`);
    if (!list) return null;
    let best = null;
    for (const x of list) if (x.gsis_id === gsis && x.pos_abb === position) best = best == null ? x.pos_rank : Math.min(best, x.pos_rank);
    return best;
  };
  const prevDepthWeek = (team, week) => {
    for (let w = week - 1; w >= 1; w--) if (d.depth.has(`${w}|${team}`)) return w;
    return null;
  };

  for (let week = 1; week <= lastWeek; week++) {
    const weekRows = byWeek.get(week) ?? [];
    const playedNow = new Map(weekRows.map(r => [r.player_id, r]));

    if (week >= startWeek && week <= endWeek) {
      // Current team of every player, from prior weeks (moves follow the player).
      const roster = new Map();  // team -> [player_id]
      for (const [pid, h] of hist) {
        if (!roster.has(h.team)) roster.set(h.team, []);
        roster.get(h.team).push(pid);
      }
      // A player seen this week for a different team is a trade known before kickoff.
      const movedTo = new Map();
      for (const r of weekRows) {
        const h = hist.get(r.player_id);
        if (h && h.team !== r.team) movedTo.set(r.player_id, { from_team: h.team, to_team: r.team });
      }
      if (trades) for (const [pid, t] of trades) if (hist.has(pid)) movedTo.set(pid, t);
      const teamOfNow = pid => movedTo.get(pid)?.to_team ?? hist.get(pid)?.team;

      const teamCtx = new Map();
      const ctxFor = team => {
        if (teamCtx.has(team)) return teamCtx.get(team);
        const prev = prevTeamWeek(team, week);
        const members = (roster.get(team) ?? []).filter(pid => teamOfNow(pid) === team);
        // Primary QB: most attempts over the team's prior games this season.
        let qb = null;
        for (const pid of members) {
          const h = hist.get(pid);
          if (h.position !== 'QB') continue;
          const att = h.games.filter(g => g.team === team).reduce((s, g) => s + num(g.attempts), 0);
          if (!qb || att > qb.att) qb = { pid, att, h };
        }
        let qbEvent = null;
        if (qb && qb.att > 0) {
          const pNow = pOutOf(week, qb.h.gsis, 'QB');
          const playedPrev = prev != null && qb.h.games.some(g => g.week === prev);
          const pPrev = prev != null ? pOutOf(prev, qb.h.gsis, 'QB') : 0;
          if (pNow >= OUT_THRESHOLD && playedPrev) qbEvent = { type: 'backup_qb_start', qb: qb.h.name, p_out: pNow, status: statusOf(week, qb.h.gsis) };
          else if (pNow < OUT_THRESHOLD && prev != null && !playedPrev && pPrev >= OUT_THRESHOLD) qbEvent = { type: 'qb_return', qb: qb.h.name, p_out: pNow };
        }
        // O-line starters (rank 1 at LT/LG/C/RG/RT on the previous depth chart) newly ruled out.
        const dw = prevDepthWeek(team, week);
        const ol = [];
        if (dw != null) {
          for (const x of d.depth.get(`${dw}|${team}`) ?? []) {
            if (x.pos_rank !== 1 || !OL_SLOTS.includes(x.pos_slot)) continue;
            const pNow = pOutOf(week, x.gsis_id, x.pos_abb);
            const pPrev = prev != null ? pOutOf(prev, x.gsis_id, x.pos_abb) : 0;
            if (pNow >= OUT_THRESHOLD && pPrev < OUT_THRESHOLD) ol.push({ name: x.player_name, slot: x.pos_slot, p_out: pNow });
          }
        }
        const cw = coachWeek.get(team);
        const ctx = { prev, members, qbEvent, ol, coachChange: cw != null && week >= cw && week < cw + 3 };
        teamCtx.set(team, ctx);
        return ctx;
      };

      const candidates = live
        ? [...hist.keys()]
        : weekRows.map(r => r.player_id).filter(pid => hist.has(pid));
      for (const pid of candidates) {
        const h = hist.get(pid);
        const now = playedNow.get(pid) ?? null;
        const position = h.position;
        if (!POSITIONS.includes(position)) continue;
        const group = GROUPS[position];
        const games = h.games;
        if (games.length < MIN_PRIOR_GAMES) continue;
        const team = teamOfNow(pid);
        const pSelf = pOutOf(week, h.gsis, position);
        if (live && !now && pSelf >= OUT_THRESHOLD) continue; // he is out: availability's question, not ours
        const ctx = ctxFor(team);
        const opps = games.map(g => g.opp);
        const base = ewma(opps);
        const ppr = ewma(games.map(g => g.ppr));
        const effGames = games.filter(g => g.opp > 0);
        const eff = effGames.length ? ewma(effGames.map(g => g.ppr / g.opp)) : null;
        const events = [];
        const pending = [];

        // 1, 10: teammates at the same position group ruled out (fresh) or returning.
        for (const tid of ctx.members) {
          if (tid === pid) continue;
          const t = hist.get(tid);
          if (GROUPS[t.position] !== group || group === 'QB') continue;
          const tGames = t.games.filter(g => g.team === team);
          if (!tGames.length) continue;
          const tOpp = ewma(tGames.map(g => g.opp));
          if (!(tOpp > 0)) continue;
          const pNow = pOutOf(week, t.gsis, t.position);
          const playedPrev = ctx.prev != null && tGames.some(g => g.week === ctx.prev);
          if (pNow >= OUT_THRESHOLD && playedPrev) {
            events.push({ type: 'teammate_out', m: tOpp, who: t.name, p_out: +pNow.toFixed(2), status: statusOf(week, t.gsis) });
          } else if (pNow > 0 && pNow < OUT_THRESHOLD && playedPrev && tOpp >= 3) {
            pending.push({ type: 'teammate_out', who: t.name, p_out: +pNow.toFixed(2), status: statusOf(week, t.gsis), would_vacate: +tOpp.toFixed(1) });
          }
          const pPrev = ctx.prev != null ? pOutOf(ctx.prev, t.gsis, t.position) : 0;
          if (!playedPrev && ctx.prev != null && pPrev >= OUT_THRESHOLD && pNow < OUT_THRESHOLD && tGames.length >= 2 && tOpp >= 3) {
            events.push({ type: 'star_return', m: tOpp, who: t.name, p_out: +pNow.toFixed(2) });
          }
        }
        // 2: QB switch (for pass-catchers and backs).
        if (group !== 'QB' && ctx.qbEvent) events.push({ type: ctx.qbEvent.type, m: 1, who: ctx.qbEvent.qb, p_out: +ctx.qbEvent.p_out.toFixed(2) });
        // 3: O-line.
        if (ctx.ol.length) events.push({ type: 'oline_out', m: ctx.ol.length, who: ctx.ol.map(o => `${o.name} (${o.slot})`).join(', ') });
        // 4: trades.
        if (movedTo.has(pid)) events.push({ type: 'traded_player', m: 1, who: `${movedTo.get(pid).from_team} -> ${movedTo.get(pid).to_team}` });
        for (const [tid, mv] of movedTo) {
          if (tid === pid) continue;
          const t = hist.get(tid);
          if (!t || GROUPS[t.position] !== group || group === 'QB') continue;
          const tOpp = ewma(t.games.map(g => g.opp));
          if (!(tOpp > 0)) continue;
          if (mv.to_team === team) events.push({ type: 'teammate_arrival', m: tOpp, who: t.name });
          else if (mv.from_team === team) events.push({ type: 'teammate_departure', m: tOpp, who: t.name });
        }
        // 5: realized usage change (role-changepoint.js, unchanged).
        const rc = detectRoleChange(games.map(g => ({ ...g, position })), games.filter(g => Number.isFinite(g.snap)).map(g => ({ week: g.week, offense_pct: g.snap })), week);
        if (rc) events.push({ type: rc.status === 'confirmed_role_increase' ? 'usage_rise' : 'usage_drop', m: 1, who: `${rc.prior_opportunities} -> ${rc.recent_opportunities} per game, snaps ${rc.snap_change_points > 0 ? '+' : ''}${rc.snap_change_points} pts` });
        // 6: depth chart move (this week's chart vs the previous one).
        const dNow = depthRank(week, team, h.gsis, position);
        const dwPrev = prevDepthWeek(team, week);
        const dPrev = dwPrev != null ? depthRank(dwPrev, team, h.gsis, position) : null;
        if (dNow != null && dPrev != null && dNow !== dPrev) {
          events.push({ type: dNow < dPrev ? 'depth_promotion' : 'depth_demotion', m: 1, who: `${position}${dPrev} -> ${position}${dNow}` });
        }
        // 7: snap trend (route participation is not loaded for any season; snaps stand in).
        const snaps = games.map(g => g.snap).filter(Number.isFinite);
        if (snaps.length >= 5) {
          const delta = mean(snaps.slice(-3)) - mean(snaps);
          if (delta >= 0.10) events.push({ type: 'snap_trend_up', m: delta, who: `${(100 * delta).toFixed(0)} pts` });
          else if (delta <= -0.10) events.push({ type: 'snap_trend_down', m: delta, who: `${(100 * delta).toFixed(0)} pts` });
        }
        // 8: red-zone role.
        const rzShares = games.filter(g => g.rzTeam > 0).map(g => g.rz / g.rzTeam);
        if (rzShares.length >= 5) {
          const delta = mean(rzShares.slice(-3)) - mean(rzShares);
          if (delta >= 0.10) events.push({ type: 'redzone_growth', m: delta, who: `red-zone share +${(100 * delta).toFixed(0)} pts` });
        }
        // 9: coach change.
        if (ctx.coachChange) events.push({ type: 'coach_change', m: 1, who: team });
        // 11: rookie ramp.
        if (d.rookies.has(h.gsis) && week >= 9) events.push({ type: 'rookie_ramp', m: 1, who: 'rookie' });
        // 12: news role report, counted only when his measured share actually moved the same way.
        for (const s of newsSignals?.get(pid) ?? []) {
          const moved = opps.at(-1) - base;
          if (Number.isFinite(s.role_delta) && Math.sign(s.role_delta) === Math.sign(moved) && Math.abs(moved) >= 1) {
            events.push({ type: 'news_role', m: 1, who: `role report ${s.role_delta > 0 ? 'up' : 'down'}; last game ${opps.at(-1)} vs ${base.toFixed(1)} EWMA` });
          }
        }

        // Context covariates (both sides of the matchup), all strictly prior or pre-kickoff.
        const line = d.lines.get(`${week}|${team}`) ?? {};
        const tv = teamOpp.get(`${team}|${group}`) ?? [];
        const tw = pace.get(team) ?? [];
        const oppTeam = now?.opponent ?? line.opponent ?? null;
        const allowedList = oppTeam ? allowed.get(`${oppTeam}|${group}`) ?? [] : [];
        const boxList = oppTeam ? boxFaced.get(oppTeam) ?? [] : [];

        const row = {
          player_id: pid, gsis_id: h.gsis, name: h.name, season, week, team, position, group,
          played: !!now,
          base_opp: base, base_ppr: ppr, base_eff: eff, prior_games: games.length, prior_opps: opps,
          events, pending,
          ctx: {
            spread: Number.isFinite(line.spread) ? line.spread : 0,
            implied: Number.isFinite(line.implied_points) ? line.implied_points : 22,
            team_opp: tv.length ? ewma(tv) : null,
            pace: tw.length ? ewma(tw.map(x => x.plays)) : null,
            pass_rate: tw.length ? ewma(tw.map(x => x.pass_rate)) : null,
            opp_allowed: allowedList.length ? ewma(allowedList) : null,
            opp_box: boxList.length ? ewma(boxList) : null,
            self_questionable: pSelf > 0 && pSelf < OUT_THRESHOLD ? pSelf : 0
          }
        };
        if (now) {
          const next = [week, week + 1, week + 2].map(w => oppAt.get(`${pid}|${w}`)).filter(v => v != null);
          row.opp1 = opportunityCount(now);
          row.opp3 = mean(next);
          row.ppr1 = pprPoints(now);
          row.eff1 = row.opp1 > 0 ? row.ppr1 / row.opp1 : null;
        }
        out.push(row);
      }
    }

    // ---- the graded week joins the history only now
    const totals = new Map(), rzTot = new Map();
    for (const r of weekRows) {
      const k = `${r.team}|${GROUPS[r.position]}`;
      totals.set(k, (totals.get(k) ?? 0) + opportunityCount(r));
      rzTot.set(r.team, (rzTot.get(r.team) ?? 0) + (d.rz.get(`${week}|${r.gsis_id}`) ?? 0));
    }
    const teamsThisWeek = new Set(weekRows.map(r => r.team));
    for (const t of teamsThisWeek) {
      if (!teamGames.has(t)) teamGames.set(t, []);
      teamGames.get(t).push(week);
    }
    for (const [k, v] of totals) {
      if (!teamOpp.has(k)) teamOpp.set(k, []);
      teamOpp.get(k).push(v);
      const [team, group] = k.split('|');
      const opp = weekRows.find(r => r.team === team)?.opponent;
      if (opp) {
        const ak = `${opp}|${group}`;
        if (!allowed.has(ak)) allowed.set(ak, []);
        allowed.get(ak).push(v);
      }
    }
    for (const r of weekRows) {
      if (!hist.has(r.player_id)) {
        hist.set(r.player_id, { games: [], team: r.team, position: r.position, gsis: r.gsis_id, name: r.name });
      }
      const h = hist.get(r.player_id);
      h.team = r.team;
      h.position = r.position;
      h.games.push({ week, team: r.team, opp: opportunityCount(r), ppr: pprPoints(r),
        snap: Number.isFinite(r.offense_pct) ? r.offense_pct : NaN,
        rz: d.rz.get(`${week}|${r.gsis_id}`) ?? 0, rzTeam: rzTot.get(r.team) ?? 0,
        attempts: r.attempts, carries: r.carries, targets: r.targets });
    }
    for (const t of teamsThisWeek) {
      const tw = d.teamWeek.get(`${week}|${t}`);
      if (tw && Number.isFinite(tw.plays)) {
        if (!pace.has(t)) pace.set(t, []);
        pace.get(t).push({ plays: tw.plays, pass_rate: num(tw.pass_rate) });
      }
      const b = d.box.get(`${week}|${t}`);
      if (Number.isFinite(b)) {
        if (!boxFaced.has(t)) boxFaced.set(t, []);
        boxFaced.get(t).push(b);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- measurement

const BASE_OF = { opp1: 'base_opp', opp3: 'base_opp', ppr1: 'base_ppr', eff1: 'base_eff' };
/** The outcome's residual against the EWMA baseline, or null when either side is missing. */
export function residual(row, outcome) {
  const y = row[outcome], b = row[BASE_OF[outcome]];
  return Number.isFinite(y) && Number.isFinite(b) ? y - b : null;
}
/** Summed magnitude of one event type on a row (0 when absent). */
export const magnitude = (row, type) => row.events.reduce((s, e) => s + (e.type === type ? e.m : 0), 0);

function xorshift(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];

/** Slope of y on x with an intercept, from sufficient statistics. */
function slope(S) {
  const vx = S.xx - S.x * S.x / S.n;
  return S.n > 1 && vx > 1e-12 ? (S.xy - S.x * S.y / S.n) / vx : null;
}
const addStats = (a, b) => ({ n: a.n + b.n, x: a.x + b.x, y: a.y + b.y, xx: a.xx + b.xx, xy: a.xy + b.xy });
const ZERO = Object.freeze({ n: 0, x: 0, y: 0, xx: 0, xy: 0 });

/**
 * beta (effect per unit of m) with a player-clustered bootstrap CI. Rows with no event
 * carry x = 0 and anchor the intercept, so beta is the event's shift over and above the
 * baseline's own average miss for that position group.
 */
export function fitEffect(rowsIn, type, outcome, { reps = 1000, seed = 20260924, level = 0.90 } = {}) {
  const clusters = new Map();
  let nEvent = 0;
  const eventPlayers = new Set();
  for (const r of rowsIn) {
    const y = residual(r, outcome);
    if (y == null) continue;
    const x = magnitude(r, type);
    if (x !== 0) { nEvent++; eventPlayers.add(r.player_id); }
    const c = clusters.get(r.player_id) ?? { ...ZERO };
    clusters.set(r.player_id, addStats(c, { n: 1, x, y, xx: x * x, xy: x * y }));
  }
  const list = [...clusters.values()];
  const total = list.reduce(addStats, { ...ZERO });
  const beta = slope(total);
  if (beta == null || nEvent < 10) return { beta, n: nEvent, players: eventPlayers.size, ci: null };
  const rand = xorshift(seed);
  const draws = [];
  for (let b = 0; b < reps; b++) {
    let S = { ...ZERO };
    for (let i = 0; i < list.length; i++) S = addStats(S, list[Math.floor(rand() * list.length)]);
    const v = slope(S);
    if (v != null) draws.push(v);
  }
  draws.sort((a, b) => a - b);
  const lo = (1 - level) / 2;
  return { beta, n: nEvent, players: eventPlayers.size, ci: [quantile(draws, lo), quantile(draws, 1 - lo)] };
}

/**
 * Paired absolute-error gain of `predict` over the EWMA baseline (positive = better),
 * player-clustered bootstrap CI. `rowsIn` should already be the rows the prediction touches.
 */
export function pairedGain(rowsIn, outcome, predict, { reps = 1000, seed = 20260925, level = 0.90 } = {}) {
  const clusters = new Map();
  let base = 0, model = 0, n = 0;
  for (const r of rowsIn) {
    const y = r[outcome], b = r[BASE_OF[outcome]];
    if (!Number.isFinite(y) || !Number.isFinite(b)) continue;
    const p = predict(r);
    const eb = Math.abs(y - b), em = Math.abs(y - p);
    base += eb; model += em; n++;
    const c = clusters.get(r.player_id) ?? { s: 0, n: 0 };
    c.s += eb - em; c.n++;
    clusters.set(r.player_id, c);
  }
  if (!n) return { n: 0, mae_base: null, mae_model: null, gain: null, ci: null };
  const list = [...clusters.values()];
  const rand = xorshift(seed);
  const draws = [];
  for (let b = 0; b < reps; b++) {
    let s = 0, k = 0;
    for (let i = 0; i < list.length; i++) { const c = list[Math.floor(rand() * list.length)]; s += c.s; k += c.n; }
    draws.push(s / k);
  }
  draws.sort((a, b) => a - b);
  const lo = (1 - level) / 2;
  return { n, players: list.length, mae_base: base / n, mae_model: model / n, gain: (base - model) / n,
    ci: [quantile(draws, lo), quantile(draws, 1 - lo)] };
}

/** The pre-registered gate: fit CI excludes 0 AND the out-of-sample gain CI is entirely > 0. */
export function passesGate(fit, graded) {
  return !!(fit?.ci && (fit.ci[0] > 0 || fit.ci[1] < 0) && graded?.ci && graded.ci[0] > 0);
}

/**
 * Start/sit pair accuracy on the pairs a projection change can flip: same week, same
 * position group, at least one of the two players touched. Projection = EWMA points plus
 * `shift(row)`. Ties in the actual score are skipped.
 */
export function pairAccuracy(rowsIn, shift) {
  const byKey = new Map();
  for (const r of rowsIn) {
    if (!Number.isFinite(r.ppr1) || !Number.isFinite(r.base_ppr)) continue;
    const k = `${r.season}|${r.week}|${r.group}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  let pairs = 0, before = 0, after = 0;
  for (const list of byKey.values()) {
    const s = list.map(shift);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (s[i] === 0 && s[j] === 0) continue;
        const a = list[i], b = list[j];
        if (a.ppr1 === b.ppr1) continue;
        const truth = a.ppr1 > b.ppr1;
        pairs++;
        if ((a.base_ppr > b.base_ppr) === truth) before++;
        if ((a.base_ppr + s[i] > b.base_ppr + s[j]) === truth) after++;
      }
    }
  }
  return { pairs, before: pairs ? before / pairs : null, after: pairs ? after / pairs : null };
}

// ---------------------------------------------------------------- the fitted effects

/**
 * Written by scripts/fit-opportunity-radar.mjs (fit 2021-2023, graded 2024, 2025 closed).
 * Key: `${type}|${group}`. beta is per unit of the event's magnitude m, on `opp1` (the
 * gate outcome); opp3/ppr1/eff1 carry their own betas for display. passes_gate is the
 * pre-registered decision; only those move a number.
 */
export const FITTED_EFFECTS = Object.freeze({});
export const FITTED_PROVENANCE = Object.freeze({ fit: '2021-2023', graded: '2024', script: 'scripts/fit-opportunity-radar.mjs', tree: null });

// ---------------------------------------------------------------- serving

/** Flag read per call: GRIDIRON_OPP_RADAR=1 on, =0 off (vetoes preview), else preview mode. */
export function radarFlag(env = process.env) {
  if (env[RADAR_FLAG] === '0') return { on: false };
  if (env[RADAR_FLAG] === '1') return { on: true };
  if (previewUnconfirmed()) return { on: true, ...previewFields('O1 opportunity radar: event effects measured 2021-23, graded 2024; nothing written into projections until O1c') };
  return { on: false };
}

const fmt = (v, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

/** One served event: effect for this player (beta * m), n, CI, gate, evidence. */
export function serveEvent(e, group, effects = FITTED_EFFECTS) {
  const f = effects[`${e.type}|${group}`] ?? null;
  const unit = OPP_UNIT[group];
  const effect = f && Number.isFinite(f.beta) ? f.beta * e.m : null;
  const ci = f?.ci ? [f.ci[0] * e.m, f.ci[1] * e.m].sort((a, b) => a - b) : null;
  const passes = !!f?.passes_gate;
  const direction = effect == null ? (/(out|departure|promotion|rise|up|growth)$/.test(e.type) ? 'up' : 'down') : effect >= 0 ? 'up' : 'down';
  const measured = f && effect != null
    ? `${fmt(effect)} ${unit}/game, measured on ${f.n} similar cases (${f.players} players, 2021-23), 90% CI [${fmt(ci[0])}, ${fmt(ci[1])}]`
      + (f.graded ? `; 2024 out-of-sample error change ${fmt(-f.graded.gain, 3)} per game [${fmt(-f.graded.ci[1], 3)}, ${fmt(-f.graded.ci[0], 3)}]` : '')
    : `not measurable: ${f ? `${f.n} historical cases` : 'no historical cases in 2021-23'}`;
  return {
    type: e.type, label: EVENT_TYPES[e.type]?.label ?? e.type, direction,
    effect: effect == null ? null : +effect.toFixed(2), unit: `${unit} per game`,
    n: f?.n ?? 0, ci: ci ? ci.map(v => +v.toFixed(2)) : null,
    passes_gate: passes, status: passes ? 'validated' : 'watch',
    basis: 'position-group pooled (not player-specific)',
    evidence: `${e.who}${e.p_out != null ? ` (P(out) ${e.p_out})` : ''}. ${measured}.`
      + (passes ? '' : ' Below the bar: a watch flag, not a projection change.')
  };
}

/** A radar row -> the served object. */
export function serveRow(row, effects = FITTED_EFFECTS) {
  const opportunity_events = row.events.map(e => serveEvent(e, row.group, effects));
  for (const p of row.pending) {
    opportunity_events.push({
      type: 'teammate_questionable', label: 'Same-position teammate questionable', direction: 'up',
      effect: null, unit: `${OPP_UNIT[row.group]} per game`, n: 0, ci: null, passes_gate: false, status: 'watch',
      basis: 'no bump until he clears the out threshold',
      evidence: `${p.who} is ${p.status ?? 'on the report'} (P(out) ${p.p_out} < ${OUT_THRESHOLD}); he averaged ${p.would_vacate} ${OPP_UNIT[row.group]}. No bump until ruled out, so his absence is never counted twice.`
    });
  }
  const validated = opportunity_events.filter(e => e.passes_gate && e.effect != null);
  const net = validated.reduce((s, e) => s + e.effect, 0);
  return {
    player_id: row.player_id, name: row.name, team: row.team, position: row.position, season: row.season, week: row.week,
    baseline: { value: row.base_opp == null ? null : +row.base_opp.toFixed(2), unit: `${OPP_UNIT[row.group]} per game`, basis: `EWMA (alpha ${EWMA_ALPHA}) of his own ${row.prior_games} games` },
    opportunity_events,
    net_validated_change: { value: +net.toFixed(2), unit: `${OPP_UNIT[row.group]} per game`, events: validated.length },
    projection_moved: false,
    note: validated.length
      ? 'Validated effects are served here; they reach projections only after O1c.'
      : 'No event passed the gate for this player; anything listed is a watch flag with its evidence.'
  };
}

const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

/** Newest typed role signals per player for the live week (news producer; read, never re-extracted). */
function liveNewsSignals() {
  const out = new Map();
  try {
    for (const r of rows(`SELECT player_id, role_delta, published_at FROM nfl_news_signals
                          WHERE signal_type = 'role' AND role_delta IS NOT NULL AND player_id IS NOT NULL
                            AND published_at >= datetime('now', '-10 days')`)) {
      if (!out.has(r.player_id)) out.set(r.player_id, []);
      out.get(r.player_id).push(r);
    }
  } catch { /* producer table absent */ }
  return out;
}
/** Detected roster moves in the last 14 days (player_team_changes), for the live week. */
function liveTrades() {
  const out = new Map();
  try {
    for (const r of rows(`SELECT player_id, from_team, to_team FROM player_team_changes
                          WHERE detected_at >= datetime('now', '-14 days') ORDER BY detected_at`)) {
      if (r.player_id != null && r.to_team) out.set(r.player_id, { from_team: r.from_team, to_team: r.to_team });
    }
  } catch { /* table absent */ }
  return out;
}

/** The whole served radar for one NFL week (every player with >= 2 games this season). */
export function radarWeek(season, week, { effects = FITTED_EFFECTS, now = Date.now() } = {}) {
  const k = `${season}|${week}`;
  const hit = cache.get(k);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const built = buildRadarRows(season, { startWeek: week, endWeek: week, live: true,
    newsSignals: liveNewsSignals(), trades: liveTrades() }).filter(r => r.week === week);
  const value = new Map(built.map(r => [r.player_id, serveRow(r, effects)]));
  cache.set(k, { at: now, value });
  return value;
}

/**
 * The one accessor consumers read (adapter.opportunityOf, AI-01, the waiver board, Coach):
 * null when the flag is off or the player has no radar row this week.
 */
export function opportunityOf(playerId, { season, week, env = process.env } = {}) {
  const flag = radarFlag(env);
  if (!flag.on || !Number.isInteger(season) || !Number.isInteger(week)) return null;
  const row = radarWeek(season, week).get(Number(playerId));
  if (!row) return null;
  return flag.preview ? { ...row, preview: flag.preview, preview_reason: flag.preview_reason } : row;
}

export const __test = { loadSeason, clearCache: () => cache.clear() };
