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
 * then seed the bracket on record and points, and play it out.
 */
import { rows } from '../db/index.js';
import { PPR } from './scoring.js';
import { buildProjections, sampleWeeks } from './projections.js';
import { correlatedSampler } from './correlation.js';
import { gameMultiplier, matchupModel, PLAYOFF_WEEKS } from './matchups.js';
import { deriveFormat } from './format.js';
import { gameScriptFor } from './gamescript.js';
import { loadRosters, assetUniverse, lineupSlots } from './trade-engine.js';
import { random, withRandomSeed } from './stats-util.js';
import { weeklyAvailability } from './contingency.js';

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
function fixtures(lg) {
  const payload = JSON.parse(lg.payload);
  const out = new Map();
  if (lg.platform === 'sleeper') {
    // Sleeper stores matchups per week keyed by a shared matchup_id.
    for (const [week, list] of Object.entries(payload.matchups ?? {})) {
      const byId = new Map();
      for (const m of list) (byId.get(m.matchup_id) ?? byId.set(m.matchup_id, []).get(m.matchup_id)).push(String(m.roster_id));
      out.set(Number(week), [...byId.values()].filter(p => p.length === 2));
    }
    return out;
  }
  const regularWeeks = payload.settings?.scheduleSettings?.matchupPeriodCount ?? 14;
  for (const m of payload.schedule ?? []) {
    const wk = m.matchupPeriodId;
    if (!wk || wk > regularWeeks) continue;
    if (m.home?.teamId == null || m.away?.teamId == null) continue;
    (out.get(wk) ?? out.set(wk, []).get(wk)).push([String(m.home.teamId), String(m.away.teamId)]);
  }
  return out;
}

/**
 * The playoff bracket's real shape: one entry per round, each the NFL weeks that round
 * is played over.
 *
 * WHY THIS IS NOT A CONSTANT. The sim used `PLAYOFF_WEEKS = [15, 16, 17]` from
 * matchups.js, one week per round, for every league — while reading `playoffTeamCount`
 * per league from the same payload. matchups.js:392 already says that default "is right
 * for a 14-week regular season with one-week playoff rounds and wrong for leagues 1 and
 * 3 as synced", so the defect was documented and nothing acted on it.
 *
 * Measured on the synced leagues 2026-09-19: leagues 2 and 5 are 14 regular periods, 6
 * playoff teams, one-week rounds, playoff periods 15/16/17 — the constant is right for
 * them. League 4 is 13 regular periods, 4 playoff teams and TWO-week rounds:
 * `matchupPeriods` maps period 14 to NFL weeks [14, 15] and period 15 to [16, 17]. So
 * its bracket is a semifinal over weeks 14-15 and a final over 16-17, and the constant
 * played it as single weeks 15 and 16 — the wrong opponents' byes, week 14 and week 17
 * never simulated at all, and each round decided on half the points it is really
 * decided on. A player on bye in week 15 was scoring nothing for that league's entire
 * semifinal.
 *
 * ESPN's `matchupPeriods` is the authority: it maps every matchup period to the NFL
 * scoring weeks it covers, so it answers both "which weeks" and "how long is a round"
 * without either being inferred. Rounds beyond `matchupPeriodCount` are the bracket.
 *
 * The number of rounds is what the field needs, ceil(log2(teams)), not however many
 * periods the payload happens to list — a league whose schedule runs past the bracket
 * should not gain a round.
 *
 * `basis` is reported on the response so a reader can tell a league-derived bracket
 * from the fallback rather than assuming the good case.
 */
