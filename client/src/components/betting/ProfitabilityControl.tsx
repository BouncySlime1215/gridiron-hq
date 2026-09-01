import { useState } from 'react';
import { api, useApi } from '../../api';
import { Notice, SectionHeading, SignalCard, StatusPill } from './BettingUI';

interface Gate { id: string; label: string; passed: boolean; actual: number | null; target: number; }
interface MarketScorecard { market: string; shadow_decisions: number; settled: number; brier: number | null;
  ece: number | null; calibration: { intercept: number | null; slope: number | null };
  mean_clv: number | null; median_clv: number | null; clv_ci90_week_clustered: [number, number] | null;
  status: string; staking_authority: string; }
interface ProfitabilityOps {
  state: string; generated_at: string; staking_authority: string;
  policy: { version: string; hash: string; minimum_settled_overall: number };
  gates: Gate[];
  alerts: { severity: string; code: string; message: string }[];
  prop_quotes: { quotes: number; captures: number; events: number; settled: number; has_key: boolean; credit_reserve: number };
  match_coverage: { quotes: number; modeled: number; resolved: number; unresolved: number; model_rate: number | null;
    rate: number | null; target: number; reasons: { status: string; quotes: number; decisions: number }[] };
  capture_horizons: { events: number; horizons: { hours_before_kickoff: number; captured: number; pending: number; missed: number; rate: number | null }[] };
  settlement: { total_due: number; resolved: number; overdue: number; resolution_rate: number | null };
  edge: { shadow_decisions: number; settled_bets: number; median_clv_probability: number | null; verdict: string };
  teaser: { status: string; wong_price_gate_passed: boolean; latest_reachable: { book: string; american_price: number } | null };
  historical_lines: { min_season: number; max_season: number; rows: number; opening_rows: number; limitation: string };
  model_growth: {
    state: string; season: number; finalized_week: number; learned_through_week: number;
    sources: { id: string; required: boolean; rows: number; through_week: number;
      prior_season_rows: number; prior_season_through_week: number; lag_weeks: number; current: boolean }[];
    labeled_examples: { independent: number; settled: number; selected: number; selected_settled: number; rule: string };
    active_fit: { cutoff: string; model_version: string; created_at: string } | null;
    latest_run: { started_at: string; finished_at: string | null; status: string } | null;
    next_action: string; promotion_policy: string;
  };
  online_neural: {
    head: string; mode: string; architecture: string; active_version: string;
    captured: number; settled: number; trained: number; trained_weeks: number;
    trained_through: { season: number; week: number } | null;
    metrics: { examples: number; weeks: number; market_mae: number | null; neural_mae: number | null;
      mae_improvement: number | null; weekly_clustered_improvement_ci90: [number, number] | null;
      production_eligible: boolean };
    heads: Record<string, { state: string; target: string }>;
    production_eligible: boolean; staking_authority: string; learning_rule: string;
  };
  balanced_online_system: { policy: string; layers: { id: string; label: string; state: string; detail: string }[] };
  gridiron_engine: { name: string; schema_version: string; current_version: string;
    architecture: { head: string; cadence: string; consumes: string }[]; rule: string };
  external_benchmarks: { ffopportunity: { rows: number; seasons: number; min_season: number | null; max_season: number | null; status: string } };
  external_sources: { id: string; repo: string; url: string; role: string; integration: string; pinned_commit: string; copied_code: boolean }[];
  market_scorecards: MarketScorecard[];
  odds_api: { requests_remaining: number | null };
  readiness: {
    closest_path: string; verdict: string;
    blind_audit: { id: number | null; status: string; opened: number; total: number;
      classification: string | null; final: { betting?: { bets: number; wins: number; losses: number; units: number; roi: number | null } } | null;
      forward: { decisions: number; settled: number; target: number } };
    ai_review: { id: number | null; status: string; reviewed: number; kept: number; staked: number; evidence_status: string | null };
    phases: { id: string; order: number; title: string; state: string; completed: number; total: number;
      headline: string; detail: string; next_action: string }[];
  };
}
interface PassingAudit { candidates_tested: number; rows: number; promoted: string[]; verdict: string;
  candidates: { id: string; validation: { delta_mae: number; candidate_spearman: number; champion_spearman: number; coverage_80: number };
    holm_passed: boolean; gates: Record<string, boolean> }[]; }

