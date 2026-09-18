/**
 * Replay study — the engine: draft, season, outcomes.
 *
 * Holds real player outcomes fixed and randomises only what is genuinely luck:
 * draft order, which manager takes whom, and the schedule. See
 * docs/WHAT-WINS-STUDY.md for the design and the reasons behind each choice.
 *
 * Three decisions here are load-bearing and were all wrong in the first design:
 *
 *   1. DRAFTERS ARE AGENTS, NOT "ADP + NOISE". If every team follows the same
 *      ranking, the only variation is noise, and a regression on roster shape
 *      is really estimating which random perturbations happened to pay. Each
 *      team gets an explicit archetype instead, so "which strategy wins" is a
 *      treatment rather than an accident.
 *
 *   2. THREE LINEUP ARMS, AND THE MIDDLE ONE IS THE ANSWER. Perfect hindsight
 *      turns head-to-head into best ball, which harvests volatility for free
 *      and would make the study "discover" that ceiling beats floor — a known
 *      best-ball result that does not transfer. The attainable arm uses only
 *      what a manager could have known that morning.
 *
 *   3. ROSTERS CHURN. Frozen rosters leave every injured pick as a permanent
 *      zero and make the waiver pool irrelevant, when about half of a real
 *      title roster's value arrives after the draft.
 */
import { loadSeason, playedStats, rng, randn, shuffle } from './lib.mjs';

/* ------------------------------------------------------------------ formats */

export const FORMATS = {
  // The validation configuration: the only shape with published benchmarks.
  bestball12: {
    label: '12-team half-PPR best ball',
    teams: 12, scoring: 'half', rounds: 18, bestBall: true, churn: false,
    slots: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1 }, bench: 10,
    playoffWeeks: [15, 16, 17], regularWeeks: [1, 14], advance: 2,
  },
  // Nick's shapes.
  redraft10_1flex: {
    label: '10-team PPR, 1 flex',
    teams: 10, scoring: 'ppr', rounds: 15, bestBall: false, churn: true,
    slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 }, bench: 8,
    playoffWeeks: [15, 16, 17], regularWeeks: [1, 14], advance: 4,
  },
  redraft10_2flex: {
    label: '10-team half-PPR, 2 flex',
    teams: 10, scoring: 'half', rounds: 15, bestBall: false, churn: true,
    slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2 }, bench: 7,
    playoffWeeks: [15, 16, 17], regularWeeks: [1, 14], advance: 4,
  },
};

const FLEX_OK = new Set(['RB', 'WR', 'TE']);

/* --------------------------------------------------------------- archetypes */

/**
 * Archetypes as POSITIONAL RULES, not value penalties.
 *
 * The first implementation multiplied a player's consensus rank by a positional
 * bias. That does not model a strategy — it models drafting worse players. An
 * agent biased against RB takes a WR ranked 40 over an RB ranked 20, then keeps
 * doing it, and ends the draft with systematically less talent. Every archetype
 * duly "lost" by 5-15 percentage points of all-play, which is not a finding
 * about football; it is the tautology that deviating from an efficient ranking
 * costs value, and ADP is efficient here (Spearman 0.48 against realised
 * points).
 *
 * What a real structural strategy does is constrain WHICH POSITIONS are live in
 * which rounds, and then take the best available player among them. Zero RB is
 * not "avoid running backs"; it is "take the best receiver or tight end early,
 * then take running back VALUE once it falls". Modelled that way the agent
 * still drafts the best player it can, so the contrast measures allocation
 * rather than competence.
 *
 * `avoid` lists positions that are off the board in those rounds; `require`
 * forces a position by the end of a round. Everything else is best available.
 */
export const ARCHETYPES = {
  balanced: { label: 'best available by consensus', rules: [] },
  zero_rb: { label: 'Zero RB — no RB before round 6', rules: [{ rounds: [1, 5], avoid: ['RB'] }] },
  hero_rb: { label: 'Hero RB — one early RB, then none until round 7', rules: [{ rounds: [2, 6], avoid: ['RB'], unless: { pos: 'RB', maxCount: 0 } }] },
  robust_rb: { label: 'Robust RB — RB with the first two picks', rules: [{ rounds: [1, 2], only: ['RB'] }] },
  early_qb: { label: 'early QB — a QB by round 4', rules: [{ rounds: [1, 4], require: 'QB' }] },
  late_qb: { label: 'late QB — no QB before round 9', rules: [{ rounds: [1, 8], avoid: ['QB'] }] },
  early_te: { label: 'early TE — a TE by round 4', rules: [{ rounds: [1, 4], require: 'TE' }] },
};

