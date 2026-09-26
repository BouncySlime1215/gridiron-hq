#!/usr/bin/env node
/**
 * SEASON-REPLAY (plan item 30): an as-of replay of past 2026 weeks in every ESPN league Nick
 * plays, grading the War Room planner against simple baselines (E4 retro). Study harness:
 * nothing served reads this file or its output, and it runs only with GRIDIRON_SEASON_REPLAY=1.
 *
 * It is E4 (scripts/eval/e4-planner-replay.mjs) pointed at Nick's own leagues: the same arms,
 * the same study simulator, the same realized-outcome rule and the same grader
 * (server/services/eval/e4-planner.js#summarize / #verdict). What it adds is the as-of read.
 *
 * ============================ BITEMPORAL READ ============================
 * Decision week W, cutoff T = the first NFL kickoff date of week W (schedule_games.date, the
 * start of that UTC day when only a date is stored: earlier than kickoff, so stricter).
 * Valid time (what the fact is about) is enforced row by row; nothing about week >= W is read:
 *   rosters     league_roster_snapshots 'final' rows of period W-1, on_roster = 1 (the lineups
 *               ESPN boxscored for the last completed period). Waiver adds between that period's
 *               last game and T are not seen (an approximation, stated in the output).
 *   player value  as-of points per game from 'final' actual_points of periods < W, shrunk to the
 *               mean ESPN projection of those same periods (PRIOR_K games, the E4 / R19 shape).
 *               Projections of period W itself are NOT read: they sit in period-W rows, which
 *               are written after T.
 *   standings   team scores = starters' actual_points in 'final' rows of periods < W (the sum
 *               the collector checks against ESPN's own total).
 *   schedule    opponents from leagues.payload.schedule (fixed before the season starts).
 *   byes        players.bye_week (fixed before the season starts).
 * Observed time (when this machine had the row) is recorded, not trusted: a row used at W whose
 * changed_at is after T was backfilled (week 1 was, on 2026-09-18). Such a week is marked
 * provenance 'reconstructed'; every other week 'captured'. --strict drops reconstructed weeks.
 *
 * ============================ PRE-REGISTRATION ============================
 * Written before any league data is read (the cloud thread has no database).
 * Sample. Every ESPN league in `leagues` for the season whose rules read cleanly
 *   (league-rules.js#simRulesProblem clean, one-week playoff rounds, 4, 6 or 8 playoff teams, no median
 *   game, no division-winner seeding; a fixed, non-reseeded bracket is played reseeded and flagged); Nick's team (leagues.my_team_id); decision weeks W from 2 to the
 *   last regular week before the playoffs whose period W-1 is final. A league outside that
 *   format is listed under skipped with its reason, never silently dropped.
 * Arms. planner = planLeague on the as-of adapter (its own never-give / never-get filter,
 *   campaign/never-give.js#withNeverGive); finder and greedy = the E4 proxies with the pinned
 *   ids removed from both sides (PINNED_NEVER_GIVE never offered, PINNED_NEVER_GET never taken);
 *   nothing = 0. Acceptance: E4's assumed curve, the same for every arm.
 * Metric (primary). Realized title gain vs doing nothing, expected over accept/decline, per
 *   league-week, once the season is complete (every regular and playoff period final).
 *   Co-reported, never a verdict: realized starter points per week over the weeks already
 *   played after W (the interim number while the season runs); made-playoffs; if-completed.
 * Pass bar. Planner minus the BEST baseline (highest mean on the graded rows), league-clustered
 *   bootstrap 95% CI (2,000 reps, seed 404): lower bound > 0 -> passing, upper < 0 -> failing,
 *   else not_enough_data. Fewer than MIN_LEAGUES complete leagues -> not_enough_data whatever
 *   the CI says.
 * Power, said up front: five leagues are five clusters and a title is 0 or 1 per league, so the
 *   likeliest 2026 verdict is not_enough_data. The harness exists so the answer, when it comes,
 *   is leak-free and the same code grades 2027.
 * =========================================================================
 *
 * Usage (on the Mac, against a copy):
 *   sqlite3 -readonly ~/gridiron-local/data/gridiron.sqlite ".backup /tmp/replay.sqlite"
 *   GRIDIRON_SEASON_REPLAY=1 node scripts/eval/season-replay.mjs --db /tmp/replay.sqlite \
 *        --season 2026 [--leagues 1,2,3,4,5] [--weeks 2-13] [--runs 400] [--strict] \
 *        --out ~/gridiron-local/rnd/season-replay-2026.json
 * Importing this file runs nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as e4 from '../../server/services/eval/e4-planner.js';
import { leagueRules, simRulesProblem } from '../../server/services/league-rules.js';
import { PINNED_NEVER_GIVE, PINNED_NEVER_GET } from '../../server/services/campaign/never-give.js';
import {
  RUNS, SEED, ACCEPT, hash32, prepareLeague, makeAdapter, realized, realizedGain,
  counterfactual, applyStep, finderMove, greedyMove,
} from './e4-planner-replay.mjs';

export const SEASON_REPLAY_ENV = 'GRIDIRON_SEASON_REPLAY';
export const seasonReplayEnabled = (env = process.env) => env[SEASON_REPLAY_ENV] === '1';
/** Games of prior weight in the as-of value (E4 / R19: k = 3). */
export const PRIOR_K = 3;
export const MIN_LEAGUES = 5;
export const PLAYOFF_TEAMS_OK = Object.freeze([4, 6, 8]);
export const PASS_BAR = `${e4.PASS_BAR}; Nick's 2026 leagues as of each past week, at least ${MIN_LEAGUES} complete leagues`;
/** ESPN slot names the E4 lineup does not know, mapped to the one it does. */
const SLOT_ALIAS = Object.freeze({ OP: 'SUPER_FLEX' });
const SK = new Set(['QB', 'RB', 'WR', 'TE']);
export const BLOCKED = Object.freeze({ give: new Set(PINNED_NEVER_GIVE), get: new Set(PINNED_NEVER_GET) });

