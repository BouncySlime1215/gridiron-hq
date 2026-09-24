/**
 * PROJ-04-a Monday Autopsy: the loader, the job and the store.
 *
 * For one league's own team and one completed week, every rostered QB/RB/WR/TE
 * that has a served projection (weekly_prediction_snapshots, the ledger) and a box
 * score (player_week_usage) gets his miss split into links (autopsy-links.js), each
 * start/sit call is graded decision vs luck, and the week gets a plain summary.
 * Rows go to the three 092 tables, replacing that league-week's previous rows.
 *
 * Inputs, each read once per week:
 *   started / benched  league_roster_snapshots (source 'final' preferred, else 'live')
 *   projection         weekly_prediction_snapshots.prediction (+ as_of for news timing)
 *   projected chain    PROJ-02-a `links` from buildProjections(through: season,
 *                      throughWeek: week - 1) when present (#221); otherwise the
 *                      player's and his team's prior weeks this season
 *   actual chain       player_week_usage, the player's row and his team's sums
 *   exit               player_week_snaps offense_pct vs his prior three weeks
 *   news               nfl_news_signals_current, verified role/availability signals
 *                      published after our snapshot and before his kickoff
 *   Vegas miss         game_lines spread vs final margin, carried in the script
 *                      link's detail
 *
 * When the links cannot be built the week still runs on the prior-weeks basis and
 * the stored summary says so (links_error): the surface never implies a link split
 * it did not have.
 */
import { db, rows, row } from '../db/index.js';
import { PPR, scoreLine } from './scoring.js';
import { gameCutoff } from './game-cutoff.js';
import { previewUnconfirmed, previewFields } from './preview-mode.js';
import {
  LINKS, IS_LUCK, splitMiss, stateFromLinks, stateFromUsage, sourceRight, playerLine, shareChannel,
  gradeCalls, weekSummary
} from './autopsy-links.js';

/** The league the autopsy runs for (leagues.id). */
export const AUTOPSY_LEAGUE_ID = Number(process.env.AUTOPSY_LEAGUE_ID) || 4;

/**
 * The one reader of GRIDIRON_MONDAY_AUTOPSY: switches the surface (GET
 * /api/trades/:leagueId/autopsy and the My team card), not the job, which writes
 * rows either way. Preview mode (preview-mode.js) turns it on too, labelled.
 */
export const MONDAY_AUTOPSY_ENV = 'GRIDIRON_MONDAY_AUTOPSY';
export const MONDAY_AUTOPSY_OFF_REASON =
  'Monday Autopsy card is default-off, unconfirmed forward: the link split has not been read against '
  + `a full season of box scores and the exit link is a snap-share read. Set ${MONDAY_AUTOPSY_ENV}=1 to switch it on.`;

/** Read per call, so a test or a run can flip it. */
export function mondayAutopsyFields() {
  if (process.env[MONDAY_AUTOPSY_ENV] === '1') return { enabled: true };
  if (process.env[MONDAY_AUTOPSY_ENV] === '0') return { enabled: false, reason: MONDAY_AUTOPSY_OFF_REASON };
  if (previewUnconfirmed()) return { enabled: true, ...previewFields(MONDAY_AUTOPSY_OFF_REASON) };
  return { enabled: false, reason: MONDAY_AUTOPSY_OFF_REASON };
}
const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);
const USAGE_COLS = ['attempts', 'carries', 'targets', 'receptions', 'passing_yards', 'rushing_yards',
  'receiving_yards', 'passing_tds', 'rushing_tds', 'receiving_tds', 'interceptions'];

/** PROJ-02-a links for the week, by player id. The default builder; tests inject their own. */
export async function projectionLinks(season, week) {
  if (week <= 1) return { byId: new Map(), error: 'week 1 has no in-season links' };
  const { buildProjections } = await import('./projections.js');
  const proj = buildProjections({ through: season, throughWeek: week - 1, scoring: PPR });
  const byId = new Map();
  for (const [id, p] of proj) if (p.links) byId.set(Number(id), p.links);
  return { byId, error: null };
}

function rosterFor(leagueId, season, week, teamId) {
  const base = `SELECT player_id, player_name, position, is_starter, lineup_slot, projected_points, source
    FROM league_roster_snapshots WHERE league_id=? AND season=? AND scoring_period_id=? AND team_id=?
      AND player_id IS NOT NULL AND source=?`;
  const final = rows(base, leagueId, season, week, teamId, 'final');
  return final.length ? final : rows(base, leagueId, season, week, teamId, 'live');
}

