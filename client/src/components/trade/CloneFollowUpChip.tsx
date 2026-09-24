/**
 * CLONE-01b b2: after he declined a package, this is the cheapest one shown to him
 * that pays him more than the one he declined. The bound is his gain on the declined
 * package, in the engine's their_value_pct unit.
 */
export default function CloneFollowUpChip({ clone }: { clone?: any }) {
  const bound = clone?.follow_up?.above_bound_pct;
  if (typeof bound !== 'number') return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-3" data-clone-follow-up>
      <span className="text-[10px] font-semibold text-[var(--accent)] bg-[var(--accent-tint)] border border-[var(--accent)]/30 px-2 py-0.5 rounded-full"
        title={clone.follow_up.why}>
        Cheapest package above the price he declined ({bound > 0 ? '+' : ''}{bound}% for him)
      </span>
      {clone.preview && <span data-preview className="rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-800">Preview (unconfirmed forward)</span>}
    </div>
  );
}
