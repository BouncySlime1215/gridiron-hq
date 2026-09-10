/**
 * The T−60 decision-time protocol (Codex plan section 6.3).
 *
 * The initial prospective decision time is 60 minutes before each game's
 * scheduled kickoff. That single sentence breaks the existing weekly policy
 * in a way that is easy to miss and impossible to work around by tuning:
 *
 *   `nfl-policy.js` ranks the ENTIRE week's candidates against each other
 *   and keeps the best five. At Thursday's T−60 cutoff, Sunday's and
 *   Monday's T−60 inputs DO NOT EXIST YET. There is no way to know whether
 *   Thursday's candidate would have made the week's top five, because four
 *   fifths of the week has not happened. Reusing the weekly ranking
 *   retrospectively — scoring Thursday's decision against candidates that
 *   only appeared on Sunday — is look-ahead, not a capacity rule.
 *
 * So capacity has to become SEQUENTIAL. This module implements exactly what
 * section 6.3 specifies: process cutoff batches in chronological order, rank
 * only the candidates available within the same batch, consume the remaining
 * predeclared weekly slots, and preserve the exclusions that happen once
 * capacity is gone. A slot is RESERVED on selection, COMMITTED on a
 * qualifying acceptance, and RELEASED on failed refresh or expiry — and
 * released capacity becomes available only to LATER batches, never
 * retroactively to an earlier one that was already excluded.
 *
 * Everything here is a pure function of its inputs (no clock, no database),
 * because the protocol's own requirement is that a replay of the same frozen
 * cutoff batches reproduces the same decisions.
 */

export const T60_PROTOCOL_VERSION = 'nfl-t60-protocol-v1';
export const DECISION_LEAD_MINUTES = 60;

/**
 * The decision instant for one scheduled kickoff, plus the schedule version
 * that established it. Section 6.3: "Save the schedule version that
 * established the cutoff" — a rescheduled game gets a NEW cutoff, and the
 * decision that was made against the old one has to remain identifiable
 * rather than being silently re-pointed at the new time.
 */
export function decisionCutoff(kickoff, { scheduleVersion = null, leadMinutes = DECISION_LEAD_MINUTES } = {}) {
  const at = new Date(kickoff).getTime();
  if (!Number.isFinite(at)) return null;
  return {
    kickoff: new Date(at).toISOString(),
    cutoff_at: new Date(at - leadMinutes * 60000).toISOString(),
    lead_minutes: leadMinutes,
    schedule_version: scheduleVersion,
    protocol_version: T60_PROTOCOL_VERSION
  };
}

/**
 * Group scheduled games into chronological cutoff BATCHES.
 *
 * Games kicking off at the same time share one decision instant and are
 * therefore genuinely comparable to each other — they are the only
 * candidates that can legitimately be ranked against one another. Batches
 * are ordered by cutoff, which is the order the real week happens in.
 */
export function cutoffBatches(games, { leadMinutes = DECISION_LEAD_MINUTES } = {}) {
  const byCutoff = new Map();
  for (const game of games ?? []) {
    const cutoff = decisionCutoff(game.kickoff, { scheduleVersion: game.schedule_version, leadMinutes });
    if (!cutoff) continue;
    const bucket = byCutoff.get(cutoff.cutoff_at) ?? { cutoff_at: cutoff.cutoff_at, kickoff: cutoff.kickoff, games: [] };
    bucket.games.push({ ...game, ...cutoff });
    byCutoff.set(cutoff.cutoff_at, bucket);
  }
  return [...byCutoff.values()].sort((a, b) => a.cutoff_at.localeCompare(b.cutoff_at));
}

/**
 * Slot lifecycle (section 6.3): reserved on selection, committed on a
 * qualifying paper observation/acceptance, released on failed refresh or
 * expiry. A PENDING reservation counts against the cap — capacity that might
 * still be used is not capacity that is free.
 */
export const SLOT_STATES = Object.freeze(['reserved', 'committed', 'released']);

