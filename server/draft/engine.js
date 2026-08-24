// Pure draft-logic: no DB access, no I/O. Everything here is a deterministic
// function of its inputs so it can be unit-tested directly and reused by both
// the transactional store and any future simulator/backtest.

export const ORDER_TYPES = ['snake', 'linear', 'third_round_reversal'];

export function roundOf(pickNumber, teamCount) {
  return Math.ceil(pickNumber / teamCount);
}

export function posInRoundOf(pickNumber, teamCount) {
  return ((pickNumber - 1) % teamCount) + 1;
}

/**
 * True if `round` is drafted in ascending team-slot order (1..N) rather than
 * descending (N..1), for the given order type.
 *
 * third_round_reversal: rounds 1 follows normal snake (ascending). Round 2
 * reverses as usual (descending). Round 3 repeats round 2's direction
 * (descending again, instead of reversing back to ascending) — this is the
 * "reversal" a TRR draft is named for. From round 4 on, normal snake
 * alternation resumes, but shifted by the extra repeated round: even rounds
 * ascend, odd rounds (other than 1) descend.
 */
function isAscendingRound(round, orderType) {
  switch (orderType) {
    case 'linear':
      return true;
    case 'third_round_reversal':
      if (round === 1) return true;
      if (round === 2 || round === 3) return false;
      return round % 2 === 0;
    case 'snake':
    default:
      return round % 2 === 1;
  }
}

/** Which team slot (1..teamCount) is on the clock for this overall pick number. */
export function slotForPick(pickNumber, teamCount, orderType = 'snake') {
  if (!ORDER_TYPES.includes(orderType)) throw new Error(`unknown draft order_type: ${orderType}`);
  const round = roundOf(pickNumber, teamCount);
  const pos = posInRoundOf(pickNumber, teamCount);
  return isAscendingRound(round, orderType) ? pos : teamCount - pos + 1;
}

/** Every overall pick number (in the current draft) that belongs to `slot`. */
export function pickNumbersForSlot(slot, teamCount, rounds, orderType = 'snake') {
  const out = [];
  for (let p = 1; p <= teamCount * rounds; p++) {
    if (slotForPick(p, teamCount, orderType) === slot) out.push(p);
  }
  return out;
}

export const DEFAULT_ROSTER_POSITIONS = {
  QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 0, K: 1, DEF: 1, BENCH: 6
};

const FLEX_ELIGIBLE = ['RB', 'WR', 'TE'];
const SUPERFLEX_ELIGIBLE = ['QB', 'RB', 'WR', 'TE'];

/**
 * Assigns a roster of drafted players (each { position, ...rest }) into
 * starting slots per `rosterPositions`, filling dedicated positional slots
 * first, then FLEX (RB/WR/TE), then SUPERFLEX (QB/RB/WR/TE), then BENCH.
 * Deterministic: within a slot, earlier-drafted players (array order) are
 * preferred, so this is stable given the same picks in the same order.
 *
 * Returns { assigned: { [slot]: player[] }, unfilled: { [slot]: count }, bench: player[] }.
 */
export function assignRosterSlots(players, rosterPositions = DEFAULT_ROSTER_POSITIONS) {
  const remaining = [...players];
  const take = (predicate, count) => {
    const out = [];
    for (let i = 0; i < remaining.length && out.length < count; ) {
      if (predicate(remaining[i])) out.push(remaining.splice(i, 1)[0]);
      else i++;
    }
    return out;
  };

  const assigned = {};
  const dedicatedSlots = Object.keys(rosterPositions).filter(s => !['FLEX', 'SUPERFLEX', 'BENCH'].includes(s));
  for (const slot of dedicatedSlots) {
    assigned[slot] = take(p => p.position === slot, rosterPositions[slot] ?? 0);
  }
  if ('FLEX' in rosterPositions) {
    assigned.FLEX = take(p => FLEX_ELIGIBLE.includes(p.position), rosterPositions.FLEX ?? 0);
  }
  if ('SUPERFLEX' in rosterPositions) {
    assigned.SUPERFLEX = take(p => SUPERFLEX_ELIGIBLE.includes(p.position), rosterPositions.SUPERFLEX ?? 0);
  }
  const benchCap = rosterPositions.BENCH ?? Infinity;
  const bench = remaining.slice(0, benchCap);
  const overflow = remaining.slice(benchCap);

  const unfilled = {};
  for (const slot of [...dedicatedSlots, ...(('FLEX' in rosterPositions) ? ['FLEX'] : []), ...(('SUPERFLEX' in rosterPositions) ? ['SUPERFLEX'] : [])]) {
    const need = rosterPositions[slot] ?? 0;
    const have = assigned[slot]?.length ?? 0;
    if (have < need) unfilled[slot] = need - have;
  }

  return { assigned, unfilled, bench: [...bench, ...overflow] };
}

export function totalPicks(draft) {
  return draft.team_count * draft.rounds;
}

export function isDraftComplete(draft, picksMade) {
  return picksMade >= totalPicks(draft);
}
