import { useState } from 'react';
import { useApi } from '../../api';

/**
 * System diagnostics: what the pipeline is doing, and whether the policy's
 * refusals are worth anything.
 *
 * These used to sit under Edges, which was wrong. Edges is for things you can
 * act on — a payout quirk, a cheaper venue, a correlation the book prices with a
 * blanket haircut. Neither of these is a bet. They belong with the audits,
 * because that is what they are.
 */

type Tab = 'profitability' | 'abstentions' | 'slices' | 'close' | 'pipeline';

export default function Diagnostics() {
  const [tab, setTab] = useState<Tab>('profitability');
  const { data: profit } = useApi<any>(tab === 'profitability' ? '/nfl-betting/diagnostic' : null);
  const { data: abst } = useApi<any>(tab === 'abstentions' ? '/betting/abstentions' : null);
  const { data: slices } = useApi<any>(tab === 'slices' ? '/nfl-betting/diagnostic/slices' : null);
  const { data: close } = useApi<any>(tab === 'close' ? '/nfl-market/line-move-study' : null);
  const { data: live } = useApi<any>(tab === 'close' ? '/nfl-market/beat-the-close' : null);
  const { data: pipe } = useApi<any>(tab === 'pipeline' ? '/betting/pipeline' : null);
  const { data: lat } = useApi<any>(tab === 'pipeline' ? '/betting/latency' : null);

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-slate-200">
        {([['profitability', 'Profit diagnostic'], ['abstentions', 'Abstention audit'], ['slices', 'Accuracy by slice'], ['close', 'Beat the close'], ['pipeline', 'Data pipeline']] as [Tab, string][])
          .map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                tab === id ? 'border-emerald-500 text-emerald-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
              {label}
            </button>
          ))}
      </div>

      {tab === 'profitability' && (
        !profit ? <div className="card p-6 text-sm text-slate-500">Measuring evidence, profit and feed health…</div>
          : profit.pending ? <Pending label="Profit diagnostic" note={profit.note} />
          : profit.error ? <div className="card p-6 text-sm text-rose-600">{profit.error}</div>
            : <>
              <div className={`card p-5 ${profit.profitability?.state === 'review_eligible'
                ? 'border-emerald-200 bg-emerald-50/40' : 'border-amber-200 bg-amber-50/40'}`}>
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Honest verdict</div>
                <h2 className="mt-1 text-xl font-black text-slate-950">{profit.verdict}</h2>
                <p className="mt-2 text-sm text-slate-700">Stake authority: <b>{profit.profitability?.staking_authority}</b></p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Historical units" value={profit.profitability?.historical_blind_audit?.profit_units == null ? '—'
                  : Number(profit.profitability.historical_blind_audit.profit_units).toFixed(2)} />
                <Stat label="Historical ROI" value={profit.profitability?.historical_blind_audit?.roi == null ? '—'
                  : `${(profit.profitability.historical_blind_audit.roi * 100).toFixed(1)}%`} />
                <Stat label="Forward settled" value={`${profit.profitability?.forward?.settled_bets ?? 0}/${profit.profitability?.forward?.target_settled ?? 200}`} />
                <Stat label="Forward CLV" value={profit.profitability?.forward?.mean_clv == null ? 'not measured'
                  : Number(profit.profitability.forward.mean_clv).toFixed(3)} />
              </div>
              <div className="card p-4">
                <h3 className="text-sm font-semibold text-slate-900">News intelligence coverage</h3>
                <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  <MiniStat label="Stories" value={profit.news?.stories} />
                  <MiniStat label="Fresh 24h" value={profit.news?.fresh_24h} />
                  <MiniStat label="Sources" value={profit.news?.sources} />
                  <MiniStat label="Typed" value={profit.news?.signals?.total} />
                  <MiniStat label="Verified" value={profit.news?.signals?.verified} />
                  <MiniStat label="Untyped material" value={profit.news?.signals?.recent_material_untyped} warn />
                </div>
                <p className="mt-3 text-xs leading-5 text-slate-500">{profit.news?.safety_policy}</p>
              </div>
              <div className="space-y-2">
                {(profit.bottlenecks ?? []).map((item: any) => <div key={item.id} className="card p-4">
                  <div className="flex items-start gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-950 text-xs font-bold text-white">{item.priority}</span>
                    <div><div className="text-sm font-semibold text-slate-900">{item.finding}</div>
                      <div className="mt-1 text-xs leading-5 text-slate-600">{item.action}</div></div></div>
                </div>)}
              </div>
            </>
      )}

      {tab === 'abstentions' && (
        !abst ? <div className="card p-6 text-sm text-slate-500">Grading the games the policy refused…</div>
          : abst.pending ? <Pending label="Abstention audit" note={abst.note} />
          : abst.error ? <div className="card p-6 text-sm text-rose-600">{abst.error}</div>
            : (
              <>
                <div className="card p-4">
                  <h2 className="font-semibold text-slate-900">Did declining actually help?</h2>
                  <p className="mt-1 text-sm text-slate-600">
                    Every abstention is a claim of skill — that the policy knew which games not to
                    touch. This grades the refused games anyway and compares them to the ones it took.
                    If the two rates match, the filter costs opportunities and buys nothing.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(['taken', 'declined'] as const).map(k => abst[k] && (
                    <div key={k} className="card p-4">
                      <div className="text-xs uppercase tracking-wide text-slate-400">{k}</div>
                      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
                        {abst[k].win_rate == null ? '—' : `${(abst[k].win_rate * 100).toFixed(1)}%`}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {abst[k].wins}-{abst[k].losses} · {abst[k].settled} settled
                        {abst[k].win_rate_95 &&
                          ` · 95% CI ${(abst[k].win_rate_95[0] * 100).toFixed(1)}–${(abst[k].win_rate_95[1] * 100).toFixed(1)}%`}
                      </div>
                    </div>
                  ))}
                </div>
                {Array.isArray(abst.by_reason) && abst.by_reason.length > 0 && (
                  <div className="card overflow-x-auto p-4">
                    <h3 className="text-sm font-semibold text-slate-900">Why each game was declined</h3>
                    <table className="mt-2 w-full text-sm">
                      <thead className="text-xs uppercase tracking-wide text-slate-400">
                        <tr><th className="py-1 text-left">Reason</th><th className="text-right">Settled</th>
                          <th className="text-right">Record</th><th className="text-right">Win rate</th></tr>
                      </thead>
                      <tbody>
                        {abst.by_reason.map((r: any) => (
                          <tr key={r.reason} className="border-t border-slate-100">
                            <td className="py-1.5 text-slate-700">{String(r.reason).replace(/_/g, ' ')}</td>
                            <td className="text-right tabular-nums text-slate-500">{r.settled}</td>
                            <td className="text-right tabular-nums text-slate-600">{r.wins}-{r.losses}</td>
                            <td className="text-right tabular-nums text-slate-900">
                              {r.win_rate == null ? '—' : `${(r.win_rate * 100).toFixed(1)}%`}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {abst.note && <p className="text-xs text-slate-500">{abst.note}</p>}
              </>
            )
      )}

      {tab === 'slices' && (
        !slices ? <div className="card p-6 text-sm text-slate-500">Cutting the historical diagnostic by season, matchup, specialist, confidence and coverage…</div>
          : !slices.available ? <div className="card p-6 text-sm text-slate-600">{slices.reason}</div>
            : <>
              <div className="card p-4">
                <h2 className="font-semibold text-slate-900">Where the council is actually right</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Historical diagnostic run {slices.audit_run_id} · {slices.games} games · {slices.quarantine.rows_excluded} rows from {slices.quarantine.seasons.join(', ')} quarantined.
                  A slice under {slices.read_floor} directional calls is shown greyed and must not be quoted.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Spread calls (coordinator)" value={String(slices.market.spread.directional_calls)} />
                <Stat label="Directional rate" value={slices.market.spread.directional_rate == null ? '—' : `${(slices.market.spread.directional_rate * 100).toFixed(1)}%`} />
                <Stat label="RMSE (pts)" value={slices.market.spread.rmse == null ? '—' : String(slices.market.spread.rmse)} />
                <Stat label="Calibration error" value={slices.coordinator_calibration.expected_calibration_error == null ? '—' : String(slices.coordinator_calibration.expected_calibration_error)} />
              </div>
              {[['By season', slices.by_season], ['By matchup type', slices.by_matchup_type], ['By roof', slices.by_roof],
                ['By confidence bucket', slices.by_confidence_bucket], ['By data-coverage bucket', slices.by_coverage_bucket], ['By week', slices.by_week]].map(([title, list]: any) => (
                <div key={title} className="card overflow-x-auto p-4">
                  <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
                  <table className="mt-2 w-full text-left text-xs">
                    <thead className="text-[10px] uppercase tracking-wide text-slate-400"><tr><th className="py-1 pr-3">Slice</th><th className="py-1 pr-3">Calls</th><th className="py-1 pr-3">Right</th><th className="py-1 pr-3">RMSE</th><th className="py-1 pr-3">Coverage</th></tr></thead>
                    <tbody>{list.map((row: any) => <tr key={String(row.key)} className={`border-t border-slate-100 ${row.readable ? 'text-slate-800' : 'text-slate-400'}`}>
                      <td className="py-1 pr-3 font-medium">{String(row.key).replaceAll('_', ' ')}</td><td className="py-1 pr-3 tabular-nums">{row.directional_calls}</td>
                      <td className="py-1 pr-3 tabular-nums">{row.directional_rate == null ? '—' : `${(row.directional_rate * 100).toFixed(1)}%`}</td>
                      <td className="py-1 pr-3 tabular-nums">{row.rmse ?? '—'}</td><td className="py-1 pr-3 tabular-nums">{row.coverage == null ? '—' : `${Math.round(row.coverage * 100)}%`}</td></tr>)}</tbody>
                  </table>
                </div>
              ))}
              <div className="card overflow-x-auto p-4">
                <h3 className="text-sm font-semibold text-slate-900">By specialist</h3>
                <table className="mt-2 w-full text-left text-xs">
                  <thead className="text-[10px] uppercase tracking-wide text-slate-400"><tr><th className="py-1 pr-3">Specialist</th><th className="py-1 pr-3">Coverage</th><th className="py-1 pr-3">Calls</th><th className="py-1 pr-3">Right</th><th className="py-1 pr-3">RMSE</th><th className="py-1 pr-3">Calibration error</th></tr></thead>
                  <tbody>{slices.by_specialist.map((row: any) => <tr key={row.id} className={`border-t border-slate-100 ${row.readable ? 'text-slate-800' : 'text-slate-400'}`}>
                    <td className="py-1 pr-3 font-medium">{row.name}</td><td className="py-1 pr-3 tabular-nums">{row.coverage == null ? '—' : `${Math.round(row.coverage * 100)}%`}</td>
                    <td className="py-1 pr-3 tabular-nums">{row.directional_calls}</td><td className="py-1 pr-3 tabular-nums">{row.directional_rate == null ? '—' : `${(row.directional_rate * 100).toFixed(1)}%`}</td>
                    <td className="py-1 pr-3 tabular-nums">{row.rmse ?? '—'}</td><td className="py-1 pr-3 tabular-nums">{row.calibration?.expected_calibration_error ?? '—'}</td></tr>)}</tbody>
                </table>
              </div>
              <div className="card p-4 text-xs text-slate-600">{slices.rule}</div>
            </>
      )}

      {tab === 'close' && (
        !close ? <div className="card p-6 text-sm text-slate-500">Reading the open-to-close study…</div>
          : close.pending ? <Pending label="Beat-the-close study" note={close.note} />
          : !close.available ? <div className="card p-6 text-sm text-slate-600">{close.reason}</div>
            : <>
              <div className={`card p-5 ${close.gate.passed_decision_times.length ? 'border-emerald-200 bg-emerald-50/40' : 'border-amber-200 bg-amber-50/40'}`}>
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Does anything predict the open-to-close move?</div>
                <h2 className="mt-1 text-lg font-black text-slate-950">{close.gate.verdict}</h2>
                <p className="mt-2 text-sm text-slate-700">
                  {close.dataset.rows.toLocaleString()} game-markets from {close.seasons[0]}–{close.seasons.at(-1)}; held out from {close.holdout_from}.
                  Gate: {close.gate.rule}
                </p>
              </div>
              <div className="card overflow-x-auto p-4">
                <h3 className="text-sm font-semibold text-slate-900">Headline by market and decision time (held-out seasons)</h3>
                <p className="mt-1 text-xs text-slate-500">CLV is the number of points the close moved in the predicted direction from the line you could bet at that time. T1/T2 have no stored line, so their CLV is an upper bound.</p>
                <table className="mt-2 w-full text-left text-xs">
                  <thead className="text-[10px] uppercase tracking-wide text-slate-400"><tr><th className="py-1 pr-3">Market</th><th className="py-1 pr-3">Time</th><th className="py-1 pr-3">Games</th><th className="py-1 pr-3">Mean CLV</th><th className="py-1 pr-3">95% interval</th><th className="py-1 pr-3">Direction</th><th className="py-1 pr-3">Basis</th></tr></thead>
                  <tbody>{close.headline.map((h: any) => <tr key={`${h.market}-${h.decision_time}`} className={`border-t border-slate-100 ${h.holdout?.clv_interval?.[0] > 0 ? 'text-slate-900' : 'text-slate-500'}`}>
                    <td className="py-1 pr-3 font-medium">{h.market}</td><td className="py-1 pr-3">{h.decision_time}</td><td className="py-1 pr-3 tabular-nums">{h.holdout?.n ?? '—'}</td>
                    <td className="py-1 pr-3 tabular-nums font-semibold">{h.holdout?.mean_clv ?? '—'}</td><td className="py-1 pr-3 tabular-nums">{h.holdout ? `${h.holdout.clv_interval[0]} to ${h.holdout.clv_interval[1]}` : '—'}</td>
                    <td className="py-1 pr-3 tabular-nums">{h.holdout?.direction_accuracy == null ? '—' : `${(h.holdout.direction_accuracy * 100).toFixed(1)}%`}</td><td className="py-1 pr-3 text-[10px]">{h.clv_basis}</td></tr>)}</tbody>
                </table>
              </div>
              <div className="card overflow-x-auto p-4">
                <h3 className="text-sm font-semibold text-slate-900">Single signals, held out, each against the line bettable when it was known</h3>
                <table className="mt-2 w-full text-left text-xs">
                  <thead className="text-[10px] uppercase tracking-wide text-slate-400"><tr><th className="py-1 pr-3">Market</th><th className="py-1 pr-3">Signal</th><th className="py-1 pr-3">Known at</th><th className="py-1 pr-3">Mean CLV</th><th className="py-1 pr-3">95% interval</th><th className="py-1 pr-3">Direction</th><th className="py-1 pr-3">Holm p</th></tr></thead>
                  <tbody>{close.features.map((f: any) => <tr key={`${f.market}-${f.name}`} className={`border-t border-slate-100 ${f.p_holm < 0.05 && f.clv_interval[0] > 0 ? 'text-slate-900' : 'text-slate-400'}`}>
                    <td className="py-1 pr-3">{f.market}</td><td className="py-1 pr-3 font-medium">{f.name.split(':')[1].replaceAll('_', ' ')}</td><td className="py-1 pr-3">{f.known_at}</td>
                    <td className="py-1 pr-3 tabular-nums font-semibold">{f.mean_clv}</td><td className="py-1 pr-3 tabular-nums">{f.clv_interval[0]} to {f.clv_interval[1]}</td>
                    <td className="py-1 pr-3 tabular-nums">{f.direction_accuracy == null ? '—' : `${(f.direction_accuracy * 100).toFixed(1)}%`}</td><td className="py-1 pr-3 tabular-nums">{f.p_holm}</td></tr>)}</tbody>
                </table>
              </div>
              {Object.entries(close.slices ?? {}).map(([market, list]: any) => (
                <div key={market} className="card overflow-x-auto p-4">
                  <h3 className="text-sm font-semibold text-slate-900">Slices · {market} (held out, T2 model)</h3>
                  <table className="mt-2 w-full text-left text-xs">
                    <thead className="text-[10px] uppercase tracking-wide text-slate-400"><tr><th className="py-1 pr-3">Slice</th><th className="py-1 pr-3">Games</th><th className="py-1 pr-3">Mean CLV</th><th className="py-1 pr-3">95% interval</th><th className="py-1 pr-3">Direction</th></tr></thead>
                    <tbody>{list.map((s: any) => <tr key={s.slice} className={`border-t border-slate-100 ${s.readable ? 'text-slate-800' : 'text-slate-400'}`}>
                      <td className="py-1 pr-3 font-medium">{s.slice}</td><td className="py-1 pr-3 tabular-nums">{s.n}</td><td className="py-1 pr-3 tabular-nums">{s.mean_clv ?? '—'}</td>
                      <td className="py-1 pr-3 tabular-nums">{s.clv_interval ? `${s.clv_interval[0]} to ${s.clv_interval[1]}` : '—'}</td><td className="py-1 pr-3 tabular-nums">{s.direction_accuracy == null ? '—' : `${(s.direction_accuracy * 100).toFixed(1)}%`}</td></tr>)}</tbody>
                  </table>
                </div>
              ))}
              {live && (
                <div className="card p-4">
                  <h3 className="text-sm font-semibold text-slate-900">Live (Phase 2) · zero units · graded by CLV against Pinnacle's close</h3>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {Object.entries(live.by_signal ?? {}).map(([signal, b]: any) => (
                      <div key={signal} className="rounded-xl border border-slate-200 p-3">
                        <div className="text-[10px] uppercase tracking-wide text-slate-400">{signal.replaceAll('_', ' ')}</div>
                        <div className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{b.settled ? `${b.mean_clv} pts` : `${b.frozen} frozen`}</div>
                        <div className="text-xs text-slate-500">{b.settled} settled · {b.record}{b.readable ? '' : ' · not yet readable'}</div>
                      </div>
                    ))}
                  </div>
                  {!!live.decisions?.length && <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs">
                    <thead className="text-[10px] uppercase tracking-wide text-slate-400"><tr><th className="py-1 pr-3">Game</th><th className="py-1 pr-3">Market</th><th className="py-1 pr-3">Side</th><th className="py-1 pr-3">Signal</th><th className="py-1 pr-3">Line</th><th className="py-1 pr-3">Price</th><th className="py-1 pr-3">Book</th><th className="py-1 pr-3">CLV</th><th className="py-1 pr-3">Result</th></tr></thead>
                    <tbody>{live.decisions.slice(0, 40).map((d: any) => <tr key={d.id} className="border-t border-slate-100 text-slate-700">
                      <td className="py-1 pr-3 font-medium">{d.away_team} at {d.home_team}</td><td className="py-1 pr-3">{d.market}</td><td className="py-1 pr-3">{d.selection}</td>
                      <td className="py-1 pr-3">{d.feature?.signal?.replaceAll('_', ' ')} {d.feature?.centered}</td><td className="py-1 pr-3 tabular-nums">{d.line}</td><td className="py-1 pr-3 tabular-nums">{d.american_price}</td>
                      <td className="py-1 pr-3">{d.feature?.book}</td><td className="py-1 pr-3 tabular-nums">{d.clv_points ?? '—'}</td><td className="py-1 pr-3">{d.result ?? 'pending'}</td></tr>)}</tbody>
                  </table></div>}
                  <p className="mt-2 text-[11px] text-slate-500">{live.gate}</p>
                </div>
              )}
              {close.units && <div className="card p-4 text-xs text-slate-600">Spreads, T0 model, predicted side at −110: {close.units.units_at_opener}u at the opener versus {close.units.units_at_close}u at the close over {close.units.n} games. {close.units.note}</div>}
              <div className="card p-4 text-xs text-slate-600">{close.rule}</div>
            </>
      )}

      {tab === 'pipeline' && (
        <>
          <div className="card p-4">
            <h2 className="font-semibold text-slate-900">Do we learn things before the market does?</h2>
            <p className="mt-1 text-sm text-slate-600">
              Five seasons say the closing line cannot be out-forecast with public data. What is not
              settled is <em>latency</em>. This grades signals against subsequent line movement, which
              is observable in hours rather than seasons and costs nothing, because it uses the free
              ESPN reference line rather than the metered odds feed.
            </p>
          </div>

          {lat && (
            <div className={`card p-4 ${lat.sufficient_evidence ? '' : 'border-amber-200 bg-amber-50/50'}`}>
              <div className="grid gap-3 sm:grid-cols-4">
                <Stat label="Signals" value={String(lat.signals_examined ?? '—')} />
                <Stat label="Moves logged" value={String(lat.line_moves_in_log ?? '—')} />
                <Stat label="Directional matches" value={String(lat.directional_signals ?? '—')} />
                <Stat label="Agreement" value={lat.agreement_rate == null ? '—'
                  : `${(lat.agreement_rate * 100).toFixed(0)}%`} />
              </div>
              <p className="mt-3 text-sm text-slate-800">{lat.verdict}</p>
            </div>
          )}

          {pipe && (
            <>
              <div className="card p-4">
                <h3 className="text-sm font-semibold text-slate-900">What is actually running</h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Free feeds poll on a 90-second tick, metered ones on 30 minutes so credits are not
                  burned, heavy compute only when explicitly enabled. Scheduler{' '}
                  {pipe.scheduler?.running ? 'running' : 'stopped'}, live timer{' '}
                  {pipe.scheduler?.live_timer_running ? 'on' : 'off'}.
                </p>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs uppercase tracking-wide text-slate-400">
                      <tr><th className="py-1 text-left">Job</th><th className="text-left">Tier</th>
                        <th className="text-right">Runs</th><th className="text-right">Age</th>
                        <th className="text-right">State</th></tr>
                    </thead>
                    <tbody>
                      {(pipe.scheduler?.jobs ?? []).map((j: any) => (
                        <tr key={j.job} className="border-t border-slate-100">
                          <td className="py-1.5 text-slate-700">{j.job}</td>
                          <td>
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                              j.tier === 'live' ? 'bg-emerald-50 text-emerald-700'
                                : j.tier === 'metered' ? 'bg-amber-50 text-amber-700'
                                  : 'bg-slate-100 text-slate-500'}`}>{j.tier}</span>
                          </td>
                          <td className="text-right tabular-nums text-slate-600">{j.runs ?? 0}</td>
                          <td className="text-right tabular-nums text-slate-500">
                            {j.age_minutes == null ? 'never'
                              : j.age_minutes < 60 ? `${j.age_minutes}m`
                                : `${(j.age_minutes / 60).toFixed(1)}h`}</td>
                          <td className={`text-right text-xs font-medium ${
                            j.runs === 0 ? 'text-rose-700' : j.stale ? 'text-amber-700' : 'text-emerald-700'}`}>
                            {j.runs === 0 ? 'never run' : j.stale ? 'stale' : 'fresh'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="card p-4">
                <h3 className="text-sm font-semibold text-slate-900">What has actually landed</h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Row counts matter more than run counts — a job that runs on time into a table nothing
                  reads is a log, not a pipeline.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {Object.entries(pipe.row_counts ?? {}).map(([t, n]) => (
                    <div key={t} className="rounded-lg bg-slate-50 px-3 py-2">
                      <div className="text-xs text-slate-500">{t}</div>
                      <div className="text-sm font-semibold tabular-nums text-slate-900">
                        {n == null ? '—' : Number(n).toLocaleString()}</div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}

function MiniStat({ label, value, warn = false }: { label: string; value: unknown; warn?: boolean }) {
  return <div className={`rounded-lg px-3 py-2 ${warn ? 'bg-amber-50' : 'bg-slate-50'}`}>
    <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
    <div className={`mt-0.5 text-lg font-bold tabular-nums ${warn ? 'text-amber-800' : 'text-slate-900'}`}>{value == null ? '—' : String(value)}</div>
  </div>;
}

/**
 * The heavy reports are computed in a worker thread on the server's growth
 * tick and served from SQLite, so a first visit can land before the first run.
 */
function Pending({ label, note }: { label: string; note?: string }) {
  return (
    <div className="card p-6 text-sm text-slate-600">
      <div className="font-semibold text-slate-900">{label} is computing in the background</div>
      <p className="mt-1">{note ?? 'Reload in a few minutes.'}</p>
    </div>
  );
}