const ms = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

/** Decision cutoff per week: the earliest schedule_games.date of that week, as epoch ms. */
export function weekCutoffs(scheduleRows) {
  const out = new Map();
  for (const r of scheduleRows) {
    const t = ms(r.date);
    if (t == null || r.week == null) continue;
    const w = Number(r.week);
    if (!out.has(w) || t < out.get(w)) out.set(w, t);
  }
  return out;
}

/** Why a league's rules keep it out of the sample, or null when they fit. */
export function formatProblem(rules) {
  const sim = simRulesProblem(rules);
  if (sim) return sim.error;
  const s = rules.schedule ?? {};
  if (!PLAYOFF_TEAMS_OK.includes(s.playoff_teams)) return `playoff teams ${s.playoff_teams} (replay supports 4, 6, 8)`;
  if (s.playoff_round_length !== 1) return `playoff rounds of ${s.playoff_round_length} weeks (replay scores one-week rounds)`;
  if (rules.median_game === true) return 'median game (E4 standings play head-to-head only)';
  if (rules.seeding?.division_winners_first) return 'division winners seeded first (E4 seeds by wins, then points)';
  return null;
}

/** Opponent per (team, week) from an ESPN payload's schedule: Map `${team}:${week}` -> team. */
export function opponents(payload) {
  const out = new Map();
  for (const m of payload?.schedule ?? []) {
    const w = Number(m.matchupPeriodId), h = m.home?.teamId, a = m.away?.teamId;
    if (!Number.isFinite(w) || h == null || a == null) continue;
    out.set(`${h}:${w}`, String(a));
    out.set(`${a}:${w}`, String(h));
  }
  return out;
}

/**
 * The as-of player value after weeks 1..k: points per game over played weeks (actual > 0),
 * shrunk to the mean ESPN projection of the same weeks with PRIOR_K games of weight.
 * games: [{ week, actual, projected }] from 'final' rows only. Weeks > k are never read.
 */
export function asOfValue(games, k, priorK = PRIOR_K) {
  const seen = games.filter(g => g.week <= k);
  const proj = seen.map(g => Number(g.projected)).filter(Number.isFinite);
  const prior = proj.length ? proj.reduce((s, x) => s + x, 0) / proj.length : null;
  const played = seen.map(g => Number(g.actual)).filter(x => Number.isFinite(x) && x > 0);
  if (!played.length) return prior ?? 0;
  const ppg = played.reduce((s, x) => s + x, 0) / played.length;
  if (prior == null) return ppg;
  return (played.length * ppg + priorK * prior) / (played.length + priorK);
}

/**
 * One league-season in E4's export shape (prepareLeague's L), from 'final' snapshot rows only.
 * snaps: league_roster_snapshots rows (source 'final'); byes: Map player_id -> bye week;
 * opp: opponents(payload); rules: leagueRules(lg); slots: the league's lineup slots.
 * pl[id] = [pos, bye, pred[], pts[]]: pred[k] = asOfValue after weeks 1..k, pts[w] = week w points.
 * tw[team][w-1] = [team score, opponent, roster ids at the end of period w] (future weeks: [null, opp, []]).
 */
