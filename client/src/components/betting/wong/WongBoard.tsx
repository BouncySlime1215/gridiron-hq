import { useMemo } from 'react';
import { TicketCard, candidateKey } from './TicketCard';
import { WongComparison } from './WongComparison';
import { BlockedReasons, ConfirmAtBookWarning, Panel, ProvenanceTag, Stat, StatRow } from './shared';
import { american, ago, bookLabel, dollars } from './format';
import type { WongBoard as Board, WongBookBoard, WongCapture } from './types';

/**
 * This week's board.
 *
 * Three things this surface is required to say, none of which are decoration:
 * where every number came from and how old it is, that a captured line is not
 * an executable price, and — when a book produces nothing — why. A book that
 * returns no candidates renders its reasons, never an empty table.
 */
export function WongBoard({
  board, refreshing, onRefresh, captures, refreshedAt, refreshError,
  stakeUnits, onStakeChange, unitSizeDollars, onTracked
}: {
  board: Board;
  refreshing: boolean;
  onRefresh: () => void;
  captures: WongCapture[] | null;
  refreshedAt: string | null;
  refreshError: string | null;
  stakeUnits: number;
  onStakeChange: (units: number) => void;
  unitSizeDollars: number | null;
  onTracked: () => void;
}) {
  const books = useMemo(() => [...(board.books ?? [])].sort((a, b) =>
    (b.candidates?.length ?? 0) - (a.candidates?.length ?? 0) || a.book.localeCompare(b.book)), [board.books]);
  const totalCandidates = books.reduce((sum, book) => sum + (book.candidates?.length ?? 0), 0);
  const totalQualifying = books.reduce((sum, book) => sum + (book.qualifying_legs ?? 0), 0);
  const totalStale = books.reduce((sum, book) => sum + (book.stale_legs ?? 0), 0);

  return <div className="space-y-4">
    <ConfirmAtBookWarning />

    <Panel
      eyebrow="This week only"
      title="Qualifying board"
      description={<>Pulled on demand, never on a timer. Nothing on this page updates until you press refresh.</>}
      action={<div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500">
          Stake
          <input type="number" min={0.25} step={0.25} value={stakeUnits} aria-label="Stake in units per ticket"
            onChange={event => onStakeChange(Math.max(0.25, Number(event.target.value) || 1))}
            className="w-16 rounded-md border border-slate-300 px-2 py-1 text-xs font-bold tabular-nums text-slate-800" />
          <span className="font-normal text-slate-400">
            units{unitSizeDollars != null ? ` · ${dollars(unitSizeDollars * stakeUnits)}` : ''}
          </span>
        </label>
        <button type="button" onClick={onRefresh} disabled={refreshing}
          className="rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-black text-white transition-colors hover:bg-emerald-700 disabled:opacity-60">
          {refreshing ? 'Pulling from books…' : 'Refresh from books'}
        </button>
      </div>}
      footer={<>Board generated {ago(board.generated_at)}{refreshedAt ? ` · last manual pull ${ago(refreshedAt)}` : ''}. Sorted by expected value only — see the note below.</>}
    >
      <StatRow>
        <Stat label="Books compared" value={books.length} detail={books.map(book => bookLabel(book.book)).join(', ') || 'none'} />
        <Stat label="Qualifying legs" value={totalQualifying} detail="Spreads inside the Wong window" />
        <Stat label="Tickets on the board" value={totalCandidates}
          tone={totalCandidates ? 'good' : 'quiet'} detail={totalCandidates ? 'Confirm each at the book' : 'Nothing qualifies right now'} />
        <Stat label="Stale legs excluded" value={totalStale} tone={totalStale ? 'warn' : 'quiet'}
          detail={totalStale ? 'Too old to price against' : 'Every captured leg is usable'} />
      </StatRow>

      {(captures || refreshError) && <div className="border-t border-slate-100 px-4 py-3">
        <div className="text-[10px] font-black uppercase tracking-[.12em] text-slate-400">Last pull</div>
        {refreshError && <p className="mt-1 text-xs font-semibold text-rose-700">{refreshError}</p>}
        {captures && <div className="mt-1.5 flex flex-wrap gap-1.5">
          {captures.map((capture, index) => <span key={`${capture.source}:${index}`}
            title={capture.error ?? undefined}
            className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${capture.ok
              ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-rose-300 bg-rose-50 text-rose-800'}`}>
            {capture.source} · {capture.ok ? `${capture.rows} rows` : (capture.error || 'failed')}
          </span>)}
        </div>}
      </div>}
    </Panel>

    <NoRankingNote />

    {books.length === 0
      ? <BlockedReasons reasons={[]} title="No book reported a board" />
      : books.map(book => <BookPanel key={book.book} book={book} stakeUnits={stakeUnits}
          unitSizeDollars={unitSizeDollars} onTracked={onTracked} />)}

    <WongComparison rows={board.comparison ?? []} />
  </div>;
}

function BookPanel({ book, stakeUnits, unitSizeDollars, onTracked }: {
  book: WongBookBoard; stakeUnits: number; unitSizeDollars: number | null; onTracked: () => void;
}) {
  const candidates = [...(book.candidates ?? [])].sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0));
  return <Panel
    title={bookLabel(book.book)}
    description={<span className="inline-flex flex-wrap items-center gap-2">
      <ProvenanceTag provenance={book.provenance} ageMinutes={book.age_minutes} source={book.source} />
      <span>{book.source}</span>
      <span className="text-slate-300">·</span>
      <span>{book.games_on_board} games · {book.qualifying_legs} qualifying legs
        {book.stale_legs ? ` · ${book.stale_legs} stale` : ''}</span>
    </span>}
    action={<div className="text-right">
      <div className="text-lg font-black tabular-nums text-slate-900">{american(book.price)}</div>
      <div className="text-[10px] text-slate-400">teaser payout</div>
    </div>}
  >
    <div className="space-y-3 p-4">
      {candidates.length === 0
        ? <BlockedReasons reasons={book.blocked_reasons} title={`${bookLabel(book.book)} produced no ticket`} />
        : candidates.map(candidate => <TicketCard key={candidateKey(book.book, candidate)}
            book={book.book} candidate={candidate} stakeUnits={stakeUnits}
            unitSizeDollars={unitSizeDollars} onTracked={onTracked} />)}
      {candidates.length > 0 && (book.blocked_reasons?.length ?? 0) > 0 &&
        <BlockedReasons reasons={book.blocked_reasons} title="Also excluded from this book" />}
    </div>
  </Panel>;
}

/**
 * The absence of a ranking column is a finding, not an oversight, so the page
 * says so where the ranking would have gone.
 */
function NoRankingNote() {
  return <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
    <div className="text-sm font-bold text-slate-800">There is no confidence column, and that is the result</div>
    <p className="mt-1 text-xs leading-5 text-slate-600">
      Roughly 4,600 tests found nothing that predicts which qualifying leg wins — not the number, not the team,
      not the total, not the rest. Tickets are ordered by expected value and by nothing else, because any other
      ordering here would be inventing a signal the data says does not exist. The one real separator is push
      exposure: a leg teased onto a half-point cannot push, one on a whole number can, and each leg is tagged.
    </p>
  </div>;
}
