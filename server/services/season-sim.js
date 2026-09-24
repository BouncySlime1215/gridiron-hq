/**
 * Season simulator.
 *
 * Plays the rest of the fantasy season ten thousand times and counts how often each
 * team makes the playoffs and wins the title. This is the number the whole engine was
 * built to produce: it values depth, bye weeks, weekly variance and playoff schedule
 * simultaneously, without any of them needing a rule of their own.
 *
 * It is also what finally makes trades comparable. "+2.3 points a week" is an input;
 * "your title odds go from 14% to 21%" is the answer.
 *
 * Each simulated week:
 *   1. draw correlated weekly scores for every rostered player (copula over the
 *      projection model's distributions, times that week's game script and
 *      matchups.js#gameMultiplier, which is 1 while matchups carry no validated signal)
 *   2. set each fantasy team's optimal lineup from what it drew
 *   3. resolve that week's head-to-head fixtures
 * then seed the bracket by the league's own rules (league-rules.js: division winners,
 * tiebreaker, playoff teams, weeks per round, fixed or re-seeded) and play it out.
 */
import { rows } from '../db/index.js';
import { PPR, scoringFor } from './scoring.js';
import { SENSE_CHECK_SIM_RUNS } from './trade-verify.js';
import { buildProjections, sampleWeeks } from './projections.js';
import { correlatedSampler } from './correlation.js';
import { gameMultiplier, matchupModel } from './matchups.js';
import { leagueRules, seedStandings, simRulesProblem } from './league-rules.js';
import { deriveFormat } from './format.js';
import { gameScriptFor } from './gamescript.js';
import { loadRosters, assetUniverse, lineupSlots } from './trade-engine.js';
import { random, withRandomSeed, keyedSeed } from './stats-util.js';
import { weeklyAvailability } from './contingency.js';
import { availPPlayMode, availPPlayWeek } from './avail-p-play.js';
import { leagueCurrentWeek } from './league-week.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);
const FLEX_ELIGIBLE = {
  FLEX: ['RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'], WRRB_FLEX: ['RB', 'WR'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], OP: ['QB', 'RB', 'WR', 'TE']
};
// Size of each player's pre-generated outcome pool. The copula indexes into it, so this
// is the resolution of every marginal distribution in the simulation.
const POOL = 600;

/*
 * Wilson interval on hits/runs. Read it as RUN-TO-RUN Monte Carlo error ONLY.
 *
 * It treats the runs as independent draws from the model, but every run indexes
 * the same fixed POOL-sized outcome pool per player-week and the same Cholesky
 * factor. The pools' own sampling error is therefore a bias shared by every run —
 * at 600 draws a WR1's p90 has sd ~1.5-1.7 and his mean sd ~0.6 across pool
 * regenerations — and it does not shrink as runs grows. So the stated interval is
 * narrower than the real uncertainty in the odds, and re-running the same league
 * with a different seed can move the point estimate by more than the interval.
 * To report the full error, regenerate the pools per batch and pool the variance
 * across regenerations. The payload says which interval this is.
 */
const binomial95 = (hits, n) => {
  if (!n) return [null, null];
  const z = 1.96, p = hits / n, den = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / den;
  const half = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / den;
  return [+(Math.max(0, center - half)).toFixed(4), +(Math.min(1, center + half)).toFixed(4)];
};

/* ------------------------------------------------------------ league shape */

/** Regular-season fixtures by week, from whichever platform the league lives on. */
function fixtures(lg, rules) {
  const payload = JSON.parse(lg.payload);
  const out = new Map();
  // Unreachable until league-rules.js has a Sleeper reader: simulateSeason
  // returns simRulesProblem's named error for every non-ESPN league first. Kept
  // for that follow-up (see league-rules.js header), not deleted.
  if (lg.platform === 'sleeper') {
    // Sleeper stores matchups per week keyed by a shared matchup_id.
    for (const [week, list] of Object.entries(payload.matchups ?? {})) {
      const byId = new Map();
      for (const m of list) (byId.get(m.matchup_id) ?? byId.set(m.matchup_id, []).get(m.matchup_id)).push(String(m.roster_id));
      out.set(Number(week), [...byId.values()].filter(p => p.length === 2));
    }
    return out;
  }
  const regularWeeks = rules.schedule.regular_season_weeks;
  for (const m of payload.schedule ?? []) {
    const wk = m.matchupPeriodId;
    if (!wk || wk > regularWeeks) continue;
    if (m.home?.teamId == null || m.away?.teamId == null) continue;
    (out.get(wk) ?? out.set(wk, []).get(wk)).push([String(m.home.teamId), String(m.away.teamId)]);
  }
  return out;
}

