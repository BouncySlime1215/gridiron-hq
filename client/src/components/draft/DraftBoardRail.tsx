/**
 * Every team, what they've filled, and what they still need — with the teams that
 * pick between now and my turn lifted to the top and highlighted, since those are
 * the ones who can take my guy.
 */
export default function DraftBoardRail({ teamNeeds, teamCounts, picksBefore, mySlot, rosterSlots }: {
  teamNeeds?: Record<string, { team?: string; needs?: string[] }> | null;
  teamCounts?: Record<string, Record<string, number>> | null;
  picksBefore?: { pick: number; slot: number; team?: string; needs?: string[] }[] | null;
  mySlot?: number | null;
  rosterSlots?: Record<string, number> | null;
}) {
  const slots = Object.keys(teamNeeds ?? {}).map(Number).sort((a, b) => a - b);
  if (!slots.length) return <p className="text-xs text-slate-400">Board appears once the draft is linked.</p>;

  const beforeMe = new Map<number, number>();
  for (const p of picksBefore ?? []) if (!beforeMe.has(p.slot)) beforeMe.set(p.slot, p.pick);

  const starterTotal = Object.entries(rosterSlots ?? {})
    .filter(([k]) => !/^(BE|BN|BENCH|IR)/i.test(k))
    .reduce((a, [, n]) => a + (Number(n) || 0), 0) || null;

  const ordered = [
    ...slots.filter(s => beforeMe.has(s)).sort((a, b) => beforeMe.get(a)! - beforeMe.get(b)!),
    ...slots.filter(s => !beforeMe.has(s))
  ];

  return (
    <div className="space-y-1">
      {beforeMe.size > 0 && (
        <div className="text-[10px] font-bold uppercase tracking-wide text-amber-700 mb-1">
          {beforeMe.size} pick{beforeMe.size === 1 ? '' : 's'} before your turn
        </div>
      )}
      {ordered.map(slot => {
        const t = teamNeeds?.[slot];
        const counts = teamCounts?.[slot] ?? {};
        const filled = Object.entries(counts).filter(([, n]) => n > 0);
        const total = Object.values(counts).reduce((a, n) => a + n, 0);
        const isMe = slot === mySlot;
        const pickNo = beforeMe.get(slot);
        const needs = t?.needs ?? [];
        return (
          <div key={slot}
            className={`rounded-lg border px-2 py-1.5 ${isMe ? 'bg-sky-50 border-sky-200' : pickNo != null ? 'bg-amber-50/70 border-amber-200' : 'bg-white border-slate-100'}`}>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[10px] font-bold text-slate-400 w-4 text-center tabular-nums">{slot}</span>
              <span className="text-xs font-semibold truncate flex-1">{t?.team ?? `Slot ${slot}`}{isMe ? ' (you)' : ''}</span>
              {pickNo != null && <span className="text-[10px] font-bold text-amber-700 tabular-nums shrink-0">#{pickNo}</span>}
              <span className="text-[10px] text-slate-400 tabular-nums shrink-0" title="players drafted / starter slots">
                {total}{starterTotal ? ` · ${Math.min(total, starterTotal)}/${starterTotal} st` : ''}
              </span>
            </div>
            <div className="flex items-center gap-1 flex-wrap mt-1 pl-6">
              {filled.map(([pos, n]) => (
                <span key={pos} className="text-[9px] font-semibold px-1 py-px rounded bg-slate-100 text-slate-600 tabular-nums">{pos}{n > 1 ? `×${n}` : ''}</span>
              ))}
              {needs.length > 0 ? (
                <>
                  <span className="text-[9px] text-slate-400 ml-1">needs</span>
                  {needs.map(n => (
                    <span key={n} className="text-[9px] font-bold px-1 py-px rounded bg-amber-100 text-amber-800 tabular-nums">{n}</span>
                  ))}
                </>
              ) : (
                <span className="text-[9px] text-slate-400 ml-1">starters set</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