/** Which positions this archetype will consider in this round. */
function allowedPositions(arch, round, counts, roundsLeft) {
  let allowed = new Set(['QB', 'RB', 'WR', 'TE']);
  for (const r of arch.rules ?? []) {
    const [lo, hi] = r.rounds;
    if (round < lo || round > hi) continue;
    if (r.only) allowed = new Set(r.only.filter(p => allowed.has(p)));
    if (r.avoid) {
      // "unless" lets Hero RB take exactly one back before the avoid window.
      const exempt = r.unless && counts[r.unless.pos] <= r.unless.maxCount;
      if (!exempt) for (const p of r.avoid) allowed.delete(p);
    }
    // A "require" becomes binding only as its window closes, so the agent still
    // takes value first and satisfies the constraint at the last opportunity.
    if (r.require && counts[r.require] === 0 && round === hi) allowed = new Set([r.require]);
  }
  return allowed.size ? allowed : new Set(['QB', 'RB', 'WR', 'TE']);
}

/* -------------------------------------------------------------------- draft */

function rosterNeeds(format) {
  const need = { ...format.slots };
  delete need.FLEX;
  return need;
}

/**
 * Snake draft. Each agent ranks the board by consensus rank, perturbed by its
 * own archetype bias and by noise, then takes the best player it can still
 * roster.
 *
 * ADP noise is scaled by the consensus dispersion the source already carries
 * (`ecr_std_dev`) and widened with pick number, because agreement is tight at
 * the top of a board and loose at the bottom. The resulting ADP-to-outcome
 * correlation is checked against the published ~0.6 Spearman in the
 * known-answers report — too little noise and the draft is unrealistically
 * efficient.
 */
export function draft(season, format, agents, rand) {
  const board = season.adp.slice();
  const teams = agents.map((a, i) => ({
    idx: i, archetype: a, players: [], counts: { QB: 0, RB: 0, WR: 0, TE: 0 },
  }));
  const taken = new Set();
  const maxAtPos = { QB: format.slots.QB + 2, RB: 8, WR: 9, TE: format.slots.TE + 2 };

  for (let round = 1; round <= format.rounds; round++) {
    const order = round % 2 ? teams : teams.slice().reverse();
    for (const team of order) {
      const arch = ARCHETYPES[team.archetype] ?? ARCHETYPES.balanced;
      const allowed = allowedPositions(arch, round, team.counts, format.rounds - round);
      // Every agent takes the BEST AVAILABLE player, and the archetype only
      // decides which positions are on its board this round. Same board, same
      // noise, different allocation.
      let best = null, bestScore = Infinity, fallback = null, fallbackScore = Infinity;
      for (const p of board) {
        if (taken.has(p.key)) continue;
        if (team.counts[p.pos] >= (maxAtPos[p.pos] ?? 6)) continue;
        const sd = Math.max(1.5, (p.adp_sd ?? 3) * (1 + round / 8));
        const score = p.adp + randn(rand) * sd;
        if (score < fallbackScore) { fallbackScore = score; fallback = p; }
        if (!allowed.has(p.pos)) continue;
        if (score < bestScore) { bestScore = score; best = p; }
      }
      best = best ?? fallback;
      if (!best) continue;
      taken.add(best.key);
      team.players.push(best);
      team.counts[best.pos]++;
    }
  }
  return teams;
}

/* ------------------------------------------------------------------- lineup */

/**
 * Fill the starting slots from a ranked list. Greedy over required slots first,
 * then flex — the standard rule, and the one real managers follow.
 */
function fillLineup(ranked, format) {
  const used = new Set();
  const starters = [];
  for (const [pos, n] of Object.entries(format.slots)) {
    if (pos === 'FLEX') continue;
    for (let i = 0; i < n; i++) {
      const pick = ranked.find(p => !used.has(p.key) && p.pos === pos);
      if (pick) { used.add(pick.key); starters.push(pick); }
    }
  }
  for (let i = 0; i < (format.slots.FLEX ?? 0); i++) {
    const pick = ranked.find(p => !used.has(p.key) && FLEX_OK.has(p.pos));
    if (pick) { used.add(pick.key); starters.push(pick); }
  }
  return starters;
}

/**
 * The three arms.
 *
 * `hindsight` is a ceiling nobody reaches (real managers sit near 85% of it).
 * `attainable` is the headline: season-to-date average with the consensus rank
 * as the prior in early weeks, and a player with no row that week treated as
 * unavailable — which is the single biggest real lineup lever. `naive` is draft
 * order, the floor.
 */
