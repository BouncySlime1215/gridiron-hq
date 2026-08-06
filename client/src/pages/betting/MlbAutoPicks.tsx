import { useMemo, useState } from 'react';
import { api, useApi } from '../../api';
import { BettingHero, EmptyState, Notice, SectionHeading, SignalCard, StatusPill } from '../../components/betting/BettingUI';

interface Pick {
  pick_date: string; rank: number; market: string; selection: string;
  player_id: number | null; matchup: string | null; game_pk: number | null;
  side: string; line: number | null; model_probability: number | null;
  projection: number | null; selected_at: string; tracking_mode: 'forward' | 'retrospective';
  status: 'Won' | 'Lost' | 'Push' | 'Void' | 'Pending'; detail: string; units: number | null;
  american_price: number | null; implied_probability: number | null; probability_difference: number | null;
  book: string | null; quote_at: string | null; pregame_snapshot_at: string | null; lineup_status: string | null;
  model_version: string | null; evidence_eligible: boolean;
}
interface MarketRow { market: string; picks: number; wins: number; losses: number; win_rate: number | null; }
interface Standing {
  wins: number; losses: number; pushes: number; voids: number; pending: number;
  win_rate: number | null; units: number | null; roi: number | null; priced_settled: number;
  quarantined: number; days_tracked: number; by_market: MarketRow[];
}
interface Payload {
  requested_date: string; slate_date: string | null; today: Pick[]; history: Pick[]; standing: Standing;
  economics: { available: boolean; odds_feed: boolean; note: string };
}
interface AuditMetric {
  n: number; wins: number; losses: number; win_rate: number | null;
  brier: number | null; log_loss: number | null; win_rate_95: [number | null, number | null];
  status: 'validated' | 'provisional' | 'insufficient';
  reliability?: { range: string; n: number; predicted: number | null; actual: number | null }[];
}
interface PregameStatus {
  snapshots: { slate_date: string; games: number; captures: number; confirmed_lineups: number; latest: string | null }[];
  quotes: { market: string; quotes: number; games: number; first_capture: string; last_capture: string }[];
  odds_api: { has_key: boolean };
}
interface MlbExperiment { id: number; market: string; name: string; hypothesis: string; verdict: string | null; validation_passed: boolean | null; spec: { provenance: { model_version: string; data_snapshot_hash: string } }; }
interface Audit {
  season: number; through_date: string; sampled_dates: number; overall: AuditMetric;
  by_market: Record<string, AuditMetric>; note: string;
}

