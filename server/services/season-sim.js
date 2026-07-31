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
 *      projection model's distributions, matchup-adjusted for that week's opponent)
 *   2. set each fantasy team's optimal lineup from what it drew
 *   3. resolve that week's head-to-head fixtures
 * then seed the bracket on record and points, and play it out.
 */
import { rows } from '../db/index.js';
import { PPR } from './scoring.js';
import { buildProjections, sampleWeeks } from './projections.js';
import { correlatedSampler } from './correlation.js';
import { dvpFor, matchupModel, PLAYOFF_WEEKS } from './matchups.js';
import { deriveFormat } from './format.js';
import { gameScriptFor } from './gamescript.js';
import { loadRosters, assetUniverse, lineupSlots } from './trade-engine.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);
const FLEX_ELIGIBLE = {
  FLEX: ['RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'], WRRB_FLEX: ['RB', 'WR'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], OP: ['QB', 'RB', 'WR', 'TE']
};
// Size of each player's pre-generated outcome pool. The copula indexes into it, so this
// is the resolution of every marginal distribution in the simulation.
const POOL = 600;

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

/** Optimal lineup total from a map of player id -> drawn score. */
function lineupPoints(roster, slots, drawn) {
  const pool = roster
    .filter(p => SCORED.has(p.position))
    .map(p => ({ id: p.id, position: p.position, pts: drawn.get(p.id) ?? 0 }))
    .sort((a, b) => b.pts - a.pts);
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

/* -------------------------------------------------------------- the sim */

/**
 * @param opts.overrides  Map<roster_id, player_id[]> replacing a team's roster, which
 *                        is how a proposed trade is evaluated: simulate the league as
 *                        it would be after the deal and diff the title odds.
 */
export function simulateSeason(lg, {
  runs = 2000, fromWeek = 1, scoring = PPR, overrides = null, projections = null
} = {}) {
  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  let teams = loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  const proj = projections ?? buildProjections({ through: SEASON - 1, scoring });

  if (overrides) {
    teams = teams.map(t => overrides.has(t.roster_id)
      ? { ...t, players: overrides.get(t.roster_id).map(id => assets.get(id)).filter(Boolean) }
      : t);
  }

  const sched = fixtures(lg);
  const weeks = [...sched.keys()].filter(w => w >= fromWeek).sort((a, b) => a - b);
  if (!weeks.length) return { error: 'no remaining fixtures in this league schedule' };

  // The bracket is played in NFL weeks 15-17, not in the last three regular-season
  // weeks. Simulating it on weeks 12-14 would apply the wrong opponents and — far worse —
  // the wrong byes, handing the title to whoever happened to have a clean week 12.
  const bracketWeeks = PLAYOFF_WEEKS;
  const simWeeks = [...new Set([...weeks, ...bracketWeeks])].sort((a, b) => a - b);

  const playoffTeams = JSON.parse(lg.payload).settings?.scheduleSettings?.playoffTeamCount ?? 6;

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
    for (const p of roster) {
      const pr = proj.get(p.id);
      const nflWeek = nflSchedule.get(p.team_abbr)?.find(g => g.week === week);
      // On bye, or no NFL game that week, the player scores nothing.
      if (!pr || !nflWeek) { entries.push({ p, samples: null, meta: null }); continue; }
      const d = dvpFor(nflWeek.opponent_abbr, p.position);
      const base = d.mult * (nflWeek.home ? 1.02 : 0.98);
      // Matchup difficulty and game script are independent effects on the same volume:
      // who you play, and how the game is expected to unfold.
      const gs = gameScriptFor(p.team_abbr, SEASON, week);
      const mult = { pass: base * gs.pass_mult, rush: base * gs.rush_mult };
      const s = sampleWeeks(pr.params, POOL, scoring, mult).sort((a, b) => a - b);
      entries.push({
        p, samples: s,
        meta: {
          id: p.id, position: p.position,
          team: p.team_abbr, opponent: nflWeek.opponent_abbr,
          target_share: pr.volume?.target_share ?? null
        }
      });
    }
    const active = entries.filter(e => e.samples);
    weekData.set(week, {
      draw: correlatedSampler(active.map(e => e.meta), active.map(e => e.samples)),
      ids: active.map(e => e.p.id)
    });
  }

  /* --- run the season ---------------------------------------------------- */
  const ids = teams.map(t => t.roster_id);
  const stats = new Map(ids.map(id => [id, {
    roster_id: id, owner: teams.find(t => t.roster_id === id).owner,
    playoffs: 0, title: 0, finals: 0, byes: 0, wins: 0, points: 0, best: 0, worst: Infinity
  }]));

  for (let run = 0; run < runs; run++) {
    const record = new Map(ids.map(id => [id, { w: 0, pf: 0 }]));

    for (const week of weeks) {
      const wd = weekData.get(week);
      const drawn = new Map();
      const vals = wd.draw();
      for (let i = 0; i < wd.ids.length; i++) drawn.set(wd.ids[i], vals[i]);

      const weekScore = new Map();
      for (const t of teams) weekScore.set(t.roster_id, lineupPoints(t.players, slots, drawn));
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

      const week = bracketWeeks[Math.min(round, bracketWeeks.length - 1)];
      const wd = weekData.get(week);
      const drawn = new Map();
      const vals = wd.draw();
      for (let i = 0; i < wd.ids.length; i++) drawn.set(wd.ids[i], vals[i]);
      const score = id => lineupPoints(teams.find(t => t.roster_id === id).players, slots, drawn);

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
    title_odds: +(s.title / runs).toFixed(4),
    finals_odds: +(s.finals / runs).toFixed(4),
    expected_wins: +(s.wins / runs).toFixed(2),
    expected_points: +(s.points / runs).toFixed(1)
  })).sort((a, b) => b.title_odds - a.title_odds);

  return { runs, weeks: weeks.length, from_week: fromWeek, playoff_teams: playoffTeams, teams: out };
}

/**
 * Title-odds impact of a proposed trade.
 *
 * Runs the league twice — as it is, and as it would be — with the same projection set,
 * so the difference is the trade and nothing else.
 */
export function tradeImpact(lg, { myTeamId, theirTeamId, iGive = [], iGet = [], runs = 1200, scoring = PPR }) {
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
  const projections = buildProjections({ through: SEASON - 1, scoring });
  const before = simulateSeason(lg, { runs, scoring, projections });
  const after = simulateSeason(lg, { runs, scoring, projections, overrides });
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
  return { runs, me: delta(me.roster_id), them: delta(them.roster_id) };
}
