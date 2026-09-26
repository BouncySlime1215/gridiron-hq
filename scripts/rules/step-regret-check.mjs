/**
 * STEP-REGRET, restated for the rules check (scripts/check-rules-everywhere.mjs). Deliberately NOT
 * imported from the code it checks (campaign/serve-regret.js, planner.js#stepRegretIndex): Nick's
 * rule, "every move beats doing nothing, per step", read straight off the served numbers.
 *
 * A served step's title_odds_delta is that step's own gain in title odds. A step whose own gain is
 * not above 0 breaks the rule. Returns one line per break: { move_id, where, step (1-based), delta }.
 */
export function servedStepRegret(entry) {
  const out = [];
  const moves = [];
  if (entry?.next_move?.status === 'ok' && entry.next_move.value) moves.push(['next_move', entry.next_move.value]);
  if (entry?.alternatives?.status === 'ok') for (const m of entry.alternatives.value ?? []) moves.push(['alternative', m]);
  for (const [where, m] of moves) {
    (m.steps ?? []).forEach((s, i) => {
      const d = s?.title_odds_delta;
      if (s?.kind === 'claim' || d?.status !== 'ok' || d.unit !== 'title_odds') return;
      if (!(Number(d.value) > 0)) out.push({ move_id: String(m.move_id), where, step: i + 1, delta: Number(d.value) });
    });
  }
  return out;
}