const MARKET_LABEL: Record<string, string> = {
  nrfi: 'NRFI / YRFI', batter_total_bases: 'Total bases', pitcher_strikeouts: 'Strikeouts'
};
const STATUS_STYLE: Record<string, string> = {
  Won: 'bg-slate-100 text-slate-800 border-slate-300', Lost: 'bg-white text-rose-700 border-rose-200',
  Push: 'bg-slate-100 text-slate-600 border-slate-300', Void: 'bg-slate-100 text-slate-500 border-slate-200',
  Pending: 'bg-white text-slate-600 border-slate-300'
};
const pct = (v: number | null | undefined) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
const fmtDate = (d: string) => {
  const x = new Date(`${d}T12:00:00`);
  return Number.isNaN(x.getTime()) ? d : x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const localIsoDate = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

export default function MlbAutoPicks() {
  const [localDate] = useState(localIsoDate);
  const [busy, setBusy] = useState(false);
  const [auditBusy, setAuditBusy] = useState(false);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [visibleDays, setVisibleDays] = useState(5);
  const pickApi = useApi<Payload>(`/mlb/auto-picks?date=${localDate}`);
  const pregameApi = useApi<PregameStatus>('/mlb/pregame/status');
  const { data: experimentData } = useApi<{ experiments: MlbExperiment[] }>('/mlb/experiments');

  const byDate = useMemo(() => {
    const m = new Map<string, Pick[]>();
    for (const p of pickApi.data?.history ?? []) {
      if (p.pick_date > localDate || p.pick_date === pickApi.data?.slate_date) continue;
      const arr = m.get(p.pick_date) ?? []; arr.push(p); m.set(p.pick_date, arr);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [pickApi.data, localDate]);

  const backfill = async () => {
    setBusy(true); setActionError(null);
    try { await api(`/mlb/auto-picks/backfill?days=21&through=${localDate}`, { method: 'POST' }); await pickApi.refetch(); }
    catch (e: any) { setActionError(e.message); }
    finally { setBusy(false); }
  };
  const runAudit = async () => {
    setAuditBusy(true); setActionError(null);
    try { setAudit(await api(`/mlb/model/accuracy?through=${localDate}&lookback_days=120&cadence_days=14`)); }
    catch (e: any) { setActionError(e.message); }
    finally { setAuditBusy(false); }
  };
  const capturePregame = async () => {
    setBusy(true); setActionError(null);
    try {
      await api(`/mlb/pregame/snapshot?date=${localDate}`, { method: 'POST' });
      await Promise.all([pregameApi.refetch(), pickApi.refetch()]);
    } catch (e: any) { setActionError(e.message); }
    finally { setBusy(false); }
  };

  if (pickApi.loading) return <div className="card p-6 text-sm text-slate-500">Building the current MLB slate…</div>;
  if (pickApi.error) return <Notice title="MLB slate unavailable" tone="bad">{pickApi.error}</Notice>;

  const data = pickApi.data;
  const s = data?.standing;
  const settled = (s?.wins ?? 0) + (s?.losses ?? 0);
  const retrospective = data?.history.filter(p => p.tracking_mode === 'retrospective').length ?? 0;
  const forward = data?.history.filter(p => p.tracking_mode === 'forward').length ?? 0;
  const slateIsRetrospective = !!data?.today.length && data.today.every(p => p.tracking_mode === 'retrospective');
  const slateIsQuarantined = !!data?.today.length && data.today.every(p => !p.evidence_eligible);
  const marketStatus = audit ? Object.values(audit.by_market).every(x => x.status === 'insufficient') ? 'Sample insufficient' : 'Calibration available' : 'Audit not run';
  const latestCapture = pregameApi.data?.snapshots?.[0]?.latest ?? null;

  return (
    <div className="mx-auto max-w-[1440px] space-y-5">
      <BettingHero eyebrow="MLB projection lab" title="Daily Picks Tracker"
        description="Pregame-only selections with preserved starters, lineups and real book quotes. Anything reconstructed or missing cutoff evidence is visibly quarantined."
        status={<StatusPill tone={data?.economics.available ? 'good' : 'warn'}>{data?.economics.available ? 'Priced forward ledger' : 'Forward evidence pending'}</StatusPill>}
        actions={<><button className="btn-ghost text-sm" onClick={capturePregame} disabled={busy}>{busy ? 'Capturing…' : 'Capture pregame slate'}</button><button className="btn-primary text-sm"
          onClick={runAudit} disabled={auditBusy}>{auditBusy ? 'Auditing…' : 'Run calibration audit'}</button></>}
      >
        <StatusPill tone="neutral">Local slate · {fmtDate(localDate)}</StatusPill>
        <StatusPill tone={pregameApi.data?.odds_api.has_key ? 'good' : 'warn'}>{pregameApi.data?.odds_api.has_key ? 'Odds feed connected' : 'Odds key unavailable'}</StatusPill>
        <StatusPill tone={latestCapture ? 'info' : 'warn'}>{latestCapture ? `Fresh ${new Date(latestCapture).toLocaleString()}` : 'No pregame snapshot'}</StatusPill>
        <StatusPill tone={audit && audit.overall.n >= 30 ? 'info' : 'warn'}>{marketStatus}</StatusPill>
      </BettingHero>

      {actionError && <Notice title="Action failed" tone="bad">{actionError}</Notice>}
      <Notice title="Economics intentionally hidden" tone="warn">
        {data?.economics.note ?? 'No MLB prices are stored.'} The previous flat −110 units were hypothetical and are no longer presented as performance.
      </Notice>

      {data?.slate_date && data.slate_date !== data.requested_date && (
        <Notice title={`Showing ${fmtDate(data.slate_date)} instead of ${fmtDate(data.requested_date)}`} tone="warn">
          The local schedule does not yet contain the requested slate. This is the most recent date with stored games and model candidates.
        </Notice>
      )}

      <section>
        <SectionHeading eyebrow={slateIsQuarantined ? 'Quarantined slate' : slateIsRetrospective ? 'Most recent retrospective slate' : 'Current slate'}
          title={data?.slate_date ? fmtDate(data.slate_date) : 'No synced slate'}
          description={slateIsQuarantined
            ? 'These rows are visible for audit continuity only. They lack a real pregame price or preserved cutoff snapshot and are excluded from every performance claim.'
            : slateIsRetrospective
            ? 'These selections were reconstructed after the slate date and count only toward the retrospective calibration ledger.'
            : "Probability is the model's unpriced directional confidence. It is not a sportsbook edge."} />
        {!data?.today.length ? <EmptyState title="No model selection for this slate"
          description="No candidate met the plausible-line band, or the current schedule and probable starters have not been synced." />
          : <div className="grid gap-3 lg:grid-cols-5">{data.today.map(p => <PickCard key={`${p.pick_date}-${p.rank}`} pick={p} />)}</div>}
      </section>

      <section>
        <SectionHeading eyebrow="Evidence ledger" title="What has actually been measured"
          description="Retrospective backfills and forward selections are counted separately so historical reconstruction cannot masquerade as a live record." />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <SignalCard label="Graded predictions" value={settled.toLocaleString()} detail={`${s?.wins ?? 0} correct · ${s?.losses ?? 0} incorrect`} />
          <SignalCard label="Directional hit rate" value={pct(s?.win_rate)} detail="Does not include price or break-even" tone="info" />
          <SignalCard label="Retrospective rows" value={retrospective.toLocaleString()} detail="Generated after the historical slate date" tone={retrospective ? 'warn' : 'good'} />
          <SignalCard label="Forward rows" value={forward.toLocaleString()} detail="Selected on or before the slate date" />
          <SignalCard label="Pending" value={(s?.pending ?? 0).toLocaleString()} detail={`${s?.voids ?? 0} void · ${s?.pushes ?? 0} push`} />
          <SignalCard label="Quarantined" value={(s?.quarantined ?? 0).toLocaleString()} detail="Excluded: missing price, snapshot, or current model version" tone={(s?.quarantined ?? 0) ? 'warn' : 'good'} />
        </div>
      </section>

      {audit && <AuditPanel audit={audit} />}

      {!!experimentData?.experiments.length && <section>
        <SectionHeading eyebrow="Locked research" title="Market-specific experiment registry"
          description="Each hypothesis pins its model version and data snapshot before independent validation and one-time holdout access." />
        <div className="grid gap-3 md:grid-cols-2">{experimentData.experiments.map(x => <div key={x.id} className="card p-4">
          <div className="flex items-center gap-2"><StatusPill tone="neutral">{MARKET_LABEL[x.market] ?? x.market}</StatusPill><span className="ml-auto text-xs text-slate-400">#{x.id}</span></div>
          <div className="mt-3 font-semibold text-slate-900">{x.name}</div><p className="mt-1 text-sm leading-5 text-slate-500">{x.hypothesis}</p>
          <div className="mt-3 flex items-center gap-2"><StatusPill tone={x.validation_passed ? 'good' : x.verdict ? 'bad' : 'warn'}>{x.verdict ?? 'Locked; not run'}</StatusPill><span className="text-[10px] text-slate-400">{x.spec.provenance.model_version}</span></div>
        </div>)}</div>
      </section>}

      {!!s?.by_market.length && <section>
        <SectionHeading eyebrow="Market cuts" title="Directional results by model family"
          description="Each family must earn calibration independently; a combined record cannot rescue a weak market." />
        <div className="grid gap-3 md:grid-cols-3">{s.by_market.map(m => (
          <div key={m.market} className="card p-4"><div className="text-sm font-black text-slate-900">{MARKET_LABEL[m.market] ?? m.market}</div><div className="mt-3 flex items-end gap-5"><div><div className="text-xs font-bold uppercase tracking-wide text-slate-400">Record</div><div className="text-xl font-black">{m.wins}-{m.losses}</div></div><div><div className="text-xs font-bold uppercase tracking-wide text-slate-400">Hit rate</div><div className="text-xl font-black">{pct(m.win_rate)}</div></div><div className="ml-auto text-sm text-slate-500">{m.picks} rows</div></div></div>
        ))}</div>
      </section>}

      <details className="card overflow-hidden group">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-4 hover:bg-slate-50">
          <div className="min-w-0 flex-1"><div className="text-base font-black text-slate-900">Retrospective research ledger</div><div className="text-sm text-slate-500">Historical slates are useful for calibration, but they are not a live betting record.</div></div>
          <StatusPill tone="neutral">{byDate.length} dates</StatusPill>
          <span className="text-sm font-bold text-slate-400 group-open:hidden">Open</span>
        </summary>
        <div className="border-t border-slate-200 p-4">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <button className="btn-ghost text-sm" onClick={backfill} disabled={busy}>{busy ? 'Generating…' : 'Generate 21-day retrospective audit'}</button>
            <p className="text-sm text-slate-500">This action reconstructs model selections from earlier data. Results remain labeled retrospective.</p>
          </div>
          {!byDate.length ? <EmptyState title="No historical audit rows" description="Generate a retrospective audit to inspect earlier model behavior." />
            : <div className="space-y-3">{byDate.slice(0, visibleDays).map(([date, picks]) => <DayLedger key={date} date={date} picks={picks} />)}</div>}
          {byDate.length > visibleDays && <button className="btn-ghost mt-3 text-sm" onClick={() => setVisibleDays(n => n + 7)}>Show 7 more dates</button>}
        </div>
      </details>
    </div>
  );
}

function PickCard({ pick: p }: { pick: Pick }) {
  return <div className="card p-4">
    <div className="flex items-center justify-between gap-2"><span className="grid h-7 w-7 place-items-center rounded-full bg-sky-100 text-xs font-bold text-sky-900 ring-1 ring-sky-200">{p.rank}</span><StatusPill tone={!p.evidence_eligible || p.tracking_mode === 'retrospective' ? 'warn' : 'good'}>{!p.evidence_eligible ? 'quarantined' : p.tracking_mode}</StatusPill></div>
    <div className="mt-4 min-h-11"><div className="font-black leading-5 text-slate-900">{p.selection}</div><div className="mt-0.5 text-xs text-slate-500">{MARKET_LABEL[p.market] ?? p.market}</div></div>
    <div className="mt-3 text-lg font-black text-slate-800">{p.side}{p.line != null ? ` ${p.line}` : ''}</div>
    <div className="mt-1 text-2xl font-black text-slate-950">{p.american_price == null ? pct(p.model_probability) : `${p.american_price > 0 ? '+' : ''}${p.american_price}`}</div>
    <div className="text-xs text-slate-500">{p.american_price == null ? 'model confidence' : `${p.book} · ${pct(p.probability_difference)} calibrated gap`}{p.projection != null ? ` · projection ${p.projection.toFixed(2)}` : ''}</div>
    <div className="mt-2 text-[10px] leading-4 text-slate-400">{p.pregame_snapshot_at ? `Snapshot ${new Date(p.pregame_snapshot_at).toLocaleString()} · ${p.lineup_status ?? 'lineup unknown'}` : 'No preserved pregame snapshot'}</div>
    <div className="mt-3 border-t border-slate-100 pt-3"><span className={`rounded-full border px-2 py-1 text-xs font-bold ${STATUS_STYLE[p.status]}`}>{p.status}</span><div className="mt-2 text-xs leading-5 text-slate-500">{p.detail}</div></div>
  </div>;
}

function AuditPanel({ audit }: { audit: Audit }) {
  return <section>
    <SectionHeading eyebrow="Blind calibration" title={`${audit.sampled_dates} fixed-cadence slates through ${fmtDate(audit.through_date)}`}
      description="Every prediction uses earlier games only. Market-level sample status governs the verdict." />
    <div className="card overflow-hidden"><div className="overflow-x-auto"><table className="w-full text-sm">
      <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400"><tr>{['Model family', 'Sample', 'Record', 'Hit rate', '95% interval', 'Brier', 'Status'].map(h => <th key={h} className="whitespace-nowrap px-4 py-3 text-left font-bold">{h}</th>)}</tr></thead>
      <tbody className="divide-y divide-slate-100">{Object.entries(audit.by_market).map(([market, m]) => <tr key={market}><td className="px-4 py-3 font-black">{MARKET_LABEL[market] ?? market}</td><td className="px-4 py-3">{m.n}</td><td className="px-4 py-3">{m.wins}-{m.losses}</td><td className="px-4 py-3 font-bold">{pct(m.win_rate)}</td><td className="px-4 py-3">{pct(m.win_rate_95[0])}–{pct(m.win_rate_95[1])}</td><td className="px-4 py-3">{m.brier ?? '—'}</td><td className="px-4 py-3"><StatusPill tone={m.status === 'validated' ? 'good' : m.status === 'provisional' ? 'warn' : 'neutral'}>{m.status}</StatusPill></td></tr>)}</tbody>
    </table></div><div className="border-t border-slate-200 px-4 py-3 text-sm text-slate-500">{audit.note}</div></div>
    <div className="mt-3 grid gap-3 md:grid-cols-3">{Object.entries(audit.by_market).map(([market, m]) => <Reliability key={market} label={MARKET_LABEL[market] ?? market} bins={m.reliability ?? []} />)}</div>
  </section>;
}

function Reliability({ label, bins }: { label: string; bins: NonNullable<AuditMetric['reliability']> }) {
  return <div className="card p-4"><div className="text-sm font-semibold text-slate-900">{label} reliability</div>
    <div className="mt-4 flex h-24 items-end gap-2">{bins.map(b => <div key={b.range} className="flex h-full flex-1 items-end gap-px border-b border-slate-200" title={`${b.range}: n=${b.n}`}><span className="w-1/2 rounded-t bg-cyan-200" style={{ height: `${(b.predicted ?? 0) * 100}%` }} /><span className="w-1/2 rounded-t bg-sky-500" style={{ height: `${(b.actual ?? 0) * 100}%` }} /></div>)}</div>
    <div className="mt-2 text-[10px] text-slate-500">Blue predicted · black observed</div>
  </div>;
}

function DayLedger({ date, picks }: { date: string; picks: Pick[] }) {
  const wins = picks.filter(p => p.status === 'Won').length;
  const losses = picks.filter(p => p.status === 'Lost').length;
  return <details className="rounded-xl border border-slate-200 overflow-hidden">
    <summary className="flex cursor-pointer list-none items-center gap-3 bg-slate-50 px-4 py-3"><span className="font-black text-slate-800">{fmtDate(date)}</span><StatusPill tone={picks.some(p => p.tracking_mode === 'retrospective') ? 'warn' : 'neutral'}>{picks[0]?.tracking_mode ?? 'unknown'}</StatusPill><span className="ml-auto text-sm font-bold text-slate-500">{wins}-{losses}</span></summary>
    <div className="overflow-x-auto"><table className="w-full text-sm"><tbody className="divide-y divide-slate-100">{picks.sort((a, b) => a.rank - b.rank).map(p => <tr key={p.rank}><td className="px-4 py-3 text-slate-400">{p.rank}</td><td className="px-4 py-3"><div className="font-bold text-slate-900">{p.selection}</div><div className="text-xs text-slate-500">{MARKET_LABEL[p.market] ?? p.market}{p.projection != null ? ` · projection ${p.projection.toFixed(2)}` : ''}</div></td><td className="whitespace-nowrap px-4 py-3 font-bold">{p.side}{p.line != null ? ` ${p.line}` : ''}</td><td className="px-4 py-3">{pct(p.model_probability)}</td><td className="px-4 py-3"><span className={`rounded-full border px-2 py-1 text-xs font-bold ${STATUS_STYLE[p.status]}`}>{p.status}</span></td><td className="px-4 py-3 text-slate-500">{p.detail}</td></tr>)}</tbody></table></div>
  </details>;
}