/**
 * Lineup total with the decision made from pre-kickoff expectations.
 *
 * `expected` decides who starts; `drawn` decides what those starters score. The
 * previous implementation sorted on `drawn`, which let every manager see the
 * future and retroactively start the highest-scoring bench players each week.
 */
function lineupPoints(roster, slots, drawn, expected) {
  const pool = roster
    .filter(p => SCORED.has(p.position))
    .map(p => ({
      id: p.id, position: p.position,
      expected: expected.get(p.id) ?? 0,
      pts: drawn.get(p.id) ?? 0
    }))
    .sort((a, b) => b.expected - a.expected);
  const used = new Set();
  let total = 0;
  for (const slot of slots) {
    if (!SCORED.has(slot)) continue;
    const pick = pool.find(p => !used.has(p.id) && p.position === slot);
    if (pick) { used.add(pick.id); total += pick.pts; }
  }
  for (const slot of slots) {
    const ok = FLEX_ELIGIBLE[slot];
    if (!ok) continue;
    const pick = pool.find(p => !used.has(p.id) && ok.includes(p.position));
    if (pick) { used.add(pick.id); total += pick.pts; }
  }
  return total;
}

/** Real record and points already earned before the simulated window. */
function initialRecords(lg, teams, fromWeek, medianGame = false) {
  const out = new Map(teams.map(t => [t.roster_id, { w: 0, pf: 0 }]));
  if (fromWeek <= 1) return out;
  const payload = JSON.parse(lg.payload);

  // Unreachable until league-rules.js has a Sleeper reader (see fixtures()).
  if (lg.platform === 'sleeper') {
    for (const [week, list] of Object.entries(payload.matchups ?? {})) {
      if (Number(week) >= fromWeek) continue;
      const groups = new Map();
      for (const m of list ?? []) {
        if (m.matchup_id == null) continue;
        const a = groups.get(m.matchup_id) ?? [];
        a.push(m); groups.set(m.matchup_id, a);
        const r = out.get(String(m.roster_id));
        if (r) r.pf += Number(m.points) || 0;
      }
      for (const pair of groups.values()) {
        if (pair.length !== 2) continue;
        const a = out.get(String(pair[0].roster_id)), b = out.get(String(pair[1].roster_id));
        if (!a || !b) continue;
        const ap = Number(pair[0].points) || 0, bp = Number(pair[1].points) || 0;
        if (ap > bp) a.w++; else if (bp > ap) b.w++; else { a.w += 0.5; b.w += 0.5; }
      }
    }
    return out;
  }

  const weekScores = new Map();
  for (const m of payload.schedule ?? []) {
    if (!m.matchupPeriodId || m.matchupPeriodId >= fromWeek) continue;
    const hid = m.home?.teamId == null ? null : String(m.home.teamId);
    const aid = m.away?.teamId == null ? null : String(m.away.teamId);
    const h = out.get(hid), a = out.get(aid);
    if (!h || !a) continue;
    const hp = Number(m.home?.totalPoints ?? m.home?.cumulativeScore?.score);
    const ap = Number(m.away?.totalPoints ?? m.away?.cumulativeScore?.score);
    if (!Number.isFinite(hp) || !Number.isFinite(ap)) continue;
    h.pf += hp; a.pf += ap;
    if (hp > ap) h.w++; else if (ap > hp) a.w++; else { h.w += 0.5; a.w += 0.5; }
    const wk = weekScores.get(m.matchupPeriodId) ?? weekScores.set(m.matchupPeriodId, new Map()).get(m.matchupPeriodId);
    wk.set(hid, hp); wk.set(aid, ap);
  }
  if (medianGame) for (const wk of weekScores.values()) addMedianResults(wk, out);
  return out;
}

/**
 * The week a page-facing simulation starts from — the one producer for it.
 *
 * A payload that is last season's (the pre-draft fallback in syncEspnLeague
 * stamps `payload_season`) starts at week 1, whatever week was asked for: its
 * scored weeks are last year's games and must not become this season's
 * standings. Otherwise an explicit week (a caller's `?from_week=`, passed through
 * raw as simulateSeason/tradeImpact's `fromWeek` option) wins; else the league's own
 * current week (leagueCurrentWeek), so the completed weeks before it are
 * carried in as the real record by initialRecords(). Defaulting to 1 simulated
 * a 5-0 team in week 6 as 0-0 (B-01, 2026-09-22).
 *
 * Callers outside this file pass only the raw client week (or nothing) as
 * `fromWeek`; simulateSeason/tradeImpact resolve it here, so this function is
 * the one producer (source guard: test/b-01-real-record-odds.test.js).
 */