export function exportLeague({ leagueId, season, snaps, byes, opp, rules, slots }) {
  const nReg = rules.schedule.regular_season_weeks;
  const lastWeek = nReg + rules.schedule.playoff_rounds * rules.schedule.playoff_round_length;
  const finals = snaps.filter(r => r.source === 'final' && r.player_id != null);
  const skippedNoId = snaps.filter(r => r.source === 'final' && r.player_id == null).length;
  const teams = [...new Set(finals.map(r => String(r.team_id)))].sort((a, b) => Number(a) - Number(b));
  const finalWeeks = [...new Set(finals.map(r => Number(r.scoring_period_id)))].sort((a, b) => a - b);
  const byPlayer = new Map();
  for (const r of finals) {
    const id = String(r.player_id);
    if (!byPlayer.has(id)) byPlayer.set(id, { pos: r.position, weeks: new Map() });
    const p = byPlayer.get(id);
    const w = Number(r.scoring_period_id);
    // One player, one week: his own points, whichever roster the boxscore shows him on.
    if (!p.weeks.has(w)) p.weeks.set(w, { week: w, actual: r.actual_points, projected: r.projected_points });
  }
  const pl = {};
  for (const [id, p] of byPlayer) {
    if (!SK.has(p.pos)) continue;
    const games = [...p.weeks.values()];
    const pred = Array.from({ length: lastWeek + 1 }, (_, k) => asOfValue(games, k));
    const pts = Array.from({ length: lastWeek + 1 }, (_, w) => Number(p.weeks.get(w)?.actual) || 0);
    pl[id] = [p.pos, byes.get(id) ?? null, pred, pts];
  }
  const tw = {};
  for (const t of teams) {
    tw[t] = Array.from({ length: lastWeek }, (_, i) => {
      const w = i + 1;
      const rows = finals.filter(r => String(r.team_id) === t && Number(r.scoring_period_id) === w);
      if (!rows.length) return [null, opp.get(`${t}:${w}`) ?? null, []];
      const score = rows.filter(r => r.is_starter === 1).reduce((s, r) => s + (Number(r.actual_points) || 0), 0);
      const roster = rows.filter(r => r.on_roster === 1).map(r => String(r.player_id));
      return [Math.round(score * 100) / 100, opp.get(`${t}:${w}`) ?? null, roster];
    });
  }
  return {
    lid: `espn:${leagueId}:${season}`, season, rids: teams, nt: teams.length, pws: nReg + 1, pt: rules.schedule.playoff_teams,
    slots: slots.map(s => SLOT_ALIAS[s] ?? s), pl, tw, made: {}, champ: {},
    final_weeks: finalWeeks, last_week: lastWeek, skipped_no_player_id: skippedNoId,
  };
}

/**
 * The observed-time audit for decision week W: every 'final' row of periods < W that the
 * replay reads, and how many of them this machine wrote after the cutoff.
 */
export function provenance(snaps, week, cutoffMs) {
  const used = snaps.filter(r => r.source === 'final' && Number(r.scoring_period_id) < week);
  const late = cutoffMs == null ? used.length : used.filter(r => !(ms(r.changed_at) <= cutoffMs)).length;
  return { rows: used.length, observed_after_cutoff: late, provenance: late === 0 && cutoffMs != null ? 'captured' : 'reconstructed' };
}

/**
 * Realized starter points of `me` over played weeks C.dw..lastWeek vs doing nothing, per week,
 * expected over accept/decline (same curve as realizedGain), and if every step is accepted.
 */
export function realizedPoints(C, me, steps, lastWeek) {
  const weeks = Math.max(0, lastWeek - C.dw + 1);
  if (!steps?.length || !weeks) return { points: 0, points_done: 0, weeks };
  const gain = state => {
    const { rule, cfRoster } = counterfactual(C, state);
    let s = 0;
    for (let w = C.dw; w <= lastWeek; w++) s += rule(cfRoster(me, w), w) - rule(C.roster(me, w), w);
    return s / weeks;
  };
  let state = new Map(C.base), reach = 1, e = 0, done = 0;
  for (let i = 0; i <= steps.length; i++) {
    const g = i === 0 ? 0 : gain(state);
    e += (i < steps.length ? reach * (1 - steps[i].p) : reach) * g;
    if (i === steps.length) { done = g; break; }
    reach *= steps[i].p;
    state = applyStep(state, me, steps[i]);
  }
  return { points: e, points_done: done, weeks };
}