export function playoffRounds(lg, playoffTeams) {
  const roundsNeeded = Math.max(1, Math.ceil(Math.log2(Math.max(2, playoffTeams))));
  const fallback = () => ({
    rounds: PLAYOFF_WEEKS.slice(0, roundsNeeded).map(w => [w]),
    basis: 'default_weeks_15_17', rounds_needed: roundsNeeded
  });

  let payload = null;
  try { payload = typeof lg?.payload === 'string' ? JSON.parse(lg.payload) : lg?.payload; }
  catch { return fallback(); }
  if (!payload) return fallback();

  if (lg?.platform === 'sleeper') {
    // Sleeper states where the bracket starts and runs one week per round.
    const start = Number(payload.settings?.playoff_week_start);
    if (!(start >= 1)) return fallback();
    return {
      rounds: Array.from({ length: roundsNeeded }, (_, i) => [start + i]),
      basis: 'sleeper_playoff_week_start', rounds_needed: roundsNeeded
    };
  }

  const settings = payload.settings?.scheduleSettings;
  const regular = Number(settings?.matchupPeriodCount);
  const periods = settings?.matchupPeriods;
  if (!(regular >= 1) || !periods || typeof periods !== 'object') return fallback();

  const bracket = Object.keys(periods)
    .map(Number).filter(k => Number.isFinite(k) && k > regular).sort((a, b) => a - b)
    .map(k => (Array.isArray(periods[String(k)]) ? periods[String(k)] : [])
      .map(Number).filter(w => Number.isFinite(w) && w >= 1))
    .filter(weeks => weeks.length);

  if (!bracket.length) return fallback();
  // Fewer periods than the field needs means the payload and the playoff team count
  // disagree. Use what the league actually lists and say so, rather than inventing a
  // week that is not in its schedule.
  if (bracket.length < roundsNeeded) {
    return { rounds: bracket, basis: 'league_schedule_short_of_field', rounds_needed: roundsNeeded };
  }
  return { rounds: bracket.slice(0, roundsNeeded), basis: 'league_schedule', rounds_needed: roundsNeeded };
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
function initialRecords(lg, teams, fromWeek) {
  const out = new Map(teams.map(t => [t.roster_id, { w: 0, pf: 0 }]));
  if (fromWeek <= 1) return out;
  const payload = JSON.parse(lg.payload);

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
  }
  return out;
}

// Narrowly exposed for deterministic regression tests. These helpers contain
// the decision-timing rules whose accidental reversal creates hindsight bias.
export const __test = { lineupPoints, initialRecords };

/* -------------------------------------------------------------- the sim */

/**
 * @param opts.overrides  Map<roster_id, player_id[]> replacing a team's roster, which
 *                        is how a proposed trade is evaluated: simulate the league as
 *                        it would be after the deal and diff the title odds.
 */
/**
 * Which games the simulator's projections are allowed to have seen.
 *
 * `through: SEASON - 1` alone -- what this used to be -- ignores every game already played
 * THIS season. At week 5 it priced the rest of the year off last season's snapshot: a rookie
 * who has taken over a backfield, a receiver whose role collapsed, a player who has not
 * played a down all year, all invisible. `ceiling-lineup.js` documents that exact defect in
 * its own header and already avoids it; the simulator did not, so the title odds and the
 * ceiling lineups were built from different information about the same roster.
 *
 * `throughWeek: fromWeek - 1` is the walk-forward-safe cutoff `player-week-engine.js` already
 * uses: every game up to the week before the one being simulated, and not one game after it.
 * Reading week `fromWeek` itself would leak the outcome of the first week being simulated.
 *
 * TWO GAMES, NOT ONE, AND THAT IS MEASURED. Switching to this season's log the moment a
 * single week exists makes the projections WORSE, because the season weighting gives the
 * current season full weight and drops last season to 0.55 -- so one game outweighs a
 * complete prior year, and the effect is large: Ja'Marr Chase's projection falls 17.1 to
 * 12.5 points a game on one week of evidence. Held out on three seasons independently, mean
 * absolute error over the remaining weeks:
 *
 *   games played |   1        2        3        4        6        8
 *   2023         | -0.015   +0.064   +0.095   +0.134   +0.176   +0.244
 *   2024         | -0.052   +0.009   +0.060   +0.093   +0.124   +0.196
 *   2025         | -0.025   +0.031   +0.064   +0.102   +0.155   +0.202
 *
 * (positive = this-season basis better, in points). The crossover sits between one game and
 * two in all three seasons, and from two games on the advantage grows monotonically. So the
 * switch is at two games played -- a threshold that reproduced in three independent seasons
 * rather than one, which is the difference between a measurement and a tuned number.
 *
 * Before then there is also nothing to read at all in week 1: `history(SEASON, 0)` returns an
 * empty log. `basis` is returned so a reader can see which cutoff was used rather than
 * inferring it from the week.
 */
export const SIM_PROJECTION_MIN_GAMES = 2;

/**
 * How many weeks of `season` the usage log ACTUALLY holds before `beforeWeek`.
 *
 * The threshold above is a measurement about EVIDENCE, and the first version of
 * `simProjectionBasis` counted the calendar instead: `played = fromWeek - 1`, with no
 * question about whether those weeks were in `player_week_usage`. The two are not the
 * same number in normal operation. nflverse settles a week's stats a day or two after the
 * games -- `scheduler.js`'s `nflverse_weekly_usage` job polls every six hours for exactly
 * that reason, and says so in its header -- so on a Monday in week 3 the log can hold one
 * week while the calendar says two. That is the case measured as WORSE than reading last
 * season complete, and a calendar-only gate would have chosen it.
 *
 * It also decides the `projection_basis` string, and that string is the page's claim about
 * what the odds rest on. Against an empty current-season log -- a fresh volume, or a
 * machine in its first hours -- `{through: 2026, throughWeek: 2}` selects `u.season < 2026`
 * and therefore returns exactly the 2021-2025 rows: identical projections to the old
 * behaviour, under a label reading "2026 through week 2". A number computed over nothing,
 * reported as measured, is the specific failure this codebase keeps producing.
 */