export function simStartWeek(lg, requested = null) {
  // Checked first, so a client's explicit week cannot turn last season's scored
  // weeks back into this season's record (INT-162-1).
  const payloadSeason = Number(lg?.payload_season), season = Number(lg?.season);
  if (payloadSeason && season && payloadSeason !== season) return 1;
  const explicit = Number(requested);
  if (Number.isInteger(explicit) && explicit >= 1) return explicit;
  return leagueCurrentWeek(lg);
}

/**
 * The league-median game (a win for every team above that week's median score,
 * half a win at it). Only runs when league-rules says the league plays it.
 */
function addMedianResults(weekScore, record) {
  const vals = [...weekScore.values()].sort((a, b) => a - b);
  if (!vals.length) return;
  const n = vals.length;
  const mid = n % 2 ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2;
  for (const [id, s] of weekScore) {
    const r = record.get(id);
    if (!r) continue;
    if (s > mid) r.w++; else if (s === mid) r.w += 0.5;
  }
}

/** Standard bracket positions for a power-of-two field: 1,8,4,5,2,7,3,6 for 8. */
function bracketOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap(seed => [seed, n + 1 - seed]);
  }
  return order;
}

/**
 * Single-elimination bracket in the league's format.
 *
 * `field` is in seed order. Bracket positions past the field size are byes, so
 * the top seeds rest in round 1 when the field is not a power of two. With
 * `reseed: false` (all five synced leagues) the bracket is fixed: in a 6-team
 * field the 1 seed meets the 4/5 winner and the 2 seed the 3/6 winner. With
 * `reseed: true` each later round pairs the best remaining seed with the worst.
 * Each round is scored over all of its NFL weeks (`playoff_weeks[round]`), so a
 * two-week round sums both weeks. A tie goes to the better seed.
 *
 * @param scoreFor (rosterId, weeks[]) -> points
 */
function playBracket(field, { playoff_weeks: roundWeeks, reseed }, scoreFor) {
  const seedOf = id => field.indexOf(id);
  let slots = bracketOrder(2 ** roundWeeks.length).map(seed => (seed <= field.length ? field[seed - 1] : null));
  const byes = [];
  for (let i = 0; i < slots.length; i += 2) {
    if (slots[i] && !slots[i + 1]) byes.push(slots[i]);
    else if (!slots[i] && slots[i + 1]) byes.push(slots[i + 1]);
  }
  const rounds = [];
  let finalists = [];
  for (let r = 0; r < roundWeeks.length; r++) {
    const weeks = roundWeeks[r];
    if (reseed && r > 0) {
      const alive = slots.filter(Boolean).sort((a, b) => seedOf(a) - seedOf(b));
      slots = [];
      while (alive.length > 1) slots.push(alive.shift(), alive.pop());
      if (alive.length) slots.push(alive[0], null);
    }
    if (r === roundWeeks.length - 1) finalists = slots.filter(Boolean);
    const pairs = [];
    const next = [];
    for (let i = 0; i < slots.length; i += 2) {
      const a = slots[i], b = slots[i + 1];
      if (!a || !b) { next.push(a ?? b ?? null); continue; }
      pairs.push([a, b]);
      const sa = scoreFor(a, weeks), sb = scoreFor(b, weeks);
      next.push(sa === sb ? (seedOf(a) < seedOf(b) ? a : b) : (sa > sb ? a : b));
    }
    rounds.push({ weeks, pairs });
    slots = next;
  }
  return { champion: slots.filter(Boolean)[0] ?? null, finalists, byes, rounds };
}

// Narrowly exposed for deterministic regression tests. These helpers contain
// the decision-timing rules whose accidental reversal creates hindsight bias.
export const __test = { lineupPoints, initialRecords, playBracket, addMedianResults };

/* -------------------------------------------------------------- the sim */

/**
 * @param opts.overrides  Map<roster_id, player_id[]> replacing a team's roster, which
 *                        is how a proposed trade is evaluated: simulate the league as
 *                        it would be after the deal and diff the title odds.
 * @param opts.universe   extra asset ids to simulate even when no roster holds them.
 *                        A paired comparison passes the SAME universe to both arms
 *                        (every id either arm rosters), so the copula's same-game
 *                        blocks, and therefore every player's draws, are identical
 *                        in both. Without it, a new player in a same-game block
 *                        changes the Cholesky rows of everyone sorted after him.
 */
