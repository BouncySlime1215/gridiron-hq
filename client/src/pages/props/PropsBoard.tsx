import { useMemo, useState } from 'react';
import { useApi } from '../../api';
import { usePickSlip } from './usePickSlip';
import {
  americanFmt, pct, formatMarket, normalizeMarket,
  type Leg, type BoardRow, type ProjectionRow, type PipelineStatus
} from './lib';

/**
 * The model board: FanDuel-priced edges first (the actionable shortlist), then
 * the full model-only research slate underneath, filterable by market and
 * matchup. Ported from Diamond Signal's today.qmd + site_helpers.R's
 * render_signal_table / render_projection_board — see server/routes/props.js
 * for where the data actually comes from.
 */
export default function PropsBoard() {
  const { data, loading, error } = useApi<{ board: BoardRow[]; projections: ProjectionRow[]; status: PipelineStatus | null }>('/props/board');
  const { addLeg, isInSlip } = usePickSlip();
  const [marketFilter, setMarketFilter] = useState<string>('all');
  const [matchupFilter, setMatchupFilter] = useState<string>('all');

  const matchups = useMemo(
    () => [...new Set((data?.projections ?? []).map(p => p.matchup))].sort(),
    [data]
  );
  const filteredProjections = useMemo(() => (data?.projections ?? []).filter(p =>
    (marketFilter === 'all' || p.market === marketFilter) &&
    (matchupFilter === 'all' || p.matchup === matchupFilter)
  ), [data, marketFilter, matchupFilter]);

  const boardLeg = (b: BoardRow): Leg => {
    const market = normalizeMarket(b.market);
    const side = market === 'nrfi' ? b.selection : b.side;
    const recommendation = market === 'nrfi' ? b.selection
      : `${b.side} ${b.line} ${b.market === 'pitcher_strikeouts' ? 'K' : b.market === 'batter_total_bases' ? 'TB' : ''}`.trim();
    return {
      id: `${b.selection}|${b.matchup}|${market}`, slateDate: b.slate_date ?? '',
      selection: b.selection, matchup: b.matchup, gameTime: b.game_time,
      market, marketLabel: formatMarket(market), side, line: b.line ?? 0,
      recommendation, modelProbability: b.model_probability ?? 0, confidence: 0,
      odds: b.american_price != null ? String(b.american_price) : ''
    };
  };
  const projectionLeg = (p: ProjectionRow): Leg => ({
    id: `${p.selection}|${p.matchup}|${p.market}|${p.recommended_side}`, slateDate: p.slate_date,
    selection: p.selection, matchup: p.matchup, gameTime: p.game_time,
    market: p.market, marketLabel: formatMarket(p.market), side: p.recommended_side, line: p.reference_line ?? 0,
    recommendation: p.recommendation, modelProbability: p.model_probability ?? 0, confidence: p.confidence ?? 0,
    odds: p.american_price != null ? String(p.american_price) : ''
  });

  if (loading) return <div className="card p-6 text-sm text-slate-500">Loading the board…</div>;
  if (error) return <div className="card p-6 text-sm text-rose-600">{error}</div>;

  const board = data?.board ?? [];
  const status = data?.status;

  return (
    <div>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <h1 className="text-2xl font-bold">Model Board</h1>
        {status && (
          <span className="text-xs text-slate-400">
            {status.line_feed_status} · updated {new Date(status.site_data_generated_at.replace(' at ', ' ')).toString() !== 'Invalid Date'
              ? status.site_data_generated_at : status.site_data_generated_at}
          </span>
        )}
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Use the FanDuel-priced section first when it's available — those are today's picks that cleared the
        model's edge threshold. The board below is the full research slate, ranked for reference only.
      </p>

      {board.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-bold text-slate-700 mb-2">FanDuel-priced edges ({board.length})</h2>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-400">
                  <tr>
                    {['Selection', 'Signal', 'Pick', 'FanDuel', 'Model', 'Market', 'Edge', ''].map(h => (
                      <th key={h} className="text-left font-semibold px-3 py-2 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {board.map((b, i) => {
                    const leg = boardLeg(b);
                    const strong = (b.probability_difference ?? 0) >= 0.07;
                    return (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="px-3 py-2">
                          <div className="font-semibold text-slate-800">{b.selection}</div>
                          <div className="text-[10px] text-slate-400">{b.matchup} · {b.game_time}</div>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${
                            strong ? 'bg-emerald-100 text-emerald-700 border-emerald-300' : 'bg-amber-50 text-amber-700 border-amber-200'
                          }`}>{b.signal}</span>
                        </td>
                        <td className="px-3 py-2 text-slate-700">{leg.recommendation}</td>
                        <td className="px-3 py-2 tabular-nums">{americanFmt(b.american_price)}</td>
                        <td className="px-3 py-2 tabular-nums" title="The model's estimate for this side">{pct(b.model_probability)}</td>
                        <td className="px-3 py-2 tabular-nums" title="Sportsbook probability after removing estimated vig">{pct(b.implied_probability)}</td>
                        <td className="px-3 py-2 tabular-nums font-semibold text-emerald-700" title="Model probability minus no-vig market probability">
                          +{pct(b.probability_difference)}
                        </td>
                        <td className="px-3 py-2">
                          <AddButton leg={leg} added={isInSlip(leg)} onAdd={addLeg} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {board.length === 0 && (
        <div className="card p-6 text-sm text-slate-500 mb-6">
          No priced signals are available yet. The model is ready, but no FanDuel-priced edges cleared the
          current threshold for this run.
        </div>
      )}

      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <h2 className="text-sm font-bold text-slate-700">Model-only projections ({filteredProjections.length})</h2>
        <div className="flex gap-1 ml-2">
          {[['all', 'All'], ['pitcher_strikeouts', 'Pitchers'], ['batter_total_bases', 'Batters'], ['nrfi', 'NRFI']].map(([v, label]) => (
            <button key={v} onClick={() => setMarketFilter(v)}
              className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
                marketFilter === v ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
              }`}>{label}</button>
          ))}
        </div>
        <select className="input py-1 text-xs ml-auto" value={matchupFilter} onChange={e => setMatchupFilter(e.target.value)}>
          <option value="all">All matchups</option>
          {matchups.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {filteredProjections.length === 0 ? (
        <div className="card p-6 text-sm text-slate-500">No model-only projections match this filter.</div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-400 sticky top-0">
                <tr>
                  {['Bet', 'Market', 'Matchup', 'Price', 'Gap', 'Probability', 'Score', ''].map(h => (
                    <th key={h} className="text-left font-semibold px-3 py-2 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredProjections.map((p, i) => {
                  const leg = projectionLeg(p);
                  const subject = p.market === 'nrfi' ? p.matchup : p.selection;
                  const gap = p.market === 'nrfi' || p.line_gap == null ? '—' : `${p.line_gap >= 0 ? '+' : ''}${p.line_gap.toFixed(2)}`;
                  return (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="px-3 py-2">
                        <div className="font-semibold text-slate-800">{subject}</div>
                        <div className="text-[10px] text-slate-400">{p.recommendation}</div>
                      </td>
                      <td className="px-3 py-2"><span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">{formatMarket(p.market)}</span></td>
                      <td className="px-3 py-2 text-slate-600">{p.matchup}<div className="text-[10px] text-slate-400">{p.game_time}</div></td>
                      <td className="px-3 py-2 tabular-nums">{americanFmt(p.american_price)}<div className="text-[10px] text-slate-400">{p.american_price != null ? 'FanDuel price' : 'Price unavailable'}</div></td>
                      <td className="px-3 py-2 tabular-nums">{gap}</td>
                      <td className="px-3 py-2 tabular-nums">{pct(p.model_probability)}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <div className="w-14 h-1.5 bg-slate-100 rounded overflow-hidden">
                            <div className="h-full bg-sky-500 rounded" style={{ width: `${Math.max(4, Math.min(100, p.confidence ?? 0))}%` }} />
                          </div>
                          <span className="tabular-nums text-slate-600">{(p.confidence ?? 0).toFixed(1)}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2"><AddButton leg={leg} added={isInSlip(leg)} onAdd={addLeg} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function AddButton({ leg, added, onAdd }: { leg: Leg; added: boolean; onAdd: (leg: Leg) => void }) {
  return (
    <button onClick={() => onAdd(leg)} disabled={added}
      className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg border whitespace-nowrap transition-colors ${
        added ? 'bg-emerald-50 text-emerald-700 border-emerald-200 cursor-default' : 'bg-white text-slate-600 border-slate-200 hover:border-sky-400 hover:text-sky-700'
      }`}>
      {added ? 'Added' : '+ Add'}
    </button>
  );
}