/** Pinned ids on the wrong side of any step (must be [] for every arm; the rule test). */
export function ruleBreaks(steps, blocked = BLOCKED) {
  const out = [];
  for (const st of steps ?? []) {
    for (const id of st.give) if (blocked.give.has(String(id))) out.push(`gives ${id}`);
    for (const id of st.get) if (blocked.get.has(String(id))) out.push(`gets ${id}`);
  }
  return out;
}

const stepIds = steps => (steps ?? []).map(s => ({ partner: String(s.team), give: s.give.map(String), get: s.get.map(String), p: s.p }));

/**
 * Replay one league-season at each decision week. L: exportLeague's shape; me: Nick's team id.
 * complete: every regular and playoff period is final (then the title metric is graded).
 */
export function replayWeeks(L, { me, weeks, cutoffs, snaps, planner, runs = RUNS, strict = false }) {
  const rows = [];
  const lastFinal = Math.max(0, ...L.final_weeks);
  const complete = L.final_weeks.length >= L.last_week;
  for (const W of weeks) {
    if (!L.final_weeks.includes(W - 1)) { rows.push({ week: W, skipped: `period ${W - 1} not final` }); continue; }
    const audit = provenance(snaps, W, cutoffs.get(W) ?? null);
    if (strict && audit.provenance !== 'captured') { rows.push({ week: W, skipped: 'reconstructed inputs (--strict)', audit }); continue; }
    const C = prepareLeague(L, { decisionWeek: W });
    if (!C.base.get(String(me))?.length) { rows.push({ week: W, skipped: `team ${me} has no week-${W - 1} roster` }); continue; }
    const t0 = Date.now();
    const leagueKey = `L${hash32('replay', L.lid).toString(16)}`;
    const adapter = makeAdapter(C, String(me), { runs, leagueKey });
    const res = planner.planLeague(adapter, { objective: planner.objective, skips: { player: new Map(), manager: new Map() },
      previous: null, budget: { flipTopPer: 0 } });
    if (res.error) { rows.push({ week: W, error: String(res.error), audit }); continue; }
    const arms = {
      planner: res.best && res.best.expected > 0 ? res.best.steps : [],
      finder: finderMove(C, adapter, String(me), adapter.world(adapter.seed), { blocked: BLOCKED }).move,
      greedy: greedyMove(C, adapter, String(me), { blocked: BLOCKED }).move,
    };
    const breaks = Object.fromEntries(Object.entries(arms).map(([a, s]) => [a, ruleBreaks(s)]));
    const row = { cluster: `league:${L.lid}`, season: L.season, week: W, audit, complete, rule_breaks: breaks,
      moves: Object.fromEntries(Object.entries(arms).map(([a, s]) => [a, stepIds(s)])), ms: 0 };
    const baseOut = complete ? realized(C, new Map(C.base)) : null;
    const cache = new Map();
    for (const [a, steps] of Object.entries(arms)) {
      row[a] = {
        ...(complete ? realizedGain(C, String(me), steps, baseOut, cache) : { title: null, playoff: null }),
        ...realizedPoints(C, String(me), steps, Math.min(lastFinal, C.nReg)),
        steps: steps.length,
      };
    }
    row.ms = Date.now() - t0;
    rows.push(row);
  }
  return rows;
}

/** The aggregate: title verdict (complete leagues only) and the interim points read. */
export function summarizeReplay(rows) {
  const graded = rows.filter(r => r.planner && !r.error && !r.skipped);
  const complete = graded.filter(r => r.complete);
  const leagues = new Set(complete.map(r => r.cluster)).size;
  const title = e4.summarize(complete, { target: 'title' });
  const status = leagues < MIN_LEAGUES ? e4.verdict(null) : e4.verdict(title.vs_best);
  const breaks = graded.reduce((s, r) => s + Object.values(r.rule_breaks).flat().length, 0);
  return {
    pass_bar: PASS_BAR,
    status,
    complete_leagues: leagues,
    title: e4.roundSummary(title),
    playoff: e4.roundSummary(e4.summarize(complete, { target: 'playoff' })),
    interim_points_per_week: e4.roundSummary(e4.summarize(graded, { target: 'points' })),
    league_weeks: graded.length,
    captured_weeks: graded.filter(r => r.audit?.provenance === 'captured').length,
    skipped: rows.filter(r => r.skipped).length,
    errors: rows.filter(r => r.error).length,
    rule_breaks: breaks,
    acceptance: `assumed: p = clamp(${ACCEPT.at_par} + ${ACCEPT.per_pct} x screen%, ${ACCEPT.lo}, ${ACCEPT.hi})`,
    real_behavior_only: false,
  };
}