export function simulateSeason(lg, {
  runs = 2000, fromWeek: requestedWeek = null, scoring = PPR, overrides = null, projections = null,
  keepRuns = false, universe = null
} = {}) {
  const prep = prepareSeason(lg, { requestedWeek, scoring, overrides, projections, universe });
  if (prep.fail) return prep.fail;
  // A run's draws for a week, made once and shared by every team and by the
  // bracket (the draw is keyed by run, so a repeat call would give the same values).
  let cachedRun = -1, cache = new Map();
  const drawnFor = (run, week) => {
    if (run !== cachedRun) { cachedRun = run; cache = new Map(); }
    let got = cache.get(week);
    if (got) return got;
    const wd = prep.weekData.get(week);
    const drawn = new Map();
    const vals = wd.draw(run);
    for (let i = 0; i < wd.ids.length; i++) drawn.set(wd.ids[i], vals[i]);
    got = { drawn, expected: wd.expected };
    cache.set(week, got);
    return got;
  };
  return playSeasons(prep, prep.teams, runs, keepRuns, (t, run, week) => {
    const { drawn, expected } = drawnFor(run, week);
    return lineupPoints(t.players, prep.slots, drawn, expected);
  });
}

/**
 * Everything a simulated season is built from before a single run is played:
 * the league's rules and fixtures, the rosters (with `overrides` applied), and
 * each player-week's outcome pool and copula sampler. It draws the one number
 * that names the simulated world from the caller's random stream, exactly once.
 */
function prepareSeason(lg, { requestedWeek = null, scoring = PPR, overrides = null, projections = null, universe = null }) {
  const fromWeek = simStartWeek(lg, requestedWeek);
  // The league's own rules, never a hard-coded default: a missing field is a
  // named error with its payload path (league-rules.js#simRulesProblem).
  const rules = leagueRules(lg);
  const problem = simRulesProblem(rules);
  if (problem) return { fail: problem };
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  let teams = loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  const proj = projections ?? buildProjections({ through: SEASON - 1, scoring });

  if (overrides) teams = applyOverrides(teams, overrides, assets);

  const sched = fixtures(lg, rules);
  const weeks = [...sched.keys()].filter(w => w >= fromWeek).sort((a, b) => a - b);
  if (!weeks.length) return { fail: { error: 'no remaining fixtures in this league schedule' } };

  // The bracket is played on the league's own playoff weeks: the NFL weeks after its
  // regular season, `playoffMatchupPeriodLength` weeks per round. Two of the five
  // synced leagues play two-week rounds and one has a 13-week regular season, so
  // the old fixed 15-17 applied the wrong NFL byes and opponents to their brackets.
  const bracketWeeks = rules.schedule.playoff_weeks;
  const simWeeks = [...new Set([...weeks, ...bracketWeeks.flat()])].sort((a, b) => a - b);

  // Every player who could be started by anyone, deduplicated, in id order.
  // RL-6-3: the order is by identity, never by roster position. A trade rebuilds
  // both rosters as `kept + received`, and the copula's Cholesky factor is
  // order-dependent, so a positional order made the "after" season different
  // random football for the whole league (up to 6.5pp on a pure reorder).
  const extra = [...(universe ?? [])].map(id => assets.get(Number(id))).filter(Boolean);
  const roster = [...new Map([...teams.flatMap(t => t.players), ...extra].map(p => [p.id, p])).values()]
    .filter(p => SCORED.has(p.position))
    .sort((a, b) => (a.id > b.id) - (a.id < b.id));
  // One draw from the caller's stream names this simulated world. Every random
  // number below is addressed by (world, player, week[, run]) off it, so under
  // one seed the same player gets the same football in every configuration.
  const world = Math.floor(random() * 0x100000000) >>> 0;
  const { schedule: nflSchedule } = matchupModel();

  /* --- pre-generate each player's outcome pool per week ---------------------
   * Sampling is by far the most expensive part, and a player's distribution only
   * changes across weeks through his opponent. So the pool is built once per
   * (player, week) up front and the simulation just indexes into it. */
  const weekData = new Map();
  // BROKEN-E (default off): the same avail.p_play read the trade engine uses.
  const pPlayMode = availPPlayMode();
  for (const week of simWeeks) {
    const entries = [];
    const pPlayWeek = pPlayMode.on ? availPPlayWeek(SEASON, week, { preview: pPlayMode.preview }) : null;
    const activeChance = pPlayWeek?.rows ?? weeklyAvailability(SEASON, week);
    for (const p of roster) {
      const pr = proj.get(p.id);
      const nflWeek = nflSchedule.get(p.team_abbr)?.find(g => g.week === week);
      // On bye, or no NFL game that week, the player scores nothing.
      if (!pr || !nflWeek) { entries.push({ p, samples: null, meta: null }); continue; }
      // matchups.js's one matchup multiplier: exactly 1 in its tested state (no home/away
      // or defense-vs-position arm beat no adjustment, MATCHUP_EVIDENCE). This used to
      // hard-code `dvpFor(...).mult * (home ? 1.02 : 0.98)`, a tilt matchups.js retired.
      const base = gameMultiplier(nflWeek.opponent_abbr, nflWeek.home, p.position);
      // Matchup difficulty and game script are independent effects on the same volume:
      // who you play, and how the game is expected to unfold.
      const gs = gameScriptFor(p.team_abbr, SEASON, week);
      const mult = { pass: base * gs.pass_mult, rush: base * gs.rush_mult };
      const pPlayed = pPlayWeek?.of(p.id, p.position) ?? null;
      const activeProbability = pPlayed ? pPlayed.value : activeChance.get(p.id)?.active_probability ?? 0.92;
      const s = withRandomSeed(keyedSeed(world, 'pool', p.id, week),
        () => sampleWeeks(pr.params, POOL, scoring, mult, activeProbability)).sort((a, b) => a - b);
      entries.push({
        p, samples: s,
        meta: {
          id: p.id, position: p.position,
          team: p.team_abbr, opponent: nflWeek.opponent_abbr,
          target_share: pr.volume?.target_share ?? null,
          active_probability: activeProbability,
          ...(pPlayed ? { p_play_status: pPlayed.status } : {})
        }
      });
    }
    const active = entries.filter(e => e.samples);
    const expected = new Map(active.map(e => [
      e.p.id,
      e.samples.reduce((s, v) => s + v, 0) / e.samples.length
    ]));
    weekData.set(week, {
      // Keyed by (world, player, week); the run index is the counter, so a player's
      // week-w outcome in run r is the same wherever he is rostered.
      draw: correlatedSampler(active.map(e => e.meta), active.map(e => e.samples),
        active.map(e => keyedSeed(world, 'copula', e.p.id, week))),
      ids: active.map(e => e.p.id), expected
    });
  }

  return {
    lg, rules, fromWeek, assets, teams, slots, sched, weeks, simWeeks, bracketWeeks, weekData,
    playoffTeams: rules.schedule.playoff_teams, medianGame: rules.median_game === true,
    rosterIds: new Set(roster.map(p => p.id))
  };
}