export function loggedWeeks(season, beforeWeek) {
  const before = Number(beforeWeek) || 1;
  if (before <= 1) return 0;
  return Number(rows(
    'SELECT COUNT(DISTINCT week) AS n FROM player_week_usage WHERE season = ? AND week < ?',
    season, before
  )[0]?.n) || 0;
}

/**
 * Which projection world the simulation runs in, and why.
 *
 * `logged` is how many weeks of `season` the usage log holds before `fromWeek`, from
 * `loggedWeeks()`. It is an argument rather than something this function fetches, so the
 * measured threshold stays testable without a database and so each test has to state what
 * the data holds instead of quietly asserting against whatever happens to be there.
 *
 * TWO JOBS, DELIBERATELY SEPARATE. `logged` decides WHETHER this season is worth reading.
 * The cutoff stays the calendar's `fromWeek - 1`, which is leak-safe and reads every row
 * that exists up to it; using the logged COUNT as the cutoff would under-read a log with a
 * gap -- weeks 1, 3, 4 present would cut at 3 and drop week 4.
 *
 * A log BEHIND the calendar is reported rather than smoothed over. A simulation at week 6
 * resting on three synced weeks is a different claim from one resting on five, and the
 * reader of the odds is the one entitled to know which.
 */
export function simProjectionBasis(fromWeek, season = SEASON, logged = 0) {
  const week = Number(fromWeek) || 1;
  const calendar = week - 1;
  const have = Math.max(0, Math.min(calendar, Number(logged) || 0));

  if (have >= SIM_PROJECTION_MIN_GAMES) {
    return {
      through: season, throughWeek: calendar,
      basis: have < calendar
        ? `${season} through week ${calendar}, but only ${have} of those ${calendar} weeks are in the usage log`
        : `${season} through week ${calendar}`
    };
  }

  let why;
  if (calendar === 0) why = 'no games played yet this season';
  else if (have === 0) {
    why = `${calendar} week${calendar === 1 ? '' : 's'} played, but the ${season} usage log `
      + 'is empty, so nothing from this season could be read';
  } else why = `${have} game this season is too little to outweigh it`;
  return { through: season - 1, throughWeek: null, basis: `${season - 1} complete; ${why}` };
}

