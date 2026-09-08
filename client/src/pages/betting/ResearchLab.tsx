import { useApi } from '../../api';

// research/model_discipline.py's per-fold verdicts, reduced to a summary plus
// the failures by server/services/nfl-research-lab.js. Optional everywhere: a
// report frozen before this check existed (schema -v1) simply has no block, and
// that is a different thing from a run whose folds all failed.
type ModelDiscipline = {
  version: string | null; checks: number; passed: boolean | null;
  by_status: Record<string, number>; statement: string | null;
  compression_policy: string | null; ratio_constants: Record<string, number> | null;
  failures: { label: string; target_type: string; rows: number; effective_n: number;
    parameters: number; observed_ratio: number | null; required_ratio: number; reason: string }[];
};
type Score = { games: number; paper_bets: number; mae: number; no_move_mae: number; mean_clv: number | null; roi: number | null; roi_interval: number[] | null };
type Fold = Score & { season: number; selected: string; tpot_trials: number; candidates: (Score & { name: string; inner_mae: number })[] };
interface Lab {
  as_of: string; principles: string[]; plan_url: string;
  latest_attempt: { id: number; status: string; opened_weeks: number; total_weeks: number | null; error: string | null } | null;
  latest_completed: { id: number; status: string; betting: { roi: number } | null } | null;
  warehouse: { archive: { rows: number; games: number } | null; forward: { decisions: number; settled: number | null } | null; expert_forward: { predictions: number; games: number } | null };
  report_error: string | null;
  packages: { id: string; title: string; state: string; risk: string; purpose: string }[];
  experiment: { run_id: string; status: string; progress?: string; rows: number; features: string[]; limitations: string[]; errors: string[]; markets: { market: string; folds: Fold[]; pooled: Score }[]; dataset_hash: string; code_hash: string; model_discipline?: ModelDiscipline | null } | null;
  book_lag_lab: {
    run_id: string; dataset_hash: string; events: number; books: number; native_step_seconds: number | null;
    hawkes_attempted: boolean; hawkes_verdict: string | null;
    lead_lag_by_book: Record<string, { confirmed_leads: number; confirmed_follows: number; leader_share: number | null; readable: boolean }>;
    delay_survival: Record<string, { readable: boolean; delay_survival?: Record<string, { survival_probability: number | null; extrapolated: boolean }> }>;
    opportunity_routing: { counts: Record<string, number> } | null;
    verdict: string; limitations: string[]; split_policy_limitation: string | null;
    model_discipline?: ModelDiscipline | null;
  } | null;
  book_lag_lab_error: string | null;
  tree_experiment: TreeLab | null; tree_report_error: string | null;
  expert_selector_lab: ExpertSelectorLab | null; expert_selector_lab_error: string | null;
  news_event_impact: NewsEventImpact | null; news_event_impact_error: string | null;
}
interface NewsEventImpact {
  run_hash: string; frozen_at: string; market: string | null;
  claims_considered: number; paired_rows: number; skipped_no_quote_pair: number;
  min_rows_required: number | null;
  coverage: { events: number; players: number; sources: number; verified: number; quarantined: number;
    unknown_certainty: number; restatements: number; contradictions: number; press_role_signals: number;
    extractor_version: string; latest: string } | null;
  provenance: { events: number; flagged: number; verdict: string; rule: string } | null;
  evaluation: { insufficient_data?: boolean; rows?: number; verdict?: string } | null;
}
type SelectorFold = {
  trial: string; test_season: number; test_rows: number; train_rows: number; alpha: number;
  selector_mae: number; selector_mse: number;
  market_only_mae: number | null; gain_vs_market: number | null; gain_vs_market_interval: number[] | null;
  static_equal_weight_mae: number | null; gain_vs_equal_weight: number | null;
  gain_vs_equal_weight_interval: number[] | null; existing_coordinator_mae: number | null;
};
type SelectorSubstrate = {
  substrate: string; rows: number; expert_count: number; seasons: number[]; guarantee: string;
  families: string[][]; family_note: string; top_correlations: { a: string; b: string; r: number; n: number }[];
  verdict: { any_trial_passed: boolean; statement: string; trials_meeting_declared_rule: string[];
    trials_meeting_rule_on_secondary_mse_metric: string[];
    significantly_worse_than_market: { trial: string; test_season: number; mean_gain_vs_market: number }[] };
  folds: SelectorFold[];
  expert_contribution: { expert: string; mean_weight: number | null; never_selected: boolean | null;
    mae_increase_when_removed_by_fold: number[] | null; note: string | null }[];
  effective_weights_by_fold: { test_season: number; effective_weights: Record<string, number> | null }[];
};
interface ExpertSelectorLab {
  run_id: string; created_at: string; declaration_written_at: string; wall_clock_seconds: number;
  meta_learner: string | null; economic_hypothesis: string | null; selection_rule: string | null;
  baselines: string[]; known_limitations: string[]; errors: string[];
  results: SelectorSubstrate[];
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

    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs font-bold uppercase tracking-widest text-slate-400">Working laboratory · Package B</div><h3 className="mt-1 text-xl font-black text-slate-950">Who moves the price, and who follows</h3></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">research only</span></div>
      <p className="mt-3 text-sm leading-6 text-slate-600">No book is assumed sharp. Every book is scored, in turn, as a possible mover and a possible follower, from the raw quote tape.</p>
      {data.book_lag_lab_error && <p role="alert" className="mt-3 text-sm text-red-700">{data.book_lag_lab_error}</p>}
      {!data.book_lag_lab ? <p className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-500">No saved run yet. `python research/book_lag_lab.py` writes a report here.</p> : <>
        <p className="mt-3 text-xs text-slate-500">{data.book_lag_lab.events} events · {data.book_lag_lab.books} books · native poll gap ≈ {data.book_lag_lab.native_step_seconds ? Math.round(data.book_lag_lab.native_step_seconds / 60) : '?'} min</p>
        <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{data.book_lag_lab.verdict}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-200 p-3">
            <div className="text-xs font-bold uppercase tracking-widest text-slate-400">Book relationship explorer</div>
            <p className="mt-1 text-xs text-slate-500">Share of this book's confirmed matched-pair moves in which it moved first. Descriptive only — not fed back into any model.</p>
            <div className="mt-2 space-y-1 text-sm">{Object.entries(data.book_lag_lab.lead_lag_by_book).filter(([, v]) => v.readable).sort(([, a], [, b]) => (b.leader_share ?? 0) - (a.leader_share ?? 0)).slice(0, 6).map(([book, v]) => <div key={book} className="flex justify-between border-t border-slate-100 pt-1"><span className="text-slate-600">{book}</span><span className="font-semibold text-slate-900">{v.leader_share == null ? '—' : `${(v.leader_share * 100).toFixed(0)}% leads`}</span></div>)}</div>
          </div>
          <div className="rounded-lg border border-slate-200 p-3">
            <div className="text-xs font-bold uppercase tracking-widest text-slate-400">Hawkes model</div>
            <p className="mt-1 text-xs text-slate-500">{data.book_lag_lab.hawkes_attempted ? 'Attempted this run.' : 'Not attempted — assessed fresh every run:'}</p>
            <p className="mt-1 text-xs leading-5 text-slate-600">{data.book_lag_lab.hawkes_verdict}</p>
          </div>
        </div>
        {data.book_lag_lab.opportunity_routing && <div className="mt-4 flex flex-wrap gap-3 text-xs">{Object.entries(data.book_lag_lab.opportunity_routing.counts).map(([state, n]) => <span key={state} className="rounded-full bg-slate-100 px-3 py-1 font-bold text-slate-700">{state.replaceAll('_', ' ')}: {n}</span>)}</div>}
        <details className="mt-4 text-sm text-slate-600"><summary className="cursor-pointer font-semibold">Delay survival and limits</summary>
          <div className="mt-3 space-y-3">{Object.entries(data.book_lag_lab.delay_survival).map(([market, m]) => <div key={market}><div className="text-xs font-bold uppercase text-slate-400">{market}</div>{!m.readable ? <p className="text-xs text-slate-500">Not yet readable.</p> : <div className="mt-1 flex flex-wrap gap-2 text-xs">{Object.entries(m.delay_survival ?? {}).map(([seconds, d]) => <span key={seconds} className="rounded bg-slate-50 px-2 py-1">{seconds}s: {d.survival_probability == null ? '—' : `${(d.survival_probability * 100).toFixed(0)}%`}{d.extrapolated ? ' (extrapolated)' : ' (measured)'}</span>)}</div>}</div>)}</div>
          <ul className="mt-3 list-disc space-y-2 pl-5">{data.book_lag_lab.limitations.map(l => <li key={l}>{l}</li>)}</ul>
          <div className="mt-3 break-all rounded-lg bg-slate-50 p-3 font-mono text-[10px]">Run: {data.book_lag_lab.run_id}<br />Dataset: {data.book_lag_lab.dataset_hash}</div>
        </details>
      </>}
    </section>

    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-widest text-slate-400">Package E · news that arrives before the price moves</div>
          <h3 className="mt-1 text-xl font-black text-slate-950">Typed news events and their price impact</h3>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">{data.news_event_impact ? 'Extraction ran · impact not measurable' : 'Not run yet'}</span>
      </div>
      {data.news_event_impact_error && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{data.news_event_impact_error}</p>}
      {!data.news_event_impact ? <p className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-500">No saved news-event run yet. This one costs real API money — run <code className="font-mono text-xs">node scripts/run-news-event-impact.mjs extract</code> then <code className="font-mono text-xs">impact</code> to write a report here.</p> : <>
        {(() => { const e = data.news_event_impact!; const c = e.coverage; return <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[['Typed events', c ? String(c.events) : '—'], ['Verified', c ? String(c.verified) : '—'],
              ['Quarantined', c ? String(c.quarantined) : '—'], ['Contradictions', c ? String(c.contradictions) : '—']]
              .map(([k, v]) => <div key={k} className="rounded-lg bg-slate-50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{k}</div><div className="mt-1 text-2xl font-black text-slate-900">{v}</div></div>)}
          </div>
          {e.provenance && <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-xs leading-5 text-emerald-900"><span className="font-bold uppercase tracking-wide">Provenance · </span>{e.provenance.flagged} of {e.provenance.events} claims flagged. {e.provenance.verdict}. Rule: {e.provenance.rule}</p>}
          <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-700"><span className="font-bold">Impact model · </span>{e.evaluation?.verdict ?? 'No verdict recorded.'}</p>
          {/* The reason for the empty result is the finding, and it is not a
              plumbing failure: a claim is pivoted on when THIS system first saw
              it, never on when the article was published, because we cannot
              claim to have known a story before we read it. A retrospective
              extraction therefore stamps every claim with the moment the
              extractor ran -- which is after the quote tape ends -- so no claim
              can have a post-claim quote. The time-shifted control proves the
              pairing itself works: move the pivot back inside the tape's window
              and 24 pairs appear immediately, and the provenance rule catches
              exactly that as the leak it is. */}
          {e.paired_rows === 0 && e.claims_considered > 0 && <p className="mt-2 text-xs leading-5 text-slate-500">
            All {e.claims_considered} verified claims were skipped for want of a post-claim quote. Claims are pivoted on when this system first <em>saw</em> them, never on the article's publication time — so a retrospective extraction stamps every claim with the moment the extractor ran, which is after the price tape ends. This is measurable only with the extractor running on a schedule alongside quote collection; a backfill can never produce a row. The negative controls confirm the pairing code itself is fine: shifting a claim's pivot back into the tape's window finds pairs immediately, and the provenance rule flags that shift as the leak it would be.
          </p>}
          <p className="mt-3 break-all rounded-lg bg-slate-50 p-3 font-mono text-[10px] text-slate-500">Market: {e.market ?? '—'} · run {e.run_hash} · frozen {e.frozen_at}{c ? ` · extractor ${c.extractor_version}` : ''}</p>
        </>; })()}
      </>}
    </section>

    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-widest text-slate-400">Package F · a selector that learns when experts are useful</div>
          <h3 className="mt-1 text-xl font-black text-slate-950">Conditional expert selector</h3>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">{data.expert_selector_lab ? 'Ran · result negative' : 'Not run yet'}</span>
      </div>
      {data.expert_selector_lab_error && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{data.expert_selector_lab_error}</p>}
      {!data.expert_selector_lab ? <p className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-500">No saved selector experiment yet. Run research/expert_selector_lab.py to write a report here.</p> : <>
        <p className="mt-3 text-sm leading-6 text-slate-600">The stacker is a non-negative ridge whose weights sum to 1, so it can only ever produce a bounded weighted average of its experts — it cannot subtract one expert from another or invent a leveraged coefficient. A market-only expert competes on equal terms and may take all the weight, which is what "trust nothing here, take the market" looks like as a selectable outcome.</p>
        <div className="mt-4 space-y-4">
          {data.expert_selector_lab.results.map(r => <div key={r.substrate} className="rounded-lg border border-slate-200 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="font-bold text-slate-900">{r.substrate}</div>
              <div className="text-xs text-slate-500">{r.rows} rows · {r.expert_count} experts · seasons {r.seasons.join(', ')}</div>
            </div>
            <p className="mt-2 rounded bg-slate-50 p-3 text-xs leading-5 text-slate-600"><span className="font-bold uppercase tracking-wide text-slate-400">Guarantee · </span>{r.guarantee}</p>
            <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-700">{r.verdict.statement}</p>
            {r.verdict.significantly_worse_than_market.length > 0 && <p className="mt-2 text-xs leading-5 text-amber-800">Significantly worse than simply taking the market in {r.verdict.significantly_worse_than_market.length} trial/season combination{r.verdict.significantly_worse_than_market.length === 1 ? '' : 's'} (week-clustered interval entirely below zero).</p>}
            <details className="mt-3 text-sm text-slate-600"><summary className="cursor-pointer font-semibold">Walk-forward folds vs both baselines</summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[46rem] text-left text-xs">
                  <thead className="text-slate-400"><tr><th className="py-1 pr-3 font-bold uppercase tracking-wide">Trial</th><th className="py-1 pr-3">Season</th><th className="py-1 pr-3">n</th><th className="py-1 pr-3">Selector MAE</th><th className="py-1 pr-3">Market MAE</th><th className="py-1 pr-3">Gain vs market (95% CI)</th><th className="py-1 pr-3">Gain vs equal weight (95% CI)</th></tr></thead>
                  <tbody>{r.folds.map((f, i) => <tr key={i} className="border-t border-slate-100"><td className="py-1 pr-3 font-mono text-[10px] text-slate-600">{f.trial}</td><td className="py-1 pr-3">{f.test_season}</td><td className="py-1 pr-3">{f.test_rows}</td><td className="py-1 pr-3">{number(f.selector_mae, 3)}</td><td className="py-1 pr-3">{number(f.market_only_mae, 3)}</td><td className={`py-1 pr-3 ${(f.gain_vs_market ?? 0) > 0 ? 'text-emerald-700' : 'text-slate-600'}`}>{number(f.gain_vs_market, 3)} {f.gain_vs_market_interval && `[${number(f.gain_vs_market_interval[0], 3)}, ${number(f.gain_vs_market_interval[1], 3)}]`}</td><td className={`py-1 pr-3 ${(f.gain_vs_equal_weight ?? 0) > 0 ? 'text-emerald-700' : 'text-slate-600'}`}>{number(f.gain_vs_equal_weight, 3)} {f.gain_vs_equal_weight_interval && `[${number(f.gain_vs_equal_weight_interval[0], 3)}, ${number(f.gain_vs_equal_weight_interval[1], 3)}]`}</td></tr>)}</tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-slate-500">A positive gain means the selector beat that baseline. Intervals bootstrap over weeks, not rows, because games in a week are dependent.</p>
            </details>
            <details className="mt-2 text-sm text-slate-600"><summary className="cursor-pointer font-semibold">Each expert's contribution and conditional usefulness</summary>
              <p className="mt-2 text-xs leading-5 text-slate-500">{r.family_note}</p>
              <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[34rem] text-left text-xs">
                <thead className="text-slate-400"><tr><th className="py-1 pr-3 font-bold uppercase tracking-wide">Expert</th><th className="py-1 pr-3">Mean weight</th><th className="py-1 pr-3">Ever selected?</th><th className="py-1 pr-3">MAE change when removed, per fold</th></tr></thead>
                <tbody>{r.expert_contribution.map(e => <tr key={e.expert} className="border-t border-slate-100"><td className="py-1 pr-3 text-slate-700">{e.expert}</td><td className="py-1 pr-3">{e.note ? '—' : number(e.mean_weight, 4)}</td><td className="py-1 pr-3">{e.note ? '—' : (e.never_selected ? <span className="text-slate-400">never</span> : 'yes')}</td><td className="py-1 pr-3 font-mono text-[10px] text-slate-500">{e.note ?? (e.mae_increase_when_removed_by_fold ?? []).map(v => v.toFixed(4)).join(', ')}</td></tr>)}</tbody>
              </table></div>
              <p className="mt-2 text-xs leading-5 text-slate-500">"Never selected" is a real finding about this evidence, not a reason to delete an expert: a weak standalone forecast may still carry conditional information that a later, larger sample can surface.</p>
            </details>
          </div>)}
        </div>
        <details className="mt-4 text-sm text-slate-600"><summary className="cursor-pointer font-semibold">Declaration, baselines and known limitations</summary>
          <p className="mt-3 text-xs leading-5 text-slate-600"><span className="font-bold">Hypothesis · </span>{data.expert_selector_lab.economic_hypothesis}</p>
          <p className="mt-2 text-xs leading-5 text-slate-600"><span className="font-bold">Meta-learner · </span>{data.expert_selector_lab.meta_learner}</p>
          <p className="mt-2 text-xs leading-5 text-slate-600"><span className="font-bold">Selection rule · </span>{data.expert_selector_lab.selection_rule}</p>
          <div className="mt-2 text-xs font-bold uppercase tracking-wide text-slate-400">Baselines that had to be beaten</div>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs leading-5">{data.expert_selector_lab.baselines.map(b => <li key={b}>{b}</li>)}</ul>
          <div className="mt-3 text-xs font-bold uppercase tracking-wide text-slate-400">Known limitations</div>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs leading-5">{data.expert_selector_lab.known_limitations.map(l => <li key={l}>{l}</li>)}</ul>
          <div className="mt-3 break-all rounded-lg bg-slate-50 p-3 font-mono text-[10px]">Run: {data.expert_selector_lab.run_id}<br />Declared before scoring: {data.expert_selector_lab.declaration_written_at}<br />Wall clock: {data.expert_selector_lab.wall_clock_seconds}s</div>
        </details>
      </>}
    </section>

    <section><div className="mb-4"><div className="text-xs font-bold uppercase tracking-widest text-slate-400">Build program for Claude agents</div><h3 className="mt-1 text-xl font-black text-slate-950">Bolder experiments. Clear jobs.</h3><p className="mt-2 text-sm text-slate-500">These are assigned work packages in the master plan, not claims that the capabilities are finished.</p></div><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{data.packages.map(p => <article key={p.id} className="rounded-xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-950 text-xs font-black text-cyan-300">{p.id}</span><span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{p.risk}</span></div><h4 className="mt-4 font-bold text-slate-900">{p.title}</h4><p className="mt-2 text-sm leading-6 text-slate-500">{p.purpose}</p><div className="mt-4 text-xs font-bold text-slate-600">{label(p.state)}</div></article>)}</div></section>
    <section className="rounded-xl border border-cyan-100 bg-cyan-50/50 p-5"><h3 className="text-sm font-bold text-slate-900">What this plan believes</h3><ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-600">{data.principles.map(p => <li key={p}>{p}</li>)}</ul></section>
  </div>;
}
function Card({ title, value, detail }: { title: string; value: string; detail: string }) {
  return <div className="rounded-xl border border-slate-200 bg-white p-5"><div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{title}</div><div className="mt-2 text-xl font-black text-slate-900">{value}</div><p className="mt-2 text-xs leading-5 text-slate-500">{detail}</p></div>;
}