/** A trade's rosters: each overridden team's players replaced by the listed ids. */
function applyOverrides(teams, overrides, assets) {
  return teams.map(t => overrides.has(t.roster_id)
    ? { ...t, players: overrides.get(t.roster_id).map(id => assets.get(id)).filter(Boolean) }
    : t);
}

/**
 * Plays the prepared season `runs` times: regular-season fixtures, the league's
 * seeding, then its bracket. `pointsFor(team, run, week)` is that team's lineup
 * total in that run and NFL week; it is the only thing that differs between a
 * full simulation (lineups set from fresh draws) and a trade rescore (lineups
 * read from a prebuilt world), so both give the same numbers.
 */
function playSeasons(prep, teams, runs, keepRuns, pointsFor) {
  const { lg, rules, fromWeek, sched, weeks, bracketWeeks, playoffTeams, medianGame } = prep;
  const ids = teams.map(t => t.roster_id);
  const teamOf = new Map(teams.map(t => [t.roster_id, t]));
  const startingRecords = initialRecords(lg, teams, fromWeek, medianGame);
  const stats = new Map(ids.map(id => [id, {
    roster_id: id, owner: teams.find(t => t.roster_id === id).owner,
    playoffs: 0, title: 0, finals: 0, byes: 0, wins: 0, points: 0, best: 0, worst: Infinity
  }]));
  // Per-run indicators, kept only for a paired comparison (tradeImpact's SE).
  const perRun = keepRuns
    ? new Map(ids.map(id => [id, { title: new Uint8Array(runs), playoffs: new Uint8Array(runs) }]))
    : null;

  for (let run = 0; run < runs; run++) {
    const record = new Map(ids.map(id => [id, { ...(startingRecords.get(id) ?? { w: 0, pf: 0 }) }]));

    for (const week of weeks) {
      const weekScore = new Map();
      for (const t of teams) weekScore.set(t.roster_id, pointsFor(t, run, week));
      for (const [a, b] of sched.get(week) ?? []) {
        const sa = weekScore.get(a) ?? 0, sb = weekScore.get(b) ?? 0;
        if (sa > sb) record.get(a).w++;
        else if (sb > sa) record.get(b).w++;
        else { record.get(a).w += 0.5; record.get(b).w += 0.5; }
      }
      for (const [id, s] of weekScore) record.get(id).pf += s;
      if (medianGame) addMedianResults(weekScore, record);
    }

    // Seed by the league's rule (division winners first where there are
    // divisions, then wins, then the league's tiebreaker).
    const seeded = seedStandings([...record.entries()].map(([id, r]) => ({ id, w: r.w, pf: r.pf })), rules);
    const field = seeded.slice(0, playoffTeams);
    for (const id of field) { stats.get(id).playoffs++; if (perRun) perRun.get(id).playoffs[run] = 1; }
    for (const [id, r] of record) {
      const s = stats.get(id);
      s.wins += r.w; s.points += r.pf;
      s.best = Math.max(s.best, r.pf); s.worst = Math.min(s.worst, r.pf);
    }

    /* --- playoff bracket: the league's own format (playBracket) --- */
    const bracket = playBracket(field, rules.schedule, (id, roundWeeks) =>
      roundWeeks.reduce((sum, week) => sum + pointsFor(teamOf.get(id), run, week), 0));
    for (const id of bracket.byes) stats.get(id).byes++;
    for (const id of bracket.finalists) stats.get(id).finals++;
    if (bracket.champion) {
      stats.get(bracket.champion).title++;
      if (perRun) perRun.get(bracket.champion).title[run] = 1;
    }
  }

  const out = [...stats.values()].map(s => ({
    roster_id: s.roster_id, owner: s.owner,
    playoff_odds: +(s.playoffs / runs).toFixed(4),
    playoff_odds_95: binomial95(s.playoffs, runs),
    title_odds: +(s.title / runs).toFixed(4),
    title_odds_95: binomial95(s.title, runs),
    finals_odds: +(s.finals / runs).toFixed(4),
    expected_wins: +(s.wins / runs).toFixed(2),
    expected_points: +(s.points / runs).toFixed(1)
  })).sort((a, b) => b.title_odds - a.title_odds);

  return {
    runs, weeks: weeks.length, from_week: fromWeek, playoff_teams: playoffTeams,
    rules_source: rules.source, playoff_weeks: bracketWeeks, seeding_rule: rules.seeding.tiebreaker,
    reseed: rules.schedule.reseed, division_winners_first: rules.seeding.division_winners_first,
    median_game: rules.median_game, rules_unknown: rules.unknown,
    standings_carried_in: fromWeek > 1,
    odds_interval: 'run-to-run Monte Carlo error only; excludes the shared error of the fixed per-player outcome pools',
    teams: out,
    ...(perRun ? { per_run: perRun } : {})
  };
}

