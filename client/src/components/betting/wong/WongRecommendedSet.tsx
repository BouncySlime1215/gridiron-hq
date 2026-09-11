import { useMemo, useState } from 'react';
import { useApi } from '../../../api';
import { TicketCard, candidateKey } from './TicketCard';
import { BackendNotReady, BlockedReasons, ConfirmAtBookWarning, Loading, Panel, Stat, StatRow } from './shared';
import { TeamLogo } from './TeamLogo';
import { bookLabel, dollars, pct, signedUnits } from './format';
import type { WongCandidate, WongCombos } from './types';

/**
 * The recommended set.
 *
 * The point of asking the server for a set rather than taking the top four
 * rows off the board is that overlap is invisible in a ranked list. Tickets
 * that share a leg are not four bets — they are one bet wearing four hats.
 */
export function WongRecommendedSet({ books, maxTickets, stakeUnits, unitSizeDollars, onTracked }: {
  books: string[]; maxTickets: number; stakeUnits: number;
  unitSizeDollars: number | null; onTracked: () => void;
}) {
  const [book, setBook] = useState(() => books[0] ?? 'draftkings');
  const [limit, setLimit] = useState(maxTickets);
  const active = books.includes(book) ? book : (books[0] ?? book);
  const { data, loading, error, refetch } = useApi<WongCombos | WongCandidate[]>(
    `/betting/wong/combos?book=${encodeURIComponent(active)}&maxTickets=${limit}`);

  const combos = useMemo(() => normalize(data), [data]);
  const tickets = combos.tickets;

  const legKeys = tickets.flatMap(ticket => (ticket.legs ?? []).map(leg => `${leg.event_id}:${leg.team}`));
  const overlapping = legKeys.length !== new Set(legKeys).size;
  const expectedProfit = combos.expected_profit_units ?? (tickets.length
    ? tickets.reduce((sum, ticket) => sum + (ticket.ev ?? 0) * stakeUnits, 0) : null);

  return <div className="space-y-4">
    <ConfirmAtBookWarning />

    <WhyNonOverlapping />

    <Panel
      eyebrow="One book, one week"
      title="Recommended set"
      description="The server picks the set; these controls only say which book and how many tickets."
      action={<div className="flex flex-wrap items-center gap-2">
        <label className="text-[11px] font-bold text-slate-500">
          Book
          <select value={active} onChange={event => setBook(event.target.value)}
            className="ml-1.5 rounded-md border border-slate-300 px-2 py-1 text-xs font-bold text-slate-800">
            {books.map(entry => <option key={entry} value={entry}>{bookLabel(entry)}</option>)}
          </select>
        </label>
        <label className="text-[11px] font-bold text-slate-500">
          Max tickets
          <input type="number" min={1} max={12} value={limit} aria-label="Maximum tickets in the set"
            onChange={event => setLimit(Math.min(12, Math.max(1, Number(event.target.value) || 1)))}
            className="ml-1.5 w-14 rounded-md border border-slate-300 px-2 py-1 text-xs font-bold tabular-nums text-slate-800" />
        </label>
      </div>}
    >
      <StatRow columns="sm:grid-cols-4">
        <Stat label="Tickets" value={tickets.length} detail={`at ${stakeUnits}u each`} />
        <Stat label="Legs used" value={new Set(legKeys).size} detail={overlapping ? 'Some leg is reused' : 'Each leg used once'}
          tone={overlapping ? 'warn' : 'neutral'} />
        <Stat label="Total staked" value={signedUnits(tickets.length * stakeUnits)}
          detail={unitSizeDollars != null ? dollars(tickets.length * stakeUnits * unitSizeDollars) : 'set a unit size'} />
        <Stat label="Expected profit" value={signedUnits(expectedProfit)}
          tone={expectedProfit != null && expectedProfit > 0 ? 'good' : 'neutral'}
          detail={combos.probability_of_losing_week != null
            ? `${pct(combos.probability_of_losing_week)} chance of a losing week`
            : 'sum of the set’s expected value'} />
      </StatRow>
    </Panel>

    {loading && !data ? <Loading label="Building the non-overlapping set…" />
      : error ? <BackendNotReady error={error} onRetry={refetch}
          endpoints={[`GET /api/betting/wong/combos?book=${active}&maxTickets=${limit}`]} />
      : tickets.length === 0 ? <BlockedReasons reasons={combos.blocked_reasons}
          title={`No non-overlapping set available at ${bookLabel(active)}`} />
      : <>
        {overlapping && <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs leading-5 text-amber-900">
          <b className="font-black">These tickets share a leg.</b> The set the server returned reuses at least one
          side, so they do not fail independently — a single wrong leg takes more than one ticket with it. Treat
          the combined stake as a single larger bet.
        </div>}
        <div className="space-y-3">
          {tickets.map((ticket, index) => <TicketCard key={candidateKey(active, ticket)}
            badge={`Ticket ${index + 1}`} book={active} candidate={ticket} stakeUnits={stakeUnits}
            unitSizeDollars={unitSizeDollars} onTracked={onTracked} />)}
        </div>
        <LegCoverage tickets={tickets} />
      </>}

    {combos.note && <p className="text-xs leading-5 text-slate-500">{combos.note}</p>}
  </div>;
}

/** Required, and one line: why the set is built this way. */
function WhyNonOverlapping() {
  return <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
    <div className="text-sm font-bold text-slate-800">Why these tickets share no legs</div>
    <p className="mt-1 text-xs leading-5 text-slate-600">
      Tickets that share a leg all die together. Four non-overlapping tickets carry roughly a 25% chance of a
      losing week against 43% for all 36 overlapping combinations of the same legs — at identical expected
      profit. Same edge, far less variance, for free.
    </p>
  </div>;
}

/** Which team is committed to which ticket, at a glance. */
function LegCoverage({ tickets }: { tickets: WongCandidate[] }) {
  return <Panel title="Legs in the set" description="Every side you are committed to this week, once each.">
    <div className="flex flex-wrap gap-2 p-4">
      {tickets.flatMap((ticket, ticketIndex) => (ticket.legs ?? []).map(leg =>
        <span key={`${ticketIndex}:${leg.event_id}:${leg.team}`}
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pl-1 pr-3">
          <TeamLogo team={leg.team} size={22} />
          <span className="text-xs font-bold text-slate-800">{leg.team}</span>
          <span className="text-[10px] font-bold text-slate-400">ticket {ticketIndex + 1}</span>
        </span>))}
    </div>
  </Panel>;
}

/**
 * `/combos` is documented as "the recommended non-overlapping ticket set"
 * without a fixed envelope, so the three shapes that phrase can take are all
 * accepted here rather than crashing the view on the one that arrives.
 */
function normalize(data: WongCombos | WongCandidate[] | null): WongCombos & { tickets: WongCandidate[] } {
  if (!data) return { tickets: [] };
  if (Array.isArray(data)) return { tickets: data };
  const tickets = data.tickets ?? data.combos ?? data.candidates ?? [];
  return { ...data, tickets: Array.isArray(tickets) ? tickets : [] };
}
