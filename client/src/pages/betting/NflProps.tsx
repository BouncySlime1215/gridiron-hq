import { useMemo, useState } from 'react';
import { api, useApi } from '../../api';
import { BettingHero, EmptyState, Notice, SectionHeading, SignalCard, StatusPill } from '../../components/betting/BettingUI';

interface Proj {
  player: string; team: string; position: string | null; opponent: string | null;
  pass_yds: number; rush_yds: number; rec_yds: number; receptions: number; any_td_prob: number;
  percentiles: { rec_yds: number[]; rush_yds: number[]; pass_yds: number[] };
  game_script: { spread: number; total: number; implied_points: number } | null;
}
interface BoardRow {
  market: string; market_label: string; player: string; team: string; position: string | null;
  matchup: string; line: number; side: string; american_price: number | null; book: string;
  model_probability: number; implied_probability: number | null;
  probability_difference: number | null; projection: number;
}
interface Payload { season: number; week: number; market_status: string; board: BoardRow[]; projections: Proj[]; }
interface AccuracyPayload {
  seasons: number[];
  point_metrics: Record<string, { n: number; mae: number | null; rmse: number | null; bias: number | null }>;
  touchdown_probability: {
    n: number; brier: number | null; log_loss: number | null;
    reliability: { range: string; n: number; predicted: number | null; actual: number | null }[];
  };
}
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

  const propApi = useApi<Payload>(`/nfl-betting/props?season=${season}&week=${week}&limit=60`);
  const { data: accuracy } = useApi<AccuracyPayload>('/nfl-betting/props/accuracy?seasons=2022,2023,2024,2025');
  const { data: system } = useApi<SystemStatus>('/nfl-betting/status');
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
  const operational = playerRows > 0 && auditN > 0;
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
        <StatusPill tone={auditN ? 'info' : 'warn'}>{auditN.toLocaleString()} audited player-weeks</StatusPill>
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
      </>}

      {accuracy && <AccuracyPanel data={accuracy} />}
    </div>
  );
}

function EdgeCard({ row: b }: { row: BoardRow }) {
  return <div className="card p-4">
    <div className="flex items-center gap-3"><Avatar name={b.player} position={b.position} /><div className="min-w-0"><div className="truncate font-black text-slate-900">{b.player}</div><div className="truncate text-xs text-slate-500">{b.team} · {b.book}</div></div></div>
    <div className="mt-4 text-sm font-black text-slate-800">{b.side} {b.line} · {b.market_label}</div>
    <div className="mt-1 text-2xl font-black text-slate-950">+{pct(b.probability_difference)}</div>
    <div className="mt-1 text-xs text-slate-500">Model {pct(b.model_probability)} · market {pct(b.implied_probability)} · {american(b.american_price)}</div>
  </div>;
}

function ProjectionCard({ player: p }: { player: Proj }) {
  return <div className="card p-4">
    <div className="flex items-center gap-3"><Avatar name={p.player} position={p.position} /><div className="min-w-0"><div className="truncate text-base font-black text-slate-900">{p.player}</div><div className="text-xs text-slate-500">{p.team}{p.opponent ? ` vs ${p.opponent}` : ''}{p.game_script ? ` · total ${p.game_script.total}` : ''}</div></div></div>
    <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
      {p.pass_yds > 20 && <Stat label="Pass yards" value={p.pass_yds.toFixed(0)} band={p.percentiles.pass_yds} />}
      {p.rush_yds > 5 && <Stat label="Rush yards" value={p.rush_yds.toFixed(0)} band={p.percentiles.rush_yds} />}
      {p.rec_yds > 5 && <Stat label="Rec yards" value={p.rec_yds.toFixed(0)} band={p.percentiles.rec_yds} />}
      {p.receptions > 0.5 && <Stat label="Receptions" value={p.receptions.toFixed(1)} />}
      <Stat label="Any TD" value={pct(p.any_td_prob)} />
    </div>
  </div>;
}

function AccuracyPanel({ data }: { data: AccuracyPayload }) {
  const labels: Record<string, string> = { pass_yds: 'Passing yards', rush_yds: 'Rushing yards', rec_yds: 'Receiving yards', receptions: 'Receptions' };
  const buckets = data.touchdown_probability.reliability.filter(x => x.n > 0);
  return <details className="card overflow-hidden group">
    <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-4 hover:bg-slate-50">
      <div className="min-w-0 flex-1"><div className="font-black text-slate-900">Walk-forward accuracy audit</div><div className="text-sm text-slate-500">Point error and touchdown calibration by historical player-week.</div></div>
      <StatusPill tone={data.touchdown_probability.n ? 'info' : 'warn'}>{data.touchdown_probability.n.toLocaleString()} samples</StatusPill>
      <span className="text-sm font-bold text-slate-400 group-open:hidden">Open</span>
    </summary>
    <div className="border-t border-slate-200 p-4">
      {!data.touchdown_probability.n ? <Notice title="Audit unavailable" tone="warn">Sync historical play-by-play to populate the accuracy and reliability report.</Notice>
        : <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-xs uppercase tracking-wide text-slate-400"><tr>{['Stat', 'N', 'MAE', 'RMSE', 'Bias'].map(h => <th key={h} className="py-2 pr-4 text-left">{h}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{Object.entries(data.point_metrics).map(([key, m]) => <tr key={key}><td className="py-2 pr-4 font-bold">{labels[key] ?? key}</td><td className="py-2 pr-4">{m.n}</td><td className="py-2 pr-4">{m.mae ?? '—'}</td><td className="py-2 pr-4">{m.rmse ?? '—'}</td><td className="py-2 pr-4">{m.bias ?? '—'}</td></tr>)}</tbody></table></div>
          <div><div className="grid grid-cols-2 gap-3"><SignalCard label="TD Brier" value={data.touchdown_probability.brier ?? '—'} /><SignalCard label="TD log loss" value={data.touchdown_probability.log_loss ?? '—'} /></div>{!!buckets.length && <div className="mt-3 text-sm text-slate-500">{buckets.length} populated reliability buckets.</div>}</div>
        </div>}
    </div>
  </details>;
}

function Stat({ label, value, band }: { label: string; value: string; band?: number[] }) {
  return <div className="rounded-lg bg-slate-50 p-2.5"><div className="text-xs font-bold uppercase tracking-wide text-slate-400">{label}</div><div className="text-lg font-black text-slate-900">{value}</div>{band?.length === 3 && <div className="text-xs text-slate-500">80% range {band[0]?.toFixed(0)}–{band[2]?.toFixed(0)}</div>}</div>;
}

function Step({ n }: { n: string }) { return <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-sky-200 bg-sky-100 text-xs font-black text-sky-900">{n}</span>; }

function Avatar({ name, position }: { name: string; position: string | null }) {
  const initials = String(name ?? '?').replace(/[^A-Za-z. ]/g, '').split(/[. ]+/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase();
  return <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-xs font-black ${POS_COLOR[position ?? ''] ?? 'bg-slate-100 text-slate-500'}`}>{initials || '?'}</div>;
}