/** A title-odds delta is shown as real only past this many paired standard errors. */
export const TRADE_DELTA_NOISE_SE = 2;

/**
 * Standard error of mean(after_i - before_i) over paired runs: the textbook
 * paired-difference SE. Both arms are indicator arrays of the same length.
 */
function pairedSe(before, after) {
  const n = before.length;
  if (n < 2) return null;
  let sum = 0, sq = 0;
  for (let i = 0; i < n; i++) { const d = after[i] - before[i]; sum += d; sq += d * d; }
  const mean = sum / n;
  const variance = Math.max(0, (sq - n * mean * mean) / (n - 1));
  return +Math.sqrt(variance / n).toFixed(4);
}

/**
 * The seed a trade is simulated under when the caller gives none: one per
 * league state, so the same deal on the same sync gives the same answer on
 * every click (it used to be a fresh random seed per request).
 */
export function tradeImpactSeed(lg) {
  return keyedSeed('trade-impact', lg.id, lg.fetched_at ?? '');
}

/**
 * The one run count every title-odds delta is simulated at (Title-impact tab,
 * TradeCard, sense-check). With the one seed (tradeImpactSeed) and the league's
 * own scoring, the same deal on the same sync is the same number on every
 * surface. It is the sense-check's measured budget (trade-verify.js).
 */
export const TRADE_IMPACT_RUNS = SENSE_CHECK_SIM_RUNS;

/**
 * GRIDIRON_FAST_RESCORE (default on; `0` restores the old path for one release):
 * a trade is scored by rescoring only the two changed lineups inside a world
 * built once (tradeImpactWorld) instead of re-running the whole league twice.
 * Same numbers either way (test/rl-19-2-fast-rescore.test.js); this is a kill
 * switch, not a model choice.
 */
export function fastRescoreEnabled() {
  return process.env.GRIDIRON_FAST_RESCORE !== '0';
}

/** Read-only view of one run's draws for one week, shaped like the Map lineupPoints reads. */
class RunDraws {
  constructor(vals, index) { this.vals = vals; this.index = index; }
  get(id) { const i = this.index.get(id); return i === undefined ? undefined : this.vals[i]; }
}

