import { useState } from 'react';
import { useApi } from '../../api';
import { Notice, SectionHeading, StatusPill } from '../../components/betting/BettingUI';

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
  distribution?: {
    sample_size: number; conditional_cohort: boolean;
    margin_quantiles: { p10: number; p25: number; p50: number; p75: number; p90: number };
    home_cover_probability: number | null; away_cover_probability: number | null; push_probability: number | null;
    margin_interval_80: [number, number]; uncertainty_width_80: number;
    calibration_state: string; production_eligible: boolean;
  } | null;
  player_availability?: {
    shadow_margin_adjustment: number; uncertainty: string; production_eligible: boolean; note: string;
    home: AvailabilityTeam; away: AvailabilityTeam;
  } | null;
}
interface AvailabilityTeam {
  team: string; estimated_points_lost: number; evidence_state: string;
  coverage: { injury_rows: number; prior_snap_match_rate: number | null; depth_match_rate: number | null };
  material_players: { player: string; position: string; report_status: string | null; practice_status: string | null;
    estimated_point_impact: number; uncertainty: string }[];
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
const pct = (v: number | null | undefined) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;

const confTone = (c: string) =>
  c.startsWith('strong') ? 'bg-slate-100 text-slate-900 border-slate-300'
  : c.startsWith('moderate') ? 'bg-blue-50 text-blue-800 border-blue-200'
  : c.startsWith('weak') || c.startsWith('no edge') ? 'bg-slate-100 text-slate-600 border-slate-300'
  : 'bg-white text-slate-700 border-slate-300';

/**
 * A multi-model ensemble, one line.
 *
 * The number that matters most on this page is not the projected spread — it is
 * how much the models disagree with each other. A two-point edge means very
 * little when the component models scatter by five, and the confidence label says
 * so rather than dressing it up.
 */
export default function EnsemblePage() {
  const [season, setSeason] = useState(2026);
  const [week, setWeek] = useState(1);
  const { data, loading, error } = useApi<{ games: Game[] }>(`/nfl-betting/ensemble/week?season=${season}&week=${week}`);
  const { data: cat } = useApi<Catalog>('/nfl-betting/ensemble/models');
  const [expanded, setExpanded] = useState<string | null>(null);
  const activeMargin = cat?.models.filter(m => m.margin_n > 0 && m.margin_weight > 0).length ?? 0;
  const activeTotal = cat?.models.filter(m => m.total_n > 0 && m.total_weight > 0).length ?? 0;

  return (
    <div>
      <div className="flex items-end gap-3 mb-4 flex-wrap">
        <SectionHeading eyebrow="Model room" title="Ensemble line"
          description="See the consensus, model scatter, and whether a game actually clears the production guards." />
        <div className="flex items-center gap-2 text-xs ml-auto">
          <select aria-label="Ensemble season" className="input py-2" value={season} onChange={e => setSeason(Number(e.target.value))}>
            {[2022, 2023, 2024, 2025, 2026].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select aria-label="Ensemble week" className="input py-2" value={week} onChange={e => setWeek(Number(e.target.value))}>
            {Array.from({ length: 18 }, (_, i) => i + 1).map(w => <option key={w} value={w}>Wk {w}</option>)}
          </select>
        </div>
      </div>
      {cat && activeMargin < cat.count && <Notice title="Partial ensemble coverage" tone="warn">
        {activeMargin} of {cat.count} models have a graded margin weight and {activeTotal} carry a total forecast. The remaining components abstain; this page no longer counts them as active evidence.
      </Notice>}

      {cat && (
        <div className="card p-4 my-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600">
          <span><b className="text-slate-800">{activeMargin}/{cat.count}</b> active margin models</span>
          <span><b className="text-slate-800">{activeTotal}/{cat.count}</b> total models</span>
          <span><b className="text-slate-800">{cat.evaluated_weeks}</b> weeks graded walk-forward</span>
          <span><b className="text-slate-800">{cat.games.toLocaleString()}</b> games</span>
          <span className="text-slate-400">
            best graded margin model: {cat.models.filter(m => m.margin_rmse != null).slice().sort((a, b) => (a.margin_rmse ?? 99) - (b.margin_rmse ?? 99))[0]?.name}
            {' '}({num(cat.models.filter(m => m.margin_rmse != null).slice().sort((a, b) => (a.margin_rmse ?? 99) - (b.margin_rmse ?? 99))[0]?.margin_rmse, 2)} RMSE)
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
            const eligible = Math.abs(e.spread_edge ?? 0) >= 3 && (e.model_disagreement_margin ?? Infinity) <= 4.5;
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
                    <Cell label="80% range" value={e.distribution ? `${signed(e.distribution.margin_interval_80[0], 0)} to ${signed(e.distribution.margin_interval_80[1], 0)}` : '—'} />
                    <StatusPill tone={eligible ? 'info' : 'neutral'}>{eligible ? 'Edge guard' : 'Abstain'}</StatusPill>
                    <span className={`text-xs font-bold px-2 py-1 rounded-full border ${confTone(e.confidence)}`}>
                      {e.confidence.split('—')[0].trim()}
                    </span>
                  </div>
                </button>

                {open && (
                  <div className="border-t border-slate-100 p-3 bg-slate-50/50">
                    <p className="text-sm text-slate-600 mb-3">{e.confidence}</p>
                    <div className="mb-4 grid gap-3 lg:grid-cols-2">
                      <DistributionPanel distribution={e.distribution} home={g.home} away={g.away} />
                      <AvailabilityPanel availability={e.player_availability} />
                    </div>
                    <div className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-1.5">
                      What each model says ({e.models_contributing_margin} with a margin opinion)
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
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
                                    <div className="h-full bg-sky-500"
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

      <div className="card p-4 mt-4 text-sm leading-6 text-slate-500">
        Production uses exponential walk-forward error weighting, which sharply reduces weak-model influence. The market anchor remains the strongest graded component; model disagreement is a risk control, not proof that a projected edge is real.
      </div>
    </div>
  );
}

function DistributionPanel({ distribution: d, home, away }: { distribution: Ensemble['distribution']; home: string; away: string }) {
  if (!d) return <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">Predictive distribution unavailable.</div>;
  const q = d.margin_quantiles;
  return <div className="rounded-xl border border-sky-200 bg-white p-4">
    <div className="flex items-center gap-2"><div className="text-sm font-black text-slate-900">Margin distribution</div><StatusPill tone="warn">research only</StatusPill></div>
    <div className="mt-3 grid grid-cols-3 gap-2 text-center">
      <Small label={`${home} cover`} value={pct(d.home_cover_probability)} />
      <Small label="Push" value={pct(d.push_probability)} />
      <Small label={`${away} cover`} value={pct(d.away_cover_probability)} />
    </div>
    <div className="mt-4">
      <div className="flex justify-between text-[10px] font-semibold text-slate-400"><span>P10 {signed(q.p10, 0)}</span><span>Median {signed(q.p50, 0)}</span><span>P90 {signed(q.p90, 0)}</span></div>
      <div className="relative mt-2 h-2 rounded-full bg-sky-100"><div className="absolute left-[18%] right-[18%] h-2 rounded-full bg-sky-300"/><div className="absolute left-1/2 top-[-3px] h-4 w-0.5 bg-sky-800"/></div>
    </div>
    <p className="mt-3 text-[11px] leading-4 text-slate-500">{d.sample_size.toLocaleString()} prior cutoff-safe games · {d.conditional_cohort ? 'similar spread/total cohort' : 'pooled residual cohort'} · raw probabilities cannot size a bet until calibration passes.</p>
  </div>;
}

function AvailabilityPanel({ availability: a }: { availability: Ensemble['player_availability'] }) {
  if (!a) return <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">Player availability unavailable.</div>;
  const players = [...a.home.material_players.map(x => ({ ...x, team: a.home.team })),
    ...a.away.material_players.map(x => ({ ...x, team: a.away.team }))]
    .sort((x, y) => y.estimated_point_impact - x.estimated_point_impact).slice(0, 5);
  return <div className="rounded-xl border border-slate-200 bg-white p-4">
    <div className="flex items-center gap-2"><div className="text-sm font-black text-slate-900">Replacement-value shadow</div><StatusPill tone="warn">not in production</StatusPill></div>
    <div className="mt-2 flex items-center gap-4 text-xs text-slate-600"><span>Shadow adjustment <b className="text-slate-900">{signed(a.shadow_margin_adjustment)} home</b></span><span>Uncertainty <b>{a.uncertainty}</b></span></div>
    {players.length ? <div className="mt-3 space-y-2">{players.map((p, i) => <div key={`${p.team}-${p.player}-${i}`} className="flex items-center gap-2 text-xs"><span className="w-8 font-black text-slate-400">{p.team}</span><span className="min-w-0 flex-1 truncate font-semibold text-slate-800">{p.player} · {p.position}</span><span className="text-slate-500">{p.report_status ?? p.practice_status ?? 'reported'}</span><span className="tabular-nums font-bold text-slate-700">{p.estimated_point_impact.toFixed(2)} pts</span></div>)}</div>
      : <p className="mt-3 text-xs text-slate-500">No material report rows are available. That means unknown—not automatically healthy.</p>}
    <p className="mt-3 text-[11px] leading-4 text-slate-500">{a.note}</p>
  </div>;
}

function Small({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-sky-50 p-2"><div className="text-sm font-black text-slate-900">{value}</div><div className="text-[9px] uppercase tracking-wide text-slate-500">{label}</div></div>;
}

function Cell({ label, value, strong, tone }: {
  label: string; value: string; strong?: boolean; tone?: 'good';
}) {
  return (
    <div className="min-w-[70px]">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`tabular-nums ${strong ? 'text-sm font-bold text-slate-800' : 'text-xs font-semibold'} ${
        tone === 'good' ? 'text-slate-950' : 'text-slate-700'}`}>{value}</div>
    </div>
  );
}
