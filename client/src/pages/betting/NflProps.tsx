import { useMemo, useState } from 'react';
import { api, headshotUrl, useApi } from '../../api';
import { BettingHero, EmptyState, Notice, SectionHeading, SignalCard, StatusPill } from '../../components/betting/BettingUI';

interface Proj {
  player: string; team: string; position: string | null; opponent: string | null;
  espn_id?: number | null; sleeper_id?: string | null; engine_version?: string; cutoff?: string;
  eligibility?: { state: string; markets: Record<string, boolean> };
  pass_yds: number; rush_yds: number; rec_yds: number; receptions: number; any_td_prob: number;
  percentiles: { rec_yds: number[]; rush_yds: number[]; pass_yds: number[] };
  game_script: { spread: number; total: number; implied_points: number } | null;
  signal_quality?: {
    candidate_paths_evaluated_by_registry: number; active_layers: number;
    missing_layers: string[]; confidence_ceiling: number; policy: string;
    layers: { id: string; label: string; status: string; authority: number;
      noise_class: string; evidence: string[] }[];
  };
}
interface BoardRow {
  market: string; market_label: string; player: string; team: string; position: string | null;
  matchup: string; line: number; side: string; american_price: number | null; book: string;
  model_probability: number; implied_probability: number | null;
  probability_difference: number | null; projection: number;
  espn_id?: number | null; sleeper_id?: string | null;
}
interface Payload { season: number; week: number; market_status: string; board: BoardRow[]; projections: Proj[]; }
interface AccuracyPayload {
  seasons: number[];
  coverage: { eligible: number; projected: number; rate: number | null };
  point_metrics: Record<string, { n: number; mae: number | null; rmse: number | null; bias: number | null }>;
  touchdown_probability: {
    n: number; brier: number | null; log_loss: number | null;
    reliability: { range: string; n: number; predicted: number | null; actual: number | null }[];
  };
  market_eligible: {
    point_metrics: Record<string, { n: number; mae: number | null; rmse: number | null; bias: number | null }>;
    touchdown_probability: AccuracyPayload['touchdown_probability'];
    rule: string;
  };
  note: string;
  calibration?: HeadPayload['prop_calibration']['active'];
}
interface HeadPayload {
  version: string; count: number; policy: string;
  heads: { id: string; name: string; family: string; status: string }[];
  audits: { validation_opened: number; result: { survivors: string[]; candidates_tested: number; candidates_redundant: number; validation_opened: boolean } }[];
  forward?: { settled: number; minimum_before_review: number; candidates: { id: string; mae: number | null; eligible_for_review: boolean }[] };
  prop_calibration: {
    count: number;
    active: null | { candidate_id: string; train_through: number; audit: {
      validation_passed: boolean;
      validation: { raw: { brier: number; log_loss: number; ece: number };
        candidate: { brier: number; log_loss: number; ece: number } };
    } };
  };
}
interface QuoteStatus { quotes: number; captures: number; events: number; first: string | null; latest: string | null; replay_ready: boolean; }
interface SystemStatus {
  pbp: { team: { season: number; rows: number; teams: number; through_week: number }[]; player: { season: number; rows: number; players: number }[] };
}

const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const american = (v: number | null) => (v == null ? '—' : v > 0 ? `+${v}` : `${v}`);
const POS_COLOR: Record<string, string> = {
  QB: 'bg-slate-100 text-slate-700', RB: 'bg-slate-100 text-slate-700',
  WR: 'bg-slate-100 text-slate-700', TE: 'bg-slate-100 text-slate-700'
};