/**
 * Everything a trade cannot change, built once per league state: the prepared
 * season (the same prepareSeason tradeImpact's full runs use, under the same
 * seed), every run's draws for every player-week, every team's per-run lineup
 * points, and the unchanged league's result. A trade then only re-solves the two
 * changed lineups (tradeImpact with `world`). Pass it to every deal scored off
 * the same league state; it holds ~runs x weeks x players doubles (tens of MB).
 *
 * `universe`: extra asset ids (e.g. free agents a claim ladder will offer) to
 * simulate even though no roster holds them. A deal that names a player outside
 * the world's universe gets its own world, because adding a player to a
 * same-game block changes the copula rows of the players after him.
 */
export function tradeImpactWorld(lg, {
  runs = TRADE_IMPACT_RUNS, scoring = null, fromWeek: requestedWeek = null, seed = null,
  universe = [], projections = null
} = {}) {
  scoring = scoring ?? scoringFor(lg);
  projections = projections ?? buildProjections({ through: SEASON - 1, scoring });
  const pairedSeed = seed == null ? tradeImpactSeed(lg) : Number(seed);
  const universeIds = [...new Set([...universe].map(Number))].sort((a, b) => a - b);
  const prep = withRandomSeed(pairedSeed,
    () => prepareSeason(lg, { requestedWeek, scoring, projections, universe: universeIds }));
  const key = {
    league: lg.id, fetched_at: lg.fetched_at ?? null, runs, fromWeek: simStartWeek(lg, requestedWeek),
    scoring: JSON.stringify(scoring), seed: pairedSeed
  };
  if (prep.fail) return { key, projections, universe: universeIds, fail: prep.fail };

  const draws = new Map();
  for (const week of prep.simWeeks) {
    const wd = prep.weekData.get(week);
    const index = new Map(wd.ids.map((id, i) => [id, i]));
    const byRun = new Array(runs);
    for (let run = 0; run < runs; run++) byRun[run] = new RunDraws(wd.draw(run), index);
    draws.set(week, { byRun, expected: wd.expected });
  }
  // Simulated players no roster holds (free agents from `universe`).
  const rostered = new Set(prep.teams.flatMap(t => t.players.map(p => p.id)));
  const extras = [...prep.rosterIds].filter(id => !rostered.has(id));
  const w = { key, projections, universe: universeIds, extras, prep, draws, runs };
  w.points = new Map(prep.teams.map(t => [t.roster_id, teamPoints(w, t.players)]));
  w.base = playSeasons(prep, prep.teams, runs, true, pointsReader(w, w.points));
  return w;
}

/** One roster's lineup total in every run and week: week -> Float64Array[run]. */
function teamPoints(w, players) {
  const out = new Map();
  for (const [week, { byRun, expected }] of w.draws) {
    const arr = new Float64Array(w.runs);
    for (let run = 0; run < w.runs; run++) arr[run] = lineupPoints(players, w.prep.slots, byRun[run], expected);
    out.set(week, arr);
  }
  return out;
}

const pointsReader = (w, points) => (t, run, week) => points.get(t.roster_id).get(week)[run];

/** Whether a prebuilt world is the one this deal's full simulation would have built. */
function worldFits(w, lg, { runs, scoring, fromWeek, seed, dealIds }) {
  if (!w || w.fail) return false;
  const k = w.key;
  if (k.league !== lg.id || k.fetched_at !== (lg.fetched_at ?? null) || k.runs !== runs
    || k.fromWeek !== fromWeek || k.scoring !== JSON.stringify(scoring) || k.seed !== seed) return false;
  // The world's copula must hold exactly the players the full runs would: every
  // rostered player plus the ones this deal names. A named player outside it, or
  // an extra free agent the deal does not name, would change his game-mates' draws.
  const named = new Set(dealIds);
  return w.extras.every(id => named.has(id)) && dealIds.every(id => {
    const p = w.prep.assets.get(id);
    return !p || !SCORED.has(p.position) || w.prep.rosterIds.has(id);
  });
}

/**
 * Title-odds impact of a proposed trade.
 *
 * Runs the league twice — as it is, and as it would be — with the same projection set
 * and the same simulated football (common random numbers keyed to each player, not to
 * his roster position), so the difference is the trade and nothing else. Each delta
 * carries its paired standard error, and `*_clears_noise` says whether it is past
 * TRADE_DELTA_NOISE_SE of them.
 *
 * RL-19-2: by default the "as it is" league and every player's draws come from a
 * world built once (tradeImpactWorld; pass `world` to reuse one across deals) and
 * only the two changed lineups are re-solved. The numbers are the same as two full
 * runs; GRIDIRON_FAST_RESCORE=0 runs them the old way.
 */
