import { useApi } from '../../api';

type Score = { games: number; paper_bets: number; mae: number; no_move_mae: number; mean_clv: number | null; roi: number | null; roi_interval: number[] | null };
type Fold = Score & { season: number; selected: string; tpot_trials: number; candidates: (Score & { name: string; inner_mae: number })[] };
interface Lab {
  as_of: string; principles: string[]; plan_url: string;
  latest_attempt: { id: number; status: string; opened_weeks: number; total_weeks: number | null; error: string | null } | null;
  latest_completed: { id: number; status: string; betting: { roi: number } | null } | null;
  warehouse: { archive: { rows: number; games: number } | null; forward: { decisions: number; settled: number | null } | null; expert_forward: { predictions: number; games: number } | null };
  report_error: string | null;
  packages: { id: string; title: string; state: string; risk: string; purpose: string }[];
  experiment: { run_id: string; status: string; progress?: string; rows: number; features: string[]; limitations: string[]; errors: string[]; markets: { market: string; folds: Fold[]; pooled: Score }[]; dataset_hash: string; code_hash: string } | null;
  tree_experiment: TreeLab | null; tree_report_error: string | null;
}
type TreeTargetFold = { season: number; target: string; selected: string; tpot_trials?: number;
  candidates: { name: string }[] };
type TreeMarketBlock = { market: string; move: TreeTargetFold[]; cover: TreeTargetFold[]; quantile: TreeTargetFold[] };
type LeakageScan = { market: string; season: number | string; target: string; flagged: string[]; skipped: boolean };
type RankerResult = { market: string; test_season: number; skipped: boolean; roi: number | null; profit_units?: number;
  wins?: number; losses?: number; mean_ndcg_informational_only: number | null; note?: string; reason?: string };
type LogitResult = { market: string; test_season: number; skipped: boolean; shrinkage_selected?: number;
  log_loss?: number; market_log_loss?: number; beats_market_log_loss?: boolean; roi: number | null;
  paper_bets?: number; reason?: string };
interface TreeLab {
  run_id: string; status: string; rows: number; features: string[]; dataset_hash: string; code_hash: string;
  wall_clock_seconds?: number; errors: string[]; limitations: string[];
  markets: TreeMarketBlock[]; leakage_scans: LeakageScan[]; ranker: RankerResult[]; market_anchored_logit: LogitResult[];
}
const label = (s: string) => s.replaceAll('_', ' ');
const number = (n: number | null | undefined, digits = 2) => n == null ? 'Unavailable' : n.toFixed(digits);