const pct = (value: number | null | undefined) => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
const signed = (value: number | null | undefined, digits = 3) => value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;

export function ProfitabilityControl() {
  const ops = useApi<ProfitabilityOps>('/nfl-betting/profitability');
  const council = useApi<any>('/nfl-betting/expert-council');
  const news = useApi<{ coverage: { signals: number; stories: number; players: number; recent_material_untyped: number; latest: string | null } }>('/nfl-betting/news/signals');
  const [passing, setPassing] = useState<PassingAudit | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [book, setBook] = useState('');
  const [price, setPrice] = useState('-115');

  const act = async (kind: 'reconcile' | 'news' | 'passing' | 'growth') => {
    setBusy(kind); setMessage(null);
    try {
      if (kind === 'passing') {
        const result = await api<PassingAudit>('/nfl-betting/profitability/passing-specialists');
        setPassing(result); setMessage(result.verdict);
      } else if (kind === 'growth') {
        const result = await api<any>('/nfl-betting/profitability/model-growth/run', {
          method: 'POST', body: JSON.stringify({})
        });
        setMessage(result.note ?? `Model growth cycle finished: ${result.status}.`);
        await ops.refetch();
      } else {
        const result = await api(kind === 'reconcile' ? '/nfl-betting/props/quotes/reconcile' : '/nfl-betting/news/signals/sync', { method: 'POST' });
        let aiResult: any = null;
        if (kind === 'news') aiResult = await api('/nfl-betting/news/signals/ai', { method: 'POST' });
        setMessage(kind === 'reconcile' ? `Reviewed ${result.reviewed ?? 0} quote records.`
          : `Rules created or refreshed ${result.signals ?? 0} signals; constrained AI accepted ${aiResult?.accepted ?? 0} additional claims.`);
        await Promise.all([ops.refetch(), news.refetch()]);
      }
    } catch (error: any) { setMessage(error.message); }
    finally { setBusy(null); }
  };

  const saveTeaser = async () => {
    setBusy('teaser'); setMessage(null);
    try {
      await api('/nfl-betting/teasers/prices', { method: 'POST', body: JSON.stringify({
        book, teaser_points: 6, legs: 2, american_price: Number(price), reachable: true,
        different_games_required: true
      }) });
      setMessage(`Saved ${book} two-team six-point teaser at ${price}.`); await ops.refetch();
    } catch (error: any) { setMessage(error.message); }
    finally { setBusy(null); }
  };

  if (ops.loading || !ops.data) return <Notice title="Loading profitability controls" tone="info">Checking the frozen policy, forward ledger, source provenance and promotion gates.</Notice>;
  const d = ops.data;
  return <section className="space-y-5">
    <SectionHeading eyebrow="Profitability plan" title="Forward edge control room"
      description="Prediction quality, market edge and execution are separate gates. Historical diagnostics can reject ideas; only the frozen 2026 ledger can authorize a model-derived stake." />
    <ProfitReadiness readiness={d.readiness} />
    <SpecialistMatrix council={council.data} loading={council.loading} />
    <div className="flex flex-wrap items-center gap-2">
      <StatusPill tone={d.state === 'review_eligible' ? 'good' : 'warn'}>{d.state.replaceAll('_', ' ')}</StatusPill>
      <StatusPill tone="info">engine {d.gridiron_engine.current_version.slice(-19)}</StatusPill>
      <StatusPill tone="neutral">policy {d.policy.version} · {d.policy.hash.slice(0, 10)}</StatusPill>
      <StatusPill tone={d.staking_authority.startsWith('0') ? 'warn' : 'good'}>{d.staking_authority}</StatusPill>
      <button className="btn-ghost text-sm" disabled={!!busy} onClick={() => act('reconcile')}>{busy === 'reconcile' ? 'Reconciling…' : 'Reconcile prop identities'}</button>
      <button className="btn-ghost text-sm" disabled={!!busy} onClick={() => act('news')}>{busy === 'news' ? 'Structuring news…' : 'Update injury & role signals'}</button>
      <button className="btn-primary text-sm" disabled={!!busy} onClick={() => act('passing')}>{busy === 'passing' ? 'Auditing 20 challengers…' : 'Run passing specialist audit'}</button>
      <button className="btn-ghost text-sm" disabled={!!busy} onClick={() => act('growth')}>{busy === 'growth' ? 'Ingesting finalized week…' : 'Run model growth cycle'}</button>
    </div>
    {message && <Notice title="Operations result" tone="info">{message}</Notice>}
    {d.alerts.map(alert => <Notice key={alert.code} title={alert.code.replaceAll('_', ' ')} tone={alert.severity === 'critical' ? 'bad' : 'warn'}>{alert.message}</Notice>)}

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <SignalCard label="Model learned through" value={d.model_growth.learned_through_week ? `Week ${d.model_growth.learned_through_week}` : 'No 2026 results'} detail={d.model_growth.state.replaceAll('_', ' ')} tone={d.model_growth.state === 'current' ? 'good' : 'warn'} />
      <SignalCard label="Frozen game labels" value={`${d.model_growth.labeled_examples.settled}/${d.model_growth.labeled_examples.independent}`} detail={`${d.model_growth.labeled_examples.selected_settled}/${d.model_growth.labeled_examples.selected} cleared the frozen betting policy`} tone={d.model_growth.labeled_examples.settled ? 'good' : 'warn'} />
      <SignalCard label="Online neural learner" value={`${d.online_neural.trained_weeks} weeks`} detail={`${d.online_neural.trained}/${d.online_neural.settled} settled vectors trained · ${d.online_neural.production_eligible ? 'promotion gate passed' : 'shadow only'}`} tone={d.online_neural.production_eligible ? 'good' : 'warn'} />
      <SignalCard label="Resolved quote coverage" value={pct(d.match_coverage.rate)} detail={`${d.match_coverage.resolved}/${d.match_coverage.quotes} explained · target 95%`} tone={d.match_coverage.rate != null && d.match_coverage.rate >= .95 ? 'good' : 'warn'} />
      <SignalCard label="Directly modeled" value={pct(d.match_coverage.model_rate)} detail={`${d.match_coverage.modeled} quotes; valid role abstentions remain abstentions`} />
      <SignalCard label="Independent decisions" value={`${d.edge.shadow_decisions}`} detail={`${d.edge.settled_bets}/${d.policy.minimum_settled_overall} settled before pooled review`} tone="warn" />
      <SignalCard label="Odds credits" value={d.odds_api.requests_remaining == null ? 'Unknown' : `${d.odds_api.requests_remaining}`} detail={`${d.prop_quotes.credit_reserve} reserved for due capture windows`} tone={d.prop_quotes.has_key ? 'good' : 'warn'} />
      {d.capture_horizons.horizons.map(h => <SignalCard key={h.hours_before_kickoff} label={`T-${h.hours_before_kickoff}h capture`} value={pct(h.rate)} detail={`${h.captured} captured · ${h.pending} pending · ${h.missed} missed`} tone={h.missed ? 'bad' : 'neutral'} />)}
      <SignalCard label="Settlement resolution" value={pct(d.settlement.resolution_rate)} detail={`${d.settlement.resolved}/${d.settlement.total_due} due · ${d.settlement.overdue} overdue`} tone={d.settlement.overdue ? 'bad' : 'neutral'} />
      <SignalCard label="Typed news" value={`${news.data?.coverage.signals ?? 0} signals`} detail={`${news.data?.coverage.players ?? 0} players · ${news.data?.coverage.recent_material_untyped ?? 0} recent material stories still untyped`} tone={(news.data?.coverage.recent_material_untyped ?? 0) ? 'warn' : 'good'} />
    </div>

    <details className="card overflow-hidden">
      <summary className="cursor-pointer px-4 py-4 font-bold text-slate-900">
        Model ingestion pipeline · {d.model_growth.state.replaceAll('_', ' ')}
      </summary>
      <div className="border-t border-slate-200 p-4">
        <p className="mb-3 text-xs leading-5 text-slate-600">{d.model_growth.next_action} {d.model_growth.promotion_policy}</p>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {d.model_growth.sources.map(source => <div key={source.id} className="rounded-xl border border-slate-200 p-3">
            <div className="flex items-center gap-2"><StatusPill tone={source.current ? 'good' : source.required ? 'bad' : 'warn'}>{source.current ? 'current' : `${source.lag_weeks}w lag`}</StatusPill><span className="text-xs font-bold text-slate-800">{source.id.replaceAll('_', ' ')}</span></div>
            <div className="mt-2 text-xs text-slate-500">{source.rows.toLocaleString()} current rows · through week {source.through_week || '—'}{source.required ? ' · required' : ' · context'}<br />{source.prior_season_rows.toLocaleString()} prior-season rows · through {source.prior_season_through_week || '—'}</div>
          </div>)}
        </div>
        <p className="mt-3 text-[11px] text-slate-500">{d.model_growth.labeled_examples.rule}</p>
      </div>
    </details>

    <details className="card overflow-hidden">
      <summary className="cursor-pointer px-4 py-4 font-bold text-slate-900">
        Balanced online system · {d.online_neural.mode.replaceAll('_', ' ')}
      </summary>
      <div className="border-t border-slate-200 p-4">
        <p className="mb-3 text-xs leading-5 text-slate-600">{d.balanced_online_system.policy}</p>
        <p className="mb-3 text-[11px] leading-5 text-slate-500">{d.gridiron_engine.rule}</p>
        <div className="mb-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {d.balanced_online_system.layers.map(layer => <div key={layer.id} className="rounded-xl border border-slate-200 p-3">
            <div className="flex items-center gap-2"><StatusPill tone={layer.state === 'adaptive' || layer.state === 'review_eligible' ? 'good' : layer.state.includes('shadow') ? 'info' : 'warn'}>{layer.state.replaceAll('_', ' ')}</StatusPill><span className="text-xs font-black text-slate-900">{layer.label}</span></div>
            <p className="mt-2 text-[11px] leading-4 text-slate-500">{layer.detail}</p>
          </div>)}
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <NeuralReadout label="Architecture" value={d.online_neural.architecture} />
          <NeuralReadout label="Forward sample" value={`${d.online_neural.metrics.examples} games · ${d.online_neural.metrics.weeks} weeks`} />
          <NeuralReadout label="MAE vs market" value={`${d.online_neural.metrics.neural_mae ?? '—'} vs ${d.online_neural.metrics.market_mae ?? '—'}`} />
          <NeuralReadout label="Weekly MAE lift" value={signed(d.online_neural.metrics.mae_improvement)} />
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-3 xl:grid-cols-5">
          {Object.entries(d.online_neural.heads).map(([head, config]) => <div key={head} className="rounded-xl border border-slate-200 p-3">
            <div className="flex items-center gap-2"><StatusPill tone={config.state === 'active_shadow' ? 'info' : 'neutral'}>{config.state.replaceAll('_', ' ')}</StatusPill><span className="text-xs font-black text-slate-900">{head.replaceAll('_', ' ')}</span></div>
            <p className="mt-2 text-[11px] leading-4 text-slate-500">{config.target}</p>
          </div>)}
        </div>
        <p className="mt-3 text-[11px] leading-5 text-slate-500">{d.online_neural.learning_rule} {d.online_neural.staking_authority}.</p>
      </div>
    </details>

    <div className="grid gap-4 xl:grid-cols-[1.25fr_.75fr]">
      <div className="card overflow-hidden">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-3"><div className="font-black text-slate-900">Forward promotion gates</div><div className="text-xs text-slate-500">Every gate must pass at the same frozen cutoff.</div></div>
        <div className="grid gap-2 p-4 md:grid-cols-2">{d.gates.map(gate => <div key={gate.id} className="rounded-xl border border-slate-200 p-3"><div className="flex items-center gap-2"><StatusPill tone={gate.passed ? 'good' : 'warn'}>{gate.passed ? 'pass' : 'waiting'}</StatusPill><span className="text-sm font-bold text-slate-800">{gate.label}</span></div><div className="mt-2 text-xs text-slate-500">Actual {gate.actual == null ? 'not measurable yet' : gate.actual}</div></div>)}</div>
      </div>
      <div className="card p-4">
        <div className="font-black text-slate-900">Reachable teaser price</div>
        <p className="mt-1 text-xs leading-5 text-slate-500">The historical Wong result is actionable only if your real book offers a two-team six-point teaser at -115 or better.</p>
        <div className="mt-4 grid grid-cols-[1fr_90px] gap-2"><input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Book name" value={book} onChange={event => setBook(event.target.value)} /><input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" aria-label="American teaser price" value={price} onChange={event => setPrice(event.target.value)} /></div>
        <button className="btn-primary mt-2 w-full text-sm" disabled={!book || busy === 'teaser'} onClick={saveTeaser}>{busy === 'teaser' ? 'Saving…' : 'Save reachable price'}</button>
        <div className="mt-3 text-xs text-slate-500">Latest: {d.teaser.latest_reachable ? `${d.teaser.latest_reachable.book} ${d.teaser.latest_reachable.american_price}` : 'none recorded'}</div>
      </div>
    </div>

    <section><SectionHeading eyebrow="Market-separated calibration" title="No market can hide behind another"
      description="Passing, rushing, receiving, receptions and anytime TD each require their own forward sample, calibration and CLV." />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">{d.market_scorecards.map(card => <div key={card.market} className="card p-4"><div className="flex items-center gap-2"><div className="min-w-0 flex-1 text-sm font-black text-slate-900">{card.market.replaceAll('player_', '').replaceAll('_', ' ')}</div><StatusPill tone={card.status === 'pilot_review_eligible' ? 'good' : 'warn'}>{card.status.replaceAll('_', ' ')}</StatusPill></div><div className="mt-3 text-2xl font-black text-slate-950">{card.settled}/75</div><div className="text-xs text-slate-500">settled · {card.shadow_decisions} shadow decisions</div><div className="mt-3 text-xs leading-5 text-slate-600">CLV mean {signed(card.mean_clv)} · median {signed(card.median_clv)}<br />ECE {pct(card.ece)} · slope {card.calibration.slope ?? '—'}<br />Stake: {card.staking_authority}</div></div>)}</div>
    </section>

    {passing && <section><SectionHeading eyebrow="Passing component audit" title={`${passing.promoted.length}/${passing.candidates_tested} challengers advanced`}
      description={passing.verdict} /><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{passing.candidates.slice(0, 8).map(candidate => <div key={candidate.id} className="card p-4"><div className="font-black text-slate-900">{candidate.id.replaceAll('_', ' ')}</div><div className="mt-3 text-lg font-black text-slate-950">{signed(candidate.validation.delta_mae)} MAE</div><div className="mt-1 text-xs text-slate-500">rank {candidate.validation.candidate_spearman} vs {candidate.validation.champion_spearman} · coverage {pct(candidate.validation.coverage_80)} · Holm {candidate.holm_passed ? 'pass' : 'fail'}</div></div>)}</div></section>}

    <details className="card overflow-hidden"><summary className="cursor-pointer px-4 py-4 font-bold text-slate-900">GitHub evidence and benchmark registry · {d.external_sources.length}</summary><div className="grid gap-3 border-t border-slate-200 p-4 md:grid-cols-2">{d.external_sources.map(source => <a key={source.id} href={source.url} target="_blank" rel="noreferrer" className="rounded-xl border border-slate-200 p-3 hover:bg-slate-50"><div className="font-black text-slate-900">{source.repo}</div><p className="mt-1 text-xs leading-5 text-slate-600">{source.role}</p><div className="mt-2 text-[11px] text-slate-400">{source.integration.replaceAll('_', ' ')} · commit {source.pinned_commit.slice(0, 10)} · code copied: {String(source.copied_code)}</div></a>)}</div></details>
    <Notice title={`${d.historical_lines.rows.toLocaleString()} historical team-lines sourced`} tone="info">{d.historical_lines.min_season}–{d.historical_lines.max_season} closing spreads and totals are available from nflverse. {d.historical_lines.limitation}</Notice>
    <Notice title="External opportunity benchmark connected" tone="info">ffopportunity contributes {d.external_benchmarks.ffopportunity.rows.toLocaleString()} cutoff-safe player-week rows across {d.external_benchmarks.ffopportunity.seasons} seasons. It remains a zero-authority shadow comparator until chronological validation proves it improves the shared engine.</Notice>
  </section>;
}