export function lineupFor(arm, roster, week, format, priorPoints) {
  if (arm === 'hindsight') {
    const live = roster.filter(p => p.weekly[week] != null);
    return fillLineup((live.length ? live : roster).slice()
      .sort((a, b) => (b.weekly[week] ?? 0) - (a.weekly[week] ?? 0)), format);
  }
  if (arm === 'naive') {
    return fillLineup(roster.slice().sort((a, b) => a.adp - b.adp), format);
  }
  // ATTAINABLE — and the availability rule here is the whole reason this arm is
  // honest. Filtering to players who actually have a score this week is knowing
  // who is active before kickoff, which no manager does; it made this arm 90%
  // efficient against a literature benchmark of 77.5% and shrank the hindsight
  // gap to 9.5 pts/week against a published ~20.
  //
  // The rule instead: a player who missed LAST week is publicly known to be
  // hurt and is benched. A player who suited up last week and is inactive this
  // week is a surprise the manager eats — exactly the mistake that costs real
  // lineups points.
  const knownOut = new Set(roster
    .filter(p => week > format.regularWeeks[0] && p.weekly[week - 1] == null && priorPoints.has(p.key))
    .map(p => p.key));
  const usable = roster.filter(p => !knownOut.has(p.key));
  const bench = usable.length >= 6 ? usable : roster;
  const ranked = bench.slice().sort((a, b) => {
    const pa = priorPoints.get(a.key), pb = priorPoints.get(b.key);
    const sa = pa && pa.n >= 2 ? pa.sum / pa.n : 18 - Math.min(17, (a.adp ?? 200) / 12);
    const sb = pb && pb.n >= 2 ? pb.sum / pb.n : 18 - Math.min(17, (b.adp ?? 200) / 12);
    return sb - sa;
  });
  return fillLineup(ranked, format);
}

/* ------------------------------------------------------------------- season */

/**
 * Play one league's season.
 *
 * Churn is deliberately simple and strictly non-look-ahead: at the end of each
 * week, the team drops its worst bench player by season-to-date average and
 * claims the best available free agent by the same measure, in reverse standing
 * order. It exists so replacement level matches a managed league and so "live
 * players" means something — not to model anyone's waiver skill.
 */
export function playSeason(teams, season, format, arm, rand) {
  const [wStart, wEnd] = format.regularWeeks;
  const allWeeks = [...Array(format.playoffWeeks.at(-1) - wStart + 1)].map((_, i) => wStart + i);
  const priorPoints = new Map();
  const freeAgents = season.pool.slice();
  const rostered = new Set(teams.flatMap(t => t.players.map(p => p.key)));
  const weekly = teams.map(() => ({}));
  const liveCount = teams.map(() => ({}));

  for (const week of allWeeks) {
    for (const [i, team] of teams.entries()) {
      const starters = lineupFor(arm, team.players, week, format, priorPoints);
      weekly[i][week] = +starters.reduce((s, p) => s + (p.weekly[week] ?? 0), 0).toFixed(2);
      liveCount[i][week] = team.players.filter(p => p.weekly[week] != null).length;
    }
    // Update the season-to-date record AFTER scoring, so week w's own points
    // never inform week w's lineup.
    for (const team of teams) {
      for (const p of team.players) {
        const v = p.weekly[week];
        if (v == null) continue;
        const rec = priorPoints.get(p.key) ?? { sum: 0, n: 0 };
        rec.sum += v; rec.n++; priorPoints.set(p.key, rec);
      }
    }
    for (const p of freeAgents) {
      const v = p.weekly[week];
      if (v == null) continue;
      const rec = priorPoints.get(p.key) ?? { sum: 0, n: 0 };
      rec.sum += v; rec.n++; priorPoints.set(p.key, rec);
    }

    if (!format.churn || week >= format.playoffWeeks[0]) continue;
    const avg = p => { const r = priorPoints.get(p.key); return r && r.n ? r.sum / r.n : -1; };
    const order = teams.map((t, i) => ({ t, i, pts: Object.values(weekly[i]).reduce((a, b) => a + b, 0) }))
      .sort((a, b) => a.pts - b.pts);
    for (const { t } of order) {
      const candidates = freeAgents.filter(p => !rostered.has(p.key) && avg(p) > 0)
        .sort((a, b) => avg(b) - avg(a));
      if (!candidates.length) break;
      const add = candidates[0];
      const starters = new Set(lineupFor(arm, t.players, week, format, priorPoints).map(p => p.key));
      const droppable = t.players.filter(p => !starters.has(p.key)).sort((a, b) => avg(a) - avg(b));
      if (!droppable.length) continue;
      const drop = droppable[0];
      if (avg(add) <= avg(drop)) continue;
      t.players = t.players.filter(p => p.key !== drop.key).concat(add);
      rostered.delete(drop.key); rostered.add(add.key);
    }
  }

  return { weekly, liveCount, regularWeeks: allWeeks.filter(w => w <= wEnd), playoffWeeks: format.playoffWeeks };
}