export function tradeImpact(lg, {
  myTeamId, theirTeamId, iGive = [], iGet = [], runs = TRADE_IMPACT_RUNS,
  scoring = null, fromWeek: requestedWeek = null, seed = null, world = null
}) {
  // Callers no longer pick these: one seed, one run count and the league's own
  // scoring, so every surface shows the same delta for the same deal.
  scoring = scoring ?? scoringFor(lg);
  const fromWeek = simStartWeek(lg, requestedWeek);
  // A world from this same league sync already holds its rosters.
  const sameSync = fastRescoreEnabled() && world?.prep && world.key.league === lg.id
    && world.key.fetched_at === (lg.fetched_at ?? null);
  const teams = sameSync ? world.prep.teams : loadRosters(lg, assetUniverse(lg, deriveFormat(lg).formatKey));
  const me = teams.find(t => t.roster_id === String(myTeamId));
  const them = teams.find(t => t.roster_id === String(theirTeamId));
  if (!me || !them) return { error: 'both teams required' };

  const give = new Set(iGive.map(Number)), get = new Set(iGet.map(Number));
  const overrides = new Map([
    [me.roster_id, [...me.players.filter(p => !give.has(p.id)).map(p => p.id), ...get]],
    [them.roster_id, [...them.players.filter(p => !get.has(p.id)).map(p => p.id), ...give]]
  ]);

  const pairedSeed = seed == null ? tradeImpactSeed(lg) : Number(seed);
  // One shared player universe for both arms: a received player nobody rosters
  // today (a free agent in a claim ladder) is simulated in the "before" arm too.
  const universe = [...give, ...get];
  let before, after;
  if (fastRescoreEnabled()) {
    let w = world;
    if (!worldFits(w, lg, { runs, scoring, fromWeek, seed: pairedSeed, dealIds: universe })) {
      w = tradeImpactWorld(lg, {
        runs, scoring, fromWeek, seed: pairedSeed, universe,
        // A world from this league state and scoring already paid for the projections.
        projections: w?.key?.scoring === JSON.stringify(scoring) ? w.projections : null
      });
    }
    if (w.fail) return w.fail;
    before = w.base;
    const afterTeams = applyOverrides(w.prep.teams, overrides, w.prep.assets);
    const points = new Map(w.points);
    for (const t of afterTeams) if (overrides.has(t.roster_id)) points.set(t.roster_id, teamPoints(w, t.players));
    after = playSeasons(w.prep, afterTeams, runs, true, pointsReader(w, points));
  } else {
    // One projection build shared by both runs — rebuilding would introduce noise that
    // has nothing to do with the trade.
    const projections = buildProjections({ through: SEASON - 1, scoring });
    before = withRandomSeed(pairedSeed,
      () => simulateSeason(lg, { runs, fromWeek, scoring, projections, keepRuns: true, universe }));
    after = withRandomSeed(pairedSeed,
      () => simulateSeason(lg, { runs, fromWeek, scoring, projections, overrides, keepRuns: true, universe }));
  }
  if (before.error || after.error) return before.error ? before : after;

  const pick = (sim, id) => sim.teams.find(t => t.roster_id === id);
  const delta = id => {
    const b = pick(before, id), a = pick(after, id);
    const rb = before.per_run.get(id), ra = after.per_run.get(id);
    const title_delta = +(a.title_odds - b.title_odds).toFixed(4);
    const playoff_delta = +(a.playoff_odds - b.playoff_odds).toFixed(4);
    const title_delta_se = pairedSe(rb.title, ra.title);
    const playoff_delta_se = pairedSe(rb.playoffs, ra.playoffs);
    return {
      roster_id: id, owner: b.owner,
      title_before: b.title_odds, title_after: a.title_odds,
      title_delta, title_delta_se,
      title_delta_clears_noise: title_delta_se != null && Math.abs(title_delta) > TRADE_DELTA_NOISE_SE * title_delta_se,
      playoff_before: b.playoff_odds, playoff_after: a.playoff_odds,
      playoff_delta, playoff_delta_se,
      playoff_delta_clears_noise: playoff_delta_se != null && Math.abs(playoff_delta) > TRADE_DELTA_NOISE_SE * playoff_delta_se,
      wins_delta: +(a.expected_wins - b.expected_wins).toFixed(2)
    };
  };
  return { runs, from_week: fromWeek, seed: pairedSeed, paired_simulation: true,
    me: delta(me.roster_id), them: delta(them.roster_id) };
}