function SpecialistMatrix({ council, loading }: { council: any; loading: boolean }) {
  if (loading) return <Notice title="Loading specialist coverage" tone="info">Reading the reset model state without treating missing opinions as zero.</Notice>;
  if (!council) return <Notice title="Specialist coverage unavailable" tone="warn">The specialist reporting endpoint did not return a status.</Notice>;
  const reporting = council.reporting ?? {};
  const games = council.matrix?.games ?? [];
  const statusTone = (status: string) => status === 'forecast' ? 'bg-emerald-100 text-emerald-800'
    : status === 'support' ? 'bg-cyan-100 text-cyan-800'
      : status === 'missing' || status === 'not_recorded' ? 'bg-rose-100 text-rose-800'
        : 'bg-slate-100 text-slate-600';
  return <details className="card overflow-hidden" open>
    <summary className="cursor-pointer border-b border-slate-200 bg-cyan-50 px-4 py-4">
      <div className="font-black text-slate-900">Game × specialist truth matrix</div>
      <div className="mt-1 text-xs text-slate-600">{reporting.observed_outputs ?? 0} with observed output · {reporting.forecasting ?? 0} with numeric forecasts · {reporting.not_run ?? 0} not run · {reporting.zero_coverage ?? 0} with zero coverage</div>
    </summary>
    <div className="grid gap-px bg-slate-200 sm:grid-cols-4">
      <SignalCard label="Registered specialists" value={`${reporting.specialists ?? 12}`} detail="Every role stays visible" />
      <SignalCard label="Observed output" value={`${reporting.observed_outputs ?? 0}`} detail="Support or a forecast was actually present" />
      <SignalCard label="Numeric forecasts" value={`${reporting.forecasting ?? 0}`} detail="Eligible for directional scoring" />
      <SignalCard label="Zero coverage" value={`${reporting.zero_coverage ?? 0}`} detail="Explicitly missing, never converted to zero" tone={(reporting.zero_coverage ?? 0) ? 'bad' : 'neutral'} />
    </div>
    {games.length === 0
      ? <div className="p-4 text-sm text-slate-600">No post-reset audit games have been recorded yet. This is an empty model-memory state, not “12 specialists reporting.”</div>
      : <div className="overflow-x-auto"><table className="w-full text-left text-xs">
        <thead className="bg-slate-50 text-[9px] uppercase tracking-wide text-slate-400"><tr><th className="sticky left-0 bg-slate-50 px-3 py-2">Game</th>{(council.registry ?? []).map((expert: any) => <th key={expert.id} className="min-w-28 px-3 py-2">{expert.name}</th>)}</tr></thead>
        <tbody>{games.map((game: any) => <tr key={`${game.season}-${game.week}-${game.home}`} className="border-t border-slate-100"><td className="sticky left-0 bg-white px-3 py-2 font-bold text-slate-900">{game.away} @ {game.home}<div className="text-[9px] font-normal text-slate-400">{game.season} W{game.week}</div></td>{game.specialists.map((cell: any) => <td key={cell.id} className="px-3 py-2 align-top"><span className={`rounded px-1.5 py-1 text-[8px] font-black uppercase ${statusTone(cell.status)}`}>{cell.status.replaceAll('_', ' ')}</span><div className="mt-1 tabular-nums text-slate-700">{cell.forecast_residual == null ? '—' : `${cell.forecast_residual > 0 ? '+' : ''}${cell.forecast_residual}`}</div>{cell.missing_reason && <div className="mt-1 max-w-40 text-[9px] leading-4 text-rose-700">{cell.missing_reason}</div>}</td>)}</tr>)}</tbody>
      </table></div>}
    <div className="border-t border-slate-200 bg-slate-50 px-4 py-3 text-[11px] text-slate-600">{reporting.rule}</div>
  </details>;
}