/* ----------------------------------------------------------------- outcomes */

/**
 * All-play (schedule-free) and head-to-head under a random schedule.
 *
 * The gap between them is schedule luck, and it is the headline luck number:
 * the published benchmark is about +/- 2 wins over a 14-game season, with the
 * all-play/H2H correlation near 0.82 in a 10-team league.
 */
export function outcomes(result, format, rand) {
  const n = result.weekly.length;
  const reg = result.regularWeeks;
  const ap = new Array(n).fill(0), apG = new Array(n).fill(0);
  const h2h = new Array(n).fill(0), h2hG = new Array(n).fill(0);
  const total = new Array(n).fill(0);

  for (const week of reg) {
    const pts = result.weekly.map(w => w[week] ?? 0);
    for (let i = 0; i < n; i++) {
      total[i] += pts[i];
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        apG[i]++;
        if (pts[i] > pts[j]) ap[i]++;
        else if (pts[i] === pts[j]) ap[i] += 0.5;
      }
    }
    // A fresh random pairing each week is the cleanest schedule randomiser and
    // reproduces the published luck band; a fixed round-robin would understate
    // it in short seasons.
    const order = shuffle([...Array(n).keys()], rand);
    for (let k = 0; k + 1 < order.length; k += 2) {
      const a = order[k], b = order[k + 1];
      h2hG[a]++; h2hG[b]++;
      if (pts[a] > pts[b]) h2h[a]++; else if (pts[b] > pts[a]) h2h[b]++;
      else { h2h[a] += 0.5; h2h[b] += 0.5; }
    }
  }

  const teams = [...Array(n).keys()].map(i => ({
    idx: i,
    all_play: apG[i] ? ap[i] / apG[i] : 0,
    h2h: h2hG[i] ? h2h[i] / h2hG[i] : 0,
    points: +total[i].toFixed(1),
    ppg: +(total[i] / reg.length).toFixed(1),
    luck_wins: +(((h2hG[i] ? h2h[i] / h2hG[i] : 0) - (apG[i] ? ap[i] / apG[i] : 0)) * h2hG[i]).toFixed(2),
    playoff_points: +format.playoffWeeks.reduce((s, w) => s + (result.weekly[i][w] ?? 0), 0).toFixed(1),
    live_wk14: result.liveCount[i][14] ?? null,
  }));

  // Seed on H2H record, break ties on points — the standard rule. The bracket
  // then plays on the REAL weeks 15-17 scores; replaying it would only reshuffle
  // seeding, since the points are fixed.
  const seeded = teams.slice().sort((a, b) => b.h2h - a.h2h || b.points - a.points);
  const field = seeded.slice(0, format.advance);
  let champion = null;
  if (field.length >= 2) {
    let alive = field.slice();
    for (const week of format.playoffWeeks) {
      if (alive.length === 1) break;
      const next = [];
      for (let k = 0; k < alive.length; k += 2) {
        const a = alive[k], b = alive[k + 1];
        if (!b) { next.push(a); continue; }
        const pa = result.weekly[a.idx][week] ?? 0, pb = result.weekly[b.idx][week] ?? 0;
        next.push(pa >= pb ? a : b);
      }
      alive = next;
    }
    champion = alive[0]?.idx ?? null;
  }
  return { teams, seeded: seeded.map(t => t.idx), champion };
}

/* -------------------------------------------------------------- one replay */

export function runLeague(season, format, agentList, seed) {
  const rand = rng(seed);
  const teams = draft(season, format, agentList, rand);
  const arms = {};
  for (const arm of format.bestBall ? ['hindsight'] : ['attainable', 'naive', 'hindsight']) {
    // Each arm re-drafts from the same seed so rosters are identical and only
    // the lineup policy differs. Churn mutates the roster, so a fresh copy is
    // required or the arms would contaminate each other.
    const copy = teams.map(t => ({ ...t, players: t.players.slice() }));
    const played = playSeason(copy, season, format, arm, rng(seed + 1));
    arms[arm] = { ...outcomes(played, format, rng(seed + 2)), rosters: copy };
  }
  return { arms, teams };
}

export { loadSeason, playedStats };
