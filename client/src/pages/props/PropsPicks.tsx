import { useMemo, useState } from 'react';
import { useApi } from '../../api';
import { usePickSlip } from './usePickSlip';
import {
  totalOdds, buildResultIndex, gradeLeg, ticketStatus, formatDate, formatDateTime,
  formatMarket, normalizeMarket, type ResultRow, type Ticket, type Grade
} from './lib';

const STATUS_TONE: Record<string, string> = {
  Won: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  Lost: 'bg-rose-100 text-rose-700 border-rose-300',
  Pending: 'bg-amber-50 text-amber-700 border-amber-200',
  Push: 'bg-slate-100 text-slate-600 border-slate-300'
};
const StatusChip = ({ status }: { status: string }) => (
  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${STATUS_TONE[status] ?? STATUS_TONE.Pending}`}>{status}</span>
);

interface GradedTicket extends Ticket {
  grades: Grade[]; status: string; counts: Record<string, number>;
  nearMiss: boolean; primarySlateDate: string; slateDates: string[]; markets: string[]; type: 'Single' | 'Parlay';
}

export default function PropsPicks() {
  const { slip, tickets, removeLeg, updateOdds, clearSlip, saveTicket, deleteTicket, clearTickets } = usePickSlip();
  const { data: results } = useApi<ResultRow[]>('/props/results');
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const [filters, setFilters] = useState({ status: 'All', type: 'All', slate: 'All', market: 'All', query: '', sort: 'Newest' });
  const [legFilters, setLegFilters] = useState({ status: 'All', slate: 'All', market: 'All', query: '', sort: 'Newest' });

  const slipOdds = totalOdds(slip);

  const graded: GradedTicket[] = useMemo(() => {
    if (!results) return [];
    const index = buildResultIndex(results);
    return tickets.map(t => {
      const fallbackDate = t.savedAt.slice(0, 10);
      const grades = t.legs.map(leg => gradeLeg({ ...leg, slateDate: leg.slateDate || fallbackDate }, index));
      const slateDates = [...new Set(t.legs.map(l => l.slateDate || fallbackDate))].sort().reverse();
      const counts = grades.reduce((acc, g) => ({ ...acc, [g.status]: (acc[g.status] ?? 0) + 1 }), {} as Record<string, number>);
      return {
        ...t, grades, status: ticketStatus(grades), counts,
        nearMiss: grades.length > 1 && (counts.Lost ?? 0) === 1 && (counts.Pending ?? 0) === 0,
        primarySlateDate: slateDates[0] ?? fallbackDate, slateDates,
        markets: [...new Set(t.legs.map(l => l.marketLabel || formatMarket(l.market)))],
        type: t.legs.length === 1 ? 'Single' as const : 'Parlay' as const
      };
    });
  }, [tickets, results]);

  const filteredTickets = useMemo(() => {
    const filtered = graded.filter(t => {
      if (filters.status !== 'All' && t.status !== filters.status) return false;
      if (filters.type !== 'All' && t.type !== filters.type) return false;
      if (filters.slate !== 'All' && !t.slateDates.includes(filters.slate)) return false;
      if (filters.market !== 'All' && !t.legs.some(l => normalizeMarket(l.market) === filters.market)) return false;
      const q = filters.query.trim().toLowerCase();
      if (!q) return true;
      return t.legs.some(l => [l.selection, l.matchup, l.recommendation, l.marketLabel, l.side].join(' ').toLowerCase().includes(q));
    });
    return [...filtered].sort((a, b) => {
      if (filters.sort === 'Oldest') return a.savedAt.localeCompare(b.savedAt);
      if (filters.sort === 'Best odds') return (Number(b.totalAmericanOdds) || -Infinity) - (Number(a.totalAmericanOdds) || -Infinity);
      if (filters.sort === 'Shortest odds') return (Number(a.totalAmericanOdds) || Infinity) - (Number(b.totalAmericanOdds) || Infinity);
      return b.savedAt.localeCompare(a.savedAt);
    });
  }, [graded, filters]);

  const allLegs = useMemo(() => filteredTickets.flatMap(t =>
    t.legs.map((leg, i) => ({ ...leg, grade: t.grades[i], ticketStatus: t.status, slateDate: leg.slateDate || t.primarySlateDate }))
  ), [filteredTickets]);
  const filteredLegs = useMemo(() => {
    const filtered = allLegs.filter(l => {
      if (legFilters.status !== 'All' && l.grade.status !== legFilters.status) return false;
      if (legFilters.slate !== 'All' && l.slateDate !== legFilters.slate) return false;
      if (legFilters.market !== 'All' && normalizeMarket(l.market) !== legFilters.market) return false;
      const q = legFilters.query.trim().toLowerCase();
      if (!q) return true;
      return [l.selection, l.matchup, l.recommendation, l.marketLabel, l.side].join(' ').toLowerCase().includes(q);
    });
    return [...filtered].sort((a, b) => {
      if (legFilters.sort === 'Oldest') return a.slateDate === b.slateDate ? a.selection.localeCompare(b.selection) : (a.slateDate > b.slateDate ? 1 : -1);
      if (legFilters.sort === 'Market') {
        const c = formatMarket(a.market).localeCompare(formatMarket(b.market));
        return c !== 0 ? c : a.selection.localeCompare(b.selection);
      }
      return a.slateDate === b.slateDate ? a.selection.localeCompare(b.selection) : (a.slateDate < b.slateDate ? 1 : -1);
    });
  }, [allLegs, legFilters]);

  const slateOptions = useMemo(() => [...new Set(graded.flatMap(t => t.slateDates))].sort().reverse(), [graded]);
  const marketOptions = useMemo(() => [...new Set(graded.flatMap(t => t.legs.map(l => l.market)))].sort(), [graded]);
  const legSlateOptions = useMemo(() => [...new Set(allLegs.map(l => l.slateDate))].sort().reverse(), [allLegs]);
  const legMarketOptions = useMemo(() => [...new Set(allLegs.map(l => normalizeMarket(l.market)))].sort(), [allLegs]);

  const settledTickets = filteredTickets.filter(t => t.status !== 'Pending');
  const legRecord = { won: 0, lost: 0, push: 0 };
  for (const t of filteredTickets) for (const g of t.grades) {
    if (g.status === 'Won') legRecord.won++; else if (g.status === 'Lost') legRecord.lost++; else if (g.status === 'Push') legRecord.push++;
  }
  const settledLegs = legRecord.won + legRecord.lost + legRecord.push;
  const nearMisses = filteredTickets.filter(t => t.type === 'Parlay' && t.nearMiss && t.status === 'Lost').length;

  const decidedLegs = filteredLegs.filter(l => l.grade.status !== 'Pending' && l.grade.status !== 'Push');
  const legWins = filteredLegs.filter(l => l.grade.status === 'Won').length;

  const onSave = () => {
    const err = saveTicket();
    setSaveMsg(err ?? `Saved your ${slip.length === 1 ? 'single' : `${slip.length}-leg parlay`}.`);
    setTimeout(() => setSaveMsg(null), 4000);
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">My Picks</h1>
      <p className="text-sm text-slate-500 mb-4">
        Build singles or parlays from the Model Board, then track them here. Everything is saved in this
        browser only — no stake size, payout, account, or personal information is stored.
      </p>

      <h2 className="text-sm font-bold text-slate-700 mb-2">Current Slip</h2>
      {saveMsg && <div className="card p-3 mb-3 border-emerald-200 bg-emerald-50/40 text-xs text-emerald-800">{saveMsg}</div>}
      {slip.length === 0 ? (
        <div className="card p-6 text-sm text-slate-500 mb-6">
          No picks selected. Add legs from the Model Board, then come back here to enter odds and save the slip.
        </div>
      ) : (
        <div className="card p-4 mb-6 border-sky-200">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-slate-700">{slip.length === 1 ? 'Single' : `${slip.length}-leg parlay`}</h3>
            <span className="text-lg font-black tabular-nums text-slate-800">{slipOdds.american}</span>
          </div>
          <div className="space-y-2 mb-3">
            {slip.map((leg, i) => (
              <div key={i} className="flex items-center gap-2 flex-wrap border-b border-slate-100 pb-2 last:border-0">
                <div className="flex-1 min-w-[180px]">
                  <div className="text-sm font-semibold text-slate-800">{leg.selection}</div>
                  <div className="text-xs text-slate-500">{normalizeMarket(leg.market) === 'nrfi' ? leg.selection : leg.recommendation}</div>
                  <div className="text-[10px] text-slate-400">{leg.marketLabel} · {leg.matchup} · {leg.gameTime}</div>
                </div>
                <label className="text-xs text-slate-500">Odds
                  <input className="input py-1 ml-1 w-20" inputMode="numeric" placeholder="-110" value={leg.odds}
                    onChange={e => updateOdds(i, e.target.value)} />
                </label>
                <button className="text-xs text-rose-600 hover:underline" onClick={() => removeLeg(i)}>Remove</button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button className="btn-primary text-xs" onClick={onSave}>Save Slip</button>
            <button className="btn-ghost text-xs" onClick={clearSlip}>Clear</button>
          </div>
        </div>
      )}

      <h2 className="text-sm font-bold text-slate-700 mb-2">Saved Slips</h2>
      {graded.length === 0 ? (
        <div className="card p-6 text-sm text-slate-500">
          No saved slips yet. Saved singles and parlays will appear here with grading once final game data is available.
        </div>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
            <Metric label="Visible slips" value={String(filteredTickets.length)} detail="Filtered view of saved tickets" />
            <Metric label="Ticket record" value={`${filteredTickets.filter(t => t.status === 'Won').length}-${filteredTickets.filter(t => t.status === 'Lost').length}-${filteredTickets.filter(t => t.status === 'Push').length}`}
              detail={settledTickets.length ? `${((filteredTickets.filter(t => t.status === 'Won').length / settledTickets.length) * 100).toFixed(1)}% win rate` : '—'} />
            <Metric label="Leg record" value={`${legRecord.won}-${legRecord.lost}-${legRecord.push}`}
              detail={settledLegs ? `${((legRecord.won / settledLegs) * 100).toFixed(1)}% leg win rate` : '—'} />
            <Metric label="Pending slips" value={String(filteredTickets.filter(t => t.status === 'Pending').length)} detail="Waiting on final results" />
            <div className="card p-3 flex flex-col justify-between">
              <button className="btn-ghost text-xs" onClick={() => confirm('Clear all saved slips from this browser?') && clearTickets()}>Clear saved slips</button>
              <span className="text-[10px] text-slate-400 mt-1">Removes every saved slip from this browser</span>
            </div>
          </div>

          <FilterBar
            statusOptions={['All', 'Pending', 'Won', 'Lost', 'Push']}
            filters={filters} setFilters={setFilters}
            slateOptions={slateOptions} marketOptions={marketOptions}
            extra={
              <label className="text-xs text-slate-600">Type
                <select className="input py-1 ml-1" value={filters.type} onChange={e => setFilters(f => ({ ...f, type: e.target.value }))}>
                  <option value="All">All slips</option><option value="Single">Singles</option><option value="Parlay">Parlays</option>
                </select>
              </label>
            }
          />

          {filteredTickets.length === 0 ? (
            <div className="card p-6 text-sm text-slate-500 mb-6">No matching slips. Try loosening the filters.</div>
          ) : (
            <div className="space-y-4 mb-6">
              {Object.entries(
                filteredTickets.reduce<Record<string, GradedTicket[]>>((acc, t) => {
                  (acc[t.primarySlateDate] ??= []).push(t); return acc;
                }, {})
              ).sort((a, b) => b[0].localeCompare(a[0])).map(([date, group]) => (
                <div key={date}>
                  <div className="flex items-baseline gap-2 mb-2">
                    <h3 className="text-sm font-bold text-slate-700">{formatDate(date)}</h3>
                    <span className="text-xs text-slate-400">{group.length} saved slip{group.length === 1 ? '' : 's'}</span>
                  </div>
                  <div className="space-y-2">
                    {group.map(t => (
                      <div key={t.id} className="card p-4">
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div>
                            <div className="flex items-center gap-2">
                              <StatusChip status={t.status} />
                              <h4 className="text-sm font-bold text-slate-800">{t.type} · {t.totalAmericanOdds}</h4>
                            </div>
                            <p className="text-xs text-slate-500 mt-0.5">{formatDateTime(t.savedAt)} · {t.markets.join(' · ')}</p>
                          </div>
                          <button className="text-xs text-rose-600 hover:underline" onClick={() => deleteTicket(t.id)}>Delete</button>
                        </div>
                        <div className="flex gap-2 flex-wrap mb-2 text-[11px]">
                          <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">{t.counts.Won ?? 0} won</span>
                          <span className={`px-2 py-0.5 rounded-full border ${(t.counts.Lost ?? 0) ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-slate-50 text-slate-500 border-slate-200'}`}>{t.counts.Lost ?? 0} lost</span>
                          <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">{t.counts.Pending ?? 0} pending</span>
                          {(t.counts.Push ?? 0) > 0 && <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">{t.counts.Push} push</span>}
                          {t.nearMiss && t.status === 'Lost' && <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">One leg short</span>}
                        </div>
                        <div className="divide-y divide-slate-100">
                          {t.legs.map((leg, i) => (
                            <div key={i} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                              <div>
                                <span className="font-semibold text-slate-800">{leg.selection}</span>
                                <span className="text-slate-500 ml-1">{normalizeMarket(leg.market) === 'nrfi' ? '' : leg.recommendation}</span>
                                <div className="text-[10px] text-slate-400">{leg.marketLabel} · {leg.matchup}</div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="tabular-nums font-semibold">{leg.odds}</span>
                                <StatusChip status={t.grades[i].status} />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <h2 className="text-sm font-bold text-slate-700 mb-2">Leg-level grading</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
            <Metric label="Visible legs" value={String(filteredLegs.length)} detail="Legs in the current filtered view" />
            <Metric label="Record" value={`${legWins}-${filteredLegs.filter(l => l.grade.status === 'Lost').length}-${filteredLegs.filter(l => l.grade.status === 'Push').length}`} detail="Settled leg record in this view" />
            <Metric label="Efficiency" value={decidedLegs.length ? `${((legWins / decidedLegs.length) * 100).toFixed(1)}%` : '—'} detail="Win rate on decided legs, excluding pushes" />
            <Metric label="Pending legs" value={String(filteredLegs.filter(l => l.grade.status === 'Pending').length)} detail="Still waiting on final results" />
            {nearMisses > 0 && <Metric label="Parlay near misses" value={String(nearMisses)} detail="Lost parlays with exactly one missed leg" />}
          </div>

          <FilterBar
            statusOptions={['All', 'Pending', 'Won', 'Lost', 'Push']}
            filters={legFilters} setFilters={setLegFilters}
            slateOptions={legSlateOptions} marketOptions={legMarketOptions}
            sortOptions={[['Newest', 'Newest first'], ['Oldest', 'Oldest first'], ['Market', 'Group by market']]}
          />

          <div className="card overflow-hidden">
            <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-400 sticky top-0">
                  <tr>{['Slate', 'Selection', 'Market', 'Recommendation', 'Result', 'Detail'].map(h => (
                    <th key={h} className="text-left font-semibold px-3 py-2 whitespace-nowrap">{h}</th>
                  ))}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredLegs.map((leg, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="px-3 py-2 whitespace-nowrap">{formatDate(leg.slateDate)}</td>
                      <td className="px-3 py-2"><strong className="text-slate-800">{leg.selection}</strong><div className="text-[10px] text-slate-400">{leg.matchup}</div></td>
                      <td className="px-3 py-2">{leg.marketLabel || formatMarket(leg.market)}</td>
                      <td className="px-3 py-2">{leg.recommendation || `${leg.side} ${leg.line}`}</td>
                      <td className="px-3 py-2"><StatusChip status={leg.grade.status} /></td>
                      <td className="px-3 py-2 text-slate-500">{leg.grade.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const Metric = ({ label, value, detail }: { label: string; value: string; detail: string }) => (
  <div className="card p-3">
    <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
    <div className="text-xl font-black text-slate-800 tabular-nums">{value}</div>
    <div className="text-[10px] text-slate-400">{detail}</div>
  </div>
);

function FilterBar({ statusOptions, filters, setFilters, slateOptions, marketOptions, extra, sortOptions }: {
  statusOptions: string[];
  filters: { status: string; slate: string; market: string; query: string; sort: string; [k: string]: string };
  setFilters: (fn: (f: any) => any) => void;
  slateOptions: string[]; marketOptions: string[];
  extra?: React.ReactNode;
  sortOptions?: [string, string][];
}) {
  return (
    <div className="card p-3 mb-3">
      <div className="flex gap-1 flex-wrap mb-2">
        {statusOptions.map(s => (
          <button key={s} onClick={() => setFilters(f => ({ ...f, status: s }))}
            className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
              filters.status === s ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
            }`}>{s}</button>
        ))}
      </div>
      <div className="flex gap-3 flex-wrap items-end text-xs">
        {extra}
        <label className="text-slate-600">Slate
          <select className="input py-1 ml-1" value={filters.slate} onChange={e => setFilters(f => ({ ...f, slate: e.target.value }))}>
            <option value="All">All slate dates</option>
            {slateOptions.map(d => <option key={d} value={d}>{formatDate(d)}</option>)}
          </select>
        </label>
        <label className="text-slate-600">Market
          <select className="input py-1 ml-1" value={filters.market} onChange={e => setFilters(f => ({ ...f, market: e.target.value }))}>
            <option value="All">All markets</option>
            {marketOptions.map(m => <option key={m} value={m}>{formatMarket(m)}</option>)}
          </select>
        </label>
        <label className="text-slate-600">Search
          <input className="input py-1 ml-1" type="search" placeholder="Player, matchup…" value={filters.query}
            onChange={e => setFilters(f => ({ ...f, query: e.target.value }))} />
        </label>
        <label className="text-slate-600">Sort
          <select className="input py-1 ml-1" value={filters.sort} onChange={e => setFilters(f => ({ ...f, sort: e.target.value }))}>
            {(sortOptions ?? [['Newest', 'Newest first'], ['Oldest', 'Oldest first'], ['Best odds', 'Largest odds'], ['Shortest odds', 'Smallest odds']])
              .map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}
