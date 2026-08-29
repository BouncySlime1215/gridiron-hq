/**
 * Who will still be there at your next pick.
 *
 * Every draft board answers "who is the best player available". That is rarely
 * the decision. The decision is which player to take NOW given that some of the
 * others will still be sitting there in two rounds — and a board sorted by
 * value cannot express that, because it has no model of what the other nine
 * managers are about to do.
 *
 * So this simulates the rest of the draft. Ten thousand times, other teams pick
 * according to a noisy ADP model, and we count how often each player survives
 * to each of your remaining picks. The output is the sentence a board cannot
 * produce: "take the back now — the receiver comes back to you 71% of the time,
 * the back only 12%."
 *
 * THE OPPONENT MODEL, stated plainly because it is the load-bearing assumption:
 * drafters follow ADP with noise. Not perfectly — everyone reaches and everyone
 * has runs — but ADP is the consensus of exactly the behaviour being modelled,
 * and a Gaussian jitter on draft position reproduces both reaches and slides
 * without pretending to know any individual manager's board. What it cannot
 * model is positional runs, so survival for a scarce position is, if anything,
 * slightly optimistic. That is stated in the output rather than hidden.
 */
import { vorBoard } from '../routes/edge.js';
import { randn, withRandomSeed } from './stats-util.js';

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

/**
 * Snake-draft pick numbers belonging to one seat.
 *
 * Overall pick numbers are 1-indexed. In a snake the order reverses each round,
 * so seat 1 picks 1st and then last in round two — getting this wrong would
 * misstate every gap this module exists to measure.
 */
export function myPickNumbers({ seat, teams, rounds }) {
  const picks = [];
  for (let round = 1; round <= rounds; round++) {
    const inRound = round % 2 === 1 ? seat : teams - seat + 1;
    picks.push((round - 1) * teams + inRound);
  }
  return picks;
}

/**
 * @param taken      player ids already off the board
 * @param seat       1-indexed draft slot
 * @param adpNoise   standard deviation, in picks, of how far a drafter strays
 *   from consensus. ~9 reproduces observed reach/slide behaviour; larger values
 *   flatten survival toward 50% for everyone, which is the failure mode to
 *   watch for if this is ever tuned.
 */
export function draftSurvival({
  seat = 1, teams = 10, rounds = 15, taken = [], trials = 4000,
  adpNoise = 9, seed = 7
} = {}) {
  const board = vorBoard(teams).filter(p => p.adp != null);
  if (board.length < teams * 3) {
    return { error: `only ${board.length} players carry an ADP — not enough to simulate a draft` };
  }

  const takenSet = new Set((taken ?? []).map(Number));
  const pool = board.filter(p => !takenSet.has(p.id));
  const picksMade = takenSet.size;

  const myPicks = myPickNumbers({ seat, teams, rounds }).filter(p => p > picksMade);
  if (!myPicks.length) return { error: 'no picks remaining for that seat' };
  const nextPick = myPicks[0];

  // survival[playerId][k] = times this player was still available at my k-th
  // remaining pick.
  const survived = new Map();
  for (const p of pool) survived.set(p.id, new Array(myPicks.length).fill(0));

  const lastPick = myPicks[myPicks.length - 1];

  withRandomSeed(seed, () => {
    for (let t = 0; t < trials; t++) {
      const gone = new Set();
      let myIdx = 0;

      for (let pick = picksMade + 1; pick <= lastPick; pick++) {
        if (myIdx < myPicks.length && pick === myPicks[myIdx]) {
          // My own pick: record who made it here, then assume I take the best
          // available so the simulation keeps moving realistically.
          for (const p of pool) if (!gone.has(p.id)) survived.get(p.id)[myIdx]++;
          const mine = pool.find(p => !gone.has(p.id));
          if (mine) gone.add(mine.id);
          myIdx++;
          continue;
        }
        // Someone else picks: the lowest jittered ADP still on the board.
        let bestId = null, bestScore = Infinity;
        for (const p of pool) {
          if (gone.has(p.id)) continue;
          const score = p.adp + randn() * adpNoise;
          if (score < bestScore) { bestScore = score; bestId = p.id; }
        }
        if (bestId != null) gone.add(bestId);
      }
    }
  });

  const players = pool.slice(0, 60).map(p => {
    const counts = survived.get(p.id) ?? [];
    return {
      id: p.id, name: p.name, position: p.position, team_abbr: p.team_abbr,
      adp: p.adp, vor: p.vor, proj: p.proj != null ? +p.proj.toFixed(1) : null,
      // Chance he is still there at each of my remaining picks, in order.
      survival: counts.map(c => r3(c / trials)),
      survives_next: r3((counts[0] ?? 0) / trials),
      survives_pick_after: counts.length > 1 ? r3(counts[1] / trials) : null
    };
  });

  // The decision this module exists for: among players available now, which are
  // likely to come back to me, and which will not. Anyone very likely to
  // survive is not a player to spend this pick on.
  const available = players.filter(p => p.survives_next > 0.5);
  const willVanish = available
    .filter(p => (p.survives_pick_after ?? 0) < 0.35)
    .sort((a, b) => (b.vor ?? 0) - (a.vor ?? 0)).slice(0, 8);
  const willKeep = available
    .filter(p => (p.survives_pick_after ?? 0) >= 0.6)
    .sort((a, b) => (b.vor ?? 0) - (a.vor ?? 0)).slice(0, 8);

  return {
    seat, teams, rounds, trials, adp_noise: adpNoise,
    picks_made: picksMade, next_pick: nextPick,
    my_remaining_picks: myPicks.slice(0, 6),
    players,
    take_now: willVanish,
    can_wait: willKeep,
    // The actionable comparison, phrased the way the decision is actually made.
    guidance: willVanish.length && willKeep.length
      ? `Take ${willVanish[0].name} now — he is gone by pick ${myPicks[1] ?? '?'} ` +
        `${Math.round((1 - (willVanish[0].survives_pick_after ?? 0)) * 100)}% of the time. ` +
        `${willKeep[0].name} does not need this pick; he comes back to you ` +
        `${Math.round((willKeep[0].survives_pick_after ?? 0) * 100)}% of the time.`
      : 'No sharp split between players who vanish and players who return at this pick.',
    note: 'Other managers are modelled as drafting to ADP with Gaussian noise, which reproduces ' +
      'reaches and slides but NOT positional runs — so survival at a scarce position is, if ' +
      'anything, slightly optimistic. My own picks are simulated as best-available so the board ' +
      'keeps moving.'
  };
}
