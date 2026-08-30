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
  model: {
    calibration_gate: string; calibration_detail: string; sizing_allowed: boolean;
    /** The same verdict as a sentence, which is what the page leads with. */
    calibration_plain?: string; calibration_numbers?: string | null;
  };
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
    ? { title: 'Build the teaser ticket that qualified', detail: teaser.detail }
    : { title: 'Go check what your book pays for a teaser',
        detail: teaser?.detail ?? 'The candidates exist. What is missing is the one number that decides whether they are worth betting: the actual price.' };

  return <BettingWorkspace sport="all" title="Path to Profit"
    description="What you can bet today, what still isn't good enough to bet, and what to do next. Nothing gets promoted here for looking clever — only for winning money on record."
    activeStage="scan">
    {(summary.error || status.error) && <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{summary.error ?? status.error}</div>}

    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(300px,.7fr)]">
      <NextAction eyebrow="Do this next" title={next.title} detail={next.detail} to="/betting/nfl" />
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="text-[10px] font-black uppercase tracking-[.15em] text-slate-400">The rule right now</div>
        <div className="mt-2 text-xl font-black text-slate-950">
          {status.data?.model.sizing_allowed ? 'The model may bet real money' : 'Only bet things that need no prediction'}
        </div>
        <p className="mt-1 text-sm leading-5 text-slate-600">
          {status.data?.model.calibration_plain ?? 'Checking how accurate the model has been…'}
        </p>
        {status.data?.model.calibration_numbers &&
          <p className="mt-2 border-t border-slate-100 pt-2 text-[11px] leading-4 text-slate-400">
            {status.data.model.calibration_numbers}
          </p>}
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full w-2/4 rounded-full bg-emerald-600" /></div>
        <div className="mt-2 flex justify-between text-[11px] font-bold text-slate-400">
          <span>Built</span><span>Proven live</span><span>Funded</span>
        </div>
      </section>
    </div>

    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div><div className="text-[10px] font-black uppercase tracking-[.15em] text-emerald-700">Two desks</div><h2 className="text-2xl font-black">Same rules, different sport</h2></div>
        <div className="text-xs text-slate-500">Every pick ends as a row with a real price on it, or it doesn't count.</div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <SportDesk sport="NFL" to="/betting/nfl" kicker="Closest thing to an edge"
          title={teaser?.headline ?? 'Teasers and price shopping'}
          detail={teaser?.detail ?? 'Reading the ledger…'} facts={[
            ['Record on fake money', nfl ? `${nfl.wins}-${nfl.losses}-${nfl.pushes}` : '—'],
            ['Up or down', units(nfl?.units)],
            ['Teaser legs measured', `${summary.data?.edges?.teaser?.legs ?? 0}`],
            ['Prices', execution?.live && !status.data?.data.capture_stale ? 'Fresh' : 'Need refreshing']
          ]} />
        <SportDesk sport="MLB" to="/betting/mlb/auto" kicker="Still collecting proof"
          title="Recording picks at real prices"
          detail="Picks get written down before the game with the price you could actually have gotten. No going back later to find a version that looks good."
          facts={[
            ['Picks recorded', String(mlb?.tracked_picks ?? 0)],
            ['Days running', String(mlb?.days_tracked ?? 0)],
            ['Last slate', mlb?.latest_slate ?? '—'],
            ['Prices used', 'Real ones only']
          ]} />
      </div>
    </section>

    <section className="grid gap-4 lg:grid-cols-3">
      <QueueCard step="01" label="Why prices cost money"
        title={`${status.data?.data.credits_remaining ?? '—'} paid price checks left`}
        detail="Watching which lines move is free. Reading every book's price at the same instant is not, and that's the only way to know who pays most. So it spends one only when a line actually moved." />
      <QueueCard step="02" label="Why the AI can't pick"
        title="The rules choose, the AI explains"
        detail="The pick is locked in first. Only then does the AI see it and write up the reasoning — and the wording is hashed, so an explanation can never quietly become the reason." />
      <QueueCard step="03" label="What counts as proof"
        title="Beating the closing price"
        detail="If you take +3 and the line closes at +2.5, you got the better number — that shows up in weeks. Win rate takes seasons and lies in the meantime, so nothing gets promoted on it." />
    </section>

    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700">
      <b className="text-slate-900">Where this actually stands:</b> everything needed to place a bet works — comparing books,
      routing to the best price, recording results. What doesn't work is predicting games; the model is no sharper than the
      betting line, so it isn't allowed to risk money. The one plausible edge is teasers, and it lives or dies on whether your
      book prices them at -110 or -130. That's the next thing to check.
    </div>
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
