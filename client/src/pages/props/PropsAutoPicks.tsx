import { useMemo } from 'react';
import { useApi } from '../../api';
import {
  americanFmt, pct, formatMarket, formatDate, normalizeMarket,
  americanToDecimal, buildResultIndex, gradeLeg,
  type Leg, type ResultRow, type Grade
} from './lib';

interface AutoPick {
  pick_date: string; rank: number; market: string; selection: string; matchup: string;
  game_time: string; side: string; line: number | null; american_price: number | null;
  model_probability: number | null; implied_probability: number | null;
  probability_difference: number | null; recommendation: string; signal: string; selected_at: string;
}

const pickToLeg = (p: AutoPick): Leg => {
  const market = normalizeMarket(p.market);
  return {
    id: `${p.pick_date}|${p.rank}`, slateDate: p.pick_date,
    selection: p.selection, matchup: p.matchup, gameTime: p.game_time,
    market, marketLabel: formatMarket(market), side: p.side, line: p.line ?? 0,
    recommendation: p.recommendation, modelProbability: p.model_probability ?? 0, confidence: 0,
    odds: p.american_price != null ? String(p.american_price) : ''
  };
};

/** Straight-bet unit result: +（decimal-1) on a win, -1 on a loss, 0 on a push/pending. */
const unitsFor = (leg: Leg, grade: Grade): number => {
  const odds = Number(leg.odds);
  if (!Number.isFinite(odds) || odds === 0) return 0;
  if (grade.status === 'Won') return americanToDecimal(odds) - 1;
  if (grade.status === 'Lost') return -1;
  return 0;
};

const GRADE_STYLE: Record<string, string> = {
  Won: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  Lost: 'bg-rose-100 text-rose-700 border-rose-300',
  Push: 'bg-slate-100 text-slate-600 border-slate-300',
  Pending: 'bg-amber-50 text-amber-700 border-amber-200'
};

/**
 * Five picks a day, chosen by the model's own edge ranking with no human curation —
 * and graded individually as straight bets, never combined into a parlay. This is
 * the honesty check on the board itself: if the top-5-by-edge selection doesn't
 * actually win more than it loses over time, that is exactly as important to see
 * as when it does.
 */