export function simulateSeason(lg, {
  runs = 2000, fromWeek = 1, scoring = PPR, overrides = null, projections = null
} = {}) {
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  let teams = loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  const projBasis = simProjectionBasis(fromWeek, SEASON, loggedWeeks(SEASON, fromWeek));
  const proj = projections ?? buildProjections({
    through: projBasis.through, throughWeek: projBasis.throughWeek, scoring
  });

  if (overrides) {
    teams = teams.map(t => overrides.has(t.roster_id)
      ? { ...t, players: overrides.get(t.roster_id).map(id => assets.get(id)).filter(Boolean) }
      : t);
  }

  const sched = fixtures(lg);
  const weeks = [...sched.keys()].filter(w => w >= fromWeek).sort((a, b) => a - b);
  if (!weeks.length) return { error: 'no remaining fixtures in this league schedule' };

  const playoffTeams = JSON.parse(lg.payload).settings?.scheduleSettings?.playoffTeamCount ?? 6;

  // The bracket is played in its own NFL weeks, not in the last regular-season weeks.
  // Simulating it on weeks 12-14 would apply the wrong opponents and — far worse — the
  // wrong byes, handing the title to whoever happened to have a clean week 12. Which
  // weeks, and how many of them per round, now come from the league (playoffRounds)
  // rather than from one constant that was right for some of these leagues and wrong
  // for others.
  const playoff = playoffRounds(lg, playoffTeams);
  const bracketRounds = playoff.rounds;
  const bracketWeeks = [...new Set(bracketRounds.flat())].sort((a, b) => a - b);
  const simWeeks = [...new Set([...weeks, ...bracketWeeks])].sort((a, b) => a - b);

  // Every player who could be started by anyone, deduplicated.
  const roster = [...new Map(teams.flatMap(t => t.players.map(p => [p.id, p]))).values()]
    .filter(p => SCORED.has(p.position));
  const { schedule: nflSchedule, byeWeek } = matchupModel();

  /* --- pre-generate each player's outcome pool per week ---------------------
   * Sampling is by far the most expensive part, and a player's distribution only
   * changes across weeks through his opponent. So the pool is built once per
   * (player, week) up front and the simulation just indexes into it. */
  const weekData = new Map();
  for (const week of simWeeks) {
    const entries = [];
    const activeChance = weeklyAvailability(SEASON, week);
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
      const activeProbability = activeChance.get(p.id)?.active_probability ?? 0.92;
      const s = sampleWeeks(pr.params, POOL, scoring, mult, activeProbability).sort((a, b) => a - b);
      entries.push({
        p, samples: s,
        meta: {
          id: p.id, position: p.position,
          team: p.team_abbr, opponent: nflWeek.opponent_abbr,
          target_share: pr.volume?.target_share ?? null,
          active_probability: activeProbability
        }
      });
    }
    const active = entries.filter(e => e.samples);
    const expected = new Map(active.map(e => [
      e.p.id,
      e.samples.reduce((s, v) => s + v, 0) / e.samples.length
    ]));
    weekData.set(week, {
      draw: correlatedSampler(active.map(e => e.meta), active.map(e => e.samples)),
      ids: active.map(e => e.p.id), expected
    });
  }

  /* --- run the season ---------------------------------------------------- */
  const ids = teams.map(t => t.roster_id);
  const startingRecords = initialRecords(lg, teams, fromWeek);
  const stats = new Map(ids.map(id => [id, {
    roster_id: id, owner: teams.find(t => t.roster_id === id).owner,
    playoffs: 0, title: 0, finals: 0, byes: 0, wins: 0, points: 0, best: 0, worst: Infinity
  }]));

  for (let run = 0; run < runs; run++) {
    const record = new Map(ids.map(id => [id, { ...(startingRecords.get(id) ?? { w: 0, pf: 0 }) }]));

    for (const week of weeks) {
      const wd = weekData.get(week);
      const drawn = new Map();
      const vals = wd.draw();
      for (let i = 0; i < wd.ids.length; i++) drawn.set(wd.ids[i], vals[i]);

      const weekScore = new Map();
      for (const t of teams) weekScore.set(t.roster_id, lineupPoints(t.players, slots, drawn, wd.expected));
      for (const [a, b] of sched.get(week) ?? []) {
        const sa = weekScore.get(a) ?? 0, sb = weekScore.get(b) ?? 0;
        if (sa > sb) record.get(a).w++;
        else if (sb > sa) record.get(b).w++;
        else { record.get(a).w += 0.5; record.get(b).w += 0.5; }
      }
      for (const [id, s] of weekScore) record.get(id).pf += s;
    }

    // Seed on wins, then points for — the standard tiebreak in both platforms.
    const seeded = [...record.entries()]
      .sort((x, y) => y[1].w - x[1].w || y[1].pf - x[1].pf)
      .map(([id]) => id);
    const field = seeded.slice(0, playoffTeams);
    for (const id of field) stats.get(id).playoffs++;
    for (const [id, r] of record) {
      const s = stats.get(id);
      s.wins += r.w; s.points += r.pf;
      s.best = Math.max(s.best, r.pf); s.worst = Math.min(s.worst, r.pf);
    }

    /* --- playoff bracket ---
     * Single elimination, one simulated week per round, with byes for the top seeds
     * when the field is not a power of two.
     *
     * Rounds are re-seeded highest-against-lowest, which is how both platforms actually
     * run it. Pairing the survivors in seed order instead would put the top two seeds in
     * the same semifinal every single time, which quietly caps the best team's title odds
     * and inflates everyone else's. */
    const seedOf = id => field.indexOf(id);
    const pairHighLow = list => {
      const s = [...list].sort((a, b) => seedOf(a) - seedOf(b));
      const pairs = [];
      while (s.length > 1) pairs.push([s.shift(), s.pop()]);
      if (s.length) pairs.push([s[0], null]);   // odd count: best remaining seed sits out
      return pairs;
    };

    const byes = Math.max(0, 2 ** Math.ceil(Math.log2(playoffTeams)) - playoffTeams);
    let resting = field.slice(0, byes);
    let playing = field.slice(byes);
    let alive = [...field];
    for (const id of resting) stats.get(id).byes++;

    for (let round = 0; alive.length > 1 && round <= 5; round++) {
      if (alive.length === 2) for (const id of alive) stats.get(id).finals++;

      // A round can be more than one NFL week (league 4's rounds are two), and a
      // multi-week round is decided on the TOTAL. Each week inside it gets its own draw
      // and its own lineup decision, because a manager sets a lineup every week and
      // week two's byes are not week one's.
      const roundWeeks = bracketRounds[Math.min(round, bracketRounds.length - 1)];
      const drawnWeeks = roundWeeks.map(week => {
        const wd = weekData.get(week);
        const drawn = new Map();
        const vals = wd.draw();
        for (let i = 0; i < wd.ids.length; i++) drawn.set(wd.ids[i], vals[i]);
        return { drawn, expected: wd.expected };
      });
      const score = id => {
        const players = teams.find(t => t.roster_id === id).players;
        return drawnWeeks.reduce((sum, w) => sum + lineupPoints(players, slots, w.drawn, w.expected), 0);
      };

      const winners = pairHighLow(playing).map(([a, b]) => {
        if (b == null) return a;
        // Ties go to the better seed, as they do in both platforms.
        const sa = score(a), sb = score(b);
        return sa === sb ? (seedOf(a) < seedOf(b) ? a : b) : (sa > sb ? a : b);
      });

      alive = [...resting, ...winners];
      resting = [];
      playing = alive;
    }
    if (alive.length === 1) stats.get(alive[0]).title++;
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
    standings_carried_in: fromWeek > 1,
    // Reported so a reader can see the bracket that was actually played and where it
    // came from, rather than trusting that it matched the league. `basis` names the
    // source: the league's own schedule, or the fallback constant.
    playoff_rounds: bracketRounds, playoff_basis: playoff.basis,
    // Which games these odds were built from. Served because odds built off last season and
    // odds built off this season's games so far are different numbers, and a reader cannot
    // tell them apart from the value alone.
    projection_basis: projBasis.basis,
    odds_interval: 'run-to-run Monte Carlo error only; excludes the shared error of the fixed per-player outcome pools',
    teams: out
  };
}

