import { useState } from 'react';
import { useApi } from '../../api';

interface ModelRow {
  id: string; name: string; family: string; note: string;
  margin: number | null; total: number | null;
  margin_weight: number; total_weight: number;
  margin_rmse: number | null; total_rmse: number | null;
}
interface Ensemble {
  projected_spread: number | null; projected_margin: number | null; projected_total: number | null;
  market_spread: number | null; market_total: number | null;
  spread_edge: number | null; total_edge: number | null;
  model_disagreement_margin: number | null; model_disagreement_total: number | null;
  models_contributing_margin: number; models_contributing_total: number;
  confidence: string;
}
interface Game { season: number; week: number; home: string; away: string; ensemble: Ensemble; models: ModelRow[]; }
interface Catalog {
  count: number; evaluated_weeks: number; games: number;
  models: { id: string; name: string; family: string; note: string;
    margin_rmse: number | null; total_rmse: number | null;
    margin_weight: number; total_weight: number; margin_n: number; total_n: number }[];
}

const num = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? '—' : v.toFixed(d);
const signed = (v: number | null | undefined, d = 1) =>
  v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`;

const confTone = (c: string) =>
  c.startsWith('strong') ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
  : c.startsWith('moderate') ? 'bg-sky-100 text-sky-700 border-sky-300'
  : c.startsWith('weak') || c.startsWith('no edge') ? 'bg-slate-100 text-slate-600 border-slate-300'
  : 'bg-amber-100 text-amber-800 border-amber-300';

/**
 * Twenty models, one line.
 *
 * The number that matters most on this page is not the projected spread — it is
 * how much the models disagree with each other. A two-point edge means very
 * little when the twenty models scatter by five, and the confidence label says
 * so rather than dressing it up.
 */
export default function EnsemblePage() {
  const [season, setSeason] = useState(2025);
  const [week, setWeek] = useState(12);
  const { data, loading, error } = useApi<{ games: Game[] }>(`/nfl-betting/ensemble/week?season=${season}&week=${week}`);
  const { data: cat } = useApi<Catalog>('/nfl-betting/ensemble/models');
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">Ensemble Line</h1>
        <div className="flex items-center gap-2 text-xs ml-auto">
          <select className="input py-1" value={season} onChange={e => setSeason(Number(e.target.value))}>
            {[2022, 2023, 2024, 2025, 2026].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="input py-1" value={week} onChange={e => setWeek(Number(e.target.value))}>
            {Array.from({ length: 18 }, (_, i) => i + 1).map(w => <option key={w} value={w}>Wk {w}</option>)}
          </select>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        {cat ? `${cat.count} independent models` : 'Models'} — rating systems, play-level efficiency,
        context and the market — each weighted by how well it has actually predicted, then blended into
        one projected line.
      </p>

      {cat && (
        <div className="card p-3 mb-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-600">
          <span><b className="text-slate-800">{cat.count}</b> models</span>
          <span><b className="text-slate-800">{cat.evaluated_weeks}</b> weeks graded walk-forward</span>
          <span><b className="text-slate-800">{cat.games.toLocaleString()}</b> games</span>
          <span className="text-slate-400">
            best margin model: {cat.models.slice().sort((a, b) => (a.margin_rmse ?? 99) - (b.margin_rmse ?? 99))[0]?.name}
            {' '}({num(cat.models.slice().sort((a, b) => (a.margin_rmse ?? 99) - (b.margin_rmse ?? 99))[0]?.margin_rmse, 2)} RMSE)
          </span>
        </div>
      )}

      {loading ? (
        <div className="card p-6 text-sm text-slate-500">Running {cat?.count ?? 20} models across the slate…</div>
      ) : error ? (
        <div className="card p-6 text-sm text-rose-600">{error}</div>
      ) : !data?.games?.length ? (
        <div className="card p-6 text-sm text-slate-500">
          No games with enough prior history for week {week} of {season}.
        </div>
      ) : (
        <div className="space-y-2">
          {data.games.map(g => {
            const e = g.ensemble;
            const key = `${g.away}@${g.home}`;
            const open = expanded === key;
            return (
              <div key={key} className="card overflow-hidden">
                <button onClick={() => setExpanded(open ? null : key)}
                  className="w-full text-left p-3 hover:bg-slate-50 transition-colors">
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="font-bold text-slate-800 w-32">{g.away} at {g.home}</div>
                    <Cell label="Ensemble" value={signed(e.projected_spread)} strong />
                    <Cell label="Market" value={signed(e.market_spread)} />
                    <Cell label="Edge" value={signed(e.spread_edge)}
                      tone={Math.abs(e.spread_edge ?? 0) >= 1.5 ? 'good' : undefined} />
                    <Cell label="Total" value={num(e.projected_total)} />
                    <Cell label="Mkt total" value={num(e.market_total)} />
                    <Cell label="Disagreement" value={`±${num(e.model_disagreement_margin)}`} />
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ml-auto ${confTone(e.confidence)}`}>
                      {e.confidence.split('—')[0].trim()}
                    </span>
                  </div>
                </button>

                {open && (
                  <div className="border-t border-slate-100 p-3 bg-slate-50/50">
                    <p className="text-[11px] text-slate-600 mb-3">{e.confidence}</p>
                    <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">
                      What each model says ({e.models_contributing_margin} with a margin opinion)
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[11px]">
                        <thead className="text-slate-400">
                          <tr>{['Model', 'Family', 'Margin', 'Total', 'Weight', 'RMSE'].map((h, i) => (
                            <th key={i} className="text-left font-semibold px-2 py-1 whitespace-nowrap">{h}</th>
                          ))}</tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {g.models.map(m => (
                            <tr key={m.id} title={m.note} className="hover:bg-white">
                              <td className="px-2 py-1 font-semibold text-slate-700 whitespace-nowrap">{m.name}</td>
                              <td className="px-2 py-1 text-slate-400 whitespace-nowrap">{m.family}</td>
                              <td className="px-2 py-1 tabular-nums">{signed(m.margin)}</td>
                              <td className="px-2 py-1 tabular-nums">{num(m.total)}</td>
                              <td className="px-2 py-1 tabular-nums">
                                <div className="flex items-center gap-1">
                                  <div className="w-8 h-1 bg-slate-200 rounded overflow-hidden">
                                    <div className="h-full bg-emerald-500"
                                      style={{ width: `${Math.min(100, (m.margin_weight || m.total_weight) * 900)}%` }} />
                                  </div>
                                  <span className="text-slate-500">{((m.margin_weight || m.total_weight) * 100).toFixed(1)}%</span>
                                </div>
                              </td>
                              <td className="px-2 py-1 tabular-nums text-slate-500">
                                {num(m.margin_rmse ?? m.total_rmse, 2)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="card p-3 mt-4 text-[11px] text-slate-500">
        Weights come from inverse mean squared error measured walk-forward, so a model that predicts
        badly fades on its own. Worth knowing: the market anchor is consistently among the most
        accurate single models — the books are hard to beat, and an ensemble that pretended otherwise
        would be lying to you. The useful output is the disagreement, not the projection.
      </div>
    </div>
  );
}

function Cell({ label, value, strong, tone }: {
  label: string; value: string; strong?: boolean; tone?: 'good';
}) {
  return (
    <div className="min-w-[70px]">
      <div className="text-[9px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`tabular-nums ${strong ? 'text-sm font-bold text-slate-800' : 'text-xs font-semibold'} ${
        tone === 'good' ? 'text-emerald-700' : 'text-slate-700'}`}>{value}</div>
    </div>
  );
}
