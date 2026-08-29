import { Link } from 'react-router-dom';
import { useApi } from '../../api';
import { BettingWorkspace, NextAction } from '../../components/betting/BettingWorkspace';

interface Standing { wins: number; losses: number; pushes: number; pending: number; win_rate: number | null; units: number; bets: number }
interface Summary {
  nfl: { standing: Standing; model: { margin_mae: number; games_graded: number } | null };
  mlb: { standing: { tracked_picks: number; days_tracked: number; latest_slate: string | null } };
  edges?: { teaser?: { legs: number; win_rate: number; ev_at_110: { verdict: string; ev_per_bet: number } }; prop_edge?: { captured_quotes: number; settled_bets?: number; median_clv_cents?: number | null; verdict: string } };
}
interface HubStatus {
  edges: { id: string; label: string; live: boolean; headline: string; detail: string; blocked_by: string | null }[];
  model: { calibration_gate: string; calibration_detail: string; sizing_allowed: boolean };
  data: { credits_remaining: number | null; capture_stale: boolean; latest_multibook_capture: string | null };
}

const units = (value: number | null | undefined) => value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}u`;

export default function BettingHome() {
  const summary = useApi<Summary>('/betting/summary');
  const status = useApi<HubStatus>('/betting/status');
  const nfl = summary.data?.nfl.standing;
  const mlb = summary.data?.mlb.standing;
  const teaser = status.data?.edges.find(edge => edge.id === 'teasers');
  const execution = status.data?.edges.find(edge => edge.id === 'execution');
  const next = teaser?.live
    ? { title: 'Build the next qualified teaser ticket', detail: teaser.detail }
    : { title: 'Verify a reachable teaser payout', detail: teaser?.detail ?? 'The model has candidate legs; execution still needs a real same-book price.' };

  return <BettingWorkspace sport="all" title="Path to Profit"
    description="One operating view for what can be executed, what still needs proof, and what data should be collected next. Nothing advances because it looks impressive; it advances only when the ledger supports it."
    activeStage="scan">
    {(summary.error || status.error) && <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{summary.error ?? status.error}</div>}

    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(300px,.7fr)]">
      <NextAction eyebrow="Do this next" title={next.title} detail={next.detail} to="/betting/nfl" />
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="text-[10px] font-black uppercase tracking-[.15em] text-slate-400">Current operating rule</div>
        <div className="mt-2 text-xl font-black text-slate-950">{status.data?.model.sizing_allowed ? 'Model staking is unlocked' : 'Execution edges only'}</div>
        <p className="mt-1 text-sm leading-5 text-slate-500">{status.data?.model.calibration_detail ?? 'Reading the latest calibration gate…'}</p>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full w-2/4 rounded-full bg-emerald-600" /></div>
        <div className="mt-2 flex justify-between text-[11px] font-bold text-slate-400"><span>Infrastructure</span><span>Forward proof</span><span>Capital</span></div>
      </section>
    </div>

    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div><div className="text-[10px] font-black uppercase tracking-[.15em] text-emerald-700">Connected desks</div><h2 className="text-2xl font-black">Same workflow, sport-specific evidence</h2></div>
        <div className="text-xs text-slate-500">Every pick must end in a priced, auditable ledger row.</div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <SportDesk sport="NFL" to="/betting/nfl" kicker="Best current path" title={teaser?.headline ?? 'Teaser execution + line shopping'} detail={teaser?.detail ?? 'Reading the structural-edge ledger…'} facts={[
          ['Paper record', nfl ? `${nfl.wins}-${nfl.losses}-${nfl.pushes}` : '—'], ['Paper units', units(nfl?.units)], ['Teaser sample', `${summary.data?.edges?.teaser?.legs ?? 0} legs`], ['Quote state', execution?.live && !status.data?.data.capture_stale ? 'Fresh' : 'Refresh needed']
        ]} />
        <SportDesk sport="MLB" to="/betting/mlb/auto" kicker="Evidence collection" title="Forward-priced daily ledger" detail="Use the local model to form candidates, then preserve the actual pregame state and price before calling anything evidence." facts={[
          ['Tracked picks', String(mlb?.tracked_picks ?? 0)], ['Days tracked', String(mlb?.days_tracked ?? 0)], ['Latest slate', mlb?.latest_slate ?? '—'], ['Economics', 'Real prices only']
        ]} />
      </div>
    </section>

    <section className="grid gap-4 lg:grid-cols-3">
      <QueueCard step="01" label="Capture only when useful" title={`${status.data?.data.credits_remaining ?? '—'} paid credits left`} detail="The free detector watches every slate. A paid multi-book snapshot fires only after a material move or news signal and preserves the reserve." />
      <QueueCard step="02" label="Make reasoning inspectable" title="AI translates; rules decide" detail="A pick is frozen first. AI receives that factor packet afterward, writes the explanation, and stores a hash so wording cannot change the selection." />
      <QueueCard step="03" label="Promote on proof" title="CLV before profit claims" detail="Candidate and close prices live in the same ledger. Promotion requires enough forward observations and a positive signal—not a backfilled win rate." />
    </section>

    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600"><b className="text-slate-900">Honest distance to profit:</b> the execution stack is built, but the bankroll gate remains intentionally closed until real forward prices accumulate. The shortest path is NFL teaser price verification plus fresh multi-book captures; MLB remains a data-collection program.</div>
  </BettingWorkspace>;
}

function SportDesk({ sport, to, kicker, title, detail, facts }: { sport: string; to: string; kicker: string; title: string; detail: string; facts: [string, string][] }) {
  return <Link to={to} className="group rounded-2xl border border-slate-200 bg-white p-5 transition hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-lg">
    <div className="flex items-center justify-between"><span className="grid h-10 w-10 place-items-center rounded-xl bg-slate-950 text-xs font-black text-white">{sport}</span><span className="text-xs font-black text-emerald-700">Open desk →</span></div>
    <div className="mt-4 text-[10px] font-black uppercase tracking-[.15em] text-slate-400">{kicker}</div><h3 className="mt-1 text-xl font-black text-slate-950">{title}</h3><p className="mt-1 min-h-10 text-sm leading-5 text-slate-500">{detail}</p>
    <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200">{facts.map(([label, value]) => <div key={label} className="bg-slate-50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div><div className="mt-1 text-sm font-black text-slate-800">{value}</div></div>)}</div>
  </Link>;
}

function QueueCard({ step, label, title, detail }: { step: string; label: string; title: string; detail: string }) {
  return <article className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center gap-2"><span className="text-xs font-black text-emerald-700">{step}</span><span className="text-[10px] font-black uppercase tracking-[.13em] text-slate-400">{label}</span></div><h3 className="mt-3 text-lg font-black text-slate-950">{title}</h3><p className="mt-1 text-sm leading-5 text-slate-500">{detail}</p></article>;
}