export default function ResearchLab() {
  const { data, loading, error, refetch } = useApi<Lab>('/nfl-market/research-lab');
  if (error) return <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-red-900">Research evidence could not load: {error}<button className="ml-3 underline" onClick={() => refetch()}>Retry</button></div>;
  if (loading || !data) return <div className="rounded-xl bg-slate-50 p-6 text-slate-600">Reading saved research and current evidence…</div>;
  const run = data.experiment;
  const tree = data.tree_experiment;
  return <div className="space-y-5">
    <section className="overflow-hidden rounded-2xl bg-slate-950 text-white">
      <div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[1.5fr_1fr]">
        <div><div className="text-xs font-bold uppercase tracking-[.2em] text-cyan-300">Independent research · NFL</div>
          <h2 className="mt-3 text-3xl font-black tracking-tight">Find the information.<br />Then test the advantage.</h2>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-300">The next step is to learn how prices react, how player roles change, and when each specialist adds something useful. More models alone do not make a better bet.</p>
          <div className="mt-5 flex flex-wrap gap-3"><a href={data.plan_url} target="_blank" rel="noreferrer" className="rounded-lg bg-cyan-300 px-4 py-2.5 text-sm font-bold text-slate-950">Open Claude agent master plan ↗</a><button onClick={() => refetch()} className="rounded-lg border border-slate-600 px-4 py-2.5 text-sm font-bold">Refresh evidence</button></div>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/5 p-5"><div className="text-xs font-bold uppercase tracking-widest text-amber-300">Current decision</div><div className="mt-3 text-xl font-bold">Research only</div><p className="mt-2 text-sm leading-6 text-slate-300">No candidate on this page changes the production model or authorizes a stake. A failed experiment still teaches us something; it does not close every future path.</p><p className="mt-4 text-xs text-slate-400">Evidence checked {new Date(data.as_of).toLocaleString()}</p></div>
      </div>
    </section>

    <div className="grid gap-3 sm:grid-cols-3">
      <Card title="Latest audit attempt" value={data.latest_attempt ? `#${data.latest_attempt.id} · ${label(data.latest_attempt.status)}` : 'No audit recorded'} detail={data.latest_attempt ? `${data.latest_attempt.opened_weeks} of ${data.latest_attempt.total_weeks ?? '?'} weeks opened. A failed attempt does not replace completed evidence.` : 'No saved attempt to review.'} />
      <Card title="Last completed audit" value={data.latest_completed ? `#${data.latest_completed.id}` : 'None'} detail={data.latest_completed?.betting ? (data.latest_completed.betting.roi > 0 ? 'Historical result positive; forward proof still separate.' : 'The tested betting policy lost money. Its result remains visible.') : 'No completed betting result available.'} />
      <Card title="Independent forward games" value={String(data.warehouse.expert_forward?.games ?? 0)} detail={`${data.warehouse.expert_forward?.predictions ?? 0} expert forecasts can refer to the same games. They are not independent bets.`} />
    </div>
    {data.latest_attempt?.error && <details className="rounded-xl border border-amber-200 bg-amber-50 p-4"><summary className="cursor-pointer text-sm font-bold text-amber-950">Why the latest audit failed</summary><p className="mt-2 text-sm leading-6 text-amber-950">{data.latest_attempt.error}</p></details>}

    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs font-bold uppercase tracking-widest text-slate-400">Working laboratory</div><h3 className="mt-1 text-xl font-black text-slate-950">Opening-price movement · trees + TPOT</h3></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">{run ? label(run.status) : 'Not run yet'}</span></div>
      <p className="mt-3 text-sm leading-6 text-slate-600">Can information available at the opening quote help predict where the line goes next? The lab compares simple baselines and tree models, with any TPOT search confined to earlier training data. This is a small starter experiment; book-response and player-role models are separate builds below.</p>
      {data.report_error && <p role="alert" className="mt-3 text-sm text-red-700">{data.report_error}</p>}
      {!run ? <p className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-500">No saved experiment yet. The offline research worker writes a report here when it runs.</p> : <>
        <p className="mt-3 text-xs text-slate-500">{run.rows.toLocaleString()} market observations · {run.features.length} input columns · {run.progress ?? 'Saved report'}</p>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">{run.markets.map(m => <div key={m.market} className="rounded-xl border border-slate-200 p-4"><h4 className="font-bold capitalize text-slate-900">{m.market}</h4><p className="mt-1 text-sm text-slate-600">{m.folds.every(f => f.selected === 'no_move') ? 'Every season selected the no-movement baseline. These challengers did not earn a forecast.' : 'Some seasons selected a challenger. Review consistency and execution assumptions before drawing conclusions.'}</p><div className="mt-4 space-y-2">{m.folds.map(f => <div key={f.season} className="flex justify-between gap-3 border-t border-slate-100 pt-2 text-sm"><span className="font-semibold text-slate-500">{f.season}</span><span className="text-right font-semibold text-slate-900">{label(f.selected)}<span className="ml-2 text-xs font-normal text-slate-400">{f.tpot_trials} TPOT trials</span></span></div>)}</div>
          <details className="mt-4 text-sm"><summary className="cursor-pointer font-semibold text-slate-600">Open technical results</summary><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[360px] text-left text-xs"><thead><tr className="border-b text-slate-400"><th className="p-2">Year / candidate</th><th className="p-2">Line error</th><th className="p-2">Paper bets</th><th className="p-2">Paper return</th></tr></thead><tbody>{m.folds.flatMap(f => f.candidates.map(c => <tr key={`${f.season}-${c.name}`} className="border-b border-slate-100"><td className="p-2">{f.season} / {label(c.name)}</td><td className="p-2">{number(c.mae)}</td><td className="p-2">{c.paper_bets}</td><td className="p-2">{c.roi == null ? 'No bets' : `${(c.roi * 100).toFixed(1)}%`}</td></tr>))}</tbody></table></div><p className="mt-2 text-xs leading-5 text-slate-500">Candidate selection used earlier-fold error, not these returns. Archived quotes do not prove fills. Previously studied seasons are development data.</p></details>
        </div>)}</div>
        {run.errors.length > 0 && <details className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3" open><summary className="cursor-pointer text-sm font-semibold text-amber-900">{run.errors.length} search or data issues — not successful runs</summary><ul className="mt-2 space-y-1 text-xs text-amber-900">{run.errors.map((e,i) => <li className="break-words" key={i}>{e}</li>)}</ul></details>}
        <details className="mt-4 text-sm text-slate-600"><summary className="cursor-pointer font-semibold">Limits and reproducibility</summary><ul className="mt-3 list-disc space-y-2 pl-5">{run.limitations.map(l => <li key={l}>{l}</li>)}</ul><div className="mt-3 break-all rounded-lg bg-slate-50 p-3 font-mono text-[10px]">Run: {run.run_id}<br />Dataset: {run.dataset_hash}<br />Code: {run.code_hash}</div></details>
      </>}
    </section>

    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs font-bold uppercase tracking-widest text-slate-400">Working laboratory · extended</div><h3 className="mt-1 text-xl font-black text-slate-950">Three targets · LightGBM, XGBoost, CatBoost</h3></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">{tree ? label(tree.status) : 'Not run yet'}</span></div>
      <p className="mt-3 text-sm leading-6 text-slate-600">A separate report from the pilot above: cover/over classification and quantile residual regression alongside the original movement target, three new bounded tree families, a ranker over opportunities (evaluated by real paper return, not a ranking metric), a market-anchored logit branch, and quantile coherence / key-number diagnostics. See the master plan's Package C section for what each branch is meant to prove.</p>
      {data.tree_report_error && <p role="alert" className="mt-3 text-sm text-red-700">{data.tree_report_error}</p>}
      {!tree ? <p className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-500">No saved extended experiment yet. Run research/tree_lab.py to write a report here.</p> : <>
        <p className="mt-3 text-xs text-slate-500">{tree.rows.toLocaleString()} market observations · {tree.features.length} input columns{tree.wall_clock_seconds != null ? ` · ${Math.round(tree.wall_clock_seconds / 60 * 10) / 10} minutes wall-clock` : ''}</p>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">{tree.markets.map(m => <div key={m.market} className="rounded-xl border border-slate-200 p-4">
          <h4 className="font-bold capitalize text-slate-900">{m.market}</h4>
          {(['move', 'cover', 'quantile'] as const).map(target => <div key={target} className="mt-3">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{target === 'move' ? 'Movement regression' : target === 'cover' ? 'Cover / over classification' : 'Quantile regression'}</div>
            <div className="mt-1 space-y-1">{(m[target] ?? []).map(f => <div key={f.season} className="flex justify-between gap-3 border-t border-slate-100 pt-1 text-sm"><span className="font-semibold text-slate-500">{f.season}</span><span className="text-right font-semibold text-slate-900">{label(f.selected)}{f.tpot_trials != null && <span className="ml-2 text-xs font-normal text-slate-400">{f.tpot_trials} TPOT trials</span>}</span></div>)}</div>
          </div>)}
        </div>)}</div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg bg-slate-50 p-4"><div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Ranker branch (top-3 per week)</div>{tree.ranker.map(r => <p key={r.market} className="mt-2 text-sm text-slate-700">{r.market}: {r.skipped ? `skipped — ${r.reason}` : `${r.roi == null ? 'no bets' : `${(r.roi * 100).toFixed(1)}% paper ROI`} (${r.wins ?? 0}-${r.losses ?? 0}); NDCG ${r.mean_ndcg_informational_only?.toFixed(3) ?? '—'} is informational only, not proof of profit`}</p>)}</div>
          <div className="rounded-lg bg-slate-50 p-4"><div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Market-anchored logit branch</div>{tree.market_anchored_logit.map(l => <p key={l.market} className="mt-2 text-sm text-slate-700">{l.market}: {l.skipped ? `skipped — ${l.reason}` : `shrinkage ${l.shrinkage_selected} selected on earlier folds; ${l.beats_market_log_loss ? 'beat' : 'did not beat'} the market's own log-loss (${number(l.log_loss, 4)} vs ${number(l.market_log_loss, 4)})`}</p>)}</div>
        </div>

        <details className="mt-4 text-sm"><summary className="cursor-pointer font-semibold text-slate-600">Leakage scan (run against the real dataset)</summary>
          <ul className="mt-2 space-y-1 text-xs text-slate-600">{tree.leakage_scans.map((s, i) => <li key={i}>{s.market} / {s.season} / {s.target}: {s.skipped ? 'skipped (not enough folds)' : s.flagged.length ? <span className="font-bold text-red-700">flagged {s.flagged.join(', ')}</span> : 'no feature flagged as a suspected leak'}</li>)}</ul>
        </details>
        {tree.errors.length > 0 && <details className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3" open><summary className="cursor-pointer text-sm font-semibold text-amber-900">{tree.errors.length} search or data issues — not successful runs</summary><ul className="mt-2 space-y-1 text-xs text-amber-900">{tree.errors.map((e, i) => <li className="break-words" key={i}>{e}</li>)}</ul></details>}
        <details className="mt-4 text-sm text-slate-600"><summary className="cursor-pointer font-semibold">Limits and reproducibility</summary><ul className="mt-3 list-disc space-y-2 pl-5">{tree.limitations.map(l => <li key={l}>{l}</li>)}</ul><div className="mt-3 break-all rounded-lg bg-slate-50 p-3 font-mono text-[10px]">Run: {tree.run_id}<br />Dataset: {tree.dataset_hash}<br />Code: {tree.code_hash}</div></details>
      </>}
    </section>

    <section><div className="mb-4"><div className="text-xs font-bold uppercase tracking-widest text-slate-400">Build program for Claude agents</div><h3 className="mt-1 text-xl font-black text-slate-950">Bolder experiments. Clear jobs.</h3><p className="mt-2 text-sm text-slate-500">These are assigned work packages in the master plan, not claims that the capabilities are finished.</p></div><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{data.packages.map(p => <article key={p.id} className="rounded-xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-950 text-xs font-black text-cyan-300">{p.id}</span><span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{p.risk}</span></div><h4 className="mt-4 font-bold text-slate-900">{p.title}</h4><p className="mt-2 text-sm leading-6 text-slate-500">{p.purpose}</p><div className="mt-4 text-xs font-bold text-slate-600">{label(p.state)}</div></article>)}</div></section>
    <section className="rounded-xl border border-cyan-100 bg-cyan-50/50 p-5"><h3 className="text-sm font-bold text-slate-900">What this plan believes</h3><ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-600">{data.principles.map(p => <li key={p}>{p}</li>)}</ul></section>
  </div>;
}
function Card({ title, value, detail }: { title: string; value: string; detail: string }) {
  return <div className="rounded-xl border border-slate-200 bg-white p-5"><div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{title}</div><div className="mt-2 text-xl font-black text-slate-900">{value}</div><p className="mt-2 text-xs leading-5 text-slate-500">{detail}</p></div>;
}
