import type { WarRoomView } from '../warroom/types';
import { offerBudgetOver, offerBudgetText } from '../warroom/offerBudget';

/** The weekly offer budget in the People header; the reads are warroom/offerBudget.ts. */
export default function OfferBudgetLine({ view, nameOf }: { view: WarRoomView | null | undefined; nameOf: (team: string) => string }) {
  const over = offerBudgetOver(view);
  if (!over.length) return null;
  return (
    <p className="rounded-xl bg-[var(--c-soft)] px-3 py-2 text-sm text-[var(--c-ink)]" role="status" data-testid="offer-budget">
      {over.map((o, i) => <span key={o.team}>{i > 0 && ' · '}{offerBudgetText(nameOf(o.team), o.used, o.limit)}</span>)}.
    </p>
  );
}