export default function PropsAutoPicks() {
  const { data, loading, error } = useApi<{ slate_date: string; today: AutoPick[]; history: AutoPick[] }>('/props/auto-picks');
  const { data: resultsData } = useApi<ResultRow[]>('/props/results');

  const resultIndex = useMemo(() => buildResultIndex(resultsData ?? []), [resultsData]);

  const graded = useMemo(() => (data?.history ?? []).map(p => {
    const leg = pickToLeg(p);
    const grade = gradeLeg(leg, resultIndex);
    return { pick: p, leg, grade, units: unitsFor(leg, grade) };
  }), [data, resultIndex]);

  const byDate = useMemo(() => {
    const m = new Map<string, typeof graded>();
    for (const g of graded) {
      const arr = m.get(g.pick.pick_date) ?? [];
      arr.push(g);
      m.set(g.pick.pick_date, arr);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [graded]);

  const settled = graded.filter(g => g.grade.status === 'Won' || g.grade.status === 'Lost');
  const wins = settled.filter(g => g.grade.status === 'Won').length;
  const losses = settled.filter(g => g.grade.status === 'Lost').length;
  const pushes = graded.filter(g => g.grade.status === 'Push').length;
  const winRate = settled.length ? wins / settled.length : null;
  const totalUnits = graded.reduce((s, g) => s + g.units, 0);

  if (loading) return <div className="card p-6 text-sm text-slate-500">Loading auto-picks…</div>;
  if (error) return <div className="card p-6 text-sm text-rose-600">{error}</div>;

  const today = data?.today ?? [];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Auto Picks</h1>
      <p className="text-sm text-slate-500 mb-4">
        The top 5 FanDuel-priced edges each slate, selected automatically by rank — no manual curation.
        Every pick is tracked as its own straight bet; none of these are combined into a parlay.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Metric label="Record" value={`${wins}-${losses}${pushes ? `-${pushes}` : ''}`} />
        <Metric label="Win rate" value={winRate == null ? '—' : pct(winRate)} />
        <Metric label="Units (flat stake)" value={`${totalUnits >= 0 ? '+' : ''}${totalUnits.toFixed(2)}u`}
          tone={totalUnits > 0 ? 'good' : totalUnits < 0 ? 'bad' : undefined} />
        <Metric label="Days tracked" value={String(byDate.length)} />
      </div>

      <h2 className="text-sm font-bold text-slate-700 mb-2">Today's five — {formatDate(data?.slate_date ?? '')}</h2>
      {today.length === 0 ? (
        <div className="card p-6 text-sm text-slate-500 mb-6">
          No FanDuel-priced edges are available yet to select from for this slate.
        </div>
      ) : (
        <div className="card overflow-hidden mb-6">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-400">
                <tr>{['#', 'Selection', 'Pick', 'Price', 'Model', 'Market', 'Edge'].map(h => (
                  <th key={h} className="text-left font-semibold px-3 py-2 whitespace-nowrap">{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {today.map(p => (
                  <tr key={p.rank}>
                    <td className="px-3 py-2 text-slate-400 tabular-nums">{p.rank}</td>
                    <td className="px-3 py-2">
                      <div className="font-semibold text-slate-800">{p.selection}</div>
                      <div className="text-[10px] text-slate-400">{p.matchup} · {p.game_time}</div>
                    </td>
                    <td className="px-3 py-2 text-slate-700">{p.recommendation}</td>
                    <td className="px-3 py-2 tabular-nums">{americanFmt(p.american_price)}</td>
                    <td className="px-3 py-2 tabular-nums">{pct(p.model_probability)}</td>
                    <td className="px-3 py-2 tabular-nums">{pct(p.implied_probability)}</td>
                    <td className="px-3 py-2 tabular-nums font-semibold text-emerald-700">+{pct(p.probability_difference)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <h2 className="text-sm font-bold text-slate-700 mb-2">History</h2>
      {byDate.length === 0 ? (
        <div className="card p-6 text-sm text-slate-500">No past auto-picks yet — check back after today's slate settles.</div>
      ) : (
        <div className="space-y-3">
          {byDate.map(([date, picks]) => (
            <div key={date} className="card overflow-hidden">
              <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-600">
                {formatDate(date)}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <tbody className="divide-y divide-slate-100">
                    {picks.sort((a, b) => a.pick.rank - b.pick.rank).map(g => (
                      <tr key={g.pick.rank}>
                        <td className="px-3 py-2 text-slate-400 tabular-nums w-6">{g.pick.rank}</td>
                        <td className="px-3 py-2">
                          <div className="font-semibold text-slate-800">{g.pick.selection}</div>
                          <div className="text-[10px] text-slate-400">{g.pick.recommendation} · {formatMarket(g.pick.market)}</div>
                        </td>
                        <td className="px-3 py-2 tabular-nums">{americanFmt(g.pick.american_price)}</td>
                        <td className="px-3 py-2">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${GRADE_STYLE[g.grade.status]}`}>
                            {g.grade.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-500">{g.grade.detail}</td>
                        <td className="px-3 py-2 tabular-nums text-right font-semibold w-16"
                          style={{ color: g.units > 0 ? '#047857' : g.units < 0 ? '#e11d48' : undefined }}>
                          {g.units === 0 ? '—' : `${g.units > 0 ? '+' : ''}${g.units.toFixed(2)}u`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="card p-3">
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`text-lg font-bold mt-0.5 ${tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-rose-600' : 'text-slate-800'}`}>
        {value}
      </div>
    </div>
  );
}