function ProfitReadiness({ readiness: r }: { readiness: ProfitabilityOps['readiness'] }) {
  return <section className="space-y-4">
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
      <div className="text-[10px] font-black uppercase tracking-[0.14em] text-amber-700">Honest distance to profit</div>
      <div className="mt-1 text-xl font-black tracking-tight text-amber-950">{r.verdict}</div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <MiniReadout label="Historical blind audit" value={`${r.blind_audit.opened}/${r.blind_audit.total || '—'} · ${r.blind_audit.status}`} />
        <MiniReadout label="Untouched forward proof" value={`${r.blind_audit.forward.settled}/${r.blind_audit.forward.target} settled`} />
        <MiniReadout label="AI risk review" value={`${r.ai_review.reviewed} reviewed · ${r.ai_review.kept} kept · ${r.ai_review.staked}u`} />
      </div>
    </div>
    <div className="grid gap-3 lg:grid-cols-5">
      {r.phases.map(phase => {
        const progress = phase.total > 0 ? Math.min(100, (phase.completed / phase.total) * 100) : 0;
        const retired = phase.state === 'retired';
        return <div key={phase.id} className={`card overflow-hidden ${phase.id === r.closest_path ? 'ring-2 ring-emerald-300' : ''}`}>
          <div className="p-4">
            <div className="flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-full bg-slate-100 text-[10px] font-black text-slate-600">{phase.order + 1}</span><StatusPill tone={retired ? 'neutral' : phase.state === 'complete' || phase.state === 'ready' ? 'good' : 'warn'}>{phase.state.replaceAll('_', ' ')}</StatusPill></div>
            <div className="mt-3 text-sm font-black text-slate-900">{phase.title}</div>
            <div className="mt-1 text-xs font-semibold leading-5 text-slate-700">{phase.headline}</div>
            <p className="mt-1 text-[11px] leading-4 text-slate-500">{phase.detail}</p>
            {!retired && <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${progress}%` }} /></div>}
          </div>
          <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 text-[11px] leading-4 text-slate-600"><b>Next:</b> {phase.next_action}</div>
        </div>;
      })}
    </div>
  </section>;
}

function MiniReadout({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-amber-200 bg-white/70 px-3 py-2"><div className="text-[10px] font-bold uppercase tracking-wide text-amber-700">{label}</div><div className="mt-0.5 text-sm font-black text-slate-900">{value}</div></div>;
}

function NeuralReadout({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-violet-200 bg-violet-50/50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-violet-700">{label}</div><div className="mt-1 text-sm font-black text-slate-900">{value}</div></div>;
}