/**
 * Run one week's cutoff batches through the sequential capacity policy.
 *
 * `batches` come from `cutoffBatches`. Each batch's `candidates` are the
 * eligible candidates known AT that batch's cutoff — nothing later. `outcomes`
 * optionally maps a candidate id to 'committed' or 'released', standing in
 * for what the refresh/acceptance step later reported.
 *
 * Returns every decision in chronological order, including the ones excluded
 * for capacity, because "preserve exclusions after capacity is reached" is
 * the whole reason a sequential policy can be evaluated at all.
 */
export function sequentialCapacity(batches, { weeklySlots = 5, outcomes = {} } = {}) {
  const decisions = [];
  const slots = [];
  let released = 0;

  for (const batch of batches ?? []) {
    // Capacity available to THIS batch: the weekly cap minus slots still
    // reserved or already committed. A slot released by an earlier batch
    // returns to the pool here — for LATER batches only, never retroactively
    // to the earlier batch that was already excluded.
    const held = slots.filter(s => s.state === 'reserved' || s.state === 'committed').length;
    let available = Math.max(0, weeklySlots - held);

    // Rank only within the batch. Candidates in a later batch do not exist
    // yet and must never influence this decision.
    const ranked = [...(batch.candidates ?? [])]
      .sort((a, b) => (b.edge_points ?? 0) - (a.edge_points ?? 0)
        || String(a.id).localeCompare(String(b.id)));

    for (const candidate of ranked) {
      if (available > 0) {
        const outcome = outcomes[candidate.id] ?? 'reserved';
        const state = SLOT_STATES.includes(outcome) ? outcome : 'reserved';
        slots.push({ id: candidate.id, cutoff_at: batch.cutoff_at, state });
        if (state === 'released') released++;
        available -= 1;
        decisions.push({ ...candidate, cutoff_at: batch.cutoff_at, selected: true,
          slot_state: state, exclusion_reason: null });
      } else {
        decisions.push({ ...candidate, cutoff_at: batch.cutoff_at, selected: false,
          slot_state: null, exclusion_reason: 'weekly_capacity_exhausted_at_this_cutoff' });
      }
    }
  }

  const committed = slots.filter(s => s.state === 'committed').length;
  const reserved = slots.filter(s => s.state === 'reserved').length;
  return {
    protocol_version: T60_PROTOCOL_VERSION,
    weekly_slots: weeklySlots,
    decisions,
    slots,
    summary: {
      selected: decisions.filter(d => d.selected).length,
      excluded_for_capacity: decisions.filter(d => d.exclusion_reason).length,
      reserved, committed, released,
      note: 'Ranked within each cutoff batch only. A candidate excluded for capacity at an earlier cutoff is ' +
        'never revisited when a later slot frees up — that would be deciding an earlier bet with later ' +
        'information, which is the exact look-ahead this policy exists to prevent.'
    }
  };
}

/**
 * What the OLD weekly policy would have selected, given the same candidates.
 *
 * Kept deliberately, and only for comparison: it is what the existing
 * `nfl-policy.js` capacity rule does (rank the whole week, keep the top N),
 * and section 6.3's point is that this is NOT reproducible at T−60. Running
 * both side by side makes the difference measurable instead of asserted.
 */
export function retrospectiveWeeklyCapacity(batches, { weeklySlots = 5 } = {}) {
  const all = (batches ?? []).flatMap(b => (b.candidates ?? []).map(c => ({ ...c, cutoff_at: b.cutoff_at })));
  const ranked = [...all].sort((a, b) => (b.edge_points ?? 0) - (a.edge_points ?? 0)
    || String(a.id).localeCompare(String(b.id)));
  const selected = new Set(ranked.slice(0, weeklySlots).map(c => c.id));
  return {
    decisions: all.map(c => ({ ...c, selected: selected.has(c.id) })),
    selected_ids: [...selected],
    caveat: 'NOT a T-60-reproducible policy: ranking the whole week against itself requires candidates that do ' +
      'not exist at an earlier cutoff. Provided only as the comparison baseline for sequentialCapacity.'
  };
}
