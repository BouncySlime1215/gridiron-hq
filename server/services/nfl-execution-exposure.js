/**
 * Aggregate game/player exposure budget.
 *
 * Every module in this package so far reasons about ONE opportunity. This one
 * is the check that looks across all of them at once: three "independent"
 * middles on the same game, or a full-role bet and a backup-share bet on the
 * same player, are not three independent risks just because they are priced
 * as separate contracts. `staking.js` already has a correlation-aware
 * portfolio check (`slateRiskCheck`) for a whole week of MODEL-derived bets;
 * this is the simpler, deterministic sibling for the execution ledger — a
 * hard cap per game, per participant and in aggregate, checked BEFORE a new
 * ACCEPTED state is ever recorded (see `nfl-execution-decision.js`).
 *
 * Deliberately not correlation-weighted: an exact-contract execution ledger
 * should fail closed on a simple, auditable cap rather than a fitted
 * correlation number that nobody can verify against this table alone.
 */
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

export const DEFAULT_EXPOSURE_BUDGET = Object.freeze({
  max_units_per_game: 3,
  max_units_per_participant: 2,
  max_units_total: 8
});

/**
 * Would adding `candidate` to the currently-open (ACCEPTED, not yet SETTLED)
 * exposure breach any cap? Every cap is evaluated against the exposure AFTER
 * the candidate is added — the whole point of a budget is that it blocks the
 * bet that would cross the line, not just the ones that already have.
 *
 * `openExposures` / `candidate`: `{ event_key, participant, stake_units }`.
 * `participant` is null for a team-level spread/total; participant caps are
 * skipped for those, since there is no single participant to attribute them to.
 */
export function checkExposureBudget({ openExposures = [], candidate, budget = DEFAULT_EXPOSURE_BUDGET }) {
  if (!candidate || !Number.isFinite(candidate.stake_units) || candidate.stake_units <= 0) {
    throw new Error('candidate.stake_units must be a positive number');
  }
  const sameGame = openExposures.filter(o => o.event_key && o.event_key === candidate.event_key);
  const gameUnitsBefore = sameGame.reduce((sum, o) => sum + o.stake_units, 0);
  const gameUnitsAfter = gameUnitsBefore + candidate.stake_units;

  const sameParticipant = candidate.participant
    ? openExposures.filter(o => o.participant && o.participant === candidate.participant) : [];
  const participantUnitsBefore = sameParticipant.reduce((sum, o) => sum + o.stake_units, 0);
  const participantUnitsAfter = participantUnitsBefore + candidate.stake_units;

  const totalBefore = openExposures.reduce((sum, o) => sum + o.stake_units, 0);
  const totalAfter = totalBefore + candidate.stake_units;

  const reasons = [];
  if (gameUnitsAfter > budget.max_units_per_game) {
    reasons.push(`game exposure would reach ${r4(gameUnitsAfter)}u, over the ${budget.max_units_per_game}u ` +
      `cap for ${candidate.event_key ?? '(no event_key)'}`);
  }
  if (candidate.participant && participantUnitsAfter > budget.max_units_per_participant) {
    reasons.push(`participant exposure would reach ${r4(participantUnitsAfter)}u, over the ` +
      `${budget.max_units_per_participant}u cap for ${candidate.participant}`);
  }
  if (totalAfter > budget.max_units_total) {
    reasons.push(`total open exposure would reach ${r4(totalAfter)}u, over the ${budget.max_units_total}u ` +
      'aggregate cap');
  }

  return {
    allowed: reasons.length === 0, reasons, budget,
    game_units_after: r4(gameUnitsAfter),
    participant_units_after: candidate.participant ? r4(participantUnitsAfter) : null,
    total_units_after: r4(totalAfter)
  };
}

/**
 * Every open position sharing a "shock factor" (same game, same weather
 * system, same slate window — whatever the caller supplies) is exposure that
 * moves together, not exposure that is merely large. The worst case for a
 * correlated book is every position sharing a factor failing AT ONCE; the
 * worst case for a genuinely independent book is bounded by its single
 * largest position. Reporting both against the same total stake is what
 * makes a correlated slate and a diversified slate distinguishable, which a
 * flat exposure total alone cannot do.
 */
export function correlatedSlateShockLoss(positions = []) {
  const totalStaked = positions.reduce((sum, p) => sum + (p.stake_units ?? 0), 0);
  const byShockFactor = new Map();
  positions.forEach((p, index) => {
    // No shared factor supplied means this position is being treated as its
    // own independent group — keyed by its own identity (or index, as a last
    // resort) rather than a random value, so the same input always produces
    // the same grouping.
    const key = p.shock_factor ?? `unshared:${p.event_key ?? index}`;
    byShockFactor.set(key, (byShockFactor.get(key) ?? 0) + (p.stake_units ?? 0));
  });
  const groups = [...byShockFactor.entries()].map(([shock_factor, stake_units]) => ({ shock_factor, stake_units: r4(stake_units) }));
  const worstSharedShockLoss = groups.length ? Math.max(...groups.map(g => g.stake_units)) : 0;
  return {
    total_staked: r4(totalStaked),
    worst_shared_shock_loss: r4(worstSharedShockLoss),
    worst_case_share_of_book: totalStaked ? r4(worstSharedShockLoss / totalStaked) : null,
    by_shock_factor: groups.sort((a, b) => b.stake_units - a.stake_units),
    note: 'worst_shared_shock_loss is the largest single group of positions that share one factor — the ' +
      'loss if that factor breaks against every position in the group at once. It grows toward ' +
      'total_staked as a slate gets more correlated and shrinks toward the single largest position as ' +
      'it gets more diversified.'
  };
}
