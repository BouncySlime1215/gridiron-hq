import { useMemo } from 'react';
import { TeamLogo } from './TeamLogo';
import { Panel, ProvenanceTag } from './shared';
import { american, bookLabel, kickoff, line, pct } from './format';
import type { WongComparisonQuote, WongComparisonRow } from './types';

/**
 * The same game, side by side across books.
 *
 * This is the comparison the whole hub exists for: the number one book posts
 * is not the number another posts, and the difference decides whether a leg
 * qualifies at all. Each cell carries its own provenance and age, because a
 * Pinnacle quote read minutes ago and a DraftKings line scraped from an
 * hourly aggregator are not interchangeable evidence even when they print the
 * same spread.
 */
export function WongComparison({ rows }: { rows: WongComparisonRow[] }) {
  const books = useMemo(() => {
    const seen: string[] = [];
    for (const row of rows) for (const quote of row.by_book ?? []) {
      if (quote?.book && !seen.includes(quote.book)) seen.push(quote.book);
    }
    return seen;
  }, [rows]);

  const sorted = useMemo(() => [...rows].sort((a, b) =>
    new Date(a.commence_time || 0).getTime() - new Date(b.commence_time || 0).getTime()), [rows]);

  return <Panel
    eyebrow="Same game, every book"
    title="Line comparison"
    description="Where each book has this game's spread, and whether that number clears the Wong window."
    footer={<>
      The rate under a qualifying number is the measured historical cover rate for that line bucket over the
      backtest — a property of the number, not a read on this game. It is shown so a qualifying leg is not
      mistaken for a strong one, and nothing on this page is ordered by it.
    </>}
  >
    {sorted.length === 0 ? (
      <div className="p-5 text-sm text-slate-500">
        No game reached the comparison. Either no book was captured this week, or every capture was too old to
        use — the book panels above carry the specific reason.
      </div>
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-white">
            <tr>
              <th scope="col" className="sticky left-0 z-10 border-b border-slate-200 bg-white px-4 py-2 text-left text-[10px] font-black uppercase tracking-[.12em] text-slate-400">Game</th>
              {books.map(book => <th key={book} scope="col" className="border-b border-slate-200 px-3 py-2 text-left text-[10px] font-black uppercase tracking-[.12em] text-slate-400">{bookLabel(book)}</th>)}
            </tr>
          </thead>
          <tbody>
            {sorted.map(row => <tr key={row.event_id} className="border-b border-slate-100 last:border-0 align-top">
              <th scope="row" className="sticky left-0 z-10 bg-white px-4 py-3 text-left font-normal">
                <div className="flex items-center gap-2">
                  <TeamLogo team={row.away_team} size={22} />
                  <span className="text-xs font-bold text-slate-700">at</span>
                  <TeamLogo team={row.home_team} size={22} />
                </div>
                <div className="mt-1 whitespace-nowrap text-xs font-bold text-slate-900">{row.away_team} @ {row.home_team}</div>
                <div className="text-[10px] text-slate-400">{kickoff(row.commence_time)}</div>
              </th>
              {books.map(book => {
                const quote = (row.by_book ?? []).find(entry => entry.book === book) ?? null;
                const isBest = !!row.best && row.best.book === book;
                return <td key={book} className="px-3 py-3">
                  <QuoteCell quote={quote} isBest={isBest} />
                </td>;
              })}
            </tr>)}
          </tbody>
        </table>
      </div>
    )}
  </Panel>;
}

function QuoteCell({ quote, isBest }: { quote: WongComparisonQuote | null; isBest: boolean }) {
  if (!quote) return <span className="text-xs text-slate-300">not posted</span>;
  return <div className={`min-w-[150px] rounded-lg border px-2.5 py-2 ${isBest
    ? 'border-emerald-400 bg-emerald-50/70'
    : quote.qualifies ? 'border-slate-200 bg-white' : 'border-slate-100 bg-slate-50'}`}>
    <div className="flex items-baseline gap-1.5">
      <span className={`text-sm font-black tabular-nums ${quote.qualifies ? 'text-slate-900' : 'text-slate-400'}`}>
        {quote.side ?? '—'} {line(quote.line)}
      </span>
      <span className="text-[11px] tabular-nums text-slate-500">{american(quote.price)}</span>
      {isBest && <span className="ml-auto rounded bg-emerald-600 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-white">best</span>}
    </div>
    <div className="mt-1 flex flex-wrap items-center gap-1">
      <ProvenanceTag provenance={quote.provenance} ageMinutes={quote.age_minutes} compact />
      {quote.qualifies
        ? <span className="rounded-full border border-emerald-300 bg-white px-2 py-0.5 text-[10px] font-bold text-emerald-800">qualifies</span>
        : <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-bold text-slate-400">outside window</span>}
    </div>
    {quote.qualifies && quote.measured_rate != null && <div className="mt-1 text-[10px] text-slate-500"
      title="Measured historical cover rate for this line bucket after the 6-point tease. A property of the number, not a forecast for this game.">
      historical rate for this number <b className="tabular-nums text-slate-700">{pct(quote.measured_rate, 2)}</b>
    </div>}
  </div>;
}