function teamTotals(season, weeks, team) {
  const got = row(`SELECT ${USAGE_COLS.map(c => `SUM(COALESCE(${c},0)) AS ${c}`).join(', ')},
      COUNT(DISTINCT week) AS games
    FROM player_week_usage WHERE season=? AND team=? AND week IN (${weeks.map(() => '?').join(',')})`,
  season, team, ...weeks);
  return got?.games ? got : null;
}

function priorWeeksState(season, week, playerId, team) {
  const weeks = rows(`SELECT DISTINCT week FROM player_week_usage WHERE season=? AND player_id=? AND week<?
    ORDER BY week`, season, playerId, week).map(r => r.week);
  if (!weeks.length || !team) return null;
  const player = row(`SELECT ${USAGE_COLS.map(c => `SUM(COALESCE(${c},0)) AS ${c}`).join(', ')}
    FROM player_week_usage WHERE season=? AND player_id=? AND week<?`, season, playerId, week);
  const tm = teamTotals(season, weeks, team);
  if (!tm) return null;
  // Per game: team totals over the same weeks, so shares and rates are unchanged.
  const perGame = o => Object.fromEntries(USAGE_COLS.map(c => [c, (o[c] ?? 0) / weeks.length]));
  return stateFromUsage(perGame(player), perGame(tm));
}

function snapRead(season, week, playerId) {
  const cur = row('SELECT offense_pct FROM player_week_snaps WHERE season=? AND week=? AND player_id=?',
    season, week, playerId)?.offense_pct;
  const prior = rows(`SELECT offense_pct FROM player_week_snaps WHERE season=? AND player_id=? AND week<?
    AND offense_pct IS NOT NULL ORDER BY week DESC LIMIT 3`, season, playerId, week).map(r => r.offense_pct);
  return { share: cur ?? null, prior: prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : null };
}

/**
 * Verified role/availability signals between our snapshot and his kickoff. Compared as
 * instants (julianday), not strings: a 'YYYY-MM-DD HH:MM:SS' stamp sorts before an ISO
 * 'YYYY-MM-DDTHH:MM:SSZ' one on the same day whatever the hour.
 */
function newsMissed(playerId, asOf, kickoff) {
  if (!asOf || !kickoff) return [];
  return rows(`SELECT news_id, signal_type, status, role_delta, published_at FROM nfl_news_signals_current
    WHERE player_id=? AND verification_state='verified' AND signal_type IN ('role','availability')
      AND julianday(published_at) > julianday(?) AND julianday(published_at) < julianday(?)`,
  String(playerId), asOf, kickoff);
}

function vegasRead(season, week, team) {
  const g = row(`SELECT spread, total, team_score, opp_score FROM game_lines WHERE season=? AND week=? AND team=?`,
    season, week, team);
  if (!g || g.spread == null) return null;
  const margin = g.team_score != null && g.opp_score != null ? g.team_score - g.opp_score : null;
  return { spread: g.spread, total: g.total, final_margin: margin,
    vegas_off: margin == null ? null : margin + g.spread };
}

/** One player-week, split. Null when there is no served projection or no box score. */
function autopsyPlayer({ season, week, rp, links }) {
  const snap = row(`SELECT prediction, as_of FROM weekly_prediction_snapshots WHERE season=? AND week=? AND player_id=?`,
    season, week, rp.player_id);
  const usage = row('SELECT * FROM player_week_usage WHERE season=? AND week=? AND player_id=?',
    season, week, rp.player_id);
  if (!snap || !usage) return null;
  const actual = scoreLine(usage, PPR);
  const team = usage.team;
  const teamNow = team ? teamTotals(season, [week], team) : null;
  let projected = links ? stateFromLinks(links) : null;
  let basis = projected ? 'links' : null;
  const prior = priorWeeksState(season, week, rp.player_id, team);
  if (!projected && prior) { projected = prior; basis = 'prior_weeks'; }
  const actualState = teamNow ? stateFromUsage(usage, teamNow, projected) : null;
  const kickoff = team ? gameCutoff(season, week, team) : null;
  const news = newsMissed(rp.player_id, snap.as_of, kickoff);
  const snaps = snapRead(season, week, rp.player_id);
  const split = splitMiss({ projection: snap.prediction, actual, projected, actualState, snaps, newsMissed: news });
  if (!split.basisOk) basis = 'none';
  const miss = actual - snap.prediction;
  const name = rp.player_name ?? `player ${rp.player_id}`;
  return {
    id: rp.player_id, name, position: rp.position, is_starter: rp.is_starter ? 1 : 0,
    projection: snap.prediction, actual, miss, espn: rp.projected_points, basis,
    links: split.links, exit: split.exit, news, vegas: team ? vegasRead(season, week, team) : null,
    source_right: sourceRight(snap.prediction, rp.projected_points, actual),
    line: playerLine(name, miss, split.links, { channel: shareChannel(projected) })
  };
}