/**
 * Title-odds impact of a proposed trade.
 *
 * Runs the league twice — as it is, and as it would be — with the same projection set,
 * so the difference is the trade and nothing else.
 */
export function tradeImpact(lg, {
  myTeamId, theirTeamId, iGive = [], iGet = [], runs = 1200,
  scoring = PPR, fromWeek = 1, seed = null
}) {
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const me = teams.find(t => t.roster_id === String(myTeamId));
  const them = teams.find(t => t.roster_id === String(theirTeamId));
  if (!me || !them) return { error: 'both teams required' };

  const give = new Set(iGive.map(Number)), get = new Set(iGet.map(Number));
  const overrides = new Map([
    [me.roster_id, [...me.players.filter(p => !give.has(p.id)).map(p => p.id), ...get]],
    [them.roster_id, [...them.players.filter(p => !get.has(p.id)).map(p => p.id), ...give]]
  ]);

  // One projection build shared by both runs — rebuilding would introduce noise that
  // has nothing to do with the trade.
  const tradeBasis = simProjectionBasis(fromWeek, SEASON, loggedWeeks(SEASON, fromWeek));
  const projections = buildProjections({
    through: tradeBasis.through, throughWeek: tradeBasis.throughWeek, scoring
  });
  // Common random numbers make this a paired experiment: the same simulated
  // football worlds are used before and after, so Monte Carlo noise cannot
  // masquerade as trade impact.
  const pairedSeed = seed == null ? Math.floor(random() * 0xFFFFFFFF) : Number(seed);
  const before = withRandomSeed(pairedSeed,
    () => simulateSeason(lg, { runs, fromWeek, scoring, projections }));
  const after = withRandomSeed(pairedSeed,
    () => simulateSeason(lg, { runs, fromWeek, scoring, projections, overrides }));
  if (before.error || after.error) return before.error ? before : after;

  const pick = (sim, id) => sim.teams.find(t => t.roster_id === id);
  const delta = id => {
    const b = pick(before, id), a = pick(after, id);
    return {
      roster_id: id, owner: b.owner,
      title_before: b.title_odds, title_after: a.title_odds,
      title_delta: +(a.title_odds - b.title_odds).toFixed(4),
      playoff_before: b.playoff_odds, playoff_after: a.playoff_odds,
      playoff_delta: +(a.playoff_odds - b.playoff_odds).toFixed(4),
      wins_delta: +(a.expected_wins - b.expected_wins).toFixed(2)
    };
  };
  return { runs, from_week: fromWeek, seed: pairedSeed, paired_simulation: true,
    me: delta(me.roster_id), them: delta(them.roster_id) };
}