// ---------------------------------------------------------------- CLI (reads a database copy)
function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2), nx = argv[i + 1];
    if (nx == null || nx.startsWith('--')) o[k] = true; else { o[k] = nx; i++; }
  }
  return o;
}

/** Everything the replay reads for one league, from an open node:sqlite database. */
export function readLeague(db, lg, season) {
  const rules = leagueRules(lg);
  const payload = JSON.parse(lg.payload);
  const snaps = db.prepare(`SELECT scoring_period_id, team_id, player_id, position, is_starter, on_roster, projected_points,
      actual_points, source, changed_at FROM league_roster_snapshots WHERE league_id = ? AND season = ? AND source = 'final'`)
    .all(lg.id, season);
  const ids = [...new Set(snaps.map(r => r.player_id).filter(x => x != null))];
  const byes = new Map();
  const bye = db.prepare('SELECT bye_week FROM players WHERE id = ?');
  for (const id of ids) { const b = bye.get(id)?.bye_week; if (b != null) byes.set(String(id), Number(b)); }
  const cutoffs = weekCutoffs(db.prepare('SELECT week, date FROM schedule_games WHERE season = ?').all(season));
  return { rules, payload, snaps, byes, cutoffs, opp: opponents(payload) };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (!seasonReplayEnabled(env)) throw new Error(`${SEASON_REPLAY_ENV}=1 is required (study harness; off by default)`);
  const o = args(argv);
  if (!o.db) throw new Error('--db <copy of the app database> is required');
  const season = Number(o.season ?? 2026);
  const { DatabaseSync } = await import('node:sqlite');
  const { lineupSlots } = await import('../../server/services/trade-engine.js');
  const { planLeague } = await import('../../server/services/campaign/planner.js');
  const { normaliseObjective } = await import('../../server/services/campaign/objectives.js');
  const planner = { planLeague, objective: normaliseObjective({}) };
  const db = new DatabaseSync(o.db, { readOnly: true });
  const only = o.leagues ? new Set(String(o.leagues).split(',').map(Number)) : null;
  const leagues = db.prepare(`SELECT id, platform, season, my_team_id, roster_positions, payload FROM leagues
    WHERE platform = 'espn' AND season = ? ORDER BY id`).all(season).filter(l => !only || only.has(l.id));
  const out = { study: 'SEASON-REPLAY: E4 retro on Nick\'s leagues, as of each past week', season, leagues: [], rows: [] };
  for (const lg of leagues) {
    const R = readLeague(db, lg, season);
    const problem = formatProblem(R.rules);
    if (problem) { out.leagues.push({ league_id: lg.id, skipped: problem }); continue; }
    const L = exportLeague({ leagueId: lg.id, season, snaps: R.snaps, byes: R.byes, opp: R.opp, rules: R.rules, slots: lineupSlots(lg) });
    const nReg = R.rules.schedule.regular_season_weeks;
    const [w0, w1] = o.weeks ? String(o.weeks).split('-').map(Number) : [2, nReg];
    const weeks = [];
    for (let w = Math.max(2, w0); w <= Math.min(w1 ?? w0, nReg); w++) weeks.push(w);
    const rows = replayWeeks(L, { me: lg.my_team_id, weeks, cutoffs: R.cutoffs, snaps: R.snaps, planner,
      runs: Number(o.runs ?? RUNS), strict: !!o.strict });
    out.leagues.push({ league_id: lg.id, weeks: weeks.length, final_weeks: L.final_weeks, skipped_no_player_id: L.skipped_no_player_id,
      bracket: R.rules.schedule.reseed ? 'reseeded (as the league)' : 'fixed in the league, played reseeded here (approximation)' });
    out.rows.push(...rows.map(r => ({ league_id: lg.id, ...r })));
    console.log(`league ${lg.id}: ${rows.filter(r => r.planner).length} graded, ${rows.filter(r => r.skipped).length} skipped, ${rows.filter(r => r.error).length} errors`);
  }
  db.close();
  out.summary = summarizeReplay(out.rows);
  out.seed = SEED;
  if (o.out) { fs.mkdirSync(path.dirname(o.out), { recursive: true }); fs.writeFileSync(o.out, JSON.stringify(out, null, 1)); }
  console.log(JSON.stringify(out.summary, null, 1));
  return out;
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? '')).href; } catch { return false; }
})();
if (invokedDirectly) {
  main().then(() => process.exit(0), e => { console.error(e.stack ?? e); process.exit(1); });
}