function detailFor(link, p) {
  if (link === 'script') return p.vegas;
  if (link === 'exit') return { modelled: p.exit.modelled, detected: p.exit.detected, scale: p.exit.scale };
  if (link === 'news_missed') return p.news.length ? { signals: p.news } : null;
  return null;
}

function store({ leagueId, season, week, teamId, players, calls, summary, linksError, now }) {
  const insLink = db.prepare(`INSERT INTO projection_autopsy
    (league_id,season,week,player_id,link,points,is_luck,source_right,detail_json,computed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insPlayer = db.prepare(`INSERT INTO projection_autopsy_player
    (league_id,season,week,player_id,team_id,is_starter,position,projected,actual,miss,espn_projected,basis,line,computed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.exec('BEGIN');
  try {
    for (const t of ['projection_autopsy', 'projection_autopsy_player', 'projection_autopsy_week']) {
      db.prepare(`DELETE FROM ${t} WHERE league_id=? AND season=? AND week=?`).run(leagueId, season, week);
    }
    for (const p of players) {
      insPlayer.run(leagueId, season, week, p.id, teamId, p.is_starter, p.position, p.projection, p.actual,
        p.miss, p.espn ?? null, p.basis, p.line, now);
      for (const link of LINKS) {
        const d = detailFor(link, p);
        insLink.run(leagueId, season, week, p.id, link, p.links[link], IS_LUCK[link], p.source_right,
          d == null ? null : JSON.stringify(d), now);
      }
    }
    db.prepare(`INSERT INTO projection_autopsy_week
      (league_id,season,week,team_id,summary,calls_json,totals_json,links_error,computed_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(leagueId, season, week, teamId, summary.text, JSON.stringify(calls),
        JSON.stringify({ totals: summary.totals, projected: summary.projected, actual: summary.actual, luck: summary.luck }),
        linksError, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Autopsy one league-week and store it.
 * @param linksFor async (season, week) => { byId: Map<playerId, links>, error }
 */
export async function runMondayAutopsy({ leagueId = AUTOPSY_LEAGUE_ID, season, week,
  linksFor = projectionLinks, now = new Date().toISOString() } = {}) {
  const lg = row('SELECT id, my_team_id FROM leagues WHERE id=?', leagueId);
  if (!lg) return { ok: false, reason: `league ${leagueId} not found` };
  const teamId = Number(lg.my_team_id);
  if (!Number.isFinite(teamId)) return { ok: false, reason: `league ${leagueId} has no my_team_id` };
  const roster = rosterFor(leagueId, season, week, teamId).filter(r => SCORED.has(r.position));
  if (!roster.length) return { ok: false, reason: `no roster snapshot for ${season} week ${week}` };
  if (!row('SELECT 1 FROM player_week_usage WHERE season=? AND week=? LIMIT 1', season, week)) {
    return { ok: false, reason: `no box scores for ${season} week ${week} yet` };
  }
  let links = { byId: new Map(), error: null };
  try {
    links = await linksFor(season, week);
  } catch (error) {
    // Surfaced, not swallowed: the week runs on prior weeks and the stored summary names the cause.
    links = { byId: new Map(), error: error.message };
  }
  const players = roster
    .map(rp => autopsyPlayer({ season, week, rp, links: links.byId.get(Number(rp.player_id)) ?? null }))
    .filter(Boolean);
  const started = players.filter(p => p.is_starter);
  const calls = gradeCalls(started, players.filter(p => !p.is_starter));
  const summary = weekSummary({ week, started, calls, linksError: links.error });
  store({ leagueId, season, week, teamId, players, calls, summary, linksError: links.error, now });
  return { ok: true, league_id: leagueId, season, week, players: players.length, starters: started.length,
    link_rows: players.length * LINKS.length, calls: calls.length, summary: summary.text, links_error: links.error };
}

/** The stored autopsy for a league-week, for weekPostmortem and any card. */
export function storedAutopsy(leagueId, season, week) {
  const wk = row('SELECT * FROM projection_autopsy_week WHERE league_id=? AND season=? AND week=?', leagueId, season, week);
  if (!wk) return null;
  const links = rows(`SELECT player_id, link, points, is_luck FROM projection_autopsy
    WHERE league_id=? AND season=? AND week=?`, leagueId, season, week);
  const players = rows(`SELECT * FROM projection_autopsy_player WHERE league_id=? AND season=? AND week=?
    ORDER BY is_starter DESC, miss`, leagueId, season, week).map(p => ({
    ...p, links: Object.fromEntries(links.filter(l => l.player_id === p.player_id).map(l => [l.link, l.points]))
  }));
  const team = teamSplit({ leagueId, season, week, teamId: wk.team_id, players });
  return { summary: team.line ? `${team.line} ${wk.summary}` : wk.summary, player_summary: wk.summary,
    team, calls: JSON.parse(wk.calls_json), totals: JSON.parse(wk.totals_json),
    links_error: wk.links_error, computed_at: wk.computed_at, players };
}

const hasTable = name => !!row(`SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?`, name);
const sumBy = (list, f) => list.reduce((s, x) => s + f(x), 0);

/**
 * The team-level decision-vs-luck number for the week, from AUTOPSY-01's
 * weekly_autopsy (#295; the table EVAL E7 grades). This module's per-player links
 * are the drill-down under it and do not produce a second team split.
 *
 * The two sit on different bases: weekly_autopsy uses ESPN's pregame projection in
 * the league's own scoring over every starter (K and D/ST too); the links use our
 * served projection in PPR over the QB/RB/WR/TE starters we could score. So the
 * reconciliation is two labelled basis rows, and it is exact:
 *
 *   team luck = sum(starters' link points) + actual_basis_gap - expected_basis_gap
 *
 *   actual_basis_gap    team actual (league scoring, all starters) - our starters' PPR actual
 *   expected_basis_gap  team pregame expected (ESPN)               - our starters' served projection
 *
 * No weekly_autopsy row (table absent, #295 not run, or the week not built) leaves
 * the team number null with the reason; the links are then still shown, labelled as
 * our basis only.
 */
/** The team's start/sit grade from weekly_autopsy's decision_points (<= 0). */
export function lineupGrade(decision) {
  if (decision == null) return null;
  if (Math.abs(decision) < 0.05) return 'best lineup by pregame projection';
  return `lineup gave up ${Math.abs(decision).toFixed(1)} by pregame projection`;
}

export function teamSplit({ leagueId, season, week, teamId, players }) {
  const started = players.filter(p => p.is_starter);
  const own = {
    starters: started.length,
    actual: sumBy(started, p => p.actual),
    projected: sumBy(started, p => p.projected),
    luck_links: sumBy(started, p => Object.entries(p.links).reduce((s, [l, v]) => s + (IS_LUCK[l] ? v : 0), 0)),
    knowable_links: sumBy(started, p => Object.entries(p.links).reduce((s, [l, v]) => s + (IS_LUCK[l] ? 0 : v), 0))
  };
  const none = reason => ({ source: null, reason, decision_points: null, luck_points: null, line: null,
    reconciliation: null, own_basis: own });
  if (!hasTable('weekly_autopsy')) return none('weekly_autopsy table absent (AUTOPSY-01, #295, not migrated)');
  const wa = row(`SELECT actual_points, expected_points, optimal_expected_points, decision_points, luck_points,
      projection_basis, status, line FROM weekly_autopsy WHERE league_id=? AND season=? AND week=? AND team_id=?`,
  leagueId, season, week, teamId);
  if (!wa) return none(`weekly_autopsy has no row for ${season} week ${week}`);
  const actualGap = wa.actual_points - own.actual;
  const expectedGap = wa.expected_points - own.projected;
  const rowsOut = [
    { key: 'luck_links', label: 'luck links, our starters (PPR, served projection)', points: own.luck_links },
    { key: 'knowable_links', label: 'knowable links, our starters (PPR, served projection)', points: own.knowable_links },
    { key: 'actual_basis_gap', label: 'basis: team actual in league scoring (all starters) minus our starters\' PPR actual',
      points: actualGap },
    { key: 'expected_basis_gap', label: `basis: our served projection minus ${wa.projection_basis} expected`,
      points: -expectedGap }
  ];
  const total = sumBy(rowsOut, r => r.points);
  return {
    source: 'weekly_autopsy', reason: null, projection_basis: wa.projection_basis, status: wa.status,
    decision_points: wa.decision_points, luck_points: wa.luck_points,
    actual_points: wa.actual_points, expected_points: wa.expected_points,
    line: wa.line, lineup_grade: lineupGrade(wa.decision_points),
    reconciliation: { rows: rowsOut, total, team_luck: wa.luck_points, residual: total - wa.luck_points },
    own_basis: own
  };
}

/**
 * The season so far, per link, over our starters' stored weeks: total points, luck vs
 * knowable, the knowable link that failed most (largest total |points|), and which
 * projection sat closer to the actual most often. `source_right` is a per player-week
 * verdict (the same on each of his link rows), so it is counted once per player-week.
 */
export function seasonRollup(leagueId, season, throughWeek = null) {
  const wk = throughWeek == null ? '' : 'AND a.week <= ?';
  const args = throughWeek == null ? [leagueId, season] : [leagueId, season, throughWeek];
  const perLink = rows(`SELECT a.link, a.is_luck, SUM(a.points) AS points, SUM(ABS(a.points)) AS abs_points,
      COUNT(*) AS n
    FROM projection_autopsy a JOIN projection_autopsy_player p
      ON p.league_id=a.league_id AND p.season=a.season AND p.week=a.week AND p.player_id=a.player_id
    WHERE a.league_id=? AND a.season=? AND p.is_starter=1 ${wk}
    GROUP BY a.link, a.is_luck`, ...args);
  const weeks = rows(`SELECT DISTINCT week FROM projection_autopsy_week a WHERE league_id=? AND season=? ${wk}
    ORDER BY week`, ...args).map(r => r.week);
  const sources = rows(`SELECT a.source_right AS src, COUNT(*) AS n FROM (
      SELECT DISTINCT a.week, a.player_id, a.source_right FROM projection_autopsy a JOIN projection_autopsy_player p
        ON p.league_id=a.league_id AND p.season=a.season AND p.week=a.week AND p.player_id=a.player_id
      WHERE a.league_id=? AND a.season=? AND p.is_starter=1 AND a.source_right IS NOT NULL ${wk}) a
    GROUP BY a.source_right`, ...args);
  const links = Object.fromEntries(LINKS.map(l => {
    const r = perLink.find(x => x.link === l);
    return [l, { points: r?.points ?? 0, abs_points: r?.abs_points ?? 0, is_luck: IS_LUCK[l] }];
  }));
  const luck = sumBy(LINKS.filter(l => IS_LUCK[l]), l => links[l].points);
  const knowable = sumBy(LINKS.filter(l => !IS_LUCK[l]), l => links[l].points);
  const luckAbs = sumBy(LINKS.filter(l => IS_LUCK[l]), l => links[l].abs_points);
  const knowableAbs = sumBy(LINKS.filter(l => !IS_LUCK[l]), l => links[l].abs_points);
  const failing = LINKS.filter(l => !IS_LUCK[l] && links[l].abs_points > 0)
    .sort((a, b) => links[b].abs_points - links[a].abs_points)[0] ?? null;
  const counts = Object.fromEntries(['ours', 'espn', 'tie'].map(k => [k, sources.find(s => s.src === k)?.n ?? 0]));
  const top = Math.max(counts.ours, counts.espn);
  const mostRight = counts.ours + counts.espn === 0 ? null
    : counts.ours === counts.espn ? 'even' : counts.ours === top ? 'ours' : 'espn';
  return {
    season, weeks, links, total: luck + knowable, luck, knowable,
    luck_share: luckAbs + knowableAbs > 0 ? luckAbs / (luckAbs + knowableAbs) : null,
    most_failing_knowable: failing ? { link: failing, ...links[failing] } : null,
    source_right: { ...counts, most_often: mostRight }
  };
}

/** The route's answer: the week (latest stored when none given) plus the season rollup. */
export function autopsyView(leagueId, season, week = null) {
  const w = week ?? row('SELECT MAX(week) AS w FROM projection_autopsy_week WHERE league_id=? AND season=?',
    leagueId, season)?.w ?? null;
  const stored = w == null ? null : storedAutopsy(leagueId, season, w);
  return { league_id: leagueId, season, week: w, autopsy: stored, rollup: seasonRollup(leagueId, season, w) };
}

/**
 * The scheduler's entry: the latest week with box scores that is not stored yet.
 * Box scores for a Monday-night game land after Monday, so this runs daily and
 * writes the week once its data is in; a stored week is not recomputed.
 */
export async function refreshMondayAutopsy({ leagueId = AUTOPSY_LEAGUE_ID,
  season = Number(process.env.NFL_SEASON) || new Date().getFullYear(), linksFor } = {}) {
  const latest = row('SELECT MAX(week) AS w FROM player_week_usage WHERE season=?', season)?.w;
  if (!latest) return { ok: false, reason: `no ${season} box scores yet` };
  if (row('SELECT 1 FROM projection_autopsy_week WHERE league_id=? AND season=? AND week=?', leagueId, season, latest)) {
    return { ok: true, skipped: true, reason: `${season} week ${latest} already stored` };
  }
  return runMondayAutopsy({ leagueId, season, week: latest, ...(linksFor ? { linksFor } : {}) });
}
