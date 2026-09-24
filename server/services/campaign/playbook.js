/**
 * CAMPAIGN-01b: the per-step playbook (pure).
 *
 *   priceLadder   opening offer and walk-away, read off the P(accept) curve.
 *                 His indifference point is the package whose market value
 *                 matches what he gives (0% on his screen). Nick's walk-away is
 *                 where the deal stops beating his best alternative (the BATNA:
 *                 the backup branch's expected gain), so he never pays more than
 *                 the next-best plan is worth.
 *   stepMessage   a copyable message framed on HIS needs, stating only engine
 *                 facts that are attached to it as `facts` (each with its field).
 *                 No title odds, no claims about his team beyond the engine's
 *                 needs read, nothing invented.
 *   replyTable    accept / decline / counter / silence -> what to do.
 *
 * P(accept) is today's model (trade-acceptance.js acceptanceBand midpoint): not
 * fitted, validated by nothing beyond the activity AUC. Every number built on it
 * carries that label.
 */

export const P_ACCEPT_LABEL = "today's model (trade-acceptance.js band midpoint; unvalidated, E1 pending)";
/** Nudge after this long without a reply, switch to the backup after SWITCH_HOURS (hand-set). */
export const NUDGE_HOURS = 24;
export const SWITCH_HOURS = 48;

/**
 * curve: [{ give: ids, his_pct: % on his screen (what he gets vs gives), p, nick_gain }]
 *   his_pct   > 0 means he gets more market value than he gives
 *   nick_gain Nick's expected gain for this package: p x delta (objective units)
 * batna: Nick's expected gain from his best alternative (0 when none).
 * mode: all_in opens at the indifference point instead of below it.
 *
 * Returns { opening, indifference, walk_away, ladder, reason } with curve points (or null).
 */
export function priceLadder(curve, { batna = 0, mode = 'balanced' } = {}) {
  const pts = curve.filter(c => Number.isFinite(c.his_pct) && Number.isFinite(c.p) && Number.isFinite(c.nick_gain))
    .sort((a, b) => a.his_pct - b.his_pct);
  if (!pts.length) return { opening: null, indifference: null, walk_away: null, ladder: [], reason: 'no priced packages' };
  const worth = pts.filter(c => c.nick_gain > batna);
  if (!worth.length) {
    return { opening: null, indifference: null, walk_away: null, ladder: [],
      reason: 'no package beats your next-best plan, so there is no price worth offering' };
  }
  const indifference = worth.reduce((a, b) => (Math.abs(b.his_pct) < Math.abs(a.his_pct) ? b : a));
  // Walk-away: the richest package for HIM (highest his_pct) that still beats the BATNA for Nick.
  const walk_away = worth[worth.length - 1];
  // Opening: below his indifference (he gets a bit less), the best P x gain among those; all-in opens at it.
  const below = worth.filter(c => c.his_pct < indifference.his_pct);
  const opening = mode === 'all_in' || !below.length
    ? indifference
    : below.reduce((a, b) => (b.nick_gain > a.nick_gain ? b : a));
  const ladder = worth.filter(c => c.his_pct >= opening.his_pct && c.his_pct <= walk_away.his_pct);
  return { opening, indifference, walk_away, ladder, reason: null };
}

const posList = needs => (Array.isArray(needs) ? needs : needs ? Object.keys(needs) : []).map(String);

/**
 * The message for one step. `ctx.players` id -> { name, position, ros_ppg, bye }; `ctx.needs`: the
 * engine's read of his thin positions (counterpartyLayer `needs`), or null.
 * Returns { text, facts: [{ text, field }], checked: true } — checked means every sentence with a
 * number is built from a listed fact, nothing else.
 */
export function stepMessage(step, ctx) {
  const P = id => ctx.players.get(String(id)) ?? ctx.players.get(Number(id)) ?? { name: `player ${id}` };
  const facts = [];
  const gives = step.give.map(P), gets = step.get.map(P);
  const needs = posList(ctx.needs);
  const fits = gives.filter(g => needs.includes(String(g.position)));
  const lines = [];
  if (fits.length) {
    const g = fits[0];
    lines.push(`Looks like you could use a ${g.position}.`);
    facts.push({ text: `his roster read lists ${g.position} as a need`, field: 'counterparty.needs' });
  }
  for (const g of gives) {
    if (Number.isFinite(g.ros_ppg) && g.ros_ppg > 0) {
      lines.push(`${g.name} projects ${g.ros_ppg.toFixed(1)} pts a game the rest of the way.`);
      facts.push({ text: `${g.name} ros_ppg ${g.ros_ppg.toFixed(1)}`, field: 'asset.ros_ppg' });
    }
  }
  const names = list => list.map(x => x.name).join(' + ');
  lines.push(`Would you do ${names(gives)} for ${names(gets)}?`);
  return { text: lines.join(' '), facts, checked: true, source: 'template' };
}

/**
 * The reply table for step i of a plan.
 * ctx: { next: step or null, backup: { step, expected } or null, ladder: priceLadder result,
 *        nudge: message text or null }
 */
export function replyTable(step, ctx) {
  const deal = s => (s ? { partner: s.team, give: s.give, get: s.get } : null);
  const rows = [];
  rows.push(ctx.next
    ? { kind: 'accept', do: `Send the next step to Team ${ctx.next.team}.`, next: deal(ctx.next) }
    : { kind: 'accept', do: 'That completes the plan. The brain proposes the next campaign on the next refresh.' });
  rows.push(ctx.backup?.step
    ? { kind: 'decline', do: `Log the reason, then offer Team ${ctx.backup.step.team} instead.`, next: deal(ctx.backup.step),
      expected_after: ctx.backup.expected ?? null,
      learn: 'a decline lowers his estimated yes-rate for packages this size' }
    : { kind: 'decline', do: 'Log the reason. No backup clears the sliders this week; the brain replans on the next refresh.',
      learn: 'a decline lowers his estimated yes-rate for packages this size' });
  const L = ctx.ladder ?? {};
  if (L.walk_away) {
    const nextRung = (L.ladder ?? []).find(c => c.his_pct > (L.opening?.his_pct ?? -Infinity)) ?? null;
    rows.push({ kind: 'counter', do: 'Check his ask against the walk-away.',
      counter_rules: {
        accept_if: `his ask is no richer than the walk-away package (walk_away_give; his screen ${L.walk_away.his_pct >= 0 ? '+' : ''}${L.walk_away.his_pct.toFixed(0)}%)`,
        counter_with: nextRung ? `the next rung: ${nextRung.give.join(' + ')} (his screen ${nextRung.his_pct >= 0 ? '+' : ''}${nextRung.his_pct.toFixed(0)}%)` : 'repeat the opening once, then hold',
        walk_away_if: 'his ask is richer than the walk-away package: your backup plan is worth more',
      },
      walk_away_give: L.walk_away.give, next_rung_give: nextRung?.give ?? null });
  } else {
    rows.push({ kind: 'counter', do: 'No walk-away could be priced; decline any counter that adds players on your side.' });
  }
  rows.push({ kind: 'silence', when: `no reply in ${NUDGE_HOURS} h`,
    do: `Send one nudge. After ${SWITCH_HOURS} h with no answer, withdraw and use the backup.`,
    message: ctx.nudge ?? 'Any interest in this one? Happy to tweak it.' });
  return rows;
}