export default function NflProps() {
  const [week, setWeek] = useState(1);
  const [season, setSeason] = useState(2026);
  const [fetched, setFetched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);

  const propApi = useApi<Payload>(`/nfl-betting/props?season=${season}&week=${week}&limit=60`);
  const accuracyApi = useApi<AccuracyPayload>(auditOpen ? '/nfl-betting/props/accuracy?seasons=2022,2023,2024,2025' : null);
  const accuracy = accuracyApi.data;
  const { data: system } = useApi<SystemStatus>('/nfl-betting/status');
  const { data: heads } = useApi<HeadPayload>('/nfl-betting/heads');
  const { data: quoteStatus } = useApi<QuoteStatus>('/nfl-betting/props/quotes/status');
  const shown = live ?? propApi.data;

  const refreshOdds = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<Payload>(`/nfl-betting/props?season=${season}&week=${week}&market=1&limit=60`);
      setLive(r); setFetched(true);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const top5 = useMemo(() => (shown?.board ?? []).slice(0, 5), [shown]);
  const playerRows = system?.pbp.player.reduce((n, s) => n + s.rows, 0) ?? 0;
  const teamRows = system?.pbp.team.reduce((n, s) => n + s.rows, 0) ?? 0;
  const auditN = accuracy?.touchdown_probability.n ?? 0;
  const operational = playerRows > 0 && teamRows > 0;
  const oddsConnected = !shown?.market_status?.includes('no ODDS_API_KEY');

  return (
    <div className="mx-auto max-w-[1440px] space-y-5">
      <BettingHero eyebrow="NFL player markets" title="Props Intelligence"
        description="Distribution-first player forecasts with a visible readiness gate. The page will not present edges until both historical usage and real market prices are available."
        status={<StatusPill tone={operational ? 'good' : 'warn'}>{operational ? 'Model ready' : 'Data required'}</StatusPill>}
        actions={<>
          <label className="flex items-center gap-2 text-sm text-slate-600"><span>Season</span>
            <select aria-label="NFL props season" className="rounded-lg border border-slate-300 bg-white px-3 py-2 font-bold text-slate-900"
              value={season} onChange={e => { setSeason(Number(e.target.value)); setLive(null); setFetched(false); }}>
              {[2025, 2026].map(s => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600"><span>Week</span>
            <select aria-label="NFL props week" className="rounded-lg border border-slate-300 bg-white px-3 py-2 font-bold text-slate-900"
              value={week} onChange={e => { setWeek(Number(e.target.value)); setLive(null); setFetched(false); }}>
              {Array.from({ length: 18 }, (_, i) => i + 1).map(w => <option key={w} value={w}>{w}</option>)}
            </select>
          </label>
          <button className="rounded-lg border border-sky-200 bg-sky-100 px-3 py-2 text-sm font-black text-sky-900 hover:bg-sky-200 disabled:opacity-50"
            onClick={refreshOdds} disabled={busy || !operational}>{busy ? 'Fetching…' : 'Fetch market prices'}</button>
        </>}
      >
        <StatusPill tone={playerRows ? 'good' : 'warn'}>{playerRows.toLocaleString()} player-week rows</StatusPill>
        <StatusPill tone={oddsConnected ? 'good' : 'neutral'}>{oddsConnected ? 'Odds connected' : 'Odds disconnected'}</StatusPill>
        <StatusPill tone={auditN ? 'info' : 'neutral'}>{auditN ? `${auditN.toLocaleString()} audited player-weeks` : 'Accuracy audit on demand'}</StatusPill>
        <StatusPill tone="neutral">{(heads?.count ?? 24) + (heads?.prop_calibration?.count ?? 24)} model + calibration heads</StatusPill>
      </BettingHero>

      {err && <Notice title="Market refresh failed" tone="bad">{err}</Notice>}

      {!operational ? <>
        <Notice title="The props engine is paused—not empty" tone="warn">
          Historical play-by-play has not been loaded into this database, so the model has no usage history and no legitimate calibration sample. Forecast cards stay off until that foundation exists.
        </Notice>
        <section>
          <SectionHeading eyebrow="Readiness gate" title="What is blocking production"
            description="All three checks must be healthy before this page can call anything an edge." />
          <div className="grid gap-3 md:grid-cols-3">
            <SignalCard label="Player usage" value={`${playerRows.toLocaleString()} rows`} detail="Targets, carries, attempts and role history" tone={playerRows ? 'good' : 'bad'} />
            <SignalCard label="Team context" value={`${teamRows.toLocaleString()} rows`} detail="Pace, efficiency, pressure and game state" tone={teamRows ? 'good' : 'bad'} />
            <SignalCard label="Calibration" value={`${auditN.toLocaleString()} samples`} detail="Walk-forward MAE, Brier and reliability" tone={auditN ? 'good' : 'bad'} />
          </div>
        </section>
        <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
          <div className="card p-5">
            <div className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">Activation sequence</div>
            <ol className="mt-4 space-y-4 text-sm leading-6 text-slate-600">
              <li className="flex gap-3"><Step n="1" /><span><b className="text-slate-900">Load 2022–2025 play-by-play.</b> Populate player and team week features.</span></li>
              <li className="flex gap-3"><Step n="2" /><span><b className="text-slate-900">Run the walk-forward audit.</b> Establish error and calibration by prop family.</span></li>
              <li className="flex gap-3"><Step n="3" /><span><b className="text-slate-900">Connect prices.</b> Compare the calibrated distribution to paired no-vig quotes.</span></li>
            </ol>
          </div>
          <EmptyState title="No projections are intentionally displayed"
            description="A blank slate is safer than generating player cards from zero usage history. Once the data sync is complete, this space becomes the live Week 1 projection board." />
        </div>
      </> : <>
        <div className={`rounded-xl border p-4 text-sm ${fetched ? 'border-blue-200 bg-blue-50/60 text-blue-800' : 'border-slate-300 bg-white text-slate-700'}`}>
          <b>{fetched ? 'Market response:' : 'Market status:'}</b> {shown?.market_status ?? 'Loading…'}
        </div>

        {!!top5.length && <section>
          <SectionHeading eyebrow="Priced opportunities" title="Top model-to-market gaps"
            description="Ranked only across fetched quotes. A partial Odds API pull is explicitly a partial board." />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">{top5.map((b, i) => <EdgeCard key={`${b.player}-${b.market}-${i}`} row={b} />)}</div>
        </section>}

        <section>
          <SectionHeading eyebrow="Projection board" title={`Week ${week} distributions${shown?.projections?.length ? ` · ${shown.projections.length} players` : ''}`}
            description="Expected values sit beside the 10th–90th percentile range so volatility remains visible." />
          {propApi.loading ? <div className="card p-6 text-sm text-slate-500">Simulating Week {week}…</div>
            : !shown?.projections?.length ? <EmptyState title="No projectable players" description="This week has no player with sufficient earlier usage history." />
            : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{shown.projections.map(p => <ProjectionCard key={`${p.team}-${p.player}`} player={p} />)}</div>}
        </section>

        <ModelLab heads={heads} quotes={quoteStatus} />
      </>}

      <AccuracyPanel data={accuracy} loading={accuracyApi.loading} onOpen={() => setAuditOpen(true)} />
    </div>
  );
}

function EdgeCard({ row: b }: { row: BoardRow }) {
  return <div className="card p-4">
    <div className="flex items-center gap-3"><Avatar name={b.player} position={b.position} espn_id={b.espn_id} sleeper_id={b.sleeper_id} /><div className="min-w-0"><div className="truncate font-black text-slate-900">{b.player}</div><div className="truncate text-xs text-slate-500">{b.team} · {b.book}</div></div></div>
    <div className="mt-4 text-sm font-black text-slate-800">{b.side} {b.line} · {b.market_label}</div>
    <div className="mt-1 text-2xl font-black text-slate-950">+{pct(b.probability_difference)}</div>
    <div className="mt-1 text-xs text-slate-500">Model {pct(b.model_probability)} · market {pct(b.implied_probability)} · {american(b.american_price)}</div>
  </div>;
}

function ProjectionCard({ player: p }: { player: Proj }) {
  return <div className="card p-4">
    <div className="flex items-center gap-3"><Avatar name={p.player} position={p.position} espn_id={p.espn_id} sleeper_id={p.sleeper_id} /><div className="min-w-0"><div className="truncate text-base font-black text-slate-900">{p.player}</div><div className="text-xs text-slate-500">{p.team}{p.opponent ? ` vs ${p.opponent}` : ''}{p.game_script ? ` · total ${p.game_script.total}` : ''}</div></div></div>
    <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
      {p.pass_yds > 20 && <Stat label="Pass yards" value={p.pass_yds.toFixed(0)} band={p.percentiles.pass_yds} />}
      {p.rush_yds > 5 && <Stat label="Rush yards" value={p.rush_yds.toFixed(0)} band={p.percentiles.rush_yds} />}
      {p.rec_yds > 5 && <Stat label="Rec yards" value={p.rec_yds.toFixed(0)} band={p.percentiles.rec_yds} />}
      {p.receptions > 0.5 && <Stat label="Receptions" value={p.receptions.toFixed(1)} />}
      <Stat label="Any TD" value={pct(p.any_td_prob)} />
    </div>
    <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-slate-500">
      <span className="rounded-full bg-slate-100 px-2 py-1">{p.eligibility?.state?.replaceAll('_', ' ') ?? 'pregame role screened'}</span>
      {p.cutoff && <span className="rounded-full bg-slate-100 px-2 py-1">data through {p.cutoff}</span>}
    </div>
    {p.signal_quality && <details className="mt-3 rounded-lg border border-slate-200 bg-white text-xs">
      <summary className="cursor-pointer px-3 py-2 font-bold text-slate-700">
        Signal truth · {p.signal_quality.active_layers} active layers · ceiling {pct(p.signal_quality.confidence_ceiling)}
      </summary>
      <div className="border-t border-slate-100 px-3 py-2">
        <div className="mb-2 text-slate-500">{p.signal_quality.candidate_paths_evaluated_by_registry} shadow paths · missing: {p.signal_quality.missing_layers.join(', ') || 'none'}</div>
        <div className="space-y-1.5">{p.signal_quality.layers.map(x => <div key={x.id} className="flex items-start justify-between gap-3">
          <span><b className="text-slate-800">{x.label}</b><span className="text-slate-500"> · {x.evidence[0] ?? x.noise_class}</span></span>
          <span className={`shrink-0 rounded-full px-2 py-0.5 ${x.authority ? 'bg-slate-100 text-slate-700' : 'bg-amber-50 text-amber-700'}`}>{x.status.replaceAll('_', ' ')}</span>
        </div>)}</div>
      </div>
    </details>}
  </div>;
}

function AccuracyPanel({ data, loading, onOpen }: { data: AccuracyPayload | null; loading: boolean; onOpen: () => void }) {
  const labels: Record<string, string> = { pass_yds: 'Passing yards', rush_yds: 'Rushing yards', rec_yds: 'Receiving yards', receptions: 'Receptions' };
  const buckets = data?.touchdown_probability.reliability.filter(x => x.n > 0) ?? [];
  return <details className="card overflow-hidden group" onToggle={e => { if (e.currentTarget.open) onOpen(); }}>
    <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-4 hover:bg-slate-50">
      <div className="min-w-0 flex-1"><div className="font-black text-slate-900">Walk-forward accuracy audit</div><div className="text-sm text-slate-500">Point error and touchdown calibration by historical player-week.</div></div>
      <StatusPill tone={data?.touchdown_probability.n ? 'info' : 'neutral'}>{data?.touchdown_probability.n ? `${data.touchdown_probability.n.toLocaleString()} samples` : 'Run on open'}</StatusPill>
      <span className="text-sm font-bold text-slate-400 group-open:hidden">Open</span>
    </summary>
    <div className="border-t border-slate-200 p-4">
      {!data ? <Notice title={loading ? 'Running four-season audit' : 'Audit loads only when opened'} tone="info">The live projection board remains responsive while the CPU-heavy 2022–2025 walk-forward report runs separately. Results are cached for six hours.</Notice>
        : !data.touchdown_probability.n ? <Notice title="Audit unavailable" tone="warn">Sync historical play-by-play to populate the accuracy and reliability report.</Notice>
        : <div className="space-y-5">
          <Notice title="Two populations, shown together" tone="info">{data.note}</Notice>
          <div className="grid gap-5 xl:grid-cols-2">
            <MetricTable title="All projected player-weeks" metrics={data.point_metrics} labels={labels} />
            <MetricTable title="Pregame market-eligible roles" metrics={data.market_eligible.point_metrics} labels={labels} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SignalCard label="Broad TD Brier" value={data.touchdown_probability.brier ?? '—'} />
            <SignalCard label="Eligible TD Brier" value={data.market_eligible.touchdown_probability.brier ?? '—'} />
            <SignalCard label="Projection coverage" value={pct(data.coverage.rate)} detail={`${data.coverage.projected}/${data.coverage.eligible} eligible identities resolved`} />
            <SignalCard label="Eligibility rule" value="Outcome-blind" detail={data.market_eligible.rule} />
            {data.calibration?.audit?.validation && <SignalCard label="Active TD calibration" value={data.calibration.candidate_id}
              detail={`Validation ECE ${(data.calibration.audit.validation.raw.ece * 100).toFixed(2)}% → ${(data.calibration.audit.validation.candidate.ece * 100).toFixed(2)}% · trained through ${data.calibration.train_through}`} tone="good" />}
          </div>
          {!!buckets.length && <div className="text-sm text-slate-500">{buckets.length} populated broad-population TD reliability buckets.</div>}
        </div>}
    </div>
  </details>;
}

function MetricTable({ title, metrics, labels }: { title: string; metrics: AccuracyPayload['point_metrics']; labels: Record<string, string> }) {
  return <div><div className="mb-2 text-sm font-black text-slate-900">{title}</div><div className="overflow-x-auto rounded-xl border border-slate-200"><table className="w-full text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr>{['Stat', 'N', 'MAE', 'RMSE', 'Bias'].map(h => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{Object.entries(metrics).map(([key, m]) => <tr key={key}><td className="px-3 py-2 font-bold">{labels[key] ?? key}</td><td className="px-3 py-2">{m.n}</td><td className="px-3 py-2">{m.mae ?? '—'}</td><td className="px-3 py-2">{m.rmse ?? '—'}</td><td className="px-3 py-2">{m.bias ?? '—'}</td></tr>)}</tbody></table></div></div>;
}

function ModelLab({ heads, quotes }: { heads: HeadPayload | null; quotes: QuoteStatus | null }) {
  const latest = heads?.audits?.[0]?.result;
  const survivors = latest?.survivors ?? [];
  const forward = heads?.forward;
  const calibration = heads?.prop_calibration;
  return <section>
    <SectionHeading eyebrow="Model lab" title="Hundreds of paths, sparse authority"
      description="Player heads, prop calibrators and 416 uncertainty paths compete in shadow. Redundancy is removed, multiplicity is corrected, and only repeated chronological wins can affect the live number." />
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <SignalCard label="Candidate registry" value={`${heads?.count ?? 24} heads`} detail={`${heads?.version ?? 'versioned'} · every head is shadow-only`} tone="info" />
      <SignalCard label="Discovery survivors" value={latest ? `${survivors.length}` : 'Not run'} detail={latest ? `${latest.candidates_tested} tested after ${latest.candidates_redundant} redundant heads were removed${survivors.length ? ` · ${survivors.join(', ')}` : ''}` : 'No discovery audit has been persisted.'} tone={survivors.length ? 'good' : 'neutral'} />
      <SignalCard label="Sealed validation" value={latest?.validation_opened ? 'Opened' : 'Closed'} detail="Opening the holdout is explicit, persisted, and cannot be undone." tone={latest?.validation_opened ? 'warn' : 'good'} />
      <SignalCard label="Forward evidence" value={`${forward?.settled ?? 0}/${forward?.minimum_before_review ?? 250}`} detail="First-write immutable weekly snapshots; review eligibility is not promotion." tone={(forward?.settled ?? 0) >= (forward?.minimum_before_review ?? 250) ? 'info' : 'neutral'} />
      <SignalCard label="Live prop quotes" value={`${quotes?.quotes ?? 0}`} detail={quotes?.latest ? `${quotes.captures} captures across ${quotes.events} events · latest ${new Date(quotes.latest).toLocaleString()}` : 'Real sportsbook lines begin accumulating when Fetch market prices is used.'} tone={quotes?.replay_ready ? 'good' : 'warn'} />
      <SignalCard label="TD calibration registry" value={`${calibration?.count ?? 24} heads`} detail={calibration?.active ? `${calibration.active.candidate_id} is active after repeated validation; all others remain shadow.` : 'No candidate has repeated out of sample; raw probabilities stay active.'} tone={calibration?.active ? 'good' : 'warn'} />
      <SignalCard label="Signal truth paths" value="416 shadow" detail="13 uncertainty layers × 8 methods × 4 horizons. Missing or correlated evidence lowers confidence; it never creates edge." tone="info" />
    </div>
  </section>;
}

function Stat({ label, value, band }: { label: string; value: string; band?: number[] }) {
  return <div className="rounded-lg bg-slate-50 p-2.5"><div className="text-xs font-bold uppercase tracking-wide text-slate-400">{label}</div><div className="text-lg font-black text-slate-900">{value}</div>{band?.length === 3 && <div className="text-xs text-slate-500">80% range {band[0]?.toFixed(0)}–{band[2]?.toFixed(0)}</div>}</div>;
}

function Step({ n }: { n: string }) { return <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-sky-200 bg-sky-100 text-xs font-black text-sky-900">{n}</span>; }

function Avatar({ name, position, espn_id, sleeper_id }: { name: string; position: string | null; espn_id?: number | null; sleeper_id?: string | null }) {
  const initials = String(name ?? '?').replace(/[^A-Za-z. ]/g, '').split(/[. ]+/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase();
  const src = headshotUrl({ espn_id, sleeper_id });
  return <div className={`relative grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full text-xs font-black ${POS_COLOR[position ?? ''] ?? 'bg-slate-100 text-slate-500'}`}>
    <span>{initials || '?'}</span>
    {src && <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" onError={e => { e.currentTarget.style.display = 'none'; }} />}
  </div>;
}
