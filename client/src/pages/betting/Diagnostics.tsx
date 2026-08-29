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

type Tab = 'abstentions' | 'pipeline';

export default function Diagnostics() {
  const [tab, setTab] = useState<Tab>('abstentions');
  const { data: abst } = useApi<any>(tab === 'abstentions' ? '/betting/abstentions' : null);
  const { data: pipe } = useApi<any>(tab === 'pipeline' ? '/betting/pipeline' : null);
  const { data: lat } = useApi<any>(tab === 'pipeline' ? '/betting/latency' : null);

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-slate-200">
        {([['abstentions', 'Abstention audit'], ['pipeline', 'Data pipeline']] as [Tab, string][])
          .map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                tab === id ? 'border-emerald-500 text-emerald-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
              {label}
            </button>
          ))}
      </div>

      {tab === 'abstentions' && (
        !abst ? <div className="card p-6 text-sm text-slate-500">Grading the games the policy refused…</div>
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
