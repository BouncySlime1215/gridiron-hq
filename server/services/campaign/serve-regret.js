/**
 * STEP-REGRET at the serve step: no served move may carry a step that does not
 * beat doing nothing on the numbers it is served with.
 *
 * Found 2026-09-26: league 3's alternative L3-lrer3n served step 2 at -0.17 pts of
 * title odds (0.085 then -0.0017). The planner's STEP-REGRET (planner.js#stepRegretIndex,
 * #481) drops such paths, but that plans file was produced by a run that started
 * before #481 reached the producer, and nothing downstream checked the served numbers.
 * So this is the same rule applied where the numbers are served: the producer writes
 * no such move, and every reader (the War Room view, Coach) holds one back if a file
 * carries it anyway.
 *
 * A served step's title_odds_delta is its own gain (view.js: st.delta - before). A
 * step fails when that is not above 0. A next move that fails is held back (the plan
 * says why); an alternative that fails is removed from the deck. Nothing is reordered
 * or recomputed; the deck's ranks close up (1..n) so the contract still holds.
 */

const ok = f => f?.status === 'ok';
const pts = d => `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)} pts`;

/** The first step of a served move whose own title-odds gain is not above 0, or null. */
export function regretStep(move) {
  for (const [k, s] of (move?.steps ?? []).entries()) {
    if (s?.kind === 'claim') continue;
    const d = s?.title_odds_delta;
    if (!ok(d) || d.unit !== 'title_odds') continue; // a plan scored on something else is judged by its own metric upstream
    if (!(Number(d.value) > 0)) return { step: k, delta: Number(d.value) };
  }
  return null;
}

/** Every served move in an entry that breaks STEP-REGRET: [{ move_id, where, step, delta }]. */
export function stepRegretBreaks(entry) {
  const out = [];
  if (ok(entry?.next_move)) {
    const r = regretStep(entry.next_move.value);
    if (r) out.push({ move_id: String(entry.next_move.value.move_id), where: 'next_move', ...r });
  }
  for (const m of ok(entry?.alternatives) ? entry.alternatives.value ?? [] : []) {
    const r = regretStep(m);
    if (r) out.push({ move_id: String(m.move_id), where: 'alternative', ...r });
  }
  return out;
}

/**
 * The entry with every STEP-REGRET break held back, and the list of what was.
 * -> { entry, held: [{ move_id, where, step, delta }] }. An entry with none comes back as is.
 */
export function holdStepRegret(entry) {
  const held = stepRegretBreaks(entry);
  if (!held.length) return { entry, held };
  const bad = new Set(held.map(h => h.move_id));
  const out = { ...entry };
  const nm = held.find(h => h.where === 'next_move');
  if (nm) {
    out.next_move = { status: 'unknown', source: 'plan.path',
      reason: `The served next move was held back: its step ${nm.step + 1} does not beat doing nothing (${pts(nm.delta)} of title odds).` };
  }
  if (ok(entry.alternatives)) {
    // The deck stays best first: the cards after a held one move up a rank (the contract numbers them 1..n).
    out.alternatives = { ...entry.alternatives, value: entry.alternatives.value.filter(m => !bad.has(String(m.move_id)))
      .map((m, i) => (m.rank == null ? m : { ...m, rank: i + 1 })) };
  }
  out._run = { ...(entry._run ?? {}), step_regret_served: held };
  return { entry: out, held };
}
